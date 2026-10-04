import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { looksLikeBankTransactions } from "./finance/manual-nab-csv";
const run = promisify(execFile);
const roots = ["Documents", "Desktop", "Downloads"].map((x) => join(homedir(), x));
const extensions = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".html",
  ".htm",
  ".vtt",
  ".srt",
]);
export function allowedMemoryFile(path: string, hidden: string[]) {
  const real = realpathSync(path);
  if (
    !roots.some((r) => real.startsWith(r + sep)) ||
    !extensions.has(extname(real).toLowerCase()) ||
    real.split(sep).some((p) => p.startsWith(".") || ["node_modules", "references"].includes(p)) ||
    /credential|password|private.?key|secret|token|\.env/i.test(basename(real)) ||
    hidden.some((h) => basename(real, extname(real)).toLowerCase() === h.toLowerCase())
  )
    throw new Error("This file is not available for memory import.");
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
    throw new Error("Choose a document smaller than 5 MB.");
  if (bankExportFile(real)) throw new Error(BANK_EXPORT_REFUSAL);
  return real;
}

/** Raw bank transactions never enter memory: Finance is authoritative, memory keeps summaries only. */
export const BANK_EXPORT_REFUSAL =
  "That looks like a bank transactions export. Import it in Finance instead (Finance → Import NAB CSV); memory keeps only Finance's summaries, never raw transactions.";

/** A CSV or text file whose first lines look like a bank transactions export (NAB or similar). */
export function bankExportFile(path: string): boolean {
  if (![".csv", ".txt"].includes(extname(path).toLowerCase())) return false;
  let head = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return looksLikeBankTransactions(head);
}
const WALK_MAX_DEPTH = 6;
const WALK_BUDGET_MS = 8000;
// Raw match cap, deliberately larger than the 40 this function returns. The
// darwin path collects everything mdfind finds, filters it through
// allowedMemoryFile, and only then takes 40 — so capping the walk at 40 would
// let hidden/disallowed files consume result slots and return fewer than macOS
// would for the same query. Collect a wider pool, filter, then slice.
const WALK_RESULT_CAP = 200;

// Non-darwin fallback for mdfind: a bounded, depth-capped, time-budgeted
// recursive walk over `roots`, matching basenames case-insensitively.
// Never throws — any per-entry fs error is skipped so the walk continues.
function walkForMatches(root: string, tokensLower: string[], deadline: number, found: Set<string>) {
  const visited = new Set<string>();
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (Date.now() > deadline || found.size >= WALK_RESULT_CAP) return;
    const { dir, depth } = stack.pop()!;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue; // guard against symlink/junction cycles
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() > deadline || found.size >= WALK_RESULT_CAP) return;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      try {
        if (entry.isDirectory()) {
          if (name === "node_modules") continue;
          if (depth + 1 > WALK_MAX_DEPTH) continue;
          stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile()) {
          const lower = name.toLowerCase();
          if (tokensLower.every((t) => lower.includes(t))) found.add(full);
        }
      } catch {
        continue;
      }
    }
  }
}

export async function findMemoryFiles(q: string, hidden: string[]) {
  const safe = q
    .replace(/[^\p{L}\p{N} -]/gu, " ")
    .trim()
    .slice(0, 100);
  if (safe.length < 2) return [];
  const tokens = safe.split(/\s+/).slice(0, 5),
    query = tokens.map((t) => `kMDItemFSName == '*${t}*'cd`).join(" && ");
  const found = new Set<string>();
  if (platform() === "darwin") {
    const results = await Promise.allSettled(
      roots.map((root) =>
        run("/usr/bin/mdfind", ["-onlyin", root, query], { timeout: 8000, maxBuffer: 1024 * 1024 }),
      ),
    );
    for (const r of results)
      if (r.status === "fulfilled")
        for (const path of r.value.stdout.trim().split("\n")) {
          try {
            found.add(allowedMemoryFile(path, hidden));
          } catch {}
        }
  } else {
    const tokensLower = tokens.map((t) => t.toLowerCase());
    const deadline = Date.now() + WALK_BUDGET_MS;
    const matches = new Set<string>();
    for (const root of roots) {
      if (Date.now() > deadline || matches.size >= WALK_RESULT_CAP) break;
      walkForMatches(root, tokensLower, deadline, matches);
    }
    for (const path of matches) {
      try {
        found.add(allowedMemoryFile(path, hidden));
      } catch {}
    }
  }
  return [...found]
    .slice(0, 40)
    .map((path) => ({
      id: Buffer.from(path).toString("base64url"),
      name: basename(path),
      path,
      kind: extname(path).slice(1),
    }));
}

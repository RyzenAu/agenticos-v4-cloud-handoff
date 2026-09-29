import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapture } from "../nonblocking-exec";

/**
 * Codex sandbox isolation for coding jobs (security finding A1-6, AUDIT-A1-SECURITY.md, 28 Sep 2026).
 *
 * Codex's Windows "elevated" sandbox runs commands as the CodexSandboxOffline/Online accounts (the
 * CodexSandboxUsers group) and, to make a workspace usable, re-grants `CodexSandboxUsers:(RX)` across the
 * profile root. An INHERITED Deny loses to the explicit Allow it adds, so credential files under the
 * profile (~/.claude-os, ~/.codex/auth.json, Hermes' env, git/npm credentials …) become readable to the
 * sandbox accounts during a Codex run. The coding harness therefore:
 *
 *   1. refuses to start any Codex role unless every protected path that exists carries an EXPLICIT
 *      (non-inherited) Deny ACE for CodexSandboxUsers covering read (deny beats Codex's allow, whatever
 *      order Codex adds its grants in);
 *   2. refuses a Codex workspace (cwd) under any protected tree;
 *   3. checks what is INSIDE a protected folder too (REVIEW-T3): a child with inheritance turned off or its
 *      own Allow for the sandbox group escapes the folder's Deny. `.ssh` is walked to the bottom; other
 *      folders one level down;
 *   4. never changes ACLs by itself: `planDenyAcls` prints the exact icacls commands, and
 *      `applyDenyAcls` runs them only when the OWNER invokes `bun scripts/coding/codex-isolation.ts --apply`
 *      from the LIVE checkout (a worktree is refused: its .env and .operator-data aren't the live ones).
 *      `--rollback` removes exactly the Deny entries for the sandbox group again (`icacls /remove:d`).
 *
 * Reading an ACL runs `icacls <path>` (read-only). Tests use a synthetic home; nothing here runs Codex.
 */

export const SANDBOX_GROUP = "CodexSandboxUsers";

export type ProtectedPath = {
  path: string;
  kind: "dir" | "file";
  why: string;
  /** Set when this is a junction or symlink inside a folder walked to the bottom (M1): it's named, never written through. */
  link?: string;
};

/** Credential-shaped paths a coding agent must never read. Only existing ones are checked. */
export function protectedPaths(options: { home?: string; env?: NodeJS.ProcessEnv; liveRoot?: string | null } = {}): ProtectedPath[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const candidates: Array<[string, string]> = [
    [join(home, ".claude-os"), "the OS's own secret dir (dev token)"],
    [join(home, ".claude", ".credentials.json"), "Claude Code login"],
    // The whole folder too (R6): Claude Code rewrites .credentials.json by temp-and-rename, and a
    // replaced file inherits the FOLDER's Deny. The Codex sandbox needs nothing in Claude's home.
    // ~/.codex is NOT protected as a folder: sandboxed commands may legitimately use Codex's own home
    // (its sandbox state and skills), so only its auth.json is, re-applied on a timer while Codex runs.
    [join(home, ".claude"), "Claude Code's home (login, transcripts, settings)"],
    [join(home, ".claude.json"), "Claude Code account config"],
    [join(home, ".codex", "auth.json"), "Codex login"],
    [join(home, ".codex", "secrets"), "Codex MCP OAuth secrets"],
    [join(home, ".hermes"), "Hermes home (env, auth pool)"],
    [join(localAppData, "hermes"), "Hermes home (junction target)"],
    [join(home, ".config", "agentic-os.env"), "the OS's provider keys"],
    [join(home, ".config", "gh"), "GitHub CLI tokens"],
    [join(home, ".git-credentials"), "git credentials"],
    [join(home, ".npmrc"), "npm token"],
    [join(home, ".ssh"), "SSH keys"],
    [join(home, ".aws"), "AWS credentials"],
    [join(home, ".azure"), "Azure credentials"],
    [join(home, ".docker", "config.json"), "Docker registry auth"],
    [join(home, ".netrc"), "netrc credentials"],
    [join(home, ".pgpass"), "Postgres passwords"],
    [join(appData, "com.vercel.cli"), "Vercel CLI token"],
    [join(home, ".vercel"), "Vercel CLI token"],
  ];
  if (options.liveRoot) {
    candidates.push([join(options.liveRoot, ".operator-data"), "the OS's operator data (people, sessions, stores)"]);
    try {
      for (const name of readdirSync(options.liveRoot)) if (/^\.env(?:\..+)?$/i.test(name) && !/\.(?:example|sample|template)$/i.test(name)) candidates.push([join(options.liveRoot, name), "the OS's env file"]);
    } catch { /* no live root */ }
  }
  const out: ProtectedPath[] = [];
  const seen = new Set<string>();
  for (const [path, why] of candidates) {
    if (!existsSync(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let kind: ProtectedPath["kind"] = "file";
    try { kind = lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() ? "dir" : "file"; } catch { /* keep file */ }
    out.push({ path, kind, why });
  }
  return out;
}

export type AclEntry = { principal: string; flags: string[]; explicit: boolean; deny: boolean; rights: string[] };

/** Parse `icacls <path>` output into entries (the first line carries the path). */
export function parseIcacls(output: string, path: string): AclEntry[] {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() && !/^Successfully processed|^Failed processing/i.test(l.trim()));
  const entries: AclEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (i === 0 && line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length);
    const m = /^\s*(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
    if (!m) continue;
    const parts = [...m[2].matchAll(/\(([^)]*)\)/g)].map((x) => x[1]);
    const deny = parts.includes("DENY");
    const explicit = !parts.includes("I");
    const flags = parts.filter((p) => ["OI", "CI", "IO", "NP", "I", "DENY"].includes(p));
    const rights = parts.filter((p) => !flags.includes(p)).flatMap((p) => p.split(","));
    entries.push({ principal: m[1].trim(), flags, explicit, deny, rights });
  }
  return entries;
}

const READ_RIGHTS = new Set(["F", "M", "RX", "R", "GR", "GA", "RD", "REA", "RA", "X"]);

/**
 * Is the sandbox group explicitly denied read here? icacls shows a Deny as `(DENY)(<rights>)`; a
 * Deny-FullControl set through PowerShell can also show as `(N)` on the principal's own explicit line.
 */
export function explicitlyDenied(entries: readonly AclEntry[], group = SANDBOX_GROUP): boolean {
  return entries.some((e) => e.explicit && new RegExp(`(?:^|\\\\)${group}$`, "i").test(e.principal) && (
    (e.deny && e.rights.some((r) => READ_RIGHTS.has(r))) || (!e.deny && e.rights.length === 1 && e.rights[0] === "N")
  ));
}

/** Effective ACEs only: an inherit-only (IO) entry doesn't apply to the object it sits on. */
const effective = (entries: readonly AclEntry[]) => entries.filter((e) => !e.flags.includes("IO"));
const isGroup = (principal: string, group = SANDBOX_GROUP) => new RegExp(`(?:^|\\\\)${group}$`, "i").test(principal);

/**
 * Inside a protected folder a child is safe when a Deny of read for the sandbox group applies to it
 * (inherited from the folder or its own) and nothing EXPLICIT on it allows the group to read.
 */
export function childDenied(entries: readonly AclEntry[], group = SANDBOX_GROUP): boolean {
  // Canonical order: explicit Deny, explicit Allow, then inherited Deny, inherited Allow. So an explicit
  // Deny always wins, and an inherited Deny wins only when nothing explicit allows the group to read.
  const mine = effective(entries).filter((e) => isGroup(e.principal, group));
  const denies = (e: AclEntry) => (e.deny && e.rights.some((r) => READ_RIGHTS.has(r))) || (!e.deny && e.rights.length === 1 && e.rights[0] === "N");
  if (mine.some((e) => e.explicit && denies(e))) return true;
  const allowed = mine.some((e) => e.explicit && !e.deny && e.rights.some((r) => READ_RIGHTS.has(r)));
  return !allowed && mine.some((e) => !e.explicit && denies(e));
}

/**
 * Split `icacls <dir> /T` or `icacls <dir>\*` output into per-path ACLs. Blocks are separated by blank
 * lines; each starts with the path. Known paths (from a directory walk) are matched longest first, so a
 * path with spaces is read correctly; a block that matches no known path is returned under "" (fail closed).
 */
export function parseIcaclsTree(output: string, knownPaths: readonly string[]): Map<string, AclEntry[]> {
  const out = new Map<string, AclEntry[]>();
  const known = [...knownPaths].sort((a, b) => b.length - a.length);
  const blocks = output.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.replace(/^\n+/, "")).filter((b) => b.trim() && !/^\s*(?:Successfully processed|Failed processing)/i.test(b.trim()));
  for (const block of blocks) {
    const first = block.split("\n")[0];
    const path = known.find((p) => first.toLowerCase().startsWith(`${p.toLowerCase()} `)) ?? "";
    out.set(path, [...(out.get(path) ?? []), ...(path ? parseIcacls(block, path) : [])]);
  }
  return out;
}

/** Children of a protected folder: every level under .ssh, one level elsewhere; capped (fails closed past it). */
export function childPaths(dir: string, options: { recursive: boolean; cap?: number } = { recursive: false }): { paths: string[]; capped: boolean } {
  const cap = options.cap ?? 400;
  const paths: string[] = [];
  const walk = (d: string, depth: number): boolean => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return true; }
    for (const name of names) {
      if (paths.length >= cap) return false;
      const p = join(d, name);
      paths.push(p);
      let dirLike = false;
      try { const st = lstatSync(p); dirLike = st.isDirectory() && !st.isSymbolicLink(); } catch { /* gone */ }
      if (dirLike && options.recursive && depth < 8 && !walk(p, depth + 1)) return false;
    }
    return true;
  };
  const complete = walk(dir, 0);
  return { paths, capped: !complete };
}

/** Every icacls call is async (REVIEW-T3 R6): a preflight never blocks the server while it runs. */
async function icacls(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const r = await runCapture("icacls", args, { timeout: 120_000 });
  return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

export type ReadTreeAcl = (dir: string, recursive: boolean) => string | null | Promise<string | null>;
const defaultReadTreeAcl: ReadTreeAcl = async (dir, recursive) => {
  const r = await icacls(recursive ? [dir, "/T", "/C"] : [join(dir, "*"), "/C"]);
  return r.status === 0 ? r.stdout : null;
};
/** Folders walked to the bottom (key material lives in subfolders); the rest are checked one level down. */
const RECURSIVE_DIRS = /(?:^|[\\/])\.ssh$/i;

export type ReadAcl = (path: string) => string | null | Promise<string | null>;
const defaultReadAcl: ReadAcl = async (path) => {
  const r = await icacls([path]);
  return r.status === 0 ? r.stdout : null;
};

export type IsolationReport = { ok: boolean; checked: number; missing: ProtectedPath[]; unreadable: ProtectedPath[]; platform: NodeJS.Platform; remedy: string[] };

/** The preflight a Codex role must pass. Non-Windows hosts have no elevated sandbox: nothing to check. */
export async function checkCodexIsolation(options: { home?: string; env?: NodeJS.ProcessEnv; liveRoot?: string | null; readAcl?: ReadAcl; readTreeAcl?: ReadTreeAcl; platform?: NodeJS.Platform } = {}): Promise<IsolationReport> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { ok: true, checked: 0, missing: [], unreadable: [], platform, remedy: [] };
  const read = options.readAcl ?? defaultReadAcl;
  const missing: ProtectedPath[] = [];
  const unreadable: ProtectedPath[] = [];
  const paths = protectedPaths(options);
  for (const p of paths) {
    const out = await read(p.path);
    if (out === null) { unreadable.push(p); continue; }
    if (!explicitlyDenied(parseIcacls(out, p.path))) { missing.push(p); continue; }
    if (p.kind !== "dir") continue;
    // Inside the folder: every child must still be denied (REVIEW-T3).
    const recursive = RECURSIVE_DIRS.test(p.path);
    const kids = childPaths(p.path, { recursive });
    if (!kids.paths.length) continue;
    // A junction or symlink in a folder walked to the bottom (M1, REVIEW-T3 R7 minor 1): `icacls /T`
    // follows it, and the target's entries can't be matched to a walked path, so the whole folder used
    // to read as "unreadable" and the pause blamed the folder. Look for links first and name them
    // (never read or written through); the rest of the folder is then read path by path, without /T.
    const planted = recursive ? kids.paths.filter((k) => { try { return lstatSync(k).isSymbolicLink(); } catch { return false; } }) : [];
    for (const k of planted) {
      let kind: ProtectedPath["kind"] = "dir";
      try { kind = statSync(k).isDirectory() ? "dir" : "file"; } catch { /* dangling: keep dir */ }
      missing.push({ path: k, kind, why: `inside ${p.path} (${p.why})`, link: "a junction or symlink" });
    }
    const rest = planted.length ? kids.paths.filter((k) => !planted.includes(k)) : kids.paths;
    if (!rest.length) continue;
    const onePathAtATime: ReadTreeAcl = async () => {
      const blocks: string[] = [];
      for (const k of rest) blocks.push((await read(k)) ?? ""); // unreadable: no entries, so it fails closed below
      return blocks.join("\n\n");
    };
    const readTree: ReadTreeAcl = planted.length ? onePathAtATime : options.readTreeAcl ?? (options.readAcl
      ? async () => (await Promise.all(kids.paths.map(async (k) => (await options.readAcl!(k)) ?? ""))).join("\n\n")
      : defaultReadTreeAcl);
    const tree = await readTree(p.path, recursive);
    if (tree === null || kids.capped) { unreadable.push(p); continue; }
    const acls = parseIcaclsTree(tree, [p.path, ...rest]);
    if (acls.has("")) { unreadable.push(p); continue; }
    for (const k of rest) {
      const entries = acls.get(k);
      if (!entries || !childDenied(entries)) {
        let kind: ProtectedPath["kind"] = "file";
        try { kind = statSync(k).isDirectory() ? "dir" : "file"; } catch { /* keep file */ }
        missing.push({ path: k, kind, why: `inside ${p.path} (${p.why})` });
      }
    }
  }
  const bad = [...missing, ...unreadable];
  // No icacls remedy for a link: /deny would follow it and write outside the protected set.
  return { ok: bad.length === 0, checked: paths.length, missing, unreadable, platform, remedy: planDenyAcls(bad.filter((p) => !p.link)) };
}

/** The exact commands that fix it (explicit, inheritable Deny of read for the sandbox group). */
export function planDenyAcls(paths: readonly ProtectedPath[]): string[] {
  return paths.map((p) => `icacls "${p.path}" /deny ${SANDBOX_GROUP}:${p.kind === "dir" ? "(OI)(CI)" : ""}(R)`);
}

/** Deny-only: `icacls /deny` for the sandbox group, one path at a time. Returns per-path results. */
export async function applyDenyAcls(paths: readonly ProtectedPath[]): Promise<{ path: string; ok: boolean }[]> {
  const out: { path: string; ok: boolean }[] = [];
  for (const p of paths) out.push({ path: p.path, ok: icaclsOk(await icacls([p.path, "/deny", `${SANDBOX_GROUP}:${p.kind === "dir" ? "(OI)(CI)" : ""}(R)`])) });
  return out;
}

export type IsolationOptions = { home?: string; env?: NodeJS.ProcessEnv; liveRoot?: string | null; readAcl?: ReadAcl; readTreeAcl?: ReadTreeAcl; platform?: NodeJS.Platform };

/**
 * OWNER-INVOKED ONLY (--apply, or a test on a synthetic home). One run is enough (REVIEW-T3 R2): the
 * folder Denies go on first, then the check looks inside and finds the children that don't inherit them
 * (OpenSSH's known_hosts has inheritance turned off), which get their own Deny; it repeats until nothing
 * new is missing (at most 4 rounds). ok only when the final check passes and every icacls call succeeded.
 */
export async function applyIsolation(options: IsolationOptions = {}): Promise<{ ok: boolean; rounds: number; results: { path: string; ok: boolean }[]; report: IsolationReport }> {
  const results: { path: string; ok: boolean }[] = [];
  let report = await checkCodexIsolation(options);
  let rounds = 0;
  const tried = new Set<string>();
  while (!report.ok && rounds < 4) {
    // Never through a link (M1): the Deny would land on its target, outside the protected set.
    const todo = [...report.missing, ...report.unreadable].filter((p) => !p.link && !tried.has(p.path.toLowerCase()));
    if (!todo.length) break;
    rounds++;
    for (const p of todo) tried.add(p.path.toLowerCase());
    results.push(...(await applyDenyAcls(todo)));
    report = await checkCodexIsolation(options);
  }
  const ok = report.ok && results.every((r) => r.ok);
  // The owner's approval, recorded: which paths he protected, and when (T3e). The harness re-applies
  // Deny-only entries on exactly these paths (and inside the folders among them) before a Codex role.
  if (ok) await recordApproval(options, [...protectedPaths(options).map((p) => p.path), ...results.map((r) => r.path)]);
  return { ok, rounds, results, report };
}

// ─────────────────────────── the owner's approval, and keeping it applied (T3e) ───────────────────────────

/**
 * Why a Deny goes missing (T3e, confirmed on a synthetic file): Claude Code rewrites ~/.claude.json by
 * writing a temp file and renaming it over the original. The renamed-in file carries the temp file's
 * ACL (inherited from the folder), so the explicit Deny --apply put on the old file is gone. An
 * in-place write keeps it. So a path the owner protected can lose its Deny without anyone removing it.
 */
export type IsolationApproval = { version: 1; group: string; approvedAt: string; paths: string[] };

/** Where the approval lives: inside ~/.claude-os, itself a protected folder (new files inherit its Deny). */
export function approvalFile(options: { home?: string } = {}) {
  return join(options.home ?? homedir(), ".claude-os", "codex-isolation-approved.json");
}

export function readApproval(options: { home?: string } = {}): IsolationApproval | null {
  try {
    const a = JSON.parse(readFileSync(approvalFile(options), "utf8"));
    return a && a.version === 1 && a.group === SANDBOX_GROUP && Array.isArray(a.paths) && typeof a.approvedAt === "string" ? a : null;
  } catch { return null; }
}

async function recordApproval(options: { home?: string }, paths: string[]) {
  try {
    const file = approvalFile(options);
    // A new ~/.claude-os (only on a home that never had one) is protected like every other one: the
    // owner is running --apply right now, so this Deny is his too.
    if (!existsSync(dirname(file))) {
      mkdirSync(dirname(file), { recursive: true });
      await applyDenyAcls([{ path: dirname(file), kind: "dir", why: "the OS's own secret dir (dev token)" }]);
      paths = [...paths, dirname(file)];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    const record: IsolationApproval = { version: 1, group: SANDBOX_GROUP, approvedAt: new Date().toISOString(), paths: [...new Set(paths.map((p) => resolve(p)))] };
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, file);
  } catch { /* the Denies are applied either way; without the record, the harness asks for --apply again */ }
}

const under = (child: string, parent: string) => {
  const r = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase());
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** Is this path one the owner approved (listed, or inside a listed folder)? */
export function isApprovedPath(path: string, approval: IsolationApproval | null): boolean {
  return !!approval && approval.paths.some((p) => under(path, p));
}

/**
 * A link inside a protected folder (REVIEW-T3 R6): a junction or symlink, or a file with more than one
 * hard link, reaches something OUTSIDE the approved set. It is never re-applied; Codex pauses and names it.
 */
export function linkInside(path: string): string | null {
  try {
    const l = lstatSync(path);
    if (l.isSymbolicLink()) return "a junction or symlink";
    if (l.isFile() && l.nlink > 1) return `a hard link (${l.nlink} names for one file)`;
    return null;
  } catch { return null; }
}

/**
 * Why a protected path is missing its Deny, in plain words: replaced by a new file or folder since
 * --apply (a rewrite drops explicit ACEs), or not replaced (the Deny was removed or never applied).
 */
export function missingReason(path: string, approval: IsolationApproval | null): { rewritten: boolean; reason: string } {
  try {
    const st = statSync(path);
    const born = st.birthtimeMs;
    const since = approval ? Date.parse(approval.approvedAt) : NaN;
    const replacedSinceApply = Number.isFinite(since) && born > since;
    // A file whose creation time equals its last write was replaced by a new file, not edited in place.
    const replacedAtLastWrite = !st.isDirectory() && Math.abs(st.mtimeMs - born) < 2000;
    if (!approval) return { rewritten: false, reason: "never protected (run --apply once)" };
    if (!isApprovedPath(path, approval)) return { rewritten: false, reason: "not in the approved list (new since --apply: run --apply again)" };
    if (replacedSinceApply || replacedAtLastWrite)
      return { rewritten: true, reason: "replaced by a new file since --apply (a write-and-rename rewrite drops explicit Deny entries); the harness re-applies it" };
    return { rewritten: false, reason: "lost its Deny without being replaced (removed or reset by something else); the harness re-applies it" };
  } catch {
    return { rewritten: false, reason: "can't be read" };
  }
}

export type EnsureResult = {
  ok: boolean;
  report: IsolationReport;
  reapplied: { path: string; ok: boolean; rewritten: boolean }[];
  /** Links inside protected folders that were NOT re-applied (they reach outside the approved set). */
  links: { path: string; kind: string; removeOnly?: boolean }[];
  message: string;
};

/**
 * Before each Codex role, and on a timer while one runs (T3e, R6): re-apply the MISSING Deny entries for
 * the sandbox group, only on paths the owner already approved with --apply. Deny-only: it never removes
 * an entry and never grants anything. The approval is re-read right before each icacls batch, so a
 * rollback during a preflight stops it at once. Links inside protected folders are never touched. A path
 * outside the approval, a link, or a re-apply that fails keeps Codex paused with the reason.
 */
export async function ensureCodexIsolation(options: IsolationOptions = {}): Promise<EnsureResult> {
  let report = await checkCodexIsolation(options);
  const reapplied: EnsureResult["reapplied"] = [];
  const links: EnsureResult["links"] = [];
  if (report.ok) return { ok: true, report, reapplied, links, message: "" };
  const listed = new Set(protectedPaths(options).map((p) => resolve(p.path).toLowerCase()));
  const tried = new Set<string>();
  for (let round = 0; round < 3 && !report.ok; round++) {
    const approval = readApproval(options); // re-read before every batch (R6-1)
    if (!approval) break;
    const todo: ProtectedPath[] = [];
    for (const p of report.missing) {
      const key = p.path.toLowerCase();
      if (tried.has(key) || !isApprovedPath(p.path, approval)) continue;
      tried.add(key);
      const link = p.link ?? (listed.has(resolve(p.path).toLowerCase()) ? null : linkInside(p.path));
      if (link) { links.push({ path: p.path, kind: link, ...(p.link ? { removeOnly: true } : {}) }); continue; }
      todo.push(p);
    }
    if (!todo.length) break;
    const reasons = new Map(todo.map((p) => [p.path, missingReason(p.path, approval).rewritten]));
    if (!readApproval(options)) break; // rolled back between the check and the batch
    for (const r of await applyDenyAcls(todo)) reapplied.push({ ...r, rewritten: reasons.get(r.path) ?? false });
    report = await checkCodexIsolation(options);
  }
  const ok = report.ok && reapplied.every((r) => r.ok) && links.length === 0;
  // A junction or symlink in a folder walked to the bottom can only be removed: --apply never writes through it (M1).
  const linkNote = links.length
    ? ` Not re-applied: ${links.map((l) => `${l.path} is ${l.kind} inside a protected folder and points elsewhere`).join("; ")}. ${links.every((l) => l.removeOnly) ? "Remove it; Codex stays paused while it's there." : "Remove it, or run --apply if it belongs there."}`
    : "";
  return { ok, report, reapplied, links, message: ok ? "" : `${isolationRefusal(report, readApproval(options))}${linkNote}` };
}

/**
 * The exact commands that undo --apply: remove the sandbox group's Deny entries from each protected path
 * and, for a folder, from everything inside it (/T), which is where --apply put the child Denies.
 */
export function planRollback(paths: readonly ProtectedPath[]): string[] {
  return paths.map((p) => `icacls "${p.path}" /remove:d ${SANDBOX_GROUP}${p.kind === "dir" ? " /T" : ""} /C`);
}

/** Did an icacls run fully succeed? Its exit code, and "Failed processing N files" with N > 0 is a failure. */
const icaclsOk = (r: { status: number | null; stdout?: string; stderr?: string }) =>
  r.status === 0 && !/Failed processing [1-9]\d* files?/i.test(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);

/** OWNER-INVOKED ONLY (the --rollback CLI below, or a test on a synthetic folder). */
export async function rollbackDenyAcls(paths: readonly ProtectedPath[]): Promise<{ path: string; ok: boolean }[]> {
  const out: { path: string; ok: boolean }[] = [];
  for (const p of paths) out.push({ path: p.path, ok: icaclsOk(await icacls([p.path, "/remove:d", SANDBOX_GROUP, ...(p.kind === "dir" ? ["/T"] : []), "/C"])) });
  return out;
}

export const ROLLBACK_RECORD_STUCK =
  "Rollback incomplete: the approval record is still there, so no Deny entry was removed. They stay in place until a rollback can remove the record too (otherwise the harness would just re-apply them). Close whatever holds it open and run --rollback again.";

/**
 * Rollback over every protected path that exists; ok only when every call succeeded AND the approval
 * record is verifiably gone (R6-1: a record held open by another process used to survive a rollback
 * that said ok, and the next preflight re-applied everything). When the record can't be removed,
 * nothing else is touched either (M1, REVIEW-T3 R7 minor 2): stripping the Deny entries while the
 * approval stands only left a gap until the next preflight put them back. The ACLs and the record stay
 * consistent until a rollback that fully succeeds.
 */
export async function rollbackIsolation(options: IsolationOptions = {}, remove: (file: string) => void = (f) => rmSync(f, { force: true })): Promise<{ ok: boolean; results: { path: string; ok: boolean }[]; recordGone: boolean; message: string }> {
  // The approval goes first, so the harness never re-applies what the owner is rolling back (T3e).
  const file = approvalFile(options);
  try { remove(file); } catch { /* checked just below */ }
  const recordGone = !existsSync(file);
  if (!recordGone) return { ok: false, results: [], recordGone, message: ROLLBACK_RECORD_STUCK };
  const results = await rollbackDenyAcls(protectedPaths(options));
  const ok = recordGone && results.every((r) => r.ok);
  return {
    ok,
    results,
    recordGone,
    message: !recordGone ? ROLLBACK_RECORD_STUCK : ok ? "" : "Rollback FAILED for the paths above; some Deny entries may remain. Nothing else was changed.",
  };
}

/**
 * The CLI acts only from the LIVE checkout: in a linked worktree `.git` is a file, and that tree's .env
 * files and .operator-data are not the ones the OS reads. Returns the refusal, or null.
 */
export function worktreeRefusal(root: string): string | null {
  try {
    if (lstatSync(join(root, ".git")).isFile())
      return `This is a worktree (${root}), not the live checkout. Run \`bun scripts/coding/codex-isolation.ts\` from the live AgenticOS checkout, so its own .env files and .operator-data are the ones protected. Nothing was changed.`;
  } catch { /* no .git: not a checkout at all */ return `${root} isn't a git checkout. Run this from the live AgenticOS checkout. Nothing was changed.`; }
  return null;
}

/** A Codex workspace under a protected tree is refused outright. */
export function workspaceUnderProtected(cwd: string, options: { home?: string; env?: NodeJS.ProcessEnv; liveRoot?: string | null } = {}): ProtectedPath | null {
  const fold = (p: string) => { let v = resolve(p); try { v = realpathSync.native(v); } catch { /* not there */ } return v.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); };
  const c = fold(cwd);
  for (const p of protectedPaths(options)) {
    const q = fold(p.path);
    if (c === q || c.startsWith(`${q}/`)) return p;
  }
  return null;
}

/** Why one reported path fails, in plain words: a planted link is named as one, not blamed on its folder (M1). */
export function pathReason(p: ProtectedPath, approval: IsolationApproval | null): string {
  if (p.link) return `${p.link} ${p.why} that points elsewhere; it is never written through, so remove it`;
  return missingReason(p.path, approval).reason;
}

/** Plain-words refusal for the job page and Jarvis. */
export function isolationRefusal(report: IsolationReport, approval: IsolationApproval | null = null): string {
  const bad = [...report.missing, ...report.unreadable].slice(0, 8);
  const list = bad.map((p) => `${p.path} (${pathReason(p, approval)})`).join("; ");
  return `Codex roles are paused: its Windows sandbox could read ${list} (security finding A1-6). Run \`bun scripts/coding/codex-isolation.ts --apply\` once as yourself to add explicit Deny entries for ${SANDBOX_GROUP}, then resume. Claude and routed roles are unaffected.`;
}

if ((import.meta as { main?: boolean }).main) {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const liveRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const refused = worktreeRefusal(liveRoot);
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
  if (rollback) {
    for (const c of planRollback(protectedPaths({ liveRoot }))) console.log(`  ${c}`);
    const done = await rollbackIsolation({ liveRoot });
    for (const r of done.results) console.log(`${r.ok ? "removed" : "FAILED"} ${r.path}`);
    console.log(done.ok ? "Rolled back: the approval record and the sandbox group's Deny entries are gone, so Codex roles will be refused again until --apply." : done.message);
    process.exit(done.ok ? 0 : 1);
  }
  const report = await checkCodexIsolation({ liveRoot });
  const approval = readApproval();
  console.log(report.ok ? `OK: ${report.checked} protected path(s) explicitly deny ${SANDBOX_GROUP}.` : `${report.missing.length + report.unreadable.length} of ${report.checked} protected path(s) are not explicitly denied to ${SANDBOX_GROUP}:`);
  for (const p of [...report.missing, ...report.unreadable]) console.log(`  ${p.path}: ${pathReason(p, approval)}`);
  if (!report.ok) console.log(approval ? `Approved by --apply at ${approval.approvedAt}; before each Codex role the harness re-applies Deny-only entries on approved paths.` : "No --apply approval is recorded yet.");
  for (const c of report.remedy) console.log(`  ${c}`);
  if (apply && !report.ok) {
    const done = await applyIsolation({ liveRoot });
    for (const r of done.results) console.log(`${r.ok ? "applied" : "FAILED"} ${r.path}`);
    console.log(done.ok ? `Verified in ${done.rounds} round(s): every protected path, and what's inside, denies the sandbox group.` : "Still not isolated; see above.");
    for (const c of done.ok ? [] : done.report.remedy) console.log(`  ${c}`);
    process.exitCode = done.ok ? 0 : 1;
  } else if (!report.ok) process.exitCode = 1;
}

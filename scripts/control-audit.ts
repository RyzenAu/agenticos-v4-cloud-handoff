/**
 * The append-only audit log for Jarvis's actions: one JSON line per event under
 * `.operator-data/audit/control-YYYY-MM-DD.jsonl` (the owner's Sydney calendar date, audit A-L4) (or JARVIS_AUDIT_DIR, or an explicit dir; tests use
 * a temp dir). Every entry passes sanitizeAuditEntry first, so only metadata is ever written: ids,
 * tier, approval method, Jev confidence, outcome, a target basename and the SHA-256 of typed text.
 * Never the text itself, transcripts or screenshots. Lines are only ever appended (O_APPEND).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeAuditEntry, type AuditEntry } from "../src/lib/control-outcome";

export function auditDir(root: string, env: Record<string, string | undefined> = process.env) {
  return env.JARVIS_AUDIT_DIR ? resolve(env.JARVIS_AUDIT_DIR) : join(root, ".operator-data", "audit");
}

/** The Sydney calendar date (YYYY-MM-DD) of an ISO instant, DST-aware. Files are named by it so a
 * Sydney morning's actions are not filed under the previous UTC day (audit A-L4). */
export function sydneyAuditDate(ts: string): string {
  const at = new Date(ts);
  if (!Number.isFinite(at.getTime())) throw new Error("Audit entry rejected: invalid timestamp.");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export type AuditLog = { dir: string; append(entry: unknown): AuditEntry; read(): AuditEntry[]; files(): string[] };

export function createAuditLog(options: { dir: string }): AuditLog {
  const dir = resolve(options.dir);
  const files = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /^control-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() : []);
  return {
    dir,
    append(raw) {
      const entry = sanitizeAuditEntry(raw);
      if (!entry) throw new Error("Audit entry rejected: missing or malformed fields.");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `control-${sydneyAuditDate(entry.ts)}.jsonl`), JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "a" });
      return entry;
    },
    read() {
      return files().flatMap((f) =>
        readFileSync(join(dir, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AuditEntry),
      );
    },
    files: () => files().map((f) => join(dir, f)),
  };
}

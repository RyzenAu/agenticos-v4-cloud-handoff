/**
 * The gateway's append-only audit: one JSON line per request, in MU_DATA_DIR/gateway/audit-YYYY-MM-DD.jsonl (UTC day).
 *
 * What a line may hold is a CLOSED list of fields (AuditEntry). There is no way to pass a header, a cookie, an enrolment
 * code, a token, the assertion key, a query string or a body to it: the route is the policy's TEMPLATE, never the raw URL,
 * and record ids come only from the hub's X-MU-Record-Ids response header for a write.
 * Files are opened for append only and never rewritten or truncated by this code.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEntry = {
  /** ISO time. */
  at: string;
  /** "request" for a proxied or refused request; the rest are gateway events. */
  event: "request" | "enrol" | "enrol-failed" | "renew" | "renew-failed" | "logout" | "session-rotated" | "session-ended" | "stream-closed" | "socket-closed" | "kill-switch" | "identity-revoked" | "identity-renewed";
  /** "dot" for a signed-in request; null for an anonymous one. Never a founder. */
  person: "dot" | null;
  /** The session's public id (not the cookie). */
  session: string | null;
  /** Dot's identity (its public id, as listed in Devices and people), when the request was signed in. */
  identity?: string;
  ip: string;
  method?: string;
  /** The policy template ("/__operator/leads/**", "page", "/gw/enrol"), or "unlisted" when no rule matched. */
  route?: string;
  /** The capability the route needed (and, when allowed, used). */
  capability?: string;
  status?: number;
  outcome: "allowed" | "denied";
  /** Why it was denied, as a fixed word (never free text from the request). */
  reason?: string;
  /** For a write: the ids of the records it touched, as reported by the hub. */
  recordIds?: string[];
  /** The founder who granted the capability this request used. */
  delegatedBy?: string;
  ms?: number;
};

const FIELDS: ReadonlyArray<keyof AuditEntry> = ["at", "event", "person", "session", "identity", "ip", "method", "route", "capability", "status", "outcome", "reason", "recordIds", "delegatedBy", "ms"];
const clean = (value: string, max: number) => value.replace(/[^\w .,:@/*()[\]-]/g, "?").slice(0, max);

/** Record ids as the hub reported them: short plain tokens only. */
export function parseRecordIds(header: string | null): string[] {
  return String(header ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9:_-]{1,80}$/.test(s))
    .slice(0, 20);
}

export class AuditLog {
  private anonymous = { minute: 0, count: 0 };
  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true });
  }
  fileFor(at: number) {
    return join(this.dir, `audit-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  }
  write(input: Omit<AuditEntry, "at">) {
    const at = this.now();
    // An anonymous flood must not fill the disk: at most 120 anonymous lines a minute, then one marker line.
    if (input.person === null) {
      const minute = Math.floor(at / 60_000);
      if (minute !== this.anonymous.minute) this.anonymous = { minute, count: 0 };
      this.anonymous.count++;
      if (this.anonymous.count > 121) return;
      if (this.anonymous.count === 121) input = { event: "request", person: null, session: null, ip: "-", outcome: "denied", reason: "anonymous-flood-further-lines-dropped-this-minute" };
    }
    const entry: Record<string, unknown> = { at: new Date(at).toISOString() };
    for (const key of FIELDS) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined || key === "at") continue;
      if (typeof value === "string") entry[key] = clean(value, 160);
      else if (typeof value === "number" || value === null) entry[key] = value;
      else if (Array.isArray(value)) entry[key] = value.filter((v) => typeof v === "string").map((v) => clean(v as string, 80)).slice(0, 20);
    }
    try {
      appendFileSync(this.fileFor(at), JSON.stringify(entry) + "\n", { flag: "a" });
    } catch (error) {
      // An audit that cannot be written is worth a (value-free) line on the console; the request itself has been decided already.
      console.error(`[gateway] audit write failed: ${(error as Error).name}`);
    }
  }
}

/** Every audit line on disk, oldest first (the CLI's `audit` command and the tests). */
export function readAudit(dir: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    return out;
  }
  for (const name of names)
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* a torn last line */
      }
    }
  return out;
}

// Away mode's state (one JSON file in .operator-data) and its audit trail on D: (one JSONL file per
// Sydney calendar day, plus low-res masked screenshots), both pruned after 7 days. One-time approval
// codes are never written to either (the state keeps only an in-memory-keyed HMAC).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Route, RouteName } from "./policy";

export type TaskStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "refused" | "stopped" | "not_approved" | "interrupted" | "cancelled";
export type TaskSource = "telegram" | "os" | "voice";
export type AwayTask = {
  id: number;
  text: string;
  route: RouteName;
  plan: Route;
  from: TaskSource;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: string;
  /** Screen plans: the next step to run (so an approved press resumes where it stopped). */
  step?: number;
};
export type PendingApproval = {
  /**
   * HMAC-SHA256 of the one-time code under a key that lives only in the runner's memory (Stage 0 F9):
   * the code itself is never written to disk. A restart drops the key, and recover() drops the pending
   * approval with it, so nothing on disk can ever approve anything.
   */
  codeHash: string;
  taskId: number;
  /** What exactly would happen, in words (shown on his phone). */
  action: string;
  /** The button label (screen) the code unlocks, or the file operation index. */
  confirm?: string;
  step?: number;
  createdAt: string;
  expiresAt: string;
  wrong: number;
  shot?: string;
  /**
   * away.payment: the exact payment this code approves (host, payee, amount, currency, button, card's last
   * four, the control's signature and its digest), bound to the task by `argsDigest`. Single use; 10 min.
   */
  payment?: PendingPayment;
};
export type PendingPayment = {
  kind: string;
  host: string | null;
  url: string | null;
  payee: string;
  amount: string;
  currency: string;
  label: string;
  last4: string | null;
  element: string;
  digest: string;
  /** sha256 over task id + step + digest: the code approves this payment for this task, nothing else. */
  argsDigest: string;
};
/** A payment receipt (kept, never pruned with the 7-day step log). */
export type PaymentReceipt = { ts: string; task: number; kind: string; amount: string; currency: string; payee: string; host: string | null; reference: string | null; outcome: "confirmed" | "unknown"; shot?: string | null };
export type AwayState = {
  version: 1;
  on: boolean;
  since?: string;
  /** Armed once the PC has been idle long enough; from then on, his input means he's back. */
  armed: boolean;
  /** /stop: nothing new starts until /away resume. */
  paused: boolean;
  nextId: number;
  tasks: AwayTask[];
  pending: PendingApproval | null;
  /** The last file an away task wrote ("delete that test file"). */
  lastPath: string | null;
  lockedNoticeAt?: string;
};

export const EMPTY_STATE: AwayState = { version: 1, on: false, armed: false, paused: false, nextId: 1, tasks: [], pending: null, lastPath: null };
const KEEP_FINISHED = 60;
const ACTIVE: TaskStatus[] = ["queued", "running", "awaiting_approval"];

export function stateStore(dir: string) {
  const file = join(dir, "state.json");
  let cache: AwayState | null = null;
  const read = (): AwayState => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as AwayState;
      cache = parsed?.version === 1 ? { ...EMPTY_STATE, ...parsed } : { ...EMPTY_STATE };
    } catch {
      cache = { ...EMPTY_STATE, tasks: [] };
    }
    return cache;
  };
  const write = (state: AwayState) => {
    // Old finished tasks go; active ones always stay.
    const finished = state.tasks.filter((t) => !ACTIVE.includes(t.status));
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map((t) => t.id));
    state.tasks = state.tasks.filter((t) => !drop.has(t.id));
    cache = state;
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, file);
  };
  return {
    read,
    update<T>(change: (state: AwayState) => T): T {
      const state = read();
      const out = change(state);
      write(state);
      return out;
    },
    /** After a restart: a task that was mid-run can't be trusted to continue on its own. */
    recover(now: string) {
      const state = read();
      let changed = false;
      for (const task of state.tasks)
        if (task.status === "running" || task.status === "awaiting_approval") {
          task.status = "interrupted";
          task.endedAt = now;
          task.result = "Interrupted: the OS server restarted mid-task. Nothing further was done.";
          changed = true;
        }
      if (state.pending) {
        state.pending = null;
        changed = true;
      }
      if (changed) write(state);
      return changed;
    },
  };
}
export type StateStore = ReturnType<typeof stateStore>;

// --- audit log --------------------------------------------------------------------------------------
export type AuditEntry = { ts: string; task?: number; action: string; target?: string; result: string; shot?: string };

/** The Sydney calendar day of a moment, YYYY-MM-DD (Stage 0 F9: his day, not UTC's, names each log file). */
const SYDNEY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
export const sydneyDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? SYDNEY_DAY.format(d) : iso.slice(0, 10);
};
const day = sydneyDay;
export const RETENTION_DAYS = 7;

export function auditLog(dataDir: string, now: () => Date = () => new Date()) {
  const logDir = join(dataDir, "log");
  const shotDir = join(dataDir, "shots");
  return {
    dataDir,
    logDir,
    shotDir,
    /** A new screenshot path for today (the folder is made here). */
    shotPath(taskId: number | undefined, label: string) {
      const ts = now().toISOString();
      const dir = join(shotDir, day(ts));
      mkdirSync(dir, { recursive: true });
      return join(dir, `${ts.replace(/[:.]/g, "-")}-t${taskId ?? 0}-${label.replace(/[^a-z0-9-]+/gi, "-").slice(0, 24)}.jpg`);
    },
    write(entry: Omit<AuditEntry, "ts"> & { ts?: string }) {
      const full: AuditEntry = { ts: entry.ts ?? now().toISOString(), ...entry };
      // Never a secret in the log: targets and results are clipped and scrubbed of anything key-like.
      full.target = full.target ? scrub(full.target).slice(0, 200) : undefined;
      full.result = scrub(full.result).slice(0, 400);
      try {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, `${day(full.ts)}.jsonl`), `${JSON.stringify(full)}\n`);
      } catch {
        /* D: unavailable: the state file still has the outcome */
      }
      return full;
    },
    /** away.payment: one receipt per approved payment, in receipts/receipts.jsonl (kept; not pruned). */
    receipt(entry: PaymentReceipt) {
      try {
        const dir = join(dataDir, "receipts");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "receipts.jsonl"), `${JSON.stringify({ ...entry, payee: scrub(entry.payee), reference: entry.reference ? scrub(entry.reference) : null })}\n`);
        return true;
      } catch {
        return false;
      }
    },
    /** The last n entries, newest last (reads today's and earlier files as needed). */
    tail(n: number): AuditEntry[] {
      if (!existsSync(logDir)) return [];
      const files = readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
      const out: AuditEntry[] = [];
      for (const f of files) {
        const lines = readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean).reverse();
        for (const line of lines) {
          try {
            out.push(JSON.parse(line));
          } catch {
            /* a torn line */
          }
          if (out.length >= n) return out.reverse();
        }
      }
      return out.reverse();
    },
    /** Delete log files and screenshot folders older than RETENTION_DAYS. Returns what went. */
    prune(days = RETENTION_DAYS) {
      const cutoff = now().getTime() - days * 86_400_000;
      const removed: string[] = [];
      const old = (name: string) => {
        const d = Date.parse(`${name.slice(0, 10)}T00:00:00Z`);
        return Number.isFinite(d) && d + 86_400_000 <= cutoff;
      };
      for (const [dir, isDir] of [[logDir, false], [shotDir, true]] as const) {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (!/^\d{4}-\d{2}-\d{2}/.test(name) || !old(name)) continue;
          try {
            if (isDir !== statSync(path).isDirectory()) continue;
            rmSync(path, { recursive: isDir, force: true });
            removed.push(path);
          } catch {
            /* in use: next prune */
          }
        }
      }
      return removed;
    },
  };
}
export type AuditLog = ReturnType<typeof auditLog>;

/** Mask anything that looks like a key, token or long digit run (card, account) in log text. */
export function scrub(text: string) {
  return String(text)
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]")
    .replace(/\bbearer\s+\S{8,}/gi, "bearer [token]")
    .replace(/\b\d(?:[ -]?\d){11,18}\b/g, "[number]");
}

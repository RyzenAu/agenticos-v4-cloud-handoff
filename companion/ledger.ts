import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutorResult } from "../scripts/jarvis-command/contracts";

/**
 * What this PC has been asked to do and what came of it, keyed by the hub's commandKey (one key per intended
 * action: `<jobId>/<stepId>`). It is the companion's half of "never repeat an action blindly":
 *
 *   - a command whose key is already here is NEVER run again (a redelivery gets the recorded report, not a rerun);
 *   - a hub that lost an ack asks "what happened to <key>?" and is answered from here (done / running / interrupted / unknown);
 *   - it is written to disk BEFORE an action starts, so a companion that was killed mid-step answers "interrupted"
 *     after it restarts, never "unknown" (unknown means: this PC has no record of ever receiving it).
 *
 * Bounded (200 entries, 2 hours) and private to this PC's config folder (mode 0600).
 */

export type LedgerState = "running" | "done" | "failed" | "cancelled" | "refused" | "interrupted";
export type LedgerEntry = {
  commandKey: string;
  commandId: string;
  executor: string;
  jobId?: string;
  stepId?: string;
  state: LedgerState;
  startedAt: number;
  finishedAt?: number;
  /** The ExecutorResult (or the refusal) that was, or still has to be, reported to the hub. */
  output?: ExecutorResult;
  error?: string;
  /** The hub has accepted (or finally refused) the report: nothing more to send. */
  reported: boolean;
};

const MAX_ENTRIES = 200;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export class CommandLedger {
  private entries = new Map<string, LedgerEntry>();

  /** `path`: where to persist (a companion's config folder); undefined keeps it in memory only. */
  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    if (!path) return;
    try {
      const list = JSON.parse(readFileSync(path, "utf8")) as LedgerEntry[];
      for (const e of Array.isArray(list) ? list : []) {
        if (!e || typeof e.commandKey !== "string" || typeof e.commandId !== "string") continue;
        // A process that died mid-step left it running: it may or may not have finished, and nobody saw.
        this.entries.set(e.commandKey, e.state === "running" ? { ...e, state: "interrupted", finishedAt: this.now() } : e);
      }
      this.persist();
    } catch {
      /* no ledger yet, or unreadable: start empty (an unreadable one is treated as no record) */
    }
  }

  get(key: string): LedgerEntry | undefined {
    return this.entries.get(key);
  }

  byCommandId(commandId: string): LedgerEntry | undefined {
    for (const e of this.entries.values()) if (e.commandId === commandId) return e;
    return undefined;
  }

  /** Record that an action is about to start. Returns false when the key is already known (never run it twice). */
  begin(entry: Omit<LedgerEntry, "state" | "startedAt" | "reported">): boolean {
    if (this.entries.has(entry.commandKey)) return false;
    this.entries.set(entry.commandKey, { ...entry, state: "running", startedAt: this.now(), reported: false });
    this.trim();
    this.persist();
    return true;
  }

  finish(key: string, state: Exclude<LedgerState, "running">, output?: ExecutorResult, error?: string) {
    const e = this.entries.get(key);
    if (!e) return;
    e.state = state;
    e.finishedAt = this.now();
    if (output) e.output = output;
    if (error) e.error = error.slice(0, 300);
    this.persist();
  }

  markReported(key: string) {
    const e = this.entries.get(key);
    if (!e || e.reported) return;
    e.reported = true;
    this.persist();
  }

  /** Finished entries whose report the hub hasn't accepted yet. */
  unreported(): LedgerEntry[] {
    return [...this.entries.values()].filter((e) => !e.reported && e.state !== "running" && e.state !== "interrupted" && !!e.output);
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  private trim() {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const [k, e] of this.entries) if (e.state !== "running" && e.startedAt < cutoff) this.entries.delete(k);
    if (this.entries.size > MAX_ENTRIES) for (const [k, e] of this.entries) if (e.state !== "running" && this.entries.size > MAX_ENTRIES) this.entries.delete(k);
  }

  private persist() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* a full disk must not stop the companion; it simply remembers less */
    }
  }
}

import { createHash } from "node:crypto";
import type { Step } from "../../jobs/types";
import type { ArtifactInput } from "../artifacts";
import type { CallResult, Delegate } from "../research";

/**
 * What every bot-computer workflow (builder, website audit, business preparation; research has its own older loop) is given and returns.
 *
 * A workflow is a small, bounded plan the HUB runs: each move is a typed executor on the computer (through the job's control lease), each move is
 * verified by the computer's own read-back, and the same gate as research runs before every move (stopped? a person taking over? out of budget?).
 * A workflow never holds a key, never sends or publishes anything, and ends by keeping one artifact on the hub and appending ONE result entry to the
 * conversation that asked.
 */

export type WorkflowKind = "builder" | "audit" | "bizprep";
export const WORKFLOW_KINDS: readonly WorkflowKind[] = ["builder", "audit", "bizprep"];
export const WORKFLOW_LABEL: Record<WorkflowKind | "research", string> = { research: "Research", builder: "Builder", audit: "Website audit", bizprep: "Business preparation" };

export type WorkflowIO = {
  signal: AbortSignal;
  jobId: string;
  computer: string;
  /** One short, plain line for the artifact: "Ryzen-PC (LAN host, WSL)" or "this PC's WSL". */
  hostLabel: string;
  /** One move on the computer, through the lease. `quiet`: no job step per call (bulk file pulls log ONE summary step instead). */
  call(executor: string, args: Record<string, unknown>, label: string, options?: { quiet?: boolean; timeoutMs?: number }): Promise<CallResult>;
  step(step: Omit<Step, "seq" | "at">): void;
  /** A safe boundary: a person asking to take the computer pauses here. "stop" = stopped, or the job lost the computer. */
  boundary(): Promise<"go" | "stop">;
  delegate: Delegate | null;
  /** Keep the result on the hub (opens from the OS). One per job: a second call returns the first. */
  artifact(input: Omit<ArtifactInput, "jobId" | "personId" | "computer" | "host">): { ok: true; title: string; created: boolean } | { ok: false; reason: string };
  /** Append the short result to the conversation the job came from (one entry, replay-safe). */
  deliver(text: string, meta: { artifact: string | null; label: string; web: boolean }): Promise<{ delivered: boolean; where: string }>;
  now?: () => number;
};

export type WorkflowResult = { ok: boolean; outcome: "complete" | "partial" | "failed" | "stopped"; note: string; settle?: "unknown"; facts?: number; wallMs: number };

/** Thrown by `gate`/`mustCall` to unwind a workflow to its single exit. */
export class Halt extends Error {
  constructor(readonly kind: "stopped" | "lost" | "uncertain" | "failed", message: string) {
    super(message);
  }
}
export const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** The ONE gate every move passes: stopped, then a person taking over (the call waits), then the run's own budget. */
export async function gate(io: WorkflowIO, over?: () => boolean): Promise<void> {
  if (io.signal.aborted) throw new Halt("stopped", "Stopped on request.");
  if ((await io.boundary()) === "stop") throw new Halt(io.signal.aborted ? "stopped" : "lost", io.signal.aborted ? "Stopped on request." : "The job lost the computer, so the work did not continue.");
  if (over?.()) throw new Halt("failed", "The time budget ran out.");
}

export type Ok = Extract<CallResult, { kind: "ok" }>;
/** A move that must succeed: anything else ends the workflow with the reason (a stop, a lost computer or an unsure outcome keep their own meaning). */
export async function mustCall(io: WorkflowIO, executor: string, args: Record<string, unknown>, label: string, over?: () => boolean, options?: { quiet?: boolean; timeoutMs?: number }): Promise<Ok> {
  await gate(io, over);
  const r = await io.call(executor, args, label, options);
  if (r.kind === "cancelled") throw new Halt("stopped", "Stopped on request.");
  if (r.kind === "lost") throw new Halt("lost", "The job lost the computer, so the work did not continue.");
  if (r.kind === "uncertain") throw new Halt("uncertain", `${r.said} I did not try again or continue.`);
  if (r.kind === "failed") throw new Halt("failed", `${label}: ${r.said}`);
  if (!r.ok) throw new Halt("failed", `${label}: ${r.said}`);
  return r;
}
/** A move whose failure is a finding, not the end: returns the result (or null on a plain failure). A stop, a lost computer or an unsure outcome still end it. */
export async function tryCall(io: WorkflowIO, executor: string, args: Record<string, unknown>, label: string, over?: () => boolean, options?: { quiet?: boolean; timeoutMs?: number }): Promise<Ok | { kind: "failed"; said: string }> {
  await gate(io, over);
  const r = await io.call(executor, args, label, options);
  if (r.kind === "cancelled") throw new Halt("stopped", "Stopped on request.");
  if (r.kind === "lost") throw new Halt("lost", "The job lost the computer, so the work did not continue.");
  if (r.kind === "uncertain") throw new Halt("uncertain", `${r.said} I did not try again or continue.`);
  if (r.kind === "failed") return { kind: "failed", said: r.said };
  if (!r.ok) return { kind: "failed", said: r.said };
  return r;
}

/**
 * Bring a file from the computer's working folder to the hub, in pieces small enough for one reply, and check the whole against the computer's own
 * SHA-256. Returns null when the file could not be read whole (never a partial file). One summary step, not one per piece.
 */
export async function pullFile(io: WorkflowIO, name: string, maxBytes = 3 * 1024 * 1024, over?: () => boolean): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let offset = 0;
  let want = "";
  let size = -1;
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const r = await tryCall(io, "file.chunk", { name, offset }, `read ${name} from ${offset}`, over, { quiet: true, timeoutMs: 30_000 });
    if (r.kind === "failed") {
      io.step({ intent: `could not read ${name} back from the computer: ${r.said}`.slice(0, 280), executor: "companion", ms: Date.now() - t0, outcome: "failed", verification: { method: "file-chunks", ok: false } });
      return null;
    }
    const d = r.data as { b64?: unknown; size?: unknown; done?: unknown; sha256?: unknown } | undefined;
    if (typeof d?.b64 !== "string" || typeof d.size !== "number" || typeof d.sha256 !== "string") return null;
    if (size >= 0 && (d.size !== size || d.sha256 !== want)) return null; // the file changed while it was being read
    size = d.size;
    want = d.sha256;
    if (size > maxBytes) return null;
    const part = Buffer.from(d.b64, "base64");
    parts.push(part);
    offset += part.length;
    if (d.done === true || offset >= size) break;
    if (!part.length) return null;
  }
  const all = Buffer.concat(parts);
  const ok = all.length === size && sha256(all) === want;
  io.step({ intent: `read ${name} back from the computer: ${all.length} bytes, ${ok ? "checksum matches" : "checksum DOES NOT match"}`.slice(0, 280), executor: "companion", ms: Date.now() - t0, outcome: ok ? "ok" : "failed", verification: { method: "file-chunks", ok, evidence: `sha256 ${want.slice(0, 12)}` } });
  return ok ? all : null;
}

/** A sub-goal line the conversation shows live (`progressFor` in jarvis-command/threads.ts reads exactly this shape). */
export function makeProgress(io: WorkflowIO, kind: WorkflowKind, names: readonly string[]) {
  const done = new Set<number>();
  return (i: number, status: "started" | "done" | "skipped" | "failed", text: string) => {
    if (status === "done") done.add(i);
    io.step({
      intent: `sub-goal ${i + 1} of ${names.length}, ${names[i]}: ${status}. ${text} (${done.size} of ${names.length} done)`.slice(0, 280),
      executor: kind,
      ms: 0,
      outcome: status === "failed" ? "failed" : status === "done" ? "ok" : "note",
      verification: { method: "workflow-subgoal", ok: status === "failed" ? false : status === "done" ? true : null, evidence: `${done.size}/${names.length}` },
    });
  };
}

export const note = (io: WorkflowIO, kind: WorkflowKind, intent: string, outcome: Step["outcome"] = "note", extra: Partial<Step> = {}) => io.step({ intent: intent.slice(0, 280), executor: kind, ms: 0, outcome, ...extra });

/** A halt becomes the workflow's result. */
export function haltResult(e: unknown, t0: number, now: () => number): WorkflowResult {
  const wallMs = now() - t0;
  if (e instanceof Halt) {
    if (e.kind === "stopped") return { ok: false, outcome: "stopped", note: e.message, wallMs };
    if (e.kind === "lost") return { ok: false, outcome: "stopped", note: e.message, wallMs };
    if (e.kind === "uncertain") return { ok: false, outcome: "failed", settle: "unknown", note: e.message, wallMs };
    return { ok: false, outcome: "failed", note: e.message, wallMs };
  }
  throw e;
}

export function parseJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
export const slug = (s: string, max = 30) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
export const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // A cell that starts with = + - @ would be a formula in a spreadsheet: it is prefixed with an apostrophe.
  const safe = /^[=+@]/.test(s) || /^-(?!\d)/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

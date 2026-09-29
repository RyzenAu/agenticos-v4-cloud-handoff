import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { terminateChild, type PlatformOptions } from "../../assistant-runtime";
import { redactText } from "../redact";
import type { InputRequest, IsoTime } from "../contracts";
import type { PolicyFn, PolicyRequest, PolicyVerdict, RunnerEvent } from "./types";

/** Shared process plumbing for the native runners: JSON lines, verified tree kill, the input queue. */

export type Spawn = typeof spawn;
export const MAX_LINE = 1_000_000;
export const MAX_OUTPUT = 32_000_000;
export const DENY_CAP = 25;

/** Split a stream into JSON objects, one per line; calls `bad` on an unreadable or oversized line. */
export function jsonLines(onMessage: (m: Record<string, any>) => void, bad: (why: string) => void) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let total = 0;
  const feed = (text: string) => {
    buffer += text;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) return bad("oversized event");
      let message: unknown;
      try { message = JSON.parse(line); } catch { return bad("unreadable event"); }
      if (message && typeof message === "object" && !Array.isArray(message)) onMessage(message as Record<string, any>);
    }
    if (buffer.length > MAX_LINE) bad("oversized event");
  };
  return {
    write(chunk: Buffer | string) {
      total += typeof chunk === "string" ? chunk.length : chunk.length;
      if (total > MAX_OUTPUT) return bad("output limit");
      feed(decoder.write(chunk as Buffer));
    },
    end() { feed(decoder.end() + "\n"); },
  };
}

/**
 * Kill the process tree and wait for `close`. Resolves true when the close was seen within `graceMs`,
 * false when it wasn't (the caller reports `termination_unverified`). Never hangs.
 */
export async function verifiedKill(child: ChildProcessWithoutNullStreams | undefined, closed: () => boolean, onClose: (fn: () => void) => void, options: PlatformOptions & { graceMs?: number; softMs?: number } = {}): Promise<boolean> {
  if (!child || closed()) return true;
  // A clean end first (stdin closed: the CLI saves its session and exits), then the tree kill.
  if (options.softMs) {
    try { child.stdin.end(); } catch { /* already closed */ }
    const soft = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(closed()), options.softMs);
      t.unref?.();
      onClose(() => { clearTimeout(t); resolve(true); });
    });
    if (soft) return true;
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    onClose(() => finish(true));
    try { child.stdin.end(); } catch { /* already closed */ }
    terminateChild(child, "SIGTERM", options);
    const hard = setTimeout(() => { if (!closed()) terminateChild(child, "SIGKILL", options); }, Math.min(1000, (options.graceMs ?? 5000) / 2));
    hard.unref?.();
    const timer = setTimeout(() => finish(closed()), options.graceMs ?? 5000);
    timer.unref?.();
  });
}

type Pending = { request: InputRequest; answer: (decision: "approve" | "deny", answers?: Record<string, string>) => void; timer?: ReturnType<typeof setTimeout> };

/**
 * The escalation queue: one input shown at a time; a timeout answers deny and reports `expired`.
 * `respond` throws for any id that isn't the one waiting.
 */
export function inputQueue(emit: (e: RunnerEvent) => void, timeoutMs: number) {
  const queue: Pending[] = [];
  const show = () => {
    const head = queue[0];
    if (!head || head.timer) return;
    head.timer = setTimeout(() => {
      if (queue[0] !== head) return;
      queue.shift();
      emit({ type: "input_resolved", id: head.request.id, decision: "expired" });
      head.answer("deny");
      show();
    }, timeoutMs);
    head.timer.unref?.();
    emit({ type: "input", request: head.request });
  };
  return {
    push(request: InputRequest, answer: Pending["answer"]) { queue.push({ request, answer }); show(); },
    respond(id: string, decision: "approve" | "deny", answers?: Record<string, string>) {
      const head = queue[0];
      if (!head || head.request.id !== id) throw new Error("That input is not the one waiting.");
      if (decision !== "approve" && decision !== "deny") throw new Error("Approve or deny.");
      clearTimeout(head.timer);
      queue.shift();
      emit({ type: "input_resolved", id, decision });
      head.answer(decision, answers);
      show();
    },
    get size() { return queue.length; },
    clear() { for (const p of queue) clearTimeout(p.timer); queue.length = 0; },
  };
}

export function isoIn(ms: number): IsoTime {
  return new Date(Date.now() + ms).toISOString() as IsoTime;
}

/** Run the policy, emit the decision, and count denies. */
export function decider(policy: PolicyFn, emit: (e: RunnerEvent) => void) {
  let denies = 0;
  return {
    decide(nativeKind: string, requestId: string, request: PolicyRequest): PolicyVerdict {
      let verdict: PolicyVerdict;
      try { verdict = policy(request); }
      catch { verdict = { decision: "escalate", rule: "unclassified", target: nativeKind, message: "The coding policy failed on this request, so the owner is being asked." }; }
      if (verdict.decision === "auto-deny") denies++;
      emit({ type: "policy", nativeKind, requestId, verdict });
      return verdict;
    },
    get denies() { return denies; },
    get capped() { return denies >= DENY_CAP; },
  };
}

/** Redacted JSON detail for an approval card (bounded, secret-shaped keys blanked). */
export function detailOf(value: unknown, limit = 4000): string {
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 4) return "[nested]";
    if (typeof v === "string") return redactText(v, 1500);
    if (Array.isArray(v)) return v.slice(0, 12).map((x) => clean(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 24).map(([k, x]) => [k, /token|secret|password|authorization|cookie|api.?key|credential/i.test(k) ? "[redacted]" : clean(x, depth + 1)]));
    return v;
  };
  return redactText(JSON.stringify(clean(value), null, 2), limit);
}

/** Coalesce text deltas: at most one event per `everyMs`, plus the final. */
export function textCoalescer(emit: (e: RunnerEvent) => void, everyMs = 500) {
  let text = "", last = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { timer = undefined; last = Date.now(); emit({ type: "text", text: redactText(text, 16_000), final: false }); };
  return {
    set(value: string) {
      text = value;
      if (timer) return;
      const wait = everyMs - (Date.now() - last);
      if (wait <= 0) flush();
      else { timer = setTimeout(flush, wait); timer.unref?.(); }
    },
    final(value: string) {
      clearTimeout(timer); timer = undefined;
      text = value;
      emit({ type: "text", text: redactText(text, 16_000), final: true });
    },
    stop() { clearTimeout(timer); timer = undefined; },
    get value() { return text; },
  };
}

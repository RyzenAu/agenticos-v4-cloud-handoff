// One audit shape for every control path (screen_act over UIA, the Playwright executor, the file
// dialogs, control_pc): {action, executor, judgment, tier, confidence, verdict, ms, outcome}, metadata
// only. The goal and anything typed are only ever hashed; step descriptions ("typed "hello"") and window
// titles (which can name his documents) are never written. The writer (scripts/control-audit.ts) runs
// every entry through sanitizeAuditEntry as well.
import { createHash } from "node:crypto";
import { classifyControlTask } from "../../src/lib/control-risk";
import { targetOf, type AuditEntry, type ControlExecutor, type ControlOutcome } from "../../src/lib/control-outcome";
import type { ScreenDone, ScreenEvent } from "./index";

export const goalHash = (goal: string) => createHash("sha256").update(goal, "utf8").digest("hex");

/** A screen_act result → the one outcome vocabulary. Success needs every step independently verified. Pure. */
export function screenOutcome(done: ScreenDone, events: ScreenEvent[]): ControlOutcome {
  if (done.stopped) return "cancelled";
  if (!done.ok) return done.outcome && done.outcome !== "no_progress" ? "unverified" : "failed";
  if (done.ask || done.confirm) return "unverified";
  const steps = events.filter((e): e is Extract<ScreenEvent, { type: "step" }> => e.type === "step");
  return steps.length > 0 && steps.every((s) => s.verified === true) ? "success" : "unverified";
}

const EXECUTOR: Record<NonNullable<ScreenDone["path"]>, ControlExecutor> = { rules: "rules", model: "model", jev: "jev", vision: "vision" };

/** The audit entries for one run: the steps (verification only), then the run. Pure. */
export function screenAuditEntries(input: {
  taskId: string;
  goal: string;
  done: ScreenDone;
  events: ScreenEvent[];
  /** Overrides the chooser-derived executor (e.g. "playwright" for a browser target). */
  executor?: ControlExecutor;
  /** He said yes to this press (req.confirm). */
  confirmed?: boolean;
  ts?: () => string;
}): Omit<AuditEntry, never>[] {
  const ts = input.ts ?? (() => new Date().toISOString());
  const tier = classifyControlTask(input.goal).tier;
  const executor = input.executor ?? EXECUTOR[input.done.path ?? "rules"];
  const target = targetOf(input.goal);
  const entries: AuditEntry[] = [];
  let n = 0;
  for (const e of input.events) {
    if (e.type !== "step") continue;
    entries.push({
      ts: ts(), taskId: input.taskId, action: "screen_step", step: ++n, tier, approval: "not-needed", executor,
      outcome: e.verified === false ? "step-failed" : "step-ok",
      verification: e.verified === true ? "passed" : e.verified === false ? "failed" : "inconclusive",
      ms: e.ms,
    });
  }
  const verdict = input.done.confirm ? "confirm" : input.done.ok ? "allow" : undefined;
  entries.push({
    ts: ts(), taskId: input.taskId, action: "screen_act", tier, executor,
    approval: input.confirmed ? "spoken-yes" : input.done.confirm ? "none" : "not-needed",
    outcome: input.done.confirm ? "awaiting-approval" : screenOutcome(input.done, input.events),
    judgment: "vet",
    ...(verdict ? { verdict } : {}),
    ...(target ? { target } : {}),
    typedSha256: goalHash(input.goal),
    ms: input.done.ms,
  });
  return entries;
}

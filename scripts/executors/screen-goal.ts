/**
 * screen.goal: the companion's open-ended desktop executor (programme 20261001, Agent B).
 *
 * It runs, on THIS PC, the very same thing the PC hub runs for /screen/command today: the Jarvis entry
 * (scripts/jev-command.ts: Jev's decision, the deterministic lanes, the Jev-first screen loop in
 * scripts/screen-hands, the app browser) over this PC's own hands. No new decision logic lives here. This file only
 *
 *   - hands the entry the utterance and the job's AbortSignal (a cancel stops later sub-steps),
 *   - streams each sub-step (the run log's steps: intent, executor, outcome, verification) back to the hub as it
 *     happens, so the hub job shows them as they occur,
 *   - maps the entry's answer to an ExecutorResult: done (ok, verified), or a QUESTION ("Shall I press Send?") that
 *     comes back as data { ask, confirm, resumeGoal } for the hub to hold as awaiting-approval,
 *   - resumes a waiting question on the SAME device: the hub has already checked the person's spoken yes against its own
 *     voice pipeline, and says so in the command (`yes`); this PC then records that yes on ITS OWN ledger and re-runs the
 *     screen gate with it, so the gate's own binding (the same window, page and control the question was about) and
 *     its no-replay rule apply unchanged.
 *
 * Everything the loop needs (Jev's key, models) is loaded the way the hub loads it (providerKey: the process
 * environment, .env.local, ~/.config/agentic-os.env), never printed. The entry and the screen hands are injected, so
 * the rules here are tested with fakes; `liveScreenGoalDeps()` builds the real ones on first use.
 */
import { randomUUID } from "node:crypto";
import type { ProgressStep } from "../devices/dispatch";
import type { CommandDone, CommandEvent, JarvisEntry } from "../jev-command";
import type { ExecutorResult } from "../jarvis-command/contracts";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { RunRecord } from "../screen-hands/run-log";
import type { ScreenDone, ScreenHands } from "../screen-hands/index";

export type ScreenGoalDeps = {
  entry: () => JarvisEntry | Promise<JarvisEntry>;
  screen: () => Pick<ScreenHands, "act" | "runs"> | Promise<Pick<ScreenHands, "act" | "runs">>;
  /** This PC's own spoken-yes ledger (the screen hands' `spoken`). */
  ledger: SpokenConfirmationLedger;
  /** The device id the entry uses for "this PC" (jev-target THIS_PC_DEVICE_ID). */
  thisPc: string;
  close?: () => Promise<void> | void;
};
export type ScreenGoalCtx = { signal: AbortSignal; owner: "usman" | "mehroz"; progress?: (step: ProgressStep) => void };
export type ScreenGoalArgs = {
  goal?: unknown;
  surface?: unknown;
  /** Answering a question this PC asked: what it asked about, and that the hub has verified the person's spoken yes. */
  resume?: { goal?: unknown; confirm?: unknown };
  yes?: unknown;
};

const STAGE_OUTCOME: Record<string, ProgressStep["outcome"]> = { refused: "refused", ask: "asked", unsure: "unknown" };

/** A run-log step as a progress step for the hub. Pure. */
export function progressOf(run: Pick<RunRecord, "executor" | "window">, s: RunRecord["steps"][number]): ProgressStep {
  const outcome: ProgressStep["outcome"] = STAGE_OUTCOME[s.stage] ?? (s.stage === "act" || s.stage === "check" ? (s.verified === false ? "failed" : "ok") : "note");
  return {
    intent: `${s.stage}: ${s.text}`.slice(0, 300),
    executor: run.executor,
    ...(run.window ? { target: run.window } : {}),
    ...(s.verified !== undefined ? { verification: { method: "screen-loop-check", ok: s.verified, evidence: s.text.slice(0, 160) } } : {}),
    ...(s.jev ? { action: `jev ${s.jev.op} ${Math.round(s.jev.confidence * 100)}%` } : {}),
    outcome,
    ms: s.jev?.ms ?? 0,
  };
}

type Answer = Pick<CommandDone, "ok" | "said" | "verified" | "ask" | "confirm" | "resumeGoal" | "outcome" | "stopped" | "refused" | "kind" | "runId"> & Partial<Pick<ScreenDone, "resumeFrom">>;

/** The entry's (or the screen gate's) answer as an ExecutorResult. `checks`: how many of the loop's own steps were verified. Pure. */
export function resultOf(done: Answer & { url?: string }, checks: { passed: number; failed: number; last?: string }, goal: string): ExecutorResult {
  const waiting = !!done.ask || !!done.confirm;
  const ok = done.ok && !waiting && !done.outcome && !done.stopped && !done.refused;
  // A lane that finished without saying "verified" is verified only if its own step checks passed and none failed.
  const verified = waiting ? null : done.stopped ? false : done.verified !== undefined && done.verified !== null ? done.verified : ok ? (checks.passed > 0 && checks.failed === 0 ? true : null) : false;
  return {
    ok,
    said: done.said,
    verified,
    ...(checks.passed || checks.failed ? { evidence: `${checks.passed} checked step${checks.passed === 1 ? "" : "s"} passed${checks.failed ? `, ${checks.failed} failed` : ""}${checks.last ? `; last: ${checks.last.slice(0, 100)}` : ""}` } : {}),
    data: {
      kind: done.kind,
      ...(waiting ? { ask: true, ...(done.confirm ? { confirm: done.confirm, resumeGoal: done.resumeGoal ?? goal } : {}) } : {}),
      ...(done.outcome ? { outcome: done.outcome } : {}),
      ...(done.stopped ? { stopped: true, cancelled: true } : {}),
      ...(done.refused ? { refused: true } : {}),
      ...(done.runId ? { runId: done.runId } : {}),
      ...(typeof done.url === "string" && /^https?:/i.test(done.url) ? { url: done.url } : {}),
    },
  };
}

export function createScreenGoalExecutor(deps: ScreenGoalDeps, owner: "usman" | "mehroz") {
  async function run(args: ScreenGoalArgs, ctx: ScreenGoalCtx): Promise<ExecutorResult> {
    const resume = args.resume && args.yes === true ? { goal: String(args.resume.goal ?? "").trim().slice(0, 600), confirm: String(args.resume.confirm ?? "").trim().slice(0, 200) } : null;
    const goal = resume ? resume.goal : String(args.goal ?? "").trim().slice(0, 600);
    if (!goal) return { ok: false, said: "Which goal? Say what to do on this PC.", verified: false, data: { refused: true } };
    if (args.resume && !resume) return { ok: false, said: "That answer wasn't approved by the hub, so nothing was done.", verified: false, data: { refused: true } };
    if (resume && !resume.confirm) return { ok: false, said: "I don't know which question that yes was for, so nothing was pressed.", verified: false, data: { refused: true } };
    if (ctx.signal.aborted) return { ok: false, said: "Stopped.", verified: false, data: { cancelled: true } };
    const screen = await deps.screen();
    // One token ties this goal's run-log entries to this command, so its sub-steps stream back as they happen.
    const token = `screen-goal-${randomUUID()}`;
    let sent = 0;
    const checks = { passed: 0, failed: 0, last: "" as string | undefined };
    const unsubscribe = screen.runs.subscribe((r: RunRecord) => {
      if (r.jobId !== token) return;
      for (const s of r.steps.slice(sent)) {
        ctx.progress?.(progressOf(r, s));
        if (s.verified === true) (checks.passed++, (checks.last = s.text));
        if (s.verified === false) (checks.failed++, (checks.last = s.text));
      }
      sent = r.steps.length;
    });
    try {
      const onEvent = (_e: CommandEvent | import("../screen-hands/index").ScreenEvent) => undefined;
      if (resume) {
        // The hub checked the spoken yes; this PC's own gate takes it as its own event for its OWN open question.
        const yes = deps.ledger.record("yes");
        if (!yes) return { ok: false, said: "I couldn't record that yes here, so nothing was pressed.", verified: false };
        const log = screen.runs.start({ request: resume.goal, source: "command", jobId: token });
        const done = await screen.act({ goal: resume.goal, confirm: resume.confirm, requireSpokenYes: true, spokenYes: yes.id, jev: true, source: "command" }, ctx.signal, onEvent, log);
        return resultOf({ ok: done.ok, said: done.said, verified: undefined as never, ask: done.ask, confirm: done.confirm, outcome: done.outcome, stopped: done.stopped, refused: done.refused, kind: "screen", runId: log.id, resumeGoal: resume.goal }, checks, resume.goal);
      }
      const entry = await deps.entry();
      const done = await entry.handle(
        { utterance: goal, source: "command", jobId: token, target: { deviceId: deps.thisPc, owner }, surface: args.surface === "voice" ? "voice" : "typed" },
        ctx.signal,
        onEvent,
      );
      return resultOf(done, checks, goal);
    } catch (error) {
      if (ctx.signal.aborted) return { ok: false, said: "Stopped.", verified: false, data: { cancelled: true } };
      return { ok: false, said: `The screen loop didn't finish: ${String((error as Error)?.message ?? error).slice(0, 160)}`, verified: false };
    } finally {
      unsubscribe();
    }
  }
  return run;
}

// ------------------------------------------------------------------------------------------------
// The real dependencies, built on first use.

export function liveScreenGoalDeps(options: { root: string; headless?: boolean } = { root: process.cwd() }): ScreenGoalDeps {
  // This PC's own spoken-yes ledger: the screen hands ask their questions on it, and a hub-approved yes is recorded on it.
  const ledger = new SpokenConfirmationLedger();
  let built: Promise<{ entry: JarvisEntry; screen: ScreenHands; close(): Promise<void> }> | null = null;
  const get = () =>
    (built ??= (async () => {
      const [{ createScreenHands }, { createLiveEntry }, { providerKey }] = await Promise.all([import("../screen-hands/index"), import("../jev-entry-server"), import("../provider-config")]);
      const screen = createScreenHands({ key: (name) => providerKey(options.root, name), spoken: ledger });
      const live = createLiveEntry({ screen, root: options.root, headless: options.headless });
      return { entry: live.entry, screen, close: live.close };
    })().catch((error) => {
      built = null;
      throw error;
    }));
  return {
    entry: async () => (await get()).entry,
    screen: async () => (await get()).screen,
    ledger,
    thisPc: "usman-pc",
    async close() {
      const b = built;
      built = null;
      await (await b?.catch(() => null))?.close();
    },
  };
}

// The Jarvis step log (Wave 2, 27 Sep 2026): every screen/browser/app run through the Jarvis entry, in
// full detail for the inspector drawer, while speech stays one short line per step.
//
//   GET /__operator/screen/runs            → { runs: RunSummary[] }   (newest first, 30 max)
//   GET /__operator/screen/runs?id=<id>    → { run: RunRecord } | 404
//
// A record holds: the route (Jev's intent and confidence, or the handoff), the target machine, the
// executor, and per step the stage, the plain-words line, Jev's decision (op, confidence, policy,
// latency, tokens) and the check (verified or not). Privacy: every line is already masked by the loop
// (typed text as "[typed N characters, sha256 …]", files as basenames, his dictated payloads as
// placeholders); this module masks again defensively (long digit runs, e-mail addresses) and keeps
// everything in memory only: nothing here is written to disk (the hash-only audit JSONL is the
// durable record). A restart clears it.
import { randomUUID } from "node:crypto";

export const RUN_LOG_MAX_RUNS = 30;
export const RUN_LOG_MAX_STEPS = 80;

export type RunExecutor = "uia" | "playwright" | "cdp" | "app-api" | "deterministic" | "handoff" | "none";
export type RunStage = "intent" | "route" | "target" | "window" | "decision" | "act" | "check" | "unsure" | "ask" | "outcome" | "fallback" | "handoff" | "refused" | "note";
export type RunStep = {
  seq: number;
  at: number;
  stage: RunStage;
  /** One short line (what is spoken, when `spoken`). */
  text: string;
  spoken?: boolean;
  /** Jev's decision for this step, when it made one. */
  jev?: { op: string; confidence: number; policy: string; ms: number; inputTokens: number | null; outputTokens: number | null };
  /** The deterministic check of the last action. */
  verified?: boolean;
};
export type RunOutcome = { ok: boolean; said: string; outcome?: string; ask?: boolean; stopped?: boolean; confirm?: string; ms: number };
export type RunRecord = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** His request, redacted (dictated text and file names as placeholders). */
  request: string;
  source: "voice" | "command" | "away" | "acceptance" | "other";
  route: { kind: string; intent?: string; confidence?: number; handoff?: string } | null;
  target: { deviceId: string; owner: string } | null;
  executor: RunExecutor;
  window: string | null;
  steps: RunStep[];
  jev: { calls: number; ms: number[]; inputTokens: number; outputTokens: number };
  outcome: RunOutcome | null;
  /** Set when the run belongs to a Job the command service already records (Track 2): the B2 mirror skips it. */
  jobId?: string;
};
export type RunSummary = Pick<RunRecord, "id" | "startedAt" | "endedAt" | "request" | "source" | "executor" | "window"> & {
  route: RunRecord["route"];
  steps: number;
  jevCalls: number;
  outcome: RunOutcome | null;
};

const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
const DIGITS = /\d[\d -]{6,}\d/g;
/** Defensive masking for anything that reaches the log. Pure. */
export function maskLine(text: unknown, max = 300): string {
  return String(text ?? "")
    .replace(EMAIL, "[email]")
    // Long digit runs (phone, card, account numbers) go; ISO dates ("2026-09-27") stay.
    .replace(DIGITS, (m) => (/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) || m.replace(/\D/g, "").length < 7 ? m : "[number]"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type RunHandle = {
  id: string;
  step(step: Omit<RunStep, "seq" | "at">): void;
  set(patch: Partial<Pick<RunRecord, "route" | "target" | "executor" | "window">>): void;
  jev(ms: number, inputTokens: number | null, outputTokens: number | null): void;
  end(outcome: Omit<RunOutcome, "ms">): RunRecord;
};

export function createRunLog(options: { now?: () => number; maxRuns?: number } = {}) {
  const now = options.now ?? Date.now;
  const max = options.maxRuns ?? RUN_LOG_MAX_RUNS;
  const runs: RunRecord[] = [];
  const listeners = new Set<(run: RunRecord) => void>();
  const notify = (run: RunRecord) => {
    for (const l of listeners) {
      try {
        l(run);
      } catch {
        // a listener never breaks a run
      }
    }
  };
  return {
    start(input: { request: string; source?: RunRecord["source"]; executor?: RunExecutor; jobId?: string }): RunHandle {
      const run: RunRecord = {
        id: randomUUID(),
        startedAt: now(),
        endedAt: null,
        request: maskLine(input.request, 200),
        source: input.source ?? "other",
        route: null,
        target: null,
        executor: input.executor ?? "none",
        window: null,
        steps: [],
        jev: { calls: 0, ms: [], inputTokens: 0, outputTokens: 0 },
        outcome: null,
        ...(input.jobId ? { jobId: input.jobId } : {}),
      };
      runs.unshift(run);
      while (runs.length > max) runs.pop();
      notify(run);
      return {
        id: run.id,
        step(step) {
          if (run.steps.length >= RUN_LOG_MAX_STEPS) return;
          run.steps.push({ ...step, text: maskLine(step.text), seq: run.steps.length + 1, at: now() });
          notify(run);
        },
        set(patch) {
          if (patch.window !== undefined) run.window = patch.window === null ? null : maskLine(patch.window, 100);
          if (patch.route !== undefined) run.route = patch.route;
          if (patch.target !== undefined) run.target = patch.target;
          if (patch.executor !== undefined) run.executor = patch.executor;
          notify(run);
        },
        jev(ms, inputTokens, outputTokens) {
          run.jev.calls++;
          run.jev.ms.push(Math.round(ms));
          run.jev.inputTokens += inputTokens ?? 0;
          run.jev.outputTokens += outputTokens ?? 0;
        },
        end(outcome) {
          if (run.endedAt === null) {
            run.endedAt = now();
            run.outcome = { ...outcome, said: maskLine(outcome.said, 300), ms: run.endedAt - run.startedAt };
            notify(run);
          }
          return run;
        },
      };
    },
    list(): RunSummary[] {
      return runs.map((r) => ({
        id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, request: r.request, source: r.source, executor: r.executor, window: r.window,
        route: r.route, steps: r.steps.length, jevCalls: r.jev.calls, outcome: r.outcome,
      }));
    },
    get(id: string): RunRecord | null {
      return runs.find((r) => r.id === id) ?? null;
    },
    subscribe(listener: (run: RunRecord) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type RunLog = ReturnType<typeof createRunLog>;

import { FINAL_BUTTON } from "../../src/lib/action-keywords";
import {
  buildControlRequest, confidencePolicy, decisionConfidence, decisionLine, goalSlots, parseControlAnswers,
  type ControlAsk, type ControlDecision,
} from "../screen-hands/jev-control";
import { secureField, type Snapshot, type UiElement } from "../screen-hands/plan";
import type { Step } from "../jobs/types";

/**
 * The hub-side goal loop for a cloud computer: an open-ended goal ("find the contact page of example.com and open it") run as
 *
 *     observe  ->  Jev decides (ON THE HUB; the key never leaves it)  ->  act (the computer's own executors)  ->  verify
 *
 * with every move recorded as a job step. It REUSES the PC screen loop's decision code: `goalSlots` (his dictated text becomes
 * placeholders, so Jev never sees it), `buildControlRequest` (the controls Jev chooses among, instruction-like labels withheld),
 * `parseControlAnswers`, `decisionConfidence` and `confidencePolicy` (act at 0.6, look again at 0.4 to 0.6, otherwise stop and ask).
 * The page is turned into the same `Snapshot` a Windows window is; only the hands differ (the computer's input.* executors).
 *
 * Bounded and careful, by design:
 *  - at most `maxSteps` moves (default 12), at most 3 moves in a row that changed nothing;
 *  - no Jev (no key, an error, a timeout): it STOPS and says so; it never guesses;
 *  - a cancel stops it at once; a takeover pauses it at the boundary BEFORE the next observation (`boundary`);
 *  - a move whose outcome is unknown (the computer dropped) ends the goal `unknown`: nothing is retried or replayed;
 *  - a final button (send, pay, delete, publish, place order...) is never pressed: the goal stops and says so;
 *  - typing needs text he dictated (a typed slot); nothing is invented; a password field is never typed into.
 */

export type PageObservation = {
  title: string;
  url: string;
  viewport: { w: number; h: number };
  elements: { type: string; name: string; x: number; y: number; w: number; h: number; password: boolean; enabled: boolean; focused: boolean; hasValue: boolean }[];
};

export type ActOutcome =
  | { kind: "done"; said: string; verified: boolean | null; data?: Record<string, unknown> }
  | { kind: "failed"; said: string }
  | { kind: "uncertain"; said: string }
  | { kind: "cancelled" }
  | { kind: "lost" };

export type GoalIO = {
  signal: AbortSignal;
  /** Read the page in front, with its controls. */
  observe(): Promise<{ ok: true; obs: PageObservation } | { ok: false; said: string; uncertain: boolean }>;
  /** Send one executor to the computer (through the lease and the dispatcher); `label` is the masked line for the job step. */
  act(executor: string, args: Record<string, unknown>, label: string): Promise<ActOutcome>;
  step(step: Omit<Step, "seq" | "at">): void;
  /** A safe step boundary: a person asking to take the computer pauses here. "stop" = the job was stopped or lost the computer. */
  boundary(): Promise<"go" | "stop">;
};

export type GoalResult = { ok: boolean; note: string; settle?: "unknown"; moves: number };

export const GOAL_MAX_STEPS = 12;
const MAX_STALLS = 3;
const KEYS: Record<string, string> = { enter: "Enter", tab: "Tab", escape: "Escape" };

export function snapshotOf(obs: PageObservation): Snapshot {
  const elements: UiElement[] = obs.elements.map((e, i) => ({
    id: i + 1, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h, password: e.password, enabled: e.enabled, focused: e.focused, hasValue: e.hasValue,
    readOnly: false, name: e.name, aid: "", help: "", value: "", web: true,
  }));
  return { window: { x: 0, y: 0, w: obs.viewport.w, h: obs.viewport.h }, elements, focused: elements.find((e) => e.focused) ?? null, browser: true };
}

/** What the page looks like, as a short signature: a move that leaves it equal changed nothing. */
export function pageSignature(obs: PageObservation): string {
  return `${obs.url}|${obs.title}|${obs.elements.length}|${obs.elements.slice(0, 12).map((e) => `${e.type}:${e.name}:${e.hasValue ? 1 : 0}`).join(",")}`;
}

const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "?";
  }
};

export async function runGoalLoop(input: { goal: string; ask: ControlAsk | null; io: GoalIO; maxSteps?: number; extraContext?: () => string[] }): Promise<GoalResult> {
  const { io } = input;
  // Context he added while it ran ("also include their opening hours") joins the goal from the next decision on (Open Dot V).
  let slots = goalSlots(input.goal);
  if (!input.ask) return { ok: false, note: "The hub has no Jev key, so I can't plan an open-ended goal. Nothing was done.", moves: 0 };
  const max = Math.min(Math.max(1, input.maxSteps ?? GOAL_MAX_STEPS), 30);
  const history: string[] = [];
  let last: string | null = null;
  let askedAgain = false;
  let stalls = 0;
  let moves = 0;
  const note = (intent: string, outcome: Step["outcome"], extra: Partial<Step> = {}) => io.step({ intent: intent.slice(0, 280), executor: "goal", ms: 0, outcome, ...extra });

  for (let n = 1; n <= max; n++) {
    if (io.signal.aborted) return { ok: false, note: "Stopped on request.", moves };
    if ((await io.boundary()) === "stop") return { ok: false, note: io.signal.aborted ? "Stopped on request." : "The job lost the computer, so the goal did not continue.", moves };

    const extra = input.extraContext?.() ?? [];
    if (extra.length) slots = goalSlots(`${input.goal}. Also: ${extra.join(". ")}`.slice(0, 1500));
    const seen = await io.observe();
    if (!seen.ok) return seen.uncertain ? { ok: false, settle: "unknown", note: `I couldn't read the computer: ${seen.said}. I did not continue.`, moves } : { ok: false, note: `I couldn't read the computer: ${seen.said}`, moves };
    const before = seen.obs;
    const snap = snapshotOf(before);
    const request = buildControlRequest({ slots, snap, app: "chromium", title: `${before.title} (${host(before.url)})`, history, last, allowOpenApp: false });
    let answer: Awaited<ReturnType<ControlAsk>> = null;
    try {
      answer = await input.ask(request.body, io.signal);
    } catch {
      if (io.signal.aborted) return { ok: false, note: "Stopped on request.", moves };
    }
    // One quick retry: a single slow or dropped answer is common and costs one more decision; two in a row means stop (never guess).
    if (!answer && !io.signal.aborted) {
      try {
        answer = await input.ask(request.body, io.signal);
      } catch {
        if (io.signal.aborted) return { ok: false, note: "Stopped on request.", moves };
      }
    }
    if (!answer) return { ok: false, note: "Jev didn't answer, so I stopped rather than guess. Nothing further was done.", moves };
    const d: ControlDecision = parseControlAnswers(answer.answers, request, slots);
    const confidence = decisionConfidence(d);
    const policy = confidencePolicy(confidence, askedAgain);
    io.step({ intent: decisionLine(d, confidence).slice(0, 280), executor: "goal", ms: answer.ms, outcome: "note", jev: { op: d.op, confidence, policy, ms: answer.ms, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens } });

    if (policy === "look-again") {
      askedAgain = true;
      continue; // observe again and ask once more
    }
    if (policy === "ask-owner" || d.op === "ask_owner" || d.op === "none" || d.op === "open_app" || d.op === "open_file" || d.op === "save_file")
      return { ok: false, note: `I'm not sure what to do next on ${host(before.url)} (${Math.round(confidence * 100)}% sure), so I stopped. Tell me the next step.`, moves };
    askedAgain = false;

    if (d.op === "done") {
      const fin = await io.observe();
      note(`check: the page reads "${fin.ok ? fin.obs.title.slice(0, 80) : "(unreadable)"}" at ${fin.ok ? host(fin.obs.url) : "?"}; Jev says the task is complete`, "ok", { verification: { method: "jev-complete", ok: true, evidence: `${Math.round(confidence * 100)}% sure` } });
      return { ok: true, note: `Done on ${host(before.url)} after ${moves} move${moves === 1 ? "" : "s"}: ${before.title.slice(0, 80)}.`, moves };
    }

    // The move itself.
    let outcome: ActOutcome;
    let label = "";
    if (d.op === "click" || d.op === "select") {
      const el = d.target?.element;
      if (!el) return { ok: false, note: "Jev named no control to press, so I stopped.", moves };
      if (FINAL_BUTTON.test(el.name)) {
        note(`refused: "${el.name.slice(0, 40)}" is a final action (send, pay, delete or publish); a computer never does those on its own`, "refused");
        return { ok: false, note: `The next step was "${el.name.slice(0, 40)}", a final action. I don't do those on a cloud computer, so I stopped before it.`, moves };
      }
      label = `${d.op} ${d.target!.text.split(",")[0]}`;
      outcome = await io.act("input.click", { x: Math.round(el.x + el.w / 2), y: Math.round(el.y + el.h / 2) }, label);
    } else if (d.op === "type") {
      if (!d.text) return { ok: false, note: "There was no text of yours to type, so I stopped.", moves };
      const field = d.target?.element;
      if (field && (secureField(field) || field.password)) return { ok: false, note: "That is a password or secure field; I never type into those.", moves };
      if (field && d.targetConfidence >= 0.6) {
        const c = await io.act("input.click", { x: Math.round(field.x + field.w / 2), y: Math.round(field.y + field.h / 2) }, `click ${d.target!.text.split(",")[0]}`);
        if (c.kind !== "done") return settleOf(c, moves);
        moves++;
      }
      label = `type your text ${d.text.id.slice(1)} (${d.text.text.length} characters)`;
      outcome = await io.act("input.type", { text: d.text.text }, label);
    } else if (d.op === "key") {
      const key = KEYS[d.key?.keys ?? ""];
      if (!key) return { ok: false, note: "That key isn't one a computer presses on its own, so I stopped.", moves };
      label = `press ${key}`;
      outcome = await io.act("input.key", { key }, label);
    } else if (d.op === "scroll_down" || d.op === "scroll_up") {
      label = d.op === "scroll_down" ? "scroll down" : "scroll up";
      outcome = await io.act("input.scroll", { dy: d.op === "scroll_down" ? 600 : -600 }, label);
    } else {
      label = "wait for the page";
      outcome = await io.act("wait", { ms: 1000 }, label);
    }
    if (outcome.kind !== "done") return settleOf(outcome, moves);
    moves++;

    // Verify: did the page change? (Jev also judges the last step on the next look.)
    const after = await io.observe();
    if (!after.ok) return after.uncertain ? { ok: false, settle: "unknown", note: `I did "${label}" but couldn't read the computer afterwards, so I can't say what happened. I did not continue.`, moves } : { ok: false, note: `I did "${label}" but couldn't read the page afterwards.`, moves };
    const changed = pageSignature(after.obs) !== pageSignature(before) || d.op === "wait";
    note(`check: after "${label}" the page ${changed ? `reads "${after.obs.title.slice(0, 60)}" at ${host(after.obs.url)}` : "did not change"}`, changed ? "ok" : "unknown", { verification: { method: "page-changed", ok: changed, evidence: `${after.obs.elements.length} controls` } });
    history.push(`${moves}. ${label} -> ${changed ? "the page changed" : "no visible change"}`);
    last = `${label}: ${changed ? "the page changed" : "nothing changed"}`;
    stalls = changed ? 0 : stalls + 1;
    if (stalls >= MAX_STALLS) return { ok: false, note: `Three moves in a row changed nothing on ${host(after.obs.url)}, so I stopped.`, moves };
  }
  return { ok: false, note: `I used all ${max} moves without finishing, so I stopped. Nothing further was done.`, moves };
}

function settleOf(o: Exclude<ActOutcome, { kind: "done" }>, moves: number): GoalResult {
  if (o.kind === "uncertain") return { ok: false, settle: "unknown", note: `${o.said} I did not try again or continue.`, moves };
  if (o.kind === "cancelled") return { ok: false, note: "Stopped on request.", moves };
  if (o.kind === "lost") return { ok: false, note: "The job lost the computer, so the goal did not continue.", moves };
  return { ok: false, note: `That move didn't work: ${o.said}`.slice(0, 200), moves };
}

export type { ControlAsk };

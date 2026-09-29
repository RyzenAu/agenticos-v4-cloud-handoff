/**
 * The command service (Track 2): the ONE path typed and spoken Jarvis commands take on the server.
 *
 *   verified principal (B1) + his words (+ page context)
 *     → hard refusals in code (money, banks, secrets)               before anything, whatever the device
 *     → page context ("this margin", "that call")                    resolved, or Jev asks; never invented
 *     → deterministic delegates (memory, coding, receptionist)       the existing services, recorded
 *     → which device (resolveTarget from the VERIFIED person)        the hub is never a fallback for anyone else
 *     → a Job (B2) with targetDeviceId, then the executor:
 *          hub       the Jarvis entry (Jev decision → lane → executor → fresh check), steps mirrored live
 *          companion a typed ExecutorCall through the dispatcher; the companion re-checks and verifies
 *     → one concise line to speak; the full decision/step/verification log is the job's steps.
 *
 * Stop, cancel and interrupt go through the job service (jobs.cancel aborts the executor's signal, which
 * also cancels a companion command). A dropped stream keeps the job for RECONNECT_GRACE_MS so the client
 * can re-attach (`attach`); with nobody attached after that it is cancelled. A restart marks a running
 * job unknown and never re-runs it (JobService.recover).
 */
import type { Principal } from "../identity/principal";
import type { JobService, ExecutorContext } from "../jobs/service";
import type { JobKind, Step } from "../jobs/types";
import type { RunLog, RunRecord } from "../screen-hands/run-log";
import { stepFromRun } from "../jobs/mirror-run-log";
import { screenGoalRefusal } from "../screen-hands/refusals";
import { goalSlots } from "../screen-hands/jev-control";
import type { ResolveContext, ResolveResult } from "../devices/types";
import type { CommandInput, DispatchResult } from "../devices/dispatch";
import type { CommandDone, CommandEvent, JarvisEntry } from "../jev-command";
import { marginAnswer, parseMarginQuery, shownContributionPct, shownFigures, sourceWords, speakFigure } from "../jev-margin";
import { parsePriceQuery, priceAnswer } from "./answers";
import { RECEPTIONIST_PACKAGES } from "../../src/lib/receptionist-packages";
import {
  COMPANION_EXECUTORS,
  isExecutorResult,
  RECONNECT_GRACE_MS,
  type CommandBody,
  type CommandDoneEvent,
  type CommandSource,
  type CommandStreamEvent,
  type ExecutorCall,
  type ExecutorName,
  type JevDecision,
  type PageContext,
  type PageContextItem,
  type SpecialistId,
  type SurfaceThresholds,
} from "./contracts";
import { createContextMemory, resolveCommandContext } from "./context";
import { leadActionIn, osPageIn, planRules, rememberToReminder, splitSpokenTarget, type LeadAction, type RulePlan } from "./plan";
import { thresholdsFor } from "./thresholds";
import { codingDraftFor } from "./coding";
import { codeChangeNotPayment, codingMoneyRefusal, readOnlyMoneyQuestion } from "../jarvis-execution/spoken-money";

export type Delegates = {
  /**
   * Shared memory by voice/typed words (scripts/memory/voice-turn.ts): its line and its OUTCOME (remembered,
   * saved-to-vault, refused…). Null = not a memory request. Only a stored or found outcome is ever "done".
   */
  memory?: (utterance: string, caller: unknown, spokenYes: string | null) => Promise<{ said: string; outcome: string } | null>;
  /** The receptionist's state from its own feed (never invented). */
  receptionist?: (utterance: string) => Promise<{ ok: boolean; said: string; verified?: boolean | null }>;
  /**
   * Coding by words, typed or spoken (scripts/coding/command-entry.ts): the SAME shaper and per-person voice state, so
   * "assign a builder to fix X and a reviewer to check it" drafts one job (models chosen, reasons said) and only a
   * person's whole "start it" starts it. Null = not a coding turn. The verified caller comes from the principal, never the words.
   */
  coding?: (utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null }) => Promise<{ say: string; navigate?: string; jobId?: string; jobState?: string; draft?: unknown } | null>;
  /** A CRM action on a named lead (log a call, set a status, who's next), read back after any write. */
  leads?: (action: LeadAction, principal: Principal, eventId?: string) => Promise<{ ok: boolean; said: string; verified: boolean | null }>;
  /** A real reminder through the reminder skill ("remind me to …" words). */
  reminder?: (words: string, principal: Principal) => Promise<{ ok: boolean; said: string }>;
  /**
   * His browser commands typed (J6), through the SAME hands as spoken ones: agent-browser in Jarvis Chrome, its window on his main
   * screen, and a multi-step goal through the task loop; the line says where it ended up. `match` is pure. Only the owner at this PC.
   */
  browser?: { match(utterance: string): boolean; run(utterance: string, principal: Principal): Promise<{ ok: boolean; said: string }> };
  /**
   * The read-only Jarvis skills the voice rules already answer (finance, time, maths, units, currency, system,
   * weather, AI usage, inbox, deploys, capabilities, timers): typed words get the same answer (AUDIT-F2/F4
   * typed = spoken). `match` is pure; nothing that types or moves windows is matched.
   */
  skill?: { match(utterance: string): string | null; run(utterance: string, principal: Principal): Promise<{ ok: boolean; said: string }> };
  /**
   * Desk payments (P1, 29 Sep): the typed command box is the owner's words at his desk too. `handle` is asked first (after
   * a stop): for the owner at his desk (the live wiring checks it: loopback, a live session, away off) his words that order
   * a payment become a confirm card, his yes or no answers one waiting, and a bank or payment site opens; null otherwise
   * (anyone else, or not a payment matter), and the command goes on exactly as before. `cancelAll` drops what is waiting.
   */
  deskPay?: {
    /** `source`: "typed" only from the typed box or palette (the client's own path); a command a model sent is "voice" and can never confirm or cancel a payment. */
    handle(utterance: string, principal: Principal, source: "typed" | "voice"): Promise<{ ok: boolean; said: string; ask?: boolean; refused?: boolean } | null>;
    cancelAll(principal: Principal): void;
  };
};

export type CommandServiceDeps = {
  jobs: () => JobService;
  /** The hub's Jarvis entry (local executors), or null where this server can't act on its own screen. */
  entry: () => JarvisEntry | null;
  /** The entry's run log, so hub steps land in the job as they happen. */
  runs?: Pick<RunLog, "subscribe">;
  hubDeviceId: string;
  resolveTarget: (ctx: ResolveContext) => ResolveResult;
  dispatcher?: { submit(input: CommandInput, opts?: { timeoutMs?: number; signal?: AbortSignal; onQueued?: (id: string, deviceId: string) => void }): Promise<DispatchResult> };
  /** The companion that holds this person's microphone, if exactly one (DeviceRegistry.micOwner). */
  micOwner?: (personId: string) => string | null;
  deviceLabel?: (deviceId: string) => string;
  delegates?: Delegates;
  thresholds?: (surface: "voice" | "typed") => SurfaceThresholds;
  now?: () => number;
  graceMs?: number;
  /** How long an identical command from the same person is the same command (default 5 s; 0 turns it off). */
  dedupeMs?: number;
  remoteTimeoutMs?: number;
};

type Live = { events: CommandStreamEvent[]; listeners: Set<(e: CommandStreamEvent) => void>; done: CommandDoneEvent | null; grace?: ReturnType<typeof setTimeout>; personId: string; seq: number };

/** `memoryCaller`: the memory plugin's own verified caller for this request (its principalFor(req)). */
export type RunInput = { principal: Principal; body: CommandBody; memoryCaller?: unknown };

const HANDOFF_SPECIALISTS: SpecialistId[] = ["brain", "vision", "voice-tools"];
/** A whole-request stop. Anything longer ("stop the music and open Notepad") is a new request. */
export const STOP_WORDS = /^(?:jarvis,?\s+)?(?:stop(?: it| that| now)?|cancel(?: it| that| the command)?|never ?mind|hold on|abort(?: it)?|forget it)[.!]?$/i;

export function createCommandService(deps: CommandServiceDeps) {
  const live = new Map<string, Live>();
  /** The last page each verified person sent (a spoken command with none uses it briefly; never across people). */
  const pageMemory = createContextMemory();
  /** An identical command from the same person, still running or just finished OK, is the same command (typed + voice echo). */
  const recent = new Map<string, { jobId: string; at: number }>();
  const DEDUPE_MS = deps.dedupeMs ?? 5_000;
  const graceMs = deps.graceMs ?? RECONNECT_GRACE_MS;
  const label = (id: string) => deps.deviceLabel?.(id) ?? id;
  /** The job each person has waiting for a yes (one open question per person, as the screen loop has). */
  const awaiting = new Map<string, { jobId: string; timer: ReturnType<typeof setTimeout> }>();
  const ANSWER_WINDOW_MS = 2 * 60_000;
  function settleAwaiting(personId: string, note: string) {
    const a = awaiting.get(personId);
    if (!a) return;
    awaiting.delete(personId);
    clearTimeout(a.timer);
    try {
      deps.jobs().finish(a.jobId, "interrupted", note);
    } catch {
      /* the store is read-only or closing */
    }
  }
  /** A late-settling step's promise carried on a done (the hub entry's `lateWork`), if any. */
  function lateOf(done: object): Promise<{ ok: boolean; said: string }> | undefined {
    const w = (done as { lateWork?: unknown }).lateWork;
    return w && typeof (w as Promise<unknown>).then === "function" ? (w as Promise<{ ok: boolean; said: string }>) : undefined;
  }
  /**
   * When the step a stop couldn't cancel finally settles, the job says what really happened: a step with the
   * late result and a new note. A saved .pptx change is never left looking like it didn't happen (REVIEW-T2 R4 F1).
   */
  function recordLate(jobId: string, work: Promise<{ ok: boolean; said: string }>) {
    void work
      .then((r) => {
        const jobs = deps.jobs();
        jobs.step(jobId, { intent: `after the stop, the step it had started ${r.ok ? "finished" : "didn't finish"}: ${r.said.slice(0, 160)}`, executor: "late-result", ms: 0, outcome: r.ok ? "ok" : "failed", verification: { method: "late-result", ok: r.ok } });
        jobs.amendNote(jobId, r.ok ? `Stopped, but the step it had started finished afterwards: ${r.said}` : `Stopped; the step it had started didn't finish: ${r.said}`);
      })
      .catch(() => undefined);
  }
  function holdAwaiting(personId: string, jobId: string) {
    settleAwaiting(personId, "Superseded by a newer question before an answer.");
    const timer = setTimeout(() => settleAwaiting(personId, "No answer to this question here within two minutes. A spoken yes presses through the screen gate and is recorded in that screen job."), ANSWER_WINDOW_MS);
    timer.unref?.();
    awaiting.set(personId, { jobId, timer });
  }

  function publish(jobId: string, event: CommandStreamEvent) {
    const l = live.get(jobId);
    if (!l) return;
    const withSeq = event.type === "done" ? event : ({ ...event, seq: ++l.seq } as CommandStreamEvent);
    l.events.push(withSeq);
    if (l.events.length > 400) l.events.splice(0, l.events.length - 400);
    if (event.type === "done") l.done = event;
    for (const fn of l.listeners) {
      try {
        fn(withSeq);
      } catch {
        /* a listener never breaks a run */
      }
    }
    if (event.type === "done") {
      if (l.grace) clearTimeout(l.grace);
      // Kept briefly so a late re-attach still hears the outcome.
      setTimeout(() => live.delete(jobId), graceMs).unref?.();
    }
  }

  /** Run one command for a verified principal. `emit` receives the stream (job, decision, narrate, step, done). */
  async function run(input: RunInput, emit: (e: CommandStreamEvent) => void = () => undefined): Promise<CommandDoneEvent> {
    const { principal } = input;
    const body = input.body ?? ({} as CommandBody);
    const source: CommandSource = body.source === "voice" || body.source === "away" || body.source === "acceptance" ? body.source : "typed";
    const surface = source === "voice" ? "voice" : "typed";
    const thresholds = (deps.thresholds ?? thresholdsFor)(surface);
    const raw = String(body.utterance ?? "").trim().slice(0, 600);
    const split = splitSpokenTarget(raw);
    const utterance = split.utterance || raw;
    const spokenTarget = typeof body.spokenTarget === "string" && body.spokenTarget.trim() ? body.spokenTarget.trim().slice(0, 60) : split.spokenTarget;
    const slots = goalSlots(utterance);
    const nowMs = (deps.now ?? Date.now)();
    // Typed and spoken take the same resolver; only a spoken command may fall back to this person's last page.
    const commandContext = resolveCommandContext({ utterance, pageContext: body.pageContext, remembered: pageMemory.recall(principal.personId, nowMs), allowMemory: source === "voice", now: nowMs });
    const pageContext = commandContext.context;
    if (commandContext.from === "sent") pageMemory.remember(principal.personId, pageContext, nowMs);
    const jobs = deps.jobs();
    const kind: JobKind = source === "voice" ? "voice" : "command";
    const decisionOf = (d: Omit<JevDecision, "calibrationRunId">): JevDecision => ({ ...d, calibrationRunId: thresholds.calibrationRunId });

    if (!raw) return { type: "done", ok: false, said: "Do what?", kind: "ask", ask: true, jobId: null, runId: "", targetDeviceId: null };
    // A new request drops any question this person left open (the confirmed press goes through the
    // screen gate's own path; this job's record says it was superseded, never "failed").
    settleAwaiting(principal.personId, /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it)[.!]?$/i.test(raw) ? "Answered in the next command." : "Superseded by a newer request before an answer.");
    // "stop", "cancel that", "never mind" typed or said as a command (AUDIT-F4 F14): stop this person's
    // running commands through the job service. Never typed into a window, never a new job.
    if (STOP_WORDS.test(raw)) {
      deps.delegates?.deskPay?.cancelAll(principal);
      const stopped = await cancelAllFor(principal);
      return { type: "done", ok: true, stopped: true, said: stopped.length ? `Stopped ${stopped.length === 1 ? "it" : `${stopped.length} commands`}.` : "Nothing of yours was running.", kind: "answer", jobId: stopped[0] ?? null, runId: "", targetDeviceId: null };
    }

    // A repeat of the same words from the same person while that job runs (or just finished OK) is the same command:
    // attach to it, never start a second (typed + voice echo, a double tap). Answers to a question are always new.
    const answering = /^(?:yes|yeah|yep|yes please|go ahead|do it|confirm(?:ed)?|no|nope|leave it)[.!]?$/i.test(raw);
    // The whole page context (minus its capture time) is part of the key: the same words about different figures are not the same command.
    const pageSig = pageContext ? JSON.stringify({ ...pageContext, capturedAt: undefined }) : "";
    const dedupeKey = answering || source === "acceptance" ? null : `${principal.personId}|${utterance.toLowerCase().replace(/\s+/g, " ")}|${spokenTarget ?? ""}|${pageSig}`;
    /** Start a job and stream it; `work` runs inside the job service (its signal is the stop). */
    const start = async (targetDeviceId: string, work: (ctx: ExecutorContext, out: (e: CommandStreamEvent) => void) => Promise<CommandDoneEvent>, opts: { dedupe?: boolean } = {}): Promise<CommandDoneEvent> => {
      // The job records WHO (person, via, actor, device), never the server-only session key (B1: it stays out of every JSON).
      const recorded = { personId: principal.personId, via: principal.via, actor: principal.actor, ...(principal.deviceId ? { deviceId: principal.deviceId } : {}) };
      const job = jobs.create({ kind, principal: recorded, targetDeviceId, title: slots.goal || "Jarvis command" });
      const l: Live = { events: [], listeners: new Set([emit]), done: null, personId: principal.personId, seq: 0 };
      live.set(job.id, l);
      if (dedupeKey && opts.dedupe !== false) recent.set(dedupeKey, { jobId: job.id, at: nowMs });
      if (recent.size > 64) for (const [k, v] of recent) if (nowMs - v.at > DEDUPE_MS) recent.delete(k);
      publish(job.id, { type: "job", jobId: job.id, targetDeviceId, ...(targetDeviceId !== "none" ? { deviceLabel: label(targetDeviceId) } : {}), seq: 0 });
      const box: { done: CommandDoneEvent | null } = { done: null };
      const result = await jobs.run(job.id, async (ctx) => {
        // When the stop arrived: "had already finished" is only claimed if the lane's check passed BEFORE this.
        let abortedAt: number | null = null;
        ctx.signal.addEventListener("abort", () => void (abortedAt ??= Date.now()), { once: true });
        let done = await work(ctx, (e) => publish(job.id, e)).catch((error: Error): CommandDoneEvent => ({ type: "done", ok: false, said: `That failed: ${String(error?.message ?? error).slice(0, 160)}`, kind: "unavailable", jobId: job.id, runId: "", targetDeviceId }));
        if (ctx.signal.aborted && !done.stopped) {
          // The stop arrived. Not done → reported as stopped. Already done and checked (a race of milliseconds)
          // → said plainly and recorded as succeeded with that note (REVIEW-T2 #5), not as an ignored stop.
          if (!done.ok) done = { ...done, ok: false, stopped: true, said: "Stopped." };
          else if (typeof done.checkedAt === "number" && abortedAt !== null && done.checkedAt <= abortedAt) {
            ctx.step({ intent: "the stop arrived after the action had already completed and been checked", executor: "none", ms: 0, outcome: "note" });
            box.done = { ...done, stopped: true, said: `That had already finished when you said stop: ${done.said}` };
            return { ok: true, completedBeforeStop: true, note: "Finished and checked just before the stop arrived." };
          } else {
            // It finished AFTER the stop (the lane didn't honour it), or its check time is unknown: say so, and let
            // the job service record the ignored stop (and quarantine it), as B2 intends (REVIEW-T2 R2 #2).
            ctx.step({ intent: "the stop wasn't honoured in time: the action completed after it", executor: "none", ms: 0, outcome: "note" });
            box.done = { ...done, stopped: false, said: `I couldn't stop that in time, so it went ahead: ${done.said}` };
            return { ok: true, note: done.said.slice(0, 200) };
          }
        }
        box.done = done;
        // A question back (a final button's "Shall I press Send?", a forget's "Say yes") waits for his answer;
        // a handoff passed the request on. Neither is a failure (REVIEW-T2 #5).
        if (!done.ok && !done.stopped && (done.confirm || done.awaiting))
          return { ok: false, settle: "awaiting-approval", note: done.confirm ? `Waiting for your yes: ${done.confirm}` : "Waiting for your answer." };
        if (!done.ok && done.kind === "handoff" && done.handoff)
          return { ok: false, settle: "handed-off", note: `Handed off to ${done.handoff.to}; nothing ran here.` };
        // Stopped while a step that can't be cancelled was running: the note hedges until it lands (REVIEW-T2 R4 F1).
        const lateNote = done.stopped && lateOf(done) ? "Stopped; a step it had already started may still finish (updated here when it does)." : undefined;
        return { ok: done.ok, note: done.said.slice(0, 200), ...(lateNote ? { stopNote: lateNote } : {}) };
      });
      if (box.done && (box.done.confirm || box.done.awaiting) && !box.done.stopped) holdAwaiting(principal.personId, job.id);
      const lateWork = box.done ? lateOf(box.done) : undefined;
      if (lateWork) recordLate(job.id, lateWork);
      const { lateWork: _dropped, ...doneOnly } = (box.done ?? {}) as CommandDoneEvent & { lateWork?: unknown };
      void _dropped;
      const final: CommandDoneEvent = box.done
        ? { ...(doneOnly as CommandDoneEvent), jobId: job.id, targetDeviceId }
        : { type: "done", ok: false, said: result.reason === "quarantined" ? "Jarvis commands are on hold after a stop that wasn't confirmed; release it in the job log first." : "That didn't start.", kind: "unavailable", jobId: job.id, runId: "", targetDeviceId };
      publish(job.id, final);
      return final;
    };

    const note = (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => ctx.step({ ms: 0, ...s });

    // 0. A payment at his desk (P1): his own typed words are his go-ahead to READ the page and show the confirm card; the
    //    press waits for his Confirm or yes (scripts/desk-payments). Only for the owner at his desk; null for everything else.
    if (deps.delegates?.deskPay && source !== "away" && source !== "acceptance") {
      const pay = await deps.delegates.deskPay.handle(utterance, principal, source === "typed" ? "typed" : "voice").catch(() => null);
      if (pay)
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "desk.payment", confidence: 1, policy: "act", source: "rules", why: "a payment at his desk: the page is read and the confirm card shown; nothing is pressed until he confirms" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `desk payment: ${pay.said.slice(0, 160)}`, executor: "none", jev: d, outcome: pay.ok ? "ok" : pay.ask ? "asked" : "refused" });
          return pay.ok
            ? { type: "done", ok: true, said: pay.said, kind: "answer", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null }
            : pay.ask
              ? { type: "done", ok: false, ask: true, said: pay.said, kind: "ask", jobId: null, runId: "", targetDeviceId: "none", decision: d }
              : { type: "done", ok: false, refused: true, said: pay.said, kind: "refused", jobId: null, runId: "", targetDeviceId: "none", decision: d };
        }, { dedupe: false });
    }

    // A repeat of the same words while that job runs (or just finished OK) attaches to it. After the desk-payment step on
    // purpose: a payment order is answered from the desk's live state every time, never replayed.
    const earlier = dedupeKey ? recent.get(dedupeKey) : undefined;
    const twin = DEDUPE_MS > 0 && earlier && nowMs - earlier.at <= DEDUPE_MS ? live.get(earlier.jobId) : undefined;
    if (twin && twin.personId === principal.personId && (!twin.done || (twin.done.ok && !twin.done.stopped)))
      return new Promise<CommandDoneEvent>((resolve) => {
        for (const e of twin.events) emit(e);
        if (twin.done) return resolve(twin.done);
        const follow = (e: CommandStreamEvent) => {
          emit(e);
          if (e.type === "done") {
            twin.listeners.delete(follow);
            resolve(e);
          }
        };
        twin.listeners.add(follow);
      });

    // 1. Hard refusals: before any device, context or model. Only secrets and private data are refused here.
    //    A money REQUEST is not (owner decision 29 Sep: "money requests are fine"): it goes to the routing
    //    below like any other, and EXECUTING it stays gated where it would run (screen_act refuses money
    //    goals and screens, the browser never presses a final or money button, the app browser never opens a
    //    money site, control_pc refuses money and trading). A read-only money QUESTION ("what's my bank
    //    balance") stays off the coding lane (F16, REVIEW-T2 #4); a code change that only NAMES a money
    //    feature goes to Track 3's coding draft as before (REVIEW-T3 F7b).
    const goalRefusal = screenGoalRefusal(raw);
    const moneyRead = readOnlyMoneyQuestion(raw) && !!goalRefusal;
    const refusal = goalRefusal?.kind === "secret-or-private-data" ? goalRefusal : null;
    if (refusal)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "refuse", confidence: 1, policy: "done", source: "rules", why: `refused in code: ${refusal.kind}` });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `refused: ${refusal.kind}`, executor: "none", jev: d, outcome: "refused" });
        return { type: "done", ok: false, said: refusal.said, kind: "refused", refused: true, jobId: null, runId: "", targetDeviceId: "none", decision: d };
      });

    // 2. Page context: "explain this margin", "open that call". Resolved, or asked; never guessed.
    const ref = commandContext.reference;
    if (ref)
      return start("none", async (ctx, out) => {
        const res = commandContext.resolution!;
        if (res.kind !== "resolved") {
          const d = decisionOf({ op: "context.resolve", target: ref.noun ?? ref.word, confidence: 0, policy: "ask", source: "context", why: res.kind === "ambiguous" ? `${res.candidates.length} matching items on the page` : commandContext.from === "stale" ? "the page context is too old to trust" : pageContext ? "nothing on the page matches" : "no page context was sent" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `context: ${d.why}`, executor: "none", jev: d, outcome: "asked" });
          return { type: "done", ok: false, ask: true, said: res.said, kind: "ask", jobId: null, runId: "", targetDeviceId: "none", decision: d };
        }
        return contextual(ctx, out, utterance, res.item, res.tier, pageContext!, decisionOf);
      });

    // 3. Coding work (Track 3's harness): drafted, then started only by a person's own "start it". The entry shares the
    //    voice's per-person state, so typed and spoken turns are one conversation. A draft page stays the fallback when the
    //    harness isn't running here. Nothing starts from this line.
    // A money move named in the words never reaches the harness, unless it is plainly a code change. A delegated order ("have Codex
    // buy 10 Tesla shares and Opus review it") is the same order: the wrapper is stripped and the words judged again.
    const undelegated = raw.replace(/\b(?:have|get|tell|ask|let|make)\s+[\w-]+\s+(?:to\s+)?(?=(?:buy|sell|pay|transfer|trade|bet|purchase|invest|wire|refund)\b)/gi, "");
    const moneyBlocked = moneyRead || !!codingMoneyRefusal(raw) || !!codingMoneyRefusal(undelegated) || ((!!goalRefusal || !!screenGoalRefusal(undelegated)) && !codeChangeNotPayment(raw));
    if (deps.delegates?.coding && !moneyBlocked && source !== "away" && source !== "acceptance") {
      const r = await deps.delegates.coding(utterance, { personId: principal.personId, actor: principal.actor === "human" ? "human" : "process", via: principal.via === "loopback-owner" ? "local" : principal.via === "telegram-owner" ? "telegram" : "tailnet", spokenYes: typeof body.spokenYes === "string" ? body.spokenYes : null }).catch(() => null);
      if (r)
        return start("none", async (ctx, out) => {
          const d = decisionOf({ op: "coding.turn", ...(r.jobId ? { target: r.jobId.slice(0, 8) } : {}), confidence: 1, policy: "delegate", delegateTo: "coding", source: "rules", why: "coding words: the coding harness's own draft, start and status rules" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: `coding: ${r.say.slice(0, 160)}`, executor: "coding", jev: d, outcome: "ok" });
          return { type: "done", ok: true, said: r.say, kind: r.navigate ? "navigate" : "answer", ...(r.navigate ? { navigate: { path: r.navigate } } : {}), numbers: { ...(r.jobId ? { codingJobId: r.jobId } : {}), ...(r.jobState ? { codingJobState: r.jobState } : {}), ...(r.draft ? { draft: r.draft } : {}) }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
        });
    }
    const coding = moneyBlocked || deps.delegates?.coding ? null : codingDraftFor(utterance);
    if (coding)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "coding.draft", target: coding.path.split("?")[0], confidence: 1, policy: "delegate", delegateTo: "coding", source: "rules", why: "coding work: the coding workspace drafts it and waits for a confirm" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: "coding: opened the Coding draft (nothing starts until he confirms the plan)", executor: "none", jev: d, outcome: "ok" });
        return { type: "done", ok: true, said: "Opening a coding draft with that request. It shows the plan, repo and agents, then asks \"Start it?\"; nothing starts until you confirm.", kind: "navigate", navigate: { path: coding.path }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 3'-. J6: his browser commands typed use the same hands as spoken (Jarvis Chrome, the where-line, the task loop): never the
    //      old app-owned browser. Only for the owner at this PC (it drives the hub's Jarvis Chrome); anyone else goes on as before.
    if (deps.delegates?.browser && principal.via === "loopback-owner" && source !== "away" && source !== "acceptance" && deps.delegates.browser.match(utterance))
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "browser.hands", confidence: 1, policy: "act", delegateTo: "voice-tools", source: "rules", why: "a browser command: the same agent-browser hands as spoken, in Jarvis Chrome" });
        out({ type: "decision", decision: d, seq: 0 });
        const r = await deps.delegates!.browser!.run(utterance, principal).catch(() => ({ ok: false, said: "The browser hands didn't answer, so nothing was done." }));
        note(ctx, { intent: `browser: ${r.said.slice(0, 160)}`, executor: "browser-hands", jev: d, outcome: r.ok ? "ok" : "failed", verification: { method: "browser-hands", ok: r.ok } });
        return { type: "done", ok: r.ok, said: r.said, kind: "browser", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 3'. Deterministic delegates: memory, leads, reminders, receptionist (their own services; recorded here).
    const rule = planRules(utterance);
    if (rule?.lane === "delegate") return delegate(rule, principal, input.memoryCaller, utterance, body, start, decisionOf, note);
    // A command with a step no executor runs in the same breath ("type 'hi' then email it"): nothing runs,
    // and he's told exactly which step (REVIEW-T2 #2). Never half-done and called done.
    if (rule?.lane === "unsupported")
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: rule.op, confidence: 1, policy: "ask", source: "rules", why: rule.why });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `not run: ${rule.why}`, executor: "none", jev: d, outcome: "asked" });
        return { type: "done", ok: false, ask: true, said: rule.said, kind: "ask", jobId: null, runId: "", targetDeviceId: "none", decision: d };
      });

    // 3a. Deterministic answers (AUDIT-F4 F9): margins from the economics model, prices from the catalogue.
    //     No device and no model: the same for both founders, wherever they are.
    const margin = parseMarginQuery(utterance);
    const prices = margin ? null : parsePriceQuery(utterance);
    if (margin || prices)
      return start("none", async (ctx, out) => {
        const a = margin ? marginAnswer(margin) : priceAnswer(prices!);
        const d = decisionOf({ op: margin ? "answer.margin" : "answer.price", target: margin ? margin.pkg.shortName : prices!.map((p) => p.shortName).join(", "), confidence: 1, policy: "act", source: "rules", why: margin ? "numbers from the economics model only" : "prices from the package catalogue only" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `answer: ${d.op} (${a.numbers.source})`, executor: "deterministic", jev: d, outcome: "ok", verification: { method: "deterministic", ok: true, evidence: String(a.numbers.source) } });
        return { type: "done", ok: true, said: a.said, kind: "answer", numbers: a.numbers as Record<string, unknown>, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: true };
      });

    // 3a'. The read-only skills the voice rules answer (finance, time, maths…): the same answer typed.
    const skillName = deps.delegates?.skill?.match(utterance) ?? null;
    if (skillName && deps.delegates?.skill)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: `skill.${skillName}`, confidence: 1, policy: "delegate", delegateTo: "voice-tools", source: "rules", why: `the ${skillName} skill answers this by rules, exactly as spoken` });
        out({ type: "decision", decision: d, seq: 0 });
        const r = await deps.delegates!.skill!.run(utterance, principal).catch(() => ({ ok: false, said: "That skill didn't answer, so I won't guess." }));
        note(ctx, { intent: `skill ${skillName}: ${r.said.slice(0, 160)}`, executor: "skills", jev: d, outcome: r.ok ? "ok" : "failed", verification: { method: `${skillName}-skill`, ok: r.ok } });
        return { type: "done", ok: r.ok, said: r.said, kind: "answer", jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: r.ok };
      });

    // 3a''. A read-only money question no finance skill answers: the brain answers it (as spoken), and
    //       nothing acts. It never reaches a device lane.
    if (moneyRead)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "delegate.brain", confidence: 1, policy: "delegate", delegateTo: "brain", source: "rules", why: "a read-only question about money: answered, never acted on" });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: "handoff → brain: a read-only money question (nothing acts)", executor: "handoff", jev: d, outcome: "note" });
        return { type: "done", ok: false, kind: "handoff", said: "That's a question for the chat brain; nothing will be paid, moved or opened.", handoff: { to: "brain", intent: "money.question", reason: d.why, utterance }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 3b. An OS page ("open the receptionist page"): the UI opens it; no device acts.
    const page = osPageIn(utterance);
    if (page)
      return start("none", async (ctx, out) => {
        const d = decisionOf({ op: "navigate", target: page.path, confidence: 1, policy: "act", source: "registry", why: `the OS page ${page.label}` });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `navigate: ${page.path}`, executor: "none", jev: d, outcome: "ok" });
        return { type: "done", ok: true, said: `Opening ${page.label}.`, kind: "navigate", navigate: { path: page.path }, jobId: null, runId: "", targetDeviceId: "none", decision: d, verified: null };
      });

    // 4. Which device, from the VERIFIED person (never a body field). The hub is never a fallback.
    const originDeviceId = principal.via === "loopback-owner" ? deps.hubDeviceId : principal.via === "companion" ? principal.deviceId : (deps.micOwner?.(principal.personId) ?? undefined);
    let target: ResolveResult;
    try {
      target = deps.resolveTarget({ personId: principal.personId, ...(spokenTarget ? { spokenTarget } : {}), ...(originDeviceId ? { originDeviceId } : {}) });
    } catch (error) {
      target = { ok: false, reason: `couldn't resolve the device (${(error as Error).message.slice(0, 60)})` };
    }
    if (!target.ok) {
      const failed = target;
      const deviceId = failed.deviceId ?? "none";
      return start(deviceId, async (ctx, out) => {
        const asks = /say which|more than one/i.test(failed.reason);
        const d = decisionOf({ op: "device.choose", confidence: 0, policy: asks ? "ask" : "done", source: "rules", why: failed.reason, ...(failed.deviceId ? { deviceId: failed.deviceId } : {}) });
        out({ type: "decision", decision: d, seq: 0 });
        note(ctx, { intent: `device: ${failed.reason}`, executor: "none", ...(failed.deviceId ? { target: failed.deviceId } : {}), jev: d, outcome: asks ? "asked" : "refused" });
        const said = failed.reason === "device offline" && failed.deviceId
          ? `${label(failed.deviceId)} is offline, so nothing ran. I never send your commands to another machine.`
          : `Not done: ${failed.reason}. Nothing ran on any other machine.`;
        return { type: "done", ok: false, said, kind: asks ? "ask" : "refused", ...(asks ? { ask: true } : { refused: true }), jobId: null, runId: "", targetDeviceId: deviceId, decision: d };
      });
    }
    const deviceId = target.deviceId;
    const owner = target.owner;

    // 5a. The hub (this PC): the Jarvis entry. Only for the person AT this PC (it acts on this screen).
    if (deviceId === deps.hubDeviceId) {
      return start(deviceId, async (ctx, out) => {
        if (principal.via !== "loopback-owner") {
          const d = decisionOf({ op: "device.choose", confidence: 1, policy: "done", source: "rules", deviceId, why: "the hub's screen acts only for someone at the PC" });
          out({ type: "decision", decision: d, seq: 0 });
          note(ctx, { intent: "device: the hub acts only for someone at this PC", executor: "none", target: deviceId, jev: d, outcome: "refused" });
          return { type: "done", ok: false, refused: true, said: "That acts on this PC's screen, so it runs only for someone sitting at it. Nothing ran.", kind: "refused", jobId: null, runId: "", targetDeviceId: deviceId, decision: d };
        }
        const entry = deps.entry();
        if (!entry) return { type: "done", ok: false, said: "Jarvis's hands aren't available on this server, so nothing ran.", kind: "unavailable", jobId: null, runId: "", targetDeviceId: deviceId };
        return hubRun(entry, ctx, out, { utterance, deviceId, owner, surface, source, pageContext });
      });
    }

    // 5b. A companion (the requester's own PC): a typed ExecutorCall only.
    return start(deviceId, async (ctx, out) => remoteRun(ctx, out, { principal, utterance, spokenTarget, originDeviceId, deviceId, rule, decisionOf, note }));
  }

  // --------------------------------------------------------------------------------------------------

  async function hubRun(entry: JarvisEntry, ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, r: { utterance: string; deviceId: string; owner: "usman" | "mehroz"; surface: "voice" | "typed"; source: CommandSource; pageContext: PageContext | null }): Promise<CommandDoneEvent> {
    // Mirror the entry's run-log steps into THIS job as they happen (the inspector's full detail).
    let mirrored = 0;
    const unsubscribe = deps.runs?.subscribe((run: RunRecord) => {
      if (run.jobId !== ctx.jobId) return;
      for (const s of run.steps.slice(mirrored)) ctx.step({ ...stepFromRun(run, s), target: r.deviceId });
      mirrored = run.steps.length;
    });
    try {
      const done: CommandDone = await entry.handle(
        { utterance: r.utterance, source: r.source === "voice" ? "voice" : "command", jobId: ctx.jobId, target: { deviceId: r.deviceId, owner: r.owner }, surface: r.surface, pageContext: r.pageContext },
        ctx.signal,
        (e: CommandEvent) => {
          if (e.type === "done") return;
          if (e.type === "decision") return out({ type: "decision", decision: e.decision, seq: 0 });
          out(e as CommandStreamEvent);
        },
      );
      return { ...done, jobId: ctx.jobId, targetDeviceId: r.deviceId, kind: done.kind as CommandDoneEvent["kind"] };
    } finally {
      unsubscribe?.();
    }
  }

  async function remoteRun(
    ctx: ExecutorContext,
    out: (e: CommandStreamEvent) => void,
    r: { principal: Principal; utterance: string; spokenTarget?: string; originDeviceId?: string; deviceId: string; rule: RulePlan | null; decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision; note: (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => Step | null },
  ): Promise<CommandDoneEvent> {
    const base = { jobId: null, runId: "", targetDeviceId: r.deviceId } as const;
    const plan = r.rule?.lane === "executor" && COMPANION_EXECUTORS.includes(r.rule.executor) ? r.rule : null;
    if (!plan) {
      const d = r.decisionOf({ op: "device.capability", confidence: 1, policy: "done", source: "rules", deviceId: r.deviceId, why: "not something the companion can run (no typed executor matches)" });
      out({ type: "decision", decision: d, seq: 0 });
      r.note(ctx, { intent: "companion: no typed executor for this request", executor: "none", target: r.deviceId, jev: d, outcome: "refused" });
      return { type: "done", ok: false, refused: true, kind: "refused", said: `On ${label(r.deviceId)} I can open an app, a web page or a file, start a new PowerPoint with a title slide, or type a line into a new Notepad document. That one needs Usman's PC's screen loop, so nothing ran, and I didn't send it anywhere else.`, decision: d, ...base };
    }
    if (!deps.dispatcher) return { type: "done", ok: false, kind: "unavailable", said: "Device routing isn't running on this server, so nothing ran.", ...base };
    const d = r.decisionOf({ op: plan.op, ...(plan.target ? { target: plan.target } : {}), confidence: 1, policy: "act", source: "rules", deviceId: r.deviceId, why: plan.why });
    out({ type: "decision", decision: d, seq: 0 });
    const call: ExecutorCall = { targetDeviceId: r.deviceId, executor: plan.executor, args: plan.args };
    out({ type: "narrate", stage: "act", text: `On ${label(r.deviceId)}: ${narration(call.executor, plan.target)}.`, speak: true });
    const started = Date.now();
    let commandId = "";
    const result = await deps.dispatcher.submit(
      { personId: r.principal.personId, ...(r.spokenTarget ? { spokenTarget: r.spokenTarget } : {}), ...(r.originDeviceId ? { originDeviceId: r.originDeviceId } : {}), executor: call.executor, args: call.args, commandKey: `${call.executor}:${JSON.stringify(call.args)}` },
      {
        timeoutMs: deps.remoteTimeoutMs ?? 60_000,
        signal: ctx.signal,
        onQueued: (id, deviceId) => {
          commandId = id;
          // The dispatcher re-resolves the device itself; it must agree with this job's target.
          if (deviceId !== r.deviceId) ctx.step({ intent: `device mismatch: dispatcher chose ${deviceId}`, executor: "companion", target: deviceId, ms: 0, outcome: "unknown" });
        },
      },
    );
    const ms = Date.now() - started;
    if (!result.ok) {
      const stopped = ctx.signal.aborted || /cancel/i.test(result.reason);
      r.note(ctx, { intent: `companion ${call.executor}: ${result.reason}`, executor: "companion", target: result.deviceId ?? r.deviceId, action: call.executor, jev: d, ms, outcome: stopped ? "cancelled" : "failed", verification: { method: "companion-report", ok: false } });
      const offline = /offline/i.test(result.reason);
      return {
        type: "done", ok: false, kind: "remote", decision: d, verified: false, ...base, ...(stopped ? { stopped: true } : {}),
        said: stopped ? "Stopped." : offline ? `${label(r.deviceId)} went offline, so it didn't finish there. Nothing ran anywhere else.` : `Not done on ${label(r.deviceId)}: ${result.reason.slice(0, 160)}`,
      };
    }
    if (result.local) return { type: "done", ok: false, kind: "unavailable", said: "That resolved to this PC after all, so nothing was sent.", ...base };
    const x = isExecutorResult(result.result) ? result.result : null;
    const verified = x ? x.verified : null;
    const ok = !!x && x.ok && verified === true;
    r.note(ctx, {
      intent: `companion ${call.executor}${commandId ? ` (${commandId.slice(0, 8)})` : ""}: ${x ? x.said : "no readable result"}`,
      executor: "companion",
      target: r.deviceId,
      action: call.executor,
      jev: d,
      ms,
      verification: { method: "companion-check", ok: verified, ...(x?.evidence ? { evidence: x.evidence.slice(0, 200) } : {}) },
      outcome: ok ? "ok" : verified === null ? "unknown" : "failed",
    });
    const said = !x ? `${label(r.deviceId)} didn't send back a result I can read, so I can't say it worked.` : ok ? x.said : x.ok ? `${x.said} I couldn't confirm it, so I'm not calling it done.` : x.said;
    return { type: "done", ok, said, kind: "remote", decision: d, verified, ...base, ...(ok ? {} : { outcome: "unverified" }) };
  }

  async function contextual(ctx: ExecutorContext, out: (e: CommandStreamEvent) => void, utterance: string, item: PageContextItem, tier: string, page: PageContext, decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision): Promise<CommandDoneEvent> {
    const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;
    const opening = /\b(?:open|show|go to|pull up|bring up|view)\b/i.test(utterance);
    const explaining = /\b(?:explain|what(?:'s| is| does)|why|how|break down|walk me through|tell me about)\b/i.test(utterance);
    const pkg = item.kind === "package" || item.kind === "margin" || item.kind === "metric" ? RECEPTIONIST_PACKAGES.find((p) => p.id === item.id || item.label.toLowerCase().includes(p.shortName.toLowerCase()) || String(item.data?.packageId ?? "") === p.id) : undefined;
    const marginLike = item.kind === "package" || item.kind === "margin" || item.kind === "metric";
    if (explaining && marginLike) {
      // The SELECTED item's own figures, quoted as shown, with the page's source and its data state. A package is
      // also cross-checked against the economics model; a mismatch is flagged, never smoothed over. No model
      // computes, rounds or writes a number here.
      const figures = shownFigures(item.data);
      const src = sourceWords(page.source);
      const model = pkg ? marginAnswer({ pkg, scenario: "base", clients: typeof item.data?.clients === "number" ? Math.max(1, Math.min(500, item.data.clients)) : 5 }) : null;
      const shownPct = shownContributionPct(item.data);
      const computed = model && model.numbers.contributionMarginBps !== null ? model.numbers.contributionMarginBps / 100 : null;
      const check: "match" | "mismatch" | "not-comparable" = shownPct === null || computed === null ? "not-comparable" : Math.abs(shownPct - computed) > 0.15 ? "mismatch" : "match";
      const d = decisionOf({ op: "answer.margin", target: pkg?.shortName ?? item.label, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} item on ${page.page}; ${figures.length ? "the figures it shows" : model ? "it shows no figures, so the economics model" : "it shows no figures"}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: ${tier} ${item.kind} "${item.label}" on ${page.page}${figures.length ? ` (${figures.length} shown figures)` : ""}`, executor: "deterministic", jev: d, ms: 0, outcome: "ok", verification: { method: figures.length ? "shown-figures" : "economics-model", ok: check !== "mismatch", evidence: `${page.source?.name ?? "no source"} [${page.source?.state ?? "unknown"}]${check === "mismatch" ? `; page shows ${shownPct}% vs model ${computed}%` : ""}` } });
      const sourceNumbers = { name: page.source?.name ?? null, state: page.source?.state ?? "unknown", updatedAt: page.source?.updatedAt ?? null };
      if (figures.length) {
        const cross = !model
          ? ""
          : check === "mismatch"
            ? ` The economics model says ${computed?.toFixed(1)}% contribution margin for this package, which doesn't match the ${shownPct}% shown, so treat the shown figure as suspect until it refreshes.`
            : check === "match"
              ? ` That matches the economics model's estimate.`
              : ` No contribution margin was shown to cross-check; the economics model's estimate is ${(computed ?? 0).toFixed(1)}%.`;
        const said = `${item.label}: ${figures.map(speakFigure).join(", ")}. ${src.line}${src.live ? "" : " Those are the page's figures, not confirmed live."}${cross}`;
        return { type: "done", ok: true, said, kind: "answer", decision: d, numbers: { itemId: item.id, itemKind: item.kind, shown: item.data ?? {}, source: sourceNumbers, crossCheck: check, ...(model ? { model: model.numbers } : {}) }, verified: check === "match" ? true : check === "mismatch" ? false : null, ...base };
      }
      if (model) {
        const said = `${item.label} shows no figures, so this is the economics model's answer instead. ${model.said} ${src.line}`;
        return { type: "done", ok: true, said, kind: "answer", decision: d, numbers: { ...model.numbers, itemId: item.id, itemKind: item.kind, shown: {}, source: sourceNumbers, crossCheck: "not-comparable" }, verified: true, ...base };
      }
      // Shown data only, and none shown: said, not delegated and not invented.
      return { type: "done", ok: false, ask: true, said: `${item.label} doesn't show any figures I can read, and it isn't a package I can work out, so I won't guess. ${src.line}`, kind: "ask", decision: d, numbers: { itemId: item.id, itemKind: item.kind, shown: {}, source: sourceNumbers }, verified: null, ...base };
    }
    if (item.kind === "job") {
      const job = deps.jobs().get(item.id);
      const d = decisionOf({ op: "answer.job", target: item.id, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} job on ${page.page}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: ${item.label}${job ? ` is ${job.state}` : " isn't in the job log"}`, executor: "deterministic", jev: d, ms: 0, outcome: job ? "ok" : "asked" });
      if (!job) return { type: "done", ok: false, ask: true, said: `I can't find ${item.label} in the job log, so I won't guess. Which job do you mean?`, kind: "ask", decision: d, ...base };
      return { type: "done", ok: true, said: `${job.title || item.label} is ${job.state}${job.targetDeviceId && job.targetDeviceId !== "none" ? ` on ${label(job.targetDeviceId)}` : ""}.`, kind: "answer", decision: d, numbers: { jobId: item.id, state: job.state }, verified: true, ...base };
    }
    if (opening && item.href) {
      const d = decisionOf({ op: "navigate", target: item.href, confidence: 1, policy: "act", source: "context", why: `"${item.label}" is the ${tier} ${item.kind} on ${page.page}` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: open ${item.kind} "${item.label}"`, executor: "none", jev: d, ms: 0, outcome: "ok" });
      return { type: "done", ok: true, said: `Opening ${item.label}.`, kind: "navigate", navigate: { path: item.href }, decision: d, verified: null, ...base };
    }
    if (opening) {
      const d = decisionOf({ op: "context.open", target: item.label, confidence: 0, policy: "ask", source: "context", why: `"${item.label}" has no page of its own` });
      out({ type: "decision", decision: d, seq: 0 });
      ctx.step({ intent: `context: "${item.label}" has no view to open`, executor: "none", jev: d, ms: 0, outcome: "asked" });
      return { type: "done", ok: false, ask: true, said: `${item.label} doesn't have a page of its own that I can open. What would you like to see?`, kind: "ask", decision: d, ...base };
    }
    // Anything else about the item is a question for the brain, WITH the item's shown facts (never invented).
    const facts = Object.entries(item.data ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ");
    const d = decisionOf({ op: "delegate.brain", target: item.label, confidence: 1, policy: "delegate", delegateTo: "brain", source: "context", why: `a question about "${item.label}" (${item.kind}) on ${page.page}` });
    out({ type: "decision", decision: d, seq: 0 });
    ctx.step({ intent: `context: delegate a question about ${item.kind} "${item.label}" to the brain`, executor: "handoff", jev: d, ms: 0, outcome: "note" });
    return {
      type: "done", ok: false, kind: "handoff", decision: d, verified: null, ...base,
      said: "That's a question for the chat brain; I've given it what the page shows.",
      handoff: { to: "brain", intent: "context", reason: d.why, utterance: `${utterance}\n[On ${page.page}, "${item.label}" (${item.kind})${facts ? `: ${facts}` : ""}. Use only these figures; say if something isn't shown.]` },
    };
  }

  async function delegate(
    rule: Extract<RulePlan, { lane: "delegate" }>,
    principal: Principal,
    memoryCaller: unknown,
    utterance: string,
    body: CommandBody,
    start: (targetDeviceId: string, work: (ctx: ExecutorContext, out: (e: CommandStreamEvent) => void) => Promise<CommandDoneEvent>) => Promise<CommandDoneEvent>,
    decisionOf: (d: Omit<JevDecision, "calibrationRunId">) => JevDecision,
    note: (ctx: ExecutorContext, s: Omit<Step, "seq" | "at" | "ms"> & { ms?: number }) => Step | null,
  ): Promise<CommandDoneEvent> {
    return start("none", async (ctx, out) => {
      const base = { jobId: null, runId: "", targetDeviceId: "none" } as const;
      const d = decisionOf({ op: rule.op, confidence: 1, policy: "delegate", delegateTo: rule.to, source: "rules", why: rule.why });
      out({ type: "decision", decision: d, seq: 0 });
      const began = Date.now();
      const finish = (ok: boolean, said: string, verified: boolean | null, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => {
        note(ctx, { intent: `delegate → ${rule.to}: ${said.slice(0, 160)}`, executor: rule.to, jev: d, ms: Date.now() - began, outcome: ok ? "ok" : verified === null ? "note" : "failed", verification: { method: `${rule.to}-service`, ok: verified } });
        // A failed delegate is "unavailable" (nothing to hand on); only a real handoff carries kind handoff.
        return { type: "done", ok, said, kind: ok ? "answer" : extra.handoff ? "handoff" : extra.ask ? "ask" : "unavailable", decision: d, verified, ...base, ...extra };
      };
      if (rule.to === "memory") {
        if (!deps.delegates?.memory || !memoryCaller) return finish(false, "Shared memory isn't connected on this server, so nothing was saved or changed.", null);
        const r = await deps.delegates.memory(utterance, memoryCaller, typeof body.spokenYes === "string" ? body.spokenYes : null).catch(() => ({ said: "Memory isn't answering right now, so I haven't saved or changed anything.", outcome: "error" }));
        if (!r) return finish(false, "That didn't read as a memory request, so nothing was saved.", null);
        // Done only when the memory service confirms it stored, changed or found something (REVIEW-T2 #1).
        const m = memoryOutcome(r.outcome);
        note(ctx, { intent: `memory outcome: ${r.outcome} (${m.what})`, executor: "memory", jev: d, outcome: "note" });
        if (m.kind === "done") return finish(true, r.said, true);
        if (m.kind === "question") return finish(false, r.said, null, { ask: true, awaiting: true });
        return finish(false, r.said, m.kind === "not-done" ? false : null);
      }
      if (rule.to === "leads") {
        const action = leadActionIn(utterance);
        if (!action || !deps.delegates?.leads) return finish(false, "The leads service isn't connected here, so nothing in the CRM changed.", null);
        const r = await deps.delegates.leads(action, principal).catch((e: Error) => ({ ok: false, said: `The CRM didn't take it: ${e.message.slice(0, 120)}`, verified: false as boolean | null }));
        return finish(r.ok && r.verified !== false, r.said, r.verified, r.ok ? {} : { ask: /which one/i.test(r.said) });
      }
      if (rule.to === "reminder") {
        const words = rememberToReminder(utterance);
        if (!words || !deps.delegates?.reminder) return finish(false, "Reminders aren't connected here, so nothing was set.", null);
        const r = await deps.delegates.reminder(words, principal).catch(() => ({ ok: false, said: "The reminder didn't set, so there's nothing scheduled." }));
        return finish(r.ok, r.said, r.ok);
      }
      if (rule.to === "receptionist") {
        if (!deps.delegates?.receptionist) return finish(false, "I can't read the receptionist's feed from here, so I won't guess.", null);
        const r: { ok: boolean; said: string; verified?: boolean | null } = await deps.delegates.receptionist(utterance).catch(() => ({ ok: false, said: "The receptionist's feed didn't answer, so I won't guess." }));
        return finish(r.ok, r.said, r.verified ?? r.ok);
      }
      return finish(false, "That's one for another of my tools.", null, { handoff: { to: rule.to, intent: rule.op, reason: rule.why, utterance } });
    });
  }

  /** Re-attach to a running (or just-finished) job's stream: events after `since`, then live until done. */
  function attach(jobId: string, principal: Principal, since: number, listener: (e: CommandStreamEvent) => void): { ok: true; detach: () => void } | { ok: false; reason: string } {
    const l = live.get(jobId);
    if (!l) return { ok: false, reason: "That command has finished or isn't known here; its outcome is in the job log." };
    if (l.personId !== principal.personId) return { ok: false, reason: "That's someone else's command." };
    if (l.grace) {
      clearTimeout(l.grace);
      l.grace = undefined;
    }
    for (const e of l.events) if (e.type === "done" || (e.seq ?? 0) > since) listener(e);
    if (l.done) return { ok: true, detach: () => undefined };
    l.listeners.add(listener);
    return { ok: true, detach: () => void l.listeners.delete(listener) };
  }

  /** The stream closed without its done: keep the job running for the grace period, then cancel it. */
  function dropped(jobId: string, listener?: (e: CommandStreamEvent) => void) {
    const l = live.get(jobId);
    if (!l || l.done) return;
    if (listener) l.listeners.delete(listener);
    if (l.listeners.size || l.grace) return;
    l.grace = setTimeout(() => {
      l.grace = undefined;
      if (!l.done && !l.listeners.size) void deps.jobs().cancel(jobId).catch(() => undefined);
    }, graceMs);
    l.grace.unref?.();
  }

  /** Stop one command (voice "stop", the pill's Stop): through the job service, at once. */
  async function cancel(jobId: string, principal: Principal) {
    const job = deps.jobs().get(jobId);
    if (!job) return { ok: false, state: null as string | null, reason: "No such job." };
    // Shared workspace (V7): either founder may stop a job; the job log records who asked.
    const result = await deps.jobs().cancel(jobId);
    return { ok: result.ok, state: result.state as string | null, by: principal.personId };
  }

  /** Every running command job of this person (voice "stop" with no job id). */
  async function cancelAllFor(principal: Principal) {
    const stopped: string[] = [];
    for (const [jobId, l] of live) if (!l.done && l.personId === principal.personId && (await deps.jobs().cancel(jobId).catch(() => null))?.ok) stopped.push(jobId);
    return stopped;
  }

  return { run, attach, dropped, cancel, cancelAllFor, liveJobs: () => [...live.keys()] };
}

function narration(executor: ExecutorName, target?: string) {
  switch (executor) {
    case "app.open":
      return `opening ${target ?? "the app"}`;
    case "open-url":
      return `opening ${target ?? "the page"}`;
    case "file.open":
      return `opening ${target ?? "the file"}`;
    case "deck.blank":
      return "starting a new PowerPoint with a title slide";
    case "notepad.type":
      return "typing the line into a new Notepad document";
    default:
      return executor;
  }
}

export type CommandService = ReturnType<typeof createCommandService>;
export { HANDOFF_SPECIALISTS };

/**
 * The memory service's outcome → whether a command is done (REVIEW-T2 #1). Stored: remembered, saved to the
 * vault, corrected, forgotten, or already there (duplicate). Found: recalled. A question (needs-confirm) waits
 * for his yes. Everything else (writes off → refused, not found, not indexed, cancelled, an error) is NOT done.
 */
export function memoryOutcome(outcome: string): { kind: "done" | "question" | "not-done" | "unknown"; what: string } {
  switch (outcome) {
    case "remembered":
      return { kind: "done", what: "stored in Hindsight memory" };
    case "saved-to-vault":
      return { kind: "done", what: "saved to the vault note" };
    case "duplicate":
      return { kind: "done", what: "already stored" };
    case "corrected":
      return { kind: "done", what: "the stored fact was changed" };
    case "forgotten":
      return { kind: "done", what: "removed" };
    case "recalled":
      return { kind: "done", what: "found and cited" };
    case "needs-confirm":
      return { kind: "question", what: "waiting for his yes" };
    case "refused":
    case "not-found":
    case "unindexed":
    case "cancelled":
      return { kind: "not-done", what: outcome };
    default:
      return { kind: "unknown", what: outcome || "no outcome reported" };
  }
}

import { prepareRoutingTurn, routingAuthority } from "./clarification-turn";
/**
 * The conversation-aware front of the ONE command path (Open Dot V). `createCommandService` hands its own `run` (the core) here and exposes
 * the result as `run`, so typed and spoken commands, the palette and the voice tool all get exactly this and nothing else:
 *
 *   1. event dedupe   a command carrying an `eventId` that this person already sent is the SAME command: the first run's outcome
 *                     is returned, never a second job and never a repeated action (a replayed utterance after a voice reconnect).
 *   2. follow-ups     "how's that going?", "stop that task", "also include their hours" about a job already linked to this person's
 *                     Jarvis thread are answered from / applied to THAT job (followup.ts), not started as a new one.
 *   3. link           a job the command left going (a computer job, a started coding job, a command waiting on a yes) is linked to the
 *                     person's durable conversation with a job-id receipt; the thread watcher then appends the real result there.
 *   4. context        the request's constraints, page, selected record and target device are written onto the job as one note step.
 *
 * It starts nothing itself: every action is the core's, the job service's cancel, or the coding delegate's own stop.
 */
import { stopOutcome, type JobService } from "../jobs/service";
import { commandRequestId, type CommandAdmission } from "../jobs/command-admission";
import { commandAdmissionKey, commandPrevented } from "./admission";
import type { CommandDoneEvent, CommandStreamEvent, PageContext } from "./contracts";
import type { RunInput } from "./service";
import { randomUUID } from "node:crypto";
import type { BotScope } from "../agents/jarvis";
import { mayUseBots } from "../identity/principal";
import { botThreadId, ConversationsUnreadable, jarvisThreadId, parseBotConversationKey, type ThreadBlocker } from "../conversations";
import { classifyFollowUp, isOpenState, type ActiveJob } from "./followup";
import type { JobThreads } from "./threads";

export type RunMeta = { pageContext?: PageContext | null };
type Core = (input: RunInput, emit: (e: CommandStreamEvent) => void, meta: RunMeta) => Promise<CommandDoneEvent>;

export const BOT_NEEDS_SESSION = "Agents need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC. Nothing was written and nothing ran.";
const EVENT_ID = /^[\w:.-]{6,80}$/;
const THREAD_ID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const EVENT_WINDOW_MS = 30 * 60_000;
const EVENT_MAX = 512;
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const shortId = (id: string) => id.slice(0, 8);

/** What a job should carry from the request: the words, the page, the record he selected, the device. One masked line (≤ 280). Pure. */
export function requestContext(input: { utterance: string; pageContext?: PageContext | null; deviceLabel?: string | null; account?: string | null }): string {
  const p = input.pageContext as (Omit<PageContext, "page"> & { page?: string | { path?: string } }) | null | undefined;
  const page = typeof p?.page === "string" ? p.page : (p?.page?.path ?? "");
  const pick = [p?.focused, ...(p?.selected ?? [])].filter((i): i is NonNullable<typeof i> => !!i).slice(0, 2).map((i) => `${i.kind} "${cut(String(i.label ?? i.id), 40)}"`);
  const parts = [`request "${cut(input.utterance.replace(/\s+/g, " "), 150)}"`, page ? `page ${cut(page, 40)}` : "", pick.length ? `selected ${pick.join(", ")}` : "", input.deviceLabel ? `device ${cut(input.deviceLabel, 30)}` : "", input.account ? `account ${input.account}` : ""].filter(Boolean);
  return cut(`context: ${parts.join("; ")}`, 280);
}

export function createLinkedRunner(deps: {
  core: Core;
  threads?: JobThreads;
  jobs: () => JobService;
  now?: () => number;
  /** Legacy exact-rule services never create router questions. */
  routingEnabled?: boolean;
  /** The whole-request stop words (service.ts STOP_WORDS). */
  isStop: (utterance: string) => boolean;
  /** Cancel the exact resumed admission while it is still routing, before a task exists. */
  cancelAdmittedEvent?: (eventId: string, principal: RunInput["principal"]) => Promise<{ outcome: string; jobId?: string }>;
  deviceLabel?: (id: string) => string;
  /** The coding delegate (its own stop words and per-person state), for "stop that task" on a coding job. */
  coding?: (utterance: string, turn: { personId: string; actor: "human" | "process"; via: string; spokenYes: string | null }) => Promise<{ say: string } | null>;
  /**
   * Agent bots (scripts/agents/jarvis.ts): which bot a turn is for. With a bot, the turn lands in THAT person's conversation with that bot (its
   * progress, its result, its one completion), follow-ups ("stop that task") only see that bot's jobs, and the request and the reply are
   * written into the bot thread as server entries. Without one, nothing changes.
   */
  bots?: { scope(input: { principal: RunInput["principal"]; utterance: string; body: RunInput["body"] }): BotScope | null; nameOf(botId: string): string; /** This person's conversation ids with every bot. */ threadIds(personId: string): string[] };
}) {
  const now = deps.now ?? Date.now;
  const routingRuns = new Map<string, RunInput>();
  /** Per person+eventId: the first run's outcome, and its stream so far (a resend replays it, the `job` event included, then follows it live). */
  const events = new Map<string, { at: number; binding: string; failed: boolean; settled: boolean; promise: Promise<CommandDoneEvent>; seen: CommandStreamEvent[]; followers: Set<(e: CommandStreamEvent) => void> }>();

  const done = (said: string, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => ({ type: "done", ok: true, said, kind: "answer", jobId: null, runId: "", targetDeviceId: null, ...extra });

  /** "Research's "find the contact page"", "your "open notepad"": whose job a question is about. */
  const whose = (j: ActiveJob) => `${j.bot && deps.bots ? `${deps.bots.nameOf(j.bot)}'s` : "your"} "${cut(j.title, 36)}"`;

  async function followUp(input: RunInput, conversationId: string | undefined, active: ActiveJob[], alone = false): Promise<CommandDoneEvent | null> {
    const { principal, body } = input;
    const threads = deps.threads!;
    if (input.admission && deps.jobs().commandAdmission(input.admission.personId, input.admission.eventId)?.stoppedAt != null) return commandPrevented();
    const f = classifyFollowUp(String(body.utterance ?? ""), active, now());
    if (f.kind === "none") return null;
    // "Stop that task" with open jobs in more than one conversation (the default thread and a bot's, or two bots'): when the words don't single one
    // out (the same words would also fit the others), ask which. Never pick a bot's job, or the wrong bot's, by recency alone.
    if (!alone && f.kind !== "ask") {
      const chosen = active.find((j) => j.jobId === f.jobId);
      const others = chosen ? active.filter((j) => j.jobId !== chosen.jobId && isOpenState(j.state) && j.conversationId !== chosen.conversationId) : [];
      if (chosen && isOpenState(chosen.state) && others.length && [chosen, ...others].some((j) => j.bot) && classifyFollowUp(String(body.utterance ?? ""), others, now()).kind !== "none") {
        const options = [chosen, ...others].slice(0, 3);
        const verb = f.kind === "cancel" ? "stop" : f.kind === "status" ? "check" : "add that to";
        return done(`Which one to ${verb}: ${options.slice(0, -1).map(whose).join(", ")} or ${whose(options[options.length - 1])}?`, { ok: false, kind: "ask", ask: true, numbers: { options: options.map((j) => j.jobId) } });
      }
    }
    const job = f.kind === "ask" ? null : active.find((j) => j.jobId === f.jobId)!;
    const tid = job?.conversationId ?? (await threadIdFor(principal.personId, conversationId)) ?? "";
    if (f.kind === "ask") return done(f.question, { ok: false, kind: "ask", ask: true, numbers: { options: f.options } });
    if (f.kind === "status") {
      const s = await threads.status(tid, job!.jobId, job!.kind);
      return s ? done(s.said, { jobId: job!.jobId, numbers: { jobId: job!.jobId, state: s.state }, verified: true }) : done("I can't read that job any more, so I won't guess its state.", { ok: false, jobId: job!.jobId });
    }
    if (f.kind === "cancel") {
      if (job!.kind === "coding") {
        // The job the words were about, by its id (round 10): never "the newest coding job", which could be another task.
        const r = await deps.coding?.(`stop the coding job ${job!.jobId}`, { personId: principal.personId, actor: principal.actor === "human" ? "human" : "process", via: principal.via === "loopback-owner" ? "local" : "tailnet", spokenYes: null }).catch(() => null);
        try { threads.touch(tid, job!.jobId); } catch { /* Stop must not depend on transcript persistence. */ }
        return r ? done(r.say, { jobId: job!.jobId, stopped: true }) : done("I couldn't reach the coding harness to stop it, so it is unchanged.", { ok: false, jobId: job!.jobId });
      }
      const res = await deps.jobs().cancel(job!.jobId).catch(() => null);
      try { threads.touch(tid, job!.jobId, res?.state ? { state: res.state } : {}); } catch { /* The job stop result is authoritative even when its conversation is unwritable. */ }
      // Only a confirmed cancelled state is "Stopped" (release re-check M1): a quarantined/unknown stop, or one that hadn't settled, says so.
      const outcome = stopOutcome(res);
      if (outcome === "stopped") return done("Stopped it. Nothing further will run.", { jobId: job!.jobId, stopped: true, numbers: { jobId: job!.jobId, state: res!.state } });
      if (outcome === "already-ended") return done(`That had already ${res!.state === "succeeded" ? "finished" : res!.state === "cancelled" ? "been stopped" : res!.state === "failed" ? "failed" : "ended"}, so there was nothing to stop.`, { jobId: job!.jobId, numbers: { jobId: job!.jobId, state: res!.state } });
      return done("Stop requested; not yet confirmed (the job didn't acknowledge it). It may still be running: check Activity before trusting it.", { ok: false, outcome: "unverified", jobId: job!.jobId, numbers: { jobId: job!.jobId, ...(res?.state ? { state: res.state } : {}) } });
    }
    // attach: more context for the job that is going; never a second job.
    if (job!.kind === "coding") {
      threads.touch(tid, job!.jobId, { addContext: f.context });
      return done("Noted on the coding job. A builder that's already running won't see it; say stop and I'll draft it again with that.", { jobId: job!.jobId, numbers: { jobId: job!.jobId, attached: true } });
    }
    const step = deps.jobs().step(job!.jobId, { intent: cut(`added context: ${f.context}`, 280), executor: "context", ms: 0, outcome: "note" });
    if (!step) return done("That job has already ended, so I didn't add to it. Tell me if you want a new one.", { ok: false, jobId: job!.jobId });
    threads.touch(tid, job!.jobId, { addContext: f.context });
    return done(`Added to the ${cut(job!.title, 30)} job.`, { jobId: job!.jobId, numbers: { jobId: job!.jobId, attached: true }, verified: true });
  }

  async function threadIdFor(personId: string, conversationId?: string): Promise<string | null> {
    return deps.threads ? ((await deps.threads.thread(personId, conversationId))?.id ?? null) : null;
  }

  /** The conversation id a request names (a UUID, or a bot conversation's `agent:<person>:<bot>` key for THIS person), or undefined. */
  function conversationOf(personId: string, value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    if (THREAD_ID.test(value)) return value;
    const key = parseBotConversationKey(value);
    return key && key.personId === personId ? botThreadId(key.personId, key.botId) : undefined;
  }

  /**
   * One turn. A turn for an agent bot (scripts/agents/jarvis.ts scope) is written into the bot's conversation first (the person's words, or "Spoken
   * request." for a spoken one: spoken words are not kept), runs with the bot's conversation as its thread, and ends with the assistant's reply
   * written there too. Every entry has a stable key (`<commandId>:request`, `:ack`), so a replayed command writes nothing twice.
   */
  async function runLinked(input: RunInput, emit: (e: CommandStreamEvent) => void): Promise<CommandDoneEvent> {
    if (input.admission && deps.jobs().commandAdmission(input.admission.personId, input.admission.eventId)?.stoppedAt != null) return commandPrevented();
    const words = String(input.body.utterance ?? "").trim();
    const resolvedScope = deps.bots?.scope({ principal: input.principal, utterance: words, body: input.body }) ?? null;
    const explicitStop = deps.isStop(resolvedScope?.kind === "bot" ? resolvedScope.utterance.trim() : words);
    if (explicitStop && resolvedScope?.kind === "refuse") return done(resolvedScope.said, { ok: false, kind: "refused", refused: true });
    if (explicitStop && resolvedScope?.kind === "ask") return done(resolvedScope.said, { ok: false, kind: "ask", ask: true });
    const stopScope = resolvedScope?.kind === "bot" ? resolvedScope.conversationId : resolvedScope?.kind === "default" ? resolvedScope.conversationId : input.body.conversationId === undefined ? jarvisThreadId(input.principal.personId) : conversationOf(input.principal.personId, input.body.conversationId);
    const scopedStops: Array<{ outcome: string; jobId?: string }> = [];
    if (stopScope && explicitStop && deps.cancelAdmittedEvent) {
      const authority = routingAuthority(input.principal);
      for (const running of [...routingRuns.values()]) {
        const turn = running.routing!;
        const botScope = turn.selection?.kind === "bot" ? botThreadId(running.principal.personId, turn.selection.bot) : null;
        if (!authority || turn.authority !== authority || running.principal.personId !== input.principal.personId || turn.conversationId !== stopScope && botScope !== stopScope || !running.body.eventId) continue;
        scopedStops.push(await deps.cancelAdmittedEvent(running.body.eventId, input.principal).catch(() => ({ outcome: "unconfirmed" })));
      }
    }
    const pendingStops = scopedStops.filter(s => s.outcome === "unconfirmed").length;
    const confirmedStops = scopedStops.filter(s => s.outcome === "stopped" || s.outcome === "prevented");
    const prepareInput = explicitStop && resolvedScope?.kind === "bot" ? { ...input, body: { ...input.body, utterance: resolvedScope.utterance, target: { bot: resolvedScope.bot.id } } } : input;
    const prepared = deps.routingEnabled === false ? prepareInput : prepareRoutingTurn(prepareInput, deps.threads, now(), deps.isStop);
    if ("type" in prepared) return prepared;
    const annotate = (result: CommandDoneEvent): CommandDoneEvent => {
      const dropped = prepared.routingCancelled ? " Dropped the request waiting for your route choice." : "";
      const failed = prepared.routingContextFailed ? " I couldn't clear the saved route question. Send a full new request rather than answering that old question." : "";
      const waiting = pendingStops ? " Stop was also requested for the resumed request still starting; its final stop is not yet confirmed." : "";
      const stopped = confirmedStops.length ? " Stopped the resumed request." : "";
      const lead = confirmedStops.length && /^Nothing .*running/i.test(result.said) ? "" : result.said;
      return dropped || failed || waiting || stopped ? { ...result, said: `${lead}${dropped}${failed}${stopped}${waiting}`.trim(), ...(confirmedStops.length ? { stopped: true, jobId: result.jobId ?? confirmedStops.find(s => s.jobId)?.jobId ?? null } : {}), ...(pendingStops ? { ok: false, outcome: "unverified" as const } : {}), numbers: { ...result.numbers, ...(dropped ? { clarificationCancelled: true } : {}), ...(failed ? { clarificationContextFailed: true } : {}), ...(waiting ? { pendingClarificationStops: pendingStops } : {}), ...(confirmedStops.length ? { stoppedClarificationRequests: confirmedStops.length } : {}) } } : result;
    };
    const runKey = prepared.routing?.selection ? `${prepared.principal.personId}|${prepared.body.eventId ?? prepared.routing.generation}` : null;
    if (runKey) routingRuns.set(runKey, prepared);
    const routedEmit = prepared.routingCancelled || prepared.routingContextFailed || scopedStops.length ? (e: CommandStreamEvent) => emit(e.type === "done" ? annotate(e) : e) : emit;
    try { return annotate(await runLinkedPrepared(prepared, routedEmit)); }
    finally { if (runKey) routingRuns.delete(runKey); }
  }
  async function runLinkedPrepared(input: RunInput, emit: (e: CommandStreamEvent) => void): Promise<CommandDoneEvent> {
    const { principal, body } = input;
    const source = body?.source;
    const threads = deps.threads;
    const eligible = !!threads && source !== "acceptance" && source !== "away" && !body?.steps?.length;
    const conversationId = conversationOf(principal.personId, body?.conversationId);
    const words = String(body?.utterance ?? "");
    const scope: BotScope | null = eligible && deps.bots ? deps.bots.scope({ principal, utterance: words, body: { ...body, ...(conversationId ? { conversationId } : {}) } }) : null;
    if (scope?.kind === "ask") return done(scope.said, { ok: false, kind: "ask", ask: true });
    if (scope?.kind === "refuse") return done(scope.said, { ok: false, kind: "refused", refused: true });
    if (scope?.kind !== "bot") {
      // Not a bot's turn. A request for the person's own device typed inside a bot conversation stays in the default thread.
      const plain = scope?.kind === "default" ? { ...input, body: { ...body, conversationId: scope.conversationId, target: undefined } } : input;
      return runPlain(plain, emit, scope?.kind === "default" ? scope.conversationId : conversationId, null);
    }
    // Agents need a confirmed person or the owner at the hub: before anything is written to the bot thread and before any job exists.
    if (!mayUseBots(principal)) return done(BOT_NEEDS_SESSION, { ok: false, kind: "refused", refused: true });
    const commandId = typeof body.eventId === "string" && EVENT_ID.test(body.eventId) ? body.eventId : randomUUID();
    const botTurn: RunInput = { ...input, body: { ...body, utterance: scope.utterance, conversationId: scope.conversationId, target: { bot: scope.bot.id }, ...(scope.subjects.length ? { subjects: scope.subjects } : {}) } };
    // A Stop cannot be held behind a request/ack transcript write. The owned job stop is its receipt.
    if (deps.isStop(scope.utterance.trim())) return runPlain(botTurn, emit, scope.conversationId, scope.bot);
    // The same event id again after a restart (the in-memory dedupe is gone) or after its window: the conversation already holds the command, so
    // it is answered from the record and never run a second time. Nothing here can start a job.
    let prior: ReturnType<NonNullable<typeof threads>["priorCommand"]> = null;
    try {
      prior = threads!.priorCommand({ personId: principal.personId, bot: scope.bot, commandId });
      if (!prior) threads!.note({ personId: principal.personId, bot: scope.bot, commandId, role: "request", text: source === "voice" ? "Spoken request." : words });
    } catch (error) {
      // The saved conversations cannot be read or written: say so, before anything has started.
      if (error instanceof ConversationsUnreadable) return done(`${error.message} Nothing was started.`, { ok: false, kind: "unavailable" });
      throw error;
    }
    // A command the hub never ran can be run: its reply is a failure with nothing started (the run threw, or the hub restarted before anything began),
    // so a Send again with the same event id is the same request run for the first time. Anything that may have started something is answered, not run.
    let rerun = false;
    if (prior) {
      const a = prior.ack;
      if (a ? a.ok === false && !a.jobId && !a.stopped && !a.unverified : !prior.mayHaveStarted) rerun = true;
      else {
        return a
          ? done(a.text, { ok: a.ok ?? !a.blocker, kind: "answer", ...(a.stopped ? { stopped: true } : {}), jobId: a.jobId || null, numbers: { replayed: true, ...(a.jobId ? { jobId: a.jobId } : {}) } })
          : done("That request reached the hub earlier, but I can't confirm how it ended. A job for this bot started after it, and it may or may not be this one. It was not run again: check this conversation before asking twice.", { ok: false, kind: "unavailable", outcome: "unverified", numbers: { replayed: true } });
      }
    }
    let result: CommandDoneEvent;
    try {
      // Round 10: a bot named from ANOTHER conversation ("Ask Research to ..." typed to Jarvis, or found from the open page) returns its result there too.
      const origin = input.routing?.selection ? input.routing.conversationId : scope.via === "words" || scope.via === "page" ? (conversationId ?? jarvisThreadId(principal.personId)) : undefined;
      result = await runPlain(botTurn, emit, scope.conversationId, scope.bot, origin !== scope.conversationId ? origin : undefined);
    } catch (error) {
      // The run threw: write the reply anyway, so the conversation never holds a request with no answer. If something may have started, say the
      // outcome is not known. A durable admission is not proof that a delegate never dispatched before throwing.
      let started = false;
      try {
        started = !!input.admission || !!threads!.priorCommand({ personId: principal.personId, bot: scope.bot, commandId })?.mayHaveStarted;
        threads!.note({ personId: principal.personId, bot: scope.bot, commandId, role: "ack", text: started ? "That request hit a fault and its outcome is not confirmed. It will not be run again automatically: check this conversation and its jobs before starting new work." : "That did not run: the hub hit a fault before it started anything. Sending it again is safe.", ok: false, ...(started ? { unverified: true } : {}), replace: true });
      } catch { /* the reply could not be saved either: the thrown error below still reaches the person */ }
      throw error;
    }
    const n = (result.numbers ?? {}) as { codingJobId?: string; blocker?: ThreadBlocker };
    const jobId = n.codingJobId ?? result.jobId ?? undefined;
    // The job (if any) is already going: failing to write its receipt must not turn a started job into a failed command.
    try {
      threads!.note({ personId: principal.personId, bot: scope.bot, commandId, role: "ack", text: result.said, ok: result.ok, ...(result.stopped ? { stopped: true } : {}), ...(result.outcome === "unverified" ? { unverified: true } : {}), ...(jobId ? { jobId } : {}), ...(n.codingJobId ? { jobKind: "coding" as const } : {}), ...(n.blocker ? { blocker: n.blocker } : {}), ...(rerun ? { replace: true } : {}) });
    } catch (error) {
      if (!(error instanceof ConversationsUnreadable)) throw error;
      return { ...result, said: `${result.said} (I couldn't save this to the conversation: ${error.message})` };
    }
    return result;
  }

  async function runPlain(input: RunInput, emit: (e: CommandStreamEvent) => void, conversationId: string | undefined, bot: { id: string; name: string } | null, /** Where a bot's turn was asked from, when not the bot's own conversation (threads.link origin). */ origin?: string): Promise<CommandDoneEvent> {
    const { principal, body } = input;
    const source = body?.source;
    const threads = deps.threads;
    if (principal.via === "loopback-owner") threads?.noteLocal(principal.personId);
    const eligible = !!threads && source !== "acceptance" && source !== "away" && !body?.steps?.length;
    let active: ActiveJob[] = [];
    if (eligible) {
      // A bot's conversation sees only that bot's jobs; the default thread sees its own and every bot's (and asks when "that task" could be either).
      active = await threads!.active(principal.personId, conversationId, bot ? { only: true } : deps.bots ? { withBots: deps.bots.threadIds(principal.personId) } : {}).catch(() => []);
      // A bare "stop" inside a bot conversation is about THAT bot's task, never the person's own device commands.
      if (bot && deps.isStop(String(body.utterance ?? "").trim())) {
        const open = active.filter((j) => isOpenState(j.state));
        if (!open.length) return done(`Nothing is running for ${bot.name}, so there is nothing to stop.`);
        if (open.length > 1) return done(`Which one to stop: ${open.slice(0, 3).map(whose).join(" or ")}?`, { ok: false, kind: "ask", ask: true });
        const f = await followUp({ ...input, principal, body: { ...body, utterance: "stop that task" } }, conversationId, active, true).catch(() => null);
        if (f) return f;
      }
      // The restored request already passed follow-up interpretation before its route question.
      const handled = input.routing?.selection ? null : await followUp(input, conversationId, active, !!bot).catch(() => null);
      if (handled) return handled;
    }
    const meta: RunMeta = {};
    const provenance = input.routing?.questionId ? { questionId: input.routing.questionId, askJobId: input.routing.askJobId, originalEventId: input.routing.originalEventId, answerEventId: body.eventId ?? null } : null;
    const annotate = (result: CommandDoneEvent): CommandDoneEvent => provenance ? { ...result, numbers: { ...result.numbers, clarification: provenance } } : result;
    let result = annotate(await deps.core(input, emit, meta));
    if (provenance) {
      if (result.jobId) try { deps.jobs().step(result.jobId, { intent: `routing clarification ${provenance.questionId}: original ${provenance.originalEventId ?? "unkeyed"}; answer ${provenance.answerEventId ?? "unkeyed"}; ask job ${provenance.askJobId ?? "none"}`, executor: "context", outcome: "note", ms: 0 }); } catch { /* The admitted task and private question still retain their binding. */ }
    }
    if (!eligible) return result;

    // A bare "stop" that the core found nothing of his own to stop: the jobs left going in his thread are what he means.
    if (result.stopped && !result.jobId && deps.isStop(String(body.utterance ?? "").trim())) {
      const open = active.filter((j) => isOpenState(j.state));
      if (open.length === 1) {
        const f = await followUp({ ...input, principal, body: { ...body, utterance: "stop that task" } }, conversationId, active).catch(() => null);
        // Both facts (review, round 11): the job it stopped AND the coding question it dropped.
        if (f) return (result.numbers as { codingDraftDropped?: boolean } | undefined)?.codingDraftDropped ? { ...f, said: `${f.said} I've also dropped the coding request that was waiting for your answer.` } : f;
      }
      if (open.length > 1) return done(`Which one to stop: ${open.slice(0, 3).map(whose).join(" or ")}?`, { ok: false, kind: "ask", ask: true });
    }

    // Link what the command left going.
    const codingJobId = (result.numbers as { codingJobId?: string } | undefined)?.codingJobId;
    const codingState = (result.numbers as { codingJobState?: string } | undefined)?.codingJobState;
    const target = codingJobId ? { id: codingJobId, kind: "coding" as const } : result.jobId ? { id: result.jobId, kind: "job" as const } : null;
    if (!target || !result.ok && result.stopped) return result;
    // Round 11: a coding draft made here records this conversation as its origin (linked as pending, no entry): started later from here OR from the
    // draft page (/coding/<id>), its progress and its one final result come back to this conversation.
    // Review M2: only a NEW draft made by this turn's own words (the harness marks it, and only for this person's request) records an origin; a
    // status reply or anything else that merely names a draft (possibly someone else's) never links it here.
    const drafted = (result.numbers as { codingDrafted?: boolean } | undefined)?.codingDrafted === true;
    if (target.kind === "coding" && codingState && /^(?:draft|awaiting_confirmation)$/.test(codingState)) {
      if (!drafted) return result;
      await threads!.link({ personId: principal.personId, ...(conversationId ? { conversationId } : {}), ...(bot ? { bot } : {}), jobId: target.id, kind: "coding", title: cut(String(body.utterance ?? ""), 60), pending: true }).catch(() => null);
      return result;
    }
    if (target.kind === "coding" && (!codingState || !isOpenState(codingState))) return result;
    // Release re-check M4: a coding reply links its job as this conversation's running job only when THIS turn started it ("start it", a resume);
    // a status or "show me" reply that names someone's job never does (that wrote a false "Started" entry into the asker's conversation).
    if (target.kind === "coding" && (result.numbers as { codingStarted?: boolean } | undefined)?.codingStarted !== true) return result;
    const state = target.kind === "job" ? deps.jobs().get(target.id)?.state : codingState;
    if (!state || !isOpenState(state)) return result;
    // A job this command just created is "started"; one it only brought up ("show me the research computer") is "following".
    const createdAt = target.kind === "job" ? Date.parse(deps.jobs().get(target.id)?.createdAt ?? "") : Date.now();
    const attached = target.kind === "job" && !(Date.now() - createdAt < 20_000);
    const linked = await threads!.link({ personId: principal.personId, ...(conversationId ? { conversationId } : {}), ...(bot ? { bot } : {}), ...(bot && origin ? { origin } : {}), jobId: target.id, kind: target.kind, attached, title: target.kind === "job" ? (deps.jobs().get(target.id)?.title ?? "") : cut(String(body.utterance ?? ""), 60) }).catch(() => null);
    if (!linked) return result;
    if (linked.created && target.kind === "job" && !attached)
      deps.jobs().step(target.id, { intent: requestContext({ utterance: String(body.utterance ?? ""), pageContext: meta.pageContext, deviceLabel: result.targetDeviceId && result.targetDeviceId !== "none" ? (deps.deviceLabel?.(result.targetDeviceId) ?? null) : null }), executor: "context", ms: 0, outcome: "note" });
    // The receipt: short, and backed by the job id the server just recorded.
    const ack = linked.created && !attached ? (source === "voice" ? `${cut(result.said.split(/(?<=[.!?])\s/)[0] ?? result.said, 90)} Job ${shortId(target.id)}.` : `${result.said} (job ${shortId(target.id)})`) : result.said;
    return { ...result, said: ack, jobId: result.jobId ?? target.id, numbers: { ...(result.numbers as object | undefined), jobId: target.id, conversationId: linked.conversationId } };
  }

  /** Read existing results only. An admission with no observed result is never dispatched again. */
  async function replay(input: RunInput, record: CommandAdmission): Promise<CommandDoneEvent> {
    if (record.admittedAt === null) return commandPrevented();
    const { principal, body } = input;
    if (deps.threads && deps.bots && mayUseBots(principal) && record.outcome !== "unknown") {
      const scope = deps.bots.scope({ principal, utterance: String(body.utterance ?? ""), body });
      if (scope?.kind === "bot") {
        const prior = deps.threads.priorCommand({ personId: principal.personId, bot: scope.bot, commandId: record.eventId });
        const a = prior?.ack;
        if (a) return done(a.text, { ok: a.ok ?? !a.blocker, ...(a.stopped ? { stopped: true } : {}), jobId: a.jobId || null, numbers: { replayed: true, ...(a.jobId ? { jobId: a.jobId } : {}) } });
      }
    }
    const taskId = record.taskKind === "coding" ? record.taskId : record.jobKind === "coding" ? record.jobId : null;
    if (taskId) {
      // threads.status() refreshes lastReferencedAt. A duplicate must not retarget later follow-ups.
      return done("That request already reached the coding job. Check its original conversation or job; it was not started again.", {
        jobId: taskId, numbers: { replayed: true, codingJobId: taskId }, verified: null,
      });
    }
    const taskJob = record.taskKind === "job" ? record.taskId : record.jobKind === "job" ? record.jobId : null;
    const job = taskJob ? deps.jobs().get(taskJob) : deps.jobs().byRequest(commandRequestId(principal.personId, record.eventId));
    if (job && job.principal.personId === principal.personId) {
      const open = ["running", "queued", "awaiting-approval"].includes(job.state);
      return done(open ? `That request is already ${job.state === "awaiting-approval" ? "waiting for your yes" : "running"}, so I didn't start it again.` : `That request already ran (${job.state}). It was not run again.`, {
        ok: open || job.state === "succeeded", jobId: job.id, targetDeviceId: job.targetDeviceId,
        numbers: { replayed: true, jobId: job.id, state: job.state }, verified: null,
      });
    }
    if (record.outcome === "stopped") return done("The stop for that request was recorded. It will not be started again.", { stopped: true, numbers: { replayed: true }, verified: null });
    const complete = record.outcome === "completed" || record.outcome === "no-work";
    return done(complete ? "That request was already handled. Check its original conversation or job; it was not run again." : "That request was received, but its outcome is not confirmed. It was not run again; check the original conversation or job before starting new work.", {
      ok: complete, ...(complete ? {} : { outcome: "unverified" }), jobId: record.jobId,
      numbers: { replayed: true, ...(record.jobId ? { [record.jobKind === "coding" ? "codingJobId" : "jobId"]: record.jobId } : {}) }, verified: null,
    });
  }

  /** Claim before any follow-up, thread mutation, planner or executor can run. */
  return async function run(input: RunInput, emit: (e: CommandStreamEvent) => void = () => undefined): Promise<CommandDoneEvent> {
    const eventId = typeof input.body?.eventId === "string" && EVENT_ID.test(input.body.eventId) ? input.body.eventId : null;
    if (!eventId) return runLinked(input, emit);
    const admission = commandAdmissionKey(input, eventId);
    const claim = deps.jobs().claimCommand(admission);
    if (claim.status === "conflict") return done("That request id belongs to a different conversation, target or request. Nothing new was started. Send a new request with a new id.", { ok: false, kind: "refused", refused: true });
    if (claim.record.admittedAt === null) return commandPrevented();
    const key = `${input.principal.personId}|${eventId}`;
    const t = now();
    const hit = events.get(key);
    if (hit && hit.binding === admission.binding && !hit.failed && (!hit.settled || t - hit.at <= EVENT_WINDOW_MS)) {
      let sawDone = false;
      const follow = (e: CommandStreamEvent) => { if (e.type === "done") sawDone = true; emit(e); };
      for (const e of hit.seen) follow(e);
      hit.followers.add(follow);
      try {
        const d = await hit.promise;
        if (!sawDone) emit(d);
        return d;
      } finally { hit.followers.delete(follow); }
    }
    if (claim.status === "existing") return replay(input, claim.record);
    // A legacy job may predate the ledger. Preserve its existing request-id receipt before doing anything else.
    const prior = deps.jobs().byRequest(commandRequestId(admission.personId, admission.eventId));
    if (prior && prior.principal.personId === admission.personId) {
      const record = deps.jobs().settleCommand(admission.personId, admission.eventId, admission.binding, { jobId: prior.id, jobKind: "job", outcome: "completed" });
      return replay(input, record!);
    }
    const seen: CommandStreamEvent[] = [];
    const followers = new Set<(e: CommandStreamEvent) => void>();
    const fanout = (e: CommandStreamEvent) => {
      if (seen.length < 500) seen.push(e);
      emit(e);
      for (const f of [...followers]) try { f(e); } catch { /* a follower never breaks the first run */ }
    };
    const holder = { at: t, binding: admission.binding, failed: false, settled: false, promise: null as unknown as Promise<CommandDoneEvent>, seen, followers };
    // A microtask installs the local fanout before even a synchronous core can emit or re-enter.
    holder.promise = Promise.resolve().then(() => runLinked({ ...input, admission }, fanout)).then((result) => {
      // Dispatch identity is written by the core only when it observes an actual start. A returned
      // status/reference is not cancellation authority and must never become a task binding here.
      deps.jobs().settleCommand(admission.personId, admission.eventId, admission.binding, {
        outcome: result.outcome === "unverified" || result.outcome === "uncertain" ? "unknown" : result.stopped && result.ok ? "stopped" : result.ok ? "completed" : "unknown",
      });
      holder.settled = true;
      return result;
    }).catch((error) => {
      holder.failed = true; holder.settled = true;
      // The claim itself already prevents replay if even the settlement write failed.
      try { deps.jobs().settleCommand(admission.personId, admission.eventId, admission.binding, { outcome: "unknown" }); } catch { /* retain the original error and durable claim */ }
      throw error;
    });
    events.set(key, holder);
    if (events.size > EVENT_MAX) for (const [k, v] of events) if (v.settled && (t - v.at > EVENT_WINDOW_MS || events.size > EVENT_MAX)) events.delete(k);
    return holder.promise;
  };
}

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
  /** The whole-request stop words (service.ts STOP_WORDS). */
  isStop: (utterance: string) => boolean;
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
  /** Per person+eventId: the first run's outcome, and its stream so far (a resend replays it, the `job` event included, then follows it live). */
  const events = new Map<string, { at: number; promise: Promise<CommandDoneEvent>; seen: CommandStreamEvent[]; followers: Set<(e: CommandStreamEvent) => void> }>();

  const done = (said: string, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => ({ type: "done", ok: true, said, kind: "answer", jobId: null, runId: "", targetDeviceId: null, ...extra });

  /** "Research's "find the contact page"", "your "open notepad"": whose job a question is about. */
  const whose = (j: ActiveJob) => `${j.bot && deps.bots ? `${deps.bots.nameOf(j.bot)}'s` : "your"} "${cut(j.title, 36)}"`;

  async function followUp(input: RunInput, conversationId: string | undefined, active: ActiveJob[], alone = false): Promise<CommandDoneEvent | null> {
    const { principal, body } = input;
    const threads = deps.threads!;
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
        threads.touch(tid, job!.jobId);
        return r ? done(r.say, { jobId: job!.jobId, stopped: true }) : done("I couldn't reach the coding harness to stop it, so it is unchanged.", { ok: false, jobId: job!.jobId });
      }
      const res = await deps.jobs().cancel(job!.jobId).catch(() => null);
      threads.touch(tid, job!.jobId, res?.state ? { state: res.state } : {});
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
      const origin = scope.via === "words" || scope.via === "page" ? (conversationId ?? jarvisThreadId(principal.personId)) : undefined;
      result = await runPlain(botTurn, emit, scope.conversationId, scope.bot, origin !== scope.conversationId ? origin : undefined);
    } catch (error) {
      // The run threw: write the reply anyway, so the conversation never holds a request with no answer. If something may have started, say the
      // outcome is not known (it is then never run again); if nothing did, a resend may run it.
      let started = false;
      try {
        started = !!threads!.priorCommand({ personId: principal.personId, bot: scope.bot, commandId })?.mayHaveStarted;
        threads!.note({ personId: principal.personId, bot: scope.bot, commandId, role: "ack", text: started ? "That hit a fault after a job for this bot started, and it may or may not be this one. I can't confirm how it ended, so it will not be run again: check this conversation before asking twice." : "That did not run: the hub hit a fault before it started anything. Sending it again is safe.", ok: false, ...(started ? { unverified: true } : {}), replace: true });
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
        const f = await followUp({ principal, body: { ...body, utterance: "stop that task" } }, conversationId, active, true).catch(() => null);
        if (f) return f;
      }
      const handled = await followUp(input, conversationId, active, !!bot).catch(() => null);
      if (handled) return handled;
    }
    const meta: RunMeta = {};
    const result = await deps.core(input, emit, meta);
    if (!eligible) return result;

    // A bare "stop" that the core found nothing of his own to stop: the jobs left going in his thread are what he means.
    if (result.stopped && !result.jobId && deps.isStop(String(body.utterance ?? "").trim())) {
      const open = active.filter((j) => isOpenState(j.state));
      if (open.length === 1) {
        const f = await followUp({ principal, body: { ...body, utterance: "stop that task" } }, conversationId, active).catch(() => null);
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

  /** The one run: dedupe by event id, then the linked run. */
  return async function run(input: RunInput, emit: (e: CommandStreamEvent) => void = () => undefined): Promise<CommandDoneEvent> {
    const eventId = typeof input.body?.eventId === "string" && EVENT_ID.test(input.body.eventId) ? input.body.eventId : null;
    if (!eventId) return runLinked(input, emit);
    const key = `${input.principal.personId}|${eventId}`;
    const t = now();
    const hit = events.get(key);
    if (hit && t - hit.at <= EVENT_WINDOW_MS) {
      // Review M3: the resend is attached to the first run's stream (its `job` event first), so a Stop on the resend can cancel that job by id.
      let sawDone = false;
      const follow = (e: CommandStreamEvent) => {
        if (e.type === "done") sawDone = true;
        emit(e);
      };
      for (const e of hit.seen) follow(e);
      hit.followers.add(follow);
      try {
        const d = await hit.promise;
        if (!sawDone) emit(d);
        return d;
      } finally {
        hit.followers.delete(follow);
      }
    }
    const seen: CommandStreamEvent[] = [];
    const followers = new Set<(e: CommandStreamEvent) => void>();
    const fanout = (e: CommandStreamEvent) => {
      if (seen.length < 500) seen.push(e);
      emit(e);
      for (const f of [...followers]) try { f(e); } catch { /* a follower never breaks the first run */ }
    };
    const promise = runLinked(input, fanout);
    events.set(key, { at: t, promise, seen, followers });
    if (events.size > EVENT_MAX) for (const [k, v] of events) if (t - v.at > EVENT_WINDOW_MS || events.size > EVENT_MAX) events.delete(k);
    promise.catch(() => events.delete(key));
    return promise;
  };
}

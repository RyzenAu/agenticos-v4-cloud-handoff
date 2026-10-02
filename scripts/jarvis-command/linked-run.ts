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
import type { JobService } from "../jobs/service";
import type { CommandDoneEvent, CommandStreamEvent, PageContext } from "./contracts";
import type { RunInput } from "./service";
import { classifyFollowUp, isOpenState, type ActiveJob } from "./followup";
import type { JobThreads } from "./threads";

export type RunMeta = { pageContext?: PageContext | null };
type Core = (input: RunInput, emit: (e: CommandStreamEvent) => void, meta: RunMeta) => Promise<CommandDoneEvent>;

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
}) {
  const now = deps.now ?? Date.now;
  const events = new Map<string, { at: number; promise: Promise<CommandDoneEvent> }>();

  const done = (said: string, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent => ({ type: "done", ok: true, said, kind: "answer", jobId: null, runId: "", targetDeviceId: null, ...extra });

  async function followUp(input: RunInput, conversationId: string | undefined, active: ActiveJob[]): Promise<CommandDoneEvent | null> {
    const { principal, body } = input;
    const threads = deps.threads!;
    const f = classifyFollowUp(String(body.utterance ?? ""), active, now());
    if (f.kind === "none") return null;
    const job = f.kind === "ask" ? null : active.find((j) => j.jobId === f.jobId)!;
    const tid = job?.conversationId ?? (await threadIdFor(principal.personId, conversationId)) ?? "";
    if (f.kind === "ask") return done(f.question, { ok: false, kind: "ask", ask: true, numbers: { options: f.options } });
    if (f.kind === "status") {
      const s = await threads.status(tid, job!.jobId, job!.kind);
      return s ? done(s.said, { jobId: job!.jobId, numbers: { jobId: job!.jobId, state: s.state }, verified: true }) : done("I can't read that job any more, so I won't guess its state.", { ok: false, jobId: job!.jobId });
    }
    if (f.kind === "cancel") {
      if (job!.kind === "coding") {
        const r = await deps.coding?.("stop the coding job", { personId: principal.personId, actor: principal.actor === "human" ? "human" : "process", via: principal.via === "loopback-owner" ? "local" : "tailnet", spokenYes: null }).catch(() => null);
        threads.touch(tid, job!.jobId);
        return r ? done(r.say, { jobId: job!.jobId, stopped: true }) : done("I couldn't reach the coding harness to stop it, so it is unchanged.", { ok: false, jobId: job!.jobId });
      }
      const res = await deps.jobs().cancel(job!.jobId).catch(() => null);
      threads.touch(tid, job!.jobId, res?.state ? { state: res.state } : {});
      return res?.ok ? done("Stopped it. Nothing further will run.", { jobId: job!.jobId, stopped: true, numbers: { jobId: job!.jobId, state: res.state } }) : done("I couldn't confirm that stopped, so check the job view before trusting it.", { ok: false, jobId: job!.jobId, numbers: { jobId: job!.jobId } });
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

  async function runLinked(input: RunInput, emit: (e: CommandStreamEvent) => void): Promise<CommandDoneEvent> {
    const { principal, body } = input;
    const source = body?.source;
    const conversationId = typeof body?.conversationId === "string" && THREAD_ID.test(body.conversationId) ? body.conversationId : undefined;
    const threads = deps.threads;
    if (principal.via === "loopback-owner") threads?.noteLocal(principal.personId);
    const eligible = !!threads && source !== "acceptance" && source !== "away" && !body?.steps?.length;
    let active: ActiveJob[] = [];
    if (eligible) {
      active = await threads!.active(principal.personId, conversationId).catch(() => []);
      const handled = await followUp(input, conversationId, active).catch(() => null);
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
        if (f) return f;
      }
      if (open.length > 1) return done(`Which one to stop: ${open.slice(0, 3).map((j) => `"${cut(j.title, 36)}"`).join(" or ")}?`, { ok: false, kind: "ask", ask: true });
    }

    // Link what the command left going.
    const codingJobId = (result.numbers as { codingJobId?: string } | undefined)?.codingJobId;
    const codingState = (result.numbers as { codingJobState?: string } | undefined)?.codingJobState;
    const target = codingJobId ? { id: codingJobId, kind: "coding" as const } : result.jobId ? { id: result.jobId, kind: "job" as const } : null;
    if (!target || !result.ok && result.stopped) return result;
    if (target.kind === "coding" && (!codingState || /^(?:draft|awaiting_confirmation)$/.test(codingState) || !isOpenState(codingState))) return result;
    const state = target.kind === "job" ? deps.jobs().get(target.id)?.state : codingState;
    if (!state || !isOpenState(state)) return result;
    // A job this command just created is "started"; one it only brought up ("show me the research computer") is "following".
    const createdAt = target.kind === "job" ? Date.parse(deps.jobs().get(target.id)?.createdAt ?? "") : Date.now();
    const attached = target.kind === "job" && !(Date.now() - createdAt < 20_000);
    const linked = await threads!.link({ personId: principal.personId, ...(conversationId ? { conversationId } : {}), jobId: target.id, kind: target.kind, attached, title: target.kind === "job" ? (deps.jobs().get(target.id)?.title ?? "") : cut(String(body.utterance ?? ""), 60) }).catch(() => null);
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
      const d = await hit.promise;
      emit(d);
      return d;
    }
    const promise = runLinked(input, emit);
    events.set(key, { at: t, promise });
    if (events.size > EVENT_MAX) for (const [k, v] of events) if (t - v.at > EVENT_WINDOW_MS || events.size > EVENT_MAX) events.delete(k);
    promise.catch(() => events.delete(key));
    return promise;
  };
}

/**
 * The ONE client entry for Jarvis commands (NEXUS-ADDENDUM §1-2, V6 §5). Typed (the palette) and
 * spoken (the voice tool `jarvis_command`) commands both go through `runJarvisCommand` to the one
 * server entry, carrying the current page context:
 *
 *   POST /__operator/screen/command            CommandBody → NDJSON CommandStreamEvent lines, last "done"
 *   GET  /__operator/screen/command/attach?job=<id>&since=<seq>   re-attach after a dropped stream
 *   POST /__operator/screen/command/cancel     { jobId }  (stop through the job service)
 *
 * A dropped stream (network error, or the body ending without "done") is NOT a stop: the server keeps
 * the job for RECONNECT_GRACE_MS, and this client re-attaches from the last event it saw. A stop from
 * the caller (his "stop", talking over Jarvis, the pill's Stop) cancels the job once and resolves with
 * a stopped done. This function never throws for transport failures: it resolves with a done that
 * says plainly nothing is confirmed.
 */
import {
  RECONNECT_GRACE_MS,
  type CommandBody,
  type CommandDoneEvent,
  type CommandSource,
  type CommandStreamEvent,
  type PageContext,
} from "../../scripts/jarvis-command/contracts";
import { buildCommandIndex, planCommand, resolveCommand } from "./commands/registry";
import { ruleAnswerIntent } from "./jarvis-intents";
import type { CommandAnswer, CommandIndex, Resolution } from "./commands/types";
import { readPageContext, type PageContextSnapshot } from "./page-context";

// ---- page context ------------------------------------------------------------------------------

/**
 * The page context on the wire: Track 1's snapshot (src/lib/page-context.ts) as-is, or our contract's
 * PageContext (the server's parser accepts both shapes).
 */
export type WirePageContext = PageContext | PageContextSnapshot;
/** CommandBody with the page context widened to Track 1's snapshot shape. */
export type WireCommandBody = Omit<CommandBody, "pageContext"> & { pageContext?: WirePageContext };

export const PAGE_CONTEXT_BOUNDS = { visible: 20, sources: 8 } as const;

/** The current route, for a snapshot whose page the shell hasn't set yet. */
function currentRoute(): string {
  try {
    const path = (globalThis as { window?: { location?: { pathname?: unknown } } }).window?.location?.pathname;
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
}

/** Bound a Track 1 snapshot for the wire: ≤20 visible items, ≤8 sources, the route as page fallback. */
export function boundPageContext(snapshot: PageContextSnapshot | null, route = currentRoute()): PageContextSnapshot | null {
  if (!snapshot) return null;
  const page = snapshot.page ?? (route ? { path: route, destination: null, title: "" } : null);
  if (!page) return null;
  return {
    ...snapshot,
    page,
    visible: snapshot.visible.slice(0, PAGE_CONTEXT_BOUNDS.visible),
    sources: snapshot.sources.slice(0, PAGE_CONTEXT_BOUNDS.sources),
  };
}

/** What is on the page right now (Track 1's one page-context API), bounded; null with no page at all. */
export function commandPageContext(): PageContextSnapshot | null {
  try {
    return boundPageContext(readPageContext());
  } catch {
    return null;
  }
}

// ---- transport ----------------------------------------------------------------------------------

/** POST to an /__operator path (the path excludes the /__operator prefix). */
export type CommandPost = (path: string, body: unknown, signal: AbortSignal) => Promise<Response>;
/** GET an /__operator path. */
export type CommandGet = (path: string, signal: AbortSignal) => Promise<Response>;

export const COMMAND_PATH = "/screen/command";
export const ATTACH_PATH = "/screen/command/attach";
export const CANCEL_PATH = "/screen/command/cancel";

// The page token is fixed for a server run; a 403 refreshes it once (e.g. after a dev-server restart).
let tokenPromise: Promise<string> | null = null;
function osToken(fresh: boolean): Promise<string> {
  if (fresh || !tokenPromise)
    tokenPromise = fetch("/__token")
      .then(async (r) => String(((await r.json()) as { token?: unknown }).token ?? ""))
      .catch((error) => {
        tokenPromise = null;
        throw error;
      });
  return tokenPromise;
}
async function withToken(send: (token: string) => Promise<Response>) {
  const response = await send(await osToken(false));
  return response.status === 403 ? send(await osToken(true)) : response;
}

export const defaultCommandPost: CommandPost = (path, body, signal) =>
  withToken((token) =>
    fetch(`/__operator${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
      body: JSON.stringify(body),
      signal,
    }),
  );

export const defaultCommandGet: CommandGet = (path, signal) =>
  withToken((token) => fetch(`/__operator${path}`, { headers: { "X-Claude-OS-Token": token }, signal }));

// ---- pure parsing helpers -----------------------------------------------------------------------

/** An incremental NDJSON parser: feed text chunks, get the parsed values of every complete line. */
export function createNdjsonParser() {
  let buffer = "";
  const parseLine = (line: string, out: unknown[]) => {
    const text = line.trim();
    if (!text) return;
    try {
      out.push(JSON.parse(text));
    } catch {
      /* A malformed line is skipped, never fatal. */
    }
  };
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const out: unknown[] = [];
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        parseLine(buffer.slice(0, nl), out);
        buffer = buffer.slice(nl + 1);
      }
      return out;
    },
    /** The last line when the stream ended without a trailing newline. */
    flush(): unknown[] {
      const out: unknown[] = [];
      parseLine(buffer, out);
      buffer = "";
      return out;
    },
  };
}

/** Parse a whole NDJSON text at once (tests, small bodies). */
export function parseNdjson(text: string): unknown[] {
  const parser = createNdjsonParser();
  return [...parser.push(text), ...parser.flush()];
}

const COMMAND_KINDS = new Set(["screen", "browser", "app", "file", "answer", "navigate", "handoff", "refused", "ask", "unavailable", "remote"]);

/** Structural check of one wire event; null for anything that isn't a CommandStreamEvent. */
export function parseCommandEvent(value: unknown): CommandStreamEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const seqOk = v.seq === undefined || (typeof v.seq === "number" && Number.isFinite(v.seq));
  if (!seqOk) return null;
  switch (v.type) {
    case "job":
      return typeof v.jobId === "string" && v.jobId && typeof v.targetDeviceId === "string" && typeof v.seq === "number" ? (v as CommandStreamEvent) : null;
    case "decision":
      return v.decision && typeof v.decision === "object" && typeof v.seq === "number" ? (v as CommandStreamEvent) : null;
    case "narrate":
      return typeof v.text === "string" && typeof v.stage === "string" ? (v as CommandStreamEvent) : null;
    case "step":
      return v as CommandStreamEvent;
    case "slow":
      return typeof v.said === "string" ? (v as CommandStreamEvent) : null;
    case "done":
      if (typeof v.ok !== "boolean" || typeof v.said !== "string") return null;
      return {
        ...(v as CommandDoneEvent),
        kind: typeof v.kind === "string" && COMMAND_KINDS.has(v.kind) ? (v.kind as CommandDoneEvent["kind"]) : "unavailable",
        jobId: typeof v.jobId === "string" ? v.jobId : null,
        runId: typeof v.runId === "string" ? v.runId : "",
        targetDeviceId: typeof v.targetDeviceId === "string" ? v.targetDeviceId : null,
      };
    default:
      return null;
  }
}

/** The attach path for a reconnect: the job's events after `since`. */
export function attachPath(jobId: string, since: number) {
  return `${ATTACH_PATH}?job=${encodeURIComponent(jobId)}&since=${Math.max(-1, Math.floor(since))}`;
}

/** A done this client makes itself (a transport failure or a stop): never claims success. */
export function clientDone(said: string, jobId: string | null, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent {
  return { type: "done", ok: false, said, kind: "unavailable", jobId, runId: "", targetDeviceId: null, verified: null, ...extra };
}

/**
 * The tool-result string for the voice model. The server's follow-up rule speaks `said` as-is when
 * the result is `{"type":"command_result", ...}`; the rest tells the model what happened.
 */
export function commandResultText(done: CommandDoneEvent): string {
  return JSON.stringify({
    type: "command_result",
    ok: done.ok,
    said: String(done.said ?? "").slice(0, 1200),
    kind: done.kind,
    jobId: done.jobId,
    ask: done.ask,
    stopped: done.stopped,
    outcome: done.outcome,
    verified: done.verified,
    confirm: done.confirm,
    resumeGoal: done.resumeGoal,
    refused: done.refused,
    navigate: done.navigate?.path,
    url: done.url,
    handoff: done.handoff ? { to: done.handoff.to, intent: done.handoff.intent, reason: done.handoff.reason, ...(done.handoff.utterance ? { brief: done.handoff.utterance.slice(0, 1200) } : {}) } : undefined,
    targetDeviceId: done.targetDeviceId,
  });
}

// ---- the command --------------------------------------------------------------------------------

export type RunJarvisCommandOptions = {
  utterance: string;
  source: Extract<CommandSource, "voice" | "typed">;
  spokenTarget?: string;
  /** Omitted: `commandPageContext()` (Track 1's snapshot). null: send none. */
  pageContext?: WirePageContext | null;
  /** The voice pipeline's spoken-yes event id for this utterance, when there is one. */
  spokenYes?: string | null;
  /**
   * This event's id: stable for the same utterance across a replay (voice reconnect, early + final call), so the server runs it once.
   * Omitted: one is minted per call, which still stops a double post of the same call from running twice.
   */
  eventId?: string;
  /** The person's Jarvis conversation (a saved voice transcript's id), when the client has one; else the server's default thread. */
  conversationId?: string;
  /** The caller's stop (his "stop", talking over, the pill's Stop): cancels the job once. */
  signal?: AbortSignal;
  post?: CommandPost;
  get?: CommandGet;
  /** Every wire event, in order (the done too). Errors thrown here are ignored. */
  onEvent?: (event: CommandStreamEvent) => void;
  /** Reconnect tuning (tests). graceMs defaults to RECONNECT_GRACE_MS. */
  reconnect?: { graceMs?: number; delaysMs?: number[]; maxAttaches?: number };
  /** How long a stop waits for the job id before giving up on the stream (ms). */
  stopWaitMs?: number;
};

const DEFAULT_DELAYS = [0, 250, 500, 1000, 2000, 3000];
const CANCEL_WAIT_MS = 3000;

class StreamEnded extends Error {}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function readError(response: Response): Promise<{ done?: CommandDoneEvent; message: string }> {
  const text = await response.text().catch(() => "");
  for (const value of parseNdjson(text)) {
    const event = parseCommandEvent(value);
    if (event?.type === "done") return { done: event, message: event.said };
  }
  try {
    const data = JSON.parse(text) as { said?: string; error?: string };
    return { message: data.said || data.error || `status ${response.status}` };
  } catch {
    return { message: `status ${response.status}` };
  }
}

/** Cancel a running command job through the job service. Resolves true when the server accepted it. */
export async function cancelJarvisCommand(jobId: string, opts: { post?: CommandPost; signal?: AbortSignal } = {}): Promise<boolean> {
  const post = opts.post ?? defaultCommandPost;
  try {
    const response = await post(CANCEL_PATH, { jobId }, opts.signal ?? AbortSignal.timeout(CANCEL_WAIT_MS));
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Run one typed or spoken command through the one server entry. Resolves with the job's done event,
 * a stopped done after the caller's abort, or a client-made failure done when the transport failed.
 */
export async function runJarvisCommand(opts: RunJarvisCommandOptions): Promise<CommandDoneEvent> {
  // A command may start a job: the idle job-event poll wakes up for the next minute.
  // Best effort only: a DOM that can't dispatch it (a test DOM, an old WebView) must never stop the command itself.
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("jobs:nudge"));
  } catch {
    /* the poll simply wakes on its own schedule */
  }
  const post = opts.post ?? defaultCommandPost;
  const get = opts.get ?? defaultCommandGet;
  const graceMs = opts.reconnect?.graceMs ?? RECONNECT_GRACE_MS;
  const delays = opts.reconnect?.delaysMs ?? DEFAULT_DELAYS;
  const maxAttaches = opts.reconnect?.maxAttaches ?? 12;
  const stopWaitMs = opts.stopWaitMs ?? 2000;

  const utterance = String(opts.utterance ?? "").trim().slice(0, 2000);
  if (opts.signal?.aborted) return clientDone("Stopped.", null, { stopped: true });
  if (!utterance) return clientDone("What should I do?", null, { kind: "ask", ask: true });

  const pageContext = opts.pageContext === undefined ? commandPageContext() : opts.pageContext;
  const body: WireCommandBody = {
    utterance,
    source: opts.source,
    ...(opts.spokenTarget ? { spokenTarget: opts.spokenTarget.slice(0, 80) } : {}),
    ...(pageContext ? { pageContext } : {}),
    ...(opts.spokenYes ? { spokenYes: opts.spokenYes } : {}),
    eventId: /^[\w:.-]{6,80}$/.test(opts.eventId ?? "") ? opts.eventId! : `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
  };

  // One controller for every request of this run: aborting it ends the run (a stop).
  const wire = new AbortController();
  let jobId = null as string | null;
  let targetDeviceId = null as string | null;
  let lastSeq = -1;
  let result = null as CommandDoneEvent | null;
  let stopRequested = false;
  let cancelSent = null as Promise<boolean> | null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  const sendCancel = () => {
    if (!cancelSent && jobId) cancelSent = cancelJarvisCommand(jobId, { post });
  };
  const onStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (jobId) {
      sendCancel();
      wire.abort();
    } else {
      // No job id yet: keep reading briefly so the job can still be cancelled by id, then give up.
      stopTimer = setTimeout(() => wire.abort(), stopWaitMs);
    }
  };
  opts.signal?.addEventListener("abort", onStop, { once: true });

  const emit = (event: CommandStreamEvent) => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* A listener's failure never breaks the command. */
    }
  };

  /** Returns true when the run is finished (done seen). */
  const handle = (event: CommandStreamEvent): boolean => {
    if (event.type !== "done" && typeof event.seq === "number") {
      if (event.seq <= lastSeq) return false; // Already seen before a reconnect.
      lastSeq = event.seq;
    }
    if (event.type === "job") {
      jobId = event.jobId;
      targetDeviceId = event.targetDeviceId;
      if (stopRequested) {
        sendCancel();
        emit(event);
        wire.abort();
        return false;
      }
    }
    emit(event);
    if (event.type === "done") {
      result = { ...event, jobId: event.jobId ?? jobId, targetDeviceId: event.targetDeviceId ?? targetDeviceId };
      return true;
    }
    return false;
  };

  /** Read one NDJSON response to its end. Resolves when done was seen; throws StreamEnded otherwise. */
  const consume = async (response: Response) => {
    if (!response.body) throw new StreamEnded("no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createNdjsonParser();
    const feed = (values: unknown[]) => {
      for (const value of values) {
        const event = parseCommandEvent(value);
        if (event && handle(event)) return true;
      }
      return false;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (feed([...parser.push(decoder.decode()), ...parser.flush()])) return;
          throw new StreamEnded("ended without done");
        }
        if (feed(parser.push(decoder.decode(value, { stream: true })))) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  };

  const finishStopped = async () => {
    if (jobId) sendCancel();
    if (cancelSent) await Promise.race([cancelSent, new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))]);
    return clientDone("Stopped.", jobId, { stopped: true, targetDeviceId });
  };

  try {
    // 1. The command itself.
    let response: Response;
    try {
      response = await post(COMMAND_PATH, body, wire.signal);
    } catch (error) {
      if (stopRequested) return await finishStopped();
      return clientDone(`Not done: I couldn't reach the command service (${(error as Error).message || "network error"}).`, null);
    }
    if (!response.ok) {
      const { done, message } = await readError(response);
      if (done) {
        emit(done);
        return done;
      }
      return clientDone(`Not done: ${message}`.slice(0, 300), null);
    }
    try {
      await consume(response);
      if (result) return result;
    } catch {
      if (stopRequested) return await finishStopped();
      // A dropped stream: fall through to re-attach.
    }
    if (result) return result;
    if (stopRequested) return await finishStopped();

    // 2. Re-attach after a dropped stream, within the server's grace window.
    if (!jobId) return clientDone("The command connection dropped before the job started. Nothing is confirmed as done.", null, { outcome: "unverified" });
    let attaches = 0;
    let dropAt = Date.now();
    let attempt = 0;
    while (attaches < maxAttaches) {
      if (stopRequested) return await finishStopped();
      if (Date.now() - dropAt > graceMs) break;
      await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1000, wire.signal);
      if (stopRequested) return await finishStopped();
      attempt++;
      attaches++;
      let attach: Response;
      try {
        attach = await get(attachPath(jobId, lastSeq), wire.signal);
      } catch {
        if (stopRequested) return await finishStopped();
        continue; // Still offline: try again within the window.
      }
      if (attach.status === 404 || attach.status === 410) {
        const { done } = await readError(attach);
        if (done) {
          emit(done);
          return done;
        }
        return clientDone("I lost track of that job: the server no longer has it. Nothing is confirmed as done.", jobId, { outcome: "unverified", targetDeviceId });
      }
      if (!attach.ok) {
        await attach.body?.cancel().catch(() => undefined);
        continue;
      }
      const seqBefore = lastSeq;
      try {
        await consume(attach);
        if (result) return result;
      } catch {
        if (stopRequested) return await finishStopped();
      }
      if (result) return result;
      // Re-attached and made progress before dropping again: a fresh grace window, fresh backoff.
      if (lastSeq > seqBefore) {
        dropAt = Date.now();
        attempt = 0;
      }
    }
    return clientDone("I lost the connection to that job and couldn't get it back. It may still be running; nothing is confirmed as done.", jobId, {
      outcome: "unverified",
      targetDeviceId,
    });
  } finally {
    opts.signal?.removeEventListener("abort", onStop);
    if (stopTimer) clearTimeout(stopTimer);
  }
}

/**
 * The typed entry for Track 1's palette: the same function, the same server entry and the same page
 * context as a spoken command. The palette UI itself is Track 1's.
 */
export function runTypedCommand(utterance: string, opts: Omit<RunJarvisCommandOptions, "utterance" | "source" | "spokenYes"> = {}) {
  return runJarvisCommand({ ...opts, utterance, source: "typed" });
}

// ---- voice: resolve locally first (Track 1's ONE resolver), else the server entry -------------------

/**
 * What the voice `jarvis_command` tool does with Track 1's resolution:
 *   navigate  a resolved OS page, section or answer: open it here (no job, nothing on a device)
 *   open-url  a resolved website: the existing open_url path
 *   ask       ambiguous: say the resolver's question, act on nothing
 *   server    a resolved device plan, or unresolved: the one server entry (runJarvisCommand), which
 *             handles apps, files, YouTube, PowerPoint, contextual references and device routing
 */
export type VoiceRoute =
  | { route: "navigate"; entryId: string; title: string; to: string; search?: Record<string, string>; focus?: string; href: string; answer?: CommandAnswer; said: string }
  | { route: "open-url"; entryId: string; title: string; url: string }
  | { route: "ask"; said: string }
  | { route: "server"; why: "device" | "unresolved"; spokenTarget?: string };

/** An OS path with its search params ("/leads?lead=3"). */
export function planHref(to: string, search?: Record<string, string>) {
  const query = search && Object.keys(search).length ? `?${new URLSearchParams(search).toString()}` : "";
  return `${to}${query}`;
}

/** The spoken line for a page opened by voice: the answer's figure first (with its caveat), then where. */
export function navigateSaid(title: string, answer?: CommandAnswer) {
  if (!answer) return `Opened ${title}.`;
  const caveat = answer.caveat ? ` ${answer.caveat}` : answer.state !== "live" ? ` (${answer.state} figures)` : "";
  return `${answer.headline}.${caveat} Opened ${title}.`.replace(/\.\./g, ".");
}

/** Pure: Track 1's Resolution → what the voice tool does. */
export function routeVoiceCommand(resolution: Resolution): VoiceRoute {
  const spokenTarget = resolution.parsed.spokenTarget;
  if (resolution.status === "ambiguous") return { route: "ask", said: resolution.ask };
  if (resolution.status === "unresolved") return { route: "server", why: "unresolved", ...(spokenTarget ? { spokenTarget } : {}) };
  const plan = planCommand(resolution.entry, resolution.parsed);
  if (plan.kind === "navigate")
    return {
      route: "navigate",
      entryId: plan.entryId,
      title: resolution.entry.title,
      to: plan.to,
      ...(plan.search ? { search: plan.search } : {}),
      ...(plan.focus ? { focus: plan.focus } : {}),
      href: planHref(plan.to, plan.search),
      ...(plan.answer ? { answer: plan.answer } : {}),
      said: navigateSaid(resolution.entry.title, plan.answer),
    };
  if (plan.kind === "open-url") return { route: "open-url", entryId: plan.entryId, title: resolution.entry.title, url: plan.url };
  return { route: "server", why: "device", ...(plan.request.spokenTarget ? { spokenTarget: plan.request.spokenTarget } : spokenTarget ? { spokenTarget } : {}) };
}

let staticIndex: CommandIndex | null = null;
/**
 * The voice command's route: words Jarvis answers by its rules (memory, finance, receptionist, leads,
 * reminders, prices, margins) go straight to the server entry, the same service a typed command reaches;
 * everything else through Track 1's resolver first. Pure apart from the static index.
 */
export function voiceRouteFor(utterance: string, context: PageContextSnapshot | null): VoiceRoute {
  if (ruleAnswerIntent(utterance)) return { route: "server", why: "unresolved" };
  return routeVoiceCommand(resolveCommand(utterance, voiceCommandIndex(), { channel: "voice", context }));
}

/** The static command index (pages, sections, answers), built once. Dynamic sources stay with the palette. */
export function voiceCommandIndex(): CommandIndex {
  return (staticIndex ??= buildCommandIndex());
}

/** A done for something the client finished itself (a page it opened, a question it asks). */
export function localDone(said: string, extra: Partial<CommandDoneEvent> = {}): CommandDoneEvent {
  return { type: "done", ok: true, said, kind: "answer", jobId: null, runId: "", targetDeviceId: null, ...extra };
}

/** An OS-internal path ("/leads?lead=3"): one leading "/", no scheme, host, whitespace or backslash. */
export function isOsPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && /^\/(?![/\\])[^\s\\]*$/.test(value);
}

// The brain's delegate_task / run_workflow open Track 3's coding draft (never an immediate agent job).
// The helper lives with the coding detector so the server's /agent-jobs route uses the same one (T3c).
export { codingDraftHref } from "./commands/coding";

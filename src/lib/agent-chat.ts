/**
 * The ONE client module for a bot's conversation (Agents workspace, builder B2). Everything BotChat reads or sends goes through here, so when the
 * backend routes land the lead changes one file, not the component:
 *
 *   GET  /__agents/bots/<id>/thread?after=<seq>   -> { conversationId, entries }   the bot's conversation entries (catch-up after a gap)
 *   POST /__operator/screen/command               the existing Jarvis command, carrying { conversationId, target: { bot } }   (typed and spoken)
 *   POST /__operator/screen/command/cancel        stop one job through the job service
 *
 * Live entries arrive on the shared `/__events` stream (topic "thread"); `src/lib/thread-events.ts` parses and folds them. Nothing here speaks,
 * starts a job on its own, or retries on its own: it carries what the person typed or said, once.
 */
import type { CommandDoneEvent } from "../../scripts/jarvis-command/contracts";
import type { ThreadBlockerKind } from "../../scripts/conversations";
import { codingClient } from "./coding-client";
import { cancelJarvisCommand, runJarvisCommand, type CommandPost, type RunJarvisCommandOptions } from "./jarvis-command";

/** What a server entry may say about why it needs the person, beyond its state (optional: the state alone is enough to show an action). */
export type BlockerHint = {
  /** The server's own kinds (one shared type, scripts/conversations.ts). An unknown kind is tolerated: the job's state decides then. */
  kind?: ThreadBlockerKind | (string & {});
  approvalId?: string;
  /** One plain sentence: what to do next. Shown as-is when present. */
  recovery?: string;
  /** A takeover: the reader holds the controls ("you"), or somebody else does ("other"). */
  held?: "you" | "other";
};

/** One server entry of the bot conversation (the existing ThreadEntry, plus optional fields the bot backend may add). */
export type BotThreadEntry = {
  seq: number;
  key: string;
  at: string;
  jobId: string;
  state: string;
  text: string;
  jobKind?: "job" | "coding";
  blocker?: BlockerHint;
  /** An acknowledgement entry: the hub's own verdict (false: nothing started). Absent on older entries; the browser's own value is used then. */
  ok?: boolean;
  /** An acknowledgement entry: the command failed after it may have started something, so its outcome is not known. Never retried as new. */
  unverified?: boolean;
};
export type BotThread = { conversationId: string; entries: BotThreadEntry[] };

/** Deterministic conversation id of a person with a bot (the server derives the same string). */
export const agentConversationId = (personId: string, botId: string) => `agent:${personId}:${botId}`;

/** The slice of a command result BotChat needs. */
export type BotSendResult = Pick<CommandDoneEvent, "ok" | "said" | "jobId"> & {
  stopped?: boolean;
  /** This browser could not learn how the command ended (a timeout, a dropped link): the hub may have accepted it. Never "did not start". */
  unconfirmed?: boolean;
};

export type BotSendInput = {
  botId: string;
  conversationId: string;
  utterance: string;
  source: "typed" | "voice";
  /** One id per utterance: a double click or a replay is the same command, so it runs once. */
  eventId: string;
  signal?: AbortSignal;
};

/** Everything BotChat needs from the outside. The real one is `agentChatApi`; tests and the fixture pass a fake. */
export type AgentChatApi = {
  fetchThread(botId: string, after: number, signal?: AbortSignal): Promise<BotThread>;
  send(input: BotSendInput): Promise<BotSendResult>;
  /** Stop one job: a coding job through the coding store, anything else through the job service. Never throws; a refusal carries its reason. */
  cancel(jobId: string, jobKind?: "job" | "coding"): Promise<boolean | CancelResult>;
};
export type CancelResult = { ok: boolean; reason?: string };

/** The exact options `runJarvisCommand` is called with for a bot: the conversation id and the bot target ride on every request. */
export function botCommandOptions(input: BotSendInput, extra: Pick<RunJarvisCommandOptions, "post" | "get" | "pageContext" | "reconnect"> = {}): RunJarvisCommandOptions {
  return {
    utterance: input.utterance,
    source: input.source,
    conversationId: input.conversationId,
    target: { bot: input.botId },
    eventId: input.eventId,
    ...(input.signal ? { signal: input.signal } : {}),
    ...extra,
  };
}

export const THREAD_PATH = (botId: string, after: number) => `/__agents/bots/${encodeURIComponent(botId)}/thread?after=${Math.max(0, Math.floor(after) || 0)}`;

function cleanEntry(raw: unknown): BotThreadEntry | null {
  const e = raw as Partial<BotThreadEntry> | null;
  if (!e || typeof e.key !== "string" || typeof e.text !== "string" || typeof e.seq !== "number") return null;
  return {
    seq: e.seq,
    key: e.key,
    at: String(e.at ?? ""),
    jobId: typeof e.jobId === "string" ? e.jobId : "",
    state: typeof e.state === "string" ? e.state : "",
    text: e.text,
    ...(e.jobKind === "coding" || e.jobKind === "job" ? { jobKind: e.jobKind } : {}),
    ...(e.blocker && typeof e.blocker === "object" ? { blocker: e.blocker } : {}),
    ...(typeof e.ok === "boolean" ? { ok: e.ok } : {}),
    ...(e.unverified === true ? { unverified: true } : {}),
  };
}

/** Parse a thread response; anything malformed is dropped, never thrown into the transcript. */
export function parseThread(body: unknown): BotThread | null {
  const b = body as { conversationId?: unknown; entries?: unknown } | null;
  if (!b || typeof b.conversationId !== "string" || !Array.isArray(b.entries)) return null;
  return { conversationId: b.conversationId, entries: b.entries.map(cleanEntry).filter((e): e is BotThreadEntry => !!e) };
}

/** Marks a read the hub refused (403): retrying will not help until the person pairs this browser. */
export const NOT_ALLOWED_PREFIX = "Not allowed: ";

/**
 * Which boundary a failed thread read broke. Each has its own cause and next action, so the page never says a vague "unavailable":
 *   not-paired  the hub refused this browser (401/403, with its own sentence): pair it; retrying cannot help
 *   not-found   no such bot (404): the bot was removed or the link is old; retrying cannot help
 *   store       the hub could not read its saved conversations (503): the hub's own sentence; retry a few times, then restart the hub
 *   server      the hub hit an error reading it (other 5xx): retry a few times
 *   network     this browser could not reach the hub at all: check the connection, then retry
 *   timeout     the hub did not answer in time: retry
 *   shape       the hub answered with something unreadable: retry, then report it
 */
export type ThreadReadKind = "not-paired" | "not-found" | "store" | "server" | "network" | "timeout" | "shape";
export class ThreadReadError extends Error {
  readonly kind: ThreadReadKind;
  readonly status: number | null;
  constructor(kind: ThreadReadKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ThreadReadError";
    this.kind = kind;
    this.status = status;
  }
  /** A retry can succeed without anyone doing anything else. */
  get retryable(): boolean {
    return this.kind !== "not-paired" && this.kind !== "not-found";
  }
}
/** The next move the person can make, in one sentence, for each kind. */
export const READ_ACTION: Record<ThreadReadKind, string> = {
  "not-paired": "Pair this browser in System, then Devices and people, and this conversation opens.",
  "not-found": "This bot is no longer here. Pick another bot from the list.",
  store: "Try again. If it keeps failing, the hub's saved conversations need attention: restart the hub, and nothing is lost.",
  server: "Try again in a moment.",
  network: "Check this browser's connection to the hub (and Tailscale), then try again.",
  timeout: "The hub is slow to answer. Try again.",
  shape: "Try again. If it keeps failing, reload the page.",
};
/** How long one thread read may take before it counts as the hub not answering. */
export const THREAD_TIMEOUT_MS = 15_000;

/** The hub's own sentence from a JSON error body, or "". */
const hubSentence = (response: Response) => response.json().then((j) => (typeof j?.error === "string" && j.error !== "Something went wrong." ? j.error : ""), () => "");

export function classifyThreadFailure(status: number, said: string): ThreadReadError {
  if (status === 401 || status === 403) return new ThreadReadError("not-paired", `${NOT_ALLOWED_PREFIX}${said || "This browser can't read this conversation. Pair it in System › Devices and people."}`, status);
  if (status === 404) return new ThreadReadError("not-found", said || "There is no such bot.", status);
  if (status === 503) return new ThreadReadError("store", said || "The hub could not read its saved conversations. Your history was left untouched.", status);
  return new ThreadReadError("server", `The hub hit an error reading the conversation (status ${status}).${said ? ` ${said}` : ""}`, status);
}

export function createAgentChatApi(options: { timeoutMs?: number } = {}): AgentChatApi {
  const timeoutMs = options.timeoutMs ?? THREAD_TIMEOUT_MS;
  return {
  async fetchThread(botId, after, signal) {
    // One timeout for the whole read (headers and body): a hub that accepts the connection and then says nothing must not leave the page
    // "loading" forever, and a caller's own abort still wins.
    const wire = new AbortController();
    const timer = setTimeout(() => wire.abort(), timeoutMs);
    const onAbort = () => wire.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(THREAD_PATH(botId, after), { signal: wire.signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw wire.signal.aborted ? new ThreadReadError("timeout", `The hub did not answer in ${Math.round(timeoutMs / 1000)} seconds.`) : new ThreadReadError("network", "This browser could not reach the hub.");
      }
      if (!response.ok) throw classifyThreadFailure(response.status, await hubSentence(response));
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw wire.signal.aborted ? new ThreadReadError("timeout", `The hub did not answer in ${Math.round(timeoutMs / 1000)} seconds.`) : new ThreadReadError("shape", "The conversation came back in a shape I can't read.");
      }
      const thread = parseThread(body);
      if (!thread) throw new ThreadReadError("shape", "The conversation came back in a shape I can't read.");
      return thread;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  },
  async send(input) {
    const done = await runJarvisCommand(botCommandOptions(input));
    return { ok: done.ok, said: done.said, jobId: done.jobId, ...(done.stopped ? { stopped: true } : {}), ...(!done.ok && done.outcome === "unverified" ? { unconfirmed: true } : {}) };
  },
  async cancel(jobId, jobKind) {
    if (jobKind === "coding") {
      try {
        await codingClient.cancel(jobId);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message ? error.message : "The coding job did not accept the stop." };
      }
    }
    return (await cancelJarvisCommand(jobId)) ? { ok: true } : { ok: false, reason: "The hub did not accept the stop." };
  },
  };
}
export const agentChatApi: AgentChatApi = createAgentChatApi();

// ---- local persistence ---------------------------------------------------------------------------------------------------------------------
// The person's own requests and the one-line acknowledgements are not server entries, so they are kept here (per conversation) and merged by
// time with the server's entries. Leaving the page and coming back shows the same thread. Every storage call is guarded: private windows throw.

export type StoredItem = { type: "request" | "ack"; key: string; at: number; text: string; jobId?: string; source?: "typed" | "voice"; ok?: boolean; unconfirmed?: boolean };

const LOCAL_MAX = 120;
const localKey = (conversationId: string) => `agent-chat:local:${conversationId}`;
const seenKey = (conversationId: string) => `agent-chat:seen:${conversationId}`;
type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadLocalItems(conversationId: string, store: Store | null = defaultStore()): StoredItem[] {
  try {
    const parsed = JSON.parse(store?.getItem(localKey(conversationId)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((i): i is StoredItem => !!i && (i.type === "request" || i.type === "ack") && typeof i.key === "string" && typeof i.text === "string" && typeof i.at === "number").slice(-LOCAL_MAX)
      : [];
  } catch {
    return [];
  }
}
export function saveLocalItems(conversationId: string, items: StoredItem[], store: Store | null = defaultStore()) {
  try {
    store?.setItem(localKey(conversationId), JSON.stringify(items.slice(-LOCAL_MAX)));
  } catch {
    /* storage unavailable: the thread still works for this visit */
  }
}
/** Entry keys the person has already been told about (a completion is announced once, ever, for this browser). */
export function loadSeen(conversationId: string, store: Store | null = defaultStore()): Set<string> {
  try {
    const parsed = JSON.parse(store?.getItem(seenKey(conversationId)) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}
export function saveSeen(conversationId: string, seen: Set<string>, store: Store | null = defaultStore()) {
  try {
    store?.setItem(seenKey(conversationId), JSON.stringify([...seen].slice(-400)));
  } catch {
    /* as above */
  }
}

export type { CommandPost };

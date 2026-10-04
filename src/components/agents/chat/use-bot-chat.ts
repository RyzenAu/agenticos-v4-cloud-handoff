// The live side of one bot conversation: load, fold live events, catch up, send. React glue over chat-state.ts; the rules live there.
//
// Continuity, in this order of trust:
//   1. the server's thread (`api.fetchThread`) is the truth for job entries; the person's own lines are kept on this device;
//   2. live entries from the shared /__events stream are folded by key, so a live event and a catch-up that overlap never double a line;
//   3. any gap (stream reconnect, a hub restart = a fresh snapshot, the tab coming back, a slow safety poll while the stream is down) is
//      closed with a catch-up from the last seq seen (from 0 after a snapshot, because a restarted hub may have renumbered).
// Nothing here speaks. A completion is announced once per job, ever, per browser (the seen set is persisted), and never for history: "history" is
// whatever the FIRST successful read of the thread returns, even when that read is not the first attempt (a hub that was down at load).
//
// When a read fails the page says which boundary broke (not paired, the hub's store, the hub, the network, a timeout: see agent-chat.ts) and what
// to do. Retries are bounded: a few automatic ones with backoff for causes that can clear on their own, none for "pair this browser", then a
// visible "Try again". A response that arrives after the person switched bots is dropped, never folded into the new conversation.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentChatApi, loadLocalItems, loadSeen, saveLocalItems, saveSeen, READ_ACTION, ThreadReadError, type AgentChatApi, type BotThreadEntry, type ThreadReadKind } from "@/lib/agent-chat";
import { activityHub, type ActivityMessage } from "@/lib/activity-stream";
import { parseThreadEvent } from "@/lib/thread-events";
import { addAck, addRequest, applyEntries, emptyChat, isNotable, needsYou, toBlocks, toStored, withStored, working, type Block, type ChatState, type Item } from "./chat-state";

export type Subscribe = (handler: (message: ActivityMessage) => void) => () => void;
export type Notification = { id: string; jobId: string; kind: "done" | "failed" | "waiting"; text: string };

/** The shared stream, held open while this chat is mounted. Tests pass their own. */
export const hubSubscribe: Subscribe = (handler) => {
  const hub = activityHub();
  const release = hub.acquire();
  const off = hub.subscribe((m) => {
    if (m.kind === "snapshot" || m.event.topic === "thread") handler(m);
  });
  return () => {
    off();
    release();
  };
};

export const SAFETY_POLL_MS = 20_000;
/** Automatic retries after a failed read, for the causes that can clear on their own. Then the person is asked. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 12_000, 30_000];
/** Snapshots closer together than this are one re-read (a flapping stream must not turn into a read loop). */
export const SNAPSHOT_MIN_GAP_MS = 3_000;
/** The stream must be down this long before the page says so (a reconnect in a moment is not worth a notice). */
export const STREAM_DOWN_AFTER_MS = 8_000;
const newEventId = () => `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Why the conversation could not be read, and what to do. `gaveUp`: the automatic retries are used up. */
export type ReadIssue = { kind: ThreadReadKind | "other"; message: string; action: string; retryable: boolean; failures: number; gaveUp: boolean };

export type UseBotChat = {
  blocks: Block[];
  loaded: boolean;
  /** Reading the thread failed (the transcript shown is what we have). The message only; `issue` has the cause and the next move. */
  readError: string | null;
  issue: ReadIssue | null;
  /** The live stream has been down a while: updates come from a slow check instead. */
  streamDown: boolean;
  sending: number;
  needsYou: boolean;
  working: boolean;
  /** One line for a polite live region: the latest completion, said once. */
  announcement: string;
  /**
   * Send one request. `resendKey`: the event id of an earlier send whose outcome this browser never learned; the hub treats the same id as the
   * same command, so the request is never run twice.
   */
  send(text: string, source?: "typed" | "voice", resendKey?: string): Promise<void>;
  /** Stop a job (a coding job through the coding store). Resolves true when accepted; otherwise `stopNotes[jobId]` says why. */
  stop(jobId: string): Promise<boolean>;
  stopNotes: Record<string, string>;
  /** Close any gap now (the Reconnect / Try again action): resets the retry budget and reads from the start. */
  refresh(): Promise<void>;
};

export function useBotChat(opts: {
  botId: string;
  conversationId: string;
  api?: AgentChatApi;
  subscribe?: Subscribe;
  onNotify?: (n: Notification) => void;
  /** Is the live stream carrying us? While it is not, a slow poll closes gaps. */
  streamHealthy?: () => boolean;
  /** Told when the stream's state may have changed (default: the shared hub's status, when the real stream is used). */
  watchStream?: (listener: () => void) => () => void;
  pollMs?: number;
  /** Automatic retry delays after a failed read (tests). */
  retryDelaysMs?: number[];
  /** How long the stream must be down before the page says so (tests). */
  streamDownAfterMs?: number;
}): UseBotChat {
  const { botId, conversationId } = opts;
  const api = opts.api ?? agentChatApi;
  const subscribe = opts.subscribe ?? hubSubscribe;
  const healthy = opts.streamHealthy ?? (() => (typeof window !== "undefined" ? activityHub().healthy() : false));
  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const retryDelaysRef = useRef(retryDelays);
  retryDelaysRef.current = retryDelays;
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [loaded, setLoaded] = useState(false);
  const [issue, setIssue] = useState<ReadIssue | null>(null);
  const [streamDown, setStreamDown] = useState(false);
  const [sending, setSending] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [stopNotes, setStopNotes] = useState<Record<string, string>>({});
  const ref = useRef(chat);
  const seen = useRef(new Set<string>());
  /** The first successful read of this conversation has happened: whatever it returned is history and is never announced. */
  const baselined = useRef(false);
  const notifyRef = useRef(opts.onNotify);
  notifyRef.current = opts.onNotify;
  const inflight = useRef<Promise<void> | null>(null);
  /** Where the read now in flight started from. */
  const inflightFrom = useRef(0);
  /** The lowest seq asked for by reads that arrived while one was in flight and started later than they need: one more read covers them. */
  const pendingFrom = useRef<number | null>(null);
  /** The hub's own id for this conversation (a UUID) once the thread route has answered for an `agent:` key. */
  const serverId = useRef<string | null>(null);
  /** Bumped whenever the conversation changes or the chat unmounts: an answer from an earlier one is dropped. */
  const generation = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSnapshotRead = useRef(0);
  /** Event ids of sends in flight: a second press of "Send again" for the same one is ignored. */
  const sendingKeys = useRef(new Set<string>());

  const commit = useCallback((next: ChatState) => {
    ref.current = next;
    setChat(next);
  }, []);

  const clearRetry = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  };

  /** Fold server entries; announce only genuinely new completions after the baseline read, once per job. */
  const fold = useCallback(
    (entries: BotThreadEntry[], quiet: boolean) => {
      const { state, applied } = applyEntries(ref.current, entries);
      if (state !== ref.current) commit(state);
      for (const item of applied) {
        if (!isNotable(item)) continue;
        const kind = item.kind === "failed" ? "failed" : item.kind === "waiting" ? "waiting" : "done";
        const id = `${item.jobId}:${kind}`;
        if (seen.current.has(id)) continue;
        seen.current.add(id);
        if (quiet) continue;
        const text = kind === "failed" ? "A task did not finish." : kind === "waiting" ? "A task needs you." : "A task is done.";
        setAnnouncement(`${text} ${item.text.split("\n")[0]}`.slice(0, 200));
        try {
          notifyRef.current?.({ id, jobId: item.jobId, kind, text: item.text.split("\n")[0] });
        } catch {
          /* a listener never breaks the thread */
        }
      }
      if (applied.length) saveSeen(conversationId, seen.current);
    },
    [commit, conversationId],
  );

  const catchUp = useCallback(
    (from?: number): Promise<void> => {
      // One catch-up at a time; a request that arrives meanwhile reuses it. If it needs entries from further back than the read in flight covers (a
      // snapshot or trailing read from 0 joining an incremental one), one more read from that lowest seq runs when this one settles.
      if (inflight.current) {
        const want = from ?? ref.current.maxSeq;
        if (want < inflightFrom.current) pendingFrom.current = pendingFrom.current === null ? want : Math.min(pendingFrom.current, want);
        return inflight.current;
      }
      const gen = generation.current;
      let start = from ?? ref.current.maxSeq;
      if (pendingFrom.current !== null) {
        start = Math.min(start, pendingFrom.current);
        pendingFrom.current = null;
      }
      inflightFrom.current = start;
      const current = () => generation.current === gen;
      let mine: Promise<void> | null = null;
      mine = (async () => {
        try {
          const thread = await api.fetchThread(botId, start);
          if (!current()) return;
          // A different conversation than ours is never folded in. The bot thread route is scoped to the signed-in person and this
          // bot, and the hub stores the conversation under a UUID derived from the `agent:<person>:<bot>` key: adopt that id once.
          const isKey = conversationId.startsWith("agent:");
          const ours = thread.conversationId === conversationId || (isKey && (serverId.current === null || serverId.current === thread.conversationId));
          if (!ours) throw new ThreadReadError("shape", "The hub answered with a different conversation than this one. Reload the page.");
          if (isKey) serverId.current = thread.conversationId;
          fold(thread.entries, !baselined.current);
          baselined.current = true;
          failures.current = 0;
          clearRetry();
          setIssue(null);
        } catch (error) {
          if (!current()) return;
          const known = error instanceof ThreadReadError ? error : null;
          const kind: ReadIssue["kind"] = known?.kind ?? "other";
          const retryable = known ? known.retryable : true;
          failures.current += 1;
          const delay = retryable ? retryDelaysRef.current[failures.current - 1] : undefined;
          const message = error instanceof Error && error.message ? error.message : "The conversation could not be read.";
          setIssue({ kind, message, action: known ? READ_ACTION[known.kind] : READ_ACTION.server, retryable, failures: failures.current, gaveUp: retryable && delay === undefined });
          clearRetry();
          if (delay !== undefined) {
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              if (generation.current === gen) void catchUp();
            }, delay);
          }
        } finally {
          if (inflight.current === mine || inflight.current === null) inflight.current = null;
        }
        if (pendingFrom.current !== null && current()) void catchUp();
      })();
      inflight.current = mine;
      return mine;
    },
    [api, botId, conversationId, fold],
  );

  // Load: what this device kept, then the server's thread. History is quiet (marked seen, never announced).
  useEffect(() => {
    let cancelled = false;
    generation.current += 1;
    baselined.current = false;
    serverId.current = null;
    failures.current = 0;
    clearRetry();
    seen.current = loadSeen(conversationId);
    commit(withStored(emptyChat(), loadLocalItems(conversationId)));
    setLoaded(false);
    setIssue(null);
    inflight.current = null;
    pendingFrom.current = null;
    void catchUp(0).finally(() => {
      if (cancelled) return;
      setLoaded(true);
      saveSeen(conversationId, seen.current);
    });
    return () => {
      cancelled = true;
      generation.current += 1;
      clearRetry();
      if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    };
  }, [botId, conversationId, catchUp, commit]);

  // Live: thread events for THIS conversation; a snapshot (first connect after a drop, a restarted hub) re-reads the thread from the start,
  // at most once in SNAPSHOT_MIN_GAP_MS however often the stream reconnects.
  useEffect(() => {
    return subscribe((message) => {
      if (message.kind === "snapshot") {
        const wait = lastSnapshotRead.current + SNAPSHOT_MIN_GAP_MS - Date.now();
        if (wait <= 0) {
          lastSnapshotRead.current = Date.now();
          void catchUp(0);
        } else if (!snapshotTimer.current) {
          snapshotTimer.current = setTimeout(() => {
            snapshotTimer.current = null;
            lastSnapshotRead.current = Date.now();
            void catchUp(0);
          }, wait);
        }
        return;
      }
      const parsed = parseThreadEvent(message.event);
      if (!parsed || (parsed.conversationId !== conversationId && parsed.conversationId !== serverId.current)) return;
      const e = parsed.entry;
      // The optional fields a bot backend may add ride in the raw entry; parseThreadEvent keeps only the base shape.
      const raw = (message.event.data as { entry?: Partial<BotThreadEntry> } | null)?.entry;
      fold([{ seq: e.seq, key: e.key, at: e.at, jobId: e.jobId, state: e.state, text: e.text, ...(typeof raw?.ok === "boolean" ? { ok: raw.ok } : {}), ...(raw?.unverified === true ? { unverified: true } : {}), ...(raw?.jobKind === "coding" ? { jobKind: "coding" as const } : {}), ...(raw?.blocker && typeof raw.blocker === "object" ? { blocker: raw.blocker } : {}) }], !baselined.current);
    });
  }, [subscribe, conversationId, catchUp, fold]);

  // Coming back to the tab, and a slow safety poll while the stream is not carrying us. Coming back is the person acting, so it gets a fresh retry
  // budget; the poll never runs for a cause retrying cannot fix (not paired) or after the automatic retries are used up.
  const issueRef = useRef(issue);
  issueRef.current = issue;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const back = () => {
      if (document.visibilityState !== "visible") return;
      failures.current = 0;
      void catchUp();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    const timer = setInterval(() => {
      const i = issueRef.current;
      if (i && (!i.retryable || i.gaveUp)) return;
      if (document.visibilityState === "visible" && !healthy()) void catchUp();
    }, opts.pollMs ?? SAFETY_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
      clearInterval(timer);
    };
  }, [catchUp, healthy, opts.pollMs]);

  // The stream being down is said once it has been down a while (and only for the real stream: a test's own subscribe has no hub behind it).
  useEffect(() => {
    const watch = opts.watchStream ?? (opts.subscribe ? null : (l: () => void) => activityHub().onStatus(l));
    if (!watch) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (healthy()) {
        if (timer) clearTimeout(timer);
        timer = null;
        setStreamDown(false);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          setStreamDown(!healthy());
        }, opts.streamDownAfterMs ?? STREAM_DOWN_AFTER_MS);
      }
    };
    check();
    const off = watch(check);
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [healthy, opts.watchStream, opts.subscribe, opts.streamDownAfterMs]);

  // Keep the person's own lines on this device.
  useEffect(() => {
    if (loaded) saveLocalItems(conversationId, toStored(chat));
  }, [chat, loaded, conversationId]);

  const send = useCallback(
    async (text: string, source: "typed" | "voice" = "typed", resendKey?: string) => {
      const utterance = text.trim().slice(0, 2000);
      if (!utterance) return;
      const key = resendKey ?? newEventId();
      if (sendingKeys.current.has(key)) return;
      sendingKeys.current.add(key);
      commit(addRequest(ref.current, { key, text: utterance, source, at: Date.now() }));
      setSending((n) => n + 1);
      try {
        const done = await api.send({ botId, conversationId, utterance, source, eventId: key });
        const unconfirmed = !!done.unconfirmed && !done.ok;
        commit(addAck(ref.current, { key, text: done.said || (done.ok ? "On it." : unconfirmed ? "I couldn't confirm that it started." : "That did not start."), ok: done.ok, jobId: done.jobId, at: Date.now(), ...(unconfirmed ? { unconfirmed: true } : {}) }));
        // The job's own entries arrive live; this closes any that were appended before we were listening (and, when the answer never
        // came back, finds the request the hub did receive).
        void catchUp();
      } catch (error) {
        // The send itself threw: nothing says whether the hub got it. Never "did not start".
        commit(addAck(ref.current, { key, text: `I couldn't confirm that it sent${error instanceof Error && error.message ? ` (${error.message})` : ""}. It may have arrived: check before sending it again.`, ok: false, jobId: null, at: Date.now(), unconfirmed: true }));
        void catchUp();
      } finally {
        sendingKeys.current.delete(key);
        setSending((n) => n - 1);
      }
    },
    [api, botId, conversationId, catchUp, commit],
  );

  const stop = useCallback(
    async (jobId: string) => {
      const jobKind = ref.current.items.some((i) => i.jobId === jobId && i.jobKind === "coding") ? ("coding" as const) : ("job" as const);
      const note = (text: string | null) => setStopNotes((n) => { const { [jobId]: _gone, ...rest } = n; return text ? { ...rest, [jobId]: text } : rest; });
      let result: boolean | { ok: boolean; reason?: string };
      try {
        result = await api.cancel(jobId, jobKind);
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : undefined };
      }
      const ok = typeof result === "boolean" ? result : result.ok;
      const reason = typeof result === "boolean" ? undefined : result.reason;
      note(ok ? null : `Could not stop it: ${reason || "the hub did not accept the stop."}`);
      if (ok) void catchUp();
      return ok;
    },
    [api, catchUp],
  );

  const refresh = useCallback(() => {
    failures.current = 0;
    clearRetry();
    try {
      if (typeof window !== "undefined" && !opts.subscribe) activityHub().retryNow();
    } catch {
      /* no hub in this environment */
    }
    return catchUp(0);
  }, [catchUp, opts.subscribe]);

  const blocks = useMemo(() => toBlocks(chat), [chat]);
  return {
    blocks,
    loaded,
    readError: issue?.message ?? null,
    issue,
    streamDown,
    sending,
    needsYou: needsYou(blocks),
    working: working(blocks),
    announcement,
    send,
    stop,
    stopNotes,
    refresh,
  };
}

export type { Item };

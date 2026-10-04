// What the voice companion does with a conversation entry that arrives on /__events (topic "thread"): show it once, say it only when a voice
// session can really say it, otherwise keep it as an unread result. Pure functions and one tiny store, so it is tested without a browser.
//
// Rules (Jarvis brief section 5):
//   - one completion per task: a job's end is keyed by completionIdentity (src/lib/thread-events.ts), so a replay, a reconnect snapshot, a second
//     tab or a differently spelled state ("succeeded" / "completed") is the same news and shows once;
//   - speech is never started from here. The server's interjection gate claims each spoken line exactly once; this file only decides whether the
//     CLIENT may ask for that claim (a session that is live and can announce) and what to keep when it may not;
//   - a session that has ended, or an engine that cannot announce, never "received" the line: it stays unread until the person has seen it;
//   - nothing here sends a request. An entry can be shown or remembered; it cannot start, resume, retry or cancel a job.
import { completionIdentity, viaFor } from "./thread-events";

/** Entry states that are not a job ending or a need: the acknowledgement, progress, a returned report. Never spoken, never "unread". */
export const SILENT_STATES = new Set(["started", "progress", "report", "request", "ack", "note"]);
export type CompletionEntry = { key: string; state: string; text: string; jobId?: string };
export type VoiceReadiness = {
  /** A voice session is connected (any engine). */
  active: boolean;
  /** The engine in use can speak a proactive line (the free engine's `announce`). */
  canAnnounce: boolean;
};
export type Delivery = "show" | "speak" | "unread";

/** The entry as a notice the person should not miss: a job ending, or one that needs them. */
export const isNotice = (entry: Pick<CompletionEntry, "state">) => !SILENT_STATES.has(entry.state);

/** What to do with an entry now. Silent entries are shown only; a notice is spoken when a session can say it, otherwise kept unread. */
export function deliveryFor(entry: Pick<CompletionEntry, "state">, voice: VoiceReadiness): Delivery {
  if (!isNotice(entry)) return "show";
  return voice.active && voice.canAnnounce ? "speak" : "unread";
}

/** The identity two arrivals of the same news share. */
export const noticeKey = (entry: Pick<CompletionEntry, "key">) => completionIdentity(viaFor(entry.key)) ?? entry.key;

export type UnreadResult = { key: string; text: string; at: number };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const MAX_UNREAD = 50;

/** Results that arrived with no live voice session to say them. Per browser, bounded, de-duplicated by notice identity; storage failing leaves memory working. */
export function createUnreadStore(storage?: StorageLike | null, storageKey = "jarvis:unread-results") {
  let items: UnreadResult[] = [];
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved)) items = saved.filter((x): x is UnreadResult => !!x && typeof x.key === "string" && typeof x.text === "string" && typeof x.at === "number").slice(-MAX_UNREAD);
  } catch {
    /* nothing kept, or unreadable: start empty */
  }
  const listeners = new Set<() => void>();
  const save = () => {
    try {
      storage?.setItem(storageKey, JSON.stringify(items));
    } catch {
      /* private mode: memory still has it */
    }
    for (const l of [...listeners]) l();
  };
  return {
    /** Keep a result as unread. False when this notice is already kept (the same news arriving twice). */
    add(entry: Pick<CompletionEntry, "key" | "text">, at = Date.now()): boolean {
      const key = noticeKey(entry);
      if (items.some((i) => i.key === key)) return false;
      items = [...items, { key, text: entry.text, at }].slice(-MAX_UNREAD);
      save();
      return true;
    },
    /** It was spoken or seen: no longer unread. */
    markRead(entryOrKey: string | Pick<CompletionEntry, "key">): void {
      const key = typeof entryOrKey === "string" ? entryOrKey : noticeKey(entryOrKey);
      const next = items.filter((i) => i.key !== key);
      if (next.length === items.length) return;
      items = next;
      save();
    },
    markAllRead(): void {
      if (!items.length) return;
      items = [];
      save();
    },
    list: (): UnreadResult[] => items,
    count: () => items.length,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type UnreadStore = ReturnType<typeof createUnreadStore>;

/**
 * After the gate's claim: the line is only "spoken" when the client really queued it. A claim is persisted by the server, so a refused announce
 * (the client closed, the queue full) would otherwise lose the result for good; it goes to unread instead.
 */
export function settleClaim(store: UnreadStore, entry: Pick<CompletionEntry, "key" | "text">, announced: boolean): "spoken" | "unread" {
  if (announced) {
    store.markRead(entry);
    return "spoken";
  }
  store.add(entry);
  return "unread";
}

/**
 * Whether a live entry belongs to the open voice session. `threadId` is the conversation the session reads: the id the hub's thread route answered with for
 * this session's scope (the person's default Jarvis thread, or the bot's thread while a bot scope is active). Null (not read yet): nothing is taken.
 */
export const entryInScope = (conversationId: string, threadId: string | null): boolean => threadId !== null && conversationId === threadId;

/** The dedupe key a spoken interjection carries (`job:<jobId>:<state>`) as the thread entry key it was made from (`<jobId>:<state>`); null for any other event. */
export const entryKeyOfInterjection = (dedupeKey: string | undefined): string | null => {
  const m = /^job:([0-9a-f-]{8,}:[a-z_-]+)$/i.exec(dedupeKey ?? "");
  return m ? m[1] : null;
};

export type ThreadFeedEntry = { seq: number; key: string; state: string; text: string };
export type ThreadFeedDeps = {
  readiness: () => VoiceReadiness;
  /** The voice panel is open and in front of the person: a line shown there has been seen. */
  panelSeen: () => boolean;
  unread: UnreadStore;
  /** Put a line in the visible voice log. Never the transcript store: the conversation already holds the durable entry. */
  show: (text: string) => void;
};

/**
 * What the voice session does with each entry of its own thread, live or from a catch-up. One notice is shown once however many times it arrives
 * (replay, snapshot catch-up, second tab, "succeeded" vs "completed"); the acknowledgement, progress and request lines are the task feed's and the
 * conversation's, so the voice log shows the result and what needs the person; a notice nobody has seen or heard is kept as unread.
 * `quiet` is history (the first read of a thread): remembered so it never appears later, shown and counted as nothing.
 */
export function createThreadFeed(deps: ThreadFeedDeps) {
  const shown = new Set<string>();
  let seq = 0;
  return {
    deliver(entry: ThreadFeedEntry, quiet = false): "shown" | "duplicate" | "skipped" | "quiet" {
      seq = Math.max(seq, entry.seq);
      const key = noticeKey(entry);
      if (shown.has(key)) return "duplicate";
      shown.add(key);
      if (quiet) return "quiet";
      const silent = !isNotice(entry);
      if (silent && entry.state !== "report") return "skipped";
      deps.show(entry.text);
      if (silent) return "shown";
      const voice = deps.readiness();
      // Seen in the open panel with no session to speak it: nothing is owed. Otherwise it stays unread until the gate's claim is spoken (settleClaim) or the panel opens.
      if (!(deps.panelSeen() && deliveryFor(entry, voice) === "unread")) deps.unread.add(entry);
      return "shown";
    },
    /** The highest entry sequence seen: where a catch-up reads from. */
    seq: () => seq,
    reset() {
      seq = 0;
    },
  };
}
export type ThreadFeed = ReturnType<typeof createThreadFeed>;

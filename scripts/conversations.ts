import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateChatAttachments } from "./chat-attachments";
import type { ChatAttachment } from "../src/lib/chat-attachments";
import { dataDirFor } from "./cloud/data-dir";
import { createHash } from "node:crypto";

/**
 * Jarvis threads (Open Dot V): a conversation can be one person's durable Jarvis thread. The server links the jobs
 * Jarvis starts for that person to it and APPENDS short result entries as those jobs change state, so a result shows
 * after a reload or a return even when the voice session (or the client) is long gone. The entries live beside the
 * client-saved messages (never inside them), so a server append never bumps `revision` and never conflicts with an
 * open tab's save; reads merge them in at the point they were appended.
 */
export type ThreadJobLink = {
  jobId: string;
  kind: "job" | "coding";
  title: string;
  state: string;
  startedAt: string;
  lastReferencedAt: string;
  /** Follow-up context the person added to the running job ("also include their opening hours"). */
  context: string[];
};
export type ThreadEntry = {
  seq: number;
  /** Idempotency: the same key is never appended twice (a replayed event, a double state notification). */
  key: string;
  at: string;
  jobId: string;
  state: string;
  text: string;
  /** The one short line worth saying out loud; the detail stays in the job view. */
  speak?: string;
  /** How many client messages existed when this was appended: where a read places it. */
  afterMessages: number;
};
export const JOB_VIA = "job:";
/** Entry kinds that are not a state of the job itself (the acknowledgement, a progress line, the returned report). */
const NOT_JOB_STATE = new Set(["started", "report", "progress"]);
/** The one deterministic conversation id of a person's default Jarvis thread. */
export function jarvisThreadId(personId: string): string {
  const h = createHash("sha1").update(`jarvis-thread:${personId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export type SavedMessage = {
  attachments?: ChatAttachment[];
  role: "user" | "oracle";
  text: string;
  brainRevision?: number;
  contextKey?: string;
  contextReusable?: boolean;
  sourceIds?: string[];
  via?: string;
  apps?: string[];
};
export type SavedConversation = {
  id: string;
  revision: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SavedMessage[];
  modelKey?: string;
  pinned?: boolean;
  persona?: "advisor" | "assistant" | "private-advisor";
  /** Set when this is a person's Jarvis thread (server-owned fields below; a client save never changes them). */
  personId?: string;
  thread?: "jarvis";
  jobs?: ThreadJobLink[];
  entries?: ThreadEntry[];
};
export class ConversationConflict extends Error {
  readonly status = 409;
  constructor() {
    super(
      "This conversation changed in another tab. Your unsaved copy is kept in this browser. Save it as a new chat.",
    );
  }
}
/** Someone tried to read or change a conversation that belongs to another person. */
export class ConversationForbidden extends Error {
  readonly status = 403;
  constructor() {
    super("That conversation belongs to someone else.");
  }
}
/**
 * Who is asking, from the VERIFIED principal (never a body). `hub` is true only for the owner sitting at the hub PC
 * (via loopback-owner). Ownership rule: a conversation with a personId is that person's alone. A conversation with NO
 * owner is legacy data from before ownership existed: it is visible and editable only by the hub owner, and is stamped
 * with that person on their next save. New conversations are stamped with the saver.
 */
export type ConversationViewer = { personId: string; hub: boolean };
const visibleTo = (c: SavedConversation, who?: ConversationViewer): boolean =>
  !who || (c.personId ? c.personId === who.personId : who.hub);

/** Told after a server entry is durably appended (never for a duplicate key): the one place a live push and a spoken line start from. */
export type AppendListener = (e: { conversationId: string; personId: string | null; entry: ThreadEntry }) => void;
/** A result report holds a short cited answer, its sources and the saved file; every other entry is a line. */
export const ENTRY_TEXT_MAX = 600;
export const REPORT_TEXT_MAX = 2200;

export function conversationStore(root: string) {
  const appendListeners = new Set<AppendListener>();
  const dir = join(dataDirFor(root)),
    file = join(dir, "conversations.json");
  const load = (): SavedConversation[] => {
    if (!existsSync(file)) return [];
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(s)) throw Error();
      return s;
    } catch {
      throw new Error("Saved conversations could not be read. Your history was left untouched.");
    }
  };
  const write = (items: SavedConversation[]) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID();
    writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const safeId = (id: unknown) => {
    if (typeof id !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
      throw new Error("Choose a valid conversation.");
    return id;
  };
  const strings = (items: unknown) =>
    Array.isArray(items)
      ? items
          .filter((v) => typeof v === "string")
          .slice(0, 100)
          .map((v) => v.slice(0, 300))
      : undefined;
  /** The conversation as a reader sees it: server entries merged into the messages where they were appended. */
  const entryMessage = (e: ThreadEntry): SavedMessage => ({ role: "oracle", text: e.text, via: `${JOB_VIA}${e.key}` });
  const view = (c: SavedConversation): SavedConversation => {
    if (!c.entries?.length) return c;
    const out: SavedMessage[] = [];
    const sorted = [...c.entries].sort((a, b) => a.seq - b.seq);
    let i = 0;
    c.messages.forEach((m, idx) => {
      while (i < sorted.length && sorted[i].afterMessages <= idx) out.push(entryMessage(sorted[i++]));
      out.push(m);
    });
    while (i < sorted.length) out.push(entryMessage(sorted[i++]));
    return { ...c, messages: out };
  };
  const mutate = (id: string, fn: (c: SavedConversation) => void): SavedConversation | null => {
    const items = load();
    const c = items.find((x) => x.id === id);
    if (!c) return null;
    fn(c);
    write(items);
    return c;
  };
  return {
    list: (who?: ConversationViewer) => load().filter((c) => visibleTo(c, who)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(view),
    get: (id: unknown) => {
      const c = load().find((x) => x.id === safeId(id));
      return c ? view(c) : null;
    },
    /**
     * The person's Jarvis thread: `id` if the client already has one (its voice transcript), else the person's default thread.
     * Created empty when missing; adopted when the client saved it first; refused (null) when it is another person's.
     */
    ensureThread: (input: { id?: string; personId: string }): SavedConversation | null => {
      let id = input.id ? safeId(input.id) : jarvisThreadId(input.personId);
      const items = load();
      let old = items.find((x) => x.id === id);
      if (old && old.personId && old.personId !== input.personId) return null;
      // An unowned (legacy) chat is never adopted by id: the person gets their own default thread instead.
      if (old && !old.personId) {
        id = jarvisThreadId(input.personId);
        old = items.find((x) => x.id === id);
        if (old && old.personId && old.personId !== input.personId) return null;
      }
      if (old) {
        if (old.personId) return old;
        old.personId = input.personId;
        old.thread = "jarvis";
        write(items);
        return old;
      }
      const now = new Date().toISOString();
      const created: SavedConversation = { id, revision: 0, title: "Jarvis", createdAt: now, updatedAt: now, messages: [], persona: "assistant", personId: input.personId, thread: "jarvis", jobs: [], entries: [] };
      write([created, ...items]);
      return created;
    },
    /** Link a job to the thread (idempotent): the conversation then knows which jobs are its own. */
    linkJob: (id: string, link: Omit<ThreadJobLink, "startedAt" | "lastReferencedAt" | "context"> & { context?: string[]; at?: string }) =>
      mutate(safeId(id), (c) => {
        const now = link.at ?? new Date().toISOString();
        c.jobs = c.jobs ?? [];
        const have = c.jobs.find((j) => j.jobId === link.jobId);
        if (have) {
          have.state = link.state;
          have.lastReferencedAt = now;
        } else c.jobs.push({ ...link, context: link.context ?? [], startedAt: now, lastReferencedAt: now });
        if (c.jobs.length > 100) c.jobs.splice(0, c.jobs.length - 100);
        c.updatedAt = now;
      }),
    /** A person mentioned this job (status question, follow-up, stop): it becomes the most recently referenced. */
    touchJob: (id: string, jobId: string, patch: { state?: string; addContext?: string; at?: string } = {}) =>
      mutate(safeId(id), (c) => {
        const j = c.jobs?.find((x) => x.jobId === jobId);
        if (!j) return;
        j.lastReferencedAt = patch.at ?? new Date().toISOString();
        if (patch.state) j.state = patch.state;
        if (patch.addContext) j.context = [...j.context, patch.addContext.slice(0, 300)].slice(-20);
      }),
    /** Append one server entry; the same key is a no-op (returns null). Durable: written before this returns. */
    appendEntry: (id: string, entry: { key: string; jobId: string; state: string; text: string; speak?: string; at?: string }): ThreadEntry | null => {
      let added: ThreadEntry | null = null;
      let owner: string | null = null;
      mutate(safeId(id), (c) => {
        owner = c.personId ?? null;
        c.entries = c.entries ?? [];
        if (c.entries.some((e) => e.key === entry.key)) return;
        const seq = (c.entries.at(-1)?.seq ?? 0) + 1;
        added = { seq, key: entry.key.slice(0, 120), at: entry.at ?? new Date().toISOString(), jobId: entry.jobId, state: entry.state, text: entry.text.slice(0, entry.state === "report" ? REPORT_TEXT_MAX : ENTRY_TEXT_MAX), ...(entry.speak ? { speak: entry.speak.slice(0, 200) } : {}), afterMessages: c.messages.length };
        c.entries.push(added);
        if (c.entries.length > 300) c.entries.splice(0, c.entries.length - 300);
        const j = c.jobs?.find((x) => x.jobId === entry.jobId);
        if (j && !NOT_JOB_STATE.has(entry.state)) j.state = entry.state; // a report or progress entry says nothing about the job's own state
        c.updatedAt = added.at;
      });
      // After the durable write, so a listener that reads the conversation always finds the entry. A listener never breaks the append.
      const appended = added as ThreadEntry | null;
      if (appended) for (const l of [...appendListeners]) try { l({ conversationId: id, personId: owner as string | null, entry: appended }); } catch { /* isolated */ }
      return appended;
    },
    /** Subscribe to appended entries. Notifications only: nothing here can start or resume a job. */
    onAppend: (listener: AppendListener) => {
      appendListeners.add(listener);
      return () => void appendListeners.delete(listener);
    },
    /** Entries after `seq` (the voice client's poll for updates to say). */
    entriesAfter: (id: string, seq: number): ThreadEntry[] => (load().find((x) => x.id === safeId(id))?.entries ?? []).filter((e) => e.seq > seq),
    save: (body: any, who?: ConversationViewer) => {
      const id = body.id ? safeId(body.id) : randomUUID(),
        items = load(),
        old = items.find((x) => x.id === id);
      if (old && !visibleTo(old, who)) throw new ConversationForbidden();
      const owner = old?.personId ?? who?.personId;
      if (!Array.isArray(body.messages) || body.messages.length > 500)
        throw new Error(
          "A conversation can contain up to 500 messages. Start a new conversation to continue.",
        );
      // The tab was shown job entries merged into its messages. They are not stored as messages; where it showed each one is where it stays.
      const placed = new Map<string, number>();
      let kept = 0;
      const clientMessages = body.messages.filter((m: any) => {
        const via = typeof m?.via === "string" && m.via.startsWith(JOB_VIA) ? m.via.slice(JOB_VIA.length) : null;
        if (via === null) return ++kept > 0;
        placed.set(via, kept);
        return false;
      });
      const messages: SavedMessage[] = clientMessages.map((m: any) => {
        if (
          !m ||
          !["user", "oracle"].includes(m.role) ||
          typeof m.text !== "string" ||
          m.text.length > 600000
        )
          throw new Error("A chat message has invalid or oversized content.");
        return {
          role: m.role,
          text: m.text,
          brainRevision:
            Number.isInteger(m.brainRevision) && m.brainRevision >= 0 ? m.brainRevision : undefined,
          contextKey: typeof m.contextKey === "string" && /^chat1:[01]:[01]{6,7}$/.test(m.contextKey) ? m.contextKey : undefined,
          contextReusable: typeof m.contextReusable === "boolean" ? m.contextReusable : undefined,
          sourceIds: strings(m.sourceIds),
          apps: strings(m.apps),
          attachments: validateChatAttachments(m.attachments),
          via: typeof m.via === "string" ? m.via.slice(0, 300) : undefined,
        };
      });
      const now = new Date().toISOString();
      const conversation: SavedConversation = {
        id,
        revision: (old?.revision || 0) + 1,
        title: String(
          body.title ||
            old?.title ||
            messages.find((m) => m.role === "user")?.text ||
            "New conversation",
        )
          .trim()
          .slice(0, 120),
        createdAt: old?.createdAt || now,
        updatedAt: now,
        messages,
        pinned: typeof body.pinned === "boolean" ? body.pinned : (old?.pinned || false),
        modelKey: typeof body.modelKey === "string" ? body.modelKey.slice(0, 300) : old?.modelKey,
        persona: ["advisor", "assistant", "private-advisor"].includes(body.persona) ? body.persona : old?.persona,
        ...(owner
          ? {
              personId: owner,
              thread: old?.thread,
              jobs: old?.jobs,
              // An entry the tab showed keeps its place; one it hadn't seen yet (appended after it loaded) goes after what it just saved.
              entries: old?.personId ? (old.entries ?? []).map((e) => {
                const at = placed.get(e.key);
                return at !== undefined ? { ...e, afterMessages: at } : e.afterMessages >= old.messages.length ? { ...e, afterMessages: messages.length } : e;
              }) : old?.entries,
            }
          : {}),
      };
      if (body.revision !== undefined && (!Number.isInteger(body.revision) || body.revision < 0))
        throw new Error("Invalid conversation revision.");
      const expected = body.revision || 0;
      if (expected !== (old?.revision || 0)) {
        // Retrying an acknowledged-by-server snapshot after a dropped response is safe.
        const same =
          old &&
          old.title === conversation.title &&
          !!old.pinned === !!conversation.pinned &&
          old.modelKey === conversation.modelKey &&
          old.persona === conversation.persona &&
          JSON.stringify(old.messages) === JSON.stringify(messages);
        if (same) return view(old);
        throw new ConversationConflict();
      }
      write([conversation, ...items.filter((x) => x.id !== id)]);
      return view(conversation);
    },
    remove: (id: unknown, who?: ConversationViewer) => {
      safeId(id);
      const items = load();
      const old = items.find((x) => x.id === id);
      if (old && !visibleTo(old, who)) throw new ConversationForbidden();
      write(items.filter((x) => x.id !== id));
      return { ok: true };
    },
  };
}

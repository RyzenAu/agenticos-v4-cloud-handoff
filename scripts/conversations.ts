import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateChatAttachments } from "./chat-attachments";
import type { ChatAttachment } from "../src/lib/chat-attachments";
import { dataDirFor } from "./cloud/data-dir";
import { createHash } from "node:crypto";
import { isCrmRef, type CrmRef } from "../src/lib/crm-ref";

/** Short-lived server-owned CRM context, not personal memory or a client-supplied message. */
export type CrmRecordReference = CrmRef & { title: string; at: number };
export const CRM_REFERENCE_TTL_MS = 15 * 60_000;
export function validCrmRecordReference(value: unknown, now: number): value is CrmRecordReference {
  const r = value as CrmRecordReference | null;
  return isCrmRef(r) && typeof r.title === "string" && r.title.length > 0 && r.title.length <= 300 &&
    Number.isFinite(r.at) && r.at <= now && now - r.at <= CRM_REFERENCE_TTL_MS;
}

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
/** Why a job in a conversation needs the person (or can't go on), for the UI to offer the right action. The words are in the entry's text; this is the machine-readable part. */
export type ThreadBlockerKind = "needs-takeover" | "needs-approval" | "needs-owner" | "allowance" | "failed" | "offline";
export type ThreadBlocker = {
  kind: ThreadBlockerKind;
  /** The B2 approval that answers it (decided through /__approvals with its own evidence rules; this only names it). */
  approvalId?: string;
  /** One plain sentence: what to do about it. */
  recovery?: string;
  /** A takeover only: whether the reader (the conversation's owner) is the one holding the controls, or somebody else is. */
  held?: "you" | "other";
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
  /** What kind of job the entry is about, when it is about one the workspace runs: a shared computer's job or a coding job. */
  jobKind?: "computer" | "coding";
  /** Present when the job is blocked, waiting for the person, or ended badly. */
  blocker?: ThreadBlocker;
  /** An `ack` entry only: whether the command was accepted (false: it did not start anything). Absent on older entries. */
  ok?: boolean;
  /** An `ack` entry only: the command was a stop. */
  stopped?: boolean;
  /** An `ack` entry only: the command failed after it may have started something, so its outcome is not known and it must not be run again. */
  unverified?: boolean;
  /** How many client messages existed when this was appended: where a read places it. */
  afterMessages: number;
};
export const JOB_VIA = "job:";
/** Entry kinds that are not a state of the job itself (the acknowledgement, a progress line, the returned report). */
const NOT_JOB_STATE = new Set(["started", "report", "progress", "request", "ack", "note"]);
/** The one deterministic conversation id of a person's default Jarvis thread. */
export function jarvisThreadId(personId: string): string {
  const h = createHash("sha1").update(`jarvis-thread:${personId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/**
 * The deterministic conversation id of one person's conversation with one agent bot (Agents workspace). The plan's key is
 * `agent:<personId>:<botId>` (see botConversationKey); the stored id is a UUID derived from it, because every conversation id on
 * the wire (store, command body, thread routes, the UI) is UUID-shaped. Same inputs, same id; different person or bot, different id.
 */
export function botThreadId(personId: string, botId: string): string {
  const h = createHash("sha1").update(`agent-thread:${personId}:${botId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** The plan's readable key for a person's conversation with a bot. */
export const botConversationKey = (personId: string, botId: string) => `agent:${personId}:${botId}`;
const BOT_KEY = /^agent:([a-z0-9][a-z0-9-]{0,31}):([a-z0-9][a-z0-9-]{0,31})$/;
/** `agent:<personId>:<botId>` -> its parts, or null. */
export function parseBotConversationKey(value: unknown): { personId: string; botId: string } | null {
  const m = typeof value === "string" ? BOT_KEY.exec(value) : null;
  return m ? { personId: m[1], botId: m[2] } : null;
}
/** A conversation the server links jobs to: a person's Jarvis thread, or one of their bot threads. */
export const isJobThread = (thread: unknown): boolean => thread === "jarvis" || thread === "bot";
/** What a caller who may not use bots (an unpaired login: see mayUseBots) gets from a conversations list: everything but the bot threads. */
export const withoutBotThreads = <T extends { thread?: unknown }>(items: T[], botsAllowed: boolean): T[] => (botsAllowed ? items : items.filter((c) => c.thread !== "bot"));
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
/** Server-owned receipts for a typed request. Kept with its messages across ordinary client saves. */
export type TypedRequest = {
  requestId: string;
  parts: Partial<Record<"user" | "reply" | "note", string>>;
  turns: Array<{ index: number; fingerprint: string; result?: Record<string, unknown> }>;
};
export type TypedBinding = { personId: string; conversationId?: string; requestId: string };
export class TypedPersistenceError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "typed_request_conflict") { super(message); this.name = "TypedPersistenceError"; }
}
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
  /** "jarvis": the person's default thread. "bot": their conversation with one agent bot (`bot` says which). */
  thread?: "jarvis" | "bot";
  /** The bot this conversation is with (thread "bot" only). */
  bot?: string;
  jobs?: ThreadJobLink[];
  entries?: ThreadEntry[];
  typedRequests?: TypedRequest[];
  /** Internal reference only; snapshot saves cannot set it and reads do not expose it. */
  crmRecordReference?: CrmRecordReference | { pending: string };
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

/** The saved conversations file exists but cannot be parsed. Callers say so (503) instead of a generic fault; the file is never touched. */
export class ConversationsUnreadable extends Error {
  constructor() {
    super("Saved conversations could not be read. Your history was left untouched.");
    this.name = "ConversationsUnreadable";
  }
}

const SHARING = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Retry a file operation that failed only because another process had the file open (Windows sharing violation), for up to ~1.5 s. */
export function withSharingRetry<T>(op: () => T, waitsMs: readonly number[] = [5, 10, 20, 40, 80, 120, 200, 300, 400, 400]): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (!SHARING.has(code) || attempt >= waitsMs.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitsMs[attempt]);
    }
  }
}

export function conversationStore(root: string) {
  const appendListeners = new Set<AppendListener>();
  const dir = join(dataDirFor(root)),
    file = join(dir, "conversations.json");
  const load = (): SavedConversation[] => {
    if (!existsSync(file)) return [];
    // Windows: another process briefly holding the file (antivirus scan, indexer, backup) is a sharing error, not a bad file.
    const raw = withSharingRetry(() => readFileSync(file, "utf8"));
    try {
      const s = JSON.parse(raw);
      if (!Array.isArray(s)) throw Error();
      return s;
    } catch {
      throw new ConversationsUnreadable();
    }
  };
  const write = (items: SavedConversation[]) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = file + "." + randomUUID();
    writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    // Production 4 Oct (the unexplained 503s): on Windows renaming over a file another process has open fails with EPERM, so a
    // thread write — and the command route that writes the thread — answered 503. Retry the swap briefly; give up only if it persists.
    try {
      withSharingRetry(() => renameSync(tmp, file));
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
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
  const view = (saved: SavedConversation): SavedConversation => {
    const { typedRequests: _receipts, crmRecordReference: _crmReference, ...c } = saved; // Internal replay receipts never leave the store through conversation reads.
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
  // Every mutation below is one read/modify/atomic-rename in this hub, including request binding and the visible messages.
  const typedRecord = (binding: TypedBinding) => {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(binding.personId) || !/^[\w:.-]{6,80}$/.test(binding.requestId))
      throw new TypedPersistenceError("A typed request needs a valid verified person and request id.", 400);
    const id = binding.conversationId === undefined ? jarvisThreadId(binding.personId) : safeId(binding.conversationId);
    if (["usman", "mehroz"].some((person) => person !== binding.personId && jarvisThreadId(person) === id)) throw new ConversationForbidden();
    const items = load();
    let c = items.find((x) => x.id === id);
    if (c && (c.personId !== binding.personId || c.thread === "bot")) throw new ConversationForbidden();
    if (items.some((x) => x.id !== id && x.personId === binding.personId && (
      x.typedRequests?.some((r) => r.requestId === binding.requestId) ||
      x.messages.some((m) => ["user", "reply", "note"].some((part) => m.via === `say:${binding.requestId}:${part}`))
    ))) throw new TypedPersistenceError("That request id belongs to a different conversation. Nothing was changed.");
    if (!c) {
      const at = new Date().toISOString();
      c = { id, revision: 0, title: "Jarvis", createdAt: at, updatedAt: at, messages: [], persona: "assistant", personId: binding.personId, thread: "jarvis", jobs: [], entries: [] };
      items.unshift(c);
    }
    c.typedRequests ??= [];
    let record = c.typedRequests.find((r) => r.requestId === binding.requestId);
    if (!record) {
      record = { requestId: binding.requestId, parts: {}, turns: [] };
      // Adopt already-saved legacy fragments, never trust the caller's claim that they were saved.
      for (const part of ["user", "reply", "note"] as const) {
        const m = c.messages.find((m) => m.via === `say:${binding.requestId}:${part}`);
        if (m) record.parts[part] = m.text;
      }
      c.typedRequests.push(record);
    }
    return { items, c, record };
  };
  const typedText = (text: string) => {
    if (typeof text !== "string" || !text.trim() || text.length > 20_000)
      throw new TypedPersistenceError("A saved typed message must contain text of at most 20000 characters. Nothing was truncated.", 400);
    return text;
  };
  const typedPart = (c: SavedConversation, record: TypedRequest, part: "user" | "reply" | "note", text: string) => {
    typedText(text);
    const prior = record.parts[part];
    if (prior !== undefined && prior !== text) throw new TypedPersistenceError("That request id already holds different words. Nothing was changed.");
    const via = `say:${record.requestId}:${part}`;
    const role = part === "user" ? "user" : "oracle";
    const old = c.messages.find((m) => m.via === via);
    if (old && (old.text !== text || old.role !== role)) throw new TypedPersistenceError("That saved request has conflicting content. Nothing was changed.");
    if (!old) {
      if (c.messages.length >= 500) throw new TypedPersistenceError("The conversation is full. This message was not saved; start a new conversation.", 409, "typed_conversation_full");
      // Fire-and-forget legacy clients can deliver their reply first. The eventual user fragment still appears before it.
      const reply = part === "user" ? c.messages.findIndex((m) => m.via === `say:${record.requestId}:reply` || m.via === `say:${record.requestId}:note`) : -1;
      if (reply >= 0) c.messages.splice(reply, 0, { role, text, via });
      else c.messages.push({ role, text, via });
    }
    record.parts[part] = text;
    c.updatedAt = new Date().toISOString();
  };
  return {
    /** Existing keyed typed-message endpoint, now strict about ownership, origin, conflicts and capacity. */
    saveTypedPart(binding: TypedBinding, part: "user" | "reply" | "note", role: "user" | "assistant", text: string): string {
      if (role !== (part === "user" ? "user" : "assistant")) throw new TypedPersistenceError("The message role does not match its request part.", 400);
      const { items, c, record } = typedRecord(binding);
      typedPart(c, record, part, text);
      write(items);
      return c.id;
    },
    /** Reserve before a free turn runs. A recorded unfinished turn is never silently rerun after a restart. */
    beginTypedTurn(binding: TypedBinding, input: { text: string; index: number; fingerprint: string }): { conversationId: string; state: "new" | "pending" | "complete"; result?: Record<string, unknown> } {
      if (!Number.isInteger(input.index) || input.index < 0 || input.index > 4 || !/^[a-f0-9]{64}$/.test(input.fingerprint))
        throw new TypedPersistenceError("Choose a valid typed turn index and fingerprint.", 400);
      const { items, c, record } = typedRecord(binding);
      typedPart(c, record, "user", input.text);
      const prior = record.turns.find((t) => t.index === input.index);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) throw new TypedPersistenceError("That request turn already has different input. Nothing ran.");
        return { conversationId: c.id, state: prior.result ? "complete" : "pending", ...(prior.result ? { result: prior.result } : {}) };
      }
      if (input.index !== record.turns.length || (input.index > 0 && !record.turns.at(-1)?.result))
        throw new TypedPersistenceError("The earlier typed turn is not saved. Retry it before continuing.");
      if (record.parts.reply !== undefined) throw new TypedPersistenceError("That request already has a saved reply. It was not run again.");
      // Reserve room for a reply before invoking any model or rule with possible side effects.
      if (c.messages.length >= 500) throw new TypedPersistenceError("The conversation is full. Nothing ran; start a new conversation.", 409, "typed_conversation_full");
      record.turns.push({ index: input.index, fingerprint: input.fingerprint });
      write(items);
      return { conversationId: c.id, state: "new" };
    },
    finishTypedTurn(binding: TypedBinding, input: { text: string; index: number; fingerprint: string; result: Record<string, unknown>; reply?: string }): string {
      const { items, c, record } = typedRecord(binding);
      typedPart(c, record, "user", input.text);
      const turn = record.turns.find((t) => t.index === input.index);
      if (!turn || turn.fingerprint !== input.fingerprint) throw new TypedPersistenceError("The typed turn binding changed. Its answer was not saved.");
      if (turn.result && JSON.stringify(turn.result) !== JSON.stringify(input.result)) throw new TypedPersistenceError("That typed turn already has a different result.");
      if (input.reply !== undefined) typedPart(c, record, "reply", input.reply);
      turn.result = input.result;
      write(items);
      return c.id;
    },
    list: (who?: ConversationViewer) => load().filter((c) => visibleTo(c, who)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(view),
    get: (id: unknown) => {
      const c = load().find((x) => x.id === safeId(id));
      return c ? view(c) : null;
    },
    /**
     * The person's Jarvis thread: `id` if the client already has one (its voice transcript), else the person's default thread.
     * Created empty when missing; adopted when the client saved it first; refused (null) when it is another person's.
     */
    ensureThread: (input: { id?: string; personId: string; /** The agent bot this conversation is with (Agents workspace): a bot thread, id from botThreadId. */ bot?: string; /** Title for a NEW thread (default "Jarvis"). */ title?: string }): SavedConversation | null => {
      const bot = input.bot && /^[a-z0-9][a-z0-9-]{0,31}$/.test(input.bot) ? input.bot : undefined;
      // A bot thread has ONE id per person and bot; a caller cannot point a bot at some other conversation.
      let id = bot ? botThreadId(input.personId, bot) : input.id ? safeId(input.id) : jarvisThreadId(input.personId);
      const items = load();
      let old = items.find((x) => x.id === id);
      if (old && old.personId && old.personId !== input.personId) return null;
      // An unowned (legacy) chat is never adopted by id: the person gets their own default thread instead.
      if (old && !old.personId && !bot) {
        id = jarvisThreadId(input.personId);
        old = items.find((x) => x.id === id);
        if (old && old.personId && old.personId !== input.personId) return null;
      }
      if (old) {
        if (bot && !old.bot) {
          // The client saved the conversation first (a chat tab opened it): adopt it as the bot thread, messages untouched.
          old.personId = input.personId;
          old.thread = "bot";
          old.bot = bot;
          old.jobs = old.jobs ?? [];
          old.entries = old.entries ?? [];
          write(items);
          return old;
        }
        if (old.personId) return old;
        old.personId = input.personId;
        old.thread = "jarvis";
        write(items);
        return old;
      }
      const now = new Date().toISOString();
      const created: SavedConversation = { id, revision: 0, title: (input.title?.trim() || (bot ? bot : "Jarvis")).slice(0, 120), createdAt: now, updatedAt: now, messages: [], persona: "assistant", personId: input.personId, thread: bot ? "bot" : "jarvis", ...(bot ? { bot } : {}), jobs: [], entries: [] };
      write([created, ...items]);
      return created;
    },
    /** Read only this owner's exact conversation; stale, malformed and future-dated references never resolve. */
    crmRecord: (personId: string, id: string, now: number): CrmRecordReference | null => {
      const c = load().find((x) => x.id === safeId(id));
      return c?.personId === personId && validCrmRecordReference(c.crmRecordReference, now) ? c.crmRecordReference : null;
    },
    /** The CRM delegate alone supplies this reference. No adoption, fallback conversation or client snapshot input. */
    rememberCrmRecord: (personId: string, id: string, reference: CrmRecordReference | null, generation: string): boolean => {
      if (!/^[\da-f-]{36}$/i.test(generation) || reference && !validCrmRecordReference(reference, reference.at)) return false;
      const items = load();
      const c = items.find((x) => x.id === safeId(id));
      if (!c || c.personId !== personId) return false;
      // A delayed older result cannot restore context after a newer lookup invalidated it.
      if (reference && (!c.crmRecordReference || !("pending" in c.crmRecordReference) || c.crmRecordReference.pending !== generation)) return false;
      c.crmRecordReference = reference ? { kind: reference.kind, id: reference.id, title: reference.title, at: reference.at } : { pending: generation };
      write(items);
      return true;
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
    /**
     * Round 11: one message of a typed exchange (the person's request, Jarvis's reply) written into this thread as a plain message, keyed
     * (`say:<key>` in its via) so a repeat is a no-op (returns false). Durable: written before this returns. The caller owns the thread (ensureThread).
     */
    appendMessage: (id: string, m: { key: string; role: "user" | "oracle"; text: string }): boolean => {
      let added = false;
      mutate(safeId(id), (c) => {
        const via = `say:${m.key.slice(0, 120)}`;
        if (c.messages.some((x) => x.via === via) || c.messages.length >= 500) return;
        c.messages.push({ role: m.role, text: m.text.slice(0, 20_000), via });
        c.updatedAt = new Date().toISOString();
        added = true;
      });
      return added;
    },
    /** Append one server entry; the same key is a no-op (returns null). Durable: written before this returns. */
    appendEntry: (id: string, entry: { key: string; jobId: string; state: string; text: string; speak?: string; at?: string; jobKind?: "computer" | "coding"; blocker?: ThreadBlocker; ok?: boolean; stopped?: boolean; unverified?: boolean; /** Replace an entry with this key (it gets a new seq, so a reader sees it as newer). Only a command's own reply is ever replaced, when the command is run again after it was never run. */ replace?: boolean }): ThreadEntry | null => {
      let added: ThreadEntry | null = null;
      let owner: string | null = null;
      mutate(safeId(id), (c) => {
        owner = c.personId ?? null;
        c.entries = c.entries ?? [];
        const have = c.entries.findIndex((e) => e.key === entry.key);
        if (have >= 0) {
          if (!entry.replace) return;
          c.entries.splice(have, 1);
        }
        const seq = (c.entries.at(-1)?.seq ?? 0) + 1;
        added = { seq, key: entry.key.slice(0, 120), at: entry.at ?? new Date().toISOString(), jobId: entry.jobId, state: entry.state, text: entry.text.slice(0, entry.state === "report" ? REPORT_TEXT_MAX : ENTRY_TEXT_MAX), ...(entry.speak ? { speak: entry.speak.slice(0, 200) } : {}), ...(typeof entry.ok === "boolean" ? { ok: entry.ok } : {}), ...(entry.stopped ? { stopped: true } : {}), ...(entry.unverified ? { unverified: true } : {}), ...(entry.jobKind ? { jobKind: entry.jobKind } : {}), ...(entry.blocker ? { blocker: { kind: entry.blocker.kind, ...(entry.blocker.approvalId ? { approvalId: entry.blocker.approvalId.slice(0, 80) } : {}), ...(entry.blocker.recovery ? { recovery: entry.blocker.recovery.slice(0, 240) } : {}), ...(entry.blocker.held ? { held: entry.blocker.held } : {}) } } : {}), afterMessages: c.messages.length };
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
      // The true reason for each refusal: a save with no messages list at all is not "too many messages". An empty list is a valid save.
      if (!Array.isArray(body.messages))
        throw new Error("Saving a conversation needs its messages as a list (an empty list is fine).");
      if (body.messages.length > 500)
        throw new Error(
          "A conversation can contain up to 500 messages. Start a new conversation to continue.",
        );
      // The tab was shown job entries merged into its messages. They are not stored as messages; where it showed each one is where it stays.
      const placed = new Map<string, number>();
      let kept = 0;
      const seenSays = new Set<string>();
      const clientMessages = body.messages.filter((m: any) => {
        if (typeof m?.via === "string" && m.via.startsWith("say:")) {
          if (!old?.messages.some((saved) => saved.via === m.via)) throw new TypedPersistenceError("Server-saved request keys cannot be created by a conversation snapshot.", 400);
          if (seenSays.has(m.via)) return false;
          seenSays.add(m.via);
        }
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
      // Round 11: a typed request or reply the server wrote into this thread (via "say:<key>") that this save doesn't carry is kept where it was:
      // the companion saves its own transcript list, which never held them, and a save used to erase them.
      if (old) old.messages.forEach((m, idx) => {
        if (typeof m.via === "string" && m.via.startsWith("say:")) {
          const at = messages.findIndex((x) => x.via === m.via);
          if (at >= 0) messages[at] = m;
          else messages.splice(Math.min(idx, messages.length), 0, m);
        }
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
              ...(old?.bot ? { bot: old.bot } : {}),
              jobs: old?.jobs,
              typedRequests: old?.typedRequests,
              crmRecordReference: old?.crmRecordReference,
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

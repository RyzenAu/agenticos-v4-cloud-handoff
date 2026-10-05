/**
 * Server-owned routing clarification state. A short answer selects an offered route for the
 * original request; it is never itself the task. Pure transitions: the conversation store owns
 * persistence, ownership checks, and an atomic read/transition/write before any dispatch.
 * This is separate from final-action approval and never carries a spoken-yes token.
 */
import type { CommandBody, PageContext } from "./contracts";

export const CLARIFICATION_TTL_MS = 30 * 60_000;
export type ClarificationRoute =
  | { kind: "bot"; bot: string }
  | { kind: "coding" }
  | { kind: "brain" }
  | { kind: "device" }
  | { kind: "computer"; computer: string };
export type ClarificationChoice = { id: string; label: string; aliases: string[]; route: ClarificationRoute };
export type ClarificationPin = { accountSlot: string | null; model: string | null };
/** Accepted request data only: event identity and approval proof belong to the new answer. */
export type ClarificationRequest = {
  utterance: string;
  source: "typed" | "voice";
  conversationId: string;
  target?: { bot: string };
  spokenTarget?: string;
  pageContext?: PageContext;
  subjects?: string[];
};
export type ClarificationAuthority = "founder-session" | "gateway";
export type PendingClarification = {
  authority: ClarificationAuthority;
  version: 1;
  id: string;
  personId: string;
  conversationId: string;
  originalEventId: string | null;
  askJobId: string;
  createdAt: number;
  expiresAt: number;
  request: ClarificationRequest;
  /** The exact offered catalogue, useful for audit; choices are a bounded subset of it. */
  offeredLanes: string[];
  choices: ClarificationChoice[];
  /** A resolved explicit account/model constraint, never a replacement chosen by the answer. */
  pin: ClarificationPin | null;
  /** The own-device option originally offered; never silently switched on an answer. */
  targetDeviceId?: string | null;
  state: "pending" | "consumed" | "cancelled" | "superseded";
  answer?: { eventId: string; binding: string; choiceId: string; at: number };
};
export type ClarificationReply = {
  authority: ClarificationAuthority;
  personId: string;
  conversationId: string;
  utterance: string;
  eventId: string;
  /** Immutable digest of the ACTUAL reply, including its source, target, context and principal. */
  binding: string;
  now: number;
  /** Actual reply metadata is checked before consumption; it is never saved as task data. */
  target?: { bot: string };
  spokenTarget?: string;
  subjects?: string[];
  hasSteps?: boolean;
  /** The same explicit-Stop predicate the command service uses. */
  stop?: boolean;
};
export type ClarificationTransition =
  | { kind: "none" }
  | { kind: "expired" | "cancelled" | "already-answered" | "conflict"; record: PendingClarification }
  | { kind: "new-request"; record: PendingClarification }
  | { kind: "ambiguous"; record: PendingClarification }
  | { kind: "replay"; record: PendingClarification; choice: ClarificationChoice }
  | { kind: "resume"; record: PendingClarification; choice: ClarificationChoice; request: ClarificationRequest; pin: ClarificationPin | null };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const normal = (value: string) => value.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
/** Only a complete finite choice is an answer. Added actions are a new request, never discarded. */
export function clarificationChoice(words: string, choices: readonly ClarificationChoice[]): ClarificationChoice | "ambiguous" | null {
  const text = normal(words);
  if (!text) return null;
  const unwrapped = text.replace(/^(?:please\s+)?(?:use|choose|pick|go with)\s+/, "").replace(/\s+please$/, "");
  const matches = choices.filter(c => [c.id, c.label, ...c.aliases].some(alias => normal(alias).length > 0 && (normal(alias) === text || normal(alias) === unwrapped)));
  return matches.length === 1 ? clone(matches[0]) : matches.length > 1 ? "ambiguous" : null;
}

export function clarificationRequest(body: CommandBody, conversationId: string): ClarificationRequest {
  return clone({
    utterance: String(body.utterance ?? ""),
    source: body.source === "voice" ? "voice" : "typed",
    conversationId,
    ...(body.target ? { target: body.target } : {}),
    ...(body.spokenTarget ? { spokenTarget: body.spokenTarget } : {}),
    ...(body.pageContext ? { pageContext: body.pageContext } : {}),
    ...(body.subjects ? { subjects: body.subjects } : {}),
  });
}

export function createClarification(input: Omit<PendingClarification, "version" | "state" | "expiresAt" | "answer"> & { expiresAt?: number }): PendingClarification {
  const record: PendingClarification = clone({ ...input, version: 1, state: "pending", expiresAt: input.expiresAt ?? input.createdAt + CLARIFICATION_TTL_MS });
  if (!validClarification(record)) throw new Error("Invalid routing clarification.");
  return record;
}

/** Runtime checks are deliberately bounded. A malformed persisted record can never resume a job. */
export function validClarification(value: unknown): value is PendingClarification {
  const v = value as PendingClarification | null;
  const text = (x: unknown, max: number) => typeof x === "string" && x.length > 0 && x.length <= max;
  const keys = (x: unknown, allowed: string[]) => !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).every(k => allowed.includes(k));
  const route = (r: any) => r && (r.kind === "bot" ? keys(r, ["kind", "bot"]) && text(r.bot, 80) : r.kind === "computer" ? keys(r, ["kind", "computer"]) && text(r.computer, 80) : keys(r, ["kind"]) && ["coding", "brain", "device"].includes(r.kind));
  const pin = (p: any) => p === null || keys(p, ["accountSlot", "model"]) && [p.accountSlot, p.model].every(x => x === null || text(x, 160));
  const optional = (x: unknown, check: (v: any) => boolean) => x === undefined || check(x);
  const path = (x: unknown) => text(x, 200) && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(String(x)) && !String(x).includes("..");
  const item = (x: any): boolean => keys(x, ["kind", "id", "label", "href", "data"]) && text(x.kind, 32) && text(x.id, 80) && text(x.label, 120) && optional(x.href, path) && optional(x.data, d => !!d && typeof d === "object" && !Array.isArray(d) && Object.entries(d).length <= 16 && Object.entries(d).every(([k, val]) => /^[A-Za-z][\w.-]{0,40}$/.test(k) && (val === null || typeof val === "boolean" || typeof val === "number" && Number.isFinite(val) || typeof val === "string" && val.length <= 80)));
  const context = (p: any): boolean => keys(p, ["page", "title", "selected", "focused", "visible", "source", "jobId", "capturedAt"]) && path(p.page) && optional(p.title, t => text(t, 120)) && optional(p.jobId, t => text(t, 64)) && optional(p.capturedAt, t => typeof t === "number" && Number.isFinite(t)) && optional(p.focused, t => t === null || item(t)) && [p.selected, p.visible].every(a => optional(a, list => Array.isArray(list) && list.length <= 20 && list.every(item))) && optional(p.source, src => keys(src, ["name", "state", "updatedAt"]) && text(src.name, 120) && optional(src.state, state => ["live", "simulated", "stale", "failed", "unknown", "setup-required"].includes(state)) && optional(src.updatedAt, t => text(t, 40)));
  if (!v || !["founder-session", "gateway"].includes(v.authority) || v.version !== 1 || !text(v.id, 160) || !text(v.personId, 80) || !text(v.conversationId, 120) || !text(v.askJobId, 160) || !(v.originalEventId === null || text(v.originalEventId, 80))) return false;
  if (!Number.isFinite(v.createdAt) || !Number.isFinite(v.expiresAt) || v.expiresAt <= v.createdAt || v.expiresAt - v.createdAt > CLARIFICATION_TTL_MS) return false;
  if (!["pending", "consumed", "cancelled", "superseded"].includes(v.state) || !v.request || !text(v.request.utterance, 20_000) || v.request.conversationId !== v.conversationId || !["typed", "voice"].includes(v.request.source) || !pin(v.pin)) return false;
  if (!keys(v.request, ["utterance", "source", "conversationId", "target", "spokenTarget", "pageContext", "subjects"])) return false;
  if (!optional(v.request.target, t => keys(t, ["bot"]) && text(t.bot, 80)) || !optional(v.request.spokenTarget, t => text(t, 60)) || !optional(v.request.pageContext, context) || !optional(v.request.subjects, a => Array.isArray(a) && a.length <= 8 && a.every(t => text(t, 200)))) return false;
  if (!optional(v.targetDeviceId, id => id === null || text(id, 160))) return false;
  if (!Array.isArray(v.offeredLanes) || !v.offeredLanes.length || v.offeredLanes.length > 12 || !v.offeredLanes.every(l => text(l, 40))) return false;
  if (!Array.isArray(v.choices) || !v.choices.length || v.choices.length > 32 || new Set(v.choices.map(c => c?.id)).size !== v.choices.length) return false;
  if (!v.choices.every(c => c && text(c.id, 120) && text(c.label, 160) && normal(c.id).length > 0 && normal(c.label).length > 0 && Array.isArray(c.aliases) && c.aliases.length <= 24 && c.aliases.every(a => text(a, 160) && normal(a).length > 0) && route(c.route))) return false;
  if (v.choices.some(c => c.route.kind === "bot" ? !v.offeredLanes.includes("bot") : c.route.kind === "device" ? !v.offeredLanes.some(l => l === "device.open" || l === "device.screen") : !v.offeredLanes.includes(c.route.kind))) return false;
  if (v.pin && v.choices.some(c => c.route.kind !== "coding")) return false;
  if (v.request.target?.bot && v.choices.some(c => c.route.kind !== "bot" || c.route.bot !== v.request.target!.bot)) return false;
  if (v.request.spokenTarget && v.choices.some(c => c.route.kind !== "device")) return false;
  if (v.state !== "consumed" && v.answer !== undefined) return false;
  if (v.state === "consumed" && (!v.answer || !text(v.answer.eventId, 80) || !text(v.answer.binding, 128) || !Number.isFinite(v.answer.at) || !v.choices.some(c => c.id === v.answer!.choiceId))) return false;
  return true;
}

/**
 * The caller must durably commit a changed record before using a `resume` result. The same reply
 * event is replay-only, never a second dispatch; another event cannot consume the original again.
 */
export function answerClarification(value: unknown, reply: ClarificationReply): ClarificationTransition {
  if (!validClarification(value)) return { kind: "none" };
  const r = clone(value);
  if (r.authority !== reply.authority || r.personId !== reply.personId || r.conversationId !== reply.conversationId || !Number.isFinite(reply.now) || reply.now < r.createdAt) return { kind: "none" };
  const choice = clarificationChoice(reply.utterance, r.choices);
  if (r.answer?.eventId === reply.eventId) {
    if (r.answer.binding !== reply.binding || !choice || choice === "ambiguous" || choice.id !== r.answer.choiceId) return { kind: "conflict", record: r };
    return { kind: "replay", record: r, choice };
  }
  if (r.state !== "pending") return choice ? { kind: "already-answered", record: r } : { kind: "none" };
  if (reply.stop || /^(?:please\s+)?(?:stop|cancel|abort|never mind|nevermind|forget it|hold on|no|nope|no thanks|leave it)(?:\s+(?:it|that|this|the request|that request|my request|the task|that task|the job|that job))?[.!?]*$/i.test(reply.utterance.trim())) {
    if (reply.target && reply.target.bot !== r.request.target?.bot) return { kind: "none" };
    return { kind: "cancelled", record: { ...r, state: "cancelled" } };
  }
  if (reply.now >= r.expiresAt) return choice ? { kind: "expired", record: r } : { kind: "new-request", record: { ...r, state: "superseded" } };
  if (choice === "ambiguous") return { kind: "ambiguous", record: r };
  if (!choice) return { kind: "new-request", record: { ...r, state: "superseded" } };
  const expectedTarget = choice.route.kind === "bot" ? { bot: choice.route.bot } : r.request.target;
  if (reply.hasSteps || reply.target && JSON.stringify(reply.target) !== JSON.stringify(expectedTarget) || reply.spokenTarget && reply.spokenTarget !== r.request.spokenTarget || reply.subjects?.length && JSON.stringify(reply.subjects) !== JSON.stringify(r.request.subjects))
    return { kind: "conflict", record: r };
  if (typeof reply.eventId !== "string" || !/^[\w:.-]{6,80}$/.test(reply.eventId) || typeof reply.binding !== "string" || !reply.binding || reply.binding.length > 128) return { kind: "conflict", record: r };
  const consumed: PendingClarification = { ...r, state: "consumed", answer: { eventId: reply.eventId, binding: reply.binding, choiceId: choice.id, at: reply.now } };
  return { kind: "resume", record: consumed, choice, request: clone(r.request), pin: clone(r.pin) };
}

/** One private conversation field. Reserve a generation synchronously before awaiting a router. */
export type ClarificationSlot = { authority: ClarificationAuthority; generation: string; record: PendingClarification | null };
/**
 * A store adapter performs this under its synchronous read/write boundary. It must persist `slot`
 * before returning `transition`, even when no question was waiting, so a slower older router call
 * cannot overwrite a newer request. Scope ownership is checked by the store before calling this.
 */
export function beginClarificationTurn(value: ClarificationSlot | undefined, generation: string, reply: ClarificationReply): { slot: ClarificationSlot; transition: ClarificationTransition } {
  if (!generation || generation.length > 160) throw new Error("Invalid clarification generation.");
  if (value && value.authority !== reply.authority) return { slot: clone(value), transition: { kind: "none" } };
  const transition = answerClarification(value?.record, reply);
  const previous = validClarification(value?.record) && value!.record!.personId === reply.personId && value!.record!.conversationId === reply.conversationId ? clone(value!.record) : null;
  return { slot: { authority: reply.authority, generation, record: "record" in transition ? clone(transition.record) : previous }, transition };
}
/** Save only a question produced by the latest admitted turn; a late ask is superseded. */
export function saveClarificationQuestion(value: ClarificationSlot | undefined, generation: string, question: PendingClarification): ClarificationSlot | null {
  if (!value || value.authority !== question.authority || value.generation !== generation || !validClarification(question) || question.state !== "pending") return null;
  if (value.record && (value.record.personId !== question.personId || value.record.conversationId !== question.conversationId || value.record.id === question.id && value.record.state !== "pending")) return null;
  return { authority: question.authority, generation, record: clone(question) };
}

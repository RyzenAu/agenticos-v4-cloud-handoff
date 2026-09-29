/**
 * CRM actions by voice or typing (Track 2, AUDIT-F4 F11; F1 flow 3), through the leads service's own API. Pure
 * over the injected API: the live server passes createLeadsApi(root); tests pass a fake.
 */
import { createHash } from "node:crypto";
import type { Principal } from "../identity/principal";
import { leadLabel, resolveLead, type LeadsApiLike } from "./lead-resolve";
import type { LeadAction } from "./plan";

export type { LeadsApiLike } from "./lead-resolve";

const OUTCOME_WORDS: Record<string, string> = {
  no_answer: "no answer", voicemail: "voicemail", call_back: "call back", interested: "interested", not_interested: "not interested",
  meeting: "meeting", proposal: "proposal", won: "won", lost: "lost", do_not_contact: "do not contact",
};

/** A repeat of the same intent inside this window (re-spoken, retried, resubmitted) is one CRM event. */
export const LEAD_EVENT_WINDOW_MS = 15 * 60_000;

/**
 * The CRM idempotency key for one intent: WHO said it, WHAT (log/status), WHICH lead (its resolved id, so
 * "Harbor Dental" and "Harbour Dental" agree), and WHICH outcome, within a time window. It deliberately does
 * not contain a job or turn id: a re-spoken command is a new job but the same intent, and must not add a
 * second activity. A genuinely different command (another lead, outcome or action) has a different key.
 */
export function leadEventKey(personId: string, action: "log" | "status", leadId: number, outcome: string, nowMs: number = Date.now(), lastActivityId: number = 0): string {
  const bucket = Math.floor(nowMs / LEAD_EVENT_WINDOW_MS);
  const digest = createHash("sha256").update(`${personId}\u0000${action}\u0000${leadId}\u0000${outcome}\u0000${lastActivityId}`).digest("hex").slice(0, 24);
  return `jarvis-crm:${digest}:${bucket}`;
}

/**
 * A spoken or typed CRM action (AUDIT-F4 F11) through the leads service. The lead is found by name in the CRM,
 * by a near-miss of the name ("Harbor Dental"), or by description ("the dentist in Parramatta"): one clear
 * match acts; two or three close ones ask which; none says so. The write goes through /leads/log and the new
 * status is read back independently (/leads/list by status) before anything is called done; the reply is
 * that read-back in one line, naming the lead and its suburb.
 */
export async function runLeadAction(api: LeadsApiLike, action: LeadAction, principal: Pick<Principal, "personId">, eventId?: string, opts: { now?: () => number } = {}): Promise<{ ok: boolean; said: string; verified: boolean | null }> {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  if (action.action === "next") {
    const r = (await api.handle("/leads/cards", "GET", {}, q({ n: "1" }), false)) as { cards?: Array<{ leadId: number; name: string; vertical?: string; area?: string; status?: string }> };
    const c = r.cards?.[0];
    return c ? { ok: true, said: `Next to call: ${c.name}${c.vertical ? ` (${c.vertical}${c.area ? `, ${c.area}` : ""})` : ""}. Its call card is in Leads.`, verified: true } : { ok: true, said: "There's no one waiting to be called right now.", verified: true };
  }
  const found = await resolveLead(api, action.lead);
  if (found.kind === "none") return { ok: false, said: `I can't find a lead called ${action.lead} in the CRM, so nothing changed.`, verified: null };
  if (found.kind === "many") return { ok: false, said: `${found.options.length} leads could be "${action.lead}": ${found.options.map(leadLabel).join(", or ")}. Which one?`, verified: null };
  const lead = found.lead;
  const kind = action.action === "log" ? "call" : "note";
  const nowMs = (opts.now ?? Date.now)();
  type Act = { id: number; at?: string; kind: string; outcome: string; by: string };
  const detail = async () => (await api.handle("/leads/detail", "GET", {}, q({ id: String(lead.id) }), false)) as { activities?: Act[] };
  const before = await detail();
  // The newest DIFFERENT activity on the lead is part of the intent: "interested, won, interested" within a window is three
  // intents, while a resubmit of the same command (its own earlier write is not "different") still maps to one key.
  const same = (a: Act) => a.kind === kind && a.outcome === action.outcome && a.by === principal.personId;
  const lastId = Math.max(0, ...(before.activities ?? []).filter((a) => !same(a)).map((a) => a.id));
  // An explicit id (a caller's own retry token) wins; otherwise the key comes from the intent itself.
  const key = eventId ?? leadEventKey(principal.personId, action.action, lead.id, action.outcome, nowMs, lastId);
  // A matching activity from this person, recent enough to be the same intent (covers a key-window edge and a
  // write whose read-back failed): confirm it by read-back, never write it again. One that a different activity has
  // since followed does not count, so a later change of status makes the repeat a new command.
  const recent = (before.activities ?? []).find((a) => {
    const at = a.at ? Date.parse(a.at) : NaN;
    return a.id > lastId && same(a) && Number.isFinite(at) && nowMs - at >= -60_000 && nowMs - at < LEAD_EVENT_WINDOW_MS;
  });
  let duplicate = !!recent;
  if (!recent) {
    const logged = (await api.handle("/leads/log", "POST", { lead: lead.id, outcome: action.outcome, kind, by: principal.personId, event: key }, q({}), false)) as { duplicate?: boolean };
    duplicate = !!logged.duplicate;
  }
  // Independent read-back: the lead now lists under that status, and (for a call) the activity is really there.
  const listed = (await api.handle("/leads/list", "GET", {}, q({ status: action.outcome, all: "1" }), false)) as { leads?: Array<{ id: number }> };
  let verified = !!listed.leads?.some((l) => l.id === lead.id);
  if (action.action === "log") {
    const after = await detail();
    const previous = new Set(before.activities?.map((a) => a.id) ?? []);
    // A replay is an acknowledged duplicate; an ordinary write must produce a fresh activity.
    verified = verified && !!after.activities?.some((a) => (duplicate || !previous.has(a.id)) && a.kind === kind && a.outcome === action.outcome && a.by === principal.personId);
  }
  const words = OUTCOME_WORDS[action.outcome] ?? action.outcome;
  const who = leadLabel(lead);
  // When the lead was not found by his exact words, say who it turned out to be (in the same line).
  const matched = found.how === "fuzzy" || found.how === "description" ? `${found.how === "description" ? "That's" : `I took "${action.lead}" to be`} ${who}. ` : "";
  return verified
    ? { ok: true, said: `${matched}${action.action === "log" ? `${duplicate ? "Already logged" : "Logged"} a call to ${matched ? lead.name : who} as ${words}` : `${duplicate ? "Already marked" : "Marked"} ${matched ? lead.name : who} as ${words}`}, confirmed in the CRM${duplicate ? "; nothing was added twice" : ""}.`, verified: true }
    : { ok: false, said: `${matched}I sent it to the CRM, but ${lead.name} doesn't read back as ${words}, so I'm not calling it done.`, verified: false };
}

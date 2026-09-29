/**
 * CRM actions by voice or typing (Track 2, AUDIT-F4 F11; F1 flow 3), through the leads service's own API. Pure
 * over the injected API: the live server passes createLeadsApi(root); tests pass a fake.
 */
import type { Principal } from "../identity/principal";
import { leadLabel, resolveLead, type LeadsApiLike } from "./lead-resolve";
import type { LeadAction } from "./plan";

export type { LeadsApiLike } from "./lead-resolve";

const OUTCOME_WORDS: Record<string, string> = {
  no_answer: "no answer", voicemail: "voicemail", call_back: "call back", interested: "interested", not_interested: "not interested",
  meeting: "meeting", proposal: "proposal", won: "won", lost: "lost", do_not_contact: "do not contact",
};

/**
 * A spoken or typed CRM action (AUDIT-F4 F11) through the leads service. The lead is found by name in the CRM,
 * by a near-miss of the name ("Harbor Dental"), or by description ("the dentist in Parramatta"): one clear
 * match acts; two or three close ones ask which; none says so. The write goes through /leads/log and the new
 * status is read back independently (/leads/list by status) before anything is called done; the reply is
 * that read-back in one line, naming the lead and its suburb.
 */
export async function runLeadAction(api: LeadsApiLike, action: LeadAction, principal: Pick<Principal, "personId">, eventId?: string): Promise<{ ok: boolean; said: string; verified: boolean | null }> {
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
  const before = action.action === "log" ? (await api.handle("/leads/detail", "GET", {}, q({ id: String(lead.id) }), false)) as { activities?: Array<{ id: number }> } : null;
  const logged = (await api.handle("/leads/log", "POST", { lead: lead.id, outcome: action.outcome, kind, by: principal.personId, ...(eventId ? { event: eventId } : {}) }, q({}), false)) as { duplicate?: boolean };
  // Independent read-back: the lead now lists under that status.
  const listed = (await api.handle("/leads/list", "GET", {}, q({ status: action.outcome, all: "1" }), false)) as { leads?: Array<{ id: number }> };
  let verified = !!listed.leads?.some((l) => l.id === lead.id);
  if (action.action === "log") {
    const after = (await api.handle("/leads/detail", "GET", {}, q({ id: String(lead.id) }), false)) as { activities?: Array<{ id: number; kind: string; outcome: string; by: string }> };
    const previous = new Set(before?.activities?.map((a) => a.id) ?? []);
    // A duplicate response is an acknowledged replay; an ordinary write must produce a fresh activity.
    verified = verified && !!after.activities?.some((a) => (logged.duplicate || !previous.has(a.id)) && a.kind === kind && a.outcome === action.outcome && a.by === principal.personId);
  }
  const words = OUTCOME_WORDS[action.outcome] ?? action.outcome;
  const who = leadLabel(lead);
  // When the lead was not found by his exact words, say who it turned out to be (in the same line).
  const matched = found.how === "fuzzy" || found.how === "description" ? `${found.how === "description" ? "That's" : `I took "${action.lead}" to be`} ${who}. ` : "";
  return verified
    ? { ok: true, said: `${matched}${action.action === "log" ? `Logged a call to ${matched ? lead.name : who} as ${words}` : `Marked ${matched ? lead.name : who} as ${words}`}, confirmed in the CRM.`, verified: true }
    : { ok: false, said: `${matched}I sent it to the CRM, but ${lead.name} doesn't read back as ${words}, so I'm not calling it done.`, verified: false };
}

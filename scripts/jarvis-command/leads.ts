/**
 * CRM actions by voice or typing (Track 2, AUDIT-F4 F11), through the leads service's own API. Pure over
 * the injected API: the live server passes createLeadsApi(root); tests pass a fake.
 */
import type { Principal } from "../identity/principal";
import type { LeadAction } from "./plan";

/** The leads service's own API (scripts/leads/api.ts createLeadsApi().handle). */
export type LeadsApiLike = { handle(path: string, method: string, body: unknown, params: URLSearchParams, remote: boolean): Promise<unknown> };

const OUTCOME_WORDS: Record<string, string> = {
  no_answer: "no answer", voicemail: "voicemail", call_back: "call back", interested: "interested", not_interested: "not interested",
  meeting: "meeting", proposal: "proposal", won: "won", lost: "lost", do_not_contact: "do not contact",
};

/**
 * A spoken or typed CRM action (AUDIT-F4 F11) through the leads service: the lead is found by name in the
 * CRM (one match acts; several ask which; none says so), the write goes through /leads/log, and the new
 * status is read back independently (/leads/list by status) before anything is called done.
 */
export async function runLeadAction(api: LeadsApiLike, action: LeadAction, principal: Pick<Principal, "personId">): Promise<{ ok: boolean; said: string; verified: boolean | null }> {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  if (action.action === "next") {
    const r = (await api.handle("/leads/cards", "GET", {}, q({ n: "1" }), false)) as { cards?: Array<{ leadId: number; name: string; vertical?: string; area?: string; status?: string }> };
    const c = r.cards?.[0];
    return c ? { ok: true, said: `Next to call: ${c.name}${c.vertical ? ` (${c.vertical}${c.area ? `, ${c.area}` : ""})` : ""}. Its call card is in Leads.`, verified: true } : { ok: true, said: "There's no one waiting to be called right now.", verified: true };
  }
  const found = (await api.handle("/leads/search", "GET", {}, q({ q: action.lead }), false)) as { hits?: Array<{ group: string; leadId: number; title: string }> };
  const leads = [...new Map((found.hits ?? []).filter((h) => h.group === "leads").map((h) => [h.leadId, h])).values()];
  const exact = leads.filter((h) => h.title.trim().toLowerCase() === action.lead.trim().toLowerCase());
  const pick = exact.length === 1 ? exact : leads;
  if (!pick.length) return { ok: false, said: `I can't find a lead called ${action.lead} in the CRM, so nothing changed.`, verified: null };
  if (pick.length > 1) return { ok: false, said: `${pick.length} leads match "${action.lead}" (${pick.slice(0, 3).map((h) => h.title).join(", ")}). Which one?`, verified: null };
  const lead = pick[0];
  await api.handle("/leads/log", "POST", { lead: lead.leadId, outcome: action.outcome, kind: action.action === "log" ? "call" : "note", by: principal.personId }, q({}), false);
  // Independent read-back: the lead now lists under that status.
  const listed = (await api.handle("/leads/list", "GET", {}, q({ status: action.outcome, all: "1" }), false)) as { leads?: Array<{ id: number }> };
  const verified = !!listed.leads?.some((l) => l.id === lead.leadId);
  const words = OUTCOME_WORDS[action.outcome] ?? action.outcome;
  return verified
    ? { ok: true, said: action.action === "log" ? `Logged a call to ${lead.title} as ${words}.` : `Marked ${lead.title} as ${words}.`, verified: true }
    : { ok: false, said: `I sent it to the CRM, but ${lead.title} doesn't read back as ${words}, so I'm not calling it done.`, verified: false };
}

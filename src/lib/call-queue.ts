import type { BoardLead } from "./leads";
import { callWindow } from "../../scripts/leads/outreach";

const CALL_STATUSES = new Set(["new", "to_call", "no_answer", "voicemail", "call_back"]);
export const sydneyDay = (at: string | number) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(at));

/** The fields a call decision needs: a client BoardLead and a server crm Lead both carry them. */
export type CallFields = { excluded?: boolean; status: string; phone: string; nextAt: string | null; deal?: { closed: boolean } };

/** A lead we may phone at all: not excluded, not closed, a call status (never an emailed-only, warm
 *  or closed one) and a phone number on file. The pipeline's action text plays no part: no stage
 *  action ever started with "call", so the old text test left the queue empty (audit F1-01). */
export function isCallable(lead: CallFields): boolean {
  return !lead.excluded && !lead.deal?.closed && CALL_STATUSES.has(lead.status) && !!lead.phone.replace(/[^\d]/g, "");
}

/** A call that is due: callable, with a call-back or follow-up date on or before today (Sydney).
 *  The one definition behind the Leads call queue, Today's "Calls to make", Work's call-queue panel
 *  and the `due` count of /leads/calls (the Business "Today's calls" quick action). */
export function isCallDue(lead: CallFields, now = Date.now()): boolean {
  return isCallable(lead) && !!lead.nextAt && Number.isFinite(Date.parse(lead.nextAt)) && sydneyDay(lead.nextAt) <= sydneyDay(now);
}

/** Cards offer a Call button for any callable lead. */
export function isCallAction(lead: BoardLead): boolean {
  return isCallable(lead);
}

/** CRM priority: callbacks first, then score; due time breaks equal priorities. */
export function selectCallQueue(leads: BoardLead[], now = Date.now()): BoardLead[] {
  return leads.filter(l => isCallDue(l, now))
    .sort((a, b) => Number(b.status === "call_back") - Number(a.status === "call_back") ||
      b.score - a.score || Date.parse(a.nextAt!) - Date.parse(b.nextAt!) || a.id - b.id);
}

export function callingHours(now = Date.now()) {
  const window = callWindow(new Date(now));
  return { ...window, banner: window.open ? null :
    /Sunday|holiday/.test(window.why) ? `No calls today · ${window.why} (Sydney time)` :
      `Calling hours closed · ${window.why} (Sydney time)` };
}

export function websiteVerification(lead: BoardLead): string {
  return websiteStateLine(lead, lead.deal.websiteStatus);
}

/** What a lead found by Find says about its own website search (stored on the lead, before any audit has run). */
function discoveryState(lead: { website: string; websiteCheckedAt?: string | null; websiteCheck?: string }): string | null {
  if (lead.website) return null;
  // Wording comes only from the explicit outcome the server stored where the result was known: never from dates or reason text.
  switch (lead.websiteCheck) {
    case "search-unavailable": return "Search unavailable, so the website was not checked · owner to Google";
    case "check-failed": return "Website check couldn't complete · owner to Google";
    case "none-verified": return `Search found no site${lead.websiteCheckedAt ? ` (${lead.websiteCheckedAt.slice(0, 10)})` : ""} · not yet verified · owner to Google`;
    default: return null; // not-checked, or an older API that does not send it
  }
}

/** The one honest line for a lead's website: verified absence, an unknown, a failed check or a listed address. */
export function websiteStateLine(lead: { website: string; websiteCheckedAt?: string | null; websiteCheck?: string }, status?: string): string {
  if (!lead.website && status === "no_website_verified") {
    const date = lead.websiteCheckedAt?.slice(0, 10);
    return `No website (verified${date ? ` ${date}` : "; date not recorded"})`;
  }
  if (status === "not_their_site") return "Website not verified · wrong site";
  if (lead.website && status === "ok") return "Website verified";
  // A saved address is presence, not verification; and a check that did not complete is its own state, never "no website".
  if (lead.website) return status === "unreachable" || status === "bot_protected" ? "Website listed · check failed" : "Website listed · not yet checked";
  if (status === "unreachable" || status === "bot_protected") return "Website not verified · check failed · owner to Google";
  if (status === "no_website_unverified") return "Website not verified · check inconclusive · owner to Google";
  return discoveryState(lead) ?? "Website not verified · owner to Google";
}

/** Historical automated discovery claims are not human confirmation of absence. */
export function honestWebsiteText(text: string, lead?: BoardLead): string {
  if (lead && !lead.website && lead.deal.websiteStatus === "no_website_verified") return text;
  return text.replace(/no website(?: found)?/gi, "Website not verified");
}

export function leadDate(at: string | null): string {
  if (!at || !Number.isFinite(Date.parse(at))) return "Not scheduled";
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

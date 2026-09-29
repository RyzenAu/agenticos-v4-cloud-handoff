// 30-second call-prep cards, built only from CRM data (score reasons, site-audit findings,
// activity history). Never invents a pain point: says "insufficient data" when the CRM doesn't
// have one. No network call, no send, no dial.
import type { Database } from "bun:sqlite";
import { activities, type Lead } from "./crm";
import { isPlacesLead, placesAttributionLine, type LiveLead, type PlacesLive } from "./places-live";
import { issueHook } from "./issues";
import { callOpener, callWindow, DEFAULT_SENDER, type Sender } from "./outreach";
import { isVerifiedFact } from "./score";

export type CardReason = { text: string; verified: boolean };

export type CallCard = {
  leadId: number;
  name: string;
  vertical: string;
  area: string;
  score: number;
  pitch: string;
  status: string;
  phone: string;
  reasons: CardReason[];
  /** True once at least one reason is a directly-observed site fact, not just a score inference. */
  hasVerifiedFact: boolean;
  observation: string;
  opener: string;
  lastContact: { at: string; kind: string; outcome: string; by: string } | null;
  history: { at: string; kind: string; outcome: string; note: string; by: string }[];
  compliance: { doNotContact: boolean; emailOk: boolean; callWindow: { open: boolean; why: string } };
  /** The founder's "how they like to be contacted" note (deals.ts, lead_deals); '' when none. */
  contactPref: string;
  /** Google-sourced lead: its name/phone/etc. came from a live lookup for this card only (never
   *  stored) and must be shown with this attribution. Absent for OSM/manual leads. */
  placesLive?: PlacesLive;
};

function contactPrefOf(db: Database, leadId: number): string {
  try {
    return ((db.query("SELECT contact_pref FROM lead_deals WHERE lead_id = ?").get(leadId) as { contact_pref: string } | null)?.contact_pref) ?? "";
  } catch {
    return ""; // a CRM file that predates lead_deals
  }
}

export function buildCard(db: Database, lead: LiveLead, sender: Sender = DEFAULT_SENDER, now = new Date()): CallCard {
  const history = activities(db, lead.id);
  const doNotContact = lead.status === "do_not_contact";
  const last = history[0];
  const reasons: CardReason[] = lead.reasons.length
    ? lead.reasons.slice(0, 3).map((text) => ({ text, verified: isVerifiedFact(text) }))
    : [{ text: "insufficient data: no score reasons on file", verified: false }];
  // Prefer a verified (directly-observed) reason as the headline observation over a score-only one.
  const observation = lead.reasons.find(isVerifiedFact) ?? lead.reasons[0] ?? "insufficient data: no site-audit finding on file";
  return {
    leadId: lead.id,
    name: lead.name || (isPlacesLead(lead) ? "(Google place: live details unavailable)" : "(name not on file)"),
    vertical: lead.vertical,
    area: lead.area,
    score: lead.score,
    pitch: lead.pitch,
    status: lead.status,
    phone: lead.phone,
    reasons,
    hasVerifiedFact: reasons.some((r) => r.verified),
    observation,
    opener: doNotContact ? "" : lead.phone ? callOpener({ ...lead, hook: issueHook(db, lead) }, sender) : "insufficient data: no phone on file",
    lastContact: last ? { at: last.at, kind: last.kind, outcome: last.outcome, by: last.by } : null,
    history: history.slice(0, 3).map((a) => ({ at: a.at, kind: a.kind, outcome: a.outcome, note: a.note, by: a.by })),
    compliance: { doNotContact, emailOk: lead.emailOk && !doNotContact, callWindow: callWindow(now) },
    contactPref: contactPrefOf(db, lead.id),
    ...(lead.placesLive ? { placesLive: lead.placesLive } : {}),
  };
}

export function renderCard(card: CallCard): string {
  const header = `#${card.leadId} ${card.name} · ${card.vertical} · ${card.area} · score ${card.score} (${card.pitch}) · ${card.status}` +
    `${card.phone ? ` · ${card.phone}` : ""}`;
  const lastLine = card.lastContact
    ? `Last contact: ${card.lastContact.at.slice(0, 16)} ${card.lastContact.kind} → ${card.lastContact.outcome || "logged"}${card.lastContact.by ? ` (${card.lastContact.by})` : ""}`
    : "Last contact: insufficient data: never contacted";
  const complianceLine = `Compliance: ${card.compliance.doNotContact ? "DO NOT CONTACT" : card.compliance.emailOk ? "email OK" : "email not usable"}` +
    ` · calls ${card.compliance.callWindow.open ? "open" : "closed"} (${card.compliance.callWindow.why})`;
  const reasonLine = card.reasons.map((r) => `${r.text}${r.verified ? " [verified]" : " [score-only]"}`).join("; ");
  return [
    header,
    ...(card.contactPref ? [`How they like to be contacted: ${card.contactPref}`] : []),
    `Why: ${reasonLine}`,
    `Observation: ${card.observation}${isVerifiedFact(card.observation) ? " [verified]" : ""}`,
    card.compliance.doNotContact ? "This lead asked not to be contacted." : `Say: ${card.opener}`,
    lastLine,
    complianceLine,
    ...(card.placesLive ? [placesAttributionLine(card.placesLive)] : []),
  ].join("\n");
}

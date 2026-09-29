// The Ctrl/⌘K palette's search: leads, contacts (a phone or email that matched), proposals (a
// draft on disk or a "proposal" outcome) and clients (won leads with a kickoff). Read-only.
import type { Database } from "bun:sqlite";
import { findLead, getKickoff, type Lead } from "./crm";
import { draftFiles } from "./sales-backoffice";

export type SearchHit = {
  group: "leads" | "contacts" | "proposals" | "clients";
  leadId: number;
  title: string;
  detail: string;
};

const digits = (s: string) => s.replace(/\D/g, "");

export function searchCrm(root: string, db: Database, query: string, limit = 8): { query: string; hits: SearchHit[] } {
  const q = query.trim().toLowerCase().slice(0, 80);
  if (q.length < 2) return { query: q, hits: [] };
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const qDigits = digits(q);
  const ids = db.query(`SELECT l.id FROM leads l LEFT JOIN lead_deals d ON d.lead_id = l.id
    WHERE lower(l.name) LIKE $q ESCAPE '\\' OR lower(l.area) LIKE $q ESCAPE '\\' OR lower(l.address) LIKE $q ESCAPE '\\'
      OR lower(l.website) LIKE $q ESCAPE '\\' OR lower(l.emails) LIKE $q ESCAPE '\\' OR lower(COALESCE(d.contact_pref, '')) LIKE $q ESCAPE '\\'
      OR ($digits != '' AND length($digits) >= 4 AND replace(replace(replace(replace(l.phone, ' ', ''), '(', ''), ')', ''), '-', '') LIKE $dq)
      OR CAST(l.id AS TEXT) = $raw
    ORDER BY l.excluded ASC, (lower(l.name) LIKE $prefix ESCAPE '\\') DESC, l.score DESC LIMIT 200`)
    .all({ $q: like, $digits: qDigits, $dq: `%${qDigits}%`, $raw: q.replace(/^#/, ""), $prefix: `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` }) as { id: number }[];

  const groups: Record<SearchHit["group"], SearchHit[]> = { leads: [], contacts: [], proposals: [], clients: [] };
  for (const { id } of ids) {
    const lead = findLead(db, id);
    if (!lead) continue;
    const where = [lead.area, lead.vertical].filter(Boolean).join(" · ");
    const name = lead.name || `Lead #${lead.id}`;
    groups.leads.push({ group: "leads", leadId: lead.id, title: name, detail: `${where}${lead.excluded ? " · excluded" : ""}` });
    const contact = contactMatch(lead, q, qDigits);
    if (contact) groups.contacts.push({ group: "contacts", leadId: lead.id, title: contact, detail: name });
    if (lead.status === "proposal" || draftFiles(root, lead.id).includes("proposal.md"))
      groups.proposals.push({ group: "proposals", leadId: lead.id, title: `Proposal — ${name}`, detail: lead.status === "proposal" ? "Awaiting reply" : "Draft on this PC (not sent)" });
    const kickoff = lead.status === "won" ? getKickoff(db, lead.id) : null;
    if (lead.status === "won") groups.clients.push({ group: "clients", leadId: lead.id, title: name, detail: kickoff ? `Client · ${kickoff.scope}` : "Client · no kickoff yet" });
  }
  const hits = (Object.keys(groups) as SearchHit["group"][]).flatMap((g) => groups[g].slice(0, limit));
  return { query: q, hits };
}

function contactMatch(lead: Lead, q: string, qDigits: string): string | null {
  const email = lead.emails.find((e) => e.toLowerCase().includes(q));
  if (email) return email;
  if (qDigits.length >= 4 && digits(lead.phone).includes(qDigits)) return lead.phone;
  return null;
}

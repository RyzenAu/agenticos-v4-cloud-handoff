// Duplicate detection: two CRM rows that are actually the same business (live case, 24 Sep 2026:
// "St Clair Dental" and "St Clair Family Dental" — OSM mapped the practice twice, and discovery
// then correctly found the same real site, `stclairfamilydental.com.au`, for both). Matched by
// the same discovered/tagged website domain, or the same phone number — either is a strong signal
// two rows are one business. Never deletes a row: `mergeLead` (crm.ts) folds the weaker record
// into the stronger one, keeping it on file as `excluded` with a "duplicate of #<id>" reason.
import type { Database } from "bun:sqlite";
import { listLeads, mergeLead, type Lead } from "./crm";
import { publicUrl } from "./site-audit";

export type DuplicateGroup = { key: string; matchedBy: "domain" | "phone"; leads: Lead[] };

function normalisedDomain(website: string): string | null {
  const url = publicUrl(website);
  return url ? url.hostname.replace(/^www\./, "").toLowerCase() : null;
}

function normalisedPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  // An AU landline/mobile has at least 8 significant digits; anything shorter is too weak a key
  // (a truncated/garbled number could collide two unrelated leads).
  return digits.length >= 8 ? digits : null;
}

/** Groups the CRM's currently open (non-excluded) leads by shared discovered/tagged website
 *  domain, then by shared phone number. A lead only ever appears in one group — domain match
 *  wins over phone when both would apply — so `mergeDuplicates` never double-merges it. */
export function findDuplicateLeads(db: Database): DuplicateGroup[] {
  // 10,000, not 500 (crm.ts's own clamp, raised 25 Sep 2026 for the same reason): a several-
  // thousand-row CRM after the multi-region OSM hunt must not silently skip dedup past row 500.
  const leads = listLeads(db, { limit: 10_000 });
  const seen = new Set<number>();
  const groups: DuplicateGroup[] = [];

  const byDomain = new Map<string, Lead[]>();
  for (const lead of leads) {
    const domain = normalisedDomain(lead.website);
    if (!domain) continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), lead]);
  }
  for (const [domain, group] of byDomain) {
    if (group.length < 2) continue;
    groups.push({ key: domain, matchedBy: "domain", leads: group });
    for (const l of group) seen.add(l.id);
  }

  const byPhone = new Map<string, Lead[]>();
  for (const lead of leads) {
    if (seen.has(lead.id)) continue; // already grouped by domain
    const phone = normalisedPhone(lead.phone);
    if (!phone) continue;
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), lead]);
  }
  for (const [phone, group] of byPhone) {
    if (group.length < 2) continue;
    groups.push({ key: phone, matchedBy: "phone", leads: group });
  }

  return groups;
}

/** How complete a record is — the merge keeps whichever lead in a group scores higher here (a
 *  richer record), breaking ties by the lower id (the one that's been in the CRM longer). */
function richness(lead: Lead): number {
  return (lead.phone ? 1 : 0) + (lead.address ? 1 : 0) + (lead.emails.length ? 1 : 0) + (lead.website ? 1 : 0) + (lead.mapsUrl ? 1 : 0);
}

export type MergeResult = { keepId: number; mergedIds: number[]; matchedBy: "domain" | "phone"; key: string };

/** Detects every duplicate group and merges each one, keeping the richest record. Returns what it
 *  did so a caller can report it — nothing here is silent or irreversible (a merged row is kept,
 *  `excluded`, and its own id is still on file in `excluded_reason`/`merged_into`). */
export function mergeDuplicates(db: Database, opts: { by?: string } = {}): MergeResult[] {
  const results: MergeResult[] = [];
  for (const group of findDuplicateLeads(db)) {
    const ranked = [...group.leads].sort((a, b) => richness(b) - richness(a) || a.id - b.id);
    const [keep, ...rest] = ranked;
    const mergedIds: number[] = [];
    for (const dupe of rest) {
      mergeLead(db, keep.id, dupe.id, { by: opts.by, reason: `duplicate of #${keep.id} (${keep.name || keep.placeId}) — matched by ${group.matchedBy} (${group.key})` });
      mergedIds.push(dupe.id);
    }
    results.push({ keepId: keep.id, mergedIds, matchedBy: group.matchedBy, key: group.key });
  }
  return results;
}

export function renderMergeResults(results: MergeResult[]): string {
  if (!results.length) return "No duplicates found.";
  return results
    .map((r) => `  kept #${r.keepId}, merged #${r.mergedIds.join(", #")} into it (matched by ${r.matchedBy}: ${r.key})`)
    .join("\n");
}

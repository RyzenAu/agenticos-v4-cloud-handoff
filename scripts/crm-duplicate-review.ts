#!/usr/bin/env bun
/**
 * CRM duplicate-contact review — Jev candidate #4 (MINISTRY-JEV-BUSINESS.md, 25 Sep 2026).
 *
 * Deliberately a SEPARATE file from scripts/leads/dedupe.ts, not a change to it: dedupe.ts's
 * `findDuplicateLeads()` feeds `mergeDuplicates()`, which actually merges records, and folding a
 * fuzzy classifier straight into that exact-match function risks quietly turning it into an
 * actor. This file only ever produces a REVIEW list for the owner to approve — it never calls
 * `mergeLead`/`mergeDuplicates`, and it opens `.operator-data/crm.sqlite` READ-ONLY.
 *
 * It is also kept out of scripts/leads/* on purpose: another agent (Crawl4AI) is active in that
 * directory for this task, so this reads the CRM through its existing exported read APIs
 * (`listLeads` from ./leads/crm, `publicUrl` from ./leads/site-audit) rather than touching or
 * living beside its files.
 *
 * Pipeline (typed input/output per the Ministry's schema for this candidate):
 *   1. Deterministic candidate retrieval (normalised phone, domain, name + suburb) — no model
 *      call, ≤10 plausible candidates per incoming lead, grouped via union-find so a business
 *      with several matching branches gets one fan-out, not one call per pair.
 *   2. Jev judges each candidate independently: `relation_i` (choice) and `same_entity_i` (noul),
 *      each question naming its candidate explicitly (a single "does the selected contact match"
 *      question in one fan-out can't see sibling answers — Ministry's own correction).
 *   3. Output is `{ suggestions: [{candidateId, relation, sameEntityProbability}], answers }` per
 *      incoming lead — a REVIEW list only. Nothing here merges, deletes, or authorises anything.
 *
 * CLI:
 *   bun scripts/crm-duplicate-review.ts candidates [--root <dir>]   deterministic pairs only, no Jev call, no cost
 *   bun scripts/crm-duplicate-review.ts review [--root <dir>] [--limit N] [--out <file>]   + Jev judging, prints a REVIEW list
 *   bun scripts/crm-duplicate-review.ts bench [--root <dir>] [--label <name>]   replays the synthetic fixtures and reports precision/latency
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listLeads, type Lead } from "./leads/crm";
import { publicUrl } from "./leads/site-audit";
import { JEV_MODEL, jevAnswers } from "./jev-client";
import { hashInput, recordDecisionShadow } from "./jev-shadow";
import { providerKey } from "./provider-config";

// --- deterministic candidate retrieval ------------------------------------------------------

const AU_STATES = new Set(["nsw", "vic", "qld", "wa", "sa", "tas", "act", "nt"]);
const NAME_STOPWORDS = new Set(["the", "pty", "ltd", "pl", "p/l", "and", "&", "clinic", "centre", "center", "practice"]);

export function normalisePhone(phone: string): string | null {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

export function normaliseDomain(website: string): string | null {
  const url = publicUrl(website || "");
  return url ? url.hostname.replace(/^www\./, "").toLowerCase() : null;
}

/** "Mount Druitt NSW" -> "mount druitt" — the suburb, with the trailing state code dropped. */
export function suburbOf(area: string): string {
  const words = (area || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length && AU_STATES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

export function nameTokens(name: string): Set<string> {
  return new Set(
    (name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w)),
  );
}

/** Jaccard similarity of the two names' significant tokens (order-independent, punctuation- and
 *  common-suffix-insensitive — "St Clair Dental" vs "St Clair Family Dental" scores high). */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / new Set([...ta, ...tb]).size;
}

export const NAME_SIMILARITY_MIN = 0.5;
export const MAX_CANDIDATES = 10;

export type MatchReason = "phone" | "domain" | "name_suburb";
export type CandidateEdge = { a: number; b: number; reason: MatchReason };

/** Every pairwise deterministic match, before grouping — the "no Jev call yet" half of this
 *  feature, safe and free to run as often as wanted. */
export function findCandidateEdges(leads: Lead[]): CandidateEdge[] {
  const active = leads.filter((l) => !l.excluded && l.mergedInto == null);
  const edges: CandidateEdge[] = [];
  const byPhone = new Map<string, Lead[]>();
  const byDomain = new Map<string, Lead[]>();
  for (const lead of active) {
    const phone = normalisePhone(lead.phone);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), lead]);
    const domain = normaliseDomain(lead.website);
    if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), lead]);
  }
  const pushGroup = (group: Lead[], reason: MatchReason) => {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) edges.push({ a: group[i].id, b: group[j].id, reason });
  };
  for (const group of byPhone.values()) if (group.length >= 2) pushGroup(group, "phone");
  for (const group of byDomain.values()) if (group.length >= 2) pushGroup(group, "domain");
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const l1 = active[i], l2 = active[j];
      const suburb1 = suburbOf(l1.area), suburb2 = suburbOf(l2.area);
      if (!suburb1 || suburb1 !== suburb2) continue;
      if (nameSimilarity(l1.name, l2.name) >= NAME_SIMILARITY_MIN) edges.push({ a: l1.id, b: l2.id, reason: "name_suburb" });
    }
  }
  return edges;
}

export type CandidateGroup = { incoming: Lead; candidates: Lead[]; reasons: Map<number, MatchReason[]> };

/** Groups edges via union-find so a business matched three ways (phone AND domain AND name)
 *  becomes one group, not three overlapping pairs — then picks the lowest-id member as the
 *  "incoming" record and caps the rest at MAX_CANDIDATES, per the Ministry's schema comment. */
export function groupCandidates(leads: Lead[]): CandidateGroup[] {
  const byId = new Map(leads.map((l) => [l.id, l]));
  const edges = findCandidateEdges(leads);
  const parent = new Map<number, number>();
  const find = (x: number): number => (parent.get(x) === x || !parent.has(x) ? (parent.set(x, x), x) : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const union = (x: number, y: number) => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  const reasonsByPair = new Map<string, MatchReason[]>();
  for (const e of edges) {
    union(e.a, e.b);
    const key = `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`;
    reasonsByPair.set(key, [...(reasonsByPair.get(key) ?? []), e.reason]);
  }
  const components = new Map<number, number[]>();
  for (const e of edges) {
    for (const id of [e.a, e.b]) {
      const root = find(id);
      if (!components.get(root)?.includes(id)) components.set(root, [...(components.get(root) ?? []), id]);
    }
  }
  const groups: CandidateGroup[] = [];
  for (const memberIds of components.values()) {
    if (memberIds.length < 2) continue;
    const members = memberIds.map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => a.id - b.id);
    const [incoming, ...rest] = members;
    const candidates = rest.slice(0, MAX_CANDIDATES);
    const reasons = new Map<number, MatchReason[]>();
    for (const c of candidates) {
      const key = `${Math.min(incoming.id, c.id)}-${Math.max(incoming.id, c.id)}`;
      reasons.set(c.id, reasonsByPair.get(key) ?? []);
    }
    groups.push({ incoming, candidates, reasons });
  }
  return groups;
}

// --- Jev judging (per candidate: relation_i choice + same_entity_i noul) ---------------------

export type Relation = "same_entity" | "related_but_distinct" | "different_entity" | "insufficient_evidence";
type RelationAnswer = { choice?: Relation; confidence?: number };
type NoulAnswer = { noul?: number };

export type EntityProjection = { id: number | string; name: string; address: string; phone: string; email: string; domain: string };

function project(lead: Lead): EntityProjection {
  return { id: lead.id, name: lead.name, address: lead.address, phone: lead.phone, email: lead.emails[0] ?? "", domain: normaliseDomain(lead.website) ?? "" };
}

export function duplicateQuestions(candidates: EntityProjection[]): Record<string, { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> }> {
  const questions: Record<string, { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> }> = {};
  for (const c of candidates) {
    const who = `candidate #${c.id} ("${c.name || "unnamed"}", ${c.address || "no address on file"})`;
    questions[`relation_${c.id}`] = {
      type: "choice",
      instructions: `Compare the incoming record to ${who}. How are they related? A shared switchboard or a shared domain is NOT the same as shared identity — a franchise or a call centre serving several distinct branches counts as related_but_distinct, not same_entity.`,
      criteria: {
        same_entity: "The same real-world business or location, just recorded twice (a duplicate).",
        related_but_distinct: "Connected (same franchise, shared phone line, group practice) but a genuinely different business or location.",
        different_entity: "No real connection beyond coincidence.",
        insufficient_evidence: "Not enough information in the two records to tell.",
      },
    };
    questions[`same_entity_${c.id}`] = { type: "noul", instructions: `Is ${who} the exact same business/location as the incoming record (a straightforward duplicate)?` };
  }
  return questions;
}

export type DuplicateSuggestion = { candidateId: number | string; relation: Relation; sameEntityProbability: number; reasons: MatchReason[] };
export type SuggestResult = { incomingId: number; suggestions: DuplicateSuggestion[]; answers: Record<string, RelationAnswer | NoulAnswer>; ms: number };

/**
 * Judges one incoming lead against its (already deterministically retrieved) candidates. Never
 * merges or creates anything — the caller decides what, if anything, happens with the REVIEW
 * output. A failed/timed-out call returns every candidate as "insufficient_evidence" rather than
 * silently dropping them (an uncertain pair must stay visible for review, never disappear).
 */
export async function suggestDuplicatePairs(
  group: CandidateGroup,
  options: { key: string; entityKind?: "business_location" | "person"; request?: typeof fetch; timeoutMs?: number },
): Promise<SuggestResult> {
  const started = Date.now();
  const incoming = project(group.incoming);
  const candidates = group.candidates.map(project);
  const fallback = (): SuggestResult => ({
    incomingId: group.incoming.id,
    suggestions: candidates.map((c) => ({ candidateId: c.id, relation: "insufficient_evidence", sameEntityProbability: 0, reasons: group.reasons.get(Number(c.id)) ?? [] })),
    answers: {},
    ms: Date.now() - started,
  });
  if (!options.key || !candidates.length) return fallback();
  // Through the one Jev client (surface crm.duplicates): same budget, bounded retries, a receipt.
  const answers = (await jevAnswers({
    surface: "crm.duplicates",
    caller: "scripts/crm-duplicate-review.ts",
    key: options.key,
    state: { entityKind: options.entityKind ?? "business_location", incoming, candidates },
    questions: duplicateQuestions(candidates),
    request: options.request,
    timeoutMs: options.timeoutMs ?? 4000,
  })) as Record<string, RelationAnswer | NoulAnswer> | null;
  if (!answers) return fallback();
  const suggestions: DuplicateSuggestion[] = candidates.map((c) => {
    const relation = (answers[`relation_${c.id}`] as RelationAnswer | undefined)?.choice ?? "insufficient_evidence";
    const sameEntityProbability = (answers[`same_entity_${c.id}`] as NoulAnswer | undefined)?.noul ?? 0;
    return { candidateId: c.id, relation, sameEntityProbability, reasons: group.reasons.get(Number(c.id)) ?? [] };
  });
  return { incomingId: group.incoming.id, suggestions, answers, ms: Date.now() - started };
}

// --- CLI ---------------------------------------------------------------------------------------

/** Opens the CRM strictly read-only — this feature never writes to crm.sqlite. */
export function openCrmReadOnly(file: string): Database {
  return new Database(file, { readonly: true });
}

function renderReview(results: SuggestResult[], byId: Map<number, Lead>): string {
  const lines: string[] = [];
  for (const r of results) {
    const incoming = byId.get(r.incomingId);
    lines.push(`\nIncoming #${r.incomingId} — ${incoming?.name || "?"} (${incoming?.area || "?"})`);
    for (const s of r.suggestions) {
      const cand = byId.get(Number(s.candidateId));
      lines.push(
        `  ${s.relation.padEnd(20)} p=${s.sameEntityProbability.toFixed(2)}  #${s.candidateId} ${cand?.name || "?"} (${cand?.area || "?"})  [${s.reasons.join(", ")}]`,
      );
    }
  }
  return lines.join("\n") || "No candidate duplicates found.";
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "candidates";
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = flag("root") ?? join(import.meta.dir, "..");
  const file = join(root, ".operator-data", "crm.sqlite");
  const db = openCrmReadOnly(file);
  try {
    const leads = listLeads(db, { limit: 10_000 });
    const byId = new Map(leads.map((l) => [l.id, l]));
    const groups = groupCandidates(leads);
    const candidateCount = groups.reduce((n, g) => n + g.candidates.length, 0);

    if (mode === "candidates") {
      console.log(`${groups.length} candidate group(s), ${candidateCount} candidate pair(s) total, out of ${leads.length} active leads.`);
      for (const g of groups.slice(0, Number(flag("limit") ?? 20))) {
        console.log(`  incoming #${g.incoming.id} "${g.incoming.name}" (${g.incoming.area}) vs ${g.candidates.map((c) => `#${c.id} "${c.name}"`).join(", ")}`);
      }
      return;
    }

    if (mode === "review") {
      const key = providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY");
      if (!key) throw new Error("No TYPESAFE_API_KEY/JEV_API_KEY configured — set one to run Jev judging (see docs/JEV-ROUTING.md).");
      const limit = Number(flag("limit") ?? groups.length);
      const results: SuggestResult[] = [];
      for (const g of groups.slice(0, limit)) {
        const result = await suggestDuplicatePairs(g, { key });
        results.push(result);
        recordDecisionShadow(root, {
          caseId: `crm-dup-${g.incoming.id}`, useCase: "crm-duplicates", timestamp: new Date().toISOString(),
          inputHash: hashInput({ incoming: g.incoming.id, candidates: g.candidates.map((c) => c.id) }),
          questionVersion: "crm-duplicates-v1", model: JEV_MODEL,
          baselineDecision: null, proposedDecision: result.suggestions.map((s) => ({ id: s.candidateId, relation: s.relation })),
          rawAnswers: result.answers, elapsedMs: result.ms, policyVersion: "crm-duplicates-v1",
        });
      }
      const text = renderReview(results, byId);
      console.log(text);
      const out = flag("out");
      if (out) {
        mkdirSync(join(out, ".."), { recursive: true });
        writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
        console.log(`\nSaved ${out}`);
      }
      return;
    }

    throw new Error(`Unknown mode "${mode}". Use candidates, review, or bench (see scripts/crm-duplicate-bench.ts).`);
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();

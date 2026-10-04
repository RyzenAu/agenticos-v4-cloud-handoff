// CRM duplicate-contact review — Jev candidate #4 (MINISTRY-JEV-BUSINESS.md). Deliberately its
// own test file, separate from scripts/leads/dedupe.test.ts (Crawl4AI owns scripts/leads/*).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead, type UpsertLeadInput } from "./leads/crm";
import { testReceipts } from "./model-router/defaults";
import {
  findCandidateEdges, groupCandidates, MAX_CANDIDATES, nameSimilarity, normaliseDomain, normalisePhone,
  suburbOf, suggestDuplicatePairs,
} from "./crm-duplicate-review";

function lead(overrides: Partial<UpsertLeadInput> & { placeId: string; name: string }): UpsertLeadInput {
  return {
    vertical: "dental", area: "Mount Druitt NSW", phone: "", address: "", website: "", mapsUrl: "",
    rating: null, reviews: null, emails: [], emailOk: false, score: 50, pitch: "", reasons: [], googleAt: null,
    ...overrides,
  };
}

function seed(leads: UpsertLeadInput[]) {
  const root = mkdtempSync(join(tmpdir(), "crm-dup-"));
  const db = openCrm(join(root, "crm.sqlite"));
  for (const l of leads) upsertLead(db, l);
  return db;
}

describe("deterministic normalisation", () => {
  test("normalisePhone requires at least 8 significant digits", () => {
    expect(normalisePhone("(02) 9621 1234")).toBe("0296211234");
    expect(normalisePhone("1234")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });

  test("normaliseDomain strips www and scheme", () => {
    expect(normaliseDomain("https://www.stclairfamilydental.com.au/contact")).toBe("stclairfamilydental.com.au");
    expect(normaliseDomain("")).toBeNull();
  });

  test("suburbOf drops the trailing state code", () => {
    expect(suburbOf("Mount Druitt NSW")).toBe("mount druitt");
    expect(suburbOf("Parramatta")).toBe("parramatta");
  });

  test("nameSimilarity is high for a real near-duplicate and low for unrelated names", () => {
    expect(nameSimilarity("St Clair Dental", "St Clair Family Dental")).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity("St Clair Dental", "Parramatta Smiles")).toBeLessThan(0.3);
  });
});

describe("findCandidateEdges / groupCandidates", () => {
  test("the real St Clair Dental / St Clair Family Dental case (24 Sep 2026) matches by domain", () => {
    const db = seed([
      lead({ placeId: "p1", name: "St Clair Dental", website: "https://stclairfamilydental.com.au", area: "St Clair NSW", phone: "0296211111" }),
      lead({ placeId: "p2", name: "St Clair Family Dental", website: "https://www.stclairfamilydental.com.au", area: "St Clair NSW", phone: "0296211112" }),
    ]);
    const leads = (require("./leads/crm") as typeof import("./leads/crm")).listLeads(db, { limit: 10 });
    const edges = findCandidateEdges(leads);
    expect(edges.some((e) => e.reason === "domain")).toBe(true);
    const groups = groupCandidates(leads);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(1);
  });

  test("matches by shared phone even with different domains", () => {
    const db = seed([
      lead({ placeId: "p1", name: "Smile Dental", phone: "0298765432", website: "https://smiledental.com.au" }),
      lead({ placeId: "p2", name: "Smile Dental Clinic", phone: "(02) 9876 5432", website: "https://smile-dental-clinic.com.au" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const groups = groupCandidates(listLeads(db, { limit: 10 }));
    expect(groups).toHaveLength(1);
  });

  test("matches by name + suburb similarity when phone and domain differ", () => {
    const db = seed([
      lead({ placeId: "p1", name: "Mount Druitt Family Dental", area: "Mount Druitt NSW" }),
      lead({ placeId: "p2", name: "Mount Druitt Dental", area: "Mount Druitt NSW" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const groups = groupCandidates(listLeads(db, { limit: 10 }));
    expect(groups).toHaveLength(1);
    expect(groups[0].reasons.get(groups[0].candidates[0].id)).toContain("name_suburb");
  });

  test("never groups unrelated leads, and excludes already-merged/excluded rows", () => {
    const db = seed([
      lead({ placeId: "p1", name: "Alpha Dental", area: "Parramatta NSW", phone: "0290000001" }),
      lead({ placeId: "p2", name: "Beta Legal", area: "Blacktown NSW", phone: "0290000002" }),
      lead({ placeId: "p3", name: "Alpha Dental Clinic", area: "Parramatta NSW", phone: "0290000001", excluded: true, excludedReason: "duplicate of #1" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const groups = groupCandidates(listLeads(db, { includeExcluded: true, limit: 10 }));
    expect(groups).toHaveLength(0);
  });

  test("caps candidates at MAX_CANDIDATES for one incoming lead", () => {
    const leads = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => lead({ placeId: `p${i}`, name: "Chain Dental", phone: "0290000000" }));
    const db = seed(leads);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const groups = groupCandidates(listLeads(db, { limit: 50 }));
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates.length).toBe(MAX_CANDIDATES);
  });
});

describe("suggestDuplicatePairs — never merges, review-only output", () => {
  test("the Jev call goes through the one Jev client and writes a router receipt", async () => {
    const db = seed([
      lead({ placeId: "r1", name: "Harbour Dental", website: "https://harbourdental.com.au" }),
      lead({ placeId: "r2", name: "Harbour Dental Clinic", website: "https://harbourdental.com.au" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const [group] = groupCandidates(listLeads(db, { limit: 10 }));
    const candidateId = group.candidates[0].id;
    const request = (async () => new Response(JSON.stringify({ answers: { [`relation_${candidateId}`]: { choice: "same_entity" }, [`same_entity_${candidateId}`]: { noul: 0.9 } } }))) as unknown as typeof fetch;
    const before = testReceipts.receipts.length;
    const result = await suggestDuplicatePairs(group, { key: "k", request });
    expect(result.suggestions[0]).toMatchObject({ relation: "same_entity", sameEntityProbability: 0.9 });
    const mine = testReceipts.receipts.slice(before).filter((r) => r.caller === "scripts/crm-duplicate-review.ts (crm.duplicates)");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ task: "jev.decision", outcome: "succeeded", httpStatus: 200 });
  });

  test("asks a relation_i and same_entity_i question per candidate, named explicitly", async () => {
    const db = seed([
      lead({ placeId: "p1", name: "St Clair Dental", website: "https://stclairfamilydental.com.au" }),
      lead({ placeId: "p2", name: "St Clair Family Dental", website: "https://stclairfamilydental.com.au" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const [group] = groupCandidates(listLeads(db, { limit: 10 }));
    let sentQuestions: Record<string, unknown> = {};
    const request = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sentQuestions = body.questions;
      const candidateId = group.candidates[0].id;
      return {
        ok: true,
        json: async () => ({ answers: { [`relation_${candidateId}`]: { choice: "same_entity" }, [`same_entity_${candidateId}`]: { noul: 0.97 } } }),
      } as Response;
    }) as typeof fetch;
    const result = await suggestDuplicatePairs(group, { key: "k", request });
    const candidateId = group.candidates[0].id;
    expect(Object.keys(sentQuestions)).toEqual(expect.arrayContaining([`relation_${candidateId}`, `same_entity_${candidateId}`]));
    expect(result.suggestions[0]).toMatchObject({ candidateId, relation: "same_entity", sameEntityProbability: 0.97 });
  });

  test("a failed/timed-out call marks every candidate insufficient_evidence, never dropped", async () => {
    const db = seed([
      lead({ placeId: "p1", name: "A Dental" }),
      lead({ placeId: "p2", name: "A Dental Clinic" }),
    ]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const [group] = groupCandidates(listLeads(db, { limit: 10 }));
    const request = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await suggestDuplicatePairs(group, { key: "k", request });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].relation).toBe("insufficient_evidence");
  });

  test("without a key, abstains the same safe way instead of guessing", async () => {
    const db = seed([lead({ placeId: "p1", name: "A Dental" }), lead({ placeId: "p2", name: "A Dental Clinic" })]);
    const { listLeads } = require("./leads/crm") as typeof import("./leads/crm");
    const [group] = groupCandidates(listLeads(db, { limit: 10 }));
    const result = await suggestDuplicatePairs(group, { key: "" });
    expect(result.suggestions[0].relation).toBe("insufficient_evidence");
  });

  test("this module never imports mergeLead/mergeDuplicates — suggestions only (comments may still discuss them)", () => {
    const source = require("node:fs").readFileSync(join(import.meta.dir, "crm-duplicate-review.ts"), "utf8");
    const imports = source.match(/^import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?$/gm) ?? [];
    for (const line of imports) expect(line).not.toMatch(/\bmergeLead\b|\bmergeDuplicates\b/);
  });
});

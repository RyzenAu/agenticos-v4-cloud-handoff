// Stage A pricing review (28 Sep 2026): H1, M1, L3, L4, L5, L7. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { dealEconomics, DEFAULT_PROBABILITY, DEFAULT_STUCK_DAYS, type Rules } from "./leads/deals";
import { dealBreakdown } from "../src/components/operator/deal-block";
import { aud as workbenchAud } from "../src/components/business/economics-workbench";
import { catalogueLabels } from "../src/lib/price-status";
import { packageEconomicsMatrix, PRICE_RECOMMENDATION } from "../src/lib/business-economics";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { buildDashboard, packageWarningException } from "./receptionist/dashboard";

const RULES: Rules = { probability: { ...DEFAULT_PROBABILITY }, stuckDays: { ...DEFAULT_STUCK_DAYS }, monthsCounted: 12 };
const DEAL = { offer: null, packageId: null, setupCents: null, monthlyCents: null, probability: null, expectedClose: null, contactPref: "", updatedBy: "", updatedAt: null };
const VIEW = { stage: "proposal" as const, closed: false };
const setupProposed = (getReceptionistPackage("receptionist-essential").pricing.setupStatus ?? "approved") !== "approved";

describe("H1 / M1: one ex-GST breakdown, website build labelled, no 'A$0 setup'", () => {
  test("'both' reads A$1,500 website build + A$699/mo × 12, ex GST, with the incl-GST total", () => {
    const e = dealEconomics({ pitch: "both" }, VIEW, { ...DEAL, packageId: "receptionist-essential" }, RULES);
    const text = dealBreakdown(e as never, 12);
    expect(text).toStartWith("A$1,500 website build + A$699/mo × 12, ex GST · ");
    expect(text).not.toContain("1,650 setup");
    expect(text).not.toContain("A$0 setup");
    if (setupProposed) expect(text).toContain("Setup: quoted separately once approved");
    expect(e.valueCents).toBe(150_000 + 69_900 * 12);
  });
  test("receptionist-only with a proposed setup fee never shows a setup figure", () => {
    const e = dealEconomics({ pitch: "receptionist" }, VIEW, { ...DEAL, packageId: "receptionist-professional" }, RULES);
    const text = dealBreakdown(e as never, 12);
    expect(text).toStartWith("A$1,099/mo × 12, ex GST");
    if (setupProposed) {
      expect(text).not.toMatch(/A\$[\d,]+ (receptionist )?setup/);
      expect(text).toContain("Setup: quoted separately once approved");
    }
  });
  test("no package chosen is marked as an assumption", () => {
    const e = dealEconomics({ pitch: "receptionist" }, VIEW, DEAL, RULES);
    expect(e.packageState).toEqual({ state: "assumed", note: "Package not chosen (Essential assumed for the estimate)" });
  });
});

describe("L3: legacy or unknown package ids are shown, not hidden", () => {
  test("a legacy alias and an unknown id become visible exceptions", () => {
    const legacy = packageWarningException({ slug: "synthetic-dental", id: "dental-receptionist", kind: "legacy-alias", resolvedTo: "Essential" });
    expect(legacy.title).toContain('legacy package id "dental-receptionist"');
    expect(legacy.detail).toContain("Resolved to Essential");
    const unknown = packageWarningException({ slug: "synthetic-law", id: "legal-gold", kind: "unknown" });
    expect(unknown.title).toContain('unknown package id "legal-gold"');
  });
  test("buildDashboard lists package warnings in its exceptions", () => {
    const now = Date.now();
    const model = buildDashboard({
      now, feed: { ok: true, generatedAt: new Date(now).toISOString(), windowDays: 30, view: "metadata", organizations: [], totals: { calls: 0, completed: 0, failed: 0, avgDurationSeconds: null, totalMinutes: 0, byOutcome: [], bySentiment: [], qaGraded: 0, qaFlagged: 0, qaCriticalOpen: 0, triagePending: 0, triageDone: 0, oldestPendingTriageAt: null }, calls: [], followUps: [], clients: [], deployment: null } as never,
      agent: { ok: false, reason: "synthetic" } as never, numberFacts: { ok: false, reason: "synthetic" } as never, twilio: { ok: false, reason: "synthetic" } as never,
      packageWarnings: [{ slug: "synthetic-dental", id: "dental-receptionist", kind: "legacy-alias", resolvedTo: "Essential" }],
    });
    expect(model.exceptions.map((x) => x.id)).toContain("package:synthetic-dental");
  });
});

describe("L4: dashboard labels come from the catalogue", () => {
  test("labels follow each tier's status", () => {
    const labels = catalogueLabels();
    const allApproved = RECEPTIONIST_PACKAGES.every((p) => p.pricing.status === "approved");
    expect(labels.monthly).toBe(`Catalogue price (${allApproved ? "approved" : RECEPTIONIST_PACKAGES.some((p) => p.pricing.status === "approved") ? "partly approved" : "proposed"}), ex GST`);
    const proposed = catalogueLabels([{ pricing: { ...RECEPTIONIST_PACKAGES[0].pricing, status: "proposed", setupStatus: "proposed" } } as never]);
    expect(proposed.monthly).toBe("Catalogue price (proposed), ex GST");
    expect(proposed.setup).toContain("Proposed setup fee, not approved");
  });
});

describe("L5: setup revenue is a scenario while the setup fee is proposed", () => {
  test("PRICE_RECOMMENDATION and the economics matrix carry setupStatus and a scenario note", () => {
    const entry = [...RECEPTIONIST_PACKAGES].sort((a, b) => a.tier - b.tier)[0];
    const status = entry.pricing.setupStatus ?? entry.pricing.status;
    expect((PRICE_RECOMMENDATION as { setupStatus?: string }).setupStatus).toBe(status);
    for (const row of packageEconomicsMatrix()) {
      const pkg = getReceptionistPackage(row.packageId);
      const s = pkg.pricing.setupStatus ?? pkg.pricing.status;
      expect(row.setupStatus).toBe(s);
      if (s !== "approved") expect((row as { setupNote?: string }).setupNote).toContain("SCENARIO");
    }
  });
});

describe("L7: the workbench always prints A$", () => {
  test("A$ prefix, en-AU grouping, two decimals", () => {
    expect(workbenchAud(349_500)).toBe("A$3,495.00");
    expect(workbenchAud(-150)).toBe("-A$1.50");
    expect(workbenchAud(null)).toBe("Not defined");
  });
});

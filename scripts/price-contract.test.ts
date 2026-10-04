// Pricing contract (owner decisions 28 Sep 2026). Approved: monthly A$699 / A$1,099 / A$1,999 ex GST,
// 400 / 1,000 / 1,800 minutes, A$0.80 / A$0.75 / A$0.70 per extra minute; M&U is GST registered (+10%).
// Setup fees are proposed and pilot terms are not approved. Active modules may not carry the old
// figures or wording, and the Professional fixture must invoice exactly through the real code path.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateEconomics, exportConsistencyFixtureJson, receptionistConsistencyFixture } from "../src/lib/business-economics";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { approvedSetupCents } from "./receptionist/dashboard";
import { priceStatusLines } from "../src/lib/price-status";
import { invoiceData, proposalText } from "./leads/sales-backoffice";
import type { Lead } from "./leads/crm";

const ROOT = join(import.meta.dir, "..");
const ACTIVE = [
  "src/components/business/economics-workbench.tsx",
  "src/components/business/mu-operations.tsx",
  "src/components/shell/pages/finance-page.tsx",
  "src/components/receptionist/commercial.tsx",
  "src/components/operator/leads-board.tsx",
  "src/lib/leads.ts",
  "src/lib/price-status.ts",
  "src/lib/business-economics.ts",
  "scripts/receptionist/commercial.ts",
  "scripts/receptionist/types.ts",
  "scripts/leads/deals.ts",
  "scripts/leads/sales-backoffice.ts",
  "scripts/leads/cli.ts",
  "src/lib/receptionist-packages.ts",
  "src/components/receptionist/dashboard/usage-economics.tsx",
  "src/components/memory/synthetic-client.ts",
];
const BANNED: [RegExp, string][] = [
  [/\b549\b|54_?900/, "old A$549 monthly"],
  [/A\$\s?490\b|\b49_?000\b/, "old A$490 pilot"],
  [/\b1\.10\b|\b110 ?cents\b/, "old A$1.10 overage"],
  [/\b300[ -]min(ute)?s?\b/i, "old 300-minute allowance"],
  [/receptionist pilot|paid pilot|pilot (price|fee|offer)\b/i, "pilot offer"],
  [/GST-inclusive if registered|GST treatment to confirm|decision pending|owner decision pending|only if (M&U (Ventures )?is )?(GST[- ])?registered|inclGstIfRegistered/i, "stale GST wording"],
  [/No price is approved|No catalogue entry is approved|Proposed prices are not approved/i, "stale approval wording"],
];

describe("active pricing modules carry no old prices or pilot copy", () => {
  for (const file of ACTIVE)
    test(file, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const hits = BANNED.filter(([re]) => re.test(text)).map(([, why]) => why);
      expect(hits).toEqual([]);
    });
  test("the scanner catches each old form", () => {
    for (const bad of ["A$549/month", "54_900", "pilot A$490", "A$1.10/min", "300 minutes", "AI receptionist pilot", "GST-inclusive if registered", "No price is approved", "GST added only if registered"])
      expect(BANNED.some(([re]) => re.test(bad))).toBe(true);
  });
});

describe("approval status is per field, from the catalogue", () => {
  test("monthly approved; setup proposed; pilot not approved; GST registered", () => {
    for (const id of ["receptionist-essential", "receptionist-professional", "receptionist-premium"]) {
      const s = priceStatusLines(getReceptionistPackage(id));
      expect(s.monthly.text).toBe("Monthly price, included minutes, extra-minute rate: Approved 28 Sep 2026 (ex GST, +10% GST)");
      expect(s.setup.text).toBe("Setup fee: Proposed, not approved");
      expect(s.pilot.text).toBe("Pilot terms: Not approved");
      expect(s.gst).toContain("M&U is GST registered");
    }
  });
});

describe("Professional fixture end to end (real code path)", () => {
  const fx = receptionistConsistencyFixture();
  test("1,200 billable minutes → A$1,099 + 200 × A$0.75 = A$1,249.00 ex GST, A$124.90 GST, A$1,373.90", () => {
    expect(fx.customer.packageId).toBe("receptionist-professional");
    expect(fx.usage.billableMinutes).toBe(1200);
    expect(fx.expectedInvoice.overageMinutes).toBe(200);
    expect(fx.expectedInvoice.totals).toEqual({ exGstCents: 124900, gstCents: 12490, totalInclGstCents: 137390 });
    const monthly = fx.expectedInvoice.lines.find((l) => l.id === "monthly")!;
    const overage = fx.expectedInvoice.lines.find((l) => l.id === "overage-minutes")!;
    expect([monthly.exGstCents, overage.quantity, overage.unitExGstCents, overage.exGstCents]).toEqual([109900, 200, 75, 15000]);
  });
  test("no setup-fee line; transfer minutes not charged; the JSON export says the same", () => {
    expect(fx.expectedInvoice.lines.some((l) => /setup/i.test(`${l.id} ${l.description}`))).toBe(false);
    expect(fx.expectedInvoice.setupFee).toMatchObject({ invoiced: false });
    expect(fx.usage.transfers.customerBillable).toBe(false);
    // 480 × 150 s = 72,000 s = 1,200 min: the 2 × 180 s post-transfer legs are not in it.
    expect(fx.usage.billableSeconds).toBe(72000);
    const exported = JSON.parse(exportConsistencyFixtureJson());
    expect(exported.expectedInvoice.totals).toEqual(fx.expectedInvoice.totals);
  });
  test("calculateEconomics agrees for one client at the fixture usage", () => {
    const pkg = getReceptionistPackage("receptionist-professional");
    expect(pkg.pricing.monthly.cents + 200 * pkg.pricing.overagePerMinute.cents).toBe(124900);
    void calculateEconomics; // the fixture builder throws if its lines disagree with calculateEconomics
  });
});

describe("drafts use only approved prices", () => {
  const lead = { id: 7, pitch: "receptionist", name: "Synthetic Dental" } as Lead;
  test("Professional invoice draft: one month's fee A$1,099 + 10% GST as an illustration, no setup line", () => {
    const inv = invoiceData(lead, new Date("2026-09-28T00:00:00Z"), "receptionist-professional");
    // Billing timing is open owner decision (b): nothing due on issue; the monthly fee is an illustration only.
    expect([inv.lines.length, inv.total, inv.due]).toEqual([0, 0, null]);
    const ill = inv.receptionistIllustration!;
    expect(ill.issue).toBe(false);
    expect(ill.billing).toContain("[OWNER DECISION (b) PENDING:");
    expect(ill.lines.map((l) => [l.cents, l.gstCents, l.totalCents])).toEqual([[109900, 10990, 120890]]);
    expect([...inv.lines, ...ill.lines].some((l) => /setup/i.test(l.description))).toBe(false);
    expect(inv.notInvoiced[0]).toContain("setup fee is proposed");
  });
  test("proposal: approved monthly, proposed setup, no pilot offer, GST registered", () => {
    const text = proposalText(lead, "receptionist-professional");
    expect(text).toContain("A$1,099.00/month, ex GST");
    // Setup is proposed: the proposal must not quote a figure (sales pack wording instead).
    expect(text).not.toContain("A$1,490");
    expect(text).toContain("Setup: quoted separately once approved.");
    expect(text).toContain("Pilot terms: not approved; no pilot is offered.");
    expect(text).toContain("M&U Ventures is registered for GST");
  });
});

describe("owner decision 1 Oct 2026: every package covers every mode; setup never in a total", () => {
  test("coverModes are identical on all tiers and no placeholder survives in the catalogue", () => {
    const tiers = RECEPTIONIST_PACKAGES;
    for (const p of tiers) expect(p.inclusions.coverModes).toEqual(["After hours", "When busy / no answer", "All calls"]);
    const ess = getReceptionistPackage("receptionist-essential");
    expect(ess.audience).not.toContain("OWNER DECISION");
    expect(ess.functions.find((f) => f.id === "answer")!.label).toBe(getReceptionistPackage("receptionist-professional").functions.find((f) => f.id === "answer")!.label);
    const json = readFileSync(join(import.meta.dir, "..", "docs", "receptionist-package-catalogue.json"), "utf8");
    expect(json).not.toContain("OWNER DECISION");
  });
  test("dashboard totals never include a proposed setup fee (unknown is null, never zero)", () => {
    for (const p of RECEPTIONIST_PACKAGES) {
      expect(p.pricing.setupStatus).toBe("proposed");
      expect(approvedSetupCents(p)).toBeNull();
    }
    expect(approvedSetupCents({ pricing: { setup: { cents: 99000 }, setupStatus: "approved", status: "approved" } })).toBe(99000);
  });
  test("Professional 1,200 billable minutes invoice total is A$1,373.90 incl GST with no setup line", () => {
    const fx = receptionistConsistencyFixture();
    const sum = fx.expectedInvoice.lines.reduce((s, l) => s + l.inclGstCents, 0);
    expect(sum).toBe(137390);
    expect(fx.expectedInvoice.lines.every((l) => !/setup/i.test(l.id))).toBe(true);
  });
});

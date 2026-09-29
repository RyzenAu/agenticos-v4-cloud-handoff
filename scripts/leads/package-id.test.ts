// The lead's chosen receptionist package drives the CRM deal value and the proposal / invoice drafts,
// through the real /leads API routes on a temp CRM (synthetic lead; nothing is sent).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead, type Lead } from "./crm";
import { createLeadsApi } from "./api";
import { readDraft } from "./sales-backoffice";
import { getReceptionistPackage } from "../../src/lib/receptionist-packages";

function lead(db: Database): Lead {
  return upsertLead(db, {
    placeId: `osm:node/${Math.random()}`, source: "osm", attribution: "© OpenStreetMap contributors", vertical: "dental",
    area: "Blacktown NSW", name: "Synthetic Dental (fictional)", phone: "02 9000 0000", address: "", website: "", mapsUrl: "", rating: null,
    reviews: null, emails: [], emailOk: false, score: 50, pitch: "receptionist", reasons: [], googleAt: null,
  });
}
async function withApi(run: (api: ReturnType<typeof createLeadsApi>, root: string, l: Lead) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "package-id-"));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  try {
    const api = createLeadsApi(root, { db, hunt: () => ({ status: "never", ranAt: null, area: null, added: 0, errors: [], overdue: false }) as never });
    await run(api, root, lead(db));
  } finally {
    db.close();
    Bun.gc(true);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}
const P = new URLSearchParams();
const PRO = getReceptionistPackage("receptionist-professional").pricing;

describe("package id wiring", () => {
  test("a Professional lead: deal value, A$1,208.90 invoice and an A$1,099 proposal with setup quoted separately", () => withApi(async (api, root, l) => {
    const saved = await api.handle("/leads/deal", "POST", { lead: l.id, packageId: "receptionist-professional", by: "usman" }, P, false) as any;
    expect(saved.deal.record.packageId).toBe("receptionist-professional");
    expect(saved.deal.economics).toMatchObject({ packageId: "receptionist-professional", monthlyCents: PRO.monthly.cents, priceStatus: PRO.status });
    // Drafts with no packageId in the request follow the package saved on the deal.
    await api.handle("/leads/deposit-invoice", "POST", { lead: l.id }, P, false);
    const invoice = readDraft(root, l.id, "deposit-invoice.md");
    expect(invoice).toContain("Booking Receptionist · Professional: one month's fee");
    // Billing timing is open owner decision (b) (review T5 R6): the fee is an illustration, never due or issued.
    expect(invoice).toContain("Illustration only: A$1,099.00 ex GST + A$109.90 GST = A$1,208.90");
    expect(invoice).toContain("[OWNER DECISION (b) PENDING:");
    expect(invoice).toContain("Due date: none (nothing is due from this draft)");
    expect(invoice).not.toContain("TOTAL DUE");
    expect(invoice).toContain("not invoiced; the setup fee is proposed");
    await api.handle("/leads/proposal", "POST", { lead: l.id, packageId: "receptionist-professional" }, P, false);
    const proposal = readDraft(root, l.id, "proposal.md");
    expect(proposal).toContain("A$1,099.00/month, ex GST");
    expect(proposal).toContain("Setup: quoted separately once approved.");
    expect(proposal).not.toContain("A$1,490");
  }));

  test("a request naming a different package from the saved one is refused (audit F1-02)", () => withApi(async (api, root, l) => {
    await api.handle("/leads/deal", "POST", { lead: l.id, packageId: "receptionist-professional", by: "usman" }, P, false);
    await expect(api.handle("/leads/deposit-invoice", "POST", { lead: l.id, packageId: "receptionist-premium" }, P, false))
      .rejects.toThrow("This deal is saved as Professional, not Premium");
    expect(() => readDraft(root, l.id, "deposit-invoice.md")).toThrow();
    // The matching package drafts as before.
    await api.handle("/leads/deposit-invoice", "POST", { lead: l.id, packageId: "receptionist-professional" }, P, false);
    expect(readDraft(root, l.id, "deposit-invoice.md")).toContain("Illustration only: A$1,099.00 ex GST + A$109.90 GST = A$1,208.90");
  }));

  test("no saved package: a draft naming the assumed Essential is refused too (the F1-02 drawer request)", () => withApi(async (api, root, l) => {
    for (const path of ["/leads/proposal", "/leads/deposit-invoice"])
      await expect(api.handle(path, "POST", { lead: l.id, packageId: "receptionist-essential" }, P, false)).rejects.toThrow("Choose the receptionist package");
    expect(() => readDraft(root, l.id, "proposal.md")).toThrow();
    expect(() => readDraft(root, l.id, "deposit-invoice.md")).toThrow();
  }));

  test("no package anywhere: drafts are refused (never silently Essential); the deal says Essential is assumed", () => withApi(async (api, root, l) => {
    await expect(api.handle("/leads/deposit-invoice", "POST", { lead: l.id }, P, false)).rejects.toThrow("Choose the receptionist package");
    await expect(api.handle("/leads/proposal", "POST", { lead: l.id }, P, false)).rejects.toThrow("Choose the receptionist package");
    expect(() => readDraft(root, l.id, "deposit-invoice.md")).toThrow();
    const detail = await api.handle("/leads/detail", "GET", null, new URLSearchParams(`id=${l.id}`), false) as any;
    expect(detail.deal.economics.packageState).toEqual({ state: "assumed", note: "Package not chosen (Essential assumed for the estimate)" });
  }));

  test("an unknown package id saved on the deal is never priced as Essential", () => withApi(async (api, root, l) => {
    // Save a real package (creates the column), then overwrite it with an id the catalogue doesn't
    // have, as an older build or a hand edit could.
    await api.handle("/leads/deal", "POST", { lead: l.id, packageId: "receptionist-premium", by: "usman" }, P, false);
    const crm = new Database(join(root, ".operator-data", "crm.sqlite"));
    crm.query("UPDATE lead_deals SET package_id = ? WHERE lead_id = ?").run("receptionist-gold", l.id);
    crm.close();
    const detail = await api.handle("/leads/detail", "GET", null, new URLSearchParams(`id=${l.id}`), false) as any;
    expect(detail.deal.economics).toMatchObject({ packageId: null, monthlyCents: 0, valueCents: 0, valueSource: "unknown package" });
    expect(detail.deal.economics.packageState.state).toBe("unknown");
    await expect(api.handle("/leads/proposal", "POST", { lead: l.id }, P, false)).rejects.toThrow('("receptionist-gold") isn\'t in the catalogue');
  }));

  test("an invalid package id is rejected by drafts and by the deal, and nothing is written", () => withApi(async (api, root, l) => {
    await expect(api.handle("/leads/proposal", "POST", { lead: l.id, packageId: "receptionist-platinum" }, P, false)).rejects.toThrow("packageId must be one of");
    await expect(api.handle("/leads/deposit-invoice", "POST", { lead: l.id, packageId: 42 }, P, false)).rejects.toThrow("packageId must be one of");
    await expect(api.handle("/leads/deal", "POST", { lead: l.id, packageId: "receptionist-platinum", by: "usman" }, P, false)).rejects.toThrow("Package must be one of");
    expect(() => readDraft(root, l.id, "proposal.md")).toThrow();
    const detail = await api.handle("/leads/detail", "GET", null, new URLSearchParams(`id=${l.id}`), false) as any;
    expect(detail.deal.record.packageId).toBeNull();
  }));
});

describe("one ex-GST basis for deals, proposals and invoices", () => {
  test("website A$1,650 incl. GST is A$1,500 ex GST everywhere a deal or draft states it", () => withApi(async (api, root, l) => {
    await api.handle("/leads/deal", "POST", { lead: l.id, offer: "both", packageId: "receptionist-essential", by: "usman" }, P, false);
    const detail = await api.handle("/leads/detail", "GET", null, new URLSearchParams(`id=${l.id}`), false) as any;
    // A$1,500 + A$699 × 12 = A$9,888 ex GST (not the mixed A$10,038); A$10,876.80 incl. GST.
    expect(detail.deal.economics).toMatchObject({ setupCents: 150_000, monthlyCents: 69_900, valueCents: 988_800, valueInclGstCents: 1_087_680, gstBasis: "ex GST" });
    await api.handle("/leads/proposal", "POST", { lead: l.id }, P, false);
    expect(readDraft(root, l.id, "proposal.md")).toContain("Website: A$1,500.00 ex GST + A$150.00 GST = A$1,650.00 incl. GST");
    await api.handle("/leads/deposit-invoice", "POST", { lead: l.id }, P, false);
    const invoice = readDraft(root, l.id, "deposit-invoice.md");
    expect(invoice).toContain("A$750.00 ex GST + A$75.00 GST = A$825.00");
    // Due on issue: the website deposit only (A$750 + A$75 GST = A$825). The receptionist's monthly
    // fee is an illustration only (decision (b) open): A$699 + A$69.90 = A$768.90.
    expect(invoice).toContain("Subtotal ex GST: A$750.00");
    expect(invoice).toContain("TOTAL DUE: A$825.00");
    expect(invoice).toContain("Illustration only: A$699.00 ex GST + A$69.90 GST = A$768.90");
  }));
});

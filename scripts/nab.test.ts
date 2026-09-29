import { describe, expect, test } from "bun:test";
import { createNabSyntheticService, type ConsentInput } from "./nab/service";
import { cashFlow, minorUnits, normalise, supportedSpendCategory, type NabRow } from "./nab/normalise";
import { fixture, type FixtureId } from "./nab/fixtures";
import { financeInsights } from "./nab/insights";
import { activateLiveNab, createNabBasiqSyntheticAdapter } from "./nab/basiq-adapter";
const owner = { tenantId: "tenant-a", ownerId: "owner-a" };
const grant: ConsentInput = { acknowledgement: "synthetic-only", purpose: "cash-flow-review", scopes: ["accounts", "balances", "transactions"], accountIds: ["syn-business"], durationDays: 1 };
function setup() {
  let time = Date.parse("2026-09-27T00:00:00Z");
  const service = createNabSyntheticService({ now: () => time });
  const consent = service.consent(owner, grant);
  const load = (fixtureId: FixtureId = "cashflow-v1") => service.importFixture(owner, { fixtureId, ownerInitiated: true, generation: consent.generation });
  return { service, consent, load, advance: (milliseconds: number) => { time += milliseconds; } };
}
describe("NAB synthetic integer normalisation", () => {
  test("decimal parsing never uses float rounding", () => {
    expect(minorUnits("0.29")).toBe(29); expect(minorUnits("-12.3")).toBe(-1230);
    for (const value of ["1.005", "1e3", "NaN", "$1.00", "1,000", " 1", "01.00", "99999999999999999"]) expect(() => minorUnits(value)).toThrow();
  });
  test("rejects currency, direction, negative magnitude, invalid date and non-synthetic IDs", () => {
    const row = fixture("cashflow-v1").rows[0];
    for (const patch of [{ currency: "USD" }, { currency: "" }, { direction: "unknown" }, { amount: "-1.00" }, { date: "2026-02-30" }, { id: "real-id" }]) expect(() => normalise({ ...row, ...patch } as NabRow)).toThrow();
  });
  test("pending, transfers and refunds do not inflate income or expenses", () => {
    expect(cashFlow(fixture("cashflow-v1").rows.map(normalise))).toEqual({ currency: "AUD", incomeMinor: 100000, expensesMinor: 10000, refundsReceivedMinor: 2000, refundsPaidMinor: 500, netCashMinor: 91500, pendingCount: 1, transferCount: 2, gst: "not-inferred", accountingProfit: null });
    expect(supportedSpendCategory("SaaS")).toBe("software");
  });
  test("aggregate integer overflow fails", () => {
    const row = normalise(fixture("cashflow-v1").rows[0]);
    expect(() => cashFlow(Array.from({ length: 10 }, () => ({ ...row, minor: Number.MAX_SAFE_INTEGER })))).toThrow("MONEY_OVERFLOW");
  });
});

describe("NAB reviewable insights and provider boundary", () => {
  test("matches exact synthetic invoice without marking paid; refunds and pending are excluded", () => {
    const rows = fixture("cashflow-v1").rows.map(normalise);
    expect(financeInsights(rows).invoiceMatches).toHaveLength(1);
    expect(financeInsights(rows).invoiceStatusChanged).toBe(false);
    expect(financeInsights(rows.map(row => ({ ...row, status: "pending" }))).invoiceMatches).toHaveLength(0);
    expect(financeInsights(rows.map(row => ({ ...row, kind: "refund" }))).invoiceMatches).toHaveLength(0);
    expect(financeInsights(rows.map(row => ({ ...row, minor: row.minor + 1 }))).invoiceMatches).toHaveLength(0);
  });
  test("vendor totals and monthly recurrence are candidates with exact refund handling", () => {
    const rows = fixture("insights-v1").rows.map(normalise);
    const result = financeInsights(rows);
    expect(result.vendorSpend[0].grossSpendMinor).toBe(2000);
    expect(result.recurringCandidates[0]).toEqual({ vendorId: "syn-software", amountMinor: 1000, evidenceCount: 2, status: "candidate-only" });
    expect(financeInsights([rows[0]]).recurringCandidates).toHaveLength(0);
    const refund = { ...rows[0], id: "syn-refund", kind: "refund" as const, direction: "credit" as const, minor: 500 };
    expect(financeInsights([...rows, refund]).vendorSpend[0].netSpendMinor).toBe(1500);
    const { service: s, load } = setup(); load("insights-v1"); expect(s.status(owner).insights?.recurringCandidates).toHaveLength(1);
    s.revoke(owner); expect(s.status(owner).insights).toBeNull();
  });
  test("existing Basiq wrapper executes token/accounts/connections/pagination using closed synthetic transport", async () => {
    const { service: s, consent } = setup(); const adapter = createNabBasiqSyntheticAdapter(s, owner);
    const result = await adapter.read(owner, consent.generation);
    expect(result.requestCount).toBe(5); expect(result.changed).toBe(7); expect(result.status.cashFlow?.netCashMinor).toBe(91500);
    expect((await adapter.read(owner, consent.generation)).changed).toBe(0);
  });
  test("provider error, expired consent, currency and account mismatch all fail before ingest", async () => {
    for (const scenario of ["provider-error", "expired", "wrong-account", "wrong-currency"] as const) {
      const { service: s, consent } = setup();
      await expect(createNabBasiqSyntheticAdapter(s, owner, scenario).read(owner, consent.generation)).rejects.toThrow("SYNTHETIC_PROVIDER_REJECTED");
      expect(s.status(owner).cashFlow).toBeNull();
    }
  });
  test("provider rejects cross-owner, revocation during await, and live activation", async () => {
    const { service: s, consent } = setup(); const adapter = createNabBasiqSyntheticAdapter(s, owner);
    await expect(adapter.read({ ...owner, ownerId: "other" }, consent.generation)).rejects.toThrow("UNAUTHORISED");
    const pending = adapter.read(owner, consent.generation); s.revoke(owner);
    await expect(pending).rejects.toThrow("SYNTHETIC_PROVIDER_REJECTED");
    expect(s.status(owner).cashFlow).toBeNull(); expect(activateLiveNab).toThrow("LIVE_NAB_NOT_AUTHORISED_OR_IMPLEMENTED");
  });
  test("provider failures update status while late failures cannot poison replacement consent", async () => {
    const { service: s, consent, advance } = setup();
    await createNabBasiqSyntheticAdapter(s, owner).read(owner, consent.generation);
    advance(1000);
    await expect(createNabBasiqSyntheticAdapter(s, owner, "provider-error").read(owner, consent.generation)).rejects.toThrow();
    expect(s.status(owner).phase).toBe("error"); expect(s.status(owner).error).toBe("PROVIDER_REJECTED");
    expect(s.status(owner).cashFlow?.netCashMinor).toBe(91500);
    expect(s.status(owner).lastAttemptAt).not.toBe(s.status(owner).lastSyncAt);
    expect(s.audit(owner).at(-1)?.code).toBe("PROVIDER_REJECTED");
    const pending = createNabBasiqSyntheticAdapter(s, owner, "provider-error").read(owner, consent.generation);
    s.revoke(owner); s.consent(owner, grant); await expect(pending).rejects.toThrow();
    expect(s.status(owner).phase).toBe("awaiting-import"); expect(s.status(owner).error).toBeNull();
  });
  test("identity-only provider response omits balance and mismatched dates reject", async () => {
    const { service: s } = setup(); const c = s.consent(owner, { ...grant, scopes: ["accounts"] });
    const result = await createNabBasiqSyntheticAdapter(s, owner, "identity-only").read(owner, c.generation);
    expect(result.requestCount).toBe(3); expect(result.status.balanceMinor).toBeNull(); expect(result.status.cashFlow).toBeNull();
    const full = s.consent(owner, grant);
    await expect(createNabBasiqSyntheticAdapter(s, owner, "wrong-date").read(owner, full.generation)).rejects.toThrow();
    expect(s.status(owner).phase).toBe("error"); expect(s.status(owner).cashFlow).toBeNull();
  });
});
describe("NAB service boundaries (actual memory service, no provider mocks)", () => {
  test("requires consent before import", () => {
    const s = createNabSyntheticService();
    expect(s.status(owner).connected).toBe(false);
    expect(() => s.importFixture(owner, { fixtureId: "cashflow-v1", generation: 0, ownerInitiated: true })).toThrow("CONSENT_REQUIRED");
  });
  test("isolates tenants and denies another owner across every operation", () => {
    const { service: s, load } = setup(); load();
    expect(s.status({ tenantId: "tenant-b", ownerId: "owner-b" }).cashFlow).toBeNull();
    const other = { ...owner, ownerId: "intruder" };
    for (const action of [() => s.status(other), () => s.audit(other), () => s.revoke(other), () => s.consent(other, grant), () => s.refresh(other, { generation: 1 }), () => s.importFixture(other, { fixtureId: "cashflow-v1", ownerInitiated: true, generation: 1 })]) expect(action).toThrow("UNAUTHORISED");
  });
  test("consent scopes and duration are explicitly validated", () => {
    const s = createNabSyntheticService();
    for (const patch of [{ scopes: [] }, { scopes: ["accounts", "payments"] }, { scopes: ["accounts", "accounts"] }, { durationDays: 0 }, { durationDays: 31 }, { acknowledgement: "yes" }, { accountIds: ["other"] }]) expect(() => s.consent(owner, { ...grant, ...patch } as ConsentInput)).toThrow("INVALID_CONSENT");
  });
  test("account-only grant does not ingest or expose balances and transactions", () => {
    const s = createNabSyntheticService(); const consent = s.consent(owner, { ...grant, scopes: ["accounts"] });
    const result = s.importFixture(owner, { fixtureId: "cashflow-v1", generation: consent.generation, ownerInitiated: true });
    expect(result.changed).toBe(0); expect(result.status.balanceMinor).toBeNull(); expect(result.status.cashFlow).toBeNull();
  });
  test("duplicate rows and repeated imports are idempotent", () => {
    const { load } = setup(); expect(load().changed).toBe(7); expect(load().changed).toBe(0); expect(load("duplicate-v1").changed).toBe(0);
  });
  test("pending settlement updates once and cannot regress on stale replay", () => {
    const { load } = setup(); load(); const settled = load("pending-posted-v1");
    expect(settled.changed).toBe(1); expect(settled.status.cashFlow?.expensesMinor).toBe(17500);
    expect(load("pending-posted-v1").changed).toBe(0); const replay = load(); expect(replay.status.cashFlow?.pendingCount).toBe(0); expect(replay.status.balanceMinor).toBe(224000);
  });
  test("revoke erases records and rejects queued refresh/import; reconsent rejects old generation", () => {
    const { service: s, consent, load } = setup(); load();
    expect(s.revoke(owner).cashFlow).toBeNull(); expect(() => load()).toThrow("CONSENT_REQUIRED");
    expect(() => s.refresh(owner, { generation: consent.generation })).toThrow("CONSENT_REQUIRED");
    s.consent(owner, grant); expect(() => load()).toThrow("STALE_CONSENT_JOB");
  });
  test("expiry hides aggregates and blocks import/refresh exactly at expiry", () => {
    const { service: s, advance, load } = setup(); load(); advance(86400000);
    expect(s.status(owner).phase).toBe("expired"); expect(s.status(owner).balanceMinor).toBeNull(); expect(s.status(owner).nextRefreshAt).toBeNull();
    expect(() => load()).toThrow("CONSENT_REQUIRED"); expect(() => s.refresh(owner, { generation: 1 })).toThrow("CONSENT_REQUIRED");
  });
  test("refresh is due once daily and stale metadata is explicit", () => {
    const { service: s, advance } = setup(); const c = s.consent(owner, { ...grant, durationDays: 2 });
    expect(s.refresh(owner, { generation: c.generation }).skipped).toBe(false);
    expect(s.refresh(owner, { generation: c.generation }).skipped).toBe(true); advance(86400000);
    expect(s.status(owner).phase).toBe("stale"); expect(s.refresh(owner, { generation: c.generation }).changed).toBe(0);
    expect(s.status(owner).phase).toBe("fresh");
  });
  test("manual fallback rejects automation, unknown files and arbitrary payloads atomically", () => {
    const { service: s, load } = setup(); load();
    expect(() => s.importFixture(owner, { fixtureId: "cashflow-v1", ownerInitiated: false as true, generation: 1 })).toThrow("OWNER_ACTION_REQUIRED");
    expect(() => load("C:/Downloads/NAB.csv" as FixtureId)).toThrow("FIXTURE_REJECTED");
    expect(s.status(owner).phase).toBe("error"); expect(s.status(owner).cashFlow?.netCashMinor).toBe(91500);
    expect(s.audit(owner).at(-1)?.code).toBe("FIXTURE_REJECTED"); expect(JSON.stringify(s.audit(owner))).not.toContain("Downloads");
  });
  test("audit contains only bounded metadata and caller mutations cannot change service state", () => {
    const { service: s, load } = setup(); load();
    const events = s.audit(owner); expect(Object.keys(events[1]).sort()).toEqual(["action", "at", "count", "result", "sequence"]);
    expect(JSON.stringify(events)).not.toMatch(/amount|balance|syn-income|owner-a|tenant-a/);
    events[0].count = 99; expect(s.audit(owner)[0].count).toBe(0);
    s.status(owner).scopes.length = 0; expect(s.status(owner).scopes).toHaveLength(3);
    for (let i = 0; i < 105; i++) load(); expect(s.audit(owner)).toHaveLength(100);
  });
});

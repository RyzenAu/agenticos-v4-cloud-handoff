// Synthetic end-to-end: a fake NAB CSV -> the one importer -> the shared ledger -> package-price candidates,
// through the same handler the Finance page calls. Every row is invented; prices come from the catalogue.
import { describe, expect, test } from "bun:test";
import { RECEPTIONIST_PACKAGES, getReceptionistPackage } from "../../src/lib/receptionist-packages";
import { handleManualFinance } from "./manual-plugin";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { SYNTHETIC_SAVINGS, buildNabCsv, type SyntheticLine } from "./manual-fixtures";
import { approvedMonthlyTargets, receptionistCandidatesText, receptionistPaymentCandidates } from "./manual-receptionist";

const inc = (id: "receptionist-essential" | "receptionist-professional" | "receptionist-premium") => (getReceptionistPackage(id).pricing.monthly.cents * 110) / 100;
const dollars = (c: number) => (c / 100).toFixed(2);
const ESSENTIAL_INC = inc("receptionist-essential");
const ESSENTIAL_EX = getReceptionistPackage("receptionist-essential").pricing.monthly.cents;
const PRO_INC = inc("receptionist-professional");

const line = (date: string, amount: string, details: string, type = "MISCELLANEOUS CREDIT", extra: Partial<SyntheticLine> = {}): SyntheticLine => ({ date, amount, type, details, ...extra });
const SEPTEMBER: SyntheticLine[] = [
  line("02 Sep 26", dollars(ESSENTIAL_INC), "SYNTHETIC CLIENT A MONTHLY"),
  line("09 Sep 26", dollars(PRO_INC), "SYNTHETIC CLIENT B MONTHLY"),
  line("11 Sep 26", dollars(ESSENTIAL_EX), "SYNTHETIC CLIENT C MONTHLY EX GST"),
  line("14 Sep 26", "123.45", "SYNTHETIC UNRELATED DEPOSIT"),
  line("15 Sep 26", dollars(getReceptionistPackage("receptionist-essential").pricing.setup.cents), "SYNTHETIC SETUP FEE AMOUNT"), // proposed: never matched
  line("18 Sep 26", dollars(ESSENTIAL_INC), "SYNTHETIC OWN TRANSFER", "TRANSFER CREDIT", { account: SYNTHETIC_SAVINGS }),
  line("18 Sep 26", `-${dollars(ESSENTIAL_INC)}`, "TRANSFER TO OWN SAVINGS", "TRANSFER DEBIT"),
  line("20 Sep 26", dollars(ESSENTIAL_INC), "SYNTHETIC REFUND OF SOMETHING", "EFTPOS CREDIT", { category: "Refunds" }),
];

function fresh() {
  const store = openManualFinanceStore(":memory:");
  const call = (path: string, query = "") => handleManualFinance({ method: "GET", path, query: new URLSearchParams(query), owner: "usman", tokenOk: false }, { store: () => store, today: () => "2026-09-28" });
  return { store, call };
}

describe("approved package targets", () => {
  test("GST is added once, in whole cents, from approved catalogue prices only", () => {
    const { targets, excluded } = approvedMonthlyTargets();
    expect(targets.map((t) => t.packageId)).toEqual(RECEPTIONIST_PACKAGES.map((p) => p.id));
    for (const t of targets) expect(t.incGstCents).toBe((t.exGstCents * 11) / 10);
    expect(excluded.filter((e) => e.item === "setup")).toHaveLength(3); // setup fees are proposed, not approved
  });
  test("a package whose price is not approved is excluded, never guessed", () => {
    const draft = { ...RECEPTIONIST_PACKAGES[0], pricing: { ...RECEPTIONIST_PACKAGES[0].pricing, status: "proposed" as const } };
    const { targets, excluded } = approvedMonthlyTargets([draft]);
    expect(targets).toEqual([]);
    expect(excluded[0]).toMatchObject({ item: "monthly", reason: "Monthly price not approved in the catalogue." });
  });
});

describe("empty and uncovered states are unknown, not zero", () => {
  test("nothing imported: candidates is null and the sentence says it does not know", () => {
    const { store } = fresh();
    const r = receptionistPaymentCandidates("last-month", { store, today: "2026-09-28" });
    expect(r.candidates).toBeNull();
    expect(r.coverage).toBe("none");
    expect(r.source.live).toBe(false);
    expect(receptionistCandidatesText(r)).toMatch(/^I don't know/);
  });
  test("a period the import does not reach stays unknown even when another period has data", () => {
    const { store } = fresh();
    store.importCsv(SHARED_LEDGER, buildNabCsv(SEPTEMBER), "test");
    const r = receptionistPaymentCandidates("last-month", { store, today: "2026-11-15" }); // October: no rows, no coverage
    expect(r.candidates).toBeNull();
  });
});

describe("end to end: import, then reconcile against approved prices", () => {
  const { store, call } = fresh();
  const preview = store.previewCsv(SHARED_LEDGER, buildNabCsv(SEPTEMBER));
  test("preview writes nothing; import is explicit", () => {
    expect((preview as any).preview).toBe(true);
    expect(store.count(SHARED_LEDGER)).toBe(0);
    store.importCsv(SHARED_LEDGER, buildNabCsv(SEPTEMBER), "test");
    expect(store.count(SHARED_LEDGER)).toBeGreaterThan(0);
  });
  test("only credits equal to an approved monthly price count: not the setup fee, own-account pair, refund or unrelated deposit", () => {
    const res = call("/receptionist-payments", "period=this-month");
    expect(res.status).toBe(200);
    const b = res.body as ReturnType<typeof receptionistPaymentCandidates>;
    expect(b.candidates!.count).toBe(3);
    expect(b.candidates!.totalCents).toBe(ESSENTIAL_INC + PRO_INC + ESSENTIAL_EX);
    const essential = b.candidates!.byPackage.find((p) => p.packageId === "receptionist-essential")!;
    expect(essential).toMatchObject({ count: 2, incGst: 1, exGst: 1 });
    expect(b.candidates!.byPackage.find((p) => p.packageId === "receptionist-professional")).toMatchObject({ count: 1, incGst: 1 });
    expect(b.source).toMatchObject({ name: "NAB CSV import", live: false });
    expect(b.source.statement).toMatch(/NAB CSV imported, as of/);
    expect(b.catalogue.version).toBeTruthy();
    expect(b.excluded.some((e) => e.item === "setup")).toBe(true);
    expect(b.caveat).toMatch(/no payer name/);
  });
  test("no transaction row, account alias or bank text leaves the route", () => {
    const text = JSON.stringify(call("/receptionist-payments", "period=all").body);
    for (const leak of ["SYNTHETIC", "00-000", "accountAlias", "vendorId", "details"]) expect(text).not.toContain(leak);
  });
  test("the spoken line says 'possible', names the source, and never says paid or live", () => {
    const t = receptionistCandidatesText(receptionistPaymentCandidates("this-month", { store, today: "2026-09-28" }));
    expect(t).toMatch(/Possible client payments, not confirmed/);
    expect(t).toMatch(/not a live bank feed/);
    expect(t).not.toMatch(/\bpaid\b/i);
  });
  test("a pending row is not counted until NAB settles it; re-importing overlapping rows never doubles the count", () => {
    const withPending = [...SEPTEMBER, line("25 Sep 26", dollars(inc("receptionist-premium")), "SYNTHETIC PENDING PREMIUM", "MISCELLANEOUS CREDIT", { processedOn: null })];
    const s2 = openManualFinanceStore(":memory:");
    s2.importCsv(SHARED_LEDGER, buildNabCsv(withPending), "test");
    s2.importCsv(SHARED_LEDGER, buildNabCsv(withPending), "test");
    const r = receptionistPaymentCandidates("this-month", { store: s2, today: "2026-09-28" });
    expect(r.candidates!.count).toBe(3);
    expect(r.candidates!.byPackage.find((p) => p.packageId === "receptionist-premium")).toBeUndefined();
  });
  test("a corrected refund/scope elsewhere does not change what is matched; the route is read-only", () => {
    const before = store.count(SHARED_LEDGER);
    const post = handleManualFinance({ method: "POST", path: "/receptionist-payments", query: new URLSearchParams(), owner: "usman", tokenOk: true }, { store: () => store, today: () => "2026-09-28" });
    expect(post.status).not.toBe(200);
    expect(store.count(SHARED_LEDGER)).toBe(before);
  });
});

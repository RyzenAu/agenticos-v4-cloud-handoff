// Regression tests for REVIEW-FINANCE.md (28 Sep 2026): B1, B2, M1, M2 (in legacy-migration.test.ts),
// M3, M4 and the smaller issues fixed with them. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { buildNabCsv, SYNTHETIC_ACCOUNT, SYNTHETIC_SAVINGS, syntheticSeptemberCsv, type SyntheticLine } from "./manual-fixtures";
import { NabCsvRejected, inspectNabCsvExport } from "./manual-nab-csv";
import { summary } from "./manual-summary";
import { answerManualFinanceQuestion } from "./manual-jarvis";
import { sourcedFinanceSummaries, sourcedSummaryText } from "./manual-sourced";
import { handleManualFinance, manualFinancePlugin } from "./manual-plugin";

const L = SHARED_LEDGER;
const mem = (now = "2026-09-27T09:00:00Z") => openManualFinanceStore(":memory:", { now: () => new Date(now) });
const line = (over: Partial<SyntheticLine>): SyntheticLine => ({ date: "03 Sep 26", amount: "-50.00", type: "EFTPOS DEBIT", details: "SYNTH HARDWARE", merchant: "Synth Hardware", ...over });
const rejectedCode = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as NabCsvRejected).code; } return "NOT_REJECTED"; };

describe("B1: same-day repeats with the same resulting balance are separate transactions", () => {
  test("charge → reversal → re-charge keeps all three rows, and a re-import adds nothing", () => {
    const s = mem();
    const csv = buildNabCsv([line({}), line({ amount: "50.00", type: "EFTPOS CREDIT", details: "SYNTH HARDWARE REVERSAL" }), line({})]);
    expect(s.importCsv(L, csv, "test")).toMatchObject({ rowsInFile: 3, inserted: 3, unchanged: 0 });
    expect(s.count(L)).toBe(3);
    expect(summary(L, "all", { store: s, today: "2026-09-27" }).cashOutCents).toBe(10000);
    expect(s.importCsv(L, csv, "test")).toMatchObject({ inserted: 0, unchanged: 3 });
    // An overlapping export that also has the next day still dedupes whole days by occurrence.
    expect(s.importCsv(L, buildNabCsv([line({}), line({ amount: "50.00", type: "EFTPOS CREDIT", details: "SYNTH HARDWARE REVERSAL" }), line({}), line({ date: "04 Sep 26", amount: "-7.00" })]), "test"))
      .toMatchObject({ inserted: 1, unchanged: 3 });
    expect(s.count(L)).toBe(4);
    s.close();
  });

  test("transfer out → back → out again keeps all three rows", () => {
    const s = mem();
    const out = line({ amount: "-100.00", type: "TRANSFER DEBIT", details: "TRANSFER TO OWN SAVINGS SYNTH", merchant: "" });
    const back = line({ amount: "100.00", type: "TRANSFER CREDIT", details: "TRANSFER FROM OWN SAVINGS SYNTH", merchant: "" });
    expect(s.importCsv(L, buildNabCsv([out, back, out]), "test")).toMatchObject({ inserted: 3 });
    expect(summary(L, "all", { store: s, today: "2026-09-27" }).transfers).toMatchObject({ outCents: 20000, inCents: 10000, count: 3 });
    s.close();
  });
});

describe("B2: coverage is the union of what each import covered, per account", () => {
  const jan: SyntheticLine[] = [
    line({ date: "02 Jan 26", amount: "-20.00" }),
    line({ date: "30 Jan 26", amount: "-5.00" }),
    line({ date: "15 Jan 26", amount: "10.00", account: SYNTHETIC_SAVINGS, type: "DEPOSIT", details: "SYNTH INTEREST", merchant: "" }),
  ];
  const sep: SyntheticLine[] = [line({ date: "01 Sep 26", amount: "-12.00" }), line({ date: "26 Sep 26", amount: "-8.00" })];
  const seeded = () => { const s = mem(); s.importCsv(L, buildNabCsv(jan), "test"); s.importCsv(L, buildNabCsv(sep), "test"); return s; };

  test("a month between two imports is unknown, not $0 — on the page, to Jarvis and in memory", () => {
    const s = seeded();
    const may = summary(L, { month: "2026-05" }, { store: s, today: "2026-09-27" });
    expect(may).toMatchObject({ periodCoverage: "none", periodCovered: [] });
    expect(may.coverage.ranges).toEqual([{ from: "2026-01-02", to: "2026-01-30" }, { from: "2026-09-01", to: "2026-09-26" }]);
    const said = answerManualFinanceQuestion({ kind: "cash", period: { month: "2026-05" } }, may);
    expect(said).toContain("I have no data for 2026-05");
    expect(said).toContain("unknown, not zero");
    expect(said).toContain("Imported data covers 2 Jan 2026 – 30 Jan 2026 and 1 Sep 2026 – 26 Sep 2026");
    expect(said).not.toContain("$0.00");
    const [sourced] = sourcedFinanceSummaries({ store: s, today: "2026-09-27", periods: [{ month: "2026-05" }] })!;
    expect(sourced).toMatchObject({ coverage: "none", totals: null });
    expect(sourcedSummaryText([sourced])).toContain("2026-05 (2026-05-01 to 2026-05-31): no data.");
    s.close();
  });

  test("a period straddling a gap is partial, and says which parts are covered", () => {
    const s = seeded();
    const r = summary(L, { from: "2026-01-20", to: "2026-02-10" }, { store: s, today: "2026-09-27" });
    expect(r).toMatchObject({ periodCoverage: "partial", periodCovered: [{ from: "2026-01-20", to: "2026-01-30" }] });
    expect(r.coverageNote).toBe("Imported NAB data only covers part of this period (20 Jan 2026 – 30 Jan 2026), so its figures may be incomplete.");
    expect(answerManualFinanceQuestion({ kind: "cash", period: "all" }, r)).toContain("may be incomplete");
    s.close();
  });

  test("an account whose exports stopped makes later periods partial, not full", () => {
    const s = seeded(); // savings was only in the January export
    const r = summary(L, { from: "2026-09-01", to: "2026-09-26" }, { store: s, today: "2026-09-27" });
    expect(r.periodCoverage).toBe("partial");
    expect(r.coverageNote).toBe("Not every account's imports cover all of this period, so its figures may be incomplete.");
    expect(summary(L, { from: "2026-01-02", to: "2026-01-30" }, { store: s, today: "2026-09-27" }).periodCoverage).toBe("full");
    s.close();
  });

  test("every account in one export is covered for the export's whole date range", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test"); // savings has a single row on 12 Sep
    expect(s.coverageSpans(L).map((x) => [x.from, x.to])).toEqual([["2026-09-01", "2026-09-27"], ["2026-09-01", "2026-09-27"]]);
    expect(summary(L, "this-month", { store: s, today: "2026-09-27" }).periodCoverage).toBe("full");
    s.close();
  });
});

describe("M1: a 20,000-row import is index-bound, not quadratic", () => {
  test("20,000 rows import, preview and summarise in seconds", () => {
    const s = mem();
    const lines: SyntheticLine[] = [];
    const start = Date.parse("2024-01-01T00:00:00Z");
    for (let i = 0; i < 20_000; i++) {
      const d = new Date(start + Math.floor(i / 30) * 86_400_000);
      const date = `${String(d.getUTCDate()).padStart(2, "0")} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
      const cents = 100 + ((i * 7919) % 50_000);
      lines.push({ date, amount: `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`, type: "EFTPOS DEBIT", details: `SYNTH SHOP ${i % 40}`, merchant: `Synth Shop ${i % 40}` });
    }
    const csv = buildNabCsv(lines, { openingCents: 1_000_000_000 });
    let t = performance.now();
    expect(s.previewCsv(L, csv)).toMatchObject({ inserted: 20_000 });
    const previewMs = performance.now() - t;
    t = performance.now();
    expect(s.importCsv(L, csv, "test")).toMatchObject({ inserted: 20_000 });
    const importMs = performance.now() - t;
    t = performance.now();
    expect(s.importCsv(L, csv, "test")).toMatchObject({ unchanged: 20_000 });
    const reimportMs = performance.now() - t;
    t = performance.now();
    expect(summary(L, "all", { store: s, today: "2026-09-27" }).rowCount).toBe(20_000);
    const summaryMs = performance.now() - t;
    console.log(`[M1] 20,000 rows: preview ${Math.round(previewMs)} ms, import ${Math.round(importMs)} ms, re-import ${Math.round(reimportMs)} ms, summary ${Math.round(summaryMs)} ms`);
    // Target is ~2 s on an idle PC; the bound leaves room for a loaded test machine (was 189 s).
    for (const ms of [previewMs, importMs, reimportMs, summaryMs]) expect(ms).toBeLessThan(15_000);
    s.close();
    // Worst case from the review: every row the same amount (was 257 s), with some pending rows.
    const same = mem();
    const sameCsv = buildNabCsv(lines.map((l, i) => ({ ...l, amount: "-5.00", details: "SYNTH CAFE", merchant: "Synth Cafe", processedOn: i % 1000 === 999 ? null : undefined })), { openingCents: 1_000_000_000 });
    t = performance.now();
    expect(same.importCsv(L, sameCsv, "test")).toMatchObject({ inserted: 20_000 });
    const sameMs = performance.now() - t;
    console.log(`[M1] 20,000 same-amount rows: import ${Math.round(sameMs)} ms`);
    expect(sameMs).toBeLessThan(15_000);
    same.close();
  }, 120_000);
});

describe("M4: an export without account numbers is never mixed with one that has them", () => {
  const classic4 = ["03/09/2026,-10.00,SYNTH SHOP,90.00", "04/09/2026,-5.00,SYNTH SHOP,85.00"].join("\n");
  const ib = buildNabCsv([line({ date: "03 Sep 26", amount: "-10.00" }), line({ date: "04 Sep 26", amount: "-5.00" })]);
  test("classic 4-column, then the current export: refused with a clear reason, nothing doubled", () => {
    const s = mem();
    expect(s.importCsv(L, classic4, "test")).toMatchObject({ inserted: 2 });
    expect(rejectedCode(() => s.previewCsv(L, ib))).toBe("ACCOUNTLESS_MIX");
    expect(rejectedCode(() => s.importCsv(L, ib, "drop", { actor: "usman" }))).toBe("ACCOUNTLESS_MIX");
    expect(s.count(L)).toBe(2);
    expect(summary(L, "all", { store: s, today: "2026-09-27" }).cashOutCents).toBe(1500);
    expect(s.audit(L)[0]).toMatchObject({ action: "import-rejected", code: "ACCOUNTLESS_MIX", actor: "usman" });
    s.close();
  });
  test("the current export, then classic 4-column: refused too", () => {
    const s = mem();
    s.importCsv(L, ib, "test");
    expect(rejectedCode(() => s.importCsv(L, classic4, "test"))).toBe("ACCOUNTLESS_MIX");
    expect(s.count(L)).toBe(2);
    s.close();
  });
});

describe("smaller review issues", () => {
  test("#2 a separate pending row in the same file is kept, not dropped as stale", () => {
    const s = mem();
    const r = s.importCsv(L, buildNabCsv([
      line({ date: "26 Sep 26", amount: "-5.00", details: "SYNTH CAFE", merchant: "Synth Cafe" }),
      line({ date: "27 Sep 26", amount: "-5.00", details: "SYNTH CAFE", merchant: "Synth Cafe", processedOn: null }),
    ]), "test");
    expect(r).toMatchObject({ inserted: 2, stalePendingSkipped: 0 });
    expect(summary(L, "all", { store: s, today: "2026-09-27" }).pending.count).toBe(1);
    s.close();
  });

  test("#7 far-future dates are rejected; a non-UTF-8 file is a warning", () => {
    const text = buildNabCsv([line({ date: "15 Jan 99" })]);
    expect(inspectNabCsvExport(text, "ab".repeat(32), { today: "2026-09-27" }).issues[0]).toMatchObject({ code: "FUTURE_DATE", severity: "error", line: 2 });
    const s = mem();
    expect(rejectedCode(() => s.importCsv(L, text, "test"))).toBe("FUTURE_DATE");
    const garbled = buildNabCsv([line({ merchant: "CAF� SYNTH", details: "CAF� SYNTH" })]);
    expect(rejectedCode(() => s.importCsv(L, garbled, "test"))).toBe("ENCODING");
    expect(s.importCsv(L, garbled, "test", { acceptWarnings: true })).toMatchObject({ inserted: 1, warnings: 1 });
    s.close();
  });

  test("#6 a formula-looking merchant label loses its formula lead", () => {
    const s = mem();
    s.importCsv(L, buildNabCsv([line({ merchant: "=HYPERLINK(\"x\")" }), line({ date: "04 Sep 26", merchant: "@SUM(1+1)" })]), "test");
    for (const r of s.rows(L)) expect(r.vendorLabel).not.toMatch(/^[=+\-@]/);
    s.close();
  });

  test("#12 consolidation keeps a correction made on a per-person duplicate of a shared row", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    s.importCsv("mehroz", syntheticSeptemberCsv(), "test");
    const target = s.rows("mehroz").find((r) => r.vendorId === "m-officeworks")!;
    s.setTxOverride("mehroz", target.id, { scope: "personal" }, "mehroz");
    expect(s.consolidateLedgers()).toMatchObject({ owners: ["mehroz"], duplicates: 24 });
    expect(s.rows(L).find((r) => r.vendorId === "m-officeworks")).toMatchObject({ scope: "personal", edited: { scope: { by: "mehroz" } } });
    s.close();
  });

  test("#8 row-level reads need the page token; period totals don't", () => {
    const s = mem();
    s.importCsv(L, syntheticSeptemberCsv(), "test");
    const get = (path: string, tokenOk: boolean) => handleManualFinance({ method: "GET", path, query: new URLSearchParams("period=all"), owner: "usman", tokenOk }, { store: () => s, today: () => "2026-09-27" });
    expect(get("/transactions", false)).toMatchObject({ status: 403, body: { code: "TOKEN" } });
    expect(get("/edits", false).status).toBe(403);
    expect(get("/transactions", true).status).toBe(200);
    expect(get("/summary", false).status).toBe(200);
    s.close();
  });
});

describe("M3: relay headers cannot become the owner or forge 'imported by' (B1 principal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "finance-relay-"));
  const token = "synthetic-token";
  let server: Server, base = "";
  beforeAll(async () => {
    const mounts: Array<[string, (req: IncomingMessage, res: ServerResponse, next: () => void) => void]> = [];
    const plugin = manualFinancePlugin({ root: dir, token });
    server = createServer((req, res) => {
      const hit = mounts.find(([p]) => req.url!.startsWith(p));
      if (!hit) { res.statusCode = 404; return res.end(); }
      req.url = req.url!.slice(hit[0].length) || "/";
      hit[1](req, res, () => { res.statusCode = 404; res.end(); });
    });
    (plugin.configureServer as any)({ httpServer: server, middlewares: { use: (path: string, fn: any) => mounts.push([path, fn]) } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}/__finance_manual`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });

  test("x-forwarded-for / forwarded / x-forwarded-host on a loopback Host are nobody: no read, no import", async () => {
    for (const relay of [{ "X-Forwarded-For": "203.0.113.9" }, { Forwarded: "for=203.0.113.9" }, { "X-Forwarded-Host": "evil.example" }]) {
      expect((await fetch(`${base}/status`, { headers: relay })).status).toBe(403);
      const res = await fetch(`${base}/import?via=drop`, { method: "POST", body: syntheticSeptemberCsv(), headers: { ...relay, "Content-Type": "text/csv", "X-Claude-OS-Token": token } });
      expect(res.status).toBe(403);
    }
    // The real owner at this PC imports, and the audit names the verified person.
    const ok = await fetch(`${base}/import?via=drop`, { method: "POST", body: syntheticSeptemberCsv(), headers: { "Content-Type": "text/csv", "X-Claude-OS-Token": token } });
    expect(ok.status).toBe(200);
    const status = await (await fetch(`${base}/status`)).json();
    expect(status.audit.map((a: any) => [a.action, a.actor])).toEqual([["import", "usman"]]);
  });
});

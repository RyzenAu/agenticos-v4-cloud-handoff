import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { FinanceDestination, describeAudit, type ManualFinanceApi, type ManualFinanceStatus, type PeriodKey } from "../../src/components/finance/manual-finance";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { summary } from "./manual-summary";
import { transactionViews } from "./manual-plugin";
import { resolvePeriod } from "./manual-summary";
import { NAB_CSV_ISSUE_TEXT, NabCsvRejected } from "./manual-nab-csv";
import { basiqLiveStatus } from "../nab/basiq-live";
import { buildNabCsv, SYNTHETIC_SEPTEMBER, syntheticSeptemberCsv } from "./manual-fixtures";

const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => { for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as any)[k]; });

const L = SHARED_LEDGER;
const withText = (e: unknown) => {
  if (e instanceof NabCsvRejected) throw Object.assign(new Error(e.message), { code: e.code, line: e.line, issues: e.issues.map((i) => ({ ...i, text: NAB_CSV_ISSUE_TEXT[i.code] })) });
  throw e;
};
/** Synthetic in-process API over a real store (no fetch), shaped like the HTTP one. */
function fakeApi(today: string) {
  const store = openManualFinanceStore(":memory:");
  const calls: string[] = [];
  const api: ManualFinanceApi = {
    async status(): Promise<ManualFinanceStatus> {
      calls.push("status");
      const all = summary(L, "all", { store, today });
      return { owner: L, source: "nab-csv-manual", rowCount: store.count(L), lastImportAt: store.lastImportAt(L), audit: store.audit(L), basiq: basiqLiveStatus(), legacyNab: { admitted: false }, maxBytes: 4 * 1024 * 1024,
        sourceLabel: all.sourceLabel, liveFeedLabel: "Live bank feed: not connected", asOf: all.asOf, stale: all.stale, daysSinceAsOf: all.daysSinceAsOf, actor: "usman" };
    },
    async summary(p: PeriodKey) { calls.push(`summary:${p}`); return summary(L, p, { store, today }); },
    async preview(text) { calls.push("preview"); try { const p = store.previewCsv(L, text); return { ...p, issues: p.issues.map((i) => ({ ...i, text: NAB_CSV_ISSUE_TEXT[i.code] })) }; } catch (e) { return withText(e); } },
    async importCsv(text, via, accept) { calls.push(`import:${via}${accept ? ":accept" : ""}`); try { return store.importCsv(L, text, via, { actor: "usman", acceptWarnings: accept }); } catch (e) { return withText(e); } },
    async clear() { calls.push("clear"); return store.clear(L, "usman"); },
    async transactions(p, filter) { calls.push(`tx:${filter}`); const rows = transactionViews(store.rows(L), filter, resolvePeriod(p, today)); return { filter, total: rows.length, rows }; },
    async correct(id, patch) { calls.push(`correct:${Object.keys(patch).join(",")}`); return store.setTxOverride(L, id, patch, "mehroz"); },
    async vendorRule(id, patch) { calls.push(`vendor:${id}`); return store.setVendorOverride(L, id, patch, "mehroz"); },
  };
  return { api, store, calls };
}
async function mount(api: ManualFinanceApi) {
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => { root.render(createElement(FinanceDestination, { api })); });
  await settle();
  return { host, root };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
const button = (host: Element, label: string | RegExp) => [...host.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""))) as any;
async function pick(host: Element, name: string, text: string) {
  const input = host.querySelector('input[type="file"]') as any;
  Object.defineProperty(input, "files", { value: [new File([text], name, { type: "text/csv" })], configurable: true });
  await act(async () => { input.dispatchEvent(new (globalThis as any).window.Event("change", { bubbles: true })); });
  await settle();
}

test("honest empty state: no import means unknown, and the live feed is shown separately as not connected", async () => {
  const { api, calls } = fakeApi("2026-09-27");
  const { host, root } = await mount(api);
  const text = host.textContent ?? "";
  expect(text).toContain("No NAB data imported yet");
  expect(text).toContain("No NAB CSV imported");
  expect(text).toContain("Live bank feed: not connected (deferred by owner decision)");
  expect(text).toContain("deferred by your decision (NAB CSV is the route)");
  expect(text).toContain("switched off (fail-closed)");
  expect(text).toContain("unknown, not zero");
  expect(text).not.toMatch(/\$\d/); // no zero-dollar tiles pretending to be data
  expect(calls.some((c) => c.startsWith("import") || c === "preview")).toBe(false);
  await act(async () => root.unmount());
});

test("'NAB CSV imported, as of …' on the source badge and in the import history; never a live feed", async () => {
  const { api, store } = fakeApi("2026-09-27");
  store.importCsv(L, syntheticSeptemberCsv(), "picker", { actor: "usman" });
  const { host, root } = await mount(api);
  const badges = [...host.querySelectorAll("span")].map((s) => s.textContent);
  expect(badges).toContain("NAB CSV imported, as of 26 Sep 2026");
  expect(badges).toContain("Live bank feed: not connected");
  expect(badges.some((b) => /live/i.test(b ?? "") && /imported/i.test(b ?? ""))).toBe(false); // two separate statements
  const history = host.textContent ?? "";
  expect(history).toContain("NAB CSV imported, as of 26 Sep 2026 · 24 rows · 24 new · by Usman");
  expect(history).not.toMatch(/live (bank )?feed: connected|synced from NAB|live data/i);
  expect(describeAudit({ id: 1, at: "", action: "import-rejected", via: "drop", actor: "mehroz", rowsInFile: 0, inserted: 0, unchanged: 0, reconciled: 0, upgraded: 0, reclassified: 0, deleted: 0, warnings: 0, asOf: null, format: null, code: "BAD_DATE" }))
    .toBe("Rejected (BAD_DATE) · nothing imported · by Mehroz");
  await act(async () => root.unmount());
});

test("unknown never shows as zero: a period no import covers says Unknown, not $0.00", async () => {
  const { api, store } = fakeApi("2026-09-27");
  store.importCsv(L, syntheticSeptemberCsv(), "test");
  const { host, root } = await mount({ ...api, summary: (p) => api.summary(p === "this-month" ? "last-month" : p) });
  const text = host.textContent ?? "";
  expect(text).toContain("Unknown for last month");
  expect(text).toContain("These figures are unknown, not zero");
  expect(text).toContain("Unknown");
  expect(text).not.toContain("$0.00");
  await act(async () => root.unmount());
});

test("aggregates, vendor table, stale badge, transfers and matched refunds render from synthetic data", async () => {
  const { api, store } = fakeApi("2026-10-10");
  store.importCsv(L, syntheticSeptemberCsv(), "test");
  const first = await mount({ ...api, summary: (p) => api.summary(p === "this-month" ? "all" : p) });
  const t = first.host.textContent ?? "";
  expect(t).toContain("Stale · 14 days old");
  expect(t).toContain("Your latest import only runs to 26 Sep 2026");
  expect(t).toContain("Tools & subscriptions");
  expect(t).toContain("Cash flow, not accounting profit");
  expect(t).toContain("A$825.00"); // cash in, Stripe payout excluded
  expect(t).toContain("1 between your own accounts");
  expect(t).toContain("incl. A$412.50 Stripe payouts (counted in Stripe revenue)");
  expect(t).toContain("1 matched to a charge");
  expect(t).toContain("A$298.04");
  expect(t).toContain("Retell AI");
  expect(t).toContain("−A$12.40");
  expect(t).not.toContain("00-000-0000");
  expect(t).not.toContain("V0000");
  await act(async () => first.root.unmount());
});

test("a picked file is previewed first; nothing is imported until the owner confirms", async () => {
  const { api, store, calls } = fakeApi("2026-09-27");
  store.importCsv(L, buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 15)), "test");
  const { host, root } = await mount(api);
  await pick(host, "Transactions.csv", syntheticSeptemberCsv());
  expect(calls).toContain("preview");
  expect(calls.some((c) => c.startsWith("import"))).toBe(false);
  expect(store.count(L)).toBe(15);
  expect(host.textContent).toContain("Preview: 24 rows, 1 Sep 2026 – 27 Sep 2026");
  expect(host.textContent).toContain("9 new · 15 already imported");
  await act(async () => { button(host, "Import 9 new rows").click(); });
  await settle();
  expect(calls).toContain("import:picker");
  expect(store.count(L)).toBe(24);
  expect(host.textContent).toContain("NAB CSV imported, as of 26 Sep 2026. 24 rows (1 Sep 2026 – 27 Sep 2026): 9 new, 15 already imported.");
  await act(async () => root.unmount());
});

test("a rejected file shows every problem by line, in plain English, and imports nothing", async () => {
  const { api, store } = fakeApi("2026-09-27");
  const { host, root } = await mount(api);
  const lines = syntheticSeptemberCsv().split("\r\n");
  lines[2] = lines[2].replace("03 Sep 26", "31 Sep 26");
  lines[4] = lines[4].replace("-35.12", "-35.1.2");
  await pick(host, "bad.csv", lines.join("\r\n"));
  const text = host.textContent ?? "";
  expect(text).toContain("2 problems found. Nothing was imported.");
  expect(text).toContain("Line 3 · Date: The date isn't a real Australian date");
  expect(text).toContain("Line 5 · Amount: The amount isn't a plain number");
  expect(store.count(L)).toBe(0);
  await act(async () => root.unmount());
});

test("a balance warning is shown in the preview and needs 'Import anyway'", async () => {
  const { api, store, calls } = fakeApi("2026-09-27");
  const { host, root } = await mount(api);
  const full = buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 8)).split("\r\n");
  await pick(host, "gap.csv", [...full.slice(0, 4), ...full.slice(5)].join("\r\n"));
  expect(host.textContent).toContain("Running-balance check: 1 row doesn't follow from the row before");
  expect(host.textContent).toContain("Line 5 · Balance");
  await act(async () => { button(host, "Import anyway").click(); });
  await settle();
  expect(calls).toContain("import:picker:accept");
  expect(store.count(L)).toBe(7);
  await act(async () => root.unmount());
});

test("review and correct: a founder marks a row personal; the change shows who made it and survives a re-import", async () => {
  const { api, store, calls } = fakeApi("2026-09-27");
  store.importCsv(L, syntheticSeptemberCsv(), "test");
  const { host, root } = await mount(api);
  expect(host.textContent).toContain("Review and correct");
  const item = [...host.querySelectorAll('ul[aria-label="Transactions"] > li')].find((li) => li.textContent?.startsWith("Officeworks"))!;
  expect(item.textContent).toContain("Not decided");
  await act(async () => { button(item, "Correct").click(); });
  const select = item.querySelector("select[id$='-scope']") as any;
  const option = [...select.querySelectorAll("option")].find((o: any) => o.getAttribute("value") === "personal") as any;
  for (const o of select.querySelectorAll("option")) (o as any).removeAttribute("selected");
  option.setAttribute("selected", "");
  await act(async () => { select.dispatchEvent(new (globalThis as any).window.Event("change", { bubbles: true })); });
  // linkedom does not turn a submit-button click into a form submit; dispatch it as the browser would.
  await act(async () => { item.querySelector("form")!.dispatchEvent(new (globalThis as any).window.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  expect(calls).toContain("correct:scope");
  store.importCsv(L, syntheticSeptemberCsv(), "drop");
  expect(store.rows(L).find((r) => r.vendorId === "m-officeworks")).toMatchObject({ scope: "personal", edited: { scope: { by: "mehroz" } } });
  await act(async () => { button(host, "Edited").click(); });
  await settle();
  expect(host.textContent).toContain("scope set by Mehroz");
  await act(async () => root.unmount());
});

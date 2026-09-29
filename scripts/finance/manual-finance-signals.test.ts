// Finance destination tiles: every tile derived from its source, and zero / unknown / stale /
// failed / loading all render differently. Synthetic data only; no fetch, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { FinanceSignalRow } from "../../src/components/finance/signal-row";
import { AI_STALE_MS, aiSpendTiles, csvDataTile, liveFeedTile, monthEndHint, type AiTotals, type FinanceRecovery, type FinanceTile } from "../../src/components/finance/signals";
import { ManualFinanceView, type ManualFinanceStatus } from "../../src/components/finance/manual-finance";
import { basiqLiveStatus } from "../nab/basiq-live";
import { projectMonth } from "../ai-usage/parsers";
import { openManualFinanceStore } from "./manual-store";
import { summary } from "./manual-summary";
import { buildNabCsv } from "./manual-fixtures";

const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => { for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as any)[k]; });

const NOW = Date.parse("2026-09-27T10:00:00+10:00");
const AI: AiTotals = {
  generatedAt: new Date(NOW - 5 * 60_000).toISOString(),
  month: { label: "September 2026", daysInMonth: 30 },
  totals: { fixedAud: 703, meteredAud: 3.75, monthAud: 706.75, projectedAud: projectMonth(703, 3.75, { elapsedDays: 23.5, daysInMonth: 30 }), unknown: ["Synthetic unpriced key"] },
};
const CSV_OK = { rowCount: 24, lastImportAt: new Date(NOW - 3_600_000).toISOString(), asOf: "2026-09-26", stale: false, daysSinceAsOf: 1 };

async function render(tiles: FinanceTile[]) {
  const recovered: Array<[FinanceRecovery, string]> = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(createElement(FinanceSignalRow, { tiles, now: NOW, onRecover: (a: FinanceRecovery, id: string) => recovered.push([a, id]) })); });
  const tile = (id: string) => host.querySelector(`[data-tile="${id}"]`)!;
  const click = async (id: string) => { await act(async () => { (tile(id).querySelector("button") as any).click(); }); };
  return { host, root, tile, recovered, click, done: () => act(async () => root.unmount()) };
}
const noSuccess = (el: Element) => expect(el.querySelector('[data-tone="success"]')).toBeNull();

describe("item 1: bank tiles come from the import status and the Basiq skeleton, never a constant", () => {
  test("CSV data: none imported → unknown with 'Import a NAB CSV'; the live feed stays a separate fact", async () => {
    const r = await render([csvDataTile({ data: { rowCount: 0, lastImportAt: null, asOf: null, stale: true, daysSinceAsOf: null }, loading: false, failed: false }), liveFeedTile(basiqLiveStatus())]);
    expect(r.tile("nab-csv").textContent).toContain("Unknown");
    expect(r.tile("nab-csv").textContent).toContain("None imported");
    expect(r.tile("nab-csv").textContent).toContain("Import a NAB CSV");
    await r.click("nab-csv");
    expect(r.recovered).toEqual([["import", "nab-csv"]]);
    const live = r.tile("live-feed").textContent ?? "";
    expect(live).toContain("Live bank feed");
    expect(live).toContain("Not connected");
    expect(live).toContain("Deferred by owner decision");
    noSuccess(r.host);
    await r.done();
  });

  test("CSV data: imported, as of the latest posted date, with the last import time", async () => {
    const r = await render([csvDataTile({ data: CSV_OK, loading: false, failed: false }), liveFeedTile(basiqLiveStatus())]);
    const csv = r.tile("nab-csv").textContent ?? "";
    expect(csv).toContain("Imported");
    expect(csv).toMatch(/As of 26 Sept? 2026/);
    expect(csv).toContain("24 rows");
    expect(csv).toContain("Updated 1 h ago");
    // Imported CSV data never turns the live feed into "connected".
    expect(r.tile("live-feed").textContent).toContain("Not connected");
    expect(r.tile("live-feed").textContent).not.toContain("Connected ");
    await r.done();
  });

  test("the live-feed tile maps every Basiq phase honestly (only a fresh sync may be green)", () => {
    const b = basiqLiveStatus();
    const live = liveFeedTile(b);
    expect(live.value).toBe("Not connected");
    // Honest-state vocabulary (Track 1): an unconnected feed is "setup required", never live and never green.
    expect(live.state).toBe("setup-required");
    expect(live.tone).toBeUndefined();
    const at = (phase: string) => { const t = liveFeedTile({ ...b, phase } as any); return [t.value, t.state ?? null, t.tone ?? null]; };
    expect(at("error")).toEqual([null, "failed", null]);
    expect(at("stale")).toEqual(["Connected", "stale", null]);
    expect(at("awaiting-consent")).toEqual(["Awaiting consent", "setup-required", null]);
    expect(at("revoked")).toEqual(["Revoked", "setup-required", null]);
    expect(at("fresh")).toEqual(["Connected", "ok", "success"]);
  });

  test("finance-page.tsx has no hard-coded bank tile and derives both facts", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/components/shell/pages/finance-page.tsx"), "utf8");
    expect(src).not.toMatch(/value="Not connected"|label="Bank"/);
    expect(src).toContain("csvDataTile(");
    expect(src).toContain("liveFeedTile(");
    expect(src).toContain("/__finance_manual/status");
  });
});

describe("item 2: the month-end hint says exactly how the projection is made", () => {
  test("fixed fees in full + metered at its daily rate across every day of the month; unpriced left out", () => {
    const hint = monthEndHint(AI);
    expect(hint).toBe("Subscriptions A$703.00 in full, plus metered use at its daily rate so far for all 30 days of September 2026. Leaves out 1 unpriced item.");
    // Same arithmetic as the snapshot: 703 + 3.75 / 23.5 × 30.
    expect(AI.totals.projectedAud).toBeCloseTo(703 + (3.75 / 23.5) * 30, 2);
    expect(hint).not.toMatch(/extended to 30 days|Metered use so far/);
  });
});

describe("item 3: one package-margin presentation, sourced from business-economics.ts", () => {
  // Reads every .tsx under src/components (~270 files, ~4 MB). Usually well under a second, but
  // it timed out at 5.7 s with the disk busy under load; 20 s is 3x that.
  test("packageEconomicsMatrix is rendered by exactly one component, labelled estimate / ex GST", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(f) && files.push(p); } };
    walk(join(import.meta.dir, "../../src/components"));
    const users = files.filter((f) => readFileSync(f, "utf8").includes("packageEconomicsMatrix("));
    expect(users.map((f) => f.replace(/\\/g, "/").split("/src/")[1])).toEqual(["components/shell/pages/finance-page.tsx"]);
    const src = readFileSync(users[0], "utf8");
    expect(src).toContain("Package margins (estimate)");
    expect(src).toContain("Price / month ex GST");
    expect(src).toContain('"Approved" : "Proposed"');
    expect(src).toContain("Open the economics workbench");
    // 390 px: no fixed-min-width table in a scroll container (page overflow + axe scrollable-region-focusable).
    expect(src).not.toMatch(/overflow-x-auto|min-w-\[\d+px\]/);
    expect(src).toContain("md:hidden");
  }, 20_000);
});

describe("item 4: Stripe payouts are transfers in the NAB CSV summary, never cash in", () => {
  test("a payout is excluded from cash in, reported with transfers and as stripePayouts", () => {
    const store = openManualFinanceStore(":memory:");
    store.importCsv("usman", buildNabCsv([
      { date: "01 Sep 26", amount: "825.00", type: "TRANSFER CREDIT", details: "SYNTHETIC CLIENT DEPOSIT INV-0001" },
      { date: "18 Sep 26", amount: "412.50", type: "MISCELLANEOUS CREDIT", details: "STRIPE PAYMENTS AUST SYNTH PAYOUT" },
      { date: "19 Sep 26", amount: "-5.00", type: "MISCELLANEOUS DEBIT", details: "STRIPE SYNTH FEE" },
      { date: "26 Sep 26", amount: "100.00", type: "MISCELLANEOUS CREDIT", details: "STRIPE PAYMENTS AUST SYNTH PAYOUT 2", processedOn: null },
    ]), "test");
    // Stored as it was parsed (ordinary Stripe credit): the summary applies the rule, so rows
    // imported before this change are classified the same way.
    expect(store.rows("usman").find((r) => r.vendorId === "stripe-payouts" && r.status === "posted")?.kind).toBe("ordinary");
    const s = summary("usman", "all", { store, today: "2026-09-27" });
    expect(s.cashInCents).toBe(82500);
    expect(s.stripePayouts).toEqual({ inCents: 41250, count: 1 });
    expect(s.transfers).toEqual({ inCents: 41250, outCents: 0, count: 1 });
    expect(s.pending).toMatchObject({ count: 1, inCents: 10000 }); // a pending payout isn't counted anywhere yet
    expect(s.cashOutCents).toBe(500); // a Stripe debit is still a real cost
    expect(s.byCategory.some((c) => c.category === "payments-income")).toBe(false);
    expect(s.notes.join(" ")).toContain("Stripe payouts are reported with transfers");
    // Stripe says it earned 412.50 this month (synthetic). NAB cash in + Stripe revenue now
    // counts that money once: 825.00 + 412.50, not 825.00 + 412.50 + 412.50.
    const stripeRevenueCents = 41250;
    expect(s.cashInCents + stripeRevenueCents).toBe(123750);
  });
});

describe("item 5: loading, empty, error and stale all render; no green zero from a failed source", () => {
  test("AI tiles: loading → skeletons; failed → 'Couldn't read' + Retry; never a number", async () => {
    const loading = await render(aiSpendTiles({ data: undefined, loading: true, failed: false }));
    expect(loading.host.querySelectorAll('[aria-label$="loading"]').length).toBe(3);
    await loading.done();
    const failed = await render(aiSpendTiles({ data: undefined, loading: false, failed: true }));
    expect(failed.tile("ai-spend").textContent).toContain("Couldn't read");
    expect(failed.tile("ai-spend").querySelector('[data-tone="danger"]')).not.toBeNull();
    expect(failed.host.textContent).not.toMatch(/A\$\d/);
    noSuccess(failed.host);
    await failed.click("ai-spend");
    expect(failed.recovered).toEqual([["retry", "ai-spend"]]);
    await failed.done();
  });

  test("AI tiles: a failed refresh keeps the last snapshot marked stale; a real zero is 'zero', not green", async () => {
    const stale = await render(aiSpendTiles({ data: AI, loading: false, failed: true }));
    expect(stale.tile("ai-spend").textContent).toContain("Stale");
    expect(stale.tile("ai-spend").textContent).toContain("A$706.75");
    expect(stale.tile("ai-spend").textContent).toContain("Retry");
    await stale.done();
    const zero = aiSpendTiles({ data: { ...AI, totals: { ...AI.totals, fixedAud: 0, meteredAud: 0, monthAud: 0, projectedAud: 0, unknown: [] } }, loading: false, failed: false });
    expect(zero.map((t) => t.state)).toEqual(["zero", "zero", "zero"]);
    const r = await render(zero);
    noSuccess(r.host);
    expect(r.tile("ai-unpriced").textContent).toContain("Every item priced");
    await r.done();
    const old = await render(aiSpendTiles({ data: { ...AI, generatedAt: new Date(NOW - AI_STALE_MS - 60_000).toISOString() }, loading: false, failed: false }));
    expect(old.tile("ai-spend").textContent).toContain("Stale · updated");
    await old.done();
  });

  test("CSV tile: loading, failed (no data), failed (last data kept, stale) and stale data", async () => {
    const tiles = [
      { ...csvDataTile({ data: undefined, loading: true, failed: false }), id: "a" },
      { ...csvDataTile({ data: undefined, loading: false, failed: true }), id: "b" },
      { ...csvDataTile({ data: CSV_OK, loading: false, failed: true }), id: "c" },
      { ...csvDataTile({ data: { ...CSV_OK, asOf: "2026-09-10", stale: true, daysSinceAsOf: 17 }, loading: false, failed: false }), id: "d" },
    ];
    const r = await render(tiles);
    expect(r.tile("a").getAttribute("data-state")).toBe("loading");
    expect(r.tile("b").textContent).toContain("Couldn't read");
    expect(r.tile("b").textContent).toContain("Retry");
    expect(r.tile("c").textContent).toContain("Stale");
    expect(r.tile("c").textContent).toContain("latest check failed");
    expect(r.tile("d").textContent).toMatch(/As of 10 Sept? 2026 · 17 days old/);
    expect(r.tile("d").textContent).toContain("Import a newer NAB CSV");
    noSuccess(r.host);
    await r.done();
  });

  test("NAB section: loading and error render; a failed read or an empty period never shows green cash", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const props = { period: "this-month" as const, onPeriod: () => {}, busy: false, message: null, onFile: () => {}, onClear: () => {}, embedded: true };
    let retried = 0;
    await act(async () => { root.render(createElement(ManualFinanceView, { ...props, status: null, data: null, loadError: null })); });
    expect(host.textContent).toContain("Loading your imported NAB data");
    expect(host.textContent).toContain("Bank cash flow (NAB CSV)");
    expect(host.querySelector("h1")).toBeNull(); // embedded: the shell page owns the title
    await act(async () => { root.render(createElement(ManualFinanceView, { ...props, status: null, data: null, loadError: "Finance request failed", onRetry: () => { retried++; } })); });
    expect(host.textContent).toContain("Finance data unavailable");
    const retry = [...host.querySelectorAll("button")].find((b: any) => b.textContent === "Retry") as any;
    await act(async () => { retry.click(); });
    expect(retried).toBe(1);
    expect(host.textContent).not.toMatch(/\$\d/);

    const store = openManualFinanceStore(":memory:");
    store.importCsv("usman", buildNabCsv([{ date: "03 Aug 26", amount: "-31.25", type: "EFTPOS DEBIT", details: "V0000 VERCEL INC USD 20.00" }]), "test");
    const status: ManualFinanceStatus = { owner: "usman", source: "nab-csv-manual", rowCount: 1, lastImportAt: new Date(NOW).toISOString(), audit: [], basiq: basiqLiveStatus(), legacyNab: { admitted: false }, maxBytes: 4 * 1024 * 1024, asOf: "2026-08-03", stale: true, daysSinceAsOf: 55 };
    const empty = summary("usman", "this-month", { store, today: "2026-09-27" });
    await act(async () => { root.render(createElement(ManualFinanceView, { ...props, status, data: empty, loadError: null })); });
    expect(host.textContent).toContain("Unknown for this month"); // not a green $0.00
    expect(host.textContent).not.toContain("$0.00");
    expect(host.querySelector(".text-success")).toBeNull(); // $0.00 cash in is not green
    const all = summary("usman", "all", { store, today: "2026-09-27" });
    await act(async () => { root.render(createElement(ManualFinanceView, { ...props, status, data: all, loadError: "Finance request failed" })); });
    expect(host.textContent).toContain("The figures below are the last ones loaded");
    expect(host.textContent).not.toContain("Up to date");
    expect(host.querySelector(".text-success")).toBeNull();
    await act(async () => root.unmount());
  });
});

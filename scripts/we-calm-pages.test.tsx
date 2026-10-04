// W-E (29 Sep 2026): the calm Finance, Finances, AI usage, System and Models pages (L3, same day, moved
// them onto the widget grid: structure assertions below follow it; the widget behaviours are in
// l3-widget-layout.test.tsx). What changed functionally: Finance → Finances now shows the NAB CSV ledger (it only read the empty Mercury
// snapshot and Stripe, so it "had nothing"); an empty ledger is a one-step import with a drop zone;
// Finance derives "next steps" from its tiles; details fold behind FoldCard; SignalWidget keeps every
// honest state of SignalTile. Synthetic data only; no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAB_ONE_STEP, aiSpendTiles, csvDataTile, financeNextSteps, type AiTotals, type FinanceTile } from "../src/components/finance/signals";
import { ManualFinanceView, type ManualFinanceStatus } from "../src/components/finance/manual-finance";
import { FoldCard } from "../src/components/shell/calm";
import { basiqLiveStatus } from "./nab/basiq-live";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = Date.parse("2026-09-29T02:00:00Z");

const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
});

const AI: AiTotals = {
  generatedAt: new Date(NOW - 60_000).toISOString(),
  month: { label: "September 2026", daysInMonth: 30 },
  totals: { fixedAud: 340, meteredAud: 0, monthAud: 340, projectedAud: 340, unknown: ["ChatGPT subscriptions (Hermes pool unreadable)"] },
  apiKeys: [],
};
const tiles = (csv: FinanceTile, ai: AiTotals | null = AI) => {
  const [aiSpend, , unpriced] = aiSpendTiles({ data: ai, loading: false, failed: !ai });
  return { csv, aiSpend, unpriced };
};

describe("Finance next steps come only from the tiles' own states", () => {
  test("nothing imported: the one-step NAB import in the owner's words; unpriced AI items; Stripe not connected", () => {
    const csv = csvDataTile({ data: { rowCount: 0, lastImportAt: null }, loading: false, failed: false });
    const steps = financeNextSteps({ ...tiles(csv), stripe: "not-connected" });
    expect(steps.map((s) => s.id)).toEqual(["ai-price", "nab-import", "stripe-connect"]); // attention first
    const nab = steps.find((s) => s.id === "nab-import")!;
    expect(nab.title).toBe("Import your first NAB CSV (one step)");
    expect(nab.body).toContain("Export a CSV from NAB Internet Banking → Accounts → Export");
    expect(nab.body).toContain("unknown, not zero");
    expect(nab.action).toEqual({ label: "Import a NAB CSV", kind: "import" });
    expect(steps.find((s) => s.id === "ai-price")!).toMatchObject({ title: "1 AI item isn't in the total", action: { kind: "link", to: "/usage", hash: "prices" } });
    expect(steps.find((s) => s.id === "stripe-connect")!.body).toContain("Nothing here moves money");
  });

  test("a stale import asks for a newer export; a failed status read is a retry, never 'none imported'", () => {
    const stale = csvDataTile({ data: { rowCount: 24, lastImportAt: new Date(NOW - 20 * 86_400_000).toISOString(), asOf: "2026-09-01", stale: true, daysSinceAsOf: 28 }, loading: false, failed: false });
    expect(financeNextSteps({ ...tiles(stale), stripe: "connected" })[0]).toMatchObject({ id: "nab-refresh", tone: "attention", action: { kind: "import" } });
    const failed = csvDataTile({ data: null, loading: false, failed: true });
    const steps = financeNextSteps({ ...tiles(failed), stripe: "connected" });
    expect(steps[0]).toMatchObject({ id: "nab-retry", action: { kind: "retry-nab" } });
    expect(steps.some((s) => s.id === "nab-import")).toBe(false);
  });

  test("all in order: no steps (the page says nothing needs you); loading tiles invent nothing", () => {
    const ok = csvDataTile({ data: { rowCount: 24, lastImportAt: new Date(NOW - 3_600_000).toISOString(), asOf: "2026-09-28", stale: false }, loading: false, failed: false });
    expect(financeNextSteps({ ...tiles(ok, { ...AI, totals: { ...AI.totals, unknown: [] } }), stripe: "connected" })).toEqual([]);
    const loading = csvDataTile({ data: null, loading: true, failed: false });
    const [aiSpend, , unpriced] = aiSpendTiles({ data: null, loading: true, failed: false });
    expect(financeNextSteps({ csv: loading, aiSpend, unpriced, stripe: "unknown" })).toEqual([]);
  });

  test("the AI read failing is its own step", () => {
    const csv = csvDataTile({ data: { rowCount: 3, lastImportAt: new Date(NOW).toISOString(), asOf: "2026-09-28" }, loading: false, failed: false });
    expect(financeNextSteps({ ...tiles(csv, null), stripe: "connected" }).map((s) => s.id)).toEqual(["ai-retry"]);
  });
});

describe("the empty NAB ledger is one friendly step with a drop zone", () => {
  const status: ManualFinanceStatus = { owner: "shared", source: "nab-csv-manual", rowCount: 0, lastImportAt: null, audit: [], basiq: basiqLiveStatus(), legacyNab: { admitted: false }, maxBytes: 4 * 1024 * 1024 };
  const props = { period: "this-month" as const, onPeriod: () => {}, status, data: null, loadError: null, busy: false, message: null, onFile: () => {}, onClear: () => {}, embedded: true };

  test("owner's wording, the file button, the honest 'unknown, not zero', and no figures", () => {
    const out = renderToStaticMarkup(createElement(ManualFinanceView, props));
    expect(NAB_ONE_STEP).toBe("Export a CSV from NAB Internet Banking → Accounts → Export, then drop it here.");
    expect(out).toContain(NAB_ONE_STEP);
    expect(out).toContain("data-first-import");
    expect(out).toContain("Drop the NAB CSV here");
    expect(out).toContain("data-nab-import-button");
    expect(out).toContain('type="file"');
    expect(out).toContain("No NAB data imported yet");
    expect(out).toContain("unknown, not zero");
    expect(out).toContain('id="nab-csv-import"');
    expect(out).not.toMatch(/\$\d/);
    // Where the numbers come from is folded, not removed: the live-feed card is still in the markup.
    expect(out).toContain("Where the numbers come from");
    expect(out).toContain("deferred by your decision (NAB CSV is the route)");
    expect(out).toMatch(/aria-expanded="false"/);
  });

  test("once rows are imported the compact zone returns and the first-import step is gone", () => {
    const out = renderToStaticMarkup(createElement(ManualFinanceView, { ...props, status: { ...status, rowCount: 5, asOf: "2026-09-26" } }));
    expect(out).not.toContain("data-first-import");
    expect(out).toContain("Import a NAB CSV");
  });
});

describe("Finance → Finances reads the ledger (it used to show nothing)", () => {
  test("the Finances tab renders FinancesTab (ledger mount, Stripe, Mercury only when saved) outside demo mode", () => {
    const business = read("src/routes/business.tsx");
    expect(business).toContain('{view === "finance" && !demo.enabled && <FinancesTab finances={workspace?.finances} />}');
    expect(business).not.toContain("<FinanceSnapshotState");
    const tab = read("src/components/finance/finances-tab.tsx");
    expect(tab).toContain('area="finance"');
    expect(tab).toContain("<StripeFinancePanel />");
    expect(tab).toContain("{mercury && <FinanceSnapshotState finances={finances} />}");
    expect(tab).not.toMatch(/Connect an account|onExamples/);
  });

  test("/finance links its import to the Finances drop zone and keeps its derived tiles", () => {
    const page = read("src/components/shell/pages/finance-page.tsx");
    expect(page).toContain('const FINANCES = { to: "/business", search: { view: "finance" }, hash: NAB_IMPORT_ANCHOR } as const;');
    expect(page).toContain("financeNextSteps(");
    expect(page).not.toContain("DestinationMount"); // the ledger lives on Finances, once
    expect(page).toContain("Package margins (estimate)"); // the margins are one list widget (no decorative rings)
    expect(page).not.toContain("<ProgressRing");
    expect(page).toContain('<FoldCard id="margins-by-basis"');
  });
});

describe("FoldCard folds, never removes", () => {
  test("closed by default with the detail in the DOM (inert); a click opens it", async () => {
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(FoldCard, { id: "prices", summary: "Prices", meta: "7 prices · 2 not set" }, createElement("p", null, "Claude Max 20x")));
    });
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toContain("Claude Max 20x");
    expect(host.textContent).toContain("7 prices · 2 not set");
    expect(host.querySelector('[id="prices"]')).not.toBeNull(); // #prices links land on it
    await act(async () => (button as unknown as { click: () => void }).click());
    expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => root.unmount());
  });
});

describe("System, Models and AI usage: widget grids, with the T8/T8b/T8c behaviours intact", () => {
  test("System uses widgets and still starts the provider check only from two clicks", () => {
    const sys = read("src/components/shell/pages/system-page.tsx");
    expect(sys).toContain("<SignalWidget");
    expect(sys).not.toContain("<SignalTile");
    expect(sys).not.toContain("<CalmSignal");
    expect(sys).toContain('getJson<ModelSnapshot>("/__operator/models?snapshot=1")');
    expect([...sys.matchAll(/onClick=\{checkModels\}/g)].length).toBe(2);
    expect(sys).toContain('id: "system-devices"'); // device controls one click away, not removed
    expect(sys).toContain("<MeterBar"); // plan limits as slim bars, not rings
    expect(sys).not.toContain("<ProgressRing");
  });
  test("Models: one widget per provider; a provider that needs a look opens by itself, the summary says so", () => {
    const models = read("src/components/shell/pages/models-page.tsx");
    expect(models).toContain("defaultOpen: !!p.alert || narrowed");
    expect(models).toContain("keepMounted: true"); // every model row stays on the page, hidden until its provider opens
    expect(models).toContain("none used in the last 30 days.");
    expect(models).not.toMatch(/\bcap(s|Id)?\b\s*[:=(]|spending limit|set (a )?cap/i);
  });
  test("AI usage: the top stays; keys open for detail; tokens, freshness and prices are one click away with a summary", () => {
    const usage = read("src/components/ai-usage/ai-usage-page.tsx");
    for (const id of ['id: "claude-models"', 'id: "freshness"', 'id: "prices"']) expect(usage).toContain(id);
    expect(usage).toContain('defaultOpen={r.status === "warn" || r.status === "danger"}');
    expect(usage).toContain("<SplitBar"); // the top the owner liked is unchanged
    expect(usage).toContain('id="subscriptions"');
  });
  test("the owned pages fill the width: no fixed-width centred column, one page foot", () => {
    for (const f of [
      "src/components/shell/pages/finance-page.tsx",
      "src/components/shell/pages/system-page.tsx",
      "src/components/shell/pages/models-page.tsx",
      "src/components/ai-usage/ai-usage-page.tsx",
    ]) {
      const src = read(f);
      expect(src).toContain("<PageFoot");
      expect(src).toContain("<WidgetGrid");
      expect(src).not.toMatch(/max-w-\[1[0-9]{3}px\]/);
    }
    // The W-E reading scale stays on the pages that have not moved to the grid.
    for (const f of ["src/components/operator/skill-drafts-page.tsx", "src/routes/skills.tsx", "src/routes/settings.tsx"]) expect(read(f)).toContain("<CalmPage");
    const css = read("src/components/shell/calm.css");
    expect(css).toContain(".calm-page {");
    expect(css).not.toContain(":root"); // the base tokens stay W-G's
  });
});
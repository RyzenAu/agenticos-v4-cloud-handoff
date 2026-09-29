// L3 (29 Sep 2026): Finance, AI usage & spend, System, Models, Goals and Mission Control on the shared
// widget grid. Layout only: every feature and honest state stays. What is pinned here:
//   - SignalWidget keeps SignalTile's honest states (unknown, failed, setup-required, stale, estimate)
//   - DeckSection / WidgetDeck: closed by default, one click opens the detail under its widget, the
//     choice is remembered, a #id link opens it, keepMounted keeps the detail on the page
//   - the plain one-line explanations (headlines, "N not verified", "N failed of N calls", a rejected key)
//   - the OpenRouter 401 on /usage is ONE calm sentence with the next step, the provider's words in detail
//   - the pages' structure (no fixed-width column, no small print, one page foot, Goals as widgets)
// Synthetic data only; no network, no key values.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Gauge } from "lucide-react";
import { DeckSection, MeterBar, SignalWidget, WidgetDeck, agoText, pressureOf } from "../src/components/shell/widgets";
import { keyProblem, providerWords } from "../src/components/ai-usage/key-state";
import { usageHeadline, AiUsagePage } from "../src/components/ai-usage/ai-usage-page";
import { csvDataTile, financeHeadline, aiSpendTiles, type AiTotals } from "../src/components/finance/signals";
import { providerExplain, systemHeadline, providerSummary } from "../src/components/shell/system-facts";
import { failureLine, modelsHeadline, type ProviderFacts } from "../src/components/shell/models-facts";
import type { AiUsageSnapshot } from "../src/lib/ai-usage";
import { MeasuredTokens } from "../src/components/measured-tokens";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = Date.parse("2026-09-29T02:00:00Z");

const saved: Record<string, PropertyDescriptor | undefined> = {};
const store = new Map<string, string>();
beforeAll(() => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const w = window as unknown as Record<string, unknown>;
  w.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, v: string) => void store.set(key, v) };
  w.location = { hash: "" };
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
});

async function inRouter(el: React.ReactElement): Promise<string> {
  const rootRoute = createRootRoute({ component: () => el });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("SignalWidget keeps SignalTile's honest states", () => {
  const html = (p: Partial<Parameters<typeof SignalWidget>[0]> & { title: string; value: Parameters<typeof SignalWidget>[0]["value"] }) => renderToStaticMarkup(createElement(SignalWidget, p));
  test("failed shows 'Couldn't read' in danger, never the number", () => {
    const out = html({ title: "AI spend", value: 340, state: "failed", now: NOW });
    expect(out).toContain("Couldn&#x27;t read");
    expect(out).toContain("text-danger");
    expect(out).not.toContain(">340<");
  });
  test("unknown and setup-required show their word; a missing value is a dash, not zero", () => {
    expect(html({ title: "Bank", value: null, state: "unknown" })).toContain(">Unknown<");
    expect(html({ title: "Revenue", value: null, state: "setup-required" })).toContain(">Setup required<");
    const empty = html({ title: "Nearest plan limit", value: null });
    expect(empty).toContain(">—<");
    expect(empty).not.toMatch(/>0%?</);
    // A setup-required tile that carries a real word ("Not connected") keeps that word.
    expect(html({ title: "Live bank feed", value: "Not connected", state: "setup-required" })).toContain("Not connected");
  });
  test("stale drops a success tone and says 'Stale' as a short badge; an estimate says 'Estimate'", () => {
    const stale = html({ title: "Imported", value: "Imported", tone: "success", state: "ok", updatedAt: NOW - 10 * 86_400_000, now: NOW, staleAfterMs: 86_400_000 });
    expect(stale).not.toContain("text-success");
    expect(stale).toContain(">Stale<");
    const est = html({ title: "Month end", value: "≈ A$340.00", state: "simulated" });
    expect(est).toContain(">Estimate<");
    expect(est).not.toContain("Updated"); // freshness is the page foot's line, not a chip on every card
  });
  test("a live tile has no 'Live' chip; loading shows a status skeleton, not a number", () => {
    const live = html({ title: "Calls", value: 3, state: "ok", now: NOW, updatedAt: NOW - 30_000 });
    expect(live).not.toContain(">Live<");
    expect(live).toContain(">3<");
    const loading = html({ title: "Calls", value: 3, loading: true });
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain(">3<");
  });
  test("one action: an explicit action wins, then a recovery, then the link", () => {
    const action = html({ title: "A", value: null, state: "failed", recovery: { label: "Retry", onClick: () => {} }, action: createElement("button", null, "Import") });
    expect(action).toContain(">Import<");
    expect(action).not.toContain(">Retry<");
    expect(html({ title: "A", value: null, state: "failed", recovery: { label: "Retry", onClick: () => {} } })).toContain(">Retry<");
    // A recovery is not offered for a healthy reading.
    expect(html({ title: "A", value: 1, state: "ok", recovery: { label: "Retry", onClick: () => {} } })).not.toContain(">Retry<");
  });
  test("long words step down in size so they fit a quarter-width card on one or two lines", () => {
    expect(html({ title: "Revenue", value: "Not connected" })).toContain('class="text-xl"');
    expect(html({ title: "Calls", value: "12" })).not.toContain('class="text-xl"');
  });
});

describe("MeterBar and pressure", () => {
  test("gold normal, copper from 70%, red from 90%; the bar has a meter role and words", () => {
    expect(pressureOf(12)).toBe("normal");
    expect(pressureOf(70)).toBe("warn");
    expect(pressureOf(90)).toBe("danger");
    expect(pressureOf(null)).toBe("normal");
    const out = renderToStaticMarkup(createElement(MeterBar, { label: "Weekly", percent: 96 }));
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuenow="96"');
    expect(out).toContain('aria-label="Weekly: 96% used"');
    expect(out).toContain("bg-danger");
  });
});

describe("agoText", () => {
  test("plain words for the page foot; null without a time", () => {
    expect(agoText(NOW - 30_000, NOW)).toBe("just now");
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(agoText(null, NOW)).toBeNull();
    expect(agoText("not a date", NOW)).toBeNull();
  });
});

describe("DeckSection / WidgetDeck: the detail is one click away, under its widget", () => {
  const items = (extra: Partial<Parameters<typeof WidgetDeck>[0]["items"][number]> = {}) => [
    { id: "d-one", icon: Gauge, title: "One", value: 3, line: "three things", detail: createElement("p", null, "detail-one"), ...extra },
    { id: "d-two", icon: Gauge, title: "Two", line: "no value", detail: () => createElement("p", null, "detail-two") },
  ];
  test("closed by default: a widget with an aria-expanded button; lazy detail is not mounted", () => {
    const out = renderToStaticMarkup(createElement(WidgetDeck, { items: items() }));
    expect(out).toContain("data-widget-deck");
    expect(out).toContain("grid-flow-dense"); // an open panel drops under its row and the widgets after it fill that row
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-label="Open One"');
    expect(out).not.toContain("detail-one");
    expect(out).not.toContain("detail-two");
  });
  test("keepMounted keeps the detail on the page, hidden; defaultOpen shows it", () => {
    const kept = renderToStaticMarkup(createElement(WidgetDeck, { items: items({ keepMounted: true }) }));
    expect(kept).toContain("detail-one");
    expect(kept).toMatch(/<section id="d-one" hidden=""/);
    const open = renderToStaticMarkup(createElement(WidgetDeck, { items: items({ defaultOpen: true }) }));
    expect(open).toContain("detail-one");
    expect(open).not.toMatch(/<section id="d-one" hidden/);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-label="Close One"');
  });
  test("a widget with no value shows no dash: the value block is left out", () => {
    const out = renderToStaticMarkup(createElement(WidgetDeck, { items: items() }));
    expect(out.match(/data-widget-value/g)).toHaveLength(1);
  });
  test("clicking Open mounts the detail, remembers the choice under calm-open:<key>, and Close unmounts it", async () => {
    store.clear();
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(DeckSection, { ...items({ persistKey: "t-one" })[0] }));
    });
    const button = () => host.querySelector("button")! as unknown as { click: () => void; getAttribute: (n: string) => string | null };
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("detail-one");
    await act(async () => button().click());
    expect(host.textContent).toContain("detail-one");
    expect(store.get("calm-open:t-one")).toBe("1");
    await act(async () => button().click());
    expect(host.textContent).not.toContain("detail-one");
    expect(store.get("calm-open:t-one")).toBe("0");
    await act(async () => root.unmount());
  });
  test("a stored choice applies after load; a #id link opens that panel", async () => {
    store.clear();
    store.set("calm-open:t-stored", "1");
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(DeckSection, { ...items({ id: "d-stored", persistKey: "t-stored" })[0] }));
    });
    expect(host.textContent).toContain("detail-one");
    await act(async () => root.unmount());
    const root2 = createRoot(host);
    (window as unknown as { location: { hash: string } }).location.hash = "#d-hash";
    await act(async () => {
      root2.render(createElement(DeckSection, { ...items({ id: "d-hash" })[0] }));
    });
    expect(host.textContent).toContain("detail-one");
    await act(async () => root2.unmount());
    (window as unknown as { location: { hash: string } }).location.hash = "";
  });
});

describe("plain one-line explanations", () => {
  const ai: AiTotals = {
    generatedAt: new Date(NOW - 60_000).toISOString(),
    month: { label: "September 2026", daysInMonth: 30 },
    totals: { fixedAud: 340, meteredAud: 0, monthAud: 340, projectedAud: 340, unknown: [] },
  };
  test("Finance headline: AI spend first, then what is missing; unknown is never turned into a zero", () => {
    const [aiSpend] = aiSpendTiles({ data: ai, loading: false, failed: false });
    const none = csvDataTile({ data: { rowCount: 0, lastImportAt: null }, loading: false, failed: false });
    expect(financeHeadline({ aiSpend, csv: none, stripe: "not-connected" })).toBe("AI spend is A$340.00 so far this month; no bank data is imported and Stripe isn't connected.");
    const ok = csvDataTile({ data: { rowCount: 24, lastImportAt: new Date(NOW).toISOString(), asOf: "2026-09-28", stale: false }, loading: false, failed: false });
    expect(financeHeadline({ aiSpend, csv: ok, stripe: "connected" })).toBe("AI spend is A$340.00 so far this month.");
    const stale = csvDataTile({ data: { rowCount: 24, lastImportAt: new Date(NOW).toISOString(), asOf: "2026-09-01", stale: true, daysSinceAsOf: 28 }, loading: false, failed: false });
    expect(financeHeadline({ aiSpend, csv: stale, stripe: "unknown" })).toContain("the bank import is out of date");
    const [failed] = aiSpendTiles({ data: null, loading: false, failed: true });
    expect(financeHeadline({ aiSpend: failed, csv: ok, stripe: "connected" })).toBe("AI spend couldn't be read.");
  });

  test("System: '2 not verified' names the providers and what it means; failures come first", () => {
    const statuses = [
      { id: "codex", ready: true, detail: "Signed in" },
      { id: "hermes", ready: true, installed: true, detail: "Installed" },
      { id: "openrouter", ready: true, catalogReady: true, detail: "Catalogue downloaded" },
      { id: "ollama", ready: false, detail: "Not running" },
    ];
    const name = (id: string) => ({ hermes: "Hermes", openrouter: "OpenRouter" })[id] ?? id;
    expect(providerExplain(statuses, name)).toBe("2 not verified: Hermes and OpenRouter are set up but not tested live.");
    expect(providerExplain([statuses[0]], name)).toBeNull();
    expect(providerExplain([{ id: "claude", ready: false, detail: "Could not verify the sign-in" }, statuses[1]], (id) => (id === "claude" ? "Claude Code" : "Hermes"))).toBe("1 failed: Claude Code. 1 not verified: Hermes is set up but not tested live.");
    const many = ["a", "b", "c", "d"].map((id) => ({ id: "hermes", ready: true, installed: true, detail: id }));
    expect(providerExplain(many, () => "X")).toContain("X, X and 2 more");
  });
  test("System headline: from the same reads as the widgets; a plain fallback while nothing has answered", () => {
    const p = providerSummary([{ id: "codex", ready: true, detail: "" }, { id: "hermes", ready: true, installed: true, detail: "" }]);
    expect(systemHeadline({ providers: p, providersEmpty: false, toolsNeedingAttention: 2 })).toBe("1 of 2 model providers verified; 2 tools need attention.");
    expect(systemHeadline({ providers: p, providersEmpty: false, toolsNeedingAttention: 1 })).toContain("1 tool needs attention");
    expect(systemHeadline({ providers: null, providersEmpty: false, toolsNeedingAttention: null })).toBe("Model providers, tools, plan limits and devices.");
    expect(systemHeadline({ providers: p, providersEmpty: true, toolsNeedingAttention: null })).toBe("Model providers, tools, plan limits and devices.");
  });

  const facts = (rows: { label: string; failures: number }[]) =>
    rows.map((r) => ({ provider: { id: r.label, label: r.label }, models: [{ usage: { failures: r.failures, calls: 10 } }] })) as unknown as ProviderFacts[];
  test("Models: 'N failed of N calls' says the share and where; no calls and no failures are said plainly", () => {
    const f = facts([{ label: "OpenRouter", failures: 3 }, { label: "Groq", failures: 1 }]);
    expect(failureLine(f, { failures: 4, calls: 226 })).toBe("4 of 226 calls failed in 30 days (about 2%). Most on OpenRouter.");
    expect(failureLine(f, { failures: 1, calls: 400 })).toContain("under 1%");
    expect(failureLine(f, { failures: 0, calls: 226 })).toBe("No failed calls in 226 (30 days).");
    expect(failureLine(f, { failures: 0, calls: 0 })).toBe("No calls recorded in the last 30 days.");
    expect(modelsHeadline({ free: 19, freeUnverified: 4, subscription: 60, metered: 143 }, false)).toBe("226 model routes: 23 free, 60 on a plan, 143 metered.");
    expect(modelsHeadline({ free: 0, freeUnverified: 0, subscription: 0, metered: 0 }, true)).toBe("Every model route the OS can use, and how each one is doing.");
  });
});

describe("a key the provider rejected is one calm sentence with the next step", () => {
  const note = "Windows environment (used by the OS and Hermes). OpenRouter returned HTTP 401: User not found.";
  test("keyProblem: rejected / rate-limited / unreachable; healthy and other rows are left alone", () => {
    const rejected = keyProblem({ provider: "OpenRouter", status: "unavailable", note });
    expect(rejected).toMatchObject({ kind: "rejected", badge: "Key rejected", line: "OpenRouter key was rejected — replace it in Settings.", fix: { to: "/settings", hash: "connections" } });
    expect(keyProblem({ provider: "ElevenLabs", status: "unavailable", note: "Env file. ElevenLabs returned HTTP 403: invalid api key" })?.kind).toBe("rejected");
    expect(keyProblem({ provider: "DeepSeek", status: "unavailable", note: "DeepSeek returned HTTP 429" })?.kind).toBe("rate-limited");
    expect(keyProblem({ provider: "Pinecone", status: "unavailable", note: "Pinecone unreachable (TimeoutError)" })?.kind).toBe("unreachable");
    expect(keyProblem({ provider: "Twilio", status: "unavailable", note: "Not linked: credentials aren't in the OS config yet" })).toBeNull();
    expect(keyProblem({ provider: "OpenRouter", status: "ok", note: "returned HTTP 401 in the past" })).toBeNull();
    expect(keyProblem({ provider: "OpenRouter", status: "info", note: "No OpenRouter key configured" })).toBeNull();
  });
  test("providerWords drops the 'where the key came from' lead-in and keeps the provider's message", () => {
    expect(providerWords(note)).toBe("OpenRouter returned HTTP 401: User not found.");
    expect(providerWords("just a note")).toBe("just a note");
  });

  const snapshot = (): AiUsageSnapshot => ({
    generatedAt: new Date(NOW - 120_000).toISOString(),
    month: { label: "September 2026", start: "2026-09-01T00:00:00+10:00", end: "2026-10-01T00:00:00+10:00", dayOfMonth: 29, daysInMonth: 30 },
    fx: { usdToAud: 1.4258, source: "RBA", asOf: "2026-09-28", stale: false },
    totals: { fixedAud: 340, meteredAud: 0, monthAud: 340, projectedAud: 340, unknown: ["OpenRouter OPENROUTER_API_KEY"], includesEstimates: false },
    subscriptions: [
      { id: "claude:max", provider: "anthropic", owner: "M&U Ventures", plan: "Claude Max 20x", planSlug: null, monthly: { aud: 340, original: { amount: 340, currency: "AUD" } }, priceNote: "A$340.00 incl. GST", status: { ok: false, reason: "No Claude Code sign-in found", checkedAt: null }, peakPercent: null },
      { id: "codex:openai-1", provider: "openai", owner: "Usman", plan: "Pro", planSlug: null, monthly: null, priceNote: "not set", status: { ok: true, windows: [{ label: "5-hour", usedPercent: 63, resetsAt: null }], notes: [], freshness: { checkedAt: new Date(NOW).toISOString(), source: "codex", estimated: false } }, peakPercent: 63 },
    ],
    apiKeys: [{ id: "openrouter:abc", provider: "OpenRouter", keyName: "OPENROUTER_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note, freshness: { checkedAt: null, source: "—", estimated: false } }],
    claudeModels: { ok: false, reason: "synthetic", checkedAt: null },
    prices: [],
    sources: [{ name: "OpenRouter", ok: false, reason: "HTTP 401", freshness: { checkedAt: null, source: "—", estimated: false } }],
  });
  const render = async () => {
    const client = new QueryClient();
    client.setQueryData(["ai-usage"], snapshot());
    return inRouter(createElement(QueryClientProvider, { client }, createElement(AiUsagePage)));
  };

  test("/usage: the reading path says the key was rejected and where to fix it; the raw HTTP words sit in the row's detail", async () => {
    const html = await render();
    expect(usageHeadline(snapshot())).toBe("A$340.00 so far in September 2026, day 29 of 30; 1 item isn't priced yet.");
    expect(html).toContain("OpenRouter key was rejected — replace it in Settings.");
    expect(html).toContain(">Key rejected<");
    expect(html).toContain('data-key-problem="rejected"');
    expect(html).toContain('href="/settings#connections"');
    expect(html).toContain("1 rejected"); // the list widget's short badge
    // The provider's own message is still there, but only after the row's plain sentence, under its own label.
    expect(html).toContain("What the provider said");
    expect(html.indexOf("HTTP 401: User not found")).toBeGreaterThan(html.indexOf("What the provider said"));
    expect(html.indexOf("HTTP 401: User not found")).toBeGreaterThan(html.indexOf("OpenRouter key was rejected"));
    // Not an alarm wall: the badge is not danger-toned and there is no red notice for it.
    expect(html).not.toMatch(/OpenRouter returned HTTP 401[^<]*<\/span><\/span><\/span>/);
  });
  test("/usage: one widget per plan with its big percentage; an unavailable plan says so in words", async () => {
    const html = await render();
    expect(html).toContain("data-plan=\"codex:openai-1\"");
    expect(html).toContain(">63%<");
    expect(html).toContain(">Unavailable<");
    expect(html).toContain("No Claude Code sign-in found");
    expect(html).toContain('role="meter"');
    // Freshness and the exchange rate are the one foot line.
    expect(html).toContain("data-page-foot");
    expect(html).toContain("US$1 = A$1.4258");
  });
});

describe("page structure (L3)", () => {
  const PAGES = [
    "src/components/shell/pages/finance-page.tsx",
    "src/components/shell/pages/system-page.tsx",
    "src/components/shell/pages/models-page.tsx",
    "src/components/ai-usage/ai-usage-page.tsx",
  ];
  test("no hard-coded small print and no fixed-width column on the converted pages", () => {
    for (const f of [...PAGES, "src/components/finance/finances-tab.tsx", "src/components/finance/manual-finance.tsx", "src/components/business/stripe-finance-panel.tsx", "src/components/business/north-star-goals.tsx", "src/components/business/progress-panel.tsx", "src/routes/-pages/dashboard.tsx", "src/components/shell/widgets.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/text-\[(?:9|10|11|11\.5|12)px\]/);
      expect(src).not.toMatch(/max-w-\[1[0-9]{3}px\]/);
    }
  });
  test("no decorative rings, 'Updated just now' chips or (i) tips on the converted pages", () => {
    for (const f of PAGES) {
      const src = read(f);
      expect(src).not.toContain("<ProgressRing");
      expect(src).not.toContain("<InfoTip");
      // Freshness is the one PageFoot line, never a chip (a Badge) on the page.
      expect(src).not.toMatch(/<Badge[^>]*>\s*Updated /);
    }
  });
  test("Goals: the long-term goals and the horizons are widgets; the decorative calendar art is gone; every editing control stays", () => {
    const goals = read("src/components/business/north-star-goals.tsx");
    expect(goals).toContain("<WidgetGrid");
    expect(goals).toContain("held as a goal, not measured here");
    expect(goals.match(/RevenueRing model=/g)).toHaveLength(1);
    const progress = read("src/components/business/progress-panel.tsx");
    expect(progress).toContain("<WidgetGrid");
    for (const id of ["week", "month", "quarter"]) expect(progress).toContain(`id: "${id}"`);
    for (const control of ['aria-label="Progress update"', 'aria-label="Link update to goal"', 'action: "check-in"', 'action: "remove-goal"', "renewedFromId: goal.id", "<ProgressMeasures />", "askOperator("]) expect(progress).toContain(control);
    expect(progress).not.toContain("GoalCalendarArt");
    expect(read("src/components/business/progress.css")).not.toMatch(/font-size:\s*(?:9|10|11|12)px/);
  });
  test("Mission Control: the top numbers stay; the sections are widgets with a value and a line, opened on demand", () => {
    const page = read("src/routes/-pages/dashboard.tsx");
    expect(page).toContain('aria-label="Key numbers"');
    expect(page.match(/<McSection /g)!.length).toBe(14);
    expect(page.match(/<McSection /g)!.length).toBe(page.match(/<\/McSection>/g)!.length);
    expect(page).toContain("function McSection(");
    expect(page).toContain("InCalmSection.Provider");
    // Away mode and Leads read the same query keys their panels use, so opening one reuses the answer.
    expect(page).toContain('queryKey: ["leads-calls", 5]');
    expect(page).toContain('queryKey: ["away-mode"]');
    // The example graph is called an example on its widget, in one line, never presented as the owner's project.
    expect(page).toContain('title="Example graph"');
    expect(page).toContain('line="Sample knowledge graph, not your project"');
    expect(page).toContain("Example graph · not your project");
  });
});

describe("Mission Control's token view shows measured figures only", () => {
  const rows = [
    { model: "claude-opus-4-1", requests: 1204, inputTokens: 5_400_000, outputTokens: 900_000, cacheReadTokens: 61_000_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, apiEquivalent: { aud: 300, original: { amount: 210, currency: "USD" as const } } },
    { model: "claude-haiku-4-5", requests: 96, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, apiEquivalent: { aud: 100, original: { amount: 70, currency: "USD" as const } } },
  ];
  const usage = (claudeModels: unknown) => ({ claudeModels }) as unknown as AiUsageSnapshot;
  const measured = { rows, totalApiEquivalent: { aud: 400, original: { amount: 280, currency: "USD" as const } }, freshness: { checkedAt: null, source: "transcripts", estimated: true }, scope: "This month on this PC." };
  const html = (u: AiUsageSnapshot | undefined, open: string | null = null) => renderToStaticMarkup(createElement(MeasuredTokens, { usage: u, expandedModel: open, setExpandedModel: () => {} }));

  test("with a source: the transcript counts and the A$ they cost, with shares as plain arithmetic", () => {
    const out = html(usage(measured), "claude-opus-4-1");
    expect(out).toContain("1,204 requests");
    expect(out).toContain("75%"); // 300 of 400
    expect(out).toContain("25%");
    expect(out).toContain("Requests");
    expect(out).toContain("Cache read tokens");
    expect(out).toContain("61M"); // measured cache-read tokens, not a percentage
    expect(out).toContain("Other providers aren&#x27;t measured here");
  });
  test("the invented fields are gone: no cache-hit %, no per-call cost from a share, no guessed rates", () => {
    const out = html(usage(measured), "claude-opus-4-1");
    for (const gone of ["Cache hit", "Avg cost / call", "Input rate", "Output rate", "/M tok", "tokenomics"]) expect(out).not.toContain(gone);
    const src = read("src/routes/-pages/dashboard.tsx") + read("src/components/measured-tokens.tsx");
    for (const gone of ["cacheHitPct", "20 + m.share * 800", "fallbackUsageDaily", "savingsTips", "SpendExpansion", "OperatorScorePill", "computeOperatorScore", "modelSplit", "tokenEquivalent", "inRate", "outRate"]) expect(src).not.toContain(gone);
  });
  test("no source: 'Not measured' with the reason; never a number", () => {
    expect(html(undefined)).toContain("Not measured yet");
    const off = html(usage({ ok: false, reason: "transcripts unreadable", checkedAt: null }));
    expect(off).toContain("Not measured");
    expect(off).toContain("transcripts unreadable");
    expect(off).not.toMatch(/A\$\d/);
    expect(html(usage({ ...measured, rows: [] }))).toContain("No Claude usage recorded this month");
  });
  test("an unpriced model says 'not priced' and has no share", () => {
    const out = html(usage({ ...measured, rows: [{ ...rows[0], apiEquivalent: null }, rows[1]] }));
    expect(out).toContain("not priced");
  });
  test("the Activity sparkline uses only measured days: no sample series", () => {
    const page = read("src/routes/-pages/dashboard.tsx");
    expect(page).toContain("usageDaily.length > 1 ?");
    expect(page).not.toContain("usageDaily as fallbackUsageDaily");
  });
});
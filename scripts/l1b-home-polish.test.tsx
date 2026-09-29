// L1b (29 Sep 2026): the second polish pass on Home (/business) and Inbox. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BUSINESS_VIEWS, BUSINESS_VIEW_TITLE } from "../src/lib/business-view";
import { CURRENCIES } from "../src/lib/currency";
import { CurrencyChip } from "../src/components/business/currency-chip";
import { MarkBusiness, undecidedIncoming } from "../src/components/business/mark-business";
import type { ManualFinanceApi } from "../src/components/finance/manual-finance";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// 1. No text under 12 px on Home or the Inbox ---------------------------------------------------------
const BUSINESS = ["ai-spend-panel", "audience-content", "audience", "brief-today", "business-setup", "connections-polish", "daily-brief", "overview-cards", "quick-actions", "studio-videos", "workspace-overview"].map((n) => `src/components/business/${n}.css`);
const FILES = [
  "src/routes/business.css",
  ...BUSINESS,
  "src/components/operator/setup-welcome.css",
  "src/components/operator/inbox-white.css",
  "src/components/operator/inbox-refinements.css",
  "src/components/operator/mail-archive-panel.css",
  "src/components/operator/account-connection-access.css",
  "src/components/business/audience-panel.tsx",
  "src/components/business/daily-brief.tsx",
  "src/components/business/mu-brief.tsx",
  "src/components/business/mark-business.tsx",
  "src/components/business/currency-chip.tsx",
  "src/components/business/workspace-overview.tsx",
  "src/components/business/quick-actions.tsx",
  "src/components/shell/pages/today-page.tsx",
  "src/components/operator/inbox-workspace.tsx",
  "src/components/operator/inbox-daily-brief.tsx",
  "src/routes/business.tsx",
];
const TINY = [/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g, /font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/g, /fontSize:\s*(?:[0-9]|1[01])(?:\.\d+)?(?=[,\s}])/g];

describe("Home and Inbox: nothing set below 12 px", () => {
  test("no tiny Tailwind sizes, px font sizes or numeric fontSize in the Home and Inbox sources", () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const src = read(file);
      for (const re of TINY) for (const m of src.matchAll(re)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
  test("the 9.5 px badge is gone and the stale brief is one line", () => {
    const tsx = read("src/components/business/daily-brief.tsx");
    expect(tsx).not.toContain("Not today");
    expect(tsx).toContain("Brief is from {dayShort}");
    expect(tsx).not.toContain("Its priorities and numbers may be out of date");
  });
});

// 2. Tabs: the banner and the heading -----------------------------------------------------------------
describe("the Setup banner and the h1 follow the open tab", () => {
  test("the h1 names the tab; only Overview is Home", () => {
    expect(BUSINESS_VIEW_TITLE.overview).toBe("Home");
    for (const v of BUSINESS_VIEWS) if (v !== "overview") expect(BUSINESS_VIEW_TITLE[v]).not.toBe("Home");
    expect(BUSINESS_VIEW_TITLE).toMatchObject({ finance: "Finances", progress: "Goals", audience: "Audience" });
    expect(read("src/routes/business.tsx")).toContain("title={BUSINESS_VIEW_TITLE[view]}");
  });
  test("SetupWelcome renders only on Overview (it already hides itself once the profile is complete)", () => {
    const page = read("src/routes/business.tsx");
    expect(page).toContain('{view === "overview" && <SetupWelcome />}');
    expect(page.match(/<SetupWelcome/g)?.length).toBe(1);
    expect(read("src/components/operator/setup-welcome.tsx")).toContain("profile.onboardingCompletedAt) return null");
  });
});

// 3. Currency: one small chip, the list opens on click ------------------------------------------------
describe("the currency control is a compact chip", () => {
  test("shows the current code, keeps all currencies in a native list, and notes a fallback", () => {
    const html = renderToStaticMarkup(<CurrencyChip selected="AUD" showing="AUD" onChange={() => {}} />);
    expect(html).toContain('class="biz-currency-code"');
    expect(html).toContain(">AUD<");
    expect(html).toContain('aria-label="Business currency"');
    expect(html.match(/<option /g)?.length).toBe(CURRENCIES.length);
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(11);
    expect(html).not.toContain("Showing");
    expect(renderToStaticMarkup(<CurrencyChip selected="GBP" showing="USD" onChange={() => {}} />)).toContain("Showing USD while rates load");
  });
  test("the visible chip is the code only; the long names live in the list", () => {
    const html = renderToStaticMarkup(<CurrencyChip selected="AUD" showing="AUD" onChange={() => {}} />);
    const visible = html.replace(/<select[\s\S]*<\/select>/, "").replace(/title="[^"]*"/, "");
    expect(visible).not.toContain("Australian Dollar");
    expect(visible).not.toMatch(/>Currency</);
  });
});

// 5. One "where these numbers come from" ------------------------------------------------------------
describe("one sources fold on Home", () => {
  test("Home has a single 'Where these numbers come from' and the old second one is gone", () => {
    const brief = read("src/components/business/mu-brief.tsx");
    const today = read("src/components/shell/pages/today-page.tsx");
    expect(brief).not.toContain('title="Where these numbers come from"');
    expect(today.match(/title="Where these numbers come from"/g)?.length).toBe(1);
    expect(today).not.toContain("Where the lists above come from");
    expect(read("src/routes/business.tsx")).toContain("<BriefSources />");
    expect(brief).not.toContain("From your own records: the NAB ledger");
  });
});

// 7. One-tap "Mark as business" ---------------------------------------------------------------------
const row = (over: Record<string, unknown> = {}) => ({ id: "tx-1", amountCents: 82_500, kind: "ordinary", scope: "unreviewed", status: "posted", vendorLabel: "Client deposit", ...over }) as never;

describe("Mark as business uses the ledger's own correction route", () => {
  test("only undecided, posted, ordinary money IN counts", () => {
    const rows = [row(), row({ id: "a", scope: "business" }), row({ id: "b", amountCents: -1200 }), row({ id: "c", kind: "transfer" }), row({ id: "d", status: "pending" })];
    expect(undecidedIncoming(rows).map((r) => r.id)).toEqual(["tx-1"]);
  });
  const api = (rows: unknown[]): ManualFinanceApi => ({ transactions: async () => ({ filter: "review", total: rows.length, rows: rows as never }), correct: async () => ({}) }) as never;
  function html(rows: unknown[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["business-facts", "nab-undecided-in"], { filter: "review", total: rows.length, rows });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MarkBusiness api={api(rows)} />
      </QueryClientProvider>,
    );
  }
  test("one undecided payment: a one-tap button that names it", () => {
    const out = html([row()]);
    expect(out).toContain("Mark as business");
    expect(out).toContain("Mark the Client deposit payment as business");
  });
  test("nothing undecided, or still loading: no button", () => {
    expect(html([row({ scope: "business" })])).not.toContain("Mark as business");
    const client = new QueryClient();
    expect(renderToStaticMarkup(<QueryClientProvider client={client}><MarkBusiness api={api([])} /></QueryClientProvider>)).not.toContain("Mark as business");
  });
  test("it patches only scope to business through /correct, and refreshes the brief facts", () => {
    const src = read("src/components/business/mark-business.tsx");
    expect(src).toContain('api.correct!(only.id, { scope: "business" })');
    expect(src).toContain('invalidateQueries({ queryKey: ["business-facts"] })');
    expect(read("src/components/business/mu-brief.tsx")).toContain("<MarkBusiness />");
  });
});

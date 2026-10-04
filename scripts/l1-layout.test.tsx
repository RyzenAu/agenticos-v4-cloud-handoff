// L1 (29 Sep 2026): Today, Inbox, Receptionist, Work and Leads on the shared widget grid. The owner:
// "see how the widgets and how everything is spaced and filled out the screen". Layout only: every
// feature and honest state stays; routine freshness and sources move to one page-foot line.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { WidgetEmpty } from "../src/components/ds";
import { CallQueue } from "../src/components/operator/call-queue";
import type { BoardLead } from "../src/lib/leads";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("WidgetEmpty", () => {
  test("plain words inside a widget, no dashed box", () => {
    const out = html(<WidgetEmpty title="Nothing booked" body="Call-backs show here." />);
    expect(out).toContain("data-widget-empty");
    expect(out).toContain("Nothing booked");
    expect(out).not.toContain("border-dashed");
  });
});

describe("SignalTile quiet (the widget-grid tiles)", () => {
  async function render(props: Record<string, unknown>) {
    const { SignalTile } = await import("../src/components/shell/page-parts");
    const rootRoute = createRootRoute({
      component: () => (
        <SignalTile label="Calls to make" to="/leads" now={Date.parse("2026-09-29T00:00:30Z")} updatedAt="2026-09-29T00:00:00Z" {...props} />
      ),
    });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return html(<RouterProvider router={router} />);
  }
  test("a live tile shows no 'Live' chip and no 'Updated just now'; the loud version still does", async () => {
    const quiet = await render({ quiet: true, value: 3, state: "live" });
    expect(quiet).not.toContain(">Live<");
    expect(quiet).not.toContain("Updated");
    expect(quiet).toContain("h-full");
    // One action inside the card, at its foot: Open when the read is fine.
    expect(quiet).toMatch(/^<div class="sh-signal h-full" data-signal-quiet="">[\s\S]*<div class="mt-auto[^"]*"><a[^>]*aria-label="Open Calls to make"/);
    expect(quiet).toMatch(/<\/a><\/div><\/div>$/);
    const loud = await render({ value: 3, state: "live" });
    expect(loud).toContain(">Live<");
    expect(loud).toContain("Updated");
  });
  test("a recovery (Retry, Connect the inbox) is the card's action, inside the card, not below it", async () => {
    const out = await render({ quiet: true, value: null, state: "failed", recovery: { label: "Retry", onClick: () => {} } });
    expect(out).toMatch(/^<div class="sh-signal h-full" data-signal-quiet="">[\s\S]*<div class="mt-auto[^"]*"><button type="button"[^>]*>Retry<\/button><\/div><\/div>$/);
    expect(out).not.toContain('aria-label="Open Calls to make"'); // one action only
    const link = await render({ quiet: true, value: null, state: "setup-required", recovery: { label: "Connect the inbox", to: "/settings" } });
    expect(link).toMatch(/<div class="mt-auto[^"]*"><a[^>]*>Connect the inbox<\/a><\/div><\/div>$/);
  });
  test("unknown and stale are still said, as short words", async () => {
    expect(await render({ quiet: true, value: null, state: "unknown" })).toContain(">Unknown<");
    const stale = await render({ quiet: true, value: 3, state: "live", updatedAt: "2026-09-28T20:00:00Z" });
    expect(stale).toContain(">Stale<");
    expect(stale).toContain("Stale · updated");
  });
});

describe("Leads: the call queue leads the grid", () => {
  const lead = (id: number): BoardLead =>
    ({ id, name: "Fixture practice", area: "Parramatta NSW", phone: "0299990000", website: "", address: "", mapsUrl: "", emails: [], emailOk: false, vertical: "dental", score: 50, pitch: "website", reasons: [], status: "to_call", owner: "usman", nextAt: "2026-09-28T06:00:00+10:00", lastContactAt: null, createdAt: "2026-09-01T00:00:00Z", deal: { closed: false, stage: "found", nextAction: "Call", evidence: "CRM", owner: "agent", stageSince: null, daysInStage: null, daysInferred: false, stuck: null, economics: {}, contactPref: "", issues: [] } }) as unknown as BoardLead;
  test("CallQueue is a spanning widget with a count; its cards are wells, not cards in a card", () => {
    const out = html(<CallQueue leads={[lead(1)]} now={Date.parse("2026-09-28T07:00:00+10:00")} loading={false} error={null} onOpen={() => {}} />);
    expect(out).toMatch(/^<section[^>]*data-widget=""[^>]*data-span="2"/);
    expect(out).toContain(">Calls to make</h2>");
    expect(out).toContain("bg-inset border border-border"); // Surface inset
    expect(out).toContain("Calling hours closed");
    const empty = html(<CallQueue leads={[]} now={Date.parse("2026-09-28T07:00:00+10:00")} loading={false} error={null} onOpen={() => {}} />);
    expect(empty).toContain("No calls due");
    expect(empty).toContain("data-widget-empty");
  });
  test("page: headline is the morning sentence, the queue is the grid's first widget, sources in the foot", () => {
    const page = read("src/components/operator/leads-crm.tsx");
    expect(page).toContain('description={overview.data?.sentence ?? "Calls to make first, then the pipeline."}');
    expect(page).toMatch(/lead=\{\s*<CallQueue/); // the queue is the overview's lead widget (Today workspace)
    expect(page).not.toContain("max-w-[1400px]");
    expect(page).toContain("No automatic outreach · Map data © OpenStreetMap contributors"); // the one wording that ships
    const overview = read("src/components/operator/crm-overview.tsx");
    expect(overview.indexOf("{lead}")).toBeLessThan(overview.indexOf("<TodoList"));
    expect(overview).toContain("<WidgetGrid>");
  });
});

describe("Today, Work, Receptionist, Inbox: one headline, a full-width grid, one foot line", () => {
  test("Home (Today merged into the Business brief): Needs you leads, rings and the header freshness are gone, the facts stay", () => {
    const page = read("src/components/shell/pages/today-page.tsx");
    expect(page).not.toContain("CaptionedRing");
    expect(page).not.toContain("max-w-[1320px]");
    const needs = page.indexOf('title="Needs you"');
    expect(needs).toBeGreaterThan(0);
    expect(needs).toBeLessThan(page.indexOf('title="Needs attention"'));
    expect(page.indexOf('title="Needs attention"')).toBeLessThan(page.indexOf("<SignalTile"));
    expect(page).toContain("quiet");
    // The Waiting-on-you tile's number, breakdown and retry head the Needs you widget.
    expect(page).toContain("badge={needsBadge}");
    expect(page).toContain("needsTile.hint");
    expect(page).toContain('retry("needsYou")');
    // Top three next actions, the rest in Work; one gold Start.
    expect(page).toContain("const NEXT_SHOWN = NEEDS_YOU_LIST_SHOWN;"); // one constant, shared with what Jarvis reads out (needs-you.ts: 3)
    expect(page).toContain('variant="accent"');
    // Sources and freshness: one folded foot section, not a line on every tile.
    expect(page).toContain("<Freshness at={r.updatedAt} now={now} />");
    expect(page).toContain("<CallingWindow now={now} />"); // moved into the Calls tile, not removed
    expect(page).toContain('title="Where these numbers come from"');
    // Home: the page's headline is Today's five-second line; Today's parts lead, the brief follows.
    const home = read("src/routes/business.tsx");
    expect(home).toContain("title={BUSINESS_VIEW_TITLE[view]}"); // Overview is Home; the other tabs name themselves (L1b)
    expect(home).toContain("todayModel.focus.headline");
    expect(home.indexOf("<TodayFocus")).toBeGreaterThan(0);
    expect(home.indexOf("<TodayFocus")).toBeLessThan(home.indexOf("<MuBrief"));
    expect(home.indexOf("<MuBrief")).toBeLessThan(home.indexOf("<TodaySources"));
  });
  test("Work: decisions first, compact counts and detailed panels remain reachable", () => {
    const page = read("src/components/shell/pages/work-page.tsx");
    expect(page).not.toContain("VerdictCard");
    expect(page).toContain('label: "Decisions"');
    expect(page.indexOf('label: "Decisions"')).toBeLessThan(page.indexOf('label: "Calls to make"'));
    expect(page).toContain("Calls, pipeline & site status");
    expect(page).not.toContain("Review the decisions"); // the decisions are the list directly below
    expect(read("src/components/workspace/panel-shell.tsx")).toContain('<Surface as="section" id={id}'); // the anchor now exists
    expect(page).toContain('<PageFoot title="From the same reads as the cards');
  });
  test("PanelShell: a routine 'Updated …' is screen-reader only; stale, failed and refreshing stay visible", () => {
    const shell = read("src/components/workspace/panel-shell.tsx");
    expect(shell).toContain('const routine = !stale && text.startsWith("Updated ") && !text.includes("refreshing");');
    expect(shell).toContain('routine ? "sr-only" : "mt-0.5 text-[13px]"');
  });
  test("Receptionist: headline, D1 tiles on the grid, no 'Updated' chip or (i) in the header", () => {
    const page = read("src/components/receptionist/dashboard/index.tsx");
    expect(page).not.toContain(`description="Calls, clients and launch readiness."`); // R11: the title and tabs say it
    expect(page).toContain("collapsible={false}"); // stale warnings must remain visible
    expect(page).not.toContain("<InfoTip");
    expect(page).not.toMatch(/<Badge[^>]*>Updated/);
    // L10: no routine "Updated … · Sources: …" line either; the foot shows only when the read is stale or missing.
    expect(page).toMatch(/const foot = data \? staleNote\(data\.generatedAt, now\) : null;/);
    expect(page).toMatch(/\{foot && \(\s*<PageFoot/);
    expect(page).not.toContain("Sources: /__receptionist");
    expect(page).toContain("<Tabs tabs={tabs}"); // tabs stay
    expect(read("src/components/receptionist/dashboard/sell-status.tsx")).toContain('<WidgetGrid mobile={2} data-rx-tiles="">');
  });
  test("Inbox: the owner's headline, to-answer first, source widgets, library after, tokens not px", () => {
    const src = read("src/components/operator/inbox-workspace.tsx");
    expect(src).not.toContain('description="Your conversations, at a glance."'); // R11: the title says it
    const grid = src.slice(src.indexOf('className="wi-overview wi-overview-grid"'));
    expect(grid.indexOf('title="To answer"')).toBeLessThan(grid.indexOf('title="Ask your inbox"'));
    expect(grid.indexOf('title="Ask your inbox"')).toBeLessThan(grid.indexOf("grouped.map((source)"));
    expect(src.indexOf("<MailArchivePanel />")).toBeGreaterThan(src.indexOf("<InboxOverview"));
    for (const css of ["src/components/operator/inbox-white.css", "src/components/operator/inbox-refinements.css"]) expect(read(css)).not.toMatch(/font-size:\s*\d+(\.\d+)?px/);
  });
});

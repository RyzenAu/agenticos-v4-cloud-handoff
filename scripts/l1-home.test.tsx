// L1 Home merge (29 Sep 2026, owner): Today merged INTO the Business brief. One Home at /business:
// Today's Needs you (top 3, one gold Start), Needs attention and the four quick stats lead; the brief
// (overview, finance, progress, audience) keeps its structure. /today redirects; the nav says Home.
// Synthetic data only; renders with react-dom/server, no browser.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { DESTINATIONS, REDIRECTS, locate } from "../src/components/shell/destinations";
import { resolveCommand, buildCommandIndex } from "../src/lib/commands/registry";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// jarvis-slot reads import.meta.glob, which only Vite defines; the Start button needs just openJarvis.
mock.module("../src/components/shell/jarvis-slot", () => ({ openJarvis: () => {} }));
const { TodayFocus, TodaySources, useToday } = await import("../src/components/shell/pages/today-page");

function HomeParts() {
  const m = useToday();
  return (
    <>
      <p data-headline="">{m.focus.headline}</p>
      <TodayFocus m={m} />
      <TodaySources m={m} />
    </>
  );
}

async function render() {
  const rootRoute = createRootRoute({ component: HomeParts });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Home content: Today's parts, before anything has loaded", () => {
  test("Needs you, Needs attention and the four quick stats are all there, in that order", async () => {
    const out = await render();
    const needs = out.indexOf("Needs you");
    const attention = out.indexOf("Needs attention");
    expect(needs).toBeGreaterThan(-1);
    expect(needs).toBeLessThan(attention);
    // the four stats (calls, receptionist, sites, email), one tile each, after the two lists
    const tiles = [...out.matchAll(/data-today-tile="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(tiles).toEqual(["callQueue", "receptionist", "websites", "email"]);
    expect(out.indexOf('data-today-tile="callQueue"')).toBeGreaterThan(attention);
    // Running now and Enquiries stay, one line each
    expect(out).toContain("Running now");
    expect(out).toContain("Enquiries");
    expect(out).toContain("Pipeline");
    // nothing is invented while reading: skeletons, never a number or "all clear"
    expect(out).toContain("Loading next actions");
    expect(out).not.toContain("Nothing on fire");
    expect(out).not.toContain("No owner decisions waiting");
    // the folded foot: where the numbers come from, one section
    expect(out).toContain("Where these numbers come from");
  });
  test("no progress rings and no per-tile 'Updated' chips on the home grid", async () => {
    const out = await render();
    expect(out).not.toMatch(/role="progressbar"|data-ring-value|stroke-dasharray/);
    expect(out).not.toContain("Updated just now");
  });
});

describe("Home is the landing page and /today redirects to it", () => {
  test("the first destination is Home and lives at /business; old links resolve to it", () => {
    expect(DESTINATIONS[0]).toMatchObject({ label: "Home", to: "/business" });
    expect(locate("/business")?.destination.label).toBe("Home");
    expect(locate("/today")?.destination.label).toBe("Home");
    expect(locate("/")?.destination.label).toBe("Home");
    // Goals is still its own entry, on the same route
    expect(locate("/business", "progress")?.drilldown?.label).toBe("Goals");
    expect(REDIRECTS["/today"]).toBe("/business");
  });
  test("/today redirects to /business and keeps ?scene=1; /workspace and / land there too", () => {
    const today = read("src/routes/today.tsx");
    expect(today).toContain('redirect({ to: "/business"');
    expect(today).toContain("search: location.search");
    expect(today).not.toContain("component:");
    expect(read("src/routes/workspace.tsx")).toContain('to: "/business"');
    expect(read("src/routes/index.tsx")).toContain('to: "/business"');
  });
  test("the brand, the not-found page and the sidebar say Home and go to /business", () => {
    expect(read("src/components/app-sidebar.tsx")).toContain('<Link to="/business" className="op-brand ar-brand-refined"');
    expect(read("src/routes/__root.tsx")).toContain("Go home");
    expect(read("src/routes/__root.tsx")).not.toContain('to="/today"');
  });
  test("typing or saying Today, Home or Command scene still lands on Home", () => {
    const index = buildCommandIndex();
    for (const text of ["open today", "open home"]) {
      const r = resolveCommand(text, index);
      expect(r.status === "resolved" && r.entry.action).toMatchObject({ type: "navigate", to: "/business" });
    }
  });
});

describe("Home page: the brief keeps its structure, Today's parts lead, the page fills the frame", () => {
  const page = read("src/routes/business.tsx");
  test("headline is Today's five-second line on Overview; the other tabs keep a plain line", () => {
    expect(page).toContain("title={BUSINESS_VIEW_TITLE[view]}"); // Overview is Home; the other tabs name themselves (L1b)
    expect(page).toContain('view === "overview" ? todayModel.focus.headline');
  });
  test("Overview order (R12): attention/active/results, the signals, then the brief, quick actions, the workspace overview, then sources", () => {
    const order = ["<HomeOverview", "<HomeSignals", "<MuBrief", "<QuickActions", "<WorkspaceOverview", "<TodaySources"].map((s) => page.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the brief's other tabs are untouched
    for (const tab of ['view === "finance"', 'view === "progress"', 'view === "audience"']) expect(page).toContain(tab);
    // Today's parts show on Overview only
    expect(page).toContain('{view === "overview" && <HomeOverview m={todayModel} />}');
  });
  test("full width: the old 1260px column is gone", () => {
    const css = read("src/routes/business.css");
    expect(css).not.toContain("max-width: 1260px");
    expect(css).toContain("max-width: 1680px");
  });
});

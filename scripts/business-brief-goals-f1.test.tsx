// Audit F1 (28 Sep 2026), Business brief and Goals: one current sidebar entry (F1-20), the tab
// lives in the URL (F1-21), AUD by default (F1-22), no upstream news card (F1-23), and Enter adds
// a goal (F1-27). Synthetic data only; renders with react-dom/server, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { DESTINATION_BY_ID, NAV_ACTIVE_OPTIONS, locate } from "../src/components/shell/destinations";
import { BUSINESS_VIEWS, businessSearchFor, businessViewOf, validateBusinessSearch } from "../src/lib/business-view";
import { DEFAULT_CURRENCY, storedCurrency, useCurrency } from "../src/lib/currency";
import { BriefRail } from "../src/components/business/brief-today";
import { ProgressPanel } from "../src/components/business/progress-panel";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const countCurrent = (html: string) => html.split('aria-current="page"').length - 1;

/** A router shaped like the app's: /business validates its search like the real route. */
function makeRouter(url: string, withOptions: boolean) {
  function Nav() {
    const path = useRouterState({ select: (s) => s.location.pathname });
    const view = useRouterState({ select: (s) => (s.location.search as Record<string, unknown>).view });
    const here = locate(path, typeof view === "string" ? view : undefined);
    const links: ReactNode[] = [];
    for (const id of ["today", "work", "memory"] as const) {
      const destination = DESTINATION_BY_ID[id];
      links.push(
        createElement(Link, {
          key: id,
          to: destination.to as never,
          ...(withOptions ? { activeOptions: NAV_ACTIVE_OPTIONS } : {}),
          "aria-current": here?.destination.id === id && !here.drilldown ? "page" : undefined,
          children: destination.label,
        } as never),
      );
      for (const dd of destination.drilldowns) {
        links.push(
          createElement(Link, {
            key: `${dd.to}${dd.view ?? ""}`,
            to: dd.to as never,
            search: (dd.view ? { view: dd.view } : dd.to === "/business" ? {} : undefined) as never,
            ...(withOptions ? { activeOptions: NAV_ACTIVE_OPTIONS } : {}),
            "aria-current": here?.drilldown === dd ? "page" : undefined,
            children: dd.label,
          } as never),
        );
      }
    }
    return createElement("nav", null, ...links, createElement(Outlet));
  }
  const root = createRootRoute({ component: Nav });
  const page = (path: string, extra: object = {}) => createRoute({ getParentRoute: () => root, path, component: () => null, ...extra });
  const tree = root.addChildren([
    page("/business", { validateSearch: validateBusinessSearch }),
    page("/work"),
    page("/memory"),
    page("/memory/vault"),
    page("/leads"),
  ]);
  return createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [url] }) });
}
async function sidebarHtml(url: string, withOptions = true) {
  const router = makeRouter(url, withOptions);
  await router.load();
  return renderToString(createElement(RouterProvider, { router } as never));
}

describe("F1-20: only the current page carries aria-current in the sidebar", () => {
  test("Goals is the one current entry on /business?view=progress", async () => {
    const html = await sidebarHtml("/business?view=progress");
    expect(countCurrent(html)).toBe(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Goals</);
  });
  test("Home (the Business brief) is the one current entry on /business; its Audience tab has its own entry (audit P2-2)", async () => {
    const home = await sidebarHtml("/business");
    expect(countCurrent(home)).toBe(1);
    expect(home).toMatch(/aria-current="page"[^>]*>Home</);
    const audience = await sidebarHtml("/business?view=audience");
    expect(countCurrent(audience)).toBe(1);
    expect(audience).toMatch(/aria-current="page"[^>]*>Audience</);
  });
  test("a nested page doesn't also mark its destination (Memory > Vault)", async () => {
    const html = await sidebarHtml("/memory/vault");
    expect(countCurrent(html)).toBe(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Vault</);
  });
  test("without the exact match the router's own marking doubles up (the audit's finding)", async () => {
    expect(countCurrent(await sidebarHtml("/business?view=progress", false))).toBe(2);
  });
  test("the real sidebar passes the exact match to every link and no longer clicks page tabs", () => {
    const sidebar = read("src/components/app-sidebar.tsx");
    expect(sidebar.match(/activeOptions=\{NAV_ACTIVE_OPTIONS\}/g)?.length).toBe(2);
    expect(sidebar).not.toContain("biz-tab-");
  });
});

describe("F1-21: the Business tab is the URL's view", () => {
  test("the route's search: known views kept, overview and junk dropped, other keys pass through", () => {
    expect(validateBusinessSearch({ view: "progress" })).toEqual({ view: "progress" });
    expect(validateBusinessSearch({ view: "growth", platform: "youtube" })).toEqual({ view: "growth", platform: "youtube" });
    expect(validateBusinessSearch({ view: "overview" })).toEqual({});
    expect(validateBusinessSearch({ view: "bogus", dev: 1 })).toEqual({ dev: 1 });
    expect(validateBusinessSearch({ view: 3 })).toEqual({});
    expect(businessViewOf({})).toBe("overview");
    expect(businessViewOf({ view: "growth" })).toBe("audience");
    for (const view of BUSINESS_VIEWS.filter((v) => v !== "overview")) expect(businessViewOf(validateBusinessSearch({ view }))).toBe(view);
  });
  test("tab searches: overview has no view, leaving Audience drops its platform and record", () => {
    expect(businessSearchFor({ view: "progress", dev: 1 }, "overview")).toEqual({ dev: 1 });
    expect(businessSearchFor({ view: "audience", platform: "youtube", record: 1 }, "finance")).toEqual({ view: "finance" });
    expect(businessSearchFor({}, "audience", { platform: "tiktok", record: true })).toEqual({ view: "audience", platform: "tiktok", record: 1 });
    expect(businessSearchFor({ view: "audience", platform: "skool" }, "audience")).toEqual({ view: "audience", platform: "skool" });
  });
  test("tab changes are history entries: Back and Forward move the view, the URL and the sidebar together", async () => {
    const router = makeRouter("/business", true);
    await router.load();
    const view = () => businessViewOf(validateBusinessSearch(router.state.location.search as Record<string, unknown>));
    const current = () => {
      const s = router.state.location.search as Record<string, unknown>;
      const found = locate(router.state.location.pathname, typeof s.view === "string" ? s.view : undefined);
      return found?.drilldown?.label ?? found?.destination.label;
    };
    for (const next of ["progress", "audience"] as const) {
      await router.navigate({ to: "/business", search: (prev: Record<string, unknown>) => businessSearchFor(prev, next) } as never);
    }
    expect(view()).toBe("audience");
    expect(router.state.location.href).toBe("/business?view=audience");
    expect(current()).toBe("Audience");
    router.history.back();
    await router.load();
    expect(view()).toBe("progress");
    expect(router.state.location.href).toBe("/business?view=progress");
    expect(current()).toBe("Goals");
    router.history.back();
    await router.load();
    expect(view()).toBe("overview");
    expect(router.state.location.href).toBe("/business");
    router.history.forward();
    await router.load();
    expect(view()).toBe("progress");
  });
  test("the record flag reaches the URL as record=1, which the Audience panel reads", async () => {
    const router = makeRouter("/business", true);
    await router.load();
    await router.navigate({ to: "/business", search: (prev: Record<string, unknown>) => businessSearchFor(prev, "audience", { platform: "youtube", record: true }) } as never);
    const url = new URL(router.state.location.href, "http://x");
    expect(url.searchParams.get("record")).toBe("1");
    expect(url.searchParams.get("platform")).toBe("youtube");
  });
  test("the page reads the router, not window.history", () => {
    const page = read("src/routes/business.tsx");
    expect(page).toContain("validateSearch: validateBusinessSearch");
    expect(page).toContain("businessViewOf(search)");
    expect(page).not.toContain("replaceState");
    expect(page).not.toContain("useState<BusinessView>");
    expect(read("src/components/business/workspace-overview.tsx")).not.toContain("replaceState");
  });
});

describe("F1-22: the Business currency defaults to AUD", () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  test("no saved choice, or an unknown code, means AUD; a saved choice is kept", () => {
    expect(DEFAULT_CURRENCY).toBe("AUD");
    expect(storedCurrency(undefined)).toBe("AUD");
    expect(storedCurrency(storage(null))).toBe("AUD");
    expect(storedCurrency(storage("XYZ"))).toBe("AUD");
    expect(storedCurrency(storage("USD"))).toBe("USD");
    expect(storedCurrency(storage("GBP"))).toBe("GBP");
    expect(storedCurrency({ getItem: () => { throw new Error("blocked"); } })).toBe("AUD");
  });
  test("the picker renders AUD selected before anything is saved", () => {
    function Picker() {
      const cur = useCurrency();
      return createElement("output", null, `selected:${cur.selected}`);
    }
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Picker)));
    expect(html).toContain("selected:AUD");
  });
});

describe("F1-23: no upstream news card on the Business brief", () => {
  test("the rail shows today's calendar and nothing from AI with Jack", () => {
    const html = renderToStaticMarkup(
      createElement(BriefRail, {
        events: [{ id: "e1", title: "Synthetic check-in", start: "2026-09-28T00:00:00Z", end: "2026-09-28T00:30:00Z", allDay: false }],
        timeZone: "Australia/Sydney",
      }),
    );
    expect(html).toContain("Synthetic check-in");
    expect(html).toContain('href="/calendar"');
    expect(html).not.toMatch(/aiwithjack|AI with Jack|In AI today/i);
  });
  test("the brief no longer passes news to the rail, and the news styles are gone", () => {
    const brief = read("src/components/business/daily-brief.tsx");
    expect(brief).toContain("<BriefRail");
    expect(brief).not.toMatch(/BriefNews|data\?\.news/);
    const component = read("src/components/business/brief-today.tsx");
    expect(component).not.toMatch(/aiwithjack|ArticleImage|safeImage/);
    for (const css of ["src/components/business/brief-today.css", "src/components/business/daily-brief.css"])
      expect(read(css)).not.toMatch(/brief-news-(item|grid|visual|open|unavailable)|\.brief-news > header/);
  });
});

describe("F1-27: Enter in an add-goal box adds the goal", () => {
  test("each add-goal input shares a <form> with its submit button, disabled while blank", () => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ProgressPanel)));
    for (const label of ["this week", "this month", "this quarter"]) {
      const form = new RegExp(`<form[^>]*class="progress-add"[^>]*>(?:(?!</form>).)*aria-label="Add ${label} goal"(?:(?!</form>).)*</form>`, "s").exec(html)?.[0];
      expect(form).toBeTruthy();
      // Implicit submission (Enter) needs the form's own submit button; blank keeps it disabled.
      expect(form).toMatch(new RegExp(`<button type="submit" disabled="" aria-label="Add goal for ${label}"`));
    }
  });
});

// Track 8: a refresh that fails keeps the previous read on screen, so it must read as stale, never as
// a fresh "Updated …" (seen while live 8081 stopped answering for 20-30 s at a time on 28 Sep).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { tileState } from "../src/components/shell/today-facts";
import { PanelShell, panelFreshness } from "../src/components/workspace/panel-shell";
import type { PanelResult } from "../src/components/workspace/api";

const NOW = Date.parse("2026-09-28T03:00:00Z");
const ok: PanelResult<{ n: number }> = { ok: true, data: { n: 7 }, updatedAt: new Date(NOW - 2 * 60_000).toISOString(), ms: 40 };
const failed: PanelResult<{ n: number }> = { ok: false, error: "Timed out after 8 s", timedOut: true, updatedAt: new Date(NOW).toISOString(), ms: 8000 };

describe("Today tiles", () => {
  test("a recent read whose refresh failed is stale, not ok", () => {
    expect(tileState({ data: ok }, NOW)).toBe("ok");
    expect(tileState({ data: ok, isError: true }, NOW)).toBe("stale");
    expect(tileState({ data: ok, isError: true }, NOW, { zero: true })).toBe("stale");
  });
  test("failed and unknown still win over stale; nothing read and failed is failed", () => {
    expect(tileState({ data: failed, isError: true }, NOW)).toBe("failed");
    expect(tileState({ data: ok, isError: true }, NOW, { unknown: true })).toBe("unknown");
    expect(tileState({ isError: true }, NOW)).toBe("failed");
  });
});

describe("Workspace cards", () => {
  test("freshness line says the refresh failed and how old the shown read is", () => {
    expect(panelFreshness(ok, ok.updatedAt, NOW, false, false)).toBe("Updated 2 min ago");
    expect(panelFreshness(ok, ok.updatedAt, NOW, false, false, true)).toBe("Refresh failed · last read 2 min ago");
    expect(panelFreshness(ok, ok.updatedAt, NOW, true, false, true)).toBe("Refreshing…");
  });

  const render = (query: Partial<UseQueryResult<PanelResult<{ n: number }>>>) => {
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/work"] }) });
    return renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <PanelShell id="t8" title="Pipeline" link={{ to: "/leads", label: "Open" }} query={query as UseQueryResult<PanelResult<{ n: number }>>} now={NOW}>
          {(d) => <p>value {d.n}</p>}
        </PanelShell>
      </RouterContextProvider>,
    );
  };

  test("a card whose refresh failed shows the old figures under a warning, marked stale", () => {
    const html = render({ data: ok, isError: true, error: new Error("Request failed (HTTP 502)"), isFetching: false, isLoading: false, refetch: (() => {}) as never });
    expect(html).toContain("Refresh failed · last read 2 min ago");
    expect(html).toContain("Couldn&#x27;t refresh: showing the previous read");
    expect(html).toContain("Request failed (HTTP 502)");
    expect(html).toContain('data-stale="true"');
    expect(html).toContain("value 7");
  });

  test("a healthy card has no warning", () => {
    const html = render({ data: ok, isError: false, error: null, isFetching: false, isLoading: false, refetch: (() => {}) as never });
    expect(html).toContain("Updated 2 min ago");
    expect(html).not.toContain("Couldn&#x27;t refresh");
    expect(html).not.toContain("data-stale");
  });
});

describe("Finance margins at phone width", () => {
  // finance-page.tsx imports the Vite-only mount registry, so (like the L2 test) this reads the source;
  // the rendered 390 px page is checked in the Track 8 preview sweep.
  test("the stacked list below md carries the same 'known costs only' caveat as the table", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/shell/pages/finance-page.tsx"), "utf8");
    const table = src.slice(src.indexOf('data-testid="package-margins"'), src.indexOf("</table>"));
    const list = src.slice(src.indexOf('<ul className="divide-y divide-border md:hidden"'), src.indexOf("</ul>"));
    expect(table).toContain("r.incomplete && <span");
    expect(list.length).toBeGreaterThan(200);
    expect(list).toMatch(/r\.incomplete && <div[^>]*>known costs only<\/div>/);
  });
});

describe("Today: Sites tile", () => {
  test("all sites up but answering with a warning is a warn tile that says so, never all-green", async () => {
    const { todayFacts, todayTiles } = await import("../src/components/shell/today-facts");
    const at = new Date(NOW - 60_000).toISOString();
    const site = (id: string, tone: "ok" | "warn" | "bad") => ({ id, name: id, tone, ok: tone !== "bad", status: tone === "bad" ? 503 : 200 });
    const tile = (sites: ReturnType<typeof site>[]) => {
      const websites = { data: { ok: true, data: { checkedAt: at, sites, local: [], localNotRunning: [] }, updatedAt: at, ms: 5 } } as never;
      return todayTiles({ websites }, todayFacts({ websites }), NOW).find((t) => t.key === "websites")!;
    };
    const warned = tile([site("a", "warn"), site("b", "warn"), site("c", "ok")]);
    expect(warned.value).toBe("3 of 3");
    expect(warned.tone).toBe("warn");
    expect(warned.hint).toBe("2 with a warning");
    const mixed = tile([site("a", "bad"), site("b", "warn")]);
    expect(mixed.tone).toBe("danger");
    expect(mixed.hint).toBe("1 down · 1 with a warning");
    const green = tile([site("a", "ok"), site("b", "ok")]);
    expect(green.tone).toBe("success");
    expect(green.hint).toBeUndefined();
  });
});

// T8b UI items: F3-12 (the /business hydration mismatch), /inbox writing on page load, and /codegraph
// at a 390 px viewport. The rendered checks were also run on a synthetic preview (D:\agent-scratch\t8b).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── F3-12 ────────────────────────────────────────────────────────────────────
// The browser had a cached rates table in localStorage (every visit after the first); the server
// never does. useRates' initialData read that cache during hydration, so the client's first render
// showed AUD and no "Showing USD while rates load" note while the server's HTML showed USD and the
// note, and React discarded the /business tree ("Hydration failed", 8 of 10 reloads on the preview).
const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
beforeAll(() => {
  const store = new Map<string, string>([
    ["claude-os.currency.rates", JSON.stringify({ rates: { USD: 1, AUD: 1.52 }, fetchedAt: Date.now() })],
    ["claude-os.currency", "AUD"],
  ]);
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  g.window = { localStorage, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (!hadWindow) delete g.window;
});

test("F3-12: the first client render of the currency picker matches the server's, even with cached rates", async () => {
  expect(read("src/lib/currency.ts")).toContain('RATES_CACHE_KEY = "claude-os.currency.rates"');
  const { useCurrency } = await import("../src/lib/currency");
  function Picker() {
    const cur = useCurrency();
    return createElement("p", null, `${cur.code}|${cur.code !== cur.selected ? "note" : "no-note"}|${cur.format(10)}`);
  }
  const client = new QueryClient();
  // renderToString uses the server snapshot of useSyncExternalStore, which is also what React uses for
  // the hydrating render; the query's initialData (the localStorage copy) IS available here, as in the browser.
  const html = renderToString(createElement(QueryClientProvider, { client }, createElement(Picker)));
  expect(client.getQueryData(["currency-rates"])).toMatchObject({ AUD: 1.52 }); // the cache really was read
  expect(html).toContain("USD|note|"); // ...but not used before hydration: same as the server's HTML
  expect(html).not.toContain("AUD|");
});

// ── /inbox: a page load never writes ─────────────────────────────────────────
test("/inbox: no automatic sync anywhere; the minute timer only re-reads; the copy no longer promises auto-refresh", () => {
  const src = read("src/components/operator/inbox-workspace.tsx");
  expect(src).not.toContain("nativeOpened");
  // `sync(true)` survives only as Skool's "load more" click handler, never from an effect or timer.
  for (const m of src.matchAll(/void sync\(true\)/g)) expect(src.slice(m.index! - 30, m.index)).toContain("onClick={() =>");
  const timers = [...src.matchAll(/window\.setInterval\(([\s\S]*?)\}, 60000\)/g)].map((m) => m[1]);
  for (const body of timers) expect(body).not.toMatch(/sync\(|operatorRequest\(/); // re-reads only
  expect(src).not.toMatch(/refresh(es)? (every 60 seconds|each minute)/);
  expect(read("src/components/operator/account-connections.tsx")).not.toMatch(/refresh (when you open Inbox|each minute)/);
  // The rendered 70-second fake-timer check is scripts/t8b-inbox-no-auto-writes.test.tsx.
});

// ── /codegraph at 390 px ─────────────────────────────────────────────────────
test("/codegraph: the gallery stacks at phone width so the project card and the ingest card both fit", () => {
  const src = read("src/routes/codegraph.tsx");
  expect(src).toContain('className="flex flex-col sm:flex-row gap-3 items-stretch min-w-0" data-testid="kg-gallery"');
  expect(src).toContain("w-full sm:w-[150px]"); // the collapsed "Add a project" tile
  expect(src).toContain("w-full sm:w-[270px]"); // the opened ingest form (it left the strip ~40 px before)
  expect(src).toContain("h-[440px] sm:h-[620px]"); // a phone can still scroll past the 3D canvas
  expect(src).toContain("hidden sm:block absolute top-4 left-4"); // the project box no longer sits under the toolbar
});

test("/codegraph: graph controls are at least 40 px tall on a phone and the node-count badge clears the legend", () => {
  const src = read("src/components/graphify-graph-3d.tsx");
  const toolbar = src.slice(src.indexOf("Density toggle"), src.indexOf("data.capped &&"));
  expect((toolbar.match(/min-h-10 sm:min-h-0/g) ?? []).length).toBe(3); // Full, Core, Pause/Play
  expect(src).toContain("absolute top-[3.75rem] right-3 sm:top-auto sm:bottom-3");
  expect(src).toContain("absolute bottom-3 left-3 right-3 sm:right-auto");
  expect(src).toContain('"min-h-[380px] sm:min-h-[560px]"');
});

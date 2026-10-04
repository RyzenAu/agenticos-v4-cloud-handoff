// Merge review U1: the needs-you count must render the same on the server and on the first client
// render, even when another component (the sidebar) has already filled the query cache.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { pendingUntilHydrated, useHydrated } from "../src/lib/use-hydrated";

function Count() {
  const q = pendingUntilHydrated(useQuery({ queryKey: ["workspace", "needsYou"], queryFn: async () => 8 }), useHydrated());
  return createElement("p", null, q.isLoading ? "?" : String(q.data));
}

test("before hydration a cached count still renders as loading (what the server rendered)", () => {
  const client = new QueryClient();
  client.setQueryData(["workspace", "needsYou"], 8); // the sidebar got there first
  // renderToString uses the server snapshot, which is also what hydration's first render uses.
  const html = renderToString(createElement(QueryClientProvider, { client }, createElement(Count)));
  expect(html).toContain(">?<");
  expect(html).not.toContain(">8<");
});

test("pendingUntilHydrated passes the live result through once hydrated", () => {
  const live = { isLoading: false, data: 8, isError: false };
  expect(pendingUntilHydrated(live, true)).toBe(live);
  expect(pendingUntilHydrated(live, false)).toMatchObject({ isLoading: true, data: undefined, isError: false });
});

test("the sidebar badge, Today and the HUD gate the needs-you read on hydration", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  expect(read("src/components/app-sidebar.tsx")).toMatch(/hydrated && query\.data\?\.ok/);
  expect(read("src/components/shell/pages/today-page.tsx")).toContain("pendingUntilHydrated(v, hydrated)");
  expect(read("src/components/operator/jarvis-hud.tsx")).toContain('pendingUntilHydrated(useWorkspacePanel("needsYou"), useHydrated())');
});

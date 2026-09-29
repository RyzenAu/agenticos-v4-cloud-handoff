// Audit F1-05 (Track 8): Projects showed "0 project folders · Demo data · No project workspaces
// detected yet" for ~10 s, and a deep link "Workspace not found" for ~6 s, while live-data loaded.
// The first render (server, and the client before its fetch lands) must be an honest loading state.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { Route as ListRoute } from "../src/routes/workspaces.index";

const render = (node: React.ReactNode) => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/workspaces"] }) });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterContextProvider router={router}>{node}</RouterContextProvider>
    </QueryClientProvider>,
  );
};

describe("Projects list before the data arrives", () => {
  test("says it is reading, never 'Demo data', a count or 'none detected'", () => {
    const Page = ListRoute.options.component as () => React.ReactNode;
    const html = render(<Page />);
    expect(html).toContain("Reading project folders");
    expect(html).toContain('aria-label="Loading project folders"');
    expect(html).not.toContain("Demo data");
    expect(html).not.toContain("No project workspaces detected");
    expect(html).not.toMatch(/\b0 project folders/);
  });
});

describe("Workspace detail", () => {
  // The route module's component needs a matched $id route to render; its gate is checked in source.
  const src = readFileSync(join(import.meta.dir, "../src/routes/workspaces.$id.tsx"), "utf8");
  test("'not found' only after the list loaded; loading and failure are their own states", () => {
    const gate = src.indexOf("if (!live.loaded)");
    const notFound = src.indexOf("if (!ws) return <WorkspaceNotFound");
    expect(gate).toBeGreaterThan(0);
    expect(notFound).toBeGreaterThan(gate);
    expect(src).toContain('<PageSkeleton rows={4} label="Loading the workspace" />');
    expect(src).toContain("This workspace couldn't be read");
    expect(src).toContain("const isDemoData = live.loaded && ld?.isExample === true;");
  });
  test("the not-found page is a real page with a heading and a way back (audit F3-33)", () => {
    expect(src).toContain('<PageHeader title="Workspace not found"');
    expect(src).toContain("All workspaces");
    expect(src).toContain("notFoundComponent: () => <WorkspaceNotFound />");
  });
});

describe("useLiveData keeps its contract", () => {
  test("useLiveData() is still the data (other pages unchanged); the status hook adds loaded/failed", () => {
    const hook = readFileSync(join(import.meta.dir, "../src/lib/use-live-data.ts"), "utf8");
    expect(hook).toContain("return useLiveDataStatus().data;");
    expect(hook).toContain("const loaded = hydrated && query.data !== undefined;");
    expect(hook).toContain("const failed = hydrated && !loaded && query.isError;");
  });
});

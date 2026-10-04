// A typed draft that runs on a metered OpenRouter route says so in the page itself (the spoken summary is never rendered),
// and Start stays disabled until the owner ticks the acknowledgement.
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DraftCard } from "../../src/components/coding/coding-list";

const withRouter = async (el: ReactElement) => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => el }), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
};
const sha = "a".repeat(40);
const result = (model: string, route: string) => ({
  kind: "draft" as const, jobId: "00000000-0000-4000-8000-000000000001", specDigest: "x", spokenSummary: "",
  validation: { ok: true, errors: [], warnings: [] },
  spec: {
    objective: "Synthetic: change a", repo: { repoId: "r", baseRef: "main", baseSha: sha, jobBranch: "coding/x" }, checks: [], doneWhen: [],
    roles: [{ roleId: "builder-1", role: "builder", agent: { route, model, accountSlot: "router:auto", provider: "router" }, access: "write", owns: { globs: ["a.ts"], newFiles: [] } }],
  },
}) as never;

describe("typed draft: paid-route disclosure", () => {
  test("an openrouter/ model shows a plain paid notice, an acknowledgement, and a disabled Start", async () => {
    const html = await withRouter(<DraftCard result={result("openrouter/deepseek-v4-pro", "model-router")} busy={false} started={null} onStart={() => {}} onAccount={() => {}} />);
    expect(html).toContain("openrouter/deepseek-v4-pro costs money per token through OpenRouter");
    expect(html).toContain("I understand this route is paid");
    expect(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Start this job/s.test(html)).toBe(true);
  });
  test("a free route shows no paid notice and Start is enabled", async () => {
    const html = await withRouter(<DraftCard result={result("cline/mimo-v2.6-flash", "model-router")} busy={false} started={null} onStart={() => {}} onAccount={() => {}} />);
    expect(html).not.toContain("costs money per token");
    expect(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Start this job/s.test(html)).toBe(false);
  });
});

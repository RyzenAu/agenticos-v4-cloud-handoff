// Round 6, items 1, 3, 12 and 14 on the Coding page: the plan can be edited before Start, a failing test shows its
// name and assertion with the full output folded away, and every stop reads as what / why / the one action.
import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DraftCard } from "../../src/components/coding/coding-list";
import { FailedTests } from "../../src/components/coding/failed-tests";
import { PlanEditor, planPatchFrom } from "../../src/components/coding/plan-editor";
import { glanceOf } from "../../src/lib/coding-glance";

const withRouter = async (el: ReactElement) => {
  const router = createRouter({ routeTree: createRootRoute({ component: () => el }), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
};
const sha = "a".repeat(40);
const plan = {
  objective: "Make src/a.ts export 42", nonGoals: ["Leave docs alone"],
  doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }],
};
const result = {
  kind: "draft" as const, jobId: "00000000-0000-4000-8000-000000000001", specDigest: "x", spokenSummary: "",
  validation: { ok: true, errors: [], warnings: [] },
  spec: {
    ...plan, revision: 2, repo: { repoId: "r", baseRef: "main", baseSha: sha, jobBranch: "coding/x" }, checks: [],
    roles: [{ roleId: "builder-1", role: "builder", agent: { route: "claude-code-cli", model: "claude-sonnet-5-5", accountSlot: "claude:max", provider: "anthropic" }, access: "write", owns: { globs: ["a.ts"], newFiles: [] } }],
  },
} as never;

describe("item 1: the drafted plan can be edited on the page", () => {
  test("the draft card offers 'Edit the plan' with the objective, each done-when line and the non-goals filled in", async () => {
    const html = await withRouter(<DraftCard result={result} busy={false} started={null} onStart={() => {}} onAccount={() => {}} onEditPlan={() => {}} />);
    expect(html).toContain("Edit the plan");
    expect(html).toContain("Make src/a.ts export 42");
    expect(html).toContain("alpha passes");
    expect(html).toContain("Leave docs alone");
    expect(html).toContain("never removed here");
  });
  test("the editor offers Save only when something changed, and sends only what changed", () => {
    const same = { objective: plan.objective, lines: { c1: "alpha passes", c2: "a is 42" }, added: "", nonGoals: "Leave docs alone" };
    expect(planPatchFrom(plan, same)).toBeNull();
    expect(planPatchFrom(plan, { ...same, objective: "Make src/a.ts export 43" })).toEqual({ objective: "Make src/a.ts export 43" });
    expect(planPatchFrom(plan, { ...same, lines: { c1: "alpha passes", c2: "a is exactly 42" }, added: "No other file changes\n\n" })).toEqual({ doneWhen: [{ id: "c2", text: "a is exactly 42" }, { text: "No other file changes" }] });
    expect(planPatchFrom(plan, { ...same, nonGoals: "" })).toEqual({ nonGoals: [] });
    const html = renderToStaticMarkup(<PlanEditor plan={plan} busy={false} onSave={() => {}} />);
    expect(html).toContain("No changes yet.");
    expect(/<button[^>]*disabled=""[^>]*>Save the changes/.test(html)).toBe(true);
  });
});

describe("item 12: failing tests up front, the full output folded away", () => {
  test("each failing test shows its bare name, its file and its assertion; the extra ones are counted", () => {
    const html = renderToStaticMarkup(<FailedTests failures={[{ name: "pricing.test.ts :: totals include GST", assertion: "expect(received).toBe(expected) · Expected: 110 · Received: 100" }, { name: "pricing.test.ts :: rounds up", assertion: null }]} total={5} />);
    expect(html).toContain("totals include GST");
    expect(html).toContain("Expected: 110 · Received: 100");
    expect(html).toContain("pricing.test.ts");
    expect(html).toContain("The runner printed no assertion for this one");
    expect(html).toContain("and 3 more failing");
    expect(html).not.toContain("<pre");
  });
  test("a job with no failures renders nothing", () => {
    expect(renderToStaticMarkup(<FailedTests failures={[]} names={[]} total={0} />)).toBe("");
  });
});

describe("item 14: the glance on a waiting job says what, why and the one action", () => {
  const view = (job: Record<string, unknown>) => ({ job: { id: "j", state: "needs_owner", runs: [], tests: [], review: null, gate: null, headSha: null, spec: { objective: "Do x", roles: [], doneWhen: [], repo: { baseSha: sha } }, ...job }, readable: null, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x" }) as never;
  test("a merge conflict between builders names the files and the two ways out", () => {
    const g = glanceOf(view({ stoppedBecause: { code: "integration_conflict", message: "Integrating builder-2 conflicted on src/a.ts; nothing was resolved automatically.", at: "2026-10-02T00:00:00.000Z" } }));
    expect(g.blocker?.text).toMatch(/src\/a\.ts/);
    expect(g.blocker?.text).toMatch(/Fix the conflict by hand.*or stop this job/);
    expect(g.blocker?.label).toBe("Retry the merge");
  });
  test("a builder that changed files it doesn't own: every file, whole, and the one fix", () => {
    const files = ["src/very/long/directory/name/component-one.ts", "src/very/long/directory/name/component-two.ts", "lib/c.ts"];
    const g = glanceOf(view({ runs: [{ roleId: "builder-1", role: "builder", state: "failed", error: { code: "ownership_violation", message: `changed files it doesn't own: ${files.join(", ")}` }, history: [] }] }));
    for (const f of files) expect(g.blocker?.text).toContain(f);
    expect(g.blocker?.text).toContain("Revert them");
    expect(g.blocker?.label).toBe("Retry the build");
  });
});

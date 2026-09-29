// W-B (29 Sep 2026): the Coding page as a harness view. The six-step lane is honest about each job's
// state (evidence only, never an agent's claim), the empty state teaches the flow without a fake job,
// the harness panel shows accounts, Codex isolation, repos and the rules, and the T3 safety wording holds.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { CodingJob, JobState } from "../../src/lib/coding-client";
import { HARNESS_POLICY, PIPELINE, pipelineFor, pipelineProgress, sampleRequest } from "../../src/lib/coding-pipeline";
import { AgentsCard, PolicyCard, ReposCard } from "../../src/components/coding/harness-panel";
import { PipelineDots, PipelineLane } from "../../src/components/coding/pipeline-lane";
import { codexIsolationStatus } from "./routes";

const ROOT = join(import.meta.dir, "..", "..");
const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

function job(state: JobState, patch: Partial<CodingJob> = {}): CodingJob {
  const confirmed = !["draft", "awaiting_confirmation"].includes(state);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    spec: {
      objective: "Synthetic: group calls by timezone",
      revision: 1,
      repo: { repoId: "synthetic-repo", baseRef: "main", baseSha: sha(1), jobBranch: "coding/synthetic-000001", excludesUncommittedCanonicalChanges: true },
      requestedBy: { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "x" },
      source: { channel: "ui", utteranceDigest: "0".repeat(64) },
      roles: [],
      doneWhen: [],
      confirmation: confirmed ? { state: "confirmed", by: { personId: "usman" }, via: "ui", at: "2026-09-29T00:00:00Z", specDigest: "0".repeat(64) } : { state: "unconfirmed" },
    },
    state,
    runs: [],
    headSha: null,
    diff: null,
    tests: [],
    review: null,
    gate: null,
    applies: [],
    executorDevice: "usman-pc",
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
    lastSeq: 0,
    ...patch,
  } as unknown as CodingJob;
}
const builderRun = (s = "running") => ({ roleId: "builder-1", role: "builder", state: s, binding: { model: "claude-opus-5-5", accountSlot: "claude:max", route: "claude-code-cli" }, pendingInput: null, error: null }) as never;
const test214 = (exitCode = 0, failed = 0) => ({ commandId: "fx.test", argv: [], sha: sha(2), ranBy: "orchestrator", exitCode, timedOut: false, counts: { passed: 214, failed, skipped: null }, failedTests: [], durationMs: 1, output: "a", baseline: null }) as never;
const review = (verdict: "approve" | "request-changes", at = sha(2)) => ({ reviewerRoleId: "reviewer", binding: {}, sha: at, verdict, findings: [], criteria: [] }) as never;
const statuses = (j: CodingJob) => pipelineFor(j).map((s) => `${s.id}:${s.status}`).join(" ");

describe("the six-step lane (honest by evidence)", () => {
  test("the steps and their order are the harness's pipeline", () => {
    expect(PIPELINE.map((p) => p.label)).toEqual(["Draft", "Plan", "Builder", "Tests", "Independent review", "Merge approval"]);
  });
  test("a drafted plan waits for YOU at Plan; nothing after it has started", () => {
    const s = pipelineFor(job("awaiting_confirmation"));
    expect(statuses(job("awaiting_confirmation"))).toBe("draft:done plan:you build:todo tests:todo review:todo merge:todo");
    expect(s[1].detail).toContain("waiting for you to press Start");
  });
  test("a draft that needs fixes is at Draft", () => {
    expect(statuses(job("draft"))).toBe("draft:you plan:todo build:todo tests:todo review:todo merge:todo");
  });
  test("building is current at Builder; testing at Tests; reviewing at Review", () => {
    expect(statuses(job("building", { runs: [builderRun()] }))).toBe("draft:done plan:done build:current tests:todo review:todo merge:todo");
    expect(statuses(job("testing", { runs: [builderRun("succeeded")], headSha: sha(2) as never }))).toContain("tests:current");
    expect(statuses(job("reviewing", { headSha: sha(2) as never, tests: [test214()] }))).toBe("draft:done plan:done build:done tests:done review:current merge:todo");
  });
  test("tests show the orchestrator's own counts at the head, or 'Not run yet'", () => {
    const steps = pipelineFor(job("reviewing", { headSha: sha(2) as never, tests: [test214()] }));
    expect(steps[3].detail).toBe("214 passed · 0 failed");
    expect(pipelineFor(job("building"))[3].detail).toBe("Not run yet");
  });
  test("completed is NOT merged: Merge approval is 'Your call' until an apply step verifiably succeeds", () => {
    const done = job("completed", { headSha: sha(2) as never, tests: [test214()], review: review("approve") });
    const steps = pipelineFor(done);
    expect(steps[5].status).toBe("optional");
    expect(steps[5].detail).toContain("Not asked");
    expect(pipelineProgress(steps)).toEqual({ done: 5, of: 6 });
    const merged = job("completed", { headSha: sha(2) as never, tests: [test214()], review: review("approve"), applies: [{ state: "succeeded", verification: { method: "merge-commit", observed: sha(3), at: "x" } }] as never });
    expect(pipelineFor(merged)[5].status).toBe("done");
  });
  test("waiting for approval is 'Needs you' at Merge, never done", () => {
    const j = job("awaiting_approval", { headSha: sha(2) as never, tests: [test214()], review: review("approve"), applies: [{ state: "awaiting_approval", verification: null }] as never });
    const m = pipelineFor(j)[5];
    expect(m.status).toBe("you");
    expect(m.detail).toContain("spoken yes or Telegram code");
  });
  test("interrupted says 'not replayed' where it stopped; failed marks the step it failed at", () => {
    const i = pipelineFor(job("interrupted", { runs: [builderRun("interrupted")] }));
    expect(i[2].status).toBe("blocked");
    expect(i[2].detail).toContain("nothing was replayed");
    const f = pipelineFor(job("failed"));
    expect(f.filter((s) => s.status === "failed").map((s) => s.id)).toEqual(["build"]);
  });
  test("a failing test run or a changes-requested verdict is shown on its own step", () => {
    const j = job("needs_owner", { headSha: sha(2) as never, tests: [test214(1, 3)], review: review("request-changes") });
    const s = pipelineFor(j);
    expect(s[3].status).toBe("failed");
    expect(s[4].status).toBe("you");
    expect(s[4].detail).toContain("Changes requested");
  });
  test("an agent's claim is never a test result: tests at another sha don't count", () => {
    const j = job("reviewing", { headSha: sha(9) as never, tests: [test214()] });
    expect(pipelineFor(j)[3].detail).toBe("Not run yet");
  });
});

describe("rendering", () => {
  test("the teaching lane lists all six steps with what each does, and no status words", () => {
    const html = renderToStaticMarkup(<PipelineLane />);
    for (const p of PIPELINE) expect(html).toContain(p.label);
    expect(html).toContain("An agent saying &#x27;tests pass&#x27; never counts");
    expect(html).not.toContain("Not yet");
  });
  test("a job's dots name every step in words (not colour-only)", () => {
    const html = renderToStaticMarkup(<PipelineDots steps={pipelineFor(job("awaiting_confirmation"))} />);
    expect(html).toContain('aria-label="Draft: Done, Plan: Needs you, Builder: Not yet');
  });
  test("Codex isolation: paused until --apply without the owner's record; protected with it", () => {
    const paused = codexIsolationStatus(null);
    expect(paused.state).toBe("paused");
    expect(paused.label).toBe("Codex paused until --apply");
    expect(paused.detail).toContain("bun scripts/coding/codex-isolation.ts --apply");
    const ok = codexIsolationStatus({ version: 1, group: "CodexSandboxUsers", approvedAt: "2026-09-28T10:00:00Z", paths: ["C:/x", "C:/y"] });
    expect(ok).toMatchObject({ state: "protected", protectedPaths: 2, approvedAt: "2026-09-28T10:00:00Z" });
  });
  test("the agents card shows Claude, Codex and the isolation state; unknowns say so", () => {
    const html = renderToStaticMarkup(
      <AgentsCard
        error={null}
        data={{
          accounts: [
            { accountSlot: "claude:max", installed: true, cliVersion: "2.1.280", allowance: null, models: [] },
            { accountSlot: "codex:openai-2", installed: true, cliVersion: "0.154.0", plan: "chatgpt-plus", creditsAllowed: false, home: "default ~/.codex", reading: null, models: [] },
          ],
          codexIsolation: codexIsolationStatus(null),
        }}
      />,
    );
    expect(html).toContain("Claude Code · Max subscription");
    expect(html).toContain("Codex · openai-2 (Plus)");
    expect(html).toContain("allowance not read yet");
    expect(html).toContain("window not read");
    expect(html).toContain("Codex paused until --apply");
    expect(html).toContain('data-isolation="paused"');
    // An older server that doesn't report it: "not checked", never "protected".
    expect(renderToStaticMarkup(<AgentsCard error={null} data={{ accounts: [] }} />)).toContain("Codex isolation: not checked");
  });
  test("repos: an empty registry says no job can start and where to add them", () => {
    expect(renderToStaticMarkup(<ReposCard repos={[]} error={null} />)).toContain("No repos are registered yet, so no job can start");
    const html = renderToStaticMarkup(<ReposCard repos={[{ id: "synthetic-repo", description: "a test repo", defaultBaseRef: "main", checks: [{ id: "fx.test", kind: "test" }] }]} error={null} />);
    expect(html).toContain("synthetic-repo");
    expect(html).toContain("checks: fx.test");
  });
  test("the rules: human-only start, plan digest, programs draft only, restricted tools, no deploys", () => {
    const html = renderToStaticMarkup(<PolicyCard />);
    for (const p of HARNESS_POLICY) expect(html).toContain(p.title.replace(/'/g, "&#x27;"));
    const text = HARNESS_POLICY.map((p) => p.body).join(" ");
    expect(text).toContain("A program holding the page token can only draft a plan");
    expect(text).toContain("digest");
    expect(text).toContain("no deploy tools");
    expect(text).toContain("spoken yes or your Telegram code");
  });
});

describe("the Coding page", () => {
  const withRouter = async (el: ReactElement) => {
    const router = createRouter({ routeTree: createRootRoute({ component: () => el }), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
  };
  test("the empty state teaches the flow with an example that only fills the box (not a fake job)", async () => {
    const { FirstJob } = await import("../../src/components/coding/coding-list");
    const html = await withRouter(<FirstJob onExample={() => {}} repo="synthetic-repo" />);
    expect(html).toContain("No coding jobs yet");
    expect(html).toContain("Try an example request");
    expect(html).toContain("it only fills the box above; nothing is drafted until you press Draft");
    expect(html).toContain(sampleRequest("synthetic-repo"));
    expect(html).not.toContain("/coding/"); // no link to a job: there is none
    expect(html).toContain('data-pipeline="true"');
  });
  test("a job card carries its lane and its state in words", async () => {
    const { JobCard, needsYouLine } = await import("../../src/components/coding/coding-list");
    const j = job("awaiting_approval", { headSha: sha(2) as never, tests: [test214()], review: review("approve"), applies: [{ state: "awaiting_approval", verification: null }] as never });
    const html = await withRouter(<JobCard job={j} />);
    expect(html).toContain("Waiting for approval (not merged)");
    expect(html).toContain("Merge approval");
    expect(needsYouLine(j)).toContain("Not merged yet");
  });
  test("starting stays a person's clear Start bound to the digest (T3 rules unchanged)", () => {
    const src = readFileSync(join(ROOT, "src/components/coding/coding-list.tsx"), "utf8");
    expect(src).toContain("codingClient.start(result.jobId, result.specDigest)");
    expect(src).toContain("Start this job");
    // The example never drafts or starts on its own.
    expect(/useExample[\s\S]{0,200}codingClient\.(shape|start)/.test(src)).toBe(false);
    const routes = readFileSync(join(ROOT, "scripts/coding/routes.ts"), "utf8");
    expect(routes).toContain('if (method === "POST" && path !== "/coding/shape" && !hasVerifiedUiSession(principal)) return { status: 403, body: { error: HUMAN_ONLY } };');
  });
});

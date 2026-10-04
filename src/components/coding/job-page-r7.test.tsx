// Round 7 (audit 1, F-04 and F-11): what a person reads on the job page and in Tasks carries no internal name (slots, model ids, role ids, config
// variables, scripts, action ids), and the page's header shows "Live" only while the job is running or waiting. Synthetic jobs; rendered with
// react-dom/server. Raw terms live only inside the collapsed "Agent details" and the Details log, which these checks leave out on purpose.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Agents, JobStatusLine, describeEvent } from "./job-detail";
import { JobSummary } from "./job-summary";
import { codingTask, serviceTask } from "../agents/tasks/tasks";
import { roleLabel } from "../../../scripts/coding/pause-reason";

const sha = "a".repeat(40);
const binding = (slot: string, model: string) => ({ provider: "anthropic", route: "claude-code-cli", accountSlot: slot, model, cliVersion: "2.1.286" });
const FORBIDDEN = /MU_[A-Z_]+|scripts\/[\w/.-]+|\b[\w-]+\.ts\b|builder-1|\bclaude:max(?:-\d)?\b|claude-(?:opus|sonnet|fable|haiku)-\d|git\.merge|git\.push|orchestrator|done gate|worktree|harness|\bdigest\b|request-changes|CLAUDE_CONFIG_DIR|~\/\.claude|\bbun \w+/i;
const outsideDetails = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, "");

const job = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", state, headSha: null, review: null, gate: null, tests: [], diff: null, applies: [], executorDevice: "usman-pc",
  spec: { objective: "Fix the booking form", doneWhen: [], nonGoals: [], checks: [], repo: { repoId: "app", baseSha: sha, jobBranch: "coding/app-1" }, roles: [
    { roleId: "builder-1", role: "builder", access: "write", agent: binding("claude:max-2", "claude-sonnet-5-5"), owns: { globs: ["src/a.ts"], newFiles: [] } },
    { roleId: "reviewer", role: "reviewer", access: "read-only", agent: binding("claude:max-2", "claude-opus-5-5"), owns: { globs: [], newFiles: [] } },
  ] },
  runs: [{ id: "r1", roleId: "builder-1", role: "builder", state: state === "building" ? "running" : "succeeded", binding: binding("claude:max-2", "claude-sonnet-5-5"), attempt: 1, history: [], error: null, nativeSessionId: null }],
  createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:05:00.000Z", ...extra,
}) as never;

describe("F-04: the header says Live only while the job is running or waiting", () => {
  const line = (state: string, live: "live" | "polling" | "offline" = "live") => renderToStaticMarkup(<JobStatusLine job={job(state)} state={{ label: state, tone: "neutral" }} live={live} />);
  test("completed, failed and stopped jobs wear no Live badge; a running or waiting job does", () => {
    for (const s of ["completed", "failed", "cancelled"]) expect(line(s)).not.toMatch(/Live|Updating|Reconnecting/);
    for (const s of ["building", "needs_owner", "awaiting_approval", "interrupted"]) expect(line(s)).toContain("Live");
    expect(line("building", "offline")).toContain("Reconnecting");
  });
  test("an ended job shows no 'Working now' row", () => {
    const view = (j: never) => ({ job: j, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "d", readable: { progress: { runs: [{ roleId: "builder-1", role: "Builder", state: "succeeded", attempt: 1, who: binding("claude:max-2", "claude-sonnet-5-5"), error: null, attempts: [] }], stateText: "x", needsYou: null, phases: [], fallbacks: [], recent: [] }, plan: { objective: "x", nonGoals: [], doneWhen: [], checks: [], roles: [] }, diff: null, tests: { latest: null, atHead: null, baselineFailed: null, runs: 0 }, review: null, result: { state: "completed", headSha: null, headShort: null, jobBranch: "coding/app-1", gate: null, merged: false, applies: [], nextStep: "" }, context: { sources: [] }, location: null } }) as never;
    expect(renderToStaticMarkup(<JobSummary bare view={view(job("cancelled"))} onOpenTab={() => undefined} />)).not.toContain("Working now");
    expect(renderToStaticMarkup(<JobSummary bare view={view(job("building"))} onOpenTab={() => undefined} />)).toContain("Working now");
  });
});

describe("F-11: no internal name on the job page or in Tasks", () => {
  test("the Agents panel names roles and accounts the way a person does", () => {
    const html = outsideDetails(renderToStaticMarkup(<Agents view={{ job: job("building"), events: [], receipts: [], approvals: [], handoff: null, liveRoles: [], specDigest: "d" } as never} />));
    expect(html).toContain("Builder");
    expect(html).toContain("Claude Max 2");
    expect(html.match(FORBIDDEN)?.[0] ?? null).toBeNull();
  });
  test("role ids read as role names", () => {
    expect(["builder-1", "builder-2", "reviewer", "test-author", null].map(roleLabel)).toEqual(["Builder", "Builder 2", "Reviewer", "Test author", "The system"]);
  });
  test("the progress log's own sentences for a merge request and its outcome use words, not action ids", () => {
    const e = (type: string, payload: unknown) => ({ seq: 1, at: "2026-10-03T00:00:00.000Z", type, roleId: null, payload }) as never;
    for (const ev of [e("approval_request", { summary: "Merge coding/app-1 into main of app" }), e("apply", { state: "cancelled", action: "git.merge.protected" }), e("approval_resolved", { state: "rejected" }), e("gate", { passed: true, sha })]) expect(describeEvent(ev)).not.toMatch(FORBIDDEN);
  });
  test("Tasks rows (from the job record and from the agents service), in every state, carry none", () => {
    const states = ["draft", "awaiting_confirmation", "building", "needs_owner", "blocked_allowance", "interrupted", "awaiting_approval", "completed", "failed", "cancelled"];
    for (const st of states) {
      const t = codingTask(job(st, { stoppedBecause: st === "interrupted" ? { code: "restart", message: "The hub restarted while the tests were running. Nothing was replayed.", at: "x" } : undefined }), null);
      const text = [t.title, t.stateWord, t.ran.text, t.progress, t.review, t.tests, t.blocker?.text, t.blocker?.action?.label, t.outcomeNote, ...t.links.map((l) => l.label)].filter(Boolean).join(" | ");
      expect(text.match(FORBIDDEN)?.[0] ?? null).toBeNull();
      const s = serviceTask({ id: "11111111-1111-4111-8111-111111111111", kind: "coding", title: "Fix the booking form", state: st, phase: "waiting", startedAt: 1, branch: "coding/app-1", commit: sha, account: "claude:max-2", model: "claude-opus-5-5", receipts: [{ account: "claude:max-2", model: "claude-opus-5-5", role: "reviewer" }], tests: { passed: 1, failed: 0 }, review: { verdict: "approve", blockers: 0, majors: 0, minors: 0 } })!;
      const text2 = [s.stateWord, s.ran.text, s.review, s.tests, s.outcomeNote, s.blocker?.text, ...s.links.map((l) => l.label)].filter(Boolean).join(" | ");
      expect(text2.match(FORBIDDEN)?.[0] ?? null).toBeNull();
    }
  });
});

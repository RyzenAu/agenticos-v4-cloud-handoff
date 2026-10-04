// Round 7, audit 1 (F-04, F-11, F-13, F-17): stopped and failed jobs say why and offer a way on, a paused job says it once and offers only actions that
// can work, a declined request reads as what happened, and no internal name reaches a rendered job view. Synthetic jobs and the synthetic world.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JobGlance } from "../../src/components/coding/job-glance";
import { codingBlocker, codingResumeLabel } from "./pause-reason";
import { glanceOf } from "../../src/lib/coding-glance";
import { FakeClaude } from "./runners/fakes";
import { specDigest } from "./spec";
import { OWNER, settled, spec, until, world } from "./r6-world";
import { join } from "node:path";

const sha = "a".repeat(40);
const binding = (slot: string, model: string) => ({ provider: "anthropic", route: "claude-code-cli", accountSlot: slot, model, cliVersion: "2.1.286" });
const base = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "j", state, headSha: null, review: null, gate: null, tests: [], diff: null, applies: [],
  spec: { objective: "Fix the booking form", doneWhen: [], repo: { baseSha: sha, repoId: "app", jobBranch: "coding/app-1" }, roles: [{ roleId: "builder-1", role: "builder", agent: binding("claude:max", "claude-sonnet-5-5") }, { roleId: "reviewer", role: "reviewer", agent: binding("claude:max", "claude-opus-5-5") }] },
  runs: [], createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:05:00.000Z", ...extra,
}) as never;
const view = (job: never) => ({ job, readable: undefined, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "d" }) as never;
const render = (job: never, over: Record<string, unknown> = {}) => {
  const glance = glanceOf(view(job));
  return renderToStaticMarkup(<JobGlance glance={glance} state={(job as { state: string }).state} choices={[]} choiceKey={null} onChoice={() => undefined} nextLabel={codingResumeLabel(job)} onNext={() => undefined} busy={false} resumable={false} {...over} />);
};
const FORBIDDEN = /MU_[A-Z_]+|scripts\/[\w/.-]+|\b[\w-]+\.ts\b|builder-1|\bclaude:max\b|claude-(?:opus|sonnet|fable|haiku)-\d|git\.merge|orchestrator|done gate|\bbun \w+/i;

describe("F-04: a stopped or failed job says why and offers the way on; a finished one says nothing it has no cause to say", () => {
  const stopped = base("cancelled", { runs: [{ roleId: "builder-1", role: "builder", state: "cancelled", binding: binding("claude:max", "claude-sonnet-5-5"), history: [{ from: "running", to: "cancelled", reason: "owner_cancel", at: "2026-10-03T00:04:00.000Z" }], error: null }] });
  test("Stopped: a reason line, no resume, and a way on that is a real link (a new draft of the same request)", () => {
    const b = codingBlocker(stopped);
    expect(b).toMatchObject({ kind: "stopped", label: "Draft it again" });
    expect(b.text).toMatch(/You stopped this job while the builder was working\. It can't be resumed.*draft it again/);
    const html = render(stopped, { draftAgainHref: "/coding?request=Fix%20the%20booking%20form" });
    expect(html).toContain("Why it stopped");
    expect(html).toContain('href="/coding?request=Fix%20the%20booking%20form"');
    expect(html).toContain("Draft it again");
    expect(html).not.toMatch(/Resume|Blocked by|Nothing is blocking/);
  });
  test("Failed: the failure's own reason, never 'Nothing is blocking it'", () => {
    const failed = base("failed", { stoppedBecause: { code: "prepare_failed", message: "The repo's git config now runs programs.", at: "2026-10-03T00:00:00.000Z" } });
    const b = codingBlocker(failed);
    expect(b.kind).toBe("failed");
    expect(b.text).toMatch(/The job failed: The repo's git config now runs programs.*can't be resumed/);
    const html = render(failed, { draftAgainHref: "/coding?request=x" });
    expect(html).toContain("Why it stopped");
    expect(html).not.toContain("Nothing is blocking");
  });
  test("a finished job has no 'Blocked by: Nothing' row; a superseded one leaves its own notice to say so", () => {
    expect(render(base("completed"))).not.toMatch(/Blocked by|Nothing is blocking|Nothing\. It is done|Waiting on/);
    expect(glanceOf(view(base("cancelled", { supersededBy: { ref: "main", reason: "landed", at: "x", by: "usman" } }))).blocker).toBeNull();
  });
});

describe("F-17: a job paused at an account limit says it once and offers only actions that can work", () => {
  const limited = base("blocked_allowance", { runs: [{ roleId: "builder-1", role: "builder", state: "blocked_allowance", binding: binding("claude:max", "claude-sonnet-5-5"), history: [{ from: "running", to: "blocked_allowance", reason: "provider_limit_reached", at: "2026-10-03T00:00:00.000Z" }], error: { code: "limit_reached", message: "Claude's weekly window is at 100%, resetting 2026-10-05T02:00:00.000Z." } }] });
  test("no other account: the sentence appears once, there is no Resume button, and nothing says a retry would stop", () => {
    const html = render(limited, { resumable: true, choices: [] });
    expect(html.match(/can&#x27;t run/g) ?? []).toHaveLength(1);
    expect(html).toContain("No other connected account can take it. Resume appears here once the limit resets.");
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/retry would stop again/);
  });
  test("another account is available: one button, named for where it will run", () => {
    const choices = [{ key: "claude:max-2|claude-sonnet-5-5", route: "claude-code-cli", accountSlot: "claude:max-2", accountLabel: "Claude Max 2", model: "claude-sonnet-5-5", same: false, recommended: true }] as never;
    const html = render(limited, { resumable: true, choices, choiceKey: "claude:max-2|claude-sonnet-5-5", nextLabel: codingResumeLabel(limited, "Claude Max 2") });
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
    expect(html).toContain("Retry the build on Claude Max 2");
  });
});

describe("F-11: no internal name reaches a rendered job view or a line the harness says", () => {
  test("rendered glances and blocker words (limit, stopped, failed, interrupted, checkout change) carry no configuration, script, slot or worker names", () => {
    const jobs = [
      base("blocked_allowance", { runs: [{ roleId: "builder-1", role: "builder", state: "blocked_allowance", binding: binding("claude:max", "claude-sonnet-5-5"), history: [], error: { code: "limit_reached", message: "Claude hit its usage limit." } }] }),
      base("cancelled"), base("failed"),
      base("interrupted", { stoppedBecause: { code: "restart", message: "The hub restarted while the tests were running. Nothing was replayed.", at: "x" } }),
      base("needs_owner", { runs: [{ roleId: "builder-1", role: "builder", state: "failed", binding: binding("claude:max", "m"), history: [], error: { code: "policy_violation", message: "A checkout this job must not touch changed while it ran (the live OS checkout: docs/a.md)." } }] }),
    ];
    for (const j of jobs) {
      const html = render(j, { resumable: true, choices: [] });
      expect(html.match(FORBIDDEN)?.[0] ?? null).toBeNull();
      expect(codingBlocker(j).text).not.toMatch(FORBIDDEN);
    }
  });
  test("what the harness says when an account is full uses the account's name, not its slot (the spoken line shown on the job card)", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const w = world({ claudeAllowance: () => ({ accountSlot: "claude:max", plan: "claude-max-20x", windows: [{ label: "weekly", usedPercent: 100, resetsAt: soon }], credits: null, readAt: new Date().toISOString(), reading: "fresh", source: "test" } as never) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, settled);
      const said = w.store.events(job.id, 0, 5000).filter((e) => e.type === "spoken").map((e) => String((e.payload as { line?: string }).line ?? "")).join(" ");
      expect(said).toMatch(/Claude Max is at its limit/);
      expect(said).not.toMatch(/claude:max/);
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 120_000);
});

describe("F-13: Deny reads as what happened", () => {
  test("declining a request whose role is gone: 'You declined … Nothing ran for it', not 'you paused the builder'", async () => {
    const w = world();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(w.dataDir, "..", ".gate-seed.json"), "{}");
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "dev-seed.ts")], { env: { ...process.env, CODING_DATA_DIR: w.dataDir, CODING_SEED_PHASE: "live" } });
      expect(child.exitCode).toBe(0);
      const asking = w.store.listJobs({ limit: 20 }).find((j) => j.runs.some((r) => r.state === "needs_input"))!;
      const run = asking.runs.find((r) => r.state === "needs_input")!;
      const after = w.orch.respond(asking.id, run.roleId, run.pendingInput!.id, "deny");
      expect(after.stoppedBecause?.code).toBe("input_declined");
      const b = codingBlocker(after);
      expect(b.text).toMatch(/^You declined Allow Bash\? \(make generate-fixtures\)\. Nothing ran for it\. Resume starts that step again/);
      expect(b.text).not.toMatch(/paused/);
      expect(b.text).not.toMatch(FORBIDDEN);
      void FakeClaude;
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  });
});

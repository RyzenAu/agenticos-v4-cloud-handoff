// "Jarvis, assign a builder to fix X and a reviewer to check it" end to end, SYNTHETIC: a temp git repo with a
// dirty canonical checkout, fake Claude processes that speak the real protocol, a real B2 ApprovalService, the
// real shaper/voice/orchestrator and the command-entry facade the command service calls. No live provider,
// no real agent CLI, no network. Router calls go through the real runRouted with a fake invoker.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { RoutedChatOptions } from "../model-router/chat";
import { MemoryReceiptSink } from "../model-router/receipts";
import { ProviderError, runRouted, type RunResult } from "../model-router/router";
import { DEFAULT_ACCOUNTS } from "./accounts";
import { createCodingCommandEntry, type CodingEntryTurn } from "./command-entry";
import type { CodingJob, RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { modelsUsed } from "./receipts";
import { DEFAULT_CODING_PREFS, type ChoiceEnv, type CodingModelPrefs } from "./role-choice";
import { codingRoute, jobView, type CodingRuntime } from "./routes";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude, FakeCodex, type ClaudeStep } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import { createShaper } from "./shaper";
import { specDigest } from "./spec";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo, gitIn, type FixtureRepo } from "./test-fixtures";
import { canonicalSnapshot, sameSnapshot, worktreePathFor } from "./worktree";
import { createCodingVoice } from "./voice";

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });

const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
function fastFixture(): FixtureRepo {
  const fx = fixtureRepo();
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const baseSha = gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never;
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  gitIn(fx.canonical, "branch", "production", baseSha);
  return { ...fx, baseSha, entry: { ...fx.entry, commands: [{ id: "fx.test" as never, kind: "test", argv, cwd: ".", timeoutMs: 60_000, counts: "bun" }] } };
}

const BUILDER: ClaudeStep[] = [
  { tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 42;\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 42;\n" } } },
  { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
  { tool: "Bash", input: { command: 'git commit -m "builder: set a to 42"' }, effect: { git: ["commit", "-q", "-m", "builder: set a to 42"] } },
  { text: "Set a to 42 in src/a.ts and committed." },
];
const APPROVE = JSON.stringify({ verdict: "approve", findings: [], criteria: [{ criterionId: "c2", met: true, note: "a is 42" }] });
const healthyRoute = ((_task: string, c: { selected?: string }) => ({ model: c.selected, fallbackFrom: null })) as unknown as ChoiceEnv["route"];

const usman = { id: "usman", name: "Usman", via: "local", actor: "human" } as const;
const turn = (over: Partial<CodingEntryTurn> = {}): CodingEntryTurn => ({ personId: "usman", actor: "human", via: "local", ...over });
const PHRASE = "Jarvis, assign a builder to change a to 42 in src/a.ts so the fixture reports the new value and a reviewer to check it";
const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };

type Options = {
  reviewer?: () => FakeClaude;
  builder?: () => FakeClaude;
  prefs?: CodingModelPrefs;
  /** Default false: Codex is not connected here (so the auto reviewer is a different Claude model). */
  codex?: boolean;
  chat?: (o: RoutedChatOptions) => Promise<RunResult<string>>;
};

function world(options: Options = {}) {
  const fx = fastFixture();
  roots.push(fx.root);
  const store = CodingStore.open(join(fx.root, "coding-data"));
  const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
  const ledger = new SpokenConfirmationLedger();
  const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
  const launched: { role: "builder" | "reviewer"; fake: FakeClaude }[] = [];
  const claudeSpawn = ((binary: string, args: string[], opts: any) => {
    const readOnly = args[args.indexOf("--permission-mode") + 1] === "plan";
    const fake = readOnly
      ? (options.reviewer?.() ?? new FakeClaude({ model: "claude-sonnet-5-5", result: { result: APPROVE } }))
      : (options.builder?.() ?? new FakeClaude({ steps: BUILDER }));
    fake.args = args; fake.options = { ...opts, binary };
    launched.push({ role: readOnly ? "reviewer" : "builder", fake });
    return fake;
  }) as any;
  const sink = new MemoryReceiptSink();
  const prefs = options.prefs ?? DEFAULT_CODING_PREFS;
  const routerSink = new MemoryReceiptSink();
  const fakeChat = async (o: RoutedChatOptions): Promise<RunResult<string>> => options.chat ? options.chat(o) : runRouted<string>({
    task: o.task, caller: o.caller, sink: routerSink, parentRequestId: o.parentRequestId,
    constraints: { ...o.constraints, providers: ["codex", "openrouter", "cline", "claude-sub"], hasKey: () => true, allowance: () => null },
    invoke: async (choice) => {
      // Hermes (the selected model) is at its limit; only Cline's free DeepSeek answers.
      if (choice.model !== "cline/deepseek-v4.1-flash") throw new ProviderError(choice.model === "codex/gpt-6-sol" ? "rate_limited" : "unavailable", "down", { sent: false, httpStatus: 429 });
      return { value: APPROVE, providerModel: choice.providerModel, usage: { inputTokens: 900, outputTokens: 120 }, costUsd: null };
    },
  });
  const orch = createOrchestrator({
    store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
    runners: {
      claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
      codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
      router: routerRunner({ chat: fakeChat, prefs: () => prefs, owns: () => null }),
    },
    approvals: () => approvals, liveRoot: null, fleetSink: sink, claudeAllowance: () => null,
    memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
  });
  orch.attachApprovals();
  const shaper = createShaper({
    registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null,
    prefs: () => prefs, choice: () => ({ route: healthyRoute, hasKey: () => true, readings: [], codexAvailable: options.codex === true }),
  });
  let focus: { jobId: string; tab: string } | null = null;
  const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: (jobId, tab) => { focus = { jobId, tab }; }, repoIds: () => [] });
  const entry = createCodingCommandEntry({ voice, store });
  // A spoken turn as the free-voice engine runs it: the STT's spoken-yes id only when the transcript is a clear yes.
  const say = (text: string, over: Partial<CodingEntryTurn> = {}) => entry.handle(text, { ...turn(over), spokenYes: over.spokenYes !== undefined ? over.spokenYes : ledger.record(text)?.id ?? null });
  const runtime = { store, orch, shaper, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null } as unknown as CodingRuntime;
  const close = () => { orch.close(); store.close(); approvals.close(); };
  return { fx, store, orch, approvals, ledger, launched, sink, routerSink, voice, entry, say, runtime, close, get focus() { return focus; } };
}
type World = ReturnType<typeof world>;

async function until(w: World, id: string, pred: (j: CodingJob) => boolean, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const j = w.store.getJob(id)!;
    if (pred(j)) return j;
    if (Date.now() - start > ms) throw new Error(`timed out; job is ${j.state}: gate ${JSON.stringify(j.gate?.checks.filter((c) => !c.passed))}; texts ${JSON.stringify(w.store.events(id).filter((e) => e.type === "text").map((e) => e.payload))}; ${JSON.stringify(w.store.events(id).filter((e) => e.type === "error").map((e) => e.payload)).slice(0, 1200)}`);
    await Bun.sleep(25);
  }
}
const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));
const idle = (w: World, id: string) => until(w, id, (j) => settled(j) && !w.orch.running(id));

describe("assign a builder and a reviewer: the whole lifecycle", () => {
  test("assign → draft with reasons → start once → isolated builder → diff+test receipts → independent reviewer → gate → cancel/resume without replay → merge needs Usman", async () => {
    const w = world({ reviewer: (() => { let n = 0; return () => (n++ === 0 ? new FakeClaude({ model: "claude-sonnet-5-5", stall: true, steps: [{ wait: 60_000 }] }) : new FakeClaude({ model: "claude-sonnet-5-5", result: { result: APPROVE } })); })() });
    const canonicalBefore = canonicalSnapshot(w.fx.canonical);
    const productionBefore = gitIn(w.fx.canonical, "rev-parse", "production").trim();

    // 1. assign → a draft: builder and a DIFFERENT reviewer, each with a reason, in the reply and the spec.
    const drafted = await w.say(PHRASE);
    expect(drafted?.navigate).toBe("/coding");
    expect(drafted?.jobState).toBe("awaiting_confirmation");
    const jobId = drafted!.jobId!;
    const models = drafted!.draft!.roles.map((r) => [r.role, r.model, r.basis]);
    expect(models).toEqual([["builder", "claude-opus-5-5", "auto"], ["reviewer", "claude-sonnet-5-5", "auto"]]);
    expect(drafted!.draft!.roles.every((r) => (r.why ?? "").length > 10)).toBe(true);
    expect(drafted!.say).toContain("Builder: Opus,");
    expect(drafted!.say).toContain("Reviewer: Sonnet, a different model than the builder");
    expect(drafted!.draft!.specDigest).toBe(specDigest(w.store.getJob(jobId)!.spec));
    expect(w.store.getJob(jobId)!.spec.objective).toBe("change a to 42 in src/a.ts so the fixture reports the new value");
    await Bun.sleep(100);
    expect(w.launched).toHaveLength(0); // nothing runs before "start"

    // 2. Start once, three ways at the same time: a spoken yes, the Coding page's Start, and a repeated Start.
    const digest = specDigest(w.store.getJob(jobId)!.spec);
    const spoken = await w.say("yes", { previousAssistant: drafted!.say });
    expect(spoken?.say).toContain("Started");
    const page = w.orch.confirmAndStart(jobId, OWNER, "ui", digest);
    const again = w.orch.confirmAndStart(jobId, OWNER, "ui", digest);
    expect([page.id, again.id]).toEqual([jobId, jobId]);
    const twice = await w.say("start it", { previousAssistant: drafted!.say });
    expect(twice === null || !/Started/.test(twice.say)).toBe(true);

    // 3. The builder works in its OWN worktree; the dirty canonical checkout is byte-identical (snapshot).
    const reviewing = await until(w, jobId, (j) => j.runs.some((r) => r.roleId === "reviewer" && r.state === "running"));
    const entry = w.fx.entry;
    const builderTree = worktreePathFor(entry, jobId.replace(/-/g, "").slice(0, 6), "builder-1");
    expect(existsSync(builderTree)).toBe(true);
    expect(readFileSync(join(builderTree, "src", "a.ts"), "utf8")).toBe("export const a = 42;\n");
    expect(readFileSync(join(w.fx.canonical, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(sameSnapshot(canonicalBefore, canonicalSnapshot(w.fx.canonical))).toBe(true);
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(productionBefore);

    // 4. Diff + test receipts exist before the reviewer finishes; the tests were run by the orchestrator.
    expect(reviewing.diff?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    const head = reviewing.tests.find((t) => t.sha === reviewing.headSha)!;
    expect(head).toMatchObject({ ranBy: "orchestrator", exitCode: 0, counts: { passed: 3, failed: 0 } });
    const usageSoFar = w.store.events(jobId, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
    expect(usageSoFar.map((r) => `${r.coding.roleId} ${r.account} ${r.model}`)).toEqual(["builder-1 claude:max claude-opus-5-5"]);

    // 5. "Stop the reviewer": the job waits for the owner; worktrees stay; nothing is merged.
    const stopped = await w.say("stop the reviewer");
    expect(stopped?.say).toContain("Stopped the reviewer");
    const waiting = await until(w, jobId, (j) => j.state === "needs_owner" && settled(j));
    expect(waiting.runs.find((r) => r.roleId === "reviewer")!.state).toBe("cancelled");
    await until(w, jobId, () => !w.orch.running(jobId));
    expect(existsSync(builderTree)).toBe(true);
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(productionBefore);

    // 6. Resume: only the reviewer runs again. The finished builder is NOT replayed and no run is duplicated.
    const buildersBefore = w.launched.filter((l) => l.role === "builder").length;
    const resumed = await w.say("resume the coding job");
    expect(resumed?.say).toContain("nothing that already ran is repeated");
    const done = await until(w, jobId, (j) => j.state === "completed" && !w.orch.running(jobId));
    expect(w.launched.filter((l) => l.role === "builder")).toHaveLength(buildersBefore);
    expect(w.launched.filter((l) => l.role === "reviewer")).toHaveLength(2);
    expect(done.runs.filter((r) => r.roleId === "builder-1")).toHaveLength(1);
    expect(done.runs.filter((r) => r.roleId === "reviewer").map((r) => r.state)).toEqual(["cancelled", "succeeded"]);

    // 7. The gate passed for the exact head, including the receipts check; the reviewer was a different model.
    expect(done.gate).toMatchObject({ passed: true, sha: done.headSha });
    expect(done.gate!.checks.find((c) => c.check === "receipts-recorded")?.passed).toBe(true);
    expect(done.review).toMatchObject({ verdict: "approve", sha: done.headSha });
    const view = jobView(w.runtime, done);
    const used = view.modelsUsed.filter((r) => r.hasReceipt).map((r) => `${r.roleId}:${r.selected}>${r.actual}:${r.fellBack}`);
    expect(used).toContain("builder-1:claude-opus-5-5>claude-opus-5-5:false");
    expect(used).toContain("reviewer:claude-sonnet-5-5>claude-sonnet-5-5:false");
    expect(view.modelsUsed.find((r) => r.roleId === "builder-1")!.actual).not.toBe(view.modelsUsed.filter((r) => r.roleId === "reviewer").at(-1)!.actual);
    const status = await w.say("how's the coding job going?");
    expect(status?.say).toContain("done and verified");
    expect(status?.say).toContain("The builder ran on Opus.");
    expect(status?.say).toContain("The reviewer ran on Sonnet.");
    expect(status?.say).toContain("Nothing is merged");
    expect(status?.jobState).toBe("completed");

    // 8. Merge: Mehroz asking creates a request ONLY; he cannot approve; nothing merges until Usman does.
    const asked = await w.say("merge it into production", turn({ personId: "mehroz", via: "tailnet" }));
    expect(asked?.say).toContain("Usman needs to approve");
    const pending = w.store.getJob(jobId)!;
    expect(pending.state).toBe("awaiting_approval");
    expect(pending.applies).toHaveLength(1);
    expect(pending.applies[0]).toMatchObject({ state: "awaiting_approval", toRef: "production", action: "git.merge.protected" });
    const approvalId = pending.applies[0].approval.approvalId;
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(productionBefore);
    const owner = { personId: "usman" as const, via: "loopback-owner" as const, actor: "human" as const, deviceId: "usman-pc" };
    const q1 = w.approvals.ask(approvalId, owner);
    await Bun.sleep(3);
    const his = w.ledger.record("yes, approve")!;
    expect(w.approvals.decide(approvalId, { personId: "mehroz", via: "tailnet-person", actor: "human" }, "approve", { spokenYes: his.id, questionId: q1.questionId })).toMatchObject({ ok: false });
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(productionBefore);
    // A typed yes from anyone is not an approval either; Mehroz's "yes, approve" through Jarvis does nothing.
    expect(await w.say("yes, approve", turn({ personId: "mehroz", via: "tailnet" }))).toBeNull();
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(productionBefore);
    // Usman's own spoken yes to the question merges once, and git confirms it.
    const q2 = w.approvals.ask(approvalId, owner);
    await Bun.sleep(3);
    const yes = w.ledger.record("yes, approve")!;
    expect(w.approvals.decide(approvalId, owner, "approve", { spokenYes: yes.id, questionId: q2.questionId })).toMatchObject({ ok: true });
    const merged = await until(w, jobId, (j) => j.applies.some((a) => a.state === "succeeded" || a.state === "failed"));
    expect(merged.applies[0].state).toBe("succeeded");
    const tip = gitIn(w.fx.canonical, "rev-parse", "production").trim();
    expect(tip).toBe(merged.applies[0].verification!.observed);
    expect(gitIn(w.fx.canonical, "merge-base", "--is-ancestor", done.headSha!, tip)).toBe("");
    // The live main branch and the canonical working files were never touched.
    expect(gitIn(w.fx.canonical, "rev-parse", "main").trim()).toBe(w.fx.baseSha);
    expect(sameSnapshot(canonicalBefore, canonicalSnapshot(w.fx.canonical))).toBe(true);
    w.close();
  }, 600_000);

  test("cancelling the whole job leaves the worktrees, merges nothing, and can't be resumed into a replay", async () => {
    const w = world({ reviewer: () => new FakeClaude({ model: "claude-sonnet-5-5", stall: true, steps: [{ wait: 60_000 }] }) });
    const drafted = await w.say(PHRASE);
    const jobId = drafted!.jobId!;
    await w.say("yes", { previousAssistant: drafted!.say });
    await until(w, jobId, (j) => j.runs.some((r) => r.roleId === "reviewer" && r.state === "running"));
    const stopped = await w.say("stop the coding job");
    expect(stopped?.say).toContain("Its worktrees are kept");
    const cancelled = await until(w, jobId, (j) => j.state === "cancelled" && settled(j) && !w.orch.running(jobId));
    expect(existsSync(worktreePathFor(w.fx.entry, jobId.replace(/-/g, "").slice(0, 6), "builder-1"))).toBe(true);
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(w.fx.baseSha);
    expect(gitIn(w.fx.canonical, "rev-parse", "main").trim()).toBe(w.fx.baseSha);
    expect(cancelled.applies).toHaveLength(0);
    const launches = w.launched.length;
    const resumed = await w.say("resume the coding job");
    expect(resumed?.say).toMatch(/cancelled job can't be resumed/);
    expect(await w.say("merge the coding job into production")).toMatchObject({ say: expect.stringMatching(/can't be merged/) });
    await Bun.sleep(100);
    expect(w.launched).toHaveLength(launches);
    expect(w.store.getJob(jobId)!.applies).toHaveLength(0);
    w.close();
  }, 600_000);
});

describe("starting is idempotent", () => {
  test("a spoken yes plus a Coding page Start plus a repeat: ONE run set (one builder, one reviewer), one preparing transition", async () => {
    const w = world();
    const drafted = await w.say(PHRASE);
    const jobId = drafted!.jobId!;
    const digest = specDigest(w.store.getJob(jobId)!.spec);
    // The Coding page's POST twice (a double click) and Jarvis's yes, all before the first pipeline step finishes.
    const results = await Promise.all([
      Promise.resolve().then(() => w.orch.confirmAndStart(jobId, OWNER, "ui", digest)),
      w.say("yes", { previousAssistant: drafted!.say }),
      Promise.resolve().then(() => w.orch.confirmAndStart(jobId, OWNER, "ui", digest)),
    ]);
    expect(results).toHaveLength(3);
    const done = await until(w, jobId, (j) => j.state === "completed" && !w.orch.running(jobId));
    expect(w.launched.map((l) => l.role)).toEqual(["builder", "reviewer"]);
    expect(done.runs.map((r) => r.roleId)).toEqual(["builder-1", "reviewer"]);
    const preparing = w.store.events(jobId, 0, 5000).filter((e) => e.type === "state" && (e.payload as any).scope === "job" && (e.payload as any).to === "preparing");
    expect(preparing).toHaveLength(1);
    // Starting a finished job again (the same digest) is a no-op, not an error and not a rerun.
    expect(w.orch.confirmAndStart(jobId, OWNER, "ui", digest).state).toBe("completed");
    // A DIFFERENT digest is still refused.
    expect(() => w.orch.confirmAndStart(jobId, OWNER, "ui", "0".repeat(64) as never)).toThrow();
    const late = await w.say("yes", { previousAssistant: drafted!.say });
    expect(late === null || !/^Started/.test(late.say)).toBe(true);
    expect(w.launched).toHaveLength(2);
    w.close();
  }, 600_000);

  test("the Coding page's POST is one run set too: same requestId or a second click", async () => {
    const w = world();
    const drafted = await w.say(PHRASE);
    const jobId = drafted!.jobId!;
    const digest = specDigest(w.store.getJob(jobId)!.spec);
    const principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.session" } as never;
    const post = (requestId?: string) => codingRoute({ method: "POST", path: "/coding/jobs", url: new URL("http://x/coding/jobs"), body: { specId: jobId, specDigest: digest, confirmation: "ui", ...(requestId ? { requestId } : {}) }, principal }, w.runtime);
    const rid = crypto.randomUUID();
    const first = await post(rid);
    const second = await post();
    expect(first).toMatchObject({ status: 202 });
    expect(second).toMatchObject({ status: 202 });
    await until(w, jobId, (j) => j.state === "completed" && !w.orch.running(jobId));
    expect(w.launched.map((l) => l.role)).toEqual(["builder", "reviewer"]);
    w.close();
  }, 600_000);
});

describe("the receipt records the model that ACTUALLY ran", () => {
  test("Hermes selected as reviewer, at its limit: the router falls back to a free model; the receipt, the models-used view, the spoken line and the gate all say so", async () => {
    // allowPaidFallback: false keeps the fallback off the metered OpenRouter models; Cline's free DeepSeek answers.
    const w = world({ prefs: { freeOnly: false, allowPaidFallback: false } });
    const drafted = await w.say("Jarvis, set a to 42 in src/a.ts so the fixture reports the new value. Opus builds, Hermes reviews.");
    expect(drafted?.draft?.roles.map((r) => [r.role, r.model, r.basis])).toEqual([["builder", "claude-opus-5-5", "named"], ["reviewer", "codex/gpt-6-sol", "named"]]);
    const jobId = drafted!.jobId!;
    await w.say("yes", { previousAssistant: drafted!.say });
    const done = await until(w, jobId, (j) => j.state === "completed" && !w.orch.running(jobId));
    const receipts = w.store.events(jobId, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
    const reviewer = receipts.find((r) => r.coding.roleId === "reviewer");
    expect(reviewer).toMatchObject({ model: "cline/deepseek-v4.1-flash", fallbackFrom: "codex/gpt-6-sol", account: "router:cline", costClass: "free", route: "model-router" });
    expect(reviewer.usage).toMatchObject({ inputTokens: 900, outputTokens: 120 });
    expect(reviewer.cost.basis).toBe("free");
    // No metered model was tried: the owner's "no paid fallback" preference held.
    expect(w.routerSink.receipts.some((r) => r.route === "metered")).toBe(false);
    // The run's binding still says what was SELECTED; the models-used view pairs it with what ran.
    expect(done.runs.find((r) => r.roleId === "reviewer")!.binding.model).toBe("codex/gpt-6-sol");
    const row = modelsUsed(done.runs, w.store.events(jobId, 0, 5000)).find((r) => r.roleId === "reviewer")!;
    expect(row).toMatchObject({ selected: "codex/gpt-6-sol", actual: "cline/deepseek-v4.1-flash", fellBack: true, fallbackFrom: "codex/gpt-6-sol", hasReceipt: true });
    expect(row.reason ?? "").toMatch(/Codex|rate|429|limit|unavailable|fell back/i);
    const status = await w.say("how's the coding job going?");
    expect(status?.say).toMatch(/The reviewer ran on Cline DeepSeek \(selected Hermes \(GPT-6 Sol\), fell back because .+\)\./);
    expect(status?.say).toContain("The builder ran on Opus.");
    expect(done.gate!.passed).toBe(true);
    w.close();
  }, 600_000);

  test("a finished run with no receipt is never claimed: the models-used view and the gate say so", () => {
    const runs = [{ roleId: "builder-1", role: "builder", attempt: 1, state: "succeeded", binding: { provider: "anthropic", route: "claude-code-cli", accountSlot: "claude:max", model: "claude-opus-5-5", cliVersion: "2" } }] as never;
    const [row] = modelsUsed(runs, []);
    expect(row).toMatchObject({ hasReceipt: false, actual: null, fellBack: false });
  });
});

describe("free-only prefs through the command entry", () => {
  test("no paid model is chosen; an explicitly named paid model is refused and the reply says which", async () => {
    const w = world({ prefs: { freeOnly: true, allowPaidFallback: true } });
    const auto = await w.say(PHRASE);
    expect(auto?.draft?.roles.every((r) => r.model.startsWith("cline/"))).toBe(true);
    expect(auto?.draft?.roles.map((r) => r.model)).toHaveLength(2);
    expect(new Set(auto!.draft!.roles.map((r) => r.model)).size).toBe(2);
    expect(auto?.say).toContain("free only");
    const named = await w.say("Jarvis, set a to 42 in src/a.ts so the fixture reports the new value. Opus builds, Codex reviews.");
    expect(named?.say).toMatch(/Free-only is on, so I won't run Opus/);
    expect(named?.draft).toBeUndefined();
    // Nothing ran and nothing new was drafted for the refused one.
    expect(w.store.listJobs({}).length).toBe(1);
    expect(w.launched).toHaveLength(0);
    w.close();
  }, 120_000);
});

describe("the command entry", () => {
  test("typed and spoken share ONE conversation per person: a person's draft is not a program's, and Mehroz's is not Usman's", async () => {
    const w = world();
    const spokenDraft = await w.say(PHRASE, { via: "voice" });
    expect(spokenDraft?.jobId).toBeTruthy();
    // The same person typing "yes" right after (with the question as the previous line) starts THAT draft.
    const typed = await w.entry.handle("yes", { personId: "usman", actor: "human", via: "local", spokenYes: null, previousAssistant: spokenDraft!.say });
    expect(typed?.say).toContain("Started");
    expect(typed?.jobId).toBe(spokenDraft!.jobId);
    // A program under the same id cannot start anything and shares nothing with the person's state.
    const program = await w.entry.handle("start it", { personId: "usman", actor: "process", via: "local", previousAssistant: spokenDraft!.say });
    expect(program?.say).toMatch(/needs you, signed in/);
    // Not a coding turn: the service carries on.
    expect(await w.say("what's the weather")).toBeNull();
    expect(w.entry.matches("assign a builder to fix the login bug and a reviewer to check it")).toBe(true);
    expect(w.entry.matches("assign a builder to fix my calendar")).toBe(false);
    await until(w, spokenDraft!.jobId!, (j) => j.state === "completed" && !w.orch.running(j.id));
    w.close();
  }, 600_000);
});

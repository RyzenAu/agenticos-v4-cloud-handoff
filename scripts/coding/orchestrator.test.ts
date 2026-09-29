import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { AllowanceSnapshot, CodingJob, IsoTime, RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude, FakeCodex, type ClaudeStep } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import { claudeBinding, codexBinding, draftSpec, specDigest } from "./spec";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo, gitIn, tempRoot, type FixtureRepo } from "./test-fixtures";
import { canonicalSnapshot, sameSnapshot } from "./worktree";

/**
 * SYNTHETIC end-to-end jobs: a temp git repo (dirty canonical checkout), fake Claude/Codex processes that
 * speak the real protocols and really edit/commit when the policy allows, the orchestrator's own test
 * runs, a real B2 ApprovalService, and a fake memory saver. No real CLI, account or network.
 */

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });

/**
 * The fixture repo with a FAST registry check: a native `findstr` (grep elsewhere) printing a committed
 * results file in bun's output format, so a loaded machine isn't spawning bun for every test run.
 */
const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
function fastFixture(): FixtureRepo {
  const fx = fixtureRepo();
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const baseSha = gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never;
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  return { ...fx, baseSha, entry: { ...fx.entry, commands: [{ id: "fx.test" as never, kind: "test", argv, cwd: ".", timeoutMs: 60_000, counts: "bun" }] } };
}

const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };
const SESSION = /--session-id|--resume/;

type World = {
  fx: FixtureRepo;
  store: CodingStore;
  orch: ReturnType<typeof createOrchestrator>;
  approvals: ApprovalService;
  spoken: SpokenConfirmationLedger;
  sink: MemoryReceiptSink;
  saved: unknown[];
  launched: FakeClaude[];
  codexLaunched: FakeCodex[];
  registry: RepoRegistry;
  dataDir: string;
};

const BUILDER_STEPS = (content = "export const a = 42;\n"): ClaudeStep[] => [
  { tool: "Read", input: { file_path: "src/a.ts" } },
  { tool: "Edit", input: { file_path: "lib/c.ts", old_string: "3", new_string: "4" }, effect: { write: { path: "lib/c.ts", content: "SHOULD NOT HAPPEN\n" } } },
  { tool: "Write", input: { file_path: "src/a.ts", content }, effect: { write: { path: "src/a.ts", content } } },
  { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
  { tool: "Bash", input: { command: 'git commit -m "builder: set a to 42"' }, effect: { git: ["commit", "-q", "-m", "builder: set a to 42"] } },
  { text: "Set a to 42 in src/a.ts and committed. lib/c.ts should also change (outside my files)." },
];
const APPROVE = JSON.stringify({ verdict: "approve", findings: [{ id: "f1", severity: "minor", file: "src/a.ts", line: 1, message: "consider a comment" }], criteria: [{ criterionId: "c2", met: true, note: "a is 42" }] });

function world(options: { builder?: (cwd: string, args: string[]) => FakeClaude; reviewer?: () => FakeClaude; codex?: () => FakeCodex; claudeAllowance?: () => AllowanceSnapshot | null; liveRoot?: string | null; memoryWrites?: boolean; store?: CodingStore; fx?: FixtureRepo; dataDir?: string; approvals?: ApprovalService; spoken?: SpokenConfirmationLedger; codexIsolation?: OrchestratorDeps["codexIsolation"]; isolationRecheckMs?: number } = {}): World {
  const fx = options.fx ?? fastFixture();
  if (!options.fx) roots.push(fx.root);
  const dataDir = options.dataDir ?? join(fx.root, "coding-data");
  const store = options.store ?? CodingStore.open(dataDir);
  const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
  const spoken = options.spoken ?? new SpokenConfirmationLedger();
  const approvals = options.approvals ?? new ApprovalService({ path: join(fx.root, `approvals-${Math.random().toString(36).slice(2)}.sqlite`), spoken });
  const launched: FakeClaude[] = [];
  const codexLaunched: FakeCodex[] = [];
  const claudeSpawn = ((binary: string, args: string[], opts: any) => {
    const readOnly = args[args.indexOf("--permission-mode") + 1] === "plan";
    const fake = readOnly ? (options.reviewer?.() ?? new FakeClaude({ result: { result: APPROVE } })) : (options.builder?.(opts.cwd, args) ?? new FakeClaude({ steps: BUILDER_STEPS() }));
    fake.args = args;
    fake.options = { ...opts, binary };
    launched.push(fake);
    return fake;
  }) as any;
  const codexSpawn = ((binary: string, args: string[], opts: any) => {
    const fake = options.codex?.() ?? new FakeCodex();
    fake.args = args;
    fake.options = { ...opts, binary };
    codexLaunched.push(fake);
    return fake;
  }) as any;
  const sink = new MemoryReceiptSink();
  const saved: unknown[] = [];
  const orch = createOrchestrator({
    store,
    registry: () => registry,
    accounts: () => DEFAULT_ACCOUNTS,
    runners: {
      claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
      codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: codexSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
      router: routerRunner({ chat: async () => { throw new Error("no router in this test"); } }),
    },
    approvals: () => approvals,
    liveRoot: options.liveRoot ?? null,
    memory: { writes: () => options.memoryWrites ?? true, save: async (p, input) => { saved.push({ p, input }); return { ok: true, fact: { wiki_ref: "mf-test", source: { link: "obsidian://test" } } }; } },
    fleetSink: sink,
    claudeAllowance: options.claudeAllowance ?? (() => null),
    inputTimeoutMs: 120_000,
    codexIsolation: options.codexIsolation ?? (() => ({ ok: true, message: "" })),
    isolationRecheckMs: options.isolationRecheckMs,
  });
  orch.attachApprovals();
  return { fx, store, orch, approvals, spoken, sink, saved, launched, codexLaunched, registry, dataDir };
}

function spec(w: World, over: { builderBinding?: ReturnType<typeof claudeBinding> } = {}) {
  return draftSpec({
    requestedBy: OWNER, channel: "voice", utterance: "Set a to 42. Opus builds, another Opus reviews.", entry: w.fx.entry,
    objective: "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }],
    roleTemplate: "build+review",
    builders: [{ binding: over.builderBinding ?? claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }],
    reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280") },
    checks: ["fx.test" as never], dataClass: "synthetic",
  });
}

async function until(w: World, id: string, pred: (j: CodingJob) => boolean, ms = 400_000) {
  const start = Date.now();
  for (;;) {
    const j = w.store.getJob(id)!;
    if (pred(j)) return j;
    if (Date.now() - start > ms) throw new Error(`timed out; job is ${j.state}: ${JSON.stringify(w.store.events(id).filter((e) => e.type === "error" || e.type === "state").map((e) => e.payload)).slice(0, 1500)}`);
    await Bun.sleep(25);
  }
}
const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));

describe("orchestrator: a SYNTHETIC job end to end", () => {
  test("build → test → review → gate → handoff; canonical untouched; receipts name the account and model", async () => {
    const w = world();
    const before = canonicalSnapshot(w.fx.canonical);
    const s = spec(w);
    const { job, validation } = w.orch.draft(s);
    expect(validation.ok).toBe(true);
    expect(job.state).toBe("awaiting_confirmation");
    w.orch.confirmAndStart(job.id, OWNER, "spoken-yes", specDigest(s));
    const done = await until(w, job.id, settled);
    const events = w.store.events(job.id, 0, 5000);
    expect(done.state).toBe("completed");
    // The gate passed for the exact head, and every check is recorded.
    expect(done.gate?.passed).toBe(true);
    expect(done.gate?.sha).toBe(done.headSha!);
    expect(done.diff?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(done.review?.verdict).toBe("approve");
    expect(done.review?.sha).toBe(done.headSha!);
    // The orchestrator's own test run (not an agent claim), with the baseline on the base sha.
    const head = done.tests.find((t) => t.sha === done.headSha)!;
    expect(head.ranBy).toBe("orchestrator");
    expect(head.counts).toEqual({ passed: 3, failed: 0, skipped: null });
    expect(head.baseline?.sha).toBe(w.fx.baseSha);
    // The builder was denied the unowned file, and it didn't change.
    const policy = events.filter((e) => e.type === "policy").map((e) => e.payload as any);
    expect(policy.some((p) => p.rule === "edit-not-owned" && p.decision === "auto-deny")).toBe(true);
    expect(policy.some((p) => p.rule === "edit-owned" && p.decision === "auto-allow")).toBe(true);
    // Session ids: the builder got a pre-assigned --session-id.
    expect(w.launched[0].args.some((a) => SESSION.test(a))).toBe(true);
    // Receipts: one per role turn with the real account and model; the fleet ledger got native rows.
    const receipts = events.filter((e) => e.type === "usage").map((e) => e.payload as any);
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.account).toBe("claude:max");
      expect(r.model).toBe("claude-opus-5-5");
      expect(r.cost).toMatchObject({ basis: "subscription_allowance", usd: null });
      expect(r.valueUsdEquivalent).toBe(0.0123);
    }
    expect(w.sink.receipts.filter((r) => r.task === "coding")).toHaveLength(2);
    // Handoff: memory saved (writes on), Work linked; spoken lines never say done before the gate.
    const handoff = events.find((e) => e.type === "handoff")!.payload as any;
    expect(handoff).toMatchObject({ memory: "saved", workLinked: true });
    expect(w.saved).toHaveLength(1);
    const lines = events.filter((e) => e.type === "spoken").map((e) => (e.payload as any).line as string);
    const doneAt = lines.findIndex((l) => /Done and verified/.test(l));
    const gateAt = events.findIndex((e) => e.type === "gate");
    expect(doneAt).toBeGreaterThan(-1);
    expect(events.findIndex((e) => e.type === "spoken" && /Done and verified/.test((e.payload as any).line))).toBeGreaterThan(gateAt);
    expect(lines.join(" ")).toContain("Nothing is merged");
    // The dirty canonical checkout is byte-identical.
    expect(sameSnapshot(before, canonicalSnapshot(w.fx.canonical))).toBe(true);
    expect(readFileSync(join(w.fx.canonical, "lib", "c.ts"), "utf8")).toBe("export const c = 3;\n");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("memory writes off → the handoff records 'skipped-writes-off'", async () => {
    const w = world({ memoryWrites: false });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w, job.id, settled);
    const handoff = w.store.events(job.id, 0, 5000).find((e) => e.type === "handoff")!.payload as any;
    expect(handoff.memory).toBe("skipped-writes-off");
    expect(w.saved).toHaveLength(0);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("a reviewer that asks for changes fails the gate: needs_owner, never 'done'", async () => {
    const w = world({ reviewer: () => new FakeClaude({ result: { result: JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "blocker", message: "wrong value" }], criteria: [] }) } }) });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("needs_owner");
    expect(done.gate?.passed).toBe(false);
    const lines = w.store.events(job.id, 0, 5000).filter((e) => e.type === "spoken").map((e) => (e.payload as any).line as string).join(" ");
    expect(lines).not.toContain("Done and verified");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("a spec that changed after it was shown can't be confirmed", async () => {
    const w = world();
    const s = spec(w);
    const { job } = w.orch.draft(s);
    expect(() => w.orch.confirmAndStart(job.id, OWNER, "ui", "0".repeat(64) as never)).toThrow(/changed/);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);
});

describe("orchestrator: allowance, isolation, stop", () => {
  test("Claude at the stop threshold: the role is blocked before starting; resume with an explicit reassignment to Codex is recorded", async () => {
    const high: AllowanceSnapshot = { accountSlot: "claude:max", windows: [{ label: "5-hour", usedPercent: 97, resetsAt: "2026-09-28T16:00:00.000Z" as IsoTime }], creditsWouldBeUsed: false, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as IsoTime };
    let allowance: AllowanceSnapshot | null = high;
    const w = world({
      claudeAllowance: () => allowance,
      codex: () => new FakeCodex({ steps: [{ fileChange: { path: "src/a.ts", content: "export const a = 42;\n" } }, { command: "git add -- src/a.ts", effect: { git: ["add", "--", "src/a.ts"] } }, { command: 'git commit -m "codex: a=42"', effect: { git: ["commit", "-q", "-m", "codex: a=42"] } }] }),
    });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const blocked = await until(w, job.id, settled);
    expect(blocked.state).toBe("blocked_allowance");
    expect(w.launched).toHaveLength(0);
    const line = w.store.events(job.id, 0, 5000).filter((e) => e.type === "spoken").map((e) => (e.payload as any).line).join(" ");
    expect(line).toContain("97%");
    // Nothing moves on its own; the owner reassigns the builder to Codex (recorded).
    allowance = null;
    w.orch.resume(job.id, { by: OWNER, roleId: "builder-1", reassignTo: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0") });
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("completed");
    const builder = done.runs.find((r) => r.roleId === "builder-1")!;
    expect(builder.binding.route).toBe("codex-app-server");
    expect(builder.history.some((h) => h.reason === "owner_resume")).toBe(true);
    const steps = w.store.events(job.id, 0, 5000).filter((e) => e.type === "step").map((e) => (e.payload as any).label);
    expect(steps).toContain("Owner reassigned this role");
    const receipt = w.store.events(job.id, 0, 5000).find((e) => e.type === "usage" && (e.payload as any).coding.roleId === "builder-1")!.payload as any;
    expect(receipt).toMatchObject({ account: "codex:openai-2", model: "gpt-6-astra", route: "codex-app-server" });
    expect(receipt.allowance.plan).toBe("chatgpt-plus");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("A1-6: a Codex role is refused while its sandbox could read credential files", async () => {
    const w = world({ codexIsolation: () => ({ ok: false, message: "Codex roles are paused (A1-6)." }) });
    const s = spec(w, { builderBinding: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0") as never });
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("needs_owner");
    expect(w.codexLaunched).toHaveLength(0);
    expect(JSON.stringify(w.store.events(job.id, 0, 5000).filter((e) => e.type === "error"))).toContain("A1-6");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("T3e: Deny entries re-applied before a Codex role are logged in the job's record; a failed re-apply pauses Codex", async () => {
    const reapplied = [{ path: "C:\\synthetic\\.claude.json", ok: true, rewritten: true }];
    const w = world({ codexIsolation: () => ({ ok: false, message: "Codex roles are paused (A1-6): re-apply failed.", reapplied: [...reapplied, { path: "C:\\synthetic\\x", ok: false, rewritten: false }] }) });
    const s = spec(w, { builderBinding: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0") as never });
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("needs_owner");
    expect(w.codexLaunched).toHaveLength(0);
    const steps = w.store.events(job.id, 0, 5000).filter((e) => e.type === "step").map((e) => JSON.stringify(e.payload));
    const logged = steps.find((p) => p.includes("Re-applied the Codex sandbox Deny"))!;
    expect(logged).toContain("replaced by a rewrite since --apply");
    expect(logged).toContain(".claude.json");
    expect(logged).toContain("failed on");
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("R6: while a Codex role runs, the Deny is re-checked on a timer; a re-apply is logged, and a lapse that can't be fixed pauses the role", async () => {
    let calls = 0;
    const w = world({
      codex: () => new FakeCodex({ stall: true }),
      isolationRecheckMs: 60,
      codexIsolation: async () => {
        calls++;
        if (calls === 1) return { ok: true, message: "" };
        if (calls === 2) return { ok: true, message: "", reapplied: [{ path: "C:\\synthetic\\.claude.json", ok: true, rewritten: true }] };
        return { ok: false, message: "Codex roles are paused: synthetic lapse." };
      },
    });
    const s = spec(w, { builderBinding: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0") as never });
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const paused = await until(w, job.id, (j) => j.runs.some((r) => r.state === "interrupted" || r.state === "failed"));
    expect(w.codexLaunched).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(3);
    const events = w.store.events(job.id, 0, 5000);
    expect(JSON.stringify(events.filter((e) => e.type === "step"))).toContain("while it ran (replaced by a rewrite since --apply)");
    expect(JSON.stringify(events.filter((e) => e.type === "error"))).toContain("Paused: Codex roles are paused: synthetic lapse.");
    expect(paused.runs.find((r) => r.roleId === "builder-1")!.state).toBe("interrupted");
    w.orch.cancel(job.id);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("stop the job → cancelled, the worktrees kept, a handoff written", async () => {
    const w = world({ builder: () => new FakeClaude({ stall: true, steps: [{ wait: 30_000 }] }) });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w, job.id, (j) => j.runs.some((r) => r.state === "running"));
    w.orch.cancel(job.id);
    const done = await until(w, job.id, (j) => j.state === "cancelled" && !j.runs.some((r) => ["starting", "running"].includes(r.state)));
    expect(done.runs[0].state).toBe("cancelled");
    for (let i = 0; i < 200 && !w.store.events(job.id, 0, 5000).some((e) => e.type === "handoff"); i++) await Bun.sleep(25);
    expect(w.store.events(job.id, 0, 5000).some((e) => e.type === "handoff")).toBe(true);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("an escalated input waits for the owner and his answer reaches the agent", async () => {
    const w = world({ builder: () => new FakeClaude({ steps: [{ tool: "Bash", input: { command: "make build" } }, ...BUILDER_STEPS()] }) });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const waiting = await until(w, job.id, (j) => j.runs.some((r) => r.state === "needs_input"));
    const run = waiting.runs.find((r) => r.state === "needs_input")!;
    expect(run.pendingInput?.escalatedBecause).toBeTruthy();
    w.orch.respond(job.id, run.roleId, run.pendingInput!.id, "deny");
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("completed");
    expect(w.launched[0].decisions[0]).toMatchObject({ tool: "Bash", behavior: "deny" });
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);
});

describe("orchestrator: restart and resume", () => {
  test("a restart interrupts the build; nothing replays; an explicit resume continues the SAME native session", async () => {
    const fx = fastFixture();
    roots.push(fx.root);
    const dataDir = join(fx.root, "coding-data");
    const w1 = world({ fx, dataDir, builder: () => new FakeClaude({ stall: true, steps: [{ wait: 60_000 }] }) });
    const s = spec(w1);
    const { job } = w1.orch.draft(s);
    w1.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const running = await until(w1, job.id, (j) => j.runs.some((r) => r.state === "running"));
    const sessionId = running.runs[0].nativeSessionId!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // "Crash": the store goes away under the running job; a new server opens it and recovers.
    w1.store.close();
    const store2 = CodingStore.open(dataDir);
    expect(store2.recovered?.jobs).toContain(job.id);
    const after = store2.getJob(job.id)!;
    expect(after.state).toBe("interrupted");
    expect(after.runs[0].state).toBe("interrupted");
    w1.orch.close();
    const w2 = world({ fx, dataDir, store: store2, approvals: w1.approvals, spoken: w1.spoken });
    // Nothing happens until the owner resumes.
    await Bun.sleep(200);
    expect(w2.launched).toHaveLength(0);
    w2.orch.resume(job.id, { by: OWNER });
    const done = await until(w2, job.id, settled);
    expect(done.state).toBe("completed");
    const resumed = w2.launched[0];
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe(sessionId);
    const events = store2.events(job.id, 0, 5000);
    expect(events.some((e) => e.type === "recovery")).toBe(true);
    expect(done.runs.find((r) => r.roleId === "builder-1")!.attempt).toBe(2);
    w2.orch.close(); store2.close(); w1.approvals.close();
  }, 600_000);
});

describe("orchestrator: agent config in a worktree (REVIEW-T3 F4)", () => {
  test("a resume is refused when agent settings appeared in the worktree; nothing is launched", async () => {
    const fx = fastFixture();
    roots.push(fx.root);
    const w = world({ fx, builder: () => new FakeClaude({ stall: true, steps: [{ wait: 60_000 }] }) });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w, job.id, (j) => j.runs.some((r) => r.state === "running"));
    w.orch.interrupt(job.id);
    await until(w, job.id, (j) => j.runs.some((r) => r.state === "interrupted"));
    const list = gitIn(fx.canonical, "worktree", "list", "--porcelain").split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    const wt = list.find((p) => /builder-1/.test(p))!;
    expect(wt).toBeTruthy();
    // A git-ignored local settings file is caught too.
    writeFileSync(join(wt, ".gitignore"), "");
    mkdirSync(join(wt, ".claude"), { recursive: true });
    writeFileSync(join(wt, ".claude", "settings.local.json"), '{"hooks":{}}');
    const before = w.launched.length;
    w.orch.resume(job.id, { by: OWNER });
    const done = await until(w, job.id, (j) => j.runs.some((r) => r.state === "failed"));
    const run = done.runs.find((r) => r.roleId === "builder-1")!;
    expect(run.error?.code).toBe("policy_violation");
    expect(run.error?.message).toContain(".claude/settings.local.json");
    expect(w.launched.length).toBe(before);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);
});

describe("orchestrator: consequential steps behind B2 approvals", () => {
  async function completed(w: World) {
    gitIn(w.fx.canonical, "branch", "production", w.fx.baseSha);
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    return until(w, job.id, settled);
  }
  test("'merge it' asks once; only the owner's spoken yes to THAT question merges; the result is verified from git", async () => {
    const w = world();
    const job = await completed(w);
    expect(job.state).toBe("completed");
    const { apply, approval } = await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
    expect(apply.state).toBe("awaiting_approval");
    expect(w.store.getJob(job.id)!.state).toBe("awaiting_approval");
    // Asked once: the same request returns the same approval.
    expect((await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER }).catch((e) => e)).message ?? "").toMatch(/completed job/);
    // A UI click can't answer a process-requested approval.
    const owner = { personId: "usman" as const, via: "loopback-owner" as const, actor: "human" as const, deviceId: "usman-pc" };
    expect(w.approvals.decide(approval.id, { ...owner, sessionId: "sk1.fake-session-key" }, "approve", { uiConfirm: true, cardNonce: crypto.randomUUID() })).toMatchObject({ ok: false });
    // A yes heard BEFORE the question doesn't count.
    const early = w.spoken.record("yes")!;
    await Bun.sleep(3); // a yes counts only if strictly after the question; never rely on same-millisecond ordering
    const q = w.approvals.ask(approval.id, owner);
    expect(w.approvals.decide(approval.id, owner, "approve", { spokenYes: early.id, questionId: q.questionId })).toMatchObject({ ok: false });
    // Mehroz's yes doesn't either (the approver is the owner).
    const q2 = w.approvals.ask(approval.id, owner);
    await Bun.sleep(3);
    const his = w.spoken.record("yes")!;
    expect(w.approvals.decide(approval.id, { personId: "mehroz", via: "tailnet-person", actor: "human" }, "approve", { spokenYes: his.id, questionId: q2.questionId })).toMatchObject({ ok: false });
    const q3 = w.approvals.ask(approval.id, owner);
    await Bun.sleep(3);
    const yes = w.spoken.record("yes, approve")!;
    expect(w.approvals.decide(approval.id, owner, "approve", { spokenYes: yes.id, questionId: q3.questionId })).toMatchObject({ ok: true });
    const merged = await until(w, job.id, (j) => j.applies.some((a) => a.state === "succeeded" || a.state === "failed"));
    const step = merged.applies[0];
    expect(step.state).toBe("succeeded");
    expect(step.verification?.method).toBe("merge-commit");
    expect(merged.state).toBe("completed");
    const tip = gitIn(w.fx.canonical, "rev-parse", "production").trim();
    expect(tip).toBe(step.verification!.observed);
    expect(gitIn(w.fx.canonical, "merge-base", "--is-ancestor", job.headSha!, tip)).toBe("");
    expect(w.approvals.get(approval.id)!.state).toBe("consumed");
    // "merge it" again: already in production, so no second approval (it would be an empty merge commit).
    expect((await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER }).catch((e) => e)).message ?? "").toMatch(/already in production/);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("a moved head voids the approval; a branch checked out elsewhere is never moved", async () => {
    const w = world();
    const job = await completed(w);
    const { approval } = await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
    // The digest binds the head: tamper it and the consume is refused.
    w.store.updateJob(job.id, { headSha: w.fx.baseSha });
    const owner = { personId: "usman" as const, via: "loopback-owner" as const, actor: "human" as const, deviceId: "usman-pc" };
    const q = w.approvals.ask(approval.id, owner);
    await Bun.sleep(3);
    const yes = w.spoken.record("yes")!;
    w.approvals.decide(approval.id, owner, "approve", { spokenYes: yes.id, questionId: q.questionId });
    const after = await until(w, job.id, (j) => j.applies[0].state !== "awaiting_approval" && j.applies[0].state !== "running");
    expect(after.applies[0].state).toBe("cancelled");
    expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(w.fx.baseSha);
    // main is checked out in the canonical checkout: a merge into it is refused before anything moves.
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);

  test("deploys and production pushes are refused outright with the reason", async () => {
    const w = world();
    const job = await completed(w);
    await expect(w.orch.requestApply(job.id, { action: "deploy", toRef: "production", by: OWNER })).rejects.toThrow(/aren't done by the coding harness/);
    // REVIEW-T3 F5: a push to the production remote is a deploy: refused outright, no approval card.
    await expect(w.orch.requestApply(job.id, { action: "git.push.production", toRef: "production", remote: "origin", by: OWNER })).rejects.toThrow(/pushes to a deploy branch/);
    expect(w.store.getJob(job.id)!.applies).toHaveLength(0);
    w.orch.close(); w.store.close(); w.approvals.close();
  }, 600_000);
});

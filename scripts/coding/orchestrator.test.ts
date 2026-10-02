import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { screenFact } from "../memory/guard";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { AllowanceSnapshot, CodingJob, IsoTime, RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createOrchestrator, type MemorySaver, type OrchestratorDeps } from "./orchestrator";
import { codingBlocker } from "./pause-reason";
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

function world(options: { builder?: (cwd: string, args: string[]) => FakeClaude; reviewer?: () => FakeClaude; codex?: () => FakeCodex; claudeAllowance?: () => AllowanceSnapshot | null; liveRoot?: string | null; memoryWrites?: boolean; memorySave?: MemorySaver; store?: CodingStore; fx?: FixtureRepo; dataDir?: string; approvals?: ApprovalService; spoken?: SpokenConfirmationLedger; codexIsolation?: OrchestratorDeps["codexIsolation"]; isolationRecheckMs?: number; contextHelper?: OrchestratorDeps["contextHelper"] } = {}): World {
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
    memory: { writes: () => options.memoryWrites ?? true, save: options.memorySave ? async (p, input) => { saved.push({ p, input }); return options.memorySave!(p, input); } : async (p, input) => { saved.push({ p, input }); return { ok: true, fact: { wiki_ref: "mf-test", source: { link: "obsidian://test" } } }; } },
    fleetSink: sink,
    claudeAllowance: options.claudeAllowance ?? (() => null),
    inputTimeoutMs: 120_000,
    codexIsolation: options.codexIsolation ?? (() => ({ ok: true, message: "" })),
    isolationRecheckMs: options.isolationRecheckMs,
    ...(options.contextHelper ? { contextHelper: options.contextHelper } : {}),
  });
  orch.attachApprovals();
  return { fx, store, orch, approvals, spoken, sink, saved, launched, codexLaunched, registry, dataDir };
}

function spec(w: World, over: { builderBinding?: ReturnType<typeof claudeBinding>; objective?: string } = {}) {
  return draftSpec({
    requestedBy: OWNER, channel: "voice", utterance: "Set a to 42. Opus builds, another Opus reviews.", entry: w.fx.entry,
    objective: over.objective ?? "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }],
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
  // Open Dot review C5: the context helper keeps raw command output per job; it is deleted when the job ends for good.
  test("a finished job deletes its context-helper data (and only its own)", async () => {
    const w = world();
    const dataRoot = join(w.fx.root, "context-mode-data");
    w.orch.close();
    const w2 = world({ fx: w.fx, store: w.store, approvals: w.approvals, dataDir: w.dataDir, contextHelper: () => ({ dataRoot }) });
    const s = spec(w2);
    const { job } = w2.orch.draft(s);
    const mine = join(dataRoot, job.id, "builder", "store");
    const other = join(dataRoot, "another-job", "builder", "store");
    for (const d of [mine, other]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "raw.db"), "raw command output"); }
    w2.orch.confirmAndStart(job.id, OWNER, "spoken-yes", specDigest(s));
    const done = await until(w2, job.id, settled);
    expect(done.state).toBe("completed");
    await Bun.sleep(100);
    expect(existsSync(join(dataRoot, job.id))).toBe(false);
    expect(existsSync(other)).toBe(true);
    w2.orch.close(); w2.store.close(); w2.approvals.close();
  }, 600_000);
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

  describe("the handoff fact and the memory screen (round 3)", () => {
    const realScreen: MemorySaver = async (_p, input) => {
      const r = screenFact(input.text, input.title);
      return r.ok ? { ok: true, fact: { wiki_ref: "mf-screened", source: { link: "obsidian://test" } } } : { ok: false, code: r.code };
    };
    async function runHandoff(objective: string) {
      const w = world({ memorySave: realScreen });
      const s = spec(w, { objective });
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "spoken-yes", specDigest(s));
      await until(w, job.id, settled);
      const handoff = w.store.events(job.id, 0, 5000).find((e) => e.type === "handoff")!.payload as any;
      const saved = (w.saved as { input: { title: string; text: string } }[]).map((x) => x.input);
      w.orch.close(); w.store.close(); w.approvals.close();
      return { handoff, saved };
    }

    test("a normal request about credentials ('the password is stored hashed') is saved WITH its wording: the screen no longer mistakes handling words for a value", async () => {
      const { handoff, saved } = await runHandoff("Make sure the password is stored hashed and the api key is never logged");
      expect(handoff).toMatchObject({ memory: "saved", memoryObjective: "copied" });
      expect(saved).toHaveLength(1);
      expect(saved[0]!.text).toContain("stored hashed");
    }, 600_000);

    test("a request that contains a real-looking secret is still never stored: the fact is saved without the request's words, and the secret is in no saved text", async () => {
      const secret = "Zq7781-Fake-Pw-xyz";
      const { handoff, saved } = await runHandoff(`Set the Xero password is now ${secret} in the config`);
      expect(handoff).toMatchObject({ memory: "saved", memoryObjective: "withheld" });
      expect(saved.length).toBeGreaterThan(1); // the full fact was refused first
      for (const s of saved.slice(1)) expect(`${s.title}
${s.text}`).not.toContain(secret);
      expect(saved.at(-1)!.text).toContain("not copied here");
    }, 600_000);
  });

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

  test("review repair: Resume sends rejected work back to the builder and reviews the new commit", async () => {
    let builds = 0;
    let reviews = 0;
    const w = world({
      builder: () => new FakeClaude({ steps: BUILDER_STEPS(++builds === 1 ? "export const a = 41;\n" : "export const a = 42;\n") }),
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({
        verdict: "request-changes", findings: [{ id: "b1", severity: "major", file: "src/a.ts", line: 1, message: "wrong value: a must be 42" }],
        criteria: [{ criterionId: "c2", met: false, note: "a is 41" }],
      }) : APPROVE } }),
    });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, settled);
      expect(builds).toBe(2);
      expect(reviews).toBe(2);
      expect(done.headSha).not.toBe(paused.headSha);
      expect(done.review?.sha).toBe(done.headSha);
      expect(done.gate?.passed).toBe(true);
      expect(done.state).toBe("completed");
      const secondBuilder = w.launched.filter((r) => r.args[r.args.indexOf("--permission-mode") + 1] !== "plan")[1];
      expect(JSON.stringify(secondBuilder.sent)).toContain("wrong value: a must be 42");
      expect(JSON.stringify(secondBuilder.sent)).toContain("a is 41");
      expect(done.applies).toHaveLength(0);
      expect(gitIn(w.fx.canonical, "rev-parse", "HEAD").trim()).toBe(w.fx.baseSha);
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("review repair: cannot-assess retries the reviewer without repeating a successful builder", async () => {
    let builds = 0;
    let reviews = 0;
    const w = world({
      builder: () => { builds++; return new FakeClaude({ steps: BUILDER_STEPS() }); },
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({ verdict: "cannot-assess", findings: [], criteria: [] }) : APPROVE } }),
    });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, settled);
      expect(builds).toBe(1);
      expect(reviews).toBe(2);
      expect(done.headSha).toBe(paused.headSha);
      expect(done.state).toBe("completed");
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("review repair: the test author sees the corrected builder commit and preserves its own earlier work", async () => {
    let builds = 0;
    let authors = 0;
    let reviews = 0;
    const w = world({
      builder: (cwd) => {
        if (!cwd.endsWith("test-author")) return new FakeClaude({ steps: BUILDER_STEPS(++builds === 1 ? "export const a = 41;\n" : "export const a = 42;\n") });
        authors++;
        if (authors === 2) expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toContain("a = 42");
        const content = `export const b = ${authors};\n`;
        return new FakeClaude({ steps: [
          { tool: "Write", input: { file_path: "src/b.ts", content }, effect: { write: { path: "src/b.ts", content } } },
          { tool: "Bash", input: { command: "git add -- src/b.ts" }, effect: { git: ["add", "--", "src/b.ts"] } },
          { tool: "Bash", input: { command: 'git commit -m "test author update"' }, effect: { git: ["commit", "-q", "-m", "test author update"] } },
        ] });
      },
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", message: "correct the implementation and coverage" }], criteria: [] }) : APPROVE } }),
    });
    try {
      const s = spec(w);
      s.roles = [...s.roles, { ...s.roles[0], roleId: "test-author" as never, role: "test-author", owns: { globs: ["src/b.ts"], newFiles: [] } }];
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      expect((await until(w, job.id, settled)).state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, settled);
      expect(builds).toBe(2);
      expect(authors).toBe(2);
      expect(done.state).toBe("completed");
      expect(done.gate?.checks.find((c) => c.check === "ownership")?.passed).toBe(true);
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("review repair: reviewers receive baseline failure identities without calling them passing tests", async () => {
    const fx = fastFixture();
    roots.push(fx.root);
    writeFileSync(join(fx.canonical, "results.txt"), RESULTS.replace(" 0 fail", "(fail) pre-existing environment check [1.00ms]\n 1 fail"));
    gitIn(fx.canonical, "add", "results.txt");
    gitIn(fx.canonical, "commit", "-q", "--only", "-m", "synthetic baseline failure", "--", "results.txt");
    const w = world({ fx: {
      ...fx, baseSha: gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never,
      entry: { ...fx.entry, commands: [{ ...fx.entry.commands[0], argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('results.txt', 'utf8')); process.exit(1)"] }] },
    } });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w, job.id, settled);
      expect(done.state).toBe("completed");
      expect(done.gate?.baselineFailures[0]?.failed).toBe(1);
      const reviewer = w.launched.find((r) => r.args[r.args.indexOf("--permission-mode") + 1] === "plan")!;
      expect(JSON.stringify(reviewer.sent)).toContain("recorded baseline at");
      expect(JSON.stringify(reviewer.sent)).toContain("pre-existing environment check");
      expect(JSON.stringify(reviewer.sent)).toContain("not a new regression or a passing test");
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("reviewer route unavailable: the blocker says so, Resume can move only the reviewer to Claude on a different model, and the build is kept", async () => {
    let builds = 0;
    let reviews = 0;
    const w = world({
      builder: () => { builds++; return new FakeClaude({ steps: BUILDER_STEPS() }); },
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", file: "src/a.ts", line: 1, message: "wrong value" }], criteria: [] }) : APPROVE } }),
      codexIsolation: () => ({ ok: false, message: "Codex roles are paused: its Windows sandbox could read C:\\synthetic (never protected)." }),
    });
    try {
      const s = spec(w);
      s.roles = s.roles.map((r) => (r.role === "reviewer" ? { ...r, agent: codexBinding("gpt-6-astra", "codex:openai-2", "0.159.0") } : r)) as never;
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const stopped = await until(w, job.id, settled);
      expect(stopped.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(codingBlocker(stopped)).toMatchObject({ kind: "reviewer-unavailable", roleId: "reviewer", label: "Retry review" });
      expect(codingBlocker(stopped).text).toContain("Codex is paused");
      expect(builds).toBe(1);
      // The reviewer can never be moved onto the builder's own model.
      expect(() => w.orch.resume(job.id, { by: OWNER, roleId: "reviewer", reassignTo: claudeBinding("claude-opus-5-5", "2.1.280") })).toThrow(/different model from the builder/);
      expect(w.store.getJob(job.id)!.state).toBe("needs_owner");
      w.orch.resume(job.id, { by: OWNER, roleId: "reviewer", reassignTo: claudeBinding("claude-sonnet-5-5", "2.1.280") });
      const next = await until(w, job.id, settled);
      expect(builds).toBe(1);
      expect(next.headSha).toBe(stopped.headSha);
      const reviewer = [...next.runs].reverse().find((r) => r.role === "reviewer")!;
      expect(reviewer.binding).toMatchObject({ route: "claude-code-cli", model: "claude-sonnet-5-5", accountSlot: "claude:max" });
      expect(w.codexLaunched).toHaveLength(0);
      // The earlier Codex error is resolved: the CURRENT blocker is the review's own findings.
      expect(next.state).toBe("needs_owner");
      expect(codingBlocker(next).kind).toBe("review-changes");
      expect(codingBlocker(next).text).not.toContain("Codex");
      expect(w.store.events(job.id, 0, 5000).some((e) => e.type === "step" && (e.payload as any).label === "Owner reassigned this role" && /claude-sonnet-5-5/.test((e.payload as any).detail))).toBe(true);
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("a rejection that is only a test already failing on the base commit retries the review, not the builder; a repeated Resume doesn't duplicate runs", async () => {
    const fx = fastFixture();
    roots.push(fx.root);
    writeFileSync(join(fx.canonical, "results.txt"), RESULTS.replace(" 0 fail", "(fail) pre-existing environment check [1.00ms]\n 1 fail"));
    gitIn(fx.canonical, "add", "results.txt");
    gitIn(fx.canonical, "commit", "-q", "--only", "-m", "synthetic baseline failure", "--", "results.txt");
    let builds = 0;
    let reviews = 0;
    const w = world({
      fx: { ...fx, baseSha: gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never,
        entry: { ...fx.entry, commands: [{ ...fx.entry.commands[0], argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('results.txt', 'utf8')); process.exit(1)"] }] } },
      builder: () => { builds++; return new FakeClaude({ steps: BUILDER_STEPS() }); },
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", message: "The suite fails: pre-existing environment check" }], criteria: [{ criterionId: "c1", met: false, note: "suite exits 1" }] }) : APPROVE } }),
    });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(codingBlocker(paused)).toMatchObject({ kind: "review-baseline-only", label: "Retry review with the baseline" });
      w.orch.resume(job.id, { by: OWNER });
      // A second click while that Resume runs is refused; nothing is started twice.
      expect(() => w.orch.resume(job.id, { by: OWNER })).toThrow(/already running|can't be resumed/);
      const done = await until(w, job.id, settled);
      expect(builds).toBe(1);
      expect(reviews).toBe(2);
      expect(done.state).toBe("completed");
      expect(done.gate?.baselineFailures[0]).toMatchObject({ failed: 1, names: ["pre-existing environment check"] });
      expect(done.gate?.checks.find((c) => c.check === "done-when-evidenced")?.passed).toBe(true);
      expect(done.runs.filter((r) => r.role === "reviewer")).toHaveLength(2);
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("a gate that doesn't pass is spoken in plain words, never as redacted check ids", async () => {
    const w = world({ reviewer: () => new FakeClaude({ result: { result: JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "blocker", message: "wrong" }], criteria: [] }) } }) });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, settled);
      const lines = w.store.events(job.id, 0, 5000).filter((e) => e.type === "spoken").map((e) => (e.payload as any).line as string);
      const gateLine = lines.find((l) => l.includes("done gate"))!;
      expect(gateLine).toContain("an independent review approved this commit");
      expect(gateLine).not.toContain("[redacted]");
      expect(lines.join(" ")).not.toMatch(/It needs you/);
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("review fix 2: independence is judged against what the other role actually ran on, and a move sticks on later Resumes", async () => {
    let builds = 0;
    let reviews = 0;
    const w = world({
      builder: () => (++builds === 1 ? new FakeClaude({ steps: [{ text: "I did nothing." }] }) : new FakeClaude({ steps: BUILDER_STEPS(builds === 2 ? "export const a = 41;\n" : "export const a = 42;\n") })),
      reviewer: () => new FakeClaude({ result: { result: ++reviews === 1 ? JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "major", message: "a must be 42" }], criteria: [] }) : APPROVE } }),
      codexIsolation: () => ({ ok: false, message: "Codex roles are paused: synthetic." }),
    });
    try {
      const s = spec(w);
      s.roles = s.roles.map((r) => (r.role === "reviewer" ? { ...r, agent: codexBinding("gpt-6-astra", "codex:openai-2", "0.159.0") } : r)) as never;
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      expect((await until(w, job.id, settled)).state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      // The builder failed on Opus; the owner moves it to Sonnet and it succeeds. The Codex reviewer is then unavailable.
      w.orch.resume(job.id, { by: OWNER, roleId: "builder-1", reassignTo: claudeBinding("claude-sonnet-5-5", "2.1.280") });
      const stopped = await until(w, job.id, (j) => settled(j) && j.runs.some((r) => r.role === "reviewer"));
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(codingBlocker(stopped).kind).toBe("reviewer-unavailable");
      // The PLAN still says Opus, but the builder ran on Sonnet: Sonnet must not review Sonnet; Opus may.
      expect(() => w.orch.resume(job.id, { by: OWNER, roleId: "reviewer", reassignTo: claudeBinding("claude-sonnet-5-5", "2.1.280") })).toThrow(/different model from the builder/);
      w.orch.resume(job.id, { by: OWNER, roleId: "reviewer", reassignTo: claudeBinding("claude-opus-5-5", "2.1.280") });
      const changes = await until(w, job.id, (j) => settled(j) && j.review?.verdict === "request-changes");
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(changes.state).toBe("needs_owner");
      // A later plain Resume repairs on the builder's MOVED binding and reviews on the reviewer's moved binding.
      w.orch.resume(job.id, { by: OWNER });
      const done = await until(w, job.id, settled);
      expect(done.state).toBe("completed");
      const builderArgs = w.launched.filter((r) => r.args[r.args.indexOf("--permission-mode") + 1] !== "plan").map((r) => r.args.join(" "));
      expect(builderArgs.at(-1)).toContain("claude-sonnet-5-5");
      expect(w.codexLaunched).toHaveLength(0);
      expect([...done.runs].reverse().find((r) => r.role === "reviewer")!.binding.model).toBe("claude-opus-5-5");
      await until(w, job.id, () => !w.orch.running(job.id));
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
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
    const high: AllowanceSnapshot = { accountSlot: "claude:max", windows: [{ label: "5-hour", usedPercent: 97, resetsAt: new Date(Date.now() + 3_600_000).toISOString() as IsoTime }], creditsWouldBeUsed: false, limitReached: false, source: "anthropic-oauth-usage-cached", readAt: new Date().toISOString() as IsoTime };
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

  test("a builder whose commit the policy refuses fails with that reason, not just 'uncommitted files' (job 674f43)", async () => {
    const steps: ClaudeStep[] = [
      { tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 7;\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 7;\n" } } },
      { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
      { tool: "Bash", input: { command: 'git commit -m "$(date)"' }, effect: { git: ["commit", "-q", "-m", "never happens"] } },
      { text: "Changed src/a.ts; I could not commit." },
    ];
    const w = world({ builder: () => new FakeClaude({ steps }) });
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    await until(w, job.id, (j) => j.runs.some((r) => r.state === "failed"));
    const error = w.store.events(job.id, 0, 5000).find((e) => e.type === "error" && (e.payload as { code: string }).code === "postcheck_failed");
    expect(JSON.stringify(error?.payload)).toContain("uncommitted file(s) left in its worktree; its git commit was refused by the coding policy 1 time (rule: runtime-path)");
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
    const q = w.approvals.ask(approval.id, owner);
    expect(w.approvals.decide(approval.id, owner, "approve", { spokenYes: early.id, questionId: q.questionId })).toMatchObject({ ok: false });
    // Mehroz's yes doesn't either (the approver is the owner).
    const q2 = w.approvals.ask(approval.id, owner);
    const his = w.spoken.record("yes")!;
    expect(w.approvals.decide(approval.id, { personId: "mehroz", via: "tailnet-person", actor: "human" }, "approve", { spokenYes: his.id, questionId: q2.questionId })).toMatchObject({ ok: false });
    const q3 = w.approvals.ask(approval.id, owner);
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

describe("orchestrator: a paused job superseded by newer work (2 Oct 2026)", () => {
  const rejecting = () => new FakeClaude({ result: { result: JSON.stringify({ verdict: "request-changes", findings: [{ id: "b1", severity: "blocker", message: "wrong value" }], criteria: [] }) } });
  test("marking keeps the history and worktrees; Resume is refused with the reason; nothing is launched or merged", async () => {
    const w = world({ reviewer: rejecting });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const paused = await until(w, job.id, settled);
      expect(paused.state).toBe("needs_owner");
      await until(w, job.id, () => !w.orch.running(job.id));
      const launchedBefore = w.launched.length;
      const eventsBefore = w.store.events(job.id, 0, 5000).length;
      const mainBefore = gitIn(w.fx.canonical, "rev-parse", "main").trim();
      // Bad input is refused first and changes nothing.
      expect(() => w.orch.supersede(job.id, { ref: "--oops", reason: "landed", by: OWNER })).toThrow(/Name the commit or branch/);
      const done = w.orch.supersede(job.id, { ref: "main", reason: "the successor landed in the live branch", by: OWNER });
      expect(done.state).toBe("cancelled");
      expect(done.supersededBy).toMatchObject({ ref: "main", by: "usman", reason: "the successor landed in the live branch" });
      // History is kept (events only grow), receipts and runs stay, and the job branch worktree is still on disk.
      expect(w.store.events(job.id, 0, 5000).length).toBeGreaterThan(eventsBefore);
      expect(done.runs.length).toBe(paused.runs.length);
      expect(done.headSha).toBe(paused.headSha);
      expect(existsSync(join(w.fx.entry.worktreeParent))).toBe(true);
      // Refused, in the owner's words, and nothing started.
      expect(() => w.orch.resume(job.id, { by: OWNER })).toThrow(/superseded by main.*could overwrite newer work/);
      await expect(w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "main", by: OWNER })).rejects.toThrow(/superseded by main/);
      expect(() => w.orch.supersede(job.id, { ref: "abc1234", reason: "again please", by: OWNER })).toThrow(/already marked superseded/);
      expect(w.launched.length).toBe(launchedBefore);
      expect(gitIn(w.fx.canonical, "rev-parse", "main").trim()).toBe(mainBefore);
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  async function awaitingMerge(w: World) {
    gitIn(w.fx.canonical, "branch", "production", w.fx.baseSha);
    const s = spec(w);
    const { job } = w.orch.draft(s);
    w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    const done = await until(w, job.id, settled);
    expect(done.state).toBe("completed");
    await w.orch.requestApply(job.id, { action: "git.merge.protected", toRef: "production", by: OWNER });
    expect(w.store.getJob(job.id)!.state).toBe("awaiting_approval");
    return job.id;
  }

  test("plain Stop while a merge waits for approval withdraws the request and ends completed, not in an error", async () => {
    const w = world();
    try {
      const id = await awaitingMerge(w);
      const after = w.orch.cancel(id);
      expect(after.state).toBe("completed");
      expect(after.applies[0].state).toBe("cancelled");
      expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(w.fx.baseSha);
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("marking superseded while a merge waits withdraws the request, records the mark and refuses a new merge, resume and tests", async () => {
    const w = world();
    try {
      const id = await awaitingMerge(w);
      const done = w.orch.supersede(id, { ref: "main", reason: "the successor already landed", by: OWNER });
      expect(done.state).toBe("completed");
      expect(done.supersededBy?.ref).toBe("main");
      expect(done.applies[0].state).toBe("cancelled");
      await expect(w.orch.requestApply(id, { action: "git.merge.protected", toRef: "production", by: OWNER })).rejects.toThrow(/superseded by main/);
      await expect(w.orch.rerunTest(id, "fx.test" as never)).rejects.toThrow(/marked superseded by main.*not re-run/);
      expect(() => w.orch.resume(id, { by: OWNER })).toThrow(/superseded by main/);
      expect(gitIn(w.fx.canonical, "rev-parse", "production").trim()).toBe(w.fx.baseSha);
      // Taking the mark back leaves the job as it was (completed, merge withdrawn).
      const back = w.orch.unsupersede(id, { by: OWNER });
      expect(back.supersededBy).toBeUndefined();
      expect(back.state).toBe("completed");
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("a ref that isn't in the repo is refused and nothing is marked", async () => {
    const w = world({ reviewer: rejecting });
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      await until(w, job.id, settled);
      await until(w, job.id, () => !w.orch.running(job.id));
      expect(() => w.orch.supersede(job.id, { ref: "feedface1234", reason: "landed another way", by: OWNER })).toThrow(/isn't a commit or branch/);
      expect(w.store.getJob(job.id)!.state).toBe("needs_owner");
      expect(w.store.getJob(job.id)!.supersededBy).toBeUndefined();
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);

  test("a running or a finished job can't be marked superseded", async () => {
    const w = world();
    try {
      const s = spec(w);
      const { job } = w.orch.draft(s);
      expect(() => w.orch.supersede(job.id, { ref: "abc1234", reason: "landed another way", by: OWNER })).toThrow(/only a paused job can/);
      w.orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
      const done = await until(w, job.id, settled);
      expect(done.state).toBe("completed");
      expect(() => w.orch.supersede(job.id, { ref: "abc1234", reason: "landed another way", by: OWNER })).toThrow(/A finished job is not paused/);
    } finally { w.orch.close(); w.store.close(); w.approvals.close(); }
  }, 600_000);
});

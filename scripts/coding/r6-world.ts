// TEST ONLY (round 6): the synthetic world the reliability tests share with orchestrator.test.ts's own copy.
import { afterAll } from "bun:test";
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

export const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });

/**
 * The fixture repo with a FAST registry check: a native `findstr` (grep elsewhere) printing a committed
 * results file in bun's output format, so a loaded machine isn't spawning bun for every test run.
 */
export const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
export function fastFixture(): FixtureRepo {
  const fx = fixtureRepo();
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const baseSha = gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never;
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  return { ...fx, baseSha, entry: { ...fx.entry, commands: [{ id: "fx.test" as never, kind: "test", argv, cwd: ".", timeoutMs: 60_000, counts: "bun" }] } };
}

export const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };
export const SESSION = /--session-id|--resume/;

export type World = {
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

export const BUILDER_STEPS = (content = "export const a = 42;\n"): ClaudeStep[] => [
  { tool: "Read", input: { file_path: "src/a.ts" } },
  { tool: "Edit", input: { file_path: "lib/c.ts", old_string: "3", new_string: "4" }, effect: { write: { path: "lib/c.ts", content: "SHOULD NOT HAPPEN\n" } } },
  { tool: "Write", input: { file_path: "src/a.ts", content }, effect: { write: { path: "src/a.ts", content } } },
  { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
  { tool: "Bash", input: { command: 'git commit -m "builder: set a to 42"' }, effect: { git: ["commit", "-q", "-m", "builder: set a to 42"] } },
  { text: "Set a to 42 in src/a.ts and committed. lib/c.ts should also change (outside my files)." },
];
export const APPROVE = JSON.stringify({ verdict: "approve", findings: [{ id: "f1", severity: "minor", file: "src/a.ts", line: 1, message: "consider a comment" }], criteria: [{ criterionId: "c2", met: true, note: "a is 42" }] });

export function world(options: { builder?: (cwd: string, args: string[]) => FakeClaude; reviewer?: () => FakeClaude; codex?: () => FakeCodex; claudeAllowance?: () => AllowanceSnapshot | null; liveRoot?: string | null; memoryWrites?: boolean; memorySave?: MemorySaver; store?: CodingStore; fx?: FixtureRepo; dataDir?: string; approvals?: ApprovalService; spoken?: SpokenConfirmationLedger; codexIsolation?: OrchestratorDeps["codexIsolation"]; isolationRecheckMs?: number; contextHelper?: OrchestratorDeps["contextHelper"]; inputTimeoutMs?: number } = {}): World {
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
    inputTimeoutMs: options.inputTimeoutMs ?? 120_000,
    codexIsolation: options.codexIsolation ?? (() => ({ ok: true, message: "" })),
    isolationRecheckMs: options.isolationRecheckMs,
    ...(options.contextHelper ? { contextHelper: options.contextHelper } : {}),
  });
  orch.attachApprovals();
  return { fx, store, orch, approvals, spoken, sink, saved, launched, codexLaunched, registry, dataDir };
}

export function spec(w: World, over: { builderBinding?: ReturnType<typeof claudeBinding>; objective?: string } = {}) {
  return draftSpec({
    requestedBy: OWNER, channel: "voice", utterance: "Set a to 42. Opus builds, another Opus reviews.", entry: w.fx.entry,
    objective: over.objective ?? "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }],
    roleTemplate: "build+review",
    builders: [{ binding: over.builderBinding ?? claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }],
    reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280") },
    checks: ["fx.test" as never], dataClass: "synthetic",
  });
}

export async function until(w: World, id: string, pred: (j: CodingJob) => boolean, ms = 400_000) {
  const start = Date.now();
  for (;;) {
    const j = w.store.getJob(id)!;
    if (pred(j)) return j;
    if (Date.now() - start > ms) throw new Error(`timed out; job is ${j.state}: ${JSON.stringify(w.store.events(id).filter((e) => e.type === "error" || e.type === "state").map((e) => e.payload)).slice(0, 1500)}`);
    await Bun.sleep(25);
  }
}
export const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));


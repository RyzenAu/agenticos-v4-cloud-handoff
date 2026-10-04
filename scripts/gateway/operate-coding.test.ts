import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import type { Principal as ApprovalPrincipal } from "../approvals/principal";
import { DEFAULT_ACCOUNTS } from "../coding/accounts";
import type { CodingJob, RepoRegistry, VerifiedPrincipal } from "../coding/contracts";
import { createOrchestrator, OrchestratorError, verifiedFromApprovalPrincipal } from "../coding/orchestrator";
import { codingRoute, type CodingRuntime } from "../coding/routes";
import { claudeRunner } from "../coding/runners/claude";
import { codexRunner } from "../coding/runners/codex";
import { FakeClaude, FakeCodex, type ClaudeStep } from "../coding/runners/fakes";
import { routerRunner } from "../coding/runners/router";
import { createShaper } from "../coding/shaper";
import { claudeBinding, draftSpec, specDigest } from "../coding/spec";
import { CodingStore } from "../coding/store";
import { cleanup, fixtureRepo, gitIn, type FixtureRepo } from "../coding/test-fixtures";
import { canonicalSnapshot, sameSnapshot } from "../coding/worktree";
import { pageTokenFor, type Principal } from "../identity/principal";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { createGatewayRoutes } from "./hub-plugin";

/**
 * Coding jobs as Dot: draft, start its OWN draft, read the diff, tests and review, rerun tests, stop. The REAL orchestrator,
 * store, approvals service and route code, on a temp git repository, with fake Claude and Codex processes (no real CLI,
 * account or network), exactly as scripts/coding/orchestrator.test.ts runs them. The hub's sign-ins never leave the hub:
 * what Dot reads back names an account slot and a model, never a token, a config folder or a path.
 */

setDefaultTimeout(600_000);

const TOKEN = "operate-coding-internal-token";
const SID = "ab".repeat(12);
const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
const BUILDER_STEPS = (content = "export const a = 42;\n"): ClaudeStep[] => [
  { tool: "Read", input: { file_path: "src/a.ts" } },
  { tool: "Write", input: { file_path: "src/a.ts", content }, effect: { write: { path: "src/a.ts", content } } },
  { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
  { tool: "Bash", input: { command: 'git commit -m "builder: set a to 42"' }, effect: { git: ["commit", "-q", "-m", "builder: set a to 42"] } },
  { text: "Set a to 42 in src/a.ts and committed." },
];
const APPROVE = JSON.stringify({ verdict: "approve", findings: [], criteria: [{ criterionId: "c2", met: true, note: "a is 42" }] });

let fx: FixtureRepo;
let store: CodingStore;
let approvals: ApprovalService;
let orch: ReturnType<typeof createOrchestrator>;
let rt: CodingRuntime;
let registry: RepoRegistry;
let server: Server;
let base = "";
const launched: FakeClaude[] = [];
const tmp = mkdtempSync(join(tmpdir(), "gw-operate-coding-"));

const dotPrincipal = (caps: string[]): Principal => ({ personId: "dot" as never, via: "gateway", actor: "process", sessionId: `gw:${SID}`, displayName: "Dot", capabilities: ["view", ...caps], delegatedBy: "usman" });
const principalOf = (req: IncomingMessage): Principal | null => {
  const who = String(req.headers["x-test-who"] ?? "");
  if (who === "usman") return { personId: "usman", via: "paired-session", actor: "human", sessionId: "sk-usman-test-session", displayName: "Usman" };
  return who.startsWith("dot:") ? dotPrincipal(who.slice(4).split(",").filter(Boolean)) : null;
};
async function call(caps: string[] | "usman", method: string, path: string, body?: unknown) {
  const label = caps === "usman" ? "usman" : `dot:${caps.join(",")}`;
  const headers: Record<string, string> = { "x-test-who": label };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-claude-os-token"] = pageTokenFor(principalOf({ headers } as unknown as IncomingMessage)!, TOKEN);
  }
  const res = await fetch(`${base}/__gateway${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || "{}") as any };
}
/** A draft in the store, as the shaper would leave it, requested by this person. */
function draftFor(requestedBy: VerifiedPrincipal) {
  const spec = draftSpec({
    requestedBy, channel: "typed", utterance: "Set a to 42 in the fixture. Opus builds, another Opus reviews.", entry: fx.entry,
    objective: "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "alpha passes", evidence: "test", ref: "alpha" }, { id: "c2", text: "a is 42", evidence: "reviewer-confirms" }],
    roleTemplate: "build+review", builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }], reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280") },
    checks: ["fx.test" as never], dataClass: "synthetic",
  });
  return { spec, job: orch.draft(spec).job };
}
const DOT = () => verifiedFromApprovalPrincipal(dotPrincipal([]) as unknown as ApprovalPrincipal);
const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };
const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));
async function until(id: string, pred: (j: CodingJob) => boolean, ms = 400_000) {
  const start = Date.now();
  for (;;) {
    const j = store.getJob(id)!;
    if (pred(j)) return j;
    if (Date.now() - start > ms) throw new Error(`timed out; job is ${j.state}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  const plain = fixtureRepo();
  writeFileSync(join(plain.canonical, "results.txt"), RESULTS);
  gitIn(plain.canonical, "add", "results.txt");
  gitIn(plain.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  // The owner's registry entry: "dot" is listed (without that, a draft is refused; see the last test).
  fx = { ...plain, baseSha: gitIn(plain.canonical, "rev-parse", "HEAD").trim() as never, entry: { ...plain.entry, allowedPeople: ["usman", "mehroz", "dot"] as never, commands: [{ id: "fx.test" as never, kind: "test", argv, cwd: ".", timeoutMs: 60_000, counts: "bun" }] } };
  registry = { version: 1, repos: [fx.entry] };
  store = CodingStore.open(join(fx.root, "coding-data"));
  approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
  const claudeSpawn = ((binary: string, args: string[], opts: any) => {
    const readOnly = args[args.indexOf("--permission-mode") + 1] === "plan";
    const fake = readOnly ? new FakeClaude({ result: { result: APPROVE } }) : new FakeClaude({ steps: BUILDER_STEPS() });
    fake.args = args;
    fake.options = { ...opts, binary };
    launched.push(fake);
    return fake;
  }) as any;
  const codexSpawn = ((binary: string, args: string[], opts: any) => Object.assign(new FakeCodex(), { args, options: { ...opts, binary } })) as any;
  orch = createOrchestrator({
    store,
    registry: () => registry,
    accounts: () => DEFAULT_ACCOUNTS,
    runners: {
      claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
      codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: codexSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
      router: routerRunner({ chat: async () => { throw new Error("no router in this test"); } }),
    },
    approvals: () => approvals,
    liveRoot: null,
    memory: { writes: () => false, save: async () => ({ ok: true, fact: { wiki_ref: "mf-test", source: { link: "obsidian://test" } } }) },
    fleetSink: new MemoryReceiptSink(),
    claudeAllowance: () => null,
    inputTimeoutMs: 120_000,
    codexIsolation: () => ({ ok: true, message: "" }),
  });
  orch.attachApprovals();
  const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
  rt = { store, orch, shaper, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null };
  mkdirSync(join(tmp, "data", "gateway"), { recursive: true });
  const handle = createGatewayRoutes({
    root: tmp,
    internalToken: () => TOKEN,
    dir: join(tmp, "data", "gateway"),
    principal: principalOf,
    operate: {
      env: () => ({ MU_DATA_DIR: join(tmp, "data") }),
      readOnly: () => false,
      coding: async () => ({ rt: rt as never, route: codingRoute as never, verified: (p: ApprovalPrincipal) => verifiedFromApprovalPrincipal(p), isRefusal: (e: unknown): e is { message: string; status: number } => e instanceof OrchestratorError }),
    },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try {
    orch?.close();
    store?.close();
    approvals?.close();
  } catch {
    /* a run may still be settling */
  }
  if (fx) cleanup(fx.root);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

describe("coding jobs through the gateway", () => {
  test("Dot starts its own draft; the job builds, tests, is reviewed and passes its gate; the checkout is untouched", async () => {
    const before = canonicalSnapshot(fx.canonical);
    const { spec, job } = draftFor(DOT());
    expect(job.spec.requestedBy.personId as string).toBe("dot");
    expect(job.state).toBe("awaiting_confirmation");
    // Without coding.start: nothing.
    expect((await call(["crm.write", "tasks.run"], "POST", `/coding/jobs/${job.id}/start`, { specDigest: specDigest(spec) })).status).toBe(403);
    // The plan that starts must be the plan that was read: a wrong digest starts nothing.
    const wrong = await call(["coding.start"], "POST", `/coding/jobs/${job.id}/start`, { specDigest: "sha256:not-the-digest" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    expect(launched.length).toBe(0);
    const started = await call(["coding.start"], "POST", `/coding/jobs/${job.id}/start`, { specDigest: specDigest(spec) });
    expect(started.status).toBe(202);
    const done = await until(job.id, settled);
    expect(done.state).toBe("completed");
    expect(done.gate?.passed).toBe(true);
    // Confirmed by Dot, typed: recorded on the job, never as a founder.
    expect((done.spec as unknown as { confirmation?: { by?: { personId?: string }; via?: string } }).confirmation).toMatchObject({ by: { personId: "dot" }, via: "typed" });
    expect(sameSnapshot(before, canonicalSnapshot(fx.canonical))).toBe(true);
    // What Dot reads back (the founders' read route, which `view` opens): the diff, the tests, the review. And no credential of any kind.
    const view = (await codingRoute({ method: "GET", path: `/coding/jobs/${job.id}`, url: new URL(`http://x/coding/jobs/${job.id}`), body: {}, principal: dotPrincipal([]) as never }, rt)) as { status: number; body: any };
    expect(view.status).toBe(200);
    const text = JSON.stringify(view.body);
    expect(text).toContain("src/a.ts");
    expect(view.body.job.tests ?? view.body.readable).toBeTruthy();
    for (const never of ["CLAUDE_CONFIG_DIR", "configDir", "codexHome", "sk-ant-", "access_token", "refresh_token", "Bearer ", ".credentials", "C:/fake/claude.exe"]) expect([never, text.includes(never)]).toEqual([never, false]);
    // The run used the hub's own (fake) CLI with the job's pinned model; Dot supplied no account.
    expect(launched.length).toBeGreaterThanOrEqual(2);
    expect(done.runs.every((r) => /^claude:/.test(String(r.binding.accountSlot)))).toBe(true);
    // Rerun a registered check on its own finished job.
    const rerun = await call(["coding.start"], "POST", `/coding/jobs/${job.id}/tests/rerun`, { commandId: "fx.test" });
    expect(rerun.status).toBe(200);
    expect((await call(["coding.start"], "POST", `/coding/jobs/${job.id}/tests/rerun`, { commandId: "rm -rf" })).status).toBeGreaterThanOrEqual(400);
    // Resume on a finished job is the orchestrator's own refusal, passed through.
    expect((await call(["coding.start"], "POST", `/coding/jobs/${job.id}/resume`, {})).status).toBeGreaterThanOrEqual(400);
  });

  test("merging stays the owner's: there is no merge route, and nothing Dot did filed or decided an approval", async () => {
    const mine = store.listJobs({}).find((j) => (j.spec.requestedBy.personId as string) === "dot" && j.state === "completed")!;
    for (const path of [`/coding/jobs/${mine.id}/apply`, `/coding/jobs/${mine.id}/supersede`, `/coding/jobs/${mine.id}/account`, `/coding/jobs/${mine.id}/plan`, `/coding/jobs/${mine.id}/input`, "/coding/jobs", "/coding/accounts"])
      expect([path, (await call(["coding.start"], "POST", path, { action: "git.merge.protected", toRef: "main" })).status]).toEqual([path, 404]);
    expect(approvals.list({ limit: 20 }).length).toBe(0);
    expect(store.getJob(mine.id)!.applies ?? []).toEqual([]);
    // The canonical branch did not move.
    expect(gitIn(fx.canonical, "rev-parse", "HEAD").trim()).toBe(fx.baseSha as unknown as string);
  });

  test("a founder's coding job is not Dot's to start, resume, rerun or stop", async () => {
    const { spec, job } = draftFor(OWNER);
    for (const [action, body] of [["start", { specDigest: specDigest(spec) }], ["resume", {}], ["tests/rerun", { commandId: "fx.test" }], ["cancel", {}]] as const)
      expect([action, (await call(["coding.start"], "POST", `/coding/jobs/${job.id}/${action}`, body)).status]).toEqual([action, 404]);
    expect(store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    // And a founder does not drive Dot's routes either.
    expect((await call("usman", "POST", `/coding/jobs/${job.id}/start`, { specDigest: specDigest(spec) })).status).toBe(403);
    orch.cancel(job.id);
  });

  test("Dot stops its own job", async () => {
    const { job } = draftFor(DOT());
    const stopped = await call(["coding.start"], "POST", `/coding/jobs/${job.id}/cancel`, {});
    expect(stopped.status).toBe(200);
    expect(store.getJob(job.id)!.state).toBe("cancelled");
  });

  test("drafting goes through the founders' own drafting step, as a program; a repository that does not list dot refuses", async () => {
    const drafted = await call(["coding.start"], "POST", "/coding/draft", { utterance: "In the fixture repo, set a to 42 in src/a.ts.", requestId: crypto.randomUUID() });
    expect(drafted.status).toBe(200);
    expect(["draft", "ask", "refused"]).toContain(drafted.json.kind);
    if (drafted.json.kind === "draft") {
      expect(store.getJob(drafted.json.jobId)!.spec.requestedBy.personId as string).toBe("dot");
      expect(store.getJob(drafted.json.jobId)!.state).toBe("awaiting_confirmation"); // a draft runs nothing
      orch.cancel(drafted.json.jobId);
    }
    // The owner has not listed "dot" for any repository: drafting is refused, and the matrix says it is the owner's to do.
    registry = { version: 1, repos: [{ ...fx.entry, allowedPeople: ["usman", "mehroz"] as never }] };
    try {
      const refused = await call(["coding.start"], "POST", "/coding/draft", { utterance: "In the fixture repo, set a to 43 in src/a.ts.", requestId: crypto.randomUUID() });
      expect(refused.json.kind).toBe("refused");
      const matrix = await call(["coding.start"], "GET", "/capabilities");
      expect(matrix.json.rows.find((r: { capability: string }) => r.capability === "coding.start")).toMatchObject({ state: "owner-action", granted: true });
    } finally {
      registry = { version: 1, repos: [fx.entry] };
    }
    const matrix = await call(["coding.start"], "GET", "/capabilities");
    expect(matrix.json.rows.find((r: { capability: string }) => r.capability === "coding.start")).toMatchObject({ state: "working" });
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_ACCOUNTS, validateAccounts } from "./accounts";
import type { AgentBinding, CodingJob, RepoRegistry, VerifiedPrincipal } from "./contracts";
import { GUIDANCE_DIR, GUIDANCE_FILE, MAX_GUIDANCE_CHARS, guidanceRoleFor, loadGuidance, withGuidance } from "./guidance";
import { createOrchestrator } from "./orchestrator";
import { buildReceipt } from "./receipts";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude, FakeCodex, fakeSpawn } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import type { PolicyFn, RoleRunner, RunnerEvent, RunnerOutcome, RunnerStart } from "./runners/types";
import { claudeBinding, codexBinding, draftSpec, routerBinding, specDigest } from "./spec";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo, gitIn, tempRoot } from "./test-fixtures";

/**
 * Engineering guidance (guidance.ts): the pinned files, delivery on every route, the honest "not supported"
 * report, and a real orchestrated job on two Claude accounts where each role's receipt names the files it got.
 * SYNTHETIC: fake CLIs speaking the real protocols; no account, network or credential.
 */

const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });
const scratch = tempRoot("coding-guidance-");
roots.push(scratch);

describe("the guidance files", () => {
  const manifest = JSON.parse(readFileSync(join(GUIDANCE_DIR, "manifest.json"), "utf8"));
  test("one file per role, pinned by manifest.json: version, upstream commit and sha256 all present and current", () => {
    expect(readdirSync(GUIDANCE_DIR).sort()).toEqual(["builder.md", "manifest.json", "planner.md", "reviewer.md"]);
    expect(manifest.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(manifest.upstream).toMatchObject({ repo: "https://github.com/mattpocock/skills", commit: "d81f3a183412e71a5b1e84ca21bc1a35eea03a60", licence: "MIT" });
    for (const file of Object.values(GUIDANCE_FILE)) expect(manifest.files[file]).toBe(sha(readFileSync(join(GUIDANCE_DIR, file), "utf8")));
  });
  test("each is bounded, says the job brief wins, and is loaded without being flagged as edited", () => {
    for (const role of ["builder", "reviewer", "planner"] as const) {
      const { text, use } = loadGuidance(role);
      expect(use).toMatchObject({ role, supplied: true, version: manifest.version, path: `scripts/coding/guidance/${role}.md` });
      expect(use.unpinned).toBeUndefined();
      expect(use.sha256).toBe(manifest.files[`${role}.md`]);
      expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARS);
      expect(text).toMatch(/always win over this page/);
    }
  });
  test("the bug-fix, review and planning workflow is in the right file", () => {
    const b = loadGuidance("builder").text;
    for (const w of [/symptom the owner actually described/, /Isolate the cause/, /smallest sufficient fix/, /original journey/, /regression test/, /Unresolved work stays visible/]) expect(b).toMatch(w);
    const r = loadGuidance("reviewer").text;
    for (const w of [/Requested behaviour/, /Fit with the repository/, /\[behaviour\]/, /\[fit\]/]) expect(r).toMatch(w);
    const p = loadGuidance("planner").text;
    for (const w of [/dependency/, /complete, usable increments/, /unresolved work is visible/]) expect(p).toMatch(w);
  });
  test("role kinds: test-author shares the builder file; the tester (no model) has none", () => {
    expect(guidanceRoleFor("builder")).toBe("builder");
    expect(guidanceRoleFor("test-author")).toBe("builder");
    expect(guidanceRoleFor("reviewer")).toBe("reviewer");
    expect(guidanceRoleFor("planner")).toBe("planner");
    expect(guidanceRoleFor("tester")).toBeNull();
  });
  test("a missing, oversized, credential-shaped or edited-but-unpinned file is refused or flagged, never trimmed", () => {
    const dir = join(scratch, "g");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "t.1", files: { "builder.md": "0".repeat(64) } }));
    expect(loadGuidance("builder", dir)).toMatchObject({ text: "", use: { supplied: false, reason: "guidance file is missing", sha256: null } });
    writeFileSync(join(dir, "builder.md"), "x".repeat(MAX_GUIDANCE_CHARS + 1));
    expect(loadGuidance("builder", dir).use).toMatchObject({ supplied: false, reason: expect.stringContaining("over 6000") });
    writeFileSync(join(dir, "builder.md"), "Use this key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n");
    expect(loadGuidance("builder", dir).use).toMatchObject({ supplied: false, reason: expect.stringContaining("credential") });
    writeFileSync(join(dir, "builder.md"), "Be careful.\r\n");
    expect(loadGuidance("builder", dir)).toMatchObject({ text: "Be careful.", use: { supplied: true, unpinned: true, sha256: sha("Be careful.") } });
  });
});

// ───────────────────────── delivery on every route ─────────────────────────

const allowAll: PolicyFn = () => ({ decision: "auto-allow", rule: "read-in-worktree", target: "x", message: "ok" });
const cwd = join(scratch, "wt");
mkdirSync(cwd, { recursive: true });
const SESSION = "11111111-2222-4333-8444-555555555555";
const claudeStart = (role: RunnerStart["role"], slot: "claude:max" | "claude:max-2", events: RunnerEvent[]): RunnerStart => ({
  jobId: "j", roleId: role === "reviewer" ? "reviewer" : "builder-1", role, binding: claudeBinding("claude-sonnet-5-5", "2.1.280", slot), cwd, prompt: "Do the job.", system: "ROLE RULES: stay in your worktree.",
  readOnly: role !== "builder", session: { mode: "new", id: SESSION }, policy: allowAll, signal: new AbortController().signal, onEvent: (e) => events.push(e),
  limits: { wallMs: 5000, maxTurns: 40, inputTimeoutMs: 400 }, stopAtWindowPercent: 95, creditsAllowed: false,
  claudeConfigDir: slot === "claude:max" ? null : join(scratch, "profile-2"),
});

describe("delivery by runner", () => {
  test("Claude CLI (both accounts): the role's file is appended to the system file; the outcome and the receipt name it", async () => {
    for (const slot of ["claude:max", "claude:max-2"] as const) {
      for (const role of ["builder", "reviewer"] as const) {
        const fake = new FakeClaude({});
        let systemText = "";
        const spawn = ((binary: string, args: string[], o: any) => {
          systemText = readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8");
          fake.args = args; fake.options = { ...o, binary };
          return fake;
        }) as any;
        const events: RunnerEvent[] = [];
        const runner = withGuidance(claudeRunner({ binary: "C:/fake/claude.exe", spawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }));
        const outcome = await runner.start(claudeStart(role, slot, events)).done;
        const want = loadGuidance(role);
        expect(systemText.startsWith("ROLE RULES: stay in your worktree.")).toBe(true);
        expect(systemText).toContain(want.text);
        expect(systemText).toContain("always take precedence over it");
        expect(outcome.guidance).toEqual([want.use]);
        expect(events.some((e) => e.type === "step" && /Engineering guidance: scripts\/coding\/guidance\/.+\.md \(sha [0-9a-f]{12}\)/.test(e.label))).toBe(true);
        const receipt = buildReceipt({ requestId: "r" as never, parentRequestId: null, jobId: "j" as never, roleId: "builder-1" as never, role, turn: 1, person: "usman" as never, binding: claudeBinding("claude-sonnet-5-5", "2.1.280", slot), dataClass: "synthetic", outcome, allowanceStart: null, queueMs: 0 });
        expect(receipt.guidance).toEqual([want.use]);
        expect(receipt.guidance?.[0].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.contextSources).toContainEqual({ kind: "engineering-guidance", name: want.use.path, chars: want.use.chars, sha256: want.use.sha256!.slice(0, 12) });
        expect(receipt.account).toBe(slot);
      }
    }
  });
  test("Codex app-server: the role's file goes into the thread's developer instructions", async () => {
    const proc = new FakeCodex({});
    const { spawn } = fakeSpawn(proc);
    const binding = codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0");
    const runner = withGuidance(codexRunner({ binary: "C:/fake/codex.exe", spawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 50, rpcTimeoutMs: 2000 } as never));
    const outcome = await runner.start({ ...claudeStart("builder", "claude:max", []), binding, claudeConfigDir: null, system: "ROLE RULES" }).done;
    const dev = proc.sent.find((x) => x.method === "thread/start").params.developerInstructions as string;
    expect(dev).toContain(loadGuidance("builder").text);
    expect(outcome.guidance?.[0]).toMatchObject({ role: "builder", supplied: true, sha256: loadGuidance("builder").use.sha256 });
  });
  test("model router (planner/reviewer text roles): the system message carries the file", async () => {
    let seen = "";
    const chat = (async (o: any) => { seen = o.messages[0].content; throw Object.assign(new Error("stop here"), { code: "unavailable" }); }) as never;
    const runner = withGuidance(routerRunner({ chat } as never));
    const outcome = await runner.start({ ...claudeStart("reviewer", "claude:max", []), binding: routerBinding("deepseek/deepseek-v4-pro") as AgentBinding }).done;
    expect(seen).toContain(loadGuidance("reviewer").text);
    expect(outcome.guidance?.[0]).toMatchObject({ role: "reviewer", supplied: true });
  });
  test("a route the runner can't take is reported 'not supported', with no guidance added", async () => {
    let got = "";
    const inner: RoleRunner = {
      kind: "model-router",
      start(input) {
        got = input.system;
        const o: RunnerOutcome = { status: "succeeded", error: null, finalText: "", sessionId: null, providerModel: null, usage: {} as never, valueUsdEquivalent: null, turns: 1, startedAt: 1, endedAt: 2, allowanceEnd: null, accountPlan: null };
        return { respond() {}, interrupt() {}, cancel() {}, done: Promise.resolve(o) };
      },
    };
    const events: RunnerEvent[] = [];
    const out = await withGuidance(inner, { supports: ["claude-code-cli"] }).start({ ...claudeStart("builder", "claude:max", events), binding: routerBinding("x/y") as AgentBinding }).done;
    expect(got).toBe("ROLE RULES: stay in your worktree.");
    expect(out.guidance?.[0]).toMatchObject({ supplied: false, sha256: null, reason: "not supported on the model-router route" });
    expect(events.some((e) => e.type === "step" && /not supplied: not supported on the model-router route/.test(e.label))).toBe(true);
    const receipt = buildReceipt({ requestId: "r" as never, parentRequestId: null, jobId: "j" as never, roleId: "builder-1" as never, role: "builder", turn: 1, person: "usman" as never, binding: routerBinding("x/y") as AgentBinding, dataClass: "synthetic", outcome: out, allowanceStart: null, queueMs: 0 });
    expect(receipt.guidance?.[0].supplied).toBe(false);
    expect(receipt.contextSources?.some((c) => c.kind === "engineering-guidance")).toBe(false);
  });
  test("a role with no model (tester) is passed through untouched, with no guidance record", async () => {
    let got = "";
    const inner: RoleRunner = { kind: "claude-code-cli", start(input) { got = input.system; return { respond() {}, interrupt() {}, cancel() {}, done: new Promise(() => {}) }; } };
    withGuidance(inner).start({ ...claudeStart("tester", "claude:max", []) });
    expect(got).toBe("ROLE RULES: stay in your worktree.");
  });
});

// ───────────────────────── a real orchestrated job, two Claude accounts ─────────────────────────

const OWNER: VerifiedPrincipal = { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "test" };
const RESULTS = ["(pass) alpha [1.00ms]", " 1 pass", " 0 fail", ""].join("\n");
const settled = (j: CodingJob) => ["completed", "needs_owner", "failed", "cancelled", "interrupted", "blocked_allowance"].includes(j.state) && !j.runs.some((r) => ["starting", "running", "needs_input"].includes(r.state));

describe("through the orchestrator (SYNTHETIC)", () => {
  test("builder on claude:max-2 and reviewer on claude:max each receive their own file; the receipts list path + sha256", async () => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
    gitIn(fx.canonical, "add", "results.txt");
    gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
    const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
    const entry = { ...fx.entry, commands: [{ id: "fx.test" as never, kind: "test" as const, argv, cwd: ".", timeoutMs: 60_000, counts: "bun" as const }] };
    const registry: RepoRegistry = { version: 1, repos: [entry] };
    const store = CodingStore.open(join(fx.root, "coding-data"));
    const dir2 = join(fx.root, "profile-max-2");
    mkdirSync(dir2, { recursive: true });
    const accounts = validateAccounts({ version: 1, codex: DEFAULT_ACCOUNTS.codex.slice(0, 1), claude: [{ slot: "claude:max", configDir: null, plan: "claude-max-20x", label: "Claude Max" }, { slot: "claude:max-2", configDir: dir2, plan: "claude-max-20x", label: "Claude Max 2" }] });
    const systems: { readOnly: boolean; dir: string | undefined; system: string }[] = [];
    const spawn = ((binary: string, args: string[], o: any) => {
      const readOnly = args[args.indexOf("--permission-mode") + 1] === "plan";
      systems.push({ readOnly, dir: o.env.CLAUDE_CONFIG_DIR, system: readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8") });
      const content = "export const a = 42;\n";
      const fake = readOnly
        ? new FakeClaude({ result: { result: JSON.stringify({ verdict: "approve", findings: [], criteria: [{ criterionId: "c1", met: true }] }) } })
        : new FakeClaude({ steps: [
            { tool: "Write", input: { file_path: "src/a.ts", content }, effect: { write: { path: "src/a.ts", content } } },
            { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
            { tool: "Bash", input: { command: 'git commit -m "a=42"' }, effect: { git: ["commit", "-q", "-m", "a=42"] } },
            { text: "Set a to 42." },
          ] });
      fake.args = args; fake.options = { ...o, binary };
      return fake;
    }) as any;
    const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => accounts,
      runners: {
        claude: withGuidance(claudeRunner({ binary: "C:/fake/claude.exe", spawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 })),
        codex: withGuidance(codexRunner({ binary: "C:/fake/codex.exe", platform: "linux", env: { PATH: "/bin" } })),
        router: withGuidance(routerRunner({ chat: async () => { throw new Error("no router here"); } })),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      claudeConnected: () => ({ connected: true, reason: null }), codexIsolation: () => ({ ok: true, message: "" }),
    });
    orch.attachApprovals();
    const s = draftSpec({
      requestedBy: OWNER, channel: "typed", utterance: "Set a to 42.", entry, objective: "Set a to 42 in the fixture",
      doneWhen: [{ id: "c1", text: "a is 42", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
      builders: [{ binding: claudeBinding("claude-sonnet-5-5", "2.1.280", "claude:max-2"), owns: { globs: ["src/a.ts"], newFiles: [] } }],
      reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280", "claude:max") }, checks: ["fx.test" as never], dataClass: "synthetic",
    });
    const { job } = orch.draft(s);
    orch.confirmAndStart(job.id, OWNER, "ui", specDigest(s));
    for (const t = Date.now(); !settled(store.getJob(job.id)!); ) { if (Date.now() - t > 300_000) throw new Error("timed out"); await Bun.sleep(25); }
    const events = store.events(job.id, 0, 5000);
    const receipts = events.filter((e) => e.type === "usage").map((e) => e.payload as any);
    const builder = receipts.find((r) => r.coding.roleId === "builder-1");
    const reviewer = receipts.find((r) => r.coding.roleId === "reviewer");
    expect(store.getJob(job.id)!.state).toBe("completed");
    expect(builder.account).toBe("claude:max-2");
    expect(reviewer.account).toBe("claude:max");
    expect(builder.guidance).toEqual([loadGuidance("builder").use]);
    expect(reviewer.guidance).toEqual([loadGuidance("reviewer").use]);
    const writer = systems.find((x) => !x.readOnly)!;
    const reader = systems.find((x) => x.readOnly)!;
    expect(writer.dir).toBe(dir2);
    expect(writer.system).toContain(loadGuidance("builder").text);
    expect(writer.system).not.toContain(loadGuidance("reviewer").text);
    expect(reader.system).toContain(loadGuidance("reviewer").text);
    expect(reader.system).not.toContain(loadGuidance("builder").text);
    const steps = events.filter((e) => e.type === "step").map((e) => (e.payload as any).label as string);
    expect(steps.filter((l) => /^Engineering guidance: /.test(l))).toHaveLength(2);
    // Recorded as sizes and digests only.
    expect(JSON.stringify(receipts)).not.toContain("Isolate the cause");
    orch.close(); store.close(); approvals.close();
  }, 400_000);
});

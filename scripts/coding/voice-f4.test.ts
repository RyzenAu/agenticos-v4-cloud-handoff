import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommandIndex, resolveCommand } from "../../src/lib/commands/registry";
import { isCodingRequest } from "../../src/lib/commands/coding";
import { ApprovalService } from "../approvals/service";
import { freeVoice } from "../free-voice";
import { moneyOrder } from "../jarvis-execution/spoken-money";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { MemoryReceiptSink } from "../model-router/receipts";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { CodingJob, RepoRegistry } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { FakeClaude, FakeCodex, type ClaudeStep } from "./runners/fakes";
import { routerRunner } from "./runners/router";
import { createShaper } from "./shaper";
import { reviseSpec } from "./spec";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo, gitIn, tempRoot, type FixtureRepo } from "./test-fixtures";
import { createCodingVoice } from "./voice";

/**
 * AUDIT-F4 style (finding F8): the same coding commands typed and spoken, through the command registry
 * (T1's resolveCommand) and through Jarvis's rules turn, then ONE synthetic job driven entirely by voice
 * with a fake STT (the spoken-yes ledger), fake agent CLIs and the orchestrator's own test run.
 */

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });

const C = {
  C01: "Jarvis, fix the login bug in the dental site",
  C02: "assign Codex to fix the failing tests in AgenticOS",
  C04: "build a CSV export in the receptionist app",
  C05: "Jarvis, fix the receptionist dashboard. Have an Opus builder implement it and another Opus agent review it. Show me the tests and what changed.",
  // REVIEW-T3 F7a: every way of handing work to an agent reaches the same draft-then-confirm entry.
  C06: "ask Claude to fix the failing test in AgenticOS",
  C07: "Codex, fix the footer on the marketing site",
  C08: "tell Codex to refactor the calls page in AgenticOS",
  C09: "ask Claude to look into the flaky test in AgenticOS",
  C10: "fix the checkout bug in the dental site",
};
const NOT_CODING = ["open the coding page", "change the volume to 50", "add a reminder to call Mehroz at 3", "fix my calendar for tomorrow", "show me the leads", "what's the status of the coding job", "make a call to the dentist", "ask Claude to check my email", "ask Claude to look into flights to Dubai", "tell Claude I said thanks", "Claude, what time is it"];

describe("F8: typed and spoken reach the SAME coding entry through the command registry", () => {
  const index = buildCommandIndex({});
  for (const [id, text] of Object.entries(C)) {
    test(`${id}: "${text.slice(0, 50)}…"`, () => {
      const typed = resolveCommand(text, index, { channel: "typed" });
      const voice = resolveCommand(text, index, { channel: "voice" });
      expect(typed.status).toBe("resolved");
      expect(voice.status).toBe("resolved");
      if (typed.status !== "resolved" || voice.status !== "resolved") return;
      expect(typed.entry.id).toBe("coding:request");
      expect(voice.entry.id).toBe(typed.entry.id);
      expect(typed.entry.action).toMatchObject({ type: "navigate", to: "/coding" });
      expect((typed.entry.action as { search: { request: string } }).search.request).toContain(text.includes("Jarvis,") ? text.replace(/^Jarvis,\s*/, "").slice(0, 20) : text.slice(0, 20));
    });
  }
  test("non-coding commands are left alone (no false coding jobs)", () => {
    for (const text of NOT_CODING) {
      expect(isCodingRequest(text)).toBe(false);
      const r = resolveCommand(text, index, { channel: "typed" });
      if (r.status === "resolved") expect(r.entry.id).not.toBe("coding:request");
    }
    // The Coding page itself is a normal page entry.
    const page = resolveCommand("open coding", index, { channel: "voice" });
    expect(page.status === "resolved" && page.entry.action).toMatchObject({ type: "navigate", to: "/coding" });
  });
});

describe("F8: Jarvis's rules turn hands coding commands to the harness, typed and spoken alike (no brain)", () => {
  test("C01/C02/C05 reach the coding rules; others don't", async () => {
    const seen: string[] = [];
    const voiceRoot = tempRoot("coding-f4-voice-");
    roots.push(voiceRoot);
    const engine = freeVoice(voiceRoot, {
      fetch: (async () => { throw new Error("network blocked in this test"); }) as never,
      key: () => "",
      coding: async (utterance) => { seen.push(utterance); return isCodingRequest(utterance) ? { say: "Draft ready: … Start it?", navigate: "/coding" } : null; },
    });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
    for (const text of [C.C01, C.C02, C.C05]) {
      {
        const out = (await engine.handle("/voice/free/turn", { messages: [{ role: "user", content: text }] }, caller)) as any;
        expect(out.model).toBe("rules");
        expect(out.route?.intent).toBe("coding");
        expect(out.tool_calls?.[0]?.function?.name).toBe("navigate");
        expect(JSON.parse(out.tool_calls[0].function.arguments)).toMatchObject({ path: "/coding" });
      }
    }
    // After the client ran navigate, the prepared line is spoken by rules (no model call).
    const call = { id: "coding_r1", type: "function", function: { name: "navigate", arguments: JSON.stringify({ path: "/coding", say: "Draft ready: X. Start it?" }) } };
    const follow = (await engine.handle("/voice/free/turn", { messages: [{ role: "user", content: C.C01 }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "coding_r1", content: "Opened Coding." }] }, caller)) as any;
    expect(follow).toMatchObject({ content: "Draft ready: X. Start it?", model: "rules" });
  }, 60_000);

  test("REVIEW-T3 F7b: a code change that names a money feature reaches coding; a payment never becomes coding (S2d: it goes to the brain, not refused)", async () => {
    const seen: string[] = [];
    const voiceRoot = tempRoot("coding-f7b-voice-");
    roots.push(voiceRoot);
    const engine = freeVoice(voiceRoot, {
      fetch: (async () => { throw new Error("network blocked in this test"); }) as never,
      key: () => "",
      coding: async (utterance) => { seen.push(utterance); return isCodingRequest(utterance) ? { say: "Draft ready: … Start it?", navigate: "/coding" } : null; },
    });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
    const turn = async (text: string) => (await engine.handle("/voice/free/turn", { messages: [{ role: "user", content: text }] }, caller)) as any;
    for (const text of ["fix the checkout bug in the dental site", "ask Claude to fix the Stripe webhook handler in AgenticOS", "fix the bank transfer page in the receptionist app", "update the PayID copy on the dental site", "implement BPAY support in the receptionist app"]) {
      expect(moneyOrder(text)).toBe(false);
      const out = await turn(text);
      expect(out.route?.intent).toBe("coding");
    }
    for (const text of ["pay the invoice", "fix the checkout bug and then pay the invoice", "ask Claude to fix the checkout and pay the invoice", "fix the checkout bug in the dental site and do it for me", "fix the $50 checkout bug in the dental site", "transfer $500 to Mehroz"]) {
      const before = seen.length;
      expect(moneyOrder(text)).toBe(true);
      // No key and no network here, so the brain can't answer; what matters is that it was neither refused
      // in code nor handed to the coding lane.
      const out = await turn(text).catch((error: unknown) => ({ error: String(error) }));
      expect(out.route?.intent).not.toBe("coding");
      expect(out.route?.intent).not.toBe("money-refused");
      expect(seen.length).toBe(before);
    }
  }, 60_000);
});

// ─────────────────────────── one job, entirely by voice ───────────────────────────

const RESULTS = ["(pass) alpha [1.00ms]", "(pass) beta [1.00ms]", "(pass) gamma [1.00ms]", " 3 pass", " 0 fail", ""].join("\n");
function fastFixture(): FixtureRepo {
  const fx = fixtureRepo();
  roots.push(fx.root);
  writeFileSync(join(fx.canonical, "results.txt"), RESULTS);
  gitIn(fx.canonical, "add", "results.txt");
  gitIn(fx.canonical, "commit", "-q", "--only", "-m", "results", "--", "results.txt");
  const baseSha = gitIn(fx.canonical, "rev-parse", "HEAD").trim() as never;
  const argv = process.platform === "win32" ? ["findstr", "/r", "^.", "results.txt"] : ["grep", "-E", "^.", "results.txt"];
  return { ...fx, baseSha, entry: { ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib", commands: [{ id: "fx.test" as never, kind: "test", argv, cwd: ".", timeoutMs: 60_000, counts: "bun" }] } };
}
const BUILDER: ClaudeStep[] = [
  { tool: "Write", input: { file_path: "src/a.ts", content: "export const a = 42;\n" }, effect: { write: { path: "src/a.ts", content: "export const a = 42;\n" } } },
  { tool: "Bash", input: { command: "git add -- src/a.ts" }, effect: { git: ["add", "--", "src/a.ts"] } },
  { tool: "Bash", input: { command: 'git commit -m "a = 42"' }, effect: { git: ["commit", "-q", "-m", "a = 42"] } },
  { text: "Set a to 42 and committed." },
];

describe("F8: a SYNTHETIC coding job driven by voice (fake STT) end to end", () => {
  test("request → plan + repo shown → 'Say start…' → spoken yes → build → test → review → gate → handoff, with receipts", async () => {
    const fx = fastFixture();
    const store = CodingStore.open(join(fx.root, "coding-data"));
    const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
    const ledger = new SpokenConfirmationLedger();
    const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
    const claudeSpawn = ((binary: string, args: string[], opts: any) => {
      const plan = args[args.indexOf("--permission-mode") + 1] === "plan";
      const fake = plan
        ? new FakeClaude({ result: { result: JSON.stringify({ verdict: "approve", findings: [], criteria: [{ criterionId: "c2", met: true, note: "a is 42" }] }) } })
        : new FakeClaude({ steps: BUILDER });
      fake.args = args; fake.options = { ...opts, binary };
      return fake;
    }) as any;
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
      runners: {
        claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
        codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
        router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
    });
    let focus: { jobId: string; tab: string } | null = null;
    const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
    const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: (jobId, tab) => { focus = { jobId, tab }; }, repoIds: () => ["fixture-app"] });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" };
    // A turn as the free-voice engine runs it: the STT's spoken-yes id only when the transcript is a clear yes.
    const say = async (text: string, previousAssistant: string | null = null) => {
      const yes = ledger.record(text);
      return voice.handle(text, { caller, spokenYes: yes?.id ?? null, previousAssistant });
    };

    // 1. The request: the plan and repo are shown and a clear confirmation is asked for.
    const drafted = await say("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews. Show me the tests and what changed.");
    expect(drafted?.navigate).toBe("/coding");
    // F1: one short line (the title), then what to say; the team, files and checks are on the Coding page.
    expect(drafted?.say).toMatch(/^Draft ready: Set a to 42 in src\/a\.ts of the fixture app\. Source snapshot: main at [a-f0-9]{12}; uncommitted checkout changes are excluded\. Selected routes: builder-1: claude-opus-5-5; reviewer: claude-opus-5-5\. Say start when you want it built\.$/);
    const job0 = store.listJobs({ limit: 1 })[0];
    expect(job0.state).toBe("awaiting_confirmation");
    // Nothing runs before the yes.
    await Bun.sleep(100);
    expect(store.getJob(job0.id)!.state).toBe("awaiting_confirmation");
    // REVIEW-T3 F7c: "start it" answers only Jarvis's own "Start it?", in the very next turn. After another
    // line (say, a refused money request in between) it starts nothing and the question is gone.
    const stale = await say("start it", "I don't pay, buy, move money or trade from a spoken or chat request. Nothing was done.");
    expect(stale?.say).toMatch(/nothing started/i);
    expect(store.getJob(job0.id)!.state).toBe("awaiting_confirmation");
    const orphan = await say("start it", drafted!.say);
    expect(orphan === null || !/Started/.test(orphan.say)).toBe(true);
    expect(store.getJob(job0.id)!.state).toBe("awaiting_confirmation");
    // 2. "Yes, but make it 43" is NOT a yes: nothing starts (AUDIT-F4 F1).
    await say("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews.");
    const notYes = await say("yes but make it 43", drafted!.say);
    expect(store.getJob(job0.id)!.state).toBe("awaiting_confirmation");
    expect(notYes === null || !/Started/.test(notYes.say)).toBe(true);
    // Re-ask (the draft is still there) and answer with a clear spoken yes.
    const again = await say("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews.");
    const job = store.listJobs({ limit: 1 })[0];
    const started = await say("yes", again!.say);
    expect(started?.say).toContain("Started");
    expect(store.getJob(job.id)!.spec.confirmation).toMatchObject({ state: "confirmed", via: "spoken-yes" });
    // 3. Progress by voice while it runs, then the finished state.
    const midway = await say("how's the coding job going?");
    expect(midway?.say).toMatch(/fixture-app job is/);
    const done = await (async () => {
      const t0 = Date.now();
      for (;;) {
        const j = store.getJob(job.id)!;
        if (["completed", "needs_owner", "failed"].includes(j.state) && !orch.running(job.id)) return j as CodingJob;
        if (Date.now() - t0 > 400_000) throw new Error(`stuck at ${j.state}`);
        await Bun.sleep(50);
      }
    })();
    expect(done.state).toBe("completed");
    const status = await say("how's the coding job going?");
    expect(status?.say).toContain("done and verified");
    expect(status?.say).toContain("3 passed");
    expect(status?.say).toContain("Nothing is merged");
    const show = await say("show me the tests");
    expect(show?.navigate).toBe("/coding");
    expect(focus).toEqual({ jobId: job.id, tab: "tests" });
    // 4. Receipts: one per role turn, the account and model that ran.
    const receipts = store.events(job.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload as any);
    expect(receipts.map((r) => `${r.coding.roleId} ${r.account} ${r.model}`)).toEqual(["builder-1 claude:max claude-opus-5-5", "reviewer claude:max claude-opus-5-5"]);
    expect(store.events(job.id, 0, 5000).some((e) => e.type === "handoff")).toBe(true);
    orch.close(); store.close(); approvals.close();
  }, 600_000);
});

describe("REVIEW-T3 R3-1: through the voice/typed turn a page-token program can draft, never act", () => {
  test("the reviewer's probe: a process caller's 'start it' and 'stop the coding job' change nothing and spawn no agent; the planner never runs for it", async () => {
    const fx = fastFixture();
    const store = CodingStore.open(join(fx.root, "coding-data"));
    const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
    const ledger = new SpokenConfirmationLedger();
    const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
    let spawns = 0;
    const claudeSpawn = ((binary: string, args: string[], opts: any) => {
      spawns++;
      const fake = new FakeClaude({ steps: BUILDER });
      fake.args = args; fake.options = { ...opts, binary };
      return fake;
    }) as any;
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
      runners: {
        claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
        codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
        router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
    });
    let plannerCalls = 0;
    const planner = async () => { plannerCalls++; return null; };
    const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner });
    const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: () => {}, repoIds: () => ["fixture-app"] });
    // The caller /__operator/voice/free/turn resolves for a local program holding only the page token.
    const program = { id: "usman", via: "local", actor: "process" };
    const say = (text: string, previousAssistant: string | null = null) => voice.handle(text, { caller: program, spokenYes: null, previousAssistant });

    const drafted = await say("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews.");
    expect(drafted?.say).toMatch(/a signed-in person starts it there\.$/);
    expect(plannerCalls).toBe(0); // drafting for a program never spends the Claude planner
    const job = store.listJobs({ limit: 1 })[0];
    expect(job.state).toBe("awaiting_confirmation");

    const started = await say("start it", drafted!.say);
    expect(started?.say).toMatch(/only a person can start/);
    await Bun.sleep(150);
    expect(store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    expect(store.getJob(job.id)!.spec.confirmation.state).not.toBe("confirmed");
    expect(spawns).toBe(0);

    for (const text of ["stop the coding job", "pause the coding job", "resume the coding job", "merge the coding job into main"]) {
      const r = await say(text, "The coding job is waiting for you to start it.");
      expect([text, r?.say ?? ""]).toEqual([text, expect.stringMatching(/only a person/)]);
    }
    expect(store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    // Status is still answered for a program.
    expect((await say("how's the coding job going?"))?.say).toMatch(/fixture-app job is/);
    expect(spawns).toBe(0);

    // The same words from a person (a signed-in session) do start it, and the planner is theirs to spend.
    const personSay = (text: string, previousAssistant: string | null = null) => voice.handle(text, { caller: { ...program, actor: "human" }, spokenYes: null, previousAssistant });
    const again = await personSay("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews.");
    expect(plannerCalls).toBe(1);
    expect(again?.say).toBeTruthy();
    orch.close(); store.close(); approvals.close();
  }, 600_000);
});

describe("REVIEW-T3 R4-1: the yes starts the plan that was read out, and only a person changes it", () => {
  function harness() {
    const fx = fastFixture();
    const store = CodingStore.open(join(fx.root, "coding-data"));
    const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
    const ledger = new SpokenConfirmationLedger();
    const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: ledger });
    let spawns = 0;
    const claudeSpawn = ((binary: string, args: string[], opts: any) => {
      spawns++;
      const fake = new FakeClaude({ stall: true, steps: [{ wait: 60_000 }] });
      fake.args = args; fake.options = { ...opts, binary };
      return fake;
    }) as any;
    const orch = createOrchestrator({
      store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
      runners: {
        claude: claudeRunner({ binary: "C:/fake/claude.exe", spawn: claudeSpawn, platform: "linux", env: { PATH: "/bin" }, killGraceMs: 300, softEndMs: 20 }),
        codex: codexRunner({ binary: "C:/fake/codex.exe", spawn: (() => new FakeCodex()) as never, platform: "linux", env: {} }),
        router: routerRunner({ chat: async () => { throw new Error("unused"); } }),
      },
      approvals: () => approvals, liveRoot: null, fleetSink: new MemoryReceiptSink(), claudeAllowance: () => null,
      memory: { writes: () => false, save: async () => ({ ok: false }) }, codexIsolation: () => ({ ok: true, message: "" }),
    });
    const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
    const voice = createCodingVoice({ store, orch, shaper, approvals: () => approvals, spoken: ledger, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), setFocus: () => {}, repoIds: () => ["fixture-app"] });
    const person = { id: "usman", name: "Usman", via: "local", actor: "human" };
    const program = { id: "usman", via: "local", actor: "process" };
    // A person's turn as the free-voice engine runs it: the STT's spoken-yes id only for a clear yes.
    const personSay = (text: string, previousAssistant: string | null = null) => {
      const yes = ledger.record(text);
      return voice.handle(text, { caller: person, spokenYes: yes?.id ?? null, previousAssistant });
    };
    const programSay = (text: string, previousAssistant: string | null = null) => voice.handle(text, { caller: program, spokenYes: null, previousAssistant });
    const close = () => { orch.close(); store.close(); approvals.close(); };
    return { store, orch, personSay, programSay, spawns: () => spawns, close };
  }
  const REQUEST = "Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews.";

  test("the reviewer's sequence: a program's edits and relayed yes change nothing; the person's yes starts exactly what he heard", async () => {
    const h = harness();
    const heard = await h.personSay(REQUEST);
    expect(heard?.say).toMatch(/Say start when you want it built\.$/);
    const job = h.store.listJobs({ limit: 1 })[0];
    const before = JSON.stringify(job.spec.roles);
    // A program with his id tries to edit the draft he's been asked about.
    for (const text of ["no review", "use sonnet for the build"]) {
      const r = await h.programSay(text, heard!.say);
      expect([text, r?.say ?? ""]).toEqual([text, expect.stringMatching(/only a person/)]);
    }
    expect(JSON.stringify(h.store.getJob(job.id)!.spec.roles)).toBe(before);
    // A program's "yes start it" is refused and does NOT clear the person's pending question.
    expect((await h.programSay("yes start it", heard!.say))?.say).toMatch(/only a person/);
    expect(h.store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    // The person's spoken yes starts the plan he heard: Opus builds, Opus reviews.
    const started = await h.personSay("yes", heard!.say);
    expect(started?.say).toContain("Started");
    const j = h.store.getJob(job.id)!;
    expect(j.spec.confirmation).toMatchObject({ state: "confirmed", via: "spoken-yes" });
    expect(JSON.stringify(j.spec.roles)).toBe(before);
    expect(j.spec.roles.find((r) => r.role === "builder")!.agent!.model).toBe("claude-opus-5-5");
    expect(j.spec.roles.some((r) => r.role === "reviewer")).toBe(true);
    h.orch.cancel(job.id);
    h.close();
  }, 600_000);

  test("a plan changed after 'Start it?' (the page, or anyone) isn't started by the yes: the new plan is read out and asked again", async () => {
    const h = harness();
    const heard = await h.personSay(REQUEST);
    const job = h.store.listJobs({ limit: 1 })[0];
    // The plan changes after it was read out (here: the reviewer is dropped on the Coding page).
    h.orch.revise(job.id, reviseSpec(job.spec, { roles: job.spec.roles.filter((r) => r.role !== "reviewer") }));
    const again = await h.personSay("yes", heard!.say);
    expect(again?.say).toMatch(/^The plan changed since I asked, so nothing started\./);
    expect(again?.say).toMatch(/Say start when you want it built\.$/);
    expect(h.store.getJob(job.id)!.state).toBe("awaiting_confirmation");
    expect(h.spawns()).toBe(0);
    // His yes to the plan he has now heard starts it.
    const started = await h.personSay("yes", again!.say);
    expect(started?.say).toContain("Started");
    expect(h.store.getJob(job.id)!.spec.roles.some((r) => r.role === "reviewer")).toBe(false);
    h.orch.cancel(job.id);
    h.close();
  }, 600_000);
});

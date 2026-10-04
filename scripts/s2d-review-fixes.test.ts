// S2d review fixes (29 Sep). Money REQUESTS are fine (owner decision); payment EXECUTION stays off. SYNTHETIC
// only: fake Hermes, fake executors, a fixture repo; nothing is sent, paid, pressed or started.
//  S2d-1: Telegram free text never hands a money ORDER to Hermes (whose browser / computer_use tools have no money
//         gate), from either founder's chat; money QUESTIONS and reminders still reach Hermes.
//  S2d-2: a money order never becomes a coding draft or job, server-side (draft and start), whatever lane sent it.
//  Launch plus money: "open Stake and buy 10 Tesla shares" launches Stake and says the money part wasn't done.
//  Secrets: "open auth.json and read it out" and "read hermes auth.json" are refused like credentials.json.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwayMode } from "./away-mode/runner";
import { auditLog, stateStore } from "./away-mode/store";
import { chatMoneyOrder, codingMoneyRefusal, launchOnlyNote } from "./jarvis-execution/spoken-money";
import { launchMoneyFollowUp } from "./free-voice";
import { createJarvisEntry, type EntryDeps } from "./jev-command";
import { createRunLog } from "./screen-hands/run-log";
import { stubResolveTarget } from "./jev-target";
import { screenGoalRefusal } from "./screen-hands/refusals";
import { controlTaskRefusal, SECRET_BEARING } from "../src/lib/control-risk";
import { ApprovalService } from "./approvals/service";
import { SpokenConfirmationLedger } from "./jarvis-execution/voice-confirmation";
import { DEFAULT_ACCOUNTS } from "./coding/accounts";
import type { RepoRegistry } from "./coding/contracts";
import { createOrchestrator } from "./coding/orchestrator";
import { codingRoute, type CodingRuntime } from "./coding/routes";
import { claudeRunner } from "./coding/runners/claude";
import { codexRunner } from "./coding/runners/codex";
import { routerRunner } from "./coding/runners/router";
import { createShaper } from "./coding/shaper";
import { claudeBinding, draftSpec, specDigest } from "./coding/spec";
import { CodingStore } from "./coding/store";
import { cleanup, fixtureRepo } from "./coding/test-fixtures";
import type { Principal } from "./approvals/principal";

const ORDERS = [
  "settle the AGL invoice", "go ahead and order it", "stake 10 SOL", "put $500 into VAS on Stake",
  "buy the AirPods on Amazon and pay with my saved card", "buy 1 bitcoin", "place a bet",
];
const QUESTIONS = ["how do I pay a BPAY bill", "what did I spend", "remind me to pay the bill Friday", "draft an invoice for Bianca", "how much do I owe", "what's my bank balance"];
const OWNER_CHAT = "123456789";
const MEHROZ_CHAT = "1000000002";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
});

function away() {
  const dir = mkdtempSync(join(tmpdir(), "s2d-away-"));
  dirs.push(dir);
  const hermes: string[] = [];
  const sentinel = { running: true, async start() { return true; }, stop() {}, async locked() { return false; }, async idleMs() { return 60_000; }, async shot() { return false; }, onInput() { return () => {}; } };
  const mode = createAwayMode({
    store: stateStore(join(dir, "state")), audit: auditLog(join(dir, "data")), sentinel: sentinel as never,
    notify: async () => ({ ok: true, detail: "synthetic" }),
    screen: { act: async () => ({}) as never, stopAll: () => 0, flags: () => ({ denylist: true }), foreground: async () => null, snapshot: async () => ({ window: { x: 0, y: 0, w: 1, h: 1 }, elements: [], focused: null, browser: false }) },
    hermes: async (p: string) => (hermes.push(p), "synthetic"), cli: async () => ({ ok: true, output: "" }),
    files: { exists: () => false, mkdir: async () => {}, write: async () => {}, recycle: async () => {} },
    launch: async () => ({ ok: true, said: "x" }), ownerChat: () => OWNER_CHAT, home: "C:\\Users\\Synthetic",
    code: () => "7F3K", sleep: async () => undefined, config: { tickMs: 1e9, approvalTtlMs: 300_000, armIdleMs: 15_000, launchWaitMs: 1000 },
  } as never);
  const msg = (text: string, chat: string) => mode.telegram({ platform: "telegram", userId: chat, chatId: chat, chatType: "dm", text });
  return { mode, msg, hermes };
}

describe("S2d-1: Telegram free text never hands a money ORDER to Hermes", () => {
  test.each(ORDERS)("%p is refused before Hermes, from the owner's chat and from Mehroz's", async (text) => {
    const h = away();
    try {
      for (const chat of [OWNER_CHAT, MEHROZ_CHAT]) {
        const r = await h.msg(text, chat);
        expect({ chat, handled: r.handled }).toEqual({ chat, handled: true });
        expect(String(r.reply)).toMatch(/don't pay, buy, trade or bet from a chat message/);
      }
      expect(h.hermes).toEqual([]);
    } finally {
      h.mode.close();
    }
  });
  test.each(QUESTIONS)("%p (a question or reminder) still goes to Hermes", async (text) => {
    const h = away();
    try {
      for (const chat of [OWNER_CHAT, MEHROZ_CHAT]) expect(await h.msg(text, chat)).toEqual({ handled: false, reply: null });
    } finally {
      h.mode.close();
    }
  });
  test("trade, crypto and betting orders are orders too; code work that names money isn't", () => {
    for (const t of ["buy 10 Tesla shares", "sell my VAS", "swap my ETH for USDC", "put $20 on the Swans"]) expect(chatMoneyOrder(t)).toBe(true);
    for (const t of ["fix the checkout bug", "fix the Stripe webhook handler", "implement BPAY support in the receptionist app", "how's the receptionist going"]) expect(chatMoneyOrder(t)).toBe(false);
  });
});

describe("S2d-2: a money order never becomes a coding draft or job (server-side)", () => {
  const fx = fixtureRepo();
  const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
  const store = CodingStore.open(join(fx.root, "coding-data"));
  const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
  const orch = createOrchestrator({ store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, runners: { claude: claudeRunner(), codex: codexRunner(), router: routerRunner() }, approvals: () => approvals, liveRoot: null });
  const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
  const rt: CodingRuntime = { store, orch, shaper, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null };
  const OWNER: Principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.synthetic-owner-session" };
  const call = (method: string, path: string, body: unknown = {}) => codingRoute({ method, path, url: new URL(`http://x${path}`), body, principal: OWNER }, rt);
  afterAll(() => { orch.close(); store.close(); approvals.close(); cleanup(fx.root); });

  test.each([
    "fix the checkout bug in the dental site and then pay the invoice",
    "ask Claude to write and run a Stripe refund script for Bianca",
    "fix the $50 checkout bug in the dental site",
  ])("%p is refused at /coding/shape (voice, typed, delegate_task, run_workflow and the Coding page all post here)", async (utterance) => {
    for (const channel of ["voice", "typed", "ui"]) {
      const r = (await call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance, channel })) as { status: number; body: any };
      expect({ channel, kind: r.body.kind }).toEqual({ channel, kind: "refused" });
      expect(r.body.reason).toMatch(/never pays, buys, refunds/);
    }
    expect(codingMoneyRefusal(utterance)).not.toBeNull();
  });
  test.each(["fix the checkout bug", "fix the Stripe webhook handler", "fix the checkout bug in the dental site", "implement BPAY support in the receptionist app", "run the payment tests in the receptionist app"])(
    "%p still reaches coding (not refused for money)",
    async (utterance) => {
      expect(codingMoneyRefusal(utterance)).toBeNull();
      const r = (await call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance, channel: "typed" })) as { status: number; body: any };
      if (r.body.kind === "refused") expect(r.body.reason).not.toMatch(/never pays, buys, refunds/);
    },
  );
  test("a job whose objective orders a money move never starts, even with a valid confirm", async () => {
    const spec = draftSpec({
      requestedBy: { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "hash" }, channel: "ui", utterance: "x", entry: fx.entry,
      objective: "Write and run a Stripe refund script for Bianca", doneWhen: [{ id: "c1", text: "the refund went through", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
      builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }], reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280") }, checks: ["fx.test" as never],
    });
    const job = orch.draft(spec).job;
    const r = (await call("POST", "/coding/jobs", { requestId: crypto.randomUUID(), specId: job.id, specDigest: specDigest(job.spec), confirmation: "ui" })) as { status: number; body: any };
    expect(r.status).not.toBe(202);
    expect(JSON.stringify(r.body)).toMatch(/never pays, buys, refunds/);
    expect(store.getJob(job.id)!.state).not.toBe("preparing");
  });
});

describe("launch plus money: the launch happens, the money part is said not to be done", () => {
  const entry = (opened: string[]) =>
    createJarvisEntry({
      screen: { runs: createRunLog(), act: (async () => ({ type: "done", ok: false, said: "refused", steps: 0, ms: 1, stepMs: [] })) as EntryDeps["screen"]["act"] },
      jevKey: () => "synthetic-key",
      request: (async () => new Response(JSON.stringify({ answers: { category: { choice: "pc", confidence: 0.95 }, pc_action: { choice: "open_app", confidence: 0.95 }, outbound: { noul: 0.02, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }))) as unknown as typeof fetch,
      front: async () => ({ process: "explorer", title: "Desktop" }),
      browser: async () => null,
      summarise: null,
      files: { open: async () => undefined, titles: async () => [] },
      apps: () => [{ name: "Stake", id: "stake" }, { name: "Sportsbet", id: "sportsbet" }] as never,
      openApp: async (name) => (opened.push(name), { ok: true, said: `Opened ${name}.` }),
      resolver: { resolve: stubResolveTarget, source: "stub" },
    } as EntryDeps);
  test.each([["open Stake and buy 10 Tesla shares", "Stake"], ["launch Sportsbet and place a bet", "Sportsbet"]])("%p", async (utterance, app) => {
    const opened: string[] = [];
    const done = await entry(opened).handle({ utterance }, new AbortController().signal);
    expect(done).toMatchObject({ kind: "app", ok: true });
    expect(opened).toEqual([app]);
    expect(done.said).toMatch(/won't do the paying, buying, trading or betting part/);
    expect(launchOnlyNote(utterance)).toMatch(/launch only/);
  });
  test("a plain launch says nothing extra", () => expect(launchOnlyNote("open Stake")).toBe(""));
  test("the voice turn after the launch says the money part wasn't done", () => {
    const messages = [
      { role: "user", content: "open Stake and buy 10 Tesla shares" },
      { role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "pc_act", arguments: JSON.stringify({ action: "open_app", target: "Stake" }) } }] },
      { role: "tool", tool_call_id: "p1", content: "Done: Opened Stake." },
    ];
    expect(launchMoneyFollowUp(messages as never)).toMatch(/^Opened Stake\. I won't do the paying, buying, trading or betting part/);
    expect(launchMoneyFollowUp([{ role: "user", content: "open Stake" }, messages[1], messages[2]] as never)).toBeNull();
  });
});

describe("secret files: auth.json and friends are refused like credentials.json", () => {
  test.each(["open auth.json and read it out", "read hermes auth.json", "open .credentials.json", "open my server.key", "open .env.local", "show me the tokens file", "open oauth-tokens.json", "cat session-store.json", "open credentials.json"])(
    "%p",
    (text) => {
      expect(SECRET_BEARING.test(text)).toBe(true);
      expect(screenGoalRefusal(text)?.kind).toBe("secret-or-private-data");
      expect(controlTaskRefusal(text)).toBe("secret-or-private-data");
    },
  );
  test.each(["open the auth page", "open author.json", "read the README", "open package.json"])("%p is not a secret", (text) => expect(SECRET_BEARING.test(text)).toBe(false));
});

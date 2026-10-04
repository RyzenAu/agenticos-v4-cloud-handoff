// Naming a Claude account out loud or typed (1 Oct 2026): "assign this fix to Claude Max 2", "have Sonnet build this
// using account two and another agent review it". The right slot is chosen for every Claude role of the job, and
// ordinary sentences that merely contain "max", "account" or "code" never start a coding job or pick an account.
// Synthetic only: no network, no account, temp fixture repo.
import { afterAll, describe, expect, test } from "bun:test";
import { buildCommandIndex, resolveCommand } from "../../src/lib/commands/registry";
import { isCodingRequest } from "../../src/lib/commands/coding";
import { validateAccounts } from "./accounts";
import type { RepoRegistry, VerifiedPrincipal } from "./contracts";
import { bindingFromWords, claudeSlotFromWords, createShaper } from "./shaper";
import { isCodingStart } from "./voice";
import { cleanup, fixtureRepo } from "./test-fixtures";

const TWO = validateAccounts({
  version: 1,
  codex: [{ slot: "codex:openai-2", codexHome: null, plan: "chatgpt-plus", creditsAllowed: false }],
  claude: [{ slot: "claude:max", configDir: null, plan: "claude-max-20x", label: "Claude Max" }, { slot: "claude:max-2", configDir: "D:/synthetic/profile-2", plan: "claude-max-20x", label: "Claude Max 2" }],
});
const THREE = validateAccounts({ ...TWO, claude: [...TWO.claude, { slot: "claude:max-3", configDir: "D:/synthetic/profile-3", plan: "claude-max-20x", label: "Claude Max 3" }] });
const index = buildCommandIndex({});
const deps = { accounts: () => TWO, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }) } as never;

const START: [string, "claude:max" | "claude:max-2"][] = [
  ["assign this fix to Claude Max 2", "claude:max-2"],
  ["Jarvis, assign the login bug fix in src/a.ts to Claude Max 2", "claude:max-2"],
  ["assign this fix to Claude Max two", "claude:max-2"],
  ["give this change to Claude account 2", "claude:max-2"],
  ["have Sonnet build this using account two and another agent review it", "claude:max-2"],
  ["have Sonnet fix the login bug in src/a.ts using account two and another agent review it", "claude:max-2"],
  ["use the second Claude account for a builder to fix the login bug in src/a.ts and Opus to review it", "claude:max-2"],
  ["use Claude Max 2 for a builder to fix the login bug in src/a.ts and Opus to review it", "claude:max-2"],
  ["assign this fix to the original Claude account", "claude:max"],
];

describe("naming an account: the request is a coding job for that account", () => {
  test.each(START)("%p -> %p", (text, slot) => {
    expect(isCodingRequest(text)).toBe(true);
    expect(isCodingStart(text)).toBe(true);
    for (const channel of ["typed", "voice"] as const) {
      const r = resolveCommand(text, index, { channel });
      expect(r.status).toBe("resolved");
      if (r.status === "resolved") expect(r.entry.id).toBe("coding:request");
    }
    expect(claudeSlotFromWords(text, TWO)).toBe(slot);
  });
  test("the model words and the account words combine: Sonnet on account two, Opus on account two, a bare account is Opus", () => {
    const at = (t: string) => { const b = bindingFromWords(t, deps); return b ? `${b.accountSlot}/${b.model}` : null; };
    expect(at("have Sonnet build this using account two")).toBe("claude:max-2/claude-sonnet-5-5");
    expect(at("have Opus fix it on Claude Max 2")).toBe("claude:max-2/claude-opus-5-5");
    expect(at("assign this fix to Claude Max 2")).toBe("claude:max-2/claude-opus-5-5");
  });
  test("an account that isn't configured is not named (never a silent swap to another)", () => {
    expect(claudeSlotFromWords("assign this fix to Claude Max 3", TWO)).toBeNull();
    expect(claudeSlotFromWords("assign this fix to Claude Max 3", THREE)).toBe("claude:max-3");
  });
});

/** Ordinary sentences: none is a coding job, and none names an account. */
const ORDINARY = [
  "my max heart rate is 180 and I have two accounts at the bank",
  "check my account balance",
  "what is the max I can put in account 2",
  "I need to max out my credit card account 2",
  "open the code editor",
  "the max number of retries is 3 on account two of the code review tool",
  "review the code for account 2 in my notes",
  "send the account two code to Mehroz",
  "give the change from lunch to account two",
  "assign the invoice to account two",
  "move this task to my second account at the bank",
  "put the max amount into account 2",
  "give this reminder to Mehroz on account two",
  "hand the project code to the second account manager",
  "send this to the other account",
  "what is the account code for Claude",
  "Claude Max 2 is at 4 percent, how much is left",
  "how many tokens does Claude Max 2 have left",
  "switch to Claude Max 2",
  "tell Mehroz to use Claude Max 2 tonight",
  "how do I open a new account at the bank",
  "max out the volume",
];
describe("ordinary sentences with max / account / code never start a coding job", () => {
  test.each(ORDINARY)("%p", (text) => {
    expect(isCodingRequest(text)).toBe(false);
    expect(isCodingStart(text)).toBe(false);
    for (const channel of ["typed", "voice"] as const) {
      const r = resolveCommand(text, index, { channel });
      if (r.status === "resolved") expect(r.entry.id).not.toBe("coding:request");
    }
  });
  test.each([
    "what is the max I can put in account 2",
    "the max number of retries is 3 on account two of the code review tool",
    "Sonnet builds; allow max 3 retries",
    "fix the login bug in src/a.ts with max 2 workers",
    "fix the account 2 balance bug in src/a.ts",
    "open a new account",
    "the second account manager will review it",
  ])("an account word in %p doesn't pick a Claude account", (text) => {
    expect(claudeSlotFromWords(text, TWO)).toBeNull();
  });
});

describe("the named account applies to every Claude role of the drafted job", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
  test("Sonnet builds on account two and the independent reviewer is on account two too", async () => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app" }] };
    const shaper = createShaper({
      registry: () => registry, accounts: () => TWO, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null,
      // The automatic pick would be the ORIGINAL login; the words must win.
      claudeSlot: () => ({ slot: "claude:max", label: "Claude Max", reason: "Claude Max" }),
      choice: () => ({ route: ((_t: string, c: { selected?: string }) => ({ model: c.selected, fallbackFrom: null })) as never, hasKey: () => true, readings: [] }),
    });
    const r = await shaper.shape({ utterance: "have Sonnet fix the login bug in src/a.ts using account two and another agent review it", channel: "voice", principal, usePlanner: false });
    if (r.kind !== "draft") throw new Error(JSON.stringify(r));
    const agents = r.spec.roles.filter((x) => x.agent);
    const builder = agents.find((x) => x.role === "builder")!.agent!;
    const reviewer = agents.find((x) => x.role === "reviewer")!.agent!;
    expect([builder.accountSlot, builder.model]).toEqual(["claude:max-2", "claude-sonnet-5-5"]);
    expect(reviewer.model).not.toBe(builder.model);
    if (reviewer.route === "claude-code-cli") expect(reviewer.accountSlot).toBe("claude:max-2");
  });
});

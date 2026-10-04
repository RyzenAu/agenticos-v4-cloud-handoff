// Round 10 (jobs owner): "Fix X using Opus on Claude Max 2" typed or said to Jarvis (no Agents bot, so no structured pin).
//   - An account the words named that isn't connected was read as no account at all, and the job was drafted on the automatic pick (a silent switch).
//   - An account the words named was only a preference: the job carried no pin, so a signed-out or exhausted account was moved to another one at start
//     by the limit fallback, and a retry could land elsewhere.
// Synthetic only: a temp fixture repo, no Jev, no planner, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, VerifiedPrincipal } from "./contracts";
import { claudeSlotNamed, createShaper, unconnectedAccountWords } from "./shaper";
import { cleanup, fixtureRepo } from "./test-fixtures";

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });
const TWO = { ...DEFAULT_ACCOUNTS, claude: [DEFAULT_ACCOUNTS.claude[0], { ...DEFAULT_ACCOUNTS.claude[0], slot: "claude:max-2" as never, configDir: "C:/synthetic/.claude-2", label: "Claude Max 2", order: 1 }] };
type SlotPick = { slot: string | null; label: string; reason: string };
const make = (claudeSlot?: (preferred?: string) => SlotPick) => {
  const fx = fixtureRepo();
  roots.push(fx.root);
  const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib" }] };
  return createShaper({ registry: () => registry, accounts: () => TWO as never, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, ...(claudeSlot ? { claudeSlot: claudeSlot as never } : {}) });
};
const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
const say = (shaper: ReturnType<typeof make>, utterance: string) => shaper.shape({ utterance, channel: "typed", principal, usePlanner: false });
/** Everything signed in and below its limit: the preferred slot is the answer. */
const allReady = (preferred?: string): SlotPick => ({ slot: preferred ?? "claude:max", label: preferred === "claude:max-2" ? "Claude Max 2" : "Claude Max", reason: "ready" });

describe("an account named in the words that isn't connected here is refused by name, never replaced", () => {
  test("Claude Max 3 on a server with Max and Max 2: refused, nothing drafted, the connected ones named", async () => {
    const r = await say(make(allReady), "Fix the greeting in src/a.ts of the fixture app using Opus on Claude Max 3.");
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") return;
    expect(r.reason).toContain("Claude Max 3 isn't connected on this server (connected: Claude Max, Claude Max 2)");
    expect(r.reason).toContain("I won't use a different account instead");
  });
  test("the grammar is the strict one: everyday 'max 3' or 'account 2' words are not accounts", () => {
    expect(claudeSlotNamed("allow max 3 retries in src/a.ts")).toBeNull();
    expect(claudeSlotNamed("the balance in account 2 is wrong")).toBeNull();
    expect(claudeSlotNamed("using Opus on Claude Max 3")).toBe("claude:max-3");
    expect(unconnectedAccountWords("using Opus on Claude Max 2", TWO as never)).toBeNull();
  });
});

describe("an account named in the words must be able to take the work now", () => {
  test("Claude Max 2 signed out: refused with why, and the account that could take it is offered (not used)", async () => {
    const pick = (preferred?: string): SlotPick => (preferred === "claude:max-2" ? { slot: "claude:max", label: "Claude Max", reason: "Claude Max, because Claude Max 2: not signed in" } : allReady(preferred));
    const r = await say(make(pick), "Fix the greeting in src/a.ts of the fixture app using Opus on Claude Max 2.");
    expect(r.kind).toBe("refused");
    if (r.kind !== "refused") return;
    expect(r.reason).toBe('Claude Max 2 isn\'t ready (not signed in). Nothing was drafted, and I won\'t use a different account instead. Claude Max could take it: say "using Claude Max" if you want that.');
  });
  test("no Claude account can take work: refused, no alternative invented", async () => {
    const r = await say(make(() => ({ slot: null, label: "Claude Max 2", reason: "No Claude account can take new work (Claude Max: not signed in; Claude Max 2 (connection not checked yet): at its limit)." })), "Fix the greeting in src/a.ts of the fixture app using Opus on Claude Max 2.");
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toMatch(/^Claude Max 2 isn't ready \(at its limit\)\. Nothing was drafted, and I won't use a different account instead\.$/);
  });
});

describe("the words' account and model are pinned on the job", () => {
  test("'using Opus on Claude Max 2' drafts the builder there AND records the pin the orchestrator's fallback respects", async () => {
    const r = await say(make(allReady), "Fix the greeting in src/a.ts of the fixture app using Opus on Claude Max 2.");
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    const b = r.spec.roles.find((x) => x.role === "builder")!.agent!;
    expect([b.accountSlot, b.model]).toEqual(["claude:max-2", "claude-opus-5-5"]);
    expect(r.spec.builderPin).toEqual({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
  });
  test("'using Opus via account 2' (the phrasing that avoids 'Claude Max', which the money guard reads as a subscription) pins both", async () => {
    const r = await say(make(allReady), "Fix the greeting in src/a.ts of the fixture app using Opus via account 2.");
    expect(r.kind).toBe("draft");
    if (r.kind === "draft") expect(r.spec.builderPin).toEqual({ accountSlot: "claude:max-2", model: "claude-opus-5-5" });
    const three = await say(make(allReady), "Fix the greeting in src/a.ts of the fixture app using Opus via account 3.");
    expect(three.kind).toBe("refused");
  });
  test("an account alone pins the account (the model stays the shaper's pick)", async () => {
    const r = await say(make(allReady), "Fix a typo in the label in src/a.ts of the fixture app using Claude Max 2.");
    expect(r.kind).toBe("draft");
    if (r.kind === "draft") expect(r.spec.builderPin).toEqual({ accountSlot: "claude:max-2", model: null });
  });
  test("'using Opus' far from the verb still names the builder (a small change would otherwise get the lighter model)", async () => {
    const r = await say(make(allReady), "Fix a typo in the label in src/a.ts of the fixture app using Opus.");
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    expect(r.spec.roles.find((x) => x.role === "builder")!.agent!.model).toBe("claude-opus-5-5");
    expect(r.spec.builderPin).toEqual({ accountSlot: null, model: "claude-opus-5-5" });
    // A model handed to the reviewer, or one inside the task's own words, is not the builder.
    const review = await say(make(allReady), "Fix a typo in the label in src/a.ts of the fixture app using Sonnet to review.");
    if (review.kind === "draft") expect(review.spec.builderPin).toBeUndefined();
    const inside = await say(make(allReady), "Show the count of jobs using Codex in the table in src/a.ts of the fixture app.");
    if (inside.kind === "draft") expect(inside.spec.builderPin).toBeUndefined();
  });
  test("no account or model in the words: no pin (the automatic pick and the owner's fallback stay as they were)", async () => {
    const r = await say(make(allReady), "Set a to 42 in src/a.ts of the fixture app.");
    expect(r.kind).toBe("draft");
    if (r.kind === "draft") expect(r.spec.builderPin).toBeUndefined();
  });
});

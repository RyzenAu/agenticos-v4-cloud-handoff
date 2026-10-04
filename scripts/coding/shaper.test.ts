// The shaper's objective parser (REVIEW-T3 R5, carried): a task that names an agent or a role inside its
// own text keeps its objective, and Jarvis doesn't ask for it again. Synthetic only: a temp fixture repo,
// no Jev, no planner, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, VerifiedPrincipal } from "./contracts";
import { createShaper, objectiveFrom } from "./shaper";
import { cleanup, fixtureRepo } from "./test-fixtures";

describe("objectiveFrom: agent and role words inside the task survive", () => {
  test.each([
    ["Fix the Claude reviewer badge colour on the Coding page so it's green. Opus builds, Codex reviews.", "Fix the Claude reviewer badge colour on the Coding page so it's green"],
    ["Fix the Claude reviewer badge colour on the Coding page, Opus builds, Codex reviews", "Fix the Claude reviewer badge colour on the Coding page"],
    ["Fix the Claude reviewer badge colour on the Coding page and have Codex review it", "Fix the Claude reviewer badge colour on the Coding page"],
    ["Jarvis, rename the Codex builder label in src/a.ts to 'Builder'. Claude builds.", "rename the Codex builder label in src/a.ts to 'Builder'"],
    ["Make the Opus reviewer card show the review time and use Sonnet for the build", "Make the Opus reviewer card show the review time"],
    ["Change the agent tester column width in the jobs table. Codex builds, Claude reviews.", "Change the agent tester column width in the jobs table"],
  ])("%p", (text, objective) => {
    expect(objectiveFrom(text)).toBe(objective);
  });
  // REVIEW-T1 P1 follow-up: the agent comes FIRST, then the task.
  test.each([
    ["Codex, fix the login bug in the dental site and have Claude review it", "fix the login bug in the dental site"],
    ["ask Codex to fix the login bug in the dental site and Claude to review", "fix the login bug in the dental site"],
    ["ask Codex to fix the failing tests in AgenticOS and Claude to review", "fix the failing tests in AgenticOS"],
    ["assign Codex to build the booking widget in the dental site, Claude reviews", "build the booking widget in the dental site"],
    ["have Opus build the booking widget in the dental site and Sonnet review it", "build the booking widget in the dental site"],
    ["use Codex as the builder to add dark mode to the marketing site", "add dark mode to the marketing site"],
    ["Jarvis, tell Claude to rename the export button on the calls page. Codex reviews.", "rename the export button on the calls page"],
    ["Claude builds and reviews the fix for the calls page crash", "build the fix for the calls page crash"],
    ["Codex fixes the login bug in the dental site, Opus reviews", "fix the login bug in the dental site"],
    ["Codex, fix the footer on the marketing site", "fix the footer on the marketing site"],
  ])("agent first: %p", (text, objective) => {
    expect(objectiveFrom(text)).toBe(objective);
  });
  test("a lead-in with no task after it is still team phrasing, never an objective", () => {
    expect(objectiveFrom("Set a to 42 in src/a.ts. Use Sonnet for the build.")).toBe("Set a to 42 in src/a.ts");
    expect(objectiveFrom("Set a to 42 in src/a.ts. Have Opus build it and Codex review it.")).toBe("Set a to 42 in src/a.ts");
    expect(objectiveFrom("Set a to 42 in src/a.ts. Codex builds it, Claude reviews the code.")).toBe("Set a to 42 in src/a.ts");
    expect(objectiveFrom("Set a to 42 in src/a.ts. Opus builds and Codex reviews.")).toBe("Set a to 42 in src/a.ts");
  });
  test("team-only sentences are still dropped whole (unchanged behaviour)", () => {
    expect(objectiveFrom("Jarvis, set a to 42 in src/a.ts of the fixture app. Opus builds, another Opus reviews. Show me the tests and what changed.")).toBe("set a to 42 in src/a.ts of the fixture app");
    expect(objectiveFrom("Jarvis, fix the receptionist dashboard. Have an Opus builder implement it and another Opus agent review it. Show me the tests and what changed.")).toBe("fix the receptionist dashboard");
    expect(objectiveFrom("Make the tasks panel button label match the page title. Codex builds, Claude reviews.")).toBe("Make the tasks panel button label match the page title");
    expect(objectiveFrom("update README.md in AgenticOS. Codex builds.")).toBe("update README.md in AgenticOS");
    expect(objectiveFrom("Fix the calls table in the receptionist app: yesterday's calls show as today. Opus builds, another Opus reviews.")).toBe("Fix the calls table in the receptionist app: yesterday's calls show as today");
  });
});

describe("the shaper keeps the objective and drafts, rather than asking what should change", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  test("'Fix the Claude reviewer badge colour…' names an agent and a role, and still drafts with its objective", async () => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib" }] };
    const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
    const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
    const r = await shaper.shape({ utterance: "Fix the Claude reviewer badge colour in src/a.ts so it's green. Opus builds, Codex reviews.", channel: "typed", principal, usePlanner: false });
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    expect(r.spec.objective).toBe("Fix the Claude reviewer badge colour in src/a.ts so it's green");
    // Agent first (REVIEW-T1 P1 follow-up): drafts with the task, and the named reviewer is kept.
    const first = await shaper.shape({ utterance: "Codex, fix the login bug in src/a.ts so the form submits and have Claude review it", channel: "typed", principal, usePlanner: false });
    expect(first.kind).toBe("draft");
    if (first.kind !== "draft") return;
    expect(first.spec.objective).toBe("fix the login bug in src/a.ts so the form submits");
  });
});

describe("a pinned builder (an Agents bot's coding setting) is exactly that account and model, or the request is refused", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const TWO = { ...DEFAULT_ACCOUNTS, claude: [DEFAULT_ACCOUNTS.claude[0], { ...DEFAULT_ACCOUNTS.claude[0], slot: "claude:max-2" as never, label: "Claude Max 2", order: 1 }] };
  const make = () => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib" }] };
    return createShaper({ registry: () => registry, accounts: () => TWO, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
  };
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
  const ask = (shaper: ReturnType<typeof make>, pin: { accountSlot?: string | null; model?: string | null }, utterance = "Set a to 42 in src/a.ts of the fixture app.") =>
    shaper.shape({ utterance, channel: "typed", principal, usePlanner: false, pin });

  test("a Claude slot and model: the builder is that slot and that model (and the words of the request are untouched)", async () => {
    const r = await ask(make(), { accountSlot: "claude:max-2", model: "claude-sonnet-5-5" });
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    const b = r.spec.roles.find((x) => x.role === "builder")!.agent!;
    expect([b.accountSlot, b.model]).toEqual(["claude:max-2", "claude-sonnet-5-5"]);
  });

  test("a Codex slot and model: the builder is that Codex slot and model", async () => {
    const r = await ask(make(), { accountSlot: "codex:openai-2", model: "gpt-5.5" });
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") return;
    const b = r.spec.roles.find((x) => x.role === "builder")!.agent!;
    expect([b.accountSlot, b.model]).toEqual(["codex:openai-2", "gpt-5.5"]);
  });

  test("a model alone is that model on the automatic slot; an unknown model, an unconfigured slot, or a slot that doesn't run the model is refused with a reason", async () => {
    const shaper = make();
    const auto = await ask(shaper, { model: "claude-haiku-4-5" });
    expect(auto.kind).toBe("draft");
    if (auto.kind === "draft") expect(auto.spec.roles.find((x) => x.role === "builder")!.agent!.model).toBe("claude-haiku-4-5");
    for (const pin of [{ model: "gpt-9-nonsense" }, { accountSlot: "claude:max-7", model: null }, { accountSlot: "codex:openai-3", model: null }, { accountSlot: "claude:max-2", model: "gpt-5.5" }]) {
      const r = await ask(shaper, pin);
      expect(r.kind).toBe("refused");
      if (r.kind === "refused") expect(r.reason).toMatch(/no other account or model was used|isn't a model this harness offers/);
    }
  });

  test("words that name a model of a different family than the pinned slot are refused, never quietly swapped", async () => {
    const r = await ask(make(), { accountSlot: "claude:max-2", model: null }, "Set a to 42 in src/a.ts of the fixture app. Codex builds.");
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("claude:max-2");
  });
});

describe("a pin with one field open fills it the way the shaper normally would", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const claude0 = DEFAULT_ACCOUNTS.claude[0];
  const codex0 = DEFAULT_ACCOUNTS.codex[0];
  const ACCOUNTS = {
    ...DEFAULT_ACCOUNTS,
    claude: [claude0, { ...claude0, slot: "claude:max-2" as never, label: "Claude Max 2", order: 1 }],
    // Array order is NOT selection order: openai-3 (order 0) is the normal pick; openai-2 is first in the file.
    codex: [{ ...codex0, slot: "codex:openai-2" as never, order: 1 }, { ...codex0, slot: "codex:openai-3" as never, order: 0 }],
  };
  const make = (claudeSlot?: () => { slot: never | null; label: string; reason: string }) => {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app: src and lib" }] };
    return createShaper({ registry: () => registry, accounts: () => ACCOUNTS as never, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, ...(claudeSlot ? { claudeSlot: claudeSlot as never } : {}) });
  };
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
  const ask = (shaper: ReturnType<typeof make>, pin: { accountSlot?: string | null; model?: string | null }, utterance: string) =>
    shaper.shape({ utterance, channel: "typed", principal, usePlanner: false, pin });
  const builderOf = (r: Awaited<ReturnType<ReturnType<typeof make>["shape"]>>) => {
    expect(r.kind).toBe("draft");
    if (r.kind !== "draft") throw new Error("not a draft");
    const a = r.spec.roles.find((x) => x.role === "builder")!.agent!;
    return [a.accountSlot, a.model];
  };

  test("an account alone keeps the model the shaper would choose (a small change: the lighter model), not a hard-coded one", async () => {
    const small = await ask(make(), { accountSlot: "claude:max-2" }, "Fix a typo in the label in src/a.ts of the fixture app.");
    expect(builderOf(small)).toEqual(["claude:max-2", "claude-sonnet-5-5"]);
    const big = await ask(make(), { accountSlot: "claude:max-2" }, "Set a to 42 in src/a.ts of the fixture app.");
    expect(builderOf(big)).toEqual(["claude:max-2", "claude-opus-5-5"]);
  });

  test("a model alone takes the normal Codex slot selection, not the first account in the file", async () => {
    const r = await ask(make(), { model: "gpt-5.5" }, "Set a to 42 in src/a.ts of the fixture app.");
    expect(builderOf(r)).toEqual(["codex:openai-3", "gpt-5.5"]);
  });

  test("a Claude model alone takes the automatic Claude pick; when no Claude account can take work it is refused, never sent to claude:max", async () => {
    const ok = await ask(make(() => ({ slot: "claude:max-2" as never, label: "Claude Max 2", reason: "least used" })), { model: "claude-haiku-4-5" }, "Set a to 42 in src/a.ts of the fixture app.");
    expect(builderOf(ok)).toEqual(["claude:max-2", "claude-haiku-4-5"]);
    const none = await ask(make(() => ({ slot: null, label: "none", reason: "every Claude account is at its limit" })), { model: "claude-haiku-4-5" }, "Set a to 42 in src/a.ts of the fixture app.");
    expect(none.kind).toBe("refused");
    if (none.kind === "refused") expect(none.reason).toContain("every Claude account is at its limit");
  });
});

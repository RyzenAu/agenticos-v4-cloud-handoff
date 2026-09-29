// Who builds and who reviews when the words don't say (role-choice.ts, and the shaper's use of it). Synthetic
// only: an injected router and key lookup, a temp fixture repo, no Jev, no planner, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, VerifiedPrincipal } from "./contracts";
import { chooseRoles, DEFAULT_CODING_PREFS, loadCodingPrefs, type ChoiceEnv, type CodingModelPrefs } from "./role-choice";
import { createShaper, spokenSummary } from "./shaper";
import { claudeBinding, codexBinding, routerBinding } from "./spec";
import { cleanup, fixtureRepo, tempRoot } from "./test-fixtures";

const FREE = ["cline/deepseek-v4.1-flash", "cline/mimo-v2.6-flash", "cline/muse-spark-1.3"];
/** A router whose free Cline routes are all healthy: route() answers with the selected model. */
const healthyRoute = ((_task: string, c: { selected?: string }) => ({ model: c.selected, fallbackFrom: null })) as unknown as ChoiceEnv["route"];
const env = (over: Partial<ChoiceEnv> = {}): ChoiceEnv => ({ cliVersions: { claude: "2.1.280", codex: "0.154.0" }, accounts: DEFAULT_ACCOUNTS, readings: [], route: healthyRoute, hasKey: () => true, ...over });
const none = { builder: null, reviewer: null };
const pick = (text: string, over: { prefs?: Partial<CodingModelPrefs>; env?: Partial<ChoiceEnv>; named?: Parameters<typeof chooseRoles>[0]["named"]; template?: "build+review" | "build-only"; jev?: Parameters<typeof chooseRoles>[0]["jev"] } = {}) =>
  chooseRoles({ text, template: over.template ?? "build+review", named: over.named ?? none, env: env(over.env), prefs: { ...DEFAULT_CODING_PREFS, ...over.prefs }, jev: over.jev });

describe("role-choice: an independent reviewer, never the builder's own model", () => {
  test("no model named: builder and reviewer differ, in different provider families, each with a why", () => {
    const r = pick("fix the login bug in the dental site");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.builder.binding).toMatchObject({ model: "claude-opus-5-5" });
    expect(r.reviewer!.binding.model).toBe("gpt-6-astra");
    expect(r.reviewer!.choice.family).not.toBe(r.builder.choice.family);
    expect(r.builder.choice).toMatchObject({ role: "builder", basis: "auto" });
    expect(r.reviewer!.choice.why).toContain("isn't checking its own work");
    expect(r.builder.choice.why.length).toBeGreaterThan(10);
  });
  test("only Claude connected: the reviewer is a different Claude model, not the builder's", () => {
    const r = pick("fix the login bug in the dental site", { env: { codexAvailable: false } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.binding.model).toBe("claude-opus-5-5");
    expect(r.reviewer!.binding.model).toBe("claude-sonnet-5");
    expect(r.reviewer!.choice.why).toContain("different model");
  });
  test("Claude at its window: Codex builds and a free route reviews, so the two still differ", () => {
    const r = pick("fix the login bug in the dental site", { env: { claudeBlocked: "Claude's 5h window is at 97%." } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.binding.model).toBe("gpt-6-astra");
    expect(r.builder.binding).toMatchObject({ route: "codex-app-server", accountSlot: "codex:openai-2" });
    expect(r.reviewer!.binding.model).not.toBe("gpt-6-astra");
    expect(FREE).toContain(r.reviewer!.binding.model);
  });
  test("a small change goes to the lighter model; test repair goes to Codex", () => {
    const small = pick("fix the typo in the pricing label");
    if (!small.ok) throw new Error(small.reason);
    expect(small.builder.binding.model).toBe("claude-sonnet-5");
    expect(small.builder.choice.why).toContain("allowance");
    expect(small.reviewer!.binding.model).toBe("gpt-6-astra");
    const tests = pick("fix the failing tests in AgenticOS");
    if (!tests.ok) throw new Error(tests.reason);
    expect(tests.builder.binding.model).toBe("gpt-6-astra");
    expect(tests.reviewer!.binding.model).toBe("claude-opus-5-5");
  });
  test("Codex isolation not applied: Codex is not picked (it would pause), so nothing is planned onto it", () => {
    const r = pick("fix the login bug in the dental site", { env: { codexReady: false } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.binding.model).toBe("claude-opus-5-5");
    expect(r.reviewer!.binding.model).toBe("claude-sonnet-5");
  });
  test("a Codex slot that would draw paid credits is never picked automatically", () => {
    const accounts = { version: 1 as const, codex: [{ slot: "codex:openai-1" as const, codexHome: null, plan: "chatgpt-pro" as const, creditsAllowed: true, order: 0 }] };
    const r = pick("fix the login bug in the dental site", { env: { accounts, readings: [{ slot: "codex:openai-1", peakPercent: 99, resetsAt: null, readAt: null }] } });
    if (!r.ok) throw new Error(r.reason);
    expect([r.builder.binding.model, r.reviewer!.binding.model]).not.toContain("gpt-6-astra");
  });
  test("build-only has no reviewer", () => {
    const r = pick("fix the login bug", { template: "build-only" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reviewer).toBeNull();
  });
});

describe("role-choice: words win; prefs and Jev fill the rest", () => {
  test("a named builder is kept (basis named) and the reviewer is picked independent of it", () => {
    const r = pick("Codex fixes the login bug", { named: { builder: codexBinding("gpt-6-astra", "codex:openai-2", "0.154.0"), reviewer: null } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.choice).toMatchObject({ basis: "named", model: "gpt-6-astra" });
    expect(r.reviewer!.binding.model).toBe("claude-opus-5-5");
  });
  test("a named reviewer keeps the auto builder off that model", () => {
    const r = pick("fix it", { named: { builder: null, reviewer: claudeBinding("claude-opus-5-5", "2.1.280") } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reviewer!.choice.basis).toBe("named");
    expect(r.builder.binding.model).toBe("gpt-6-astra");
  });
  test("both named the same model (\"Opus builds, another Opus reviews\") is allowed: the words win", () => {
    const opus = claudeBinding("claude-opus-5-5", "2.1.280");
    const r = pick("Opus builds, another Opus reviews", { named: { builder: opus, reviewer: opus } });
    if (!r.ok) throw new Error(r.reason);
    expect([r.builder.choice.basis, r.reviewer!.choice.basis]).toEqual(["named", "named"]);
  });
  test("saved preferences go first, and say so", () => {
    const r = pick("fix the login bug", { prefs: { preferred: ["gpt-6-astra"] } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.binding.model).toBe("gpt-6-astra");
    expect(r.builder.choice).toMatchObject({ basis: "preferred" });
    expect(r.builder.choice.why).toContain("your saved preference");
    expect(r.reviewer!.binding.model).toBe("claude-opus-5-5");
  });
  test("Jev's proposal is used when available and recorded; an unavailable proposal is ignored", () => {
    const r = pick("fix the login bug", { jev: { builder: "claude-sonnet-5", reviewer: "gpt-6-astra" } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.builder.choice).toMatchObject({ basis: "jev", model: "claude-sonnet-5" });
    expect(r.reviewer!.choice).toMatchObject({ basis: "jev", model: "gpt-6-astra" });
    const gone = pick("fix the login bug", { env: { codexAvailable: false }, jev: { builder: "gpt-6-astra" } });
    if (!gone.ok) throw new Error(gone.reason);
    expect(gone.builder.binding.model).toBe("claude-opus-5-5");
    expect(gone.builder.choice.basis).toBe("auto");
  });
  test("Jev cannot pick the builder's model for the reviewer", () => {
    const r = pick("fix the login bug", { jev: { builder: "claude-opus-5-5", reviewer: "claude-opus-5-5" } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reviewer!.binding.model).not.toBe(r.builder.binding.model);
  });
});

describe("role-choice: free-only", () => {
  test("no paid model is chosen: builder and reviewer are two different free Cline routes", () => {
    const r = pick("fix the login bug in the dental site", { prefs: { freeOnly: true } });
    if (!r.ok) throw new Error(r.reason);
    for (const p of [r.builder, r.reviewer!]) {
      expect(p.binding.route).toBe("model-router");
      expect(FREE).toContain(p.binding.model);
      expect(p.choice.why).toContain("free-only is on");
    }
    expect(r.builder.binding.model).not.toBe(r.reviewer!.binding.model);
  });
  test("free-only with no free route set up says so instead of choosing a paid model", () => {
    const r = pick("fix the login bug", { prefs: { freeOnly: true }, env: { route: (() => { throw new Error("not configured"); }) as never } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no free coding route");
  });
  test("an explicitly named paid model is refused with the way out; a named free model is fine", () => {
    const paid = pick("Opus builds", { prefs: { freeOnly: true }, named: { builder: claudeBinding("claude-opus-5-5", "2.1.280"), reviewer: null } });
    expect(paid.ok).toBe(false);
    if (!paid.ok) { expect(paid.reason).toContain("Free-only is on"); expect(paid.reason).toContain("Opus"); expect(paid.reason).toContain("coding-prefs.json"); }
    const hermes = pick("Hermes reviews", { prefs: { freeOnly: true }, named: { builder: null, reviewer: routerBinding("codex/gpt-6-sol") } });
    expect(hermes.ok).toBe(false);
    const free = pick("DeepSeek builds", { prefs: { freeOnly: true }, named: { builder: routerBinding("cline/deepseek-v4.1-flash"), reviewer: null } });
    if (!free.ok) throw new Error(free.reason);
    expect(free.builder.choice.basis).toBe("named");
    expect(free.reviewer!.binding.model).not.toBe("cline/deepseek-v4.1-flash");
  });
});

describe("coding-prefs.json", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) cleanup(d); });
  const write = (text: string) => { const d = tempRoot("prefs-"); dirs.push(d); mkdirSync(d, { recursive: true }); const f = join(d, "coding-prefs.json"); writeFileSync(f, text); return f; };
  test("missing file = safe default: paid subscription allowed, paid fallback as today, free-only off", () => {
    const d = tempRoot("prefs-"); dirs.push(d);
    expect(loadCodingPrefs(join(d, "coding-prefs.json"))).toEqual({ prefs: DEFAULT_CODING_PREFS, problem: null });
    expect(DEFAULT_CODING_PREFS).toEqual({ freeOnly: false, allowPaidFallback: true });
  });
  test("a valid file is read; an invalid one is ignored with the reason (never a paid surprise)", () => {
    expect(loadCodingPrefs(write(JSON.stringify({ freeOnly: true, preferred: ["cline/mimo-v2.6-flash"] }))).prefs).toEqual({ freeOnly: true, allowPaidFallback: true, preferred: ["cline/mimo-v2.6-flash"] });
    expect(loadCodingPrefs(write(JSON.stringify({ allowPaidFallback: false }))).prefs.allowPaidFallback).toBe(false);
    const bad = loadCodingPrefs(write(JSON.stringify({ freeOnly: "yes" })));
    expect(bad.prefs).toEqual(DEFAULT_CODING_PREFS);
    expect(bad.problem).toContain("freeOnly must be true or false");
    expect(loadCodingPrefs(write("{not json")).problem).toContain("ignored");
  });
});

describe("the shaper records who was chosen and why, and says it", () => {
  const roots: string[] = [];
  afterAll(() => { for (const r of roots) cleanup(r); });
  const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;
  function shaperWith(prefs?: CodingModelPrefs) {
    const fx = fixtureRepo();
    roots.push(fx.root);
    const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app" }] };
    return createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, prefs: prefs ? () => prefs : undefined, choice: () => ({ route: healthyRoute, hasKey: () => true, readings: [] }) });
  }
  test("'assign a builder to fix X and a reviewer to check it' drafts a builder and a DIFFERENT reviewer with reasons in the spec and the summary", async () => {
    const r = await shaperWith().shape({ utterance: "Jarvis, assign a builder to fix the login bug in src/a.ts so the form submits and a reviewer to check it", channel: "voice", principal, usePlanner: false });
    if (r.kind !== "draft") throw new Error(JSON.stringify(r));
    const roles = r.spec.roles.filter((x) => x.agent);
    const builder = roles.find((x) => x.role === "builder")!.agent!;
    const reviewer = roles.find((x) => x.role === "reviewer")!.agent!;
    expect(builder.model).not.toBe(reviewer.model);
    expect(r.spec.objective).toBe("fix the login bug in src/a.ts so the form submits");
    expect(r.spec.roleChoices?.map((c) => [c.role, c.model, c.basis])).toEqual([["builder", "claude-opus-5-5", "auto"], ["reviewer", "gpt-6-astra", "auto"]]);
    expect(r.spokenSummary).toContain("Builder: Opus,");
    expect(r.spokenSummary).toContain("Reviewer: Codex, a different provider than the builder");
    expect(r.spokenSummary).toMatch(/Say start when you want it built\.$/);
    expect(spokenSummary(r.spec)).toBe(r.spokenSummary);
  });
  test("named models still win and add no 'why' sentence", async () => {
    const r = await shaperWith().shape({ utterance: "Fix the login bug in src/a.ts so the form submits. Codex builds, Opus reviews.", channel: "voice", principal, usePlanner: false });
    if (r.kind !== "draft") throw new Error(JSON.stringify(r));
    expect(r.spec.roleChoices?.map((c) => [c.role, c.model, c.basis])).toEqual([["builder", "gpt-6-astra", "named"], ["reviewer", "claude-opus-5-5", "named"]]);
    expect(r.spokenSummary).not.toContain("Builder:");
  });
  test("free-only prefs: no paid model in the draft; a named paid model is refused and the reply says which", async () => {
    const shaper = shaperWith({ freeOnly: true, allowPaidFallback: true });
    const auto = await shaper.shape({ utterance: "assign a builder to fix the login bug in src/a.ts so the form submits and a reviewer to check it", channel: "voice", principal, usePlanner: false });
    if (auto.kind !== "draft") throw new Error(JSON.stringify(auto));
    for (const role of auto.spec.roles.filter((x) => x.agent)) expect(role.agent!.model.startsWith("cline/")).toBe(true);
    expect(auto.spokenSummary).toContain("free only");
    const named = await shaper.shape({ utterance: "Fix the login bug in src/a.ts so the form submits. Opus builds.", channel: "voice", principal, usePlanner: false });
    expect(named.kind).toBe("refused");
    if (named.kind === "refused") expect(named.reason).toMatch(/Free-only is on, so I won't run Opus/);
  });
  test("a spec drafted before role-choice existed (no roleChoices) still validates the same: the field is optional and leaves digests alone", async () => {
    const r = await shaperWith().shape({ utterance: "Fix the login bug in src/a.ts so the form submits. Opus builds, Codex reviews.", channel: "voice", principal, usePlanner: false });
    if (r.kind !== "draft") throw new Error(JSON.stringify(r));
    const { roleChoices: _drop, ...legacy } = r.spec;
    expect("roleChoices" in legacy).toBe(false);
    expect(spokenSummary(legacy as never)).toContain("Selected routes");
  });
});

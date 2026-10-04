// Model selection words (1 Oct 2026, successor to coding job fd219e20): "Cline MiMo Flash free" and
// "Cline Muse Spark free" pick the right free Cline routes, typed and spoken; a bare MiMo or DeepSeek is the FREE
// Flash route; a PAID route is selected only when asked for by name, and is disclosed before Start.
// Synthetic only: an injected router, a temp fixture repo, no Jev, no planner, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, TaskSpec, VerifiedPrincipal } from "./contracts";
import type { ChoiceEnv, CodingModelPrefs } from "./role-choice";
import { createShaper, spokenSummary } from "./shaper";
import { cleanup, fixtureRepo } from "./test-fixtures";
import { createCodingVoice } from "./voice";

const MIMO = "cline/mimo-v2.6-flash";
const MUSE = "cline/muse-spark-1.3";
const DEEPSEEK_FREE = "cline/deepseek-v4.1-flash";
const DEEPSEEK_PAID = "openrouter/deepseek-v4-pro";
const MIMO_PAID = "openrouter/mimo-v2.6-pro";

const healthyRoute = ((_t: string, c: { selected?: string }) => ({ model: c.selected, fallbackFrom: null })) as unknown as ChoiceEnv["route"];
const principal = { personId: "usman", via: "local", deviceId: "usman-pc", sessionId: "synthetic" } as unknown as VerifiedPrincipal;

const roots: string[] = [];
afterAll(() => { for (const r of roots) cleanup(r); });
function shaperWith(prefs?: CodingModelPrefs) {
  const fx = fixtureRepo();
  roots.push(fx.root);
  const registry: RepoRegistry = { version: 1, repos: [{ ...fx.entry, id: "fixture-app" as never, description: "the synthetic fixture app" }] };
  return createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null, prefs: prefs ? () => prefs : undefined, choice: () => ({ route: healthyRoute, hasKey: () => true, readings: [] }) });
}
const shaper = shaperWith();
const bind = (text: string) => shaper.bindingFromWords(text);
const agentOf = (spec: TaskSpec, role: string) => spec.roles.find((r) => r.role === role)?.agent ?? null;
async function draft(utterance: string, s = shaper, channel: "typed" | "voice" = "typed") {
  const r = await s.shape({ utterance, channel, principal, usePlanner: false });
  if (r.kind !== "draft") throw new Error(JSON.stringify(r));
  return r;
}

describe("Cline free models are selected by name, in their usual spellings", () => {
  test.each([
    ["Cline MiMo Flash free", MIMO],
    ["cline mimo flash free", MIMO],
    ["CLINE MIMO FLASH FREE", MIMO],
    ["Cline MiMo Flash", MIMO],
    ["cline mimo-flash", MIMO],
    ["Cline MiMo v2.6 Flash free.", MIMO],
    ["mimo-flash", MIMO],
    ["MiMo via Cline", MIMO],
    ["use MiMo via cline,", MIMO],
    ["Cline Muse Spark free", MUSE],
    ["cline muse spark free", MUSE],
    ["Cline Muse-Spark", MUSE],
    ["Cline Muse Spark 1.3 free!", MUSE],
    ["muse spark", MUSE],
    ["muse-spark via Cline", MUSE],
    ["Cline DeepSeek Flash free", DEEPSEEK_FREE],
    ["cline deep-seek flash", DEEPSEEK_FREE],
  ])("%p selects %s on the free Cline route", (text, model) => {
    const b = bind(text);
    expect(b).toMatchObject({ provider: "router", route: "model-router", model });
    expect(b!.model.startsWith("cline/")).toBe(true);
  });
  test("a bare MiMo or DeepSeek is the FREE Cline Flash route, never a paid one", () => {
    expect(bind("MiMo")!.model).toBe(MIMO);
    expect(bind("Use mimo")!.model).toBe(MIMO);
    expect(bind("DeepSeek")!.model).toBe(DEEPSEEK_FREE);
    expect(bind("use deepseek for it")!.model).toBe(DEEPSEEK_FREE);
    expect(bind("deep seek")!.model).toBe(DEEPSEEK_FREE);
    expect(bind("Cline")!.model).toBe(DEEPSEEK_FREE);
  });
  test("a free route's draft says 'free only' and carries no paid-route warning", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Cline MiMo Flash free builds, Cline Muse Spark free reviews.");
    expect(agentOf(r.spec, "builder")!.model).toBe(MIMO);
    expect(agentOf(r.spec, "reviewer")!.model).toBe(MUSE);
    expect(r.spokenSummary).toContain("(free only)");
    expect(r.spokenSummary).not.toMatch(/paid/i);
  });
});

describe("a paid route is selected only by name, and is said before Start", () => {
  test.each([
    ["paid DeepSeek", DEEPSEEK_PAID],
    ["Paid deepseek", DEEPSEEK_PAID],
    ["OpenRouter DeepSeek", DEEPSEEK_PAID],
    ["DeepSeek Pro", DEEPSEEK_PAID],
    ["deepseek-v4-pro", DEEPSEEK_PAID],
    ["DeepSeek via OpenRouter", DEEPSEEK_PAID],
    ["paid MiMo", MIMO_PAID],
    ["OpenRouter MiMo", MIMO_PAID],
    ["MiMo Pro", MIMO_PAID],
    ["mimo-v2.6-pro", MIMO_PAID],
    ["MiMo via OpenRouter", MIMO_PAID],
  ])("%p stays selectable as %s", (text, model) => {
    expect(bind(text)).toMatchObject({ route: "model-router", model });
  });
  test("a paid route named for the builder is drafted as asked and disclosed in the spoken summary", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Paid DeepSeek builds.");
    expect(agentOf(r.spec, "builder")!.model).toBe(DEEPSEEK_PAID);
    // The route list says PAID, and a plain sentence precedes the Start question.
    expect(r.spokenSummary).toContain("PAID");
    expect(r.spokenSummary).toMatch(/Paid route: DeepSeek Pro \(paid\) costs money per token through OpenRouter/);
    expect(r.spokenSummary).toContain("builder-1: openrouter/deepseek-v4-pro (PAID");
    expect(r.spokenSummary).toMatch(/Start it\?$/);
    expect(spokenSummary(r.spec)).toBe(r.spokenSummary);
  });
  test("a paid MiMo reviewer is disclosed too, and it differs from the builder", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Opus builds and OpenRouter MiMo reviews.");
    expect(agentOf(r.spec, "builder")!.model).toBe("claude-opus-5-5");
    expect(agentOf(r.spec, "reviewer")!.model).toBe(MIMO_PAID);
    expect(r.spokenSummary).toMatch(/Paid route: MiMo Pro \(paid\)/);
  });
  test("generic MiMo / DeepSeek requests never resolve to a paid route unannounced", async () => {
    for (const words of ["Fix the login bug in src/a.ts so the form submits. MiMo builds.", "Fix the login bug in src/a.ts so the form submits. DeepSeek builds, Muse Spark reviews."]) {
      const r = await draft(words);
      for (const role of r.spec.roles.filter((x) => x.agent)) {
        if (role.agent!.model.startsWith("openrouter/")) expect(r.spokenSummary).toMatch(/Paid route/);
        else expect(r.spokenSummary).not.toMatch(/Paid route/);
      }
      expect(agentOf(r.spec, "builder")!.model.startsWith("cline/")).toBe(true);
    }
  });
  test("free-only still refuses a named paid route, with the way out", async () => {
    const s = shaperWith({ freeOnly: true, allowPaidFallback: true });
    const r = await s.shape({ utterance: "Fix the login bug in src/a.ts so the form submits. Paid DeepSeek builds.", channel: "typed", principal, usePlanner: false });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toMatch(/Free-only is on/);
  });
});

describe("the role words keep each model with its own role", () => {
  test("'DeepSeek builds and MiMo reviews' is DeepSeek-builds, MiMo-reviews (the old reading gave both to DeepSeek)", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Cline DeepSeek Flash builds and Cline MiMo Flash reviews.");
    expect(agentOf(r.spec, "builder")!.model).toBe(DEEPSEEK_FREE);
    expect(agentOf(r.spec, "reviewer")!.model).toBe(MIMO);
  });
  test("'MiMo reviews and DeepSeek builds' the other way round", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. MiMo reviews and DeepSeek builds.");
    expect(agentOf(r.spec, "builder")!.model).toBe(DEEPSEEK_FREE);
    expect(agentOf(r.spec, "reviewer")!.model).toBe(MIMO);
  });
  test("the model words are not left in the objective", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Paid DeepSeek builds and Cline Muse Spark free reviews it.");
    expect(r.spec.objective).not.toMatch(/deepseek|muse|paid/i);
  });
});

describe("spoken, through voice.ts: the same words draft the same routes", () => {
  function voiceWith() {
    const drafted: TaskSpec[] = [];
    const sh = shaperWith();
    const voice = createCodingVoice({
      store: { getJob: () => null, listJobs: () => [] } as never,
      orch: { draft: (spec: TaskSpec) => { drafted.push(spec); return { job: { id: "job-1", spec }, validation: { ok: true, errors: [] } }; }, liveRoles: () => [] } as never,
      shaper: sh,
      approvals: () => null,
      spoken: { ask: () => ({ id: "q1", at: Date.now() }) } as never,
      cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }),
      setFocus: () => {},
    });
    const caller = { id: "usman", name: "Usman", via: "local", actor: "human" } as never;
    return { drafted, say: async (text: string) => voice.handle(text, { caller, spokenYes: null, previousAssistant: null }) };
  }
  test("a spoken request names Cline MiMo Flash free and Cline Muse Spark free", async () => {
    const v = voiceWith();
    const reply = await v.say("Jarvis, fix the login bug in src/a.ts so the form submits. Cline MiMo Flash free builds and Cline Muse Spark free reviews it.");
    expect(reply?.say).toMatch(/Draft ready/);
    const spec = v.drafted[0];
    expect(agentOf(spec, "builder")!.model).toBe(MIMO);
    expect(agentOf(spec, "reviewer")!.model).toBe(MUSE);
    expect(reply!.say).toContain("(free only)");
  });
  test("a spoken paid route is read out as paid before 'Start it?'", async () => {
    const v = voiceWith();
    const reply = await v.say("Jarvis, fix the login bug in src/a.ts so the form submits. Paid MiMo builds.");
    expect(agentOf(v.drafted[0], "builder")!.model).toBe(MIMO_PAID);
    expect(reply!.say).toMatch(/Paid route: MiMo Pro \(paid\) costs money per token/);
    expect(reply!.say).toMatch(/Start it\?$/);
  });
});

describe("free intent is never turned into a paid route (review defect 1)", () => {
  test.each([
    ["free DeepSeek rather than via OpenRouter", DEEPSEEK_FREE],
    ["Cline MiMo, not MiMo Pro", MIMO],
    ["MiMo Flash free, avoid the paid mimo", MIMO],
    ["don't use paid DeepSeek, use cline deepseek", DEEPSEEK_FREE],
    ["deepseek on openrouter free tier", DEEPSEEK_FREE],
    ["do not use paid MiMo, use MiMo", MIMO],
    ["MiMo without OpenRouter", MIMO],
    ["DeepSeek instead of OpenRouter DeepSeek", DEEPSEEK_FREE],
  ])("%p selects the free route %s", (text, model) => {
    expect(bind(text)!.model).toBe(model);
  });
  test.each([
    ["MiMo 2.6 Pro", MIMO_PAID],
    ["MiMo v2.6 Pro", MIMO_PAID],
    ["mimo-2.6-pro", MIMO_PAID],
    ["use paid DeepSeek for the build", DEEPSEEK_PAID],
    ["paid DeepSeek", DEEPSEEK_PAID],
  ])("an explicit paid request %p still selects %s", (text, model) => {
    expect(bind(text)!.model).toBe(model);
  });
  test("the role words honour the same guards", async () => {
    const r = await draft("Fix the login bug in src/a.ts so the form submits. Cline MiMo Flash free builds, not MiMo Pro. Muse Spark reviews.");
    expect(agentOf(r.spec, "builder")!.model).toBe(MIMO);
    expect(r.spokenSummary).not.toMatch(/Paid route/);
  });
});

describe("a same-model reviewer needs 'another <model> reviews' in so many words (review defect 8)", () => {
  test.each([
    "Fix the bug in src/a.ts so it submits. Opus builds the new reviewer page, Opus reviews it.",
    "Fix the bug in src/a.ts so it submits. Sonnet fixes the second agent bug and Sonnet reviews it.",
    "Fix the bug in src/a.ts so it submits. Opus builds. Opus reviews the new session handling.",
  ])("%p is split into two models", async (words) => {
    const r = await draft(words);
    expect(agentOf(r.spec, "reviewer")!.model).not.toBe(agentOf(r.spec, "builder")!.model);
  });
  test.each([
    "Fix the bug in src/a.ts so it submits. Opus builds, another Opus reviews.",
    "Fix the bug in src/a.ts so it submits. Opus builds and a fresh Opus session reviews it.",
    "Fix the bug in src/a.ts so it submits. Opus builds, another Opus agent reviews it.",
  ])("%p keeps the fresh same-model session the owner asked for", async (words) => {
    const r = await draft(words);
    expect(agentOf(r.spec, "reviewer")!.model).toBe(agentOf(r.spec, "builder")!.model);
  });
});

describe("second review: more ways of saying no to paid, and a free cue that must name the model", () => {
  test.each([
    ["I don't want DeepSeek Pro, just DeepSeek", DEEPSEEK_FREE],
    ["Use MiMo, no MiMo Pro", MIMO],
    ["Use DeepSeek but skip OpenRouter DeepSeek", DEEPSEEK_FREE],
    ["DeepSeek Pro is too pricey so use DeepSeek", DEEPSEEK_FREE],
    ["I do not want the paid MiMo, use MiMo", MIMO],
    ["paid DeepSeek is too expensive, use DeepSeek", DEEPSEEK_FREE],
    ["MiMo Pro is way too costly so MiMo", MIMO],
    ["never use OpenRouter MiMo, use MiMo", MIMO],
  ])("%p stays on the free route", (text, model) => {
    expect(bind(text)!.model).toBe(model);
  });
  test.each([
    ["Use paid DeepSeek and make the parser error-free", DEEPSEEK_PAID],
    ["OpenRouter MiMo please, and fix the flash of unstyled content", MIMO_PAID],
    ["paid DeepSeek, and make the page free to edit", DEEPSEEK_PAID],
    ["Cline MiMo reviews, paid DeepSeek builds", DEEPSEEK_PAID],
    ["use paid DeepSeek, free MiMo for the review", DEEPSEEK_PAID],
    ["paid MiMo, then DeepSeek Flash free", MIMO_PAID],
  ])("%p still selects the paid route %s", (text, model) => {
    expect(bind(text)!.model).toBe(model);
  });
  test.each([
    ["free DeepSeek", DEEPSEEK_FREE],
    ["MiMo Flash", MIMO],
    ["deepseek via cline", DEEPSEEK_FREE],
    ["DeepSeek on the free tier", DEEPSEEK_FREE],
  ])("a named free cue %p is free", (text, model) => {
    expect(bind(text)!.model).toBe(model);
  });
});

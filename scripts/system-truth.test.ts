// System page truth (UI-truth review, 28 Sep 2026): tools that work are not "needing setup" (H2),
// only a verified probe reads as Ready and Codex models count under Codex (M3), the plan-limit
// line says "resets" once (L1), and the model check never blocks the page (L7). Synthetic data only.
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { discoverClaudeModels, discoverCodexModels } from "./assistant-adapters";
import { catalogSnapshots } from "./assistant-catalog-snapshot";
import { fmtResetIn } from "../src/lib/ai-usage";
import {
  distinctModelCount,
  modelCheckView,
  modelCountsByProvider,
  modelHarness,
  planWindowLine,
  providerSummary,
  providerView,
  toolAttentionLabel,
  toolCounts,
  toolStatusView,
  type Capabilities,
  type ProviderStatus,
} from "../src/components/shell/system-facts";

const cap = (id: string, status: string) => ({ id, name: `Tool ${id}`, category: "test", status });
/** Shaped like the live registry on 28 Sep: 19 working, 9 available, 2 setup-required. */
const liveShaped: Capabilities = {
  generatedAt: "2026-09-27T16:14:02.836Z",
  capabilities: [
    ...Array.from({ length: 19 }, (_, i) => cap(`w${i}`, "working")),
    ...Array.from({ length: 9 }, (_, i) => cap(`a${i}`, "available")),
    cap("s0", "setup-required"),
    cap("s1", "setup-required"),
  ],
};

// ── H2 ──────────────────────────────────────────────────────────────────────────────────────────
test("H2: working and available tools are not counted as needing setup", () => {
  const c = toolCounts(liveShaped);
  expect(c).toMatchObject({ working: 19, available: 9, setup: 2, broken: 0, unknown: 0, total: 30 });
  expect(c.attention.map((t) => t.id)).toEqual(["s0", "s1"]);
  expect(toolAttentionLabel(c)).toBe("2 need setup · 0 broken");
});

test("H2: broken tools lead the attention list, duplicates count once, unknown statuses stay unknown", () => {
  const c = toolCounts({
    generatedAt: "2026-09-28T00:00:00Z",
    capabilities: [cap("x", "setup-required"), cap("y", "broken"), cap("x", "setup-required"), cap("z", "mystery"), cap("w", "working"), cap("w", "working")],
  });
  expect(c).toMatchObject({ working: 1, setup: 1, broken: 1, unknown: 1, total: 4 });
  expect(c.attention.map((t) => t.id)).toEqual(["y", "x"]);
  expect(toolAttentionLabel(c)).toBe("1 needs setup · 1 broken · 1 unknown");
});

test("H2: working reads green, available neutral, only setup and broken carry warning tones", () => {
  expect(toolStatusView("working").tone).toBe("success");
  expect(toolStatusView("available")).toEqual({ label: "Available · not tested", tone: "neutral" });
  expect(toolStatusView("setup-required").tone).toBe("warn");
  expect(toolStatusView("broken").tone).toBe("danger");
  expect(toolStatusView("something-new")).toEqual({ label: "Unknown", tone: "neutral" });
  // An unbuilt registry is not "0 tools".
  expect(toolCounts(undefined).total).toBe(0);
});

// ── M3 ──────────────────────────────────────────────────────────────────────────────────────────
const claudeDiscoveryFailed: ProviderStatus = {
  id: "claude",
  installed: true,
  ready: true,
  catalogReady: false,
  detail: "Claude Code reports signed in; generation and app access are not verified. Claude model discovery failed. Check the installed Claude Code version and refresh.",
};
const hermesInstalled: ProviderStatus = { id: "hermes", installed: true, ready: true, detail: "Hermes is installed; provider access is checked when you send." };
const openrouterCatalogue: ProviderStatus = { id: "openrouter", ready: true, detail: "Current OpenRouter text-model catalog. Credential access is checked when you send." };
const codexSignedIn: ProviderStatus = { id: "codex", ready: true, detail: "Codex reports signed in; model access is discovered, not generation-tested." };

test("M3: Claude Code with failed model discovery is a failed check, never Ready or green", () => {
  const view = providerView(claudeDiscoveryFailed);
  expect(view.state).toBe("failed");
  expect(view.tone).not.toBe("success");
  expect(view.label).toBe("Model discovery failed");
  expect(providerView({ ...claudeDiscoveryFailed, catalogReady: true }).state).toBe("verified");
  expect(providerView({ id: "claude", installed: true, ready: false, detail: "Could not verify Claude Code sign-in. Open Claude Code and check /login." }).state).toBe("failed");
  expect(providerView({ id: "claude", installed: true, ready: false, detail: "Claude Code is installed but signed out. Open Claude Code and run /login." }).state).toBe("setup");
});

test("M3: installed Hermes and a downloaded OpenRouter catalogue are not verified", () => {
  expect(providerView(hermesInstalled)).toEqual({ state: "installed", label: "Installed · not verified", tone: "neutral" });
  expect(providerView(openrouterCatalogue)).toEqual({ state: "configured", label: "Catalogue only · not verified", tone: "neutral" });
  expect(providerView({ id: "openrouter", ready: false, detail: "OpenRouter catalog could not be refreshed. Check the connection and retry." }).state).toBe("failed");
  expect(providerView({ id: "deepseek", ready: true, detail: "SDK installed · OpenRouter credential available" }).tone).toBe("neutral");
  expect(providerView({ id: "brand-new", ready: true, detail: "" }).state).toBe("unknown");
});

test("M3: a signed-in probe and a live local server are the only Ready states", () => {
  expect(providerView(codexSignedIn)).toMatchObject({ state: "verified", tone: "success" });
  expect(providerView({ id: "codex", ready: false, detail: "Install Codex, then sign in with codex login." }).label).toBe("Not installed");
  expect(providerView({ id: "codex", ready: false, detail: "Codex sign-in or model discovery could not be verified. Open Codex and check your account." }).state).toBe("failed");
  expect(providerView({ id: "ollama", ready: true, detail: "3 local models available" }).state).toBe("verified");
  expect(providerView({ id: "lmstudio", ready: false, detail: "Running · load a model to use it" }).state).toBe("installed");
  expect(providerSummary([claudeDiscoveryFailed, hermesInstalled, openrouterCatalogue, codexSignedIn])).toEqual({
    verified: 1,
    unverified: 2,
    failed: 1,
    setup: 0,
    unknown: 0,
    total: 4,
  });
});

test("M3: Codex models travel the claude route but count under Codex, with or without the harness field", () => {
  const models = [
    { key: "claude|openai · via codex|gpt-a", backend: "claude", provider: "openai · via codex", name: "gpt-a", harness: "codex" },
    { key: "claude|openai · via codex|gpt-b", backend: "claude", provider: "openai · via codex", name: "gpt-b" }, // older server
    { key: "claude|claude-code|claude-x", backend: "claude", provider: "claude-code", name: "claude-x" },
    { key: "claude|claude-code|claude-x", backend: "claude", provider: "claude-code", name: "claude-x" }, // duplicate
    { key: "hermes|openrouter|v/m", backend: "hermes", provider: "openrouter", name: "v/m" },
    { key: "local|ollama|llama", backend: "local", provider: "ollama", name: "llama" },
  ];
  expect(modelHarness(models[1])).toBe("codex");
  expect(modelCountsByProvider(models)).toEqual({ codex: 2, claude: 1, hermes: 1, ollama: 1 });
  expect(distinctModelCount(models)).toBe(5);
});

function codexLaunch() {
  return (() => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(bytes, _encoding, done) {
        const message = JSON.parse(String(bytes));
        const result = message.id === 1 ? {} : message.id === 2 ? { account: { type: "chatgpt" } } : { data: [{ model: "gpt-synthetic", displayName: "Synthetic" }] };
        if (message.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n"));
        done();
      },
    });
    return child;
  }) as any;
}

test("M3: discovered Codex models keep backend 'claude' (the send route) and name Codex as their harness", async () => {
  const discovery = await discoverCodexModels("/mock/codex", codexLaunch());
  expect(discovery.models).toHaveLength(1);
  expect(discovery.models[0]).toMatchObject({ backend: "claude", harness: "codex", provider: "openai · via codex", name: "gpt-synthetic" });
  expect(modelCountsByProvider(discovery.models)).toEqual({ codex: 1 });
});

test("M3: discovered Claude Code models name Claude Code as their harness", async () => {
  const launch = (() => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(bytes, _e, done) {
        const request = JSON.parse(String(bytes));
        const response = { type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models: [{ value: "claude-synthetic" }] } } };
        queueMicrotask(() => child.stdout.write(JSON.stringify(response) + "\n"));
        done();
      },
    });
    return child;
  }) as any;
  const discovery = await discoverClaudeModels("/mock/claude", launch);
  expect(discovery.models[0]).toMatchObject({ backend: "claude", harness: "claude", provider: "claude-code" });
});

// ── L1 ──────────────────────────────────────────────────────────────────────────────────────────
test("L1: the plan-limit line says 'resets' once", () => {
  const now = Date.parse("2026-09-28T00:00:00Z");
  const line = planWindowLine("5 h", fmtResetIn("2026-09-28T02:10:00Z", now));
  expect(line).toBe("5 h window · resets in 2 h 10 min");
  expect(line.match(/resets/g)).toHaveLength(1);
  const page = readFileSync(join(import.meta.dir, "../src/components/shell/pages/system-page.tsx"), "utf8");
  expect(page).not.toMatch(/resets \{fmtResetIn/);
});

// ── L7 ──────────────────────────────────────────────────────────────────────────────────────────
type Cat = { models: { key: string }[]; statuses: { id: string }[] };

test("L7: the first snapshot answers at once with 'checking' while the probe runs in the background", async () => {
  let clock = 1_000_000;
  const snap = catalogSnapshots<Cat>(60_000, () => clock);
  let release!: (value: Cat) => void;
  let loads = 0;
  const load = () => {
    loads++;
    return new Promise<Cat>((r) => (release = r));
  };
  const first = snap("k", load);
  expect(first).toEqual({ models: [], statuses: [], checking: true, checkedAt: null, error: null });
  // A second ask while the probe runs doesn't start another probe.
  snap("k", load);
  await Promise.resolve();
  expect(loads).toBe(1);
  release({ models: [{ key: "m" }], statuses: [{ id: "codex" }] });
  await new Promise((r) => setTimeout(r, 0));
  const ready = snap("k", load);
  expect(ready).toMatchObject({ models: [{ key: "m" }], checking: false, checkedAt: new Date(1_000_000).toISOString(), error: null });
  expect(loads).toBe(1);
  // Past the TTL the old result is shown with its time while a re-check runs.
  clock += 61_000;
  const stale = snap("k", load);
  expect(stale).toMatchObject({ models: [{ key: "m" }], checking: true, checkedAt: new Date(1_000_000).toISOString() });
  await Promise.resolve();
  expect(loads).toBe(2);
});

test("L7: a failed probe says so without raw errors and never invents a result", async () => {
  const snap = catalogSnapshots<Cat>(60_000);
  snap("k", async () => {
    throw new Error("C:/Users/PRIVATE/path token=PRIVATE");
  });
  await new Promise((r) => setTimeout(r, 0));
  const after = snap("k", () => new Promise<Cat>(() => {}));
  expect(after.models).toEqual([]);
  expect(after.checkedAt).toBeNull();
  expect(after.error).toContain("model check failed");
  expect(JSON.stringify(after)).not.toContain("PRIVATE");
});

test("L7: the page view is checking, ready with its age, re-checking, or failed; old servers read as fresh", () => {
  expect(modelCheckView(undefined, 0).phase).toBe("checking");
  expect(modelCheckView({ models: [], statuses: [], checking: true, checkedAt: null, error: null }, 5).phase).toBe("checking");
  const at = "2026-09-28T01:00:00.000Z";
  expect(modelCheckView({ models: [], statuses: [], checking: true, checkedAt: at, error: null }, 5)).toEqual({ phase: "ready", checkedAt: Date.parse(at), rechecking: true, note: null });
  expect(modelCheckView({ models: [], statuses: [], checking: false, checkedAt: null, error: "The model check failed." }, 5)).toMatchObject({ phase: "failed", note: "The model check failed." });
  expect(modelCheckView({ models: [], statuses: [] }, 1234)).toEqual({ phase: "ready", checkedAt: 1234, rechecking: false, note: null });
});

test("L7: the System page asks for the non-blocking snapshot, not the blocking catalogue", () => {
  const page = readFileSync(join(import.meta.dir, "../src/components/shell/pages/system-page.tsx"), "utf8");
  expect(page).toContain('"/__operator/models?snapshot=1"');
  expect(page).not.toMatch(/getJson<[^>]+>\("\/__operator\/models"\)/);
  const plugin = readFileSync(join(import.meta.dir, "operator-plugin.ts"), "utf8");
  expect(plugin).toMatch(/path === "\/models" && url\.searchParams\.get\("snapshot"\) === "1"/);
});

// Review T8 S-5: the catalogue can hand back an older build at once (stale-while-revalidate); the
// snapshot's "checked" time is that build's, never the moment it was handed out.
test("S-5: a catalogue answer built 9 minutes ago shows as checked 9 minutes ago", async () => {
  const clock = Date.parse("2026-09-28T10:00:00Z");
  const snap = catalogSnapshots<Cat & { builtAt?: string }>(60_000, () => clock);
  const builtAt = new Date(clock - 9 * 60_000).toISOString();
  snap("k", async () => ({ models: [{ key: "m" }], statuses: [], builtAt }));
  await new Promise((r) => setTimeout(r, 0));
  expect(snap("k", async () => ({ models: [], statuses: [], builtAt })).checkedAt).toBe(builtAt);
  // A build that reports no time keeps the old behaviour (checked when it arrived).
  const plain = catalogSnapshots<Cat>(60_000, () => clock);
  plain("p", async () => ({ models: [], statuses: [] }));
  await new Promise((r) => setTimeout(r, 0));
  expect(plain("p", async () => ({ models: [], statuses: [] })).checkedAt).toBe(new Date(clock).toISOString());
});

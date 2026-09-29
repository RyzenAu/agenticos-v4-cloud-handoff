import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutedChatOptions } from "../../model-router/chat";
import { MemoryReceiptSink, type RouterReceipt } from "../../model-router/receipts";
import { runRouted, type RunResult } from "../../model-router/router";
import { buildReceipt } from "../receipts";
import { cleanup, fixtureRepo, gitIn } from "../test-fixtures";
import { createPolicy } from "./policy";
import { extractJson, routerRunner } from "./router";
import type { RunnerEvent } from "./types";

/**
 * Routed roles (Hermes, DeepSeek, MiMo, Cline) through the REAL router logic with fake providers: the
 * owner's automatic fallback happens, and the receipt names the model that ACTUALLY ran (never the one
 * selected when another did). Builders' files still go through the policy engine.
 */
const fx = fixtureRepo({ dirty: false });
afterAll(() => cleanup(fx.root));
const wt = join(fx.root, "wt-router");
gitIn(fx.canonical, "worktree", "add", "-q", "-b", "coding/r-abc123-builder-1", wt, fx.baseSha);

/** routedChat's contract, backed by the real runRouted with a fake invoker per provider. */
function fakeChat(behaviour: Record<string, "ok" | "limited" | "down">, reply: string, sink = new MemoryReceiptSink()) {
  const chat = async (o: RoutedChatOptions): Promise<RunResult<string>> =>
    runRouted<string>({
      task: o.task, caller: o.caller, sink, parentRequestId: o.parentRequestId,
      constraints: { ...o.constraints, providers: ["codex", "openrouter", "cline", "claude-sub"], hasKey: () => true, allowance: () => null },
      invoke: async (choice) => {
        const b = behaviour[choice.model] ?? "down";
        if (b === "limited") { const { ProviderError } = await import("../../model-router/router"); throw new ProviderError("rate_limited", "429", { sent: false, httpStatus: 429 }); }
        if (b === "down") { const { ProviderError } = await import("../../model-router/router"); throw new ProviderError("unavailable", "503", { sent: false, httpStatus: 503 }); }
        return { value: reply, providerModel: choice.providerModel, usage: { inputTokens: 900, outputTokens: 120 }, costUsd: choice.route === "metered" ? 0.0031 : null };
      },
    });
  return { chat, sink };
}

function start(model: string, readOnly: boolean, chat: ReturnType<typeof fakeChat>["chat"]) {
  const events: RunnerEvent[] = [];
  const handle = routerRunner({ chat, owns: () => ({ globs: ["src/a.ts"], newFiles: ["src/new.ts"] }) }).start({
    jobId: "11111111-1111-4111-8111-111111111111", roleId: "builder-1", role: readOnly ? "reviewer" : "builder",
    binding: { provider: "router", route: "model-router", accountSlot: "router:auto", model, task: "coding.router", cliVersion: "router" },
    cwd: wt, prompt: "Set a to 42.", system: "rules", readOnly, session: { mode: "new", id: "x" },
    policy: createPolicy({ role: readOnly ? "reviewer" : "builder", access: readOnly ? "read-only" : "write", worktree: wt, owns: { globs: ["src/a.ts"], newFiles: ["src/new.ts"] }, commands: [], nodeModules: "none", mayChangeDependencies: false, allowWeb: false, protectedRoots: [fx.canonical] }),
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
    limits: { wallMs: 60_000, maxTurns: 1, inputTimeoutMs: 1000 }, stopAtWindowPercent: 95, creditsAllowed: false,
  });
  return { handle, events };
}

describe("routed coding roles (model route verification)", () => {
  test("Hermes (codex/gpt-6-sol) selected and available: it runs, and the receipt says so", async () => {
    const { chat, sink } = fakeChat({ "codex/gpt-6-sol": "ok" }, JSON.stringify({ verdict: "approve", findings: [], criteria: [] }));
    const { handle } = start("codex/gpt-6-sol", true, chat);
    const out = await handle.done;
    expect(out.status).toBe("succeeded");
    expect(out.providerModel).toBe("codex/gpt-6-sol");
    expect(out.routedProvider).toBe("codex");
    expect(out.fallbackFrom).toBeNull();
    expect(sink.receipts.at(-1)).toMatchObject({ task: "coding.router", model: "codex/gpt-6-sol", outcome: "succeeded" });
  }, 60_000);
  test("Hermes limited → the router falls back AUTOMATICALLY to paid DeepSeek; the receipt names DeepSeek and fallbackFrom", async () => {
    const { chat, sink } = fakeChat({ "codex/gpt-6-sol": "limited", "openrouter/deepseek-v4-pro": "ok" }, JSON.stringify({ verdict: "approve", findings: [], criteria: [] }));
    const { handle, events } = start("codex/gpt-6-sol", true, chat);
    const out = await handle.done;
    expect(out.providerModel).toBe("openrouter/deepseek-v4-pro");
    expect(out.fallbackFrom).toBe("codex/gpt-6-sol");
    expect(out.routedCost).toMatchObject({ basis: "provider_reported", usd: 0.0031 });
    expect(events.some((e) => e.type === "step" && /unavailable; the router ran openrouter\/deepseek-v4-pro/.test(e.label))).toBe(true);
    const rows = sink.receipts as RouterReceipt[];
    expect(rows.map((r) => `${r.model}:${r.outcome}`)).toEqual(["codex/gpt-6-sol:rate_limited", "openrouter/deepseek-v4-pro:succeeded"]);
    // The coding receipt carries the same truth (no in-app cap, real cost, the model that ran).
    const r = buildReceipt({ requestId: crypto.randomUUID() as never, parentRequestId: null, jobId: crypto.randomUUID() as never, roleId: "reviewer" as never, role: "reviewer", turn: 1, person: "usman" as never, binding: { provider: "router", route: "model-router", accountSlot: "router:auto", model: "codex/gpt-6-sol", task: "coding.router", cliVersion: "router" }, dataClass: "synthetic", outcome: out, allowanceStart: null, queueMs: 0 });
    expect(r).toMatchObject({ model: "openrouter/deepseek-v4-pro", fallbackFrom: "codex/gpt-6-sol", account: "router:openrouter", costClass: "metered", cost: { usd: 0.0031 } });
  }, 60_000);
  test("MiMo and Cline are selectable routed roles", async () => {
    for (const model of ["openrouter/mimo-v2.6-pro", "cline/deepseek-v4.1-flash"]) {
      const { chat } = fakeChat({ [model]: "ok" }, JSON.stringify({ verdict: "approve", findings: [], criteria: [] }));
      const out = await start(model, true, chat).handle.done;
      expect(out.providerModel).toBe(model);
    }
  }, 60_000);
  test("an explicit free Cline choice never reaches a metered OpenRouter fallback", async () => {
    const { chat, sink } = fakeChat({ "cline/deepseek-v4.1-flash": "limited", "openrouter/deepseek-v4-pro": "ok" }, "{}");
    const out = await start("cline/deepseek-v4.1-flash", true, chat).handle.done;
    expect(out.status).toBe("blocked_allowance");
    expect((sink.receipts as RouterReceipt[]).some((r) => r.model === "openrouter/deepseek-v4-pro")).toBe(false);
  }, 60_000);
  test("every route down → blocked with every reason, never a fake success", async () => {
    const { chat } = fakeChat({}, "x");
    const out = await start("codex/gpt-6-sol", true, chat).handle.done;
    expect(out.status).toBe("blocked_allowance");
    expect(out.error?.message).toMatch(/no eligible model/);
  }, 60_000);
  test("a routed builder's files go through the policy: owned written and committed, unowned refused", async () => {
    const reply = "```json\n" + JSON.stringify({ files: [{ path: "src/a.ts", content: "export const a = 42;\n" }, { path: "lib/c.ts", content: "HACKED\n" }, { path: ".env", content: "X=1\n" }], summary: "a is 42" }) + "\n```";
    const { chat } = fakeChat({ "openrouter/deepseek-v4-pro": "ok" }, reply);
    const { handle, events } = start("openrouter/deepseek-v4-pro", false, chat);
    const out = await handle.done;
    expect(out.error).toBeNull();
    expect(out.status).toBe("succeeded");
    expect(readFileSync(join(wt, "src", "a.ts"), "utf8")).toBe("export const a = 42;\n");
    expect(readFileSync(join(wt, "lib", "c.ts"), "utf8")).toBe("export const c = 3;\n");
    const denied = events.filter((e) => e.type === "policy" && e.verdict.decision === "auto-deny");
    expect(denied.length).toBe(2);
    expect(gitIn(wt, "log", "-1", "--format=%B")).toContain("Model that ran: openrouter/deepseek-v4-pro");
    expect(gitIn(wt, "status", "--porcelain").trim()).toBe("");
  }, 60_000);
  test("JSON is found inside fences and chatter", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nDone')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeNull();
  }, 60_000);
});

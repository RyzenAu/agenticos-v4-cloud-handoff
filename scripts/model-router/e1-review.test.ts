// REVIEW-E1 findings as regression tests: the reviewer's repros R1-R8 (memory/master-v3/review-e1/
// e1.repro.test.ts), rewritten to assert the FIXED behaviour, plus the H1/M1-M5 fixes. Zero network.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import raw from "./catalogue.json";
import { validateCatalogue } from "./catalogue";
import {
  allowanceFromSnapshot,
  clearPublishedUsage,
  currentAllowance,
  publishUsageSnapshot,
} from "./allowance";
import { modelRouterRoute } from "./api";
import { httpProviderError, openAiCompatibleChat } from "./clients";
import { MemoryHealthStore } from "./health";
import {
  JsonlReceiptSink,
  MemoryReceiptSink,
  meteredSpendByProvider,
  summariseReceipts,
} from "./receipts";
import {
  fallbackAllowed,
  MaybeExecuted,
  ProviderError,
  ReplayRefused,
  route,
  RouteError,
  runRouted,
  SinkRefused,
} from "./router";
import type { AiUsageSnapshot } from "../ai-usage/types";

const hasKey = () => true;
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "e1-review-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  clearPublishedUsage();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// --- B1: no replay ------------------------------------------------------------------------------

test("R1 fixed: a side-effecting 502 after send is never run again under the same requestId", async () => {
  const sink = new MemoryReceiptSink();
  let calls = 0;
  const invoke = async () => {
    calls++;
    throw httpProviderError(502, "bad gateway");
  };
  const req = {
    task: "agent.hermes",
    caller: "review",
    requestId: "req-r1",
    sink,
    invoke,
    constraints: { hasKey, health: new MemoryHealthStore() },
  };
  await expect(runRouted(req)).rejects.toBeInstanceOf(MaybeExecuted);
  await expect(runRouted(req)).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
  expect(sink.receipts.map((r) => [r.outcome, r.sent])).toEqual([
    ["failed", true],
    ["replay_refused", false],
  ]);
});

test("R1 fixed across a restart: history alone (a fresh claim store) still refuses a possibly-sent step", async () => {
  const dir = tempDir();
  const file = join(dir, "receipts.jsonl");
  let calls = 0;
  const invoke = async () => {
    calls++;
    throw new ProviderError("transport", "reset", { sent: "unknown" });
  };
  await expect(
    runRouted({
      task: "agent.hermes",
      caller: "r",
      requestId: "req-t",
      sink: new JsonlReceiptSink(file),
      invoke,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(MaybeExecuted);
  // A new process reads the same store.
  await expect(
    runRouted({
      task: "agent.hermes",
      caller: "r",
      requestId: "req-t",
      sink: new JsonlReceiptSink(file),
      invoke,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
});

test("R2 fixed: cancelled after send is never run again", async () => {
  const sink = new MemoryReceiptSink();
  let calls = 0;
  const ac = new AbortController();
  const invoke = async () => {
    calls++;
    ac.abort();
    throw new ProviderError("cancelled", "cancelled", { sent: "unknown" });
  };
  await expect(
    runRouted({
      task: "agent.hermes",
      caller: "review",
      requestId: "req-r2",
      sink,
      invoke,
      signal: ac.signal,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(Error);
  await expect(
    runRouted({
      task: "agent.hermes",
      caller: "review",
      requestId: "req-r2",
      sink,
      invoke: async () => ({ value: "ok" }),
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
});

test("R3 fixed: two concurrent runs with one requestId (JSONL sink, even two sink instances) invoke once", async () => {
  const file = join(tempDir(), "receipts.jsonl");
  let calls = 0;
  const invoke = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    return { value: "done" };
  };
  const one = () =>
    runRouted({
      task: "agent.hermes",
      caller: "review",
      requestId: "req-r3",
      sink: new JsonlReceiptSink(file),
      invoke,
      constraints: { hasKey },
    });
  const results = await Promise.allSettled([one(), one()]);
  expect(calls).toBe(1);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
  ).toBeInstanceOf(ReplayRefused);
  // The claim is unique across instances sharing the file.
  const a = new JsonlReceiptSink(join(tempDir(), "r.jsonl"));
  expect(a.claim("x")).toBe(true);
  expect(new JsonlReceiptSink(join(dirs.at(-1)!, "r.jsonl")).claim("x")).toBe(false);
});

test("R4 fixed: a sink without history lookup or claims is refused before anything runs", async () => {
  let calls = 0;
  const invoke = async () => (calls++, { value: "x" });
  const writeOnly = { write: () => {} } as any;
  await expect(
    runRouted({
      task: "agent.hermes",
      caller: "review",
      requestId: "req-r4",
      sink: writeOnly,
      invoke,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(SinkRefused);
  const noClaim = { write: () => {}, forRequest: () => [] } as any;
  await expect(
    runRouted({
      task: "screen.plan",
      caller: "review",
      sink: noClaim,
      invoke,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(SinkRefused);
  expect(calls).toBe(0);
});

test("a claim is released only when nothing was sent, so a refused-everywhere step may be tried again", async () => {
  const sink = new MemoryReceiptSink();
  let calls = 0;
  const refused = async () => {
    calls++;
    throw httpProviderError(429, "per day (RPD)");
  };
  await expect(
    runRouted({
      task: "screen.plan",
      caller: "r",
      requestId: "req-rel",
      sink,
      invoke: refused,
      constraints: { hasKey },
    }),
  ).rejects.toBeInstanceOf(RouteError);
  expect(sink.claims.get("req-rel")).toBe("released");
  const r = await runRouted({
    task: "screen.plan",
    caller: "r",
    requestId: "req-rel",
    sink,
    invoke: async () => ({ value: "ok" }),
    constraints: { hasKey },
  });
  expect(r.value).toBe("ok");
  expect(r.receipt.attempt).toBe(4); // numbering continues after the 2 refusals + exhaustion row
  expect(sink.claims.get("req-rel")).toBe("open"); // a success holds the claim forever
  expect(calls).toBe(2);
});

// --- M1/M2/M5 -----------------------------------------------------------------------------------

test("R5 fixed: exhaustion rows are not calls; a 402 refusal is one call at $0; the real failure stays visible", async () => {
  const sink = new MemoryReceiptSink();
  const invoke = async (choice: { model: string }) => {
    if (choice.model === "openrouter/mimo-v2.6-flash")
      throw httpProviderError(402, "insufficient credits");
    throw httpProviderError(429, "Rate limit reached ... requests per day (RPD)");
  };
  await expect(
    runRouted({
      task: "bulk.text",
      caller: "scripts/llm/mimo (lead-summary)",
      requestId: "req-r5",
      sink,
      invoke,
      constraints: {
        selected: "openrouter/mimo-v2.6-flash",
        selectedBy: "owner",
        providers: ["openrouter", "groq"],
        hasKey,
        health: new MemoryHealthStore(),
      },
    }),
  ).rejects.toBeInstanceOf(RouteError);
  expect(sink.receipts.at(-1)?.outcome).toBe("exhausted_free");
  const spend = meteredSpendByProvider(sink.receipts);
  // One metered call reached OpenRouter (MiMo 402; refused, so $0). No paid DeepSeek fallback (REVIEW-E12 R2).
  // The exhaustion row is not a call.
  expect(spend.openrouter).toMatchObject({ calls: 1, costUsd: 0, unknownCostCalls: 0 });
  const usage = summariseReceipts(sink.receipts)["openrouter/mimo-v2.6-flash"];
  expect(usage).toMatchObject({ calls: 1, failures: 1, unknownCostCalls: 0 });
  expect(usage.lastFailure?.errorCode).toBe("insufficient_funds");
});

test("R6 fixed: when every model fails at the provider an exhaustion receipt is written", async () => {
  const sink = new MemoryReceiptSink();
  await expect(
    runRouted({
      task: "bulk.text",
      caller: "review",
      requestId: "req-r6",
      sink,
      invoke: async () => {
        throw httpProviderError(503, "down");
      },
      constraints: {
        selected: "openrouter/mimo-v2.6-pro",
        hasKey,
        health: new MemoryHealthStore(),
      },
    }),
  ).rejects.toBeInstanceOf(RouteError);
  expect(sink.receipts.filter((r) => r.outcome === "exhausted_free")).toHaveLength(1);
  expect(sink.receipts.at(-1)?.outcome).toBe("exhausted_free");
});

test("M5: provider-reported cost wins on a free route too", async () => {
  const sink = new MemoryReceiptSink();
  await runRouted({
    task: "bulk.text",
    caller: "r",
    sink,
    constraints: { providers: ["openrouter"], hasKey },
    invoke: async () => ({ value: "x", costUsd: 0.01 }),
  });
  expect(sink.receipts[0]).toMatchObject({
    route: "free",
    costUsd: 0.01,
    costBasis: "provider_reported",
  });
});

test("an unknown selected id writes a clear refusal receipt instead of crashing", async () => {
  const sink = new MemoryReceiptSink();
  await expect(
    runRouted({
      task: "voice.brain",
      caller: "r",
      sink,
      constraints: { selected: "nobody/nothing", hasKey },
      invoke: async () => ({ value: 1 }),
    }),
  ).rejects.toThrow(/not a model for voice.brain/);
  expect(sink.receipts[0]).toMatchObject({
    outcome: "refused_policy",
    model: "nobody/nothing",
    sent: false,
  });
});

// --- R7/R8 (unchanged, still hold) --------------------------------------------------------------

test("R7 (after the owner's corrections): Gemini's pre-existing vision legs are kept; data class is not a routing input", () => {
  const c = route("vision.screen", { providers: ["gemini"], hasKey });
  expect(c).toMatchObject({ model: "gemini/3.8-flash", fallbackFrom: "codex/gpt-6-sol" });
  expect(
    route("vision.screen", { selected: "gemini/3.8-flash", providers: ["gemini"], hasKey }).model,
  ).toBe("gemini/3.8-flash");
});

// --- H1: Gemini billing unverified --------------------------------------------------------------

test("H1: verifiedFree is a schema-enforced flag; research.web has no pre-existing Gemini fallback to keep", () => {
  // Groq limited: the other verified-free Groq model takes over.
  const h = new MemoryHealthStore({
    models: {
      "groq/gpt-oss-120b": {
        state: "limited",
        until: "2999-01-01T00:00:00Z",
        lastProbe: null,
        lastFailure: null,
        detail: null,
      },
    },
  });
  expect(route("screen.plan", { hasKey, health: h }).model).toBe("groq/gpt-oss-20b");
  expect(() =>
    route("research.web", {
      hasKey,
      health: new MemoryHealthStore({
        models: {
          "gemini/flash-latest": {
            state: "limited",
            until: "2999-01-01T00:00:00Z",
            lastProbe: null,
            lastFailure: null,
            detail: null,
          },
        },
      }),
    }),
  ).toThrow(RouteError);
  const bad = JSON.parse(JSON.stringify(raw));
  bad.models.find((m: any) => m.id === "gemini/3.8-flash").verifiedFree = true;
  expect(validateCatalogue(bad).join()).toMatch(/verifiedFree needs a verified-free provider/);
  const missing = JSON.parse(JSON.stringify(raw));
  delete missing.models.find((m: any) => m.id === "groq/gpt-oss-20b").verifiedFree;
  expect(validateCatalogue(missing).join()).toMatch(/verifiedFree must be boolean/);
});

// --- M3 superseded (owner, 28 Sep: "it's all my data"): no data_collection or zdr routing is added ---------

test("no data_collection deny or zdr is added to OpenRouter calls", async () => {
  const bodies: any[] = [];
  const request = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  const mimo = route("bulk.text", { selected: "openrouter/mimo-v2.6-flash", hasKey });
  await openAiCompatibleChat(
    mimo,
    {
      root: tempDir(),
      env: { OPENROUTER_API_KEY: "SYNTHETIC" } as NodeJS.ProcessEnv,
      request,
      messages: [{ role: "user", content: "x" }],
    },
    new AbortController().signal,
  );
  expect(bodies[0].provider).toBeUndefined();
  expect(JSON.stringify(bodies[0])).not.toMatch(/data_collection|zdr/);
});

// --- M4: allowance wired from /usage ------------------------------------------------------------

const card = (id: string, provider: "anthropic" | "openai", used: number, plan = "Max 20x") =>
  ({
    id,
    provider,
    owner: "M&U Ventures",
    plan,
    planSlug: null,
    monthly: null,
    priceNote: "",
    peakPercent: used,
    status: {
      ok: true,
      windows: [{ label: "Weekly", usedPercent: used, resetsAt: "2026-10-04T03:05:00Z" }],
      notes: [],
      freshness: { checkedAt: null, source: "x", estimated: false },
    },
  }) as unknown as AiUsageSnapshot["subscriptions"][number];

test("M4: the /usage snapshot feeds route()'s >= 95% subscription skip, per pool", () => {
  const now = Date.now();
  publishUsageSnapshot({
    generatedAt: new Date(now).toISOString(),
    subscriptions: [
      card("claude:max", "anthropic", 97),
      card("codex:openai-1", "openai", 100, "Pro"),
      card("codex:openai-2", "openai", 12, "Plus"),
    ],
  });
  const summary = route("summary.private", { hasKey });
  expect(summary.model).toBe("groq/gpt-oss-120b");
  expect(summary.skipped[0].why).toMatch(/Claude Max 20x Weekly at 97%/);
  // One pooled Codex account at 100% doesn't block the pool: Hermes rotates to the least-used one.
  const agent = route("agent.hermes", { hasKey });
  expect(agent).toMatchObject({ model: "codex/gpt-6-sol", allowance: { usedPct: 12 } });
  expect(currentAllowance("codex")?.plan).toContain("least-used openai-2");
  // Every account over 95%: the pool is skipped.
  expect(
    allowanceFromSnapshot(
      {
        subscriptions: [
          card("codex:openai-1", "openai", 100),
          card("codex:openai-2", "openai", 96),
        ],
      },
      "codex",
    )?.usedPct,
  ).toBe(96);
  // A stale reading is unknown and never blocks.
  expect(currentAllowance("claude-sub", now + 31 * 60_000)).toBeNull();
});

test("verifiedFree governs only NEW fallbacks: pre-existing Gemini fallbacks are kept, new ones are refused", () => {
  const gemini = { id: "gemini/3.7-flash", route: "free" as const, verifiedFree: false };
  // A task that never had this fallback: the router won't add it.
  expect(fallbackAllowed(gemini, { preExistingFallbacks: undefined }, true)).toBe(false);
  expect(fallbackAllowed(gemini, { preExistingFallbacks: ["gemini/flash-latest"] }, true)).toBe(
    false,
  );
  // Where it pre-dates the router, it stays.
  expect(fallbackAllowed(gemini, { preExistingFallbacks: ["gemini/3.7-flash"] }, true)).toBe(true);
  // Primary (selected) runs are never affected; verified-free models are always allowed.
  expect(fallbackAllowed(gemini, {}, false)).toBe(true);
  expect(
    fallbackAllowed({ id: "groq/gpt-oss-20b", route: "free", verifiedFree: true }, {}, true),
  ).toBe(true);
  // The schema keeps the list honest.
  const bad = JSON.parse(JSON.stringify(raw));
  bad.tasks["bulk.text"].preExistingFallbacks = ["gemini/3.7-flash"];
  expect(validateCatalogue(bad).join()).toMatch(
    /preExistingFallbacks gemini\/3\.7-flash must be in candidates/,
  );
});

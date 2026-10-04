import { describe, expect, test } from "bun:test";
import { catalogue, catalogueModel } from "./catalogue";
import { MemoryHealthStore } from "./health";
import { MemoryReceiptSink } from "./receipts";
import {
  MaybeExecuted,
  ProviderError,
  ReplayRefused,
  RouteError,
  route,
  runRouted,
  type RouteConstraints,
} from "./router";

const NOW = Date.parse("2026-09-28T02:00:00Z");
const allKeys = () => true;
const base = (extra: RouteConstraints = {}): RouteConstraints => ({
  hasKey: allKeys,
  now: NOW,
  ...extra,
});
const limited = (...ids: string[]) =>
  new MemoryHealthStore({
    models: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          state: "limited",
          until: new Date(NOW + 60_000).toISOString(),
          lastProbe: null,
          lastFailure: null,
          detail: "HTTP 429",
        },
      ]),
    ),
  });

/** Every task class: what happens when its selected (first) model is limited. */
const FALLBACK: Record<string, { to: string | null }> = {
  "jev.decision": { to: null },
  "approval.guardian": { to: null },
  "voice.brain": { to: "groq/gpt-oss-20b" },
  "voice.stt": { to: null },
  "voice.tts": { to: "gemini/3.1-flash-tts-preview" }, // pre-existing fallback and pre-E2 model (REVIEW-E12 M5), kept
  "video.narration": { to: null },
  "film.narration": { to: null },
  "video.understand": { to: "gemini/flash-latest" }, // pre-existing fallback, kept
  "video.understand.pro": { to: null }, // pre-E1: the pro tier had no fallback
  "vision.screen": { to: "groq/qwen3.8-27b" },
  "screen.plan": { to: "groq/gpt-oss-20b" },
  "research.web": { to: null },
  "bulk.text": { to: "cline/gemini-3.8-flash" },
  "review.source": { to: "cline/muse-spark-1.3" },
  "summary.private": { to: "claude/sonnet-5" },
  "inbox.question": { to: "groq/gpt-oss-120b" },
  callscript: { to: "cline/deepseek-v4.1-flash" },
  critique: { to: "claude/sonnet-5" },
  "agent.hermes": { to: "groq/gpt-oss-120b" },
  coding: { to: null },
  // Track 3 (C3): routed coding roles (Hermes' Codex pool first, then DeepSeek/MiMo/Cline), text only.
  "coding.router": { to: "openrouter/deepseek-v4-pro" },
  "moa.ministry": { to: "codex/gpt-6-sol" },
  "photo.index": { to: null },
  // Stage E2 tasks.
  "vision.point": { to: "codex/gpt-6-sol" }, // pre-E2 pointing order: Claude, then GPT-6 via Hermes
  "bridge.claude": { to: null },
  "bridge.cline": { to: "cline/gemini-3.8-flash" },
  "dream.nightly": { to: null },
  "cad.code": { to: "codex/gpt-6-sol" },
  "meeting.notes": { to: "codex/gpt-6-sol" },
  "voice.companion": { to: null },
};

describe("fallback for each task class", () => {
  test("the table covers every task in the catalogue", () => {
    expect(Object.keys(FALLBACK).sort()).toEqual(Object.keys(catalogue().tasks).sort());
  });
  for (const [task, want] of Object.entries(FALLBACK)) {
    test(task, () => {
      const primary = catalogue().tasks[task].candidates[0];
      const healthy = route(task, base());
      expect(healthy.model).toBe(primary);
      expect(healthy.fallbackFrom).toBeNull();
      const c = base({ health: limited(primary) });
      if (want.to === null) {
        let error: unknown;
        try {
          route(task, c);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(RouteError);
        expect((error as RouteError).code).toBe("exhausted_free");
        expect((error as RouteError).message).toContain(catalogue().tasks[task].onExhausted);
        expect((error as RouteError).message).toContain(`${primary}: limited`);
      } else {
        const choice = route(task, c);
        expect(choice.model).toBe(want.to);
        expect(choice.route).toBe(catalogueModel(want.to).route);
        expect(choice.fallbackFrom).toBe(primary);
        expect(choice.reason).toContain(primary);
      }
    });
  }
});

describe("route rules", () => {
  test("a selected paid model runs when healthy and falls back automatically to the free chain, never to a new paid model", () => {
    const sel = {
      selected: "openrouter/mimo-v2.6-flash",
      selectedBy: "owner" as const,
      providers: ["openrouter", "groq"],
    };
    expect(route("bulk.text", base(sel)).model).toBe("openrouter/mimo-v2.6-flash");
    const fb = route("bulk.text", base({ ...sel, health: limited("openrouter/mimo-v2.6-flash") }));
    expect(fb).toMatchObject({
      model: "groq/gpt-oss-120b",
      route: "free",
      fallbackFrom: "openrouter/mimo-v2.6-flash",
      selectedBy: "owner",
    });
    // REVIEW-E12 R2 (M6): before E1, bulk text never reached paid DeepSeek, so with the free models out the
    // chain ends; paid DeepSeek and MiMo stay selectable only.
    const free = catalogue().tasks["bulk.text"].candidates.filter(
      (id) => catalogueModel(id).route === "free",
    );
    expect(() => route("bulk.text", base({ ...sel, health: limited("openrouter/mimo-v2.6-flash", ...free) }))).toThrow(RouteError);
    expect(catalogue().tasks["bulk.text"].selectable).toEqual(expect.arrayContaining(["openrouter/deepseek-v4.1-flash", "openrouter/mimo-v2.6-flash"]));
  });

  test("owner-selected ElevenLabs voice falls back to a free voice; the pro video tier has no fallback (as before E1)", () => {
    const tts = route(
      "voice.tts",
      base({ selected: "elevenlabs/flash-v2-5", health: limited("elevenlabs/flash-v2-5") }),
    );
    expect(tts).toMatchObject({
      model: "groq/orpheus-v1-english",
      fallbackFrom: "elevenlabs/flash-v2-5",
    });
    // Pre-E1 behaviour kept exactly: the pro tier had no fallback.
    expect(() =>
      route("video.understand.pro", base({ health: limited("openrouter/gemini-3.1-pro-preview") })),
    ).toThrow(/video.understand.pro: no eligible model.*the pro tier has no fallback/);
    // The flash chain still ends at the pre-E1 paid OpenRouter fallback.
    const flash = route(
      "video.understand",
      base({ health: limited("gemini/3.8-flash", "gemini/flash-latest") }),
    );
    expect(flash).toMatchObject({
      model: "openrouter/gemini-2.5-flash-lite",
      route: "metered",
      fallbackFrom: "gemini/3.8-flash",
    });
  });

  test("a metered model outside the task's chain (selectable only) is never picked automatically", () => {
    const all = catalogue().tasks["bulk.text"].candidates;
    let error: RouteError | null = null;
    try {
      route("bulk.text", base({ health: limited(...all) }));
    } catch (e) {
      error = e as RouteError;
    }
    expect(error).toBeInstanceOf(RouteError);
    expect(error!.skipped.map((s) => s.model)).not.toContain("openrouter/mimo-v2.6-pro");
  });

  test("subscriptions can be fallbacks now; free-only workflows still skip anything paid", () => {
    expect(route("critique", base({ health: limited("claude/opus-5-5") })).model).toBe(
      "claude/sonnet-5",
    );
    const freeOnly = route("critique", base({ freeOnly: true }));
    expect(freeOnly).toMatchObject({
      model: "cline/muse-spark-1.3",
      fallbackFrom: "claude/opus-5-5",
    });
    expect(freeOnly.skipped[0].why).toMatch(/free-only/);
    expect(() =>
      route("video.narration", base({ health: limited("gemini/3.8-flash-lite-tts") })),
    ).toThrow(RouteError);
  });

  test("data use never gates routing (owner: it's all my data)", () => {
    expect(route("review.source", base()).model).toBe("cline/deepseek-v4.1-flash");
    expect(
      route("vision.screen", base({ selected: "gemini/3.8-flash", providers: ["gemini"] })).model,
    ).toBe("gemini/3.8-flash");
    const c = route(
      "summary.private",
      base({
        health: limited(
          "claude/haiku-4-5",
          "claude/sonnet-5",
          "groq/gpt-oss-120b",
          "groq/gpt-oss-20b",
        ),
      }),
    );
    expect(c.model).toBe("cline/deepseek-v4.1-flash"); // a Cline model that may train on prompts is fine
  });

  test("a subscription window at 95% or more is skipped with its reading", () => {
    const allowance = () => ({
      plan: "Claude Max 20x",
      window: "session",
      usedPct: 96,
      resetsAt: null,
    });
    const c = route("summary.private", base({ allowance }));
    expect(c.model).toBe("groq/gpt-oss-120b"); // haiku and sonnet share the spent Claude window
    expect(c.skipped[0].why).toContain("session at 96%");
    expect(c.skipped[1].why).toContain("session at 96%");
    const ok = route(
      "summary.private",
      base({ allowance: () => ({ plan: "Claude Max 20x", window: "session", usedPct: 40 }) }),
    );
    expect(ok).toMatchObject({ model: "claude/haiku-4-5", allowance: { usedPct: 40 } });
  });

  test("a missing key is 'not configured', a model outside the task is refused, unknown tasks fail", () => {
    // free-voice's Gemini last resort pre-dates the router: kept, after the Groq models are skipped.
    const brain = route("voice.brain", base({ hasKey: (n) => n !== "GROQ_API_KEY" }));
    expect(brain.model).toBe("gemini/3.5-flash-lite");
    expect(brain.skipped[0].why).toMatch(/GROQ_API_KEY missing/);
    expect(route("bulk.text", base({ hasKey: (n) => n !== "GROQ_API_KEY" })).model).toBe(
      "cline/deepseek-v4.1-flash",
    );
    expect(() => route("voice.brain", base({ selected: "openrouter/mimo-v2.6-flash" }))).toThrow(
      /not a model for voice.brain/,
    );
    expect(() => route("nope", base())).toThrow(/No router task/);
  });

  test("an expired limit no longer blocks the model", () => {
    const h = new MemoryHealthStore({
      models: {
        "groq/gpt-oss-120b": {
          state: "limited",
          until: new Date(NOW - 1).toISOString(),
          lastProbe: null,
          lastFailure: null,
          detail: null,
        },
      },
    });
    expect(route("screen.plan", base({ health: h })).model).toBe("groq/gpt-oss-120b");
  });
});

describe("runRouted receipts, fallback and no replay", () => {
  const ok =
    (value = "OK") =>
    async () => ({ value, usage: { inputTokens: 10, outputTokens: 5 } });

  test("receipts are written for every attempt and the fallback records fallbackFrom", async () => {
    const sink = new MemoryReceiptSink();
    const health = new MemoryHealthStore();
    const seen: string[] = [];
    const result = await runRouted({
      task: "screen.plan",
      caller: "test",
      requestId: "req-1",
      sink,
      constraints: base({ health }),
      invoke: async (choice) => {
        seen.push(choice.model);
        if (choice.model === "groq/gpt-oss-120b")
          throw new ProviderError("rate_limited", "429", {
            httpStatus: 429,
            sent: false,
            retryAfterMs: 30_000,
          });
        return {
          value: "PLAN",
          providerModel: choice.providerModel,
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    });
    expect(result.value).toBe("PLAN");
    expect(seen).toEqual(["groq/gpt-oss-120b", "groq/gpt-oss-20b"]);
    expect(sink.receipts.map((r) => [r.attempt, r.model, r.outcome, r.fallbackFrom])).toEqual([
      [1, "groq/gpt-oss-120b", "rate_limited", null],
      [2, "groq/gpt-oss-20b", "succeeded", "groq/gpt-oss-120b"],
    ]);
    const [first, second] = sink.receipts;
    expect(first).toMatchObject({
      errorCode: "rate_limited",
      httpStatus: 429,
      costUsd: 0,
      costBasis: "refused_before_work",
      selectedBy: "rule",
      sent: false,
    });
    expect(second).toMatchObject({
      requestId: "req-1",
      route: "free",
      costUsd: 0,
      costBasis: "free",
      inputTokens: 100,
      outputTokens: 20,
      providerModel: "openai/gpt-oss-20b",
      sent: true,
    });
    expect(health.model("groq/gpt-oss-120b").state).toBe("limited");
  });

  test("metered cost: provider-reported wins, else catalogue price; unknown stays null", async () => {
    const sink = new MemoryReceiptSink();
    const c = base({ selected: "openrouter/mimo-v2.6-flash", providers: ["openrouter"] });
    await runRouted({
      task: "bulk.text",
      caller: "t",
      sink,
      constraints: c,
      invoke: async () => ({
        value: "x",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        costUsd: 0.5,
      }),
    });
    await runRouted({
      task: "bulk.text",
      caller: "t",
      sink,
      constraints: c,
      invoke: async () => ({
        value: "x",
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });
    await runRouted({
      task: "bulk.text",
      caller: "t",
      sink,
      constraints: c,
      invoke: async () => ({ value: "x" }),
    });
    expect(sink.receipts.map((r) => [r.costUsd, r.costBasis, r.route])).toEqual([
      [0.5, "provider_reported", "metered"],
      [0.42, "catalogue_price", "metered"],
      [null, "unknown", "metered"],
    ]);
    expect(sink.receipts[0].selectedBy).toBe("owner");
  });

  test("subscription calls record allowance, not cash; unverified free tiers record null cost", async () => {
    const sink = new MemoryReceiptSink();
    await runRouted({
      task: "summary.private",
      caller: "t",
      sink,
      constraints: base({
        allowance: () => ({ plan: "claude-max-20x", window: "session", usedPct: 22 }),
      }),
      invoke: ok(),
    });
    await runRouted({
      task: "video.understand",
      caller: "t",
      sink,
      constraints: base(),
      invoke: ok(),
    });
    expect(sink.receipts[0]).toMatchObject({
      route: "subscription",
      costUsd: null,
      costBasis: "subscription_allowance",
      allowance: { plan: "claude-max-20x", window: "session", usedPct: 22 },
    });
    expect(sink.receipts[1]).toMatchObject({
      provider: "gemini",
      route: "free",
      costUsd: null,
      costBasis: "free_tier_unverified",
    });
  });

  test("a side-effecting step that may have run is never retried elsewhere, and is refused on replay", async () => {
    const sink = new MemoryReceiptSink();
    const calls: string[] = [];
    const invoke = async (choice: { model: string }) => {
      calls.push(choice.model);
      throw new ProviderError("timeout", "timed out", { sent: "unknown" });
    };
    await expect(
      runRouted({
        task: "agent.hermes",
        caller: "t",
        requestId: "job-7/step-3",
        sink,
        constraints: base(),
        invoke,
      }),
    ).rejects.toBeInstanceOf(MaybeExecuted);
    expect(calls).toEqual(["codex/gpt-6-sol"]);
    expect(sink.receipts.map((r) => r.outcome)).toEqual(["timed_out"]);

    await expect(
      runRouted({
        task: "agent.hermes",
        caller: "t",
        requestId: "job-7/step-3",
        sink,
        constraints: base(),
        invoke,
      }),
    ).rejects.toBeInstanceOf(ReplayRefused);
    expect(calls).toEqual(["codex/gpt-6-sol"]);
    expect(sink.receipts.map((r) => [r.attempt, r.outcome, r.errorCode])).toEqual([
      [1, "timed_out", "timeout"],
      [2, "replay_refused", "replay"],
    ]);
  });

  test("a 5xx on a side-effecting task does not fall back; a refused (429) request does", async () => {
    const sink = new MemoryReceiptSink();
    await expect(
      runRouted({
        task: "agent.hermes",
        caller: "t",
        sink,
        constraints: base(),
        invoke: async () => {
          throw new ProviderError("unavailable", "503", { httpStatus: 503, sent: "unknown" });
        },
      }),
    ).rejects.toBeInstanceOf(MaybeExecuted);
    expect(sink.receipts).toHaveLength(1);

    const sink2 = new MemoryReceiptSink();
    const r = await runRouted({
      task: "agent.hermes",
      caller: "t",
      sink: sink2,
      constraints: base(),
      invoke: async (c) => {
        if (c.model === "codex/gpt-6-sol")
          throw new ProviderError("quota_exhausted", "429", { httpStatus: 429, sent: false });
        return { value: "done" };
      },
    });
    expect(r.receipt).toMatchObject({
      model: "groq/gpt-oss-120b",
      fallbackFrom: "codex/gpt-6-sol",
      outcome: "succeeded",
    });
  });

  test("a step that already succeeded is not replayed", async () => {
    const sink = new MemoryReceiptSink();
    let n = 0;
    const invoke = async () => ({ value: ++n });
    await runRouted({
      task: "screen.plan",
      caller: "t",
      requestId: "once",
      sink,
      constraints: base(),
      invoke,
    });
    await expect(
      runRouted({
        task: "screen.plan",
        caller: "t",
        requestId: "once",
        sink,
        constraints: base(),
        invoke,
      }),
    ).rejects.toBeInstanceOf(ReplayRefused);
    expect(n).toBe(1);
  });

  test("a text-only step may fall back after a timeout (nothing to repeat)", async () => {
    const sink = new MemoryReceiptSink();
    const r = await runRouted({
      task: "screen.plan",
      caller: "t",
      sink,
      constraints: base(),
      invoke: async (c) => {
        if (c.model === "groq/gpt-oss-120b")
          throw new ProviderError("timeout", "slow", { sent: "unknown" });
        return { value: "ok" };
      },
    });
    expect(r.receipt.fallbackFrom).toBe("groq/gpt-oss-120b");
  });

  test("exhaustion, cancellation and bad requests fail clearly, each with a receipt", async () => {
    const sink = new MemoryReceiptSink();
    await expect(
      runRouted({
        task: "video.narration",
        caller: "t",
        sink,
        constraints: base(),
        invoke: async () => {
          throw new ProviderError("quota_exhausted", "429", { httpStatus: 429, sent: false });
        },
      }),
    ).rejects.toThrow(/Stop on 429/);
    expect(sink.receipts.map((r) => r.outcome)).toEqual(["rate_limited", "exhausted_free"]);
    expect(sink.receipts[1]).toMatchObject({
      errorCode: "no_eligible_model",
      model: "gemini/3.8-flash-lite-tts",
    });

    const s2 = new MemoryReceiptSink();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRouted({
        task: "screen.plan",
        caller: "t",
        sink: s2,
        signal: controller.signal,
        constraints: base(),
        invoke: ok(),
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(s2.receipts.map((r) => r.outcome)).toEqual(["cancelled"]);

    const s3 = new MemoryReceiptSink();
    const calls: string[] = [];
    await expect(
      runRouted({
        task: "screen.plan",
        caller: "t",
        sink: s3,
        constraints: base(),
        invoke: async (c) => {
          calls.push(c.model);
          throw new ProviderError("bad_request", "400", { httpStatus: 400, sent: false });
        },
      }),
    ).rejects.toThrow();
    // REVIEW-E12 BL2: a 400 is that model's refusal; a read-only task continues down its chain.
    expect(calls).toEqual(["groq/gpt-oss-120b", "groq/gpt-oss-20b"]);
    expect(s3.receipts.at(-1)!.outcome).toBe("exhausted_free");

    // A site rule that says stop (e.g. Gemini flash on a 401/403) ends the chain on the first model.
    const stopCalls: string[] = [];
    await expect(
      runRouted({
        task: "screen.plan",
        caller: "t",
        sink: new MemoryReceiptSink(),
        constraints: base(),
        invoke: async (c) => {
          stopCalls.push(c.model);
          throw new ProviderError("auth", "403", { httpStatus: 403, sent: false, stop: true });
        },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(stopCalls).toHaveLength(1);
  });

  test("a model outside the task writes a refused_policy receipt", async () => {
    const sink = new MemoryReceiptSink();
    await expect(
      runRouted({
        task: "voice.brain",
        caller: "t",
        sink,
        constraints: base({ selected: "openrouter/deepseek-v4-pro" }),
        invoke: ok(),
      }),
    ).rejects.toBeInstanceOf(RouteError);
    expect(sink.receipts[0]).toMatchObject({ outcome: "refused_policy", errorCode: "policy" });
  });
});

test("(E2) a freshly generated request id skips the history read and claim; a caller-supplied one is checked", async () => {
  let reads = 0;
  let claims = 0;
  const inner = new MemoryReceiptSink();
  const sink = {
    write: (r: Parameters<typeof inner.write>[0]) => inner.write(r),
    forRequest: (id: string) => (reads++, inner.forRequest(id)),
    claim: (id: string) => (claims++, inner.claim(id)),
    release: (id: string) => inner.release(id),
  };
  const invoke = async () => ({ value: "ok" });
  await runRouted({ task: "screen.plan", caller: "t", sink, constraints: { hasKey: () => true, health: new MemoryHealthStore() }, invoke });
  expect([reads, claims]).toEqual([0, 0]);
  await runRouted({ task: "screen.plan", caller: "t", requestId: "fixed-1", sink, constraints: { hasKey: () => true, health: new MemoryHealthStore() }, invoke });
  expect([reads, claims]).toEqual([1, 1]);
  await expect(runRouted({ task: "screen.plan", caller: "t", requestId: "fixed-1", sink, constraints: { hasKey: () => true, health: new MemoryHealthStore() }, invoke })).rejects.toBeInstanceOf(ReplayRefused);
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAiRequest,
  codexOwner,
  extractTranscriptUsage,
  monthInfo,
  parseClaudePlanUsage,
  parseCodexUsage,
  parseDeepseekBalance,
  parseElevenCharacterStats,
  parseFx,
  parseOpenRouterKey,
  parseRateLimitHeaders,
  parseRetellCosts,
  projectMonth,
  toAud,
  usdToAud,
  windowLabel,
} from "./parsers";
import { chatgptPlanName, chatgptPriceId, claudeApiCostUsd, claudePriceKey } from "./prices";
import { emptyCounts, recordCall } from "./call-counter";
import { createTranscriptScanner } from "./transcripts";
import { applySettingsPatch, blankSettings, priceSettings } from "./snapshot";

const fx = { usdToAud: 1.5 };

describe("money", () => {
  test("AUD prices that include GST pass through unchanged", () => {
    expect(toAud(340, "AUD", true, null)).toEqual({ aud: 340, original: { amount: 340, currency: "AUD" } });
  });
  test("USD subscriptions get 10% GST, then convert", () => {
    expect(toAud(100, "USD", false, fx)?.aud).toBe(165); // 100 × 1.1 × 1.5
    expect(toAud(20, "USD", false, { usdToAud: 1.419544 })?.aud).toBe(31.23);
  });
  test("no rate means no converted number (never a guess)", () => {
    expect(toAud(20, "USD", false, null)).toBeNull();
    expect(usdToAud(5, null)).toBeNull();
    expect(usdToAud(5, { usdToAud: 0 })).toBeNull();
  });
  test("metered USD converts without adding GST", () => {
    expect(usdToAud(0.27, fx)?.aud).toBe(0.41);
  });
  test("FX payload", () => {
    const rate = parseFx({ result: "success", time_last_update_utc: "Thu, 24 Sep 2026 00:02:32 +0000", rates: { AUD: 1.42 } });
    expect(rate?.usdToAud).toBe(1.42);
    expect(rate?.asOf).toBe("2026-09-24T00:02:32.000Z");
    expect(parseFx({ result: "error" })).toBeNull();
    expect(parseFx({ result: "success", rates: { AUD: -1 } })).toBeNull();
  });
});

describe("month maths", () => {
  test("month bounds and elapsed days", () => {
    const m = monthInfo(new Date(2026, 8, 24, 12));
    expect(m.daysInMonth).toBe(30);
    expect(m.dayOfMonth).toBe(24);
    expect(m.start.getDate()).toBe(1);
    expect(m.elapsedDays).toBeCloseTo(23.5, 5);
  });
  test("projection: fixed in full, metered at its daily rate", () => {
    expect(projectMonth(600, 10, { elapsedDays: 10, daysInMonth: 30 })).toBe(630);
    // Early in the month a few hours of use doesn't explode (first day counts as a whole day).
    expect(projectMonth(0, 1, { elapsedDays: 1, daysInMonth: 31 })).toBe(31);
    expect(projectMonth(0, 1, { elapsedDays: 0.1 as number, daysInMonth: 31 } as any)).toBe(31);
  });
});

describe("Codex usage", () => {
  const payload = {
    plan_type: "prolite",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 57, limit_window_seconds: 604800, reset_after_seconds: 192650, reset_at: 1790422270 },
      secondary_window: null,
    },
    credits: { has_credits: true, balance: "50.5232920000" },
    rate_limit_reset_credits: { available_count: 1 },
    email: "someone@example.com",
  };
  test("weekly-only plan", () => {
    const u = parseCodexUsage(payload)!;
    expect(u.planSlug).toBe("prolite");
    expect(u.windows).toEqual([{ label: "Weekly", usedPercent: 57, resetsAt: new Date(1790422270 * 1000).toISOString(), windowSeconds: 604800 }]);
    expect(u.notes[0]).toContain("50.52 Codex credits");
    expect(u.notes.join(" ")).toContain("1 banked limit reset");
    expect(JSON.stringify(u)).not.toContain("example.com");
  });
  test("5-hour + weekly plan, reset from reset_after when reset_at is missing", () => {
    const u = parseCodexUsage(
      { plan_type: "plus", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 60 }, secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1790724275 } } },
      1_000_000,
    )!;
    expect(u.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
    expect(u.windows[0].resetsAt).toBe(new Date(1_060_000).toISOString());
  });
  test("limit reached", () => {
    expect(parseCodexUsage({ rate_limit: { allowed: false, primary_window: { used_percent: 100 } } })!.limitReached).toBe(true);
  });
  test("garbage", () => {
    expect(parseCodexUsage(null)).toBeNull();
    expect(parseCodexUsage({})).toBeNull();
  });
  test("window labels", () => {
    expect(windowLabel(18000)).toBe("5-hour");
    expect(windowLabel(604800)).toBe("Weekly");
    expect(windowLabel(86400)).toBe("1-day");
  });
  test("owner mapping: M&U by domain, Usman by Plus, overrides win", () => {
    expect(codexOwner({ label: "openai-1", emailDomain: "muventures.com.au", planSlug: "prolite" })).toBe("M&U Ventures");
    expect(codexOwner({ label: "openai-2", emailDomain: "gmail.com", planSlug: "plus" })).toBe("Usman");
    expect(codexOwner({ label: "openai-3", emailDomain: "gmail.com", planSlug: "prolite" })).toBe("Mehroz");
    expect(codexOwner({ label: "openai-3", emailDomain: "gmail.com", planSlug: "prolite" }, { "openai-3": "Mehroz (Pro)" })).toBe("Mehroz (Pro)");
  });
  test("plan slugs map to the right price", () => {
    expect(chatgptPriceId("prolite")).toBe("chatgpt-pro-100");
    expect(chatgptPriceId("pro")).toBe("chatgpt-pro-200");
    expect(chatgptPriceId("plus")).toBe("chatgpt-plus");
    expect(chatgptPriceId("enterprise")).toBeNull();
    expect(chatgptPlanName("prolite")).toBe("ChatGPT Pro (US$100 tier)");
  });
});

describe("Claude plan usage", () => {
  test("session, weekly and per-model weekly windows", () => {
    const u = parseClaudePlanUsage({
      five_hour: { utilization: 10, resets_at: "2026-09-24T06:09:59Z" },
      seven_day: { utilization: 45, resets_at: "2026-09-28T01:59:59Z" },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      limits: [
        { kind: "session", percent: 10 },
        { kind: "weekly_scoped", percent: 10, resets_at: "2026-09-28T01:59:59Z", scope: { model: { display_name: "Fable" } } },
      ],
    })!;
    expect(u.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Session (5-hour)", 10],
      ["Weekly · all models", 45],
      ["Weekly · Fable", 10],
    ]);
    expect(u.extraUsageEnabled).toBe(false);
  });
  test("nothing usable → null", () => {
    expect(parseClaudePlanUsage({ five_hour: null })).toBeNull();
  });
});

describe("API key payloads", () => {
  test("OpenRouter key", () => {
    const k = parseOpenRouterKey({ data: { label: "sk-or-v1-97a...317", limit: 19, limit_remaining: 18.95, usage: 0.0512, usage_monthly: 0.0512, is_free_tier: true } })!;
    expect(k).toEqual({ label: "sk-or-v1-97a...317", limit: 19, limitRemaining: 18.95, usageTotal: 0.0512, usageMonthly: 0.0512, isFreeTier: true });
    expect(parseOpenRouterKey({ data: { limit: 0, usage: 0 } })!.limit).toBe(0);
    expect(parseOpenRouterKey({ error: "nope" })).toBeNull();
  });
  test("ElevenLabs character stats", () => {
    const s = parseElevenCharacterStats({ time: [1, 2], usage: { TTS: [100, 50], "Conversational AI": [10, 0] } })!;
    expect(s.total).toBe(160);
    expect(parseElevenCharacterStats({ usage: { All: [1, 2, 3] } })!.total).toBe(6);
  });
  test("Retell: cents → dollars, month filter, nothing else read", () => {
    const calls = [
      { start_timestamp: 2000, call_cost: { combined_cost: 27.3166742, total_duration_seconds: 113 }, transcript: "private" },
      { start_timestamp: 500, call_cost: { combined_cost: 1000 } },
    ];
    expect(parseRetellCosts(calls, 1000)).toEqual({ calls: 1, costUsd: 0.273166742, seconds: 113 });
    expect(parseRetellCosts({}, 0)).toBeNull();
  });
  test("DeepSeek balance", () => {
    expect(parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "0.98" }] })).toEqual({ available: true, balances: [{ currency: "USD", total: 0.98 }] });
  });
});

describe("Claude API-equivalent pricing", () => {
  test("model keys, aliases and suffixes", () => {
    expect(claudePriceKey("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(claudePriceKey("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(claudePriceKey("sonnet")).toBe("claude-sonnet-5");
    expect(claudePriceKey("nvidia/nemotron:free")).toBeNull();
  });
  test("cost per token class", () => {
    const m = 1_000_000;
    // Opus 5: $5 in, $25 out, $0.50 cache read, $6.25 5-min write, $10 1-hour write.
    expect(claudeApiCostUsd("claude-opus-5", { input: m, output: m, cacheRead: m, write5m: m, write1h: m })).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 10, 6);
    // Fable 5.1's cache reads are $0.25; Opus 5.5's $0.20.
    expect(claudeApiCostUsd("claude-fable-5-1", { input: 0, output: 0, cacheRead: m, write5m: 0, write1h: 0 })).toBeCloseTo(0.25, 6);
    expect(claudeApiCostUsd("claude-opus-5-5", { input: 0, output: 0, cacheRead: m, write5m: 0, write1h: 0 })).toBeCloseTo(0.2, 6);
    expect(claudeApiCostUsd("gpt-6-sol", { input: m, output: 0, cacheRead: 0, write5m: 0, write1h: 0 })).toBeNull();
  });
});

describe("transcript usage extraction", () => {
  const line = (over: Record<string, unknown> = {}, text = "hello") =>
    JSON.stringify({
      parentUuid: "x",
      message: {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 15, output_tokens: 110, cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 0 } },
      },
      requestId: "req_01XYZ",
      type: "assistant",
      timestamp: "2026-09-24T02:18:32.830Z",
      ...over,
    });
  test("reads usage, model, ids and time", () => {
    const u = extractTranscriptUsage(line())!;
    expect(u).toEqual({ key: "msg_01ABC:req_01XYZ", model: "claude-opus-5", timestampMs: Date.parse("2026-09-24T02:18:32.830Z"), counts: { input: 2, output: 110, cacheRead: 15, write5m: 0, write1h: 30 } });
  });
  test("message text can't spoof the fields", () => {
    const spoof = 'x "model":"claude-fable-5-1" "usage":{"input_tokens":999999} "timestamp":"2020-01-01T00:00:00Z"';
    const u = extractTranscriptUsage(line({}, spoof))!;
    expect(u.model).toBe("claude-opus-5");
    expect(u.counts.input).toBe(2);
    expect(u.timestampMs).toBe(Date.parse("2026-09-24T02:18:32.830Z"));
  });
  test("older lines without the TTL split count as 5-minute writes", () => {
    const old = JSON.stringify({ message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 40 } }, type: "assistant", timestamp: "2026-09-02T00:00:00Z" });
    expect(extractTranscriptUsage(old)!.counts).toEqual({ input: 1, output: 1, cacheRead: 0, write5m: 40, write1h: 0 });
  });
  test("user lines and synthetic messages are skipped", () => {
    expect(extractTranscriptUsage(line({ type: "user" }))).toBeNull();
    expect(extractTranscriptUsage(line().replace('"claude-opus-5"', '"<synthetic>"'))).toBeNull();
  });
});

describe("transcript scanner", () => {
  test("dedupes repeated lines of one API response, filters to this month, reads incrementally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiu-tx-"));
    try {
      mkdirSync(join(dir, "proj", "sub"), { recursive: true });
      const mk = (id: string, ts: string, out: number) =>
        JSON.stringify({ message: { id, model: "claude-opus-5[1m]", content: [{ type: "text", text: "t" }], usage: { input_tokens: 1, output_tokens: out } }, requestId: `req_${id}`, type: "assistant", timestamp: ts });
      const f = join(dir, "proj", "a.jsonl");
      writeFileSync(f, [mk("msg_a", "2026-09-10T00:00:00Z", 10), mk("msg_a", "2026-09-10T00:00:00Z", 10), mk("msg_old", "2026-08-30T00:00:00Z", 99), ""].join("\n"));
      writeFileSync(join(dir, "proj", "sub", "agent.jsonl"), mk("msg_b", "2026-09-11T00:00:00Z", 5) + "\n" + mk("msg_a", "2026-09-10T00:00:00Z", 10) + "\n");
      const s = createTranscriptScanner({ dir, now: () => new Date(2026, 8, 24) });
      let t = await s.scan();
      expect(t.byModel["claude-opus-5"]).toEqual({ requests: 2, counts: { input: 2, output: 15, cacheRead: 0, write5m: 0, write1h: 0 } });
      writeFileSync(f, [mk("msg_a", "2026-09-10T00:00:00Z", 10), mk("msg_a", "2026-09-10T00:00:00Z", 10), mk("msg_old", "2026-08-30T00:00:00Z", 99), mk("msg_c", "2026-09-12T00:00:00Z", 7), ""].join("\n"));
      t = await s.scan();
      expect(t.byModel["claude-opus-5"].requests).toBe(3);
      expect(t.byModel["claude-opus-5"].counts.output).toBe(22);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("local call counter", () => {
  test("classifies provider traffic by host and path, ignoring query strings", () => {
    expect(classifyAiRequest("https://api.groq.com/openai/v1/chat/completions")).toEqual({ provider: "groq", kind: "chat" });
    expect(classifyAiRequest("https://api.groq.com/openai/v1/audio/speech")).toEqual({ provider: "groq", kind: "speech" });
    expect(classifyAiRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=SECRET")).toEqual({ provider: "gemini", kind: "gemini-2.5-flash-lite" });
    expect(classifyAiRequest("https://api.typesafe.ai/v1/systemone")).toEqual({ provider: "typesafe", kind: "systemone" });
    expect(classifyAiRequest("https://api.typesafe.ai/")).toBeNull(); // the free keep-warm HEAD
    expect(classifyAiRequest("https://api.openai.com/v1/models")).toBeNull();
  });
  test("records per day with provider rate-limit headers", () => {
    const c = emptyCounts(new Date(2026, 8, 24));
    const h = parseRateLimitHeaders((n) => ({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "993" } as Record<string, string>)[n] ?? null);
    expect(recordCall(c, "https://api.groq.com/openai/v1/chat/completions", 200, h, new Date(2026, 8, 24, 9))).toBe(true);
    expect(recordCall(c, "https://api.groq.com/openai/v1/chat/completions", 429, null, new Date(2026, 8, 24, 10))).toBe(true);
    expect(recordCall(c, "https://example.com/", 200, null)).toBe(false);
    expect(c.days["2026-09-24"]["groq:chat"]).toEqual({ calls: 2, errors: 1 });
    expect(c.headers["groq:chat"].remainingRequests).toBe(993);
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });
});

describe("price settings", () => {
  test("defaults, edits and resets", () => {
    let s = blankSettings();
    expect(priceSettings(s).find((p) => p.id === "claude-max-20x")).toMatchObject({ amount: 340, currency: "AUD", gstIncluded: true, edited: false });
    s = applySettingsPatch(s, { prices: { "chatgpt-plus": { amount: "32.5", currency: "AUD", gstIncluded: true } } });
    expect(priceSettings(s).find((p) => p.id === "chatgpt-plus")).toMatchObject({ amount: 32.5, currency: "AUD", gstIncluded: true, edited: true, source: "Set by you" });
    s = applySettingsPatch(s, { prices: { "chatgpt-plus": null } });
    expect(priceSettings(s).find((p) => p.id === "chatgpt-plus")!.edited).toBe(false);
  });
  test("rejects bad input", () => {
    expect(() => applySettingsPatch(blankSettings(), { prices: { nope: { amount: 1, currency: "AUD" } } })).toThrow("Unknown price");
    expect(() => applySettingsPatch(blankSettings(), { prices: { "chatgpt-plus": { amount: -1, currency: "AUD" } } })).toThrow();
    expect(() => applySettingsPatch(blankSettings(), { prices: { "chatgpt-plus": { amount: 1, currency: "EUR" } } })).toThrow("Currency");
    expect(() => applySettingsPatch(blankSettings(), { owners: { "../x": "a" } })).toThrow();
  });
});

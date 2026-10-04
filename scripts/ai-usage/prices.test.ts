import { describe, expect, test } from "bun:test";
import { catalogue } from "../model-router/catalogue";
import {
  CLAUDE_API_PRICES,
  HISTORICAL_CLAUDE_API_PRICES,
  catalogueClaudePrices,
  catalogueTokenPrice,
  claudeApiCostUsd,
  claudePriceKey,
} from "./prices";

describe("prices read the router catalogue", () => {
  test("every Claude model the catalogue routes is priced from its apiListUsdPerM", () => {
    const claude = catalogue().models.filter((m) => m.provider === "claude-sub" && m.cost.apiListUsdPerM);
    expect(claude.length).toBeGreaterThan(0);
    const fromCat = catalogueClaudePrices();
    for (const m of claude) {
      const p = CLAUDE_API_PRICES[claudePriceKey(m.providerModel)!];
      expect(p.input).toBe(m.cost.apiListUsdPerM![0]);
      expect(p.output).toBe(m.cost.apiListUsdPerM![1]);
      expect(fromCat[m.providerModel].priceAsOf).toBe(m.cost.priceAsOf ?? null);
    }
  });

  test("the historical table holds only models the catalogue does not route", () => {
    const routed = new Set(catalogue().models.map((m) => m.providerModel));
    for (const id of Object.keys(HISTORICAL_CLAUDE_API_PRICES)) expect(routed.has(id)).toBe(false);
    // Old transcripts still cost out, at the same rates as before E2.
    expect(claudePriceKey("claude-opus-4-7-20260418")).toBe("claude-opus-4-7");
    expect(claudeApiCostUsd("claude-opus-4-7", { input: 1_000_000, output: 1_000_000, cacheRead: 0, write5m: 0, write1h: 0 })).toBeCloseTo(30, 6);
    // Claude 3.x was never priced on /usage; it stays unpriced (unknown, not guessed).
    expect(claudePriceKey("claude-3-5-sonnet-20241022")).toBeNull();
  });

  test("metered prices come from the catalogue with their date; free and plan models have none", () => {
    expect(catalogueTokenPrice("openrouter/mimo-v2.6-flash")).toEqual({ inputUsdPerM: 0.14, outputUsdPerM: 0.28, priceAsOf: "2026-09-27" });
    expect(catalogueTokenPrice("google/gemini-2.5-flash-lite", "openrouter")).toEqual({ inputUsdPerM: 0.1, outputUsdPerM: 0.4, priceAsOf: "2026-09-27" });
    expect(catalogueTokenPrice("groq/gpt-oss-120b")).toBeNull(); // free: never a price that reads as spend
    expect(catalogueTokenPrice("claude/opus-5-5")).toBeNull(); // subscription: list value, not spend
    expect(catalogueTokenPrice("elevenlabs/flash-v2-5")).toBeNull(); // credits: unknown per token
    expect(catalogueTokenPrice("nope/nothing")).toBeNull();
  });
});

// REVIEW-E12 repro, now asserting the FIXED behaviour: pre-E1 flash threw on a direct-Gemini 401/403 (not fallback-worthy); post-E1 it falls through to paid OpenRouter.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiGenerate, isFallbackWorthy } from "../llm/gemini";
import { MemoryReceiptSink } from "../model-router/receipts";
test("BL4b (fixed): flash on a Gemini 403 stops, as before E1; nothing is spent on OpenRouter", async () => {
  expect(isFallbackWorthy(403, "PERMISSION_DENIED")).toBe(false); // the pre-E1 rule, still exported
  const root = mkdtempSync(join(tmpdir(), "rv-"));
  const sink = new MemoryReceiptSink();
  const urls: string[] = [];
  const request = (async (url: string) => { urls.push(url);
    if (url.includes("generativelanguage")) return new Response("{\"error\":{\"status\":\"PERMISSION_DENIED\"}}", { status: 403 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }], model: "google/gemini-2.5-flash-lite", usage: { cost: 0.001 } }), { status: 200 }); }) as unknown as typeof fetch;
  await expect(geminiGenerate({ tier: "flash", parts: [{ text: "x" }], root, home: root, env: { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "k" } as any, request, sink, retryDelaysMs: [] })).rejects.toThrow(/403/);
  expect(urls.some((u) => u.includes("openrouter"))).toBe(false);
  expect(urls.filter((u) => u.includes("generativelanguage"))).toHaveLength(1);
  // A later call tries direct Gemini again (no 30-minute auth sit-out that would send it to paid OpenRouter).
  const again = await geminiGenerate({ tier: "flash", parts: [{ text: "x" }], root, home: root, env: { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "k" } as any, request: (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 }); }) as unknown as typeof fetch, sink, retryDelaysMs: [] });
  expect(again.provider).toBe("gemini");
});

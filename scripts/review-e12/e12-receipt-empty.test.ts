// REVIEW-E12 repro, now asserting the FIXED behaviour: a PAID OpenRouter call that ran but returned empty text is receipted as $0 "refused_before_work".
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiGenerate } from "../llm/gemini";
import { MemoryReceiptSink } from "../model-router/receipts";
test("BL5 (fixed): a paid call that ran and answered empty is never booked as $0", async () => {
  const root = mkdtempSync(join(tmpdir(), "rv-"));
  const sink = new MemoryReceiptSink();
  const request = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 5000, completion_tokens: 900 } }), { status: 200 })) as unknown as typeof fetch;
  await geminiGenerate({ tier: "pro", parts: [{ text: "x" }], root, home: root, env: { OPENROUTER_API_KEY: "k" } as any, request, sink, retryDelaysMs: [] }).catch(() => null);
  const r = sink.receipts.map((x) => [x.model, x.route, x.outcome, x.sent, x.costUsd, x.costBasis]);
  console.log(r);
  expect(r[0]).toEqual(["openrouter/gemini-3.1-pro-preview", "metered", "failed", true, null, "unknown"]); // sent: possibly ran; cost unknown
});

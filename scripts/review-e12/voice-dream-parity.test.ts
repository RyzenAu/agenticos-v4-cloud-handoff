import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { dreamLimits, dreamSelection } from "../dream/core";
import { MemoryReceiptSink } from "../model-router/receipts";
import { MemoryHealthStore } from "../model-router/health";

test("F (fixed, M5): the Gemini voice calls its pre-E2 model gemini-3.1-flash-tts-preview", async () => {
  const urls: string[] = [];
  const voice = freeVoice(mkdtempSync(join(tmpdir(), "fv-")), {
    key: (n: string) => (n === "GROQ_API_KEY" || n === "GEMINI_API_KEY" ? "x" : ""),
    sink: new MemoryReceiptSink(), health: new MemoryHealthStore(),
    fetch: (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.from([0, 0]).toString("base64") } }] } }] })); }) as any,
  } as any);
  await voice.handle("/voice/free/configure", { tts: "gemini" });
  await voice.handle("/voice/free/tts", { text: "Hello there." });
  console.log("F:", urls);
  expect(urls[0]).toContain("gemini-3.1-flash-tts-preview");
});

test("G (fixed, M4): a pre-E2-valid dream.model outside the catalogue runs as saved", () => {
  for (const m of ["claude-haiku-4-5", "opus", "claude-opus-4-1", "claude-sonnet-5"]) {
    const l = dreamLimits({ dream: { model: m } });
    const s = dreamSelection("claude", { dream: { model: m } });
    console.log("G:", m, "->", l.model, "runs", s.runs);
  }
  for (const m of ["claude-haiku-4-5", "opus", "claude-opus-4-1", "claude-sonnet-5"]) expect(dreamSelection("claude", { dream: { model: m } }).runs).toBe(m);
});

test("H: Dream OpenRouter: all 6 dropdown ids run as picked", () => {
  for (const id of ["anthropic/claude-fable-5", "anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "google/gemini-3.5-flash", "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat"]) {
    const s = dreamSelection("openrouter", { openRouterModel: id });
    expect(s.runs).toBe(id);
  }
  expect(dreamSelection("openrouter", {}).runs).toBe("anthropic/claude-fable-5");
});

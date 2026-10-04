// REVIEW-E12 repro, now asserting the FIXED behaviour: pre-E2 vision tried every Gemini model after ANY non-OK status; post-E2 an HTTP 400
// from one engine ends the chain (runRouted: bad_request -> throw).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryReceiptSink } from "../model-router/receipts";
import { MemoryHealthStore } from "../model-router/health";
import { describeScreen } from "../vision";

const root = mkdtempSync(join(tmpdir(), "rv-"));
const env = { GEMINI_API_KEY: "gem-fixture" } as NodeJS.ProcessEnv; // no Groq key: Hermes then Gemini, as pre-E2
const FRAME = { image: "QUJD", mime: "image/jpeg" };

test("BL2 (fixed): a Hermes 400 falls through to Gemini, as before E2", async () => {
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    if (url.includes("8642")) return new Response("{\"error\":\"image too large\"}", { status: 400 });
    if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Save is top right" }] } }] }), { status: 200 });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  const sink = new MemoryReceiptSink();
  let err: unknown = null;
  try { await describeScreen(root, { ...FRAME, question: "q" }, request, { sink, env, home: root, hermesKey: () => "k", health: new MemoryHealthStore() }); } catch (e) { err = e; }
  console.log("urls", urls, "err", String(err), sink.receipts.map((r) => [r.model, r.outcome, r.errorCode]));
  expect(urls.some((u) => u.includes("generativelanguage"))).toBe(true);
  expect(err).toBeNull();
});

test("BL2 (fixed): a Gemini 3.8 400 moves on to 3.7-flash", async () => {
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    if (url.includes("8642")) return Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    if (url.includes("gemini-3.8-flash:")) return new Response("{}", { status: 400 });
    if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  const sink = new MemoryReceiptSink();
  let err: unknown = null;
  try { await describeScreen(root, { ...FRAME, question: "q" }, request, { sink, env, home: root, hermesKey: () => "k", health: new MemoryHealthStore() }); } catch (e) { err = e; }
  console.log("urls", urls.map((u) => u.slice(-40)), "err", String(err));
  expect(urls.filter((u) => u.includes("generativelanguage")).length).toBe(2);
  expect(err).toBeNull();
});

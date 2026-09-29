// REVIEW-E12 R2 variants (new cases beyond the 44 ported repros). Zero network: every provider is a fake.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevDecide } from "../jev-client";
import { modelRouterRoute } from "../model-router/api";
import { httpProviderError } from "../model-router/clients";
import { MemoryHealthStore, routerHealthStore } from "../model-router/health";
import { JsonlReceiptSink, MemoryReceiptSink, type ReceiptSink } from "../model-router/receipts";
import { MaybeExecuted, ProviderError, ReplayRefused, route, runRouted } from "../model-router/router";
import { clearPublishedUsage, publishUsageSnapshot } from "../model-router/allowance";
import { describeScreen } from "../vision";
import { geminiGenerate } from "../llm/gemini";
import { callMimo } from "../llm/mimo";

const hasKey = () => true;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "e12r2-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  delete process.env.MU_ROUTER_REAL_FILES;
  clearPublishedUsage();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ok = (answers: unknown) => new Response(JSON.stringify({ answers }), { status: 200 });

test("N1 BL1: production health (real files): a 404 on screen.point does not stop the next guardian call; failure mirrored", async () => {
  process.env.MU_ROUTER_REAL_FILES = "1";
  const root = tmp();
  let calls = 0;
  const r1 = await jevDecide({ surface: "screen.point", key: "k", state: {}, questions: {}, root, sink: new MemoryReceiptSink(),
    request: (async () => { calls++; return new Response("nope", { status: 404 }); }) as any, sleep: async () => {} });
  expect(r1.ok).toBe(false);
  await new Promise((r) => setImmediate(r));
  expect(routerHealthStore(root).model("typesafe/jev-latest").state).toBe("down");
  const r2 = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, root, sink: new MemoryReceiptSink(),
    request: (async () => { calls++; return ok({ decision: "allow" }); }) as any });
  expect(r2.ok).toBe(true);
  expect(calls).toBe(2);
});

// Receipt writes always fail (EBUSY receipts file) but the JSONL claim store works.
const brokenWrites = (file: string): ReceiptSink => {
  const j = new JsonlReceiptSink(file);
  return {
    write() { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); },
    forRequest: (id) => j.forRequest(id),
    claim: (id) => j.claim(id),
    release: (id) => j.release(id),
  };
};

test("N2 H1 x no-replay: failed receipt writes do not reopen a possibly-sent side-effecting step (across a restart)", async () => {
  const file = join(tmp(), "receipts.jsonl");
  let calls = 0;
  const req = () => ({ task: "agent.hermes", caller: "x", requestId: "n2-sidefx-000001", sink: brokenWrites(file),
    constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async () => { calls++; throw httpProviderError(502, "bad gateway"); } });
  await expect(runRouted(req())).rejects.toBeInstanceOf(MaybeExecuted);
  await expect(runRouted(req())).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
});

test("N3 H1: a side-effecting success with a failed receipt write returns the value and still holds the claim", async () => {
  const file = join(tmp(), "receipts.jsonl");
  let calls = 0;
  const req = () => ({ task: "agent.hermes", caller: "x", requestId: "n3-sidefx-000001", sink: brokenWrites(file),
    constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async () => { calls++; return { value: "done" }; } });
  expect((await runRouted(req())).value).toBe("done");
  await expect(runRouted(req())).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
});

test("N4 BL2: a 400 continues on a read-only task but still stops a side-effecting one", async () => {
  const seenRO: string[] = [];
  const seenSE: string[] = [];
  await runRouted({ task: "meeting.notes", caller: "x", sink: new MemoryReceiptSink(), constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async (c) => { seenRO.push(c.model); if (seenRO.length === 1) throw httpProviderError(400, "bad"); return { value: "ok" }; } });
  expect(seenRO.length).toBe(2);
  await expect(runRouted({ task: "agent.hermes", caller: "x", sink: new MemoryReceiptSink(), constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async (c) => { seenSE.push(c.model); throw new ProviderError("bad_request", "bad", { httpStatus: 400, sent: false }); } })).rejects.toBeInstanceOf(ProviderError);
  expect(seenSE.length).toBe(1);
});

test("N5 BL3: at 100% the Claude bridge and chained sites still start on Claude; the reading is recorded", () => {
  publishUsageSnapshot({ generatedAt: new Date().toISOString(), subscriptions: [
    { provider: "anthropic", plan: "Max", id: "claude", status: { ok: true, windows: [{ label: "session", usedPercent: 100, resetsAt: null }] } }] } as any);
  for (const t of ["bridge.claude", "meeting.notes", "cad.code", "vision.point", "callscript"]) {
    const c = route(t, { hasKey });
    expect(c.model).toBe("claude/sonnet-5");
    expect(c.allowance?.usedPct).toBe(100);
  }
});

test("N6 BL5: a metered call that ran and failed empty keeps its reported cost; without one it stays null", async () => {
  const run = (sink: MemoryReceiptSink, cost?: number) => runRouted({ task: "bulk.text", caller: "x", sink,
    constraints: { hasKey, selected: "openrouter/mimo-v2.6-pro", providers: ["openrouter"],
      exclude: ["openrouter/deepseek-v4.1-flash", "openrouter/mimo-v2.6-flash"], health: new MemoryHealthStore() },
    invoke: async () => { throw new ProviderError("unavailable", "empty", { httpStatus: 200, sent: "unknown", costUsd: cost }); } }).catch((e) => e);
  const s1 = new MemoryReceiptSink();
  await run(s1, 0.0021);
  expect([s1.receipts[0].costUsd, s1.receipts[0].costBasis]).toEqual([0.0021, "provider_reported"]);
  const s2 = new MemoryReceiptSink();
  await run(s2);
  expect([s2.receipts[0].costUsd, s2.receipts[0].costBasis]).toEqual([null, "unknown"]);
});

test("N7 M1: vision with the default per-call health: a Hermes 503 on one call does not skip Hermes on the next", async () => {
  const root = tmp();
  const env = { GEMINI_API_KEY: "g" } as NodeJS.ProcessEnv;
  let hermes = 0;
  const mk = (fail: boolean) => (async (url: string) => {
    if (url.includes("8642")) {
      hermes++;
      return fail ? new Response("x", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], model: "gpt-6-sol" }), { status: 200 });
    }
    if (url.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "g" }] } }] }), { status: 200 });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  const frame = { image: "QUJD", mime: "image/jpeg", question: "q" } as any;
  await describeScreen(root, frame, mk(true), { sink: new MemoryReceiptSink(), env, home: root, hermesKey: () => "k" });
  await describeScreen(root, frame, mk(false), { sink: new MemoryReceiptSink(), env, home: root, hermesKey: () => "k" });
  expect(hermes).toBe(2);
});

test("N8 BL4b: flash on a Gemini 400 stops (pre-E1 rule); on 503 everywhere the kept paid flash-lite leg still runs", async () => {
  const root = tmp();
  const env = { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "k" } as any;
  const urls: string[] = [];
  const r400 = (async (url: string) => {
    urls.push(url);
    return url.includes("generativelanguage") ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ choices: [{ message: { content: "a" } }] }), { status: 200 });
  }) as any;
  await expect(geminiGenerate({ tier: "flash", parts: [{ text: "x" }], root, home: root, env, request: r400, sink: new MemoryReceiptSink(), retryDelaysMs: [] })).rejects.toBeDefined();
  expect(urls.some((u) => u.includes("openrouter"))).toBe(false);
  const r503 = (async (url: string) =>
    url.includes("generativelanguage") ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "a" } }], model: "google/gemini-2.5-flash-lite" }), { status: 200 })) as any;
  const out = await geminiGenerate({ tier: "flash", parts: [{ text: "x" }], root, home: root, env, request: r503, sink: new MemoryReceiptSink(), retryDelaysMs: [] });
  expect(out.provider).toBe("openrouter");
});

test("N9 H2: the probe is PC-only; a remote GET of the view still works; local without token 403", async () => {
  let probed = 0;
  const probe = async () => { probed++; return []; };
  expect((await modelRouterRoute({ path: "/model-router/probe", method: "POST", remote: true, authenticated: true }, tmp(), { probe }))!.status).toBe(403);
  expect((await modelRouterRoute({ path: "/model-router", method: "GET", remote: true, authenticated: false }, tmp(), { probe }))!.status).toBe(200);
  expect((await modelRouterRoute({ path: "/model-router/probe", method: "POST", remote: false, authenticated: false }, tmp(), { probe }))!.status).toBe(403);
  expect(probed).toBe(0);
});

test("N10 M6 (fixed): a MIMO_BULK caller with MiMo refused (402) and free models limited never reaches paid OpenRouter DeepSeek", async () => {
  const root = tmp();
  const hits: string[] = [];
  const request = (async (_url: string, init: any) => {
    const model = String(JSON.parse(init.body).model);
    hits.push(model);
    if (model.includes("deepseek")) return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    if (model.includes("mimo")) return new Response("{}", { status: 402 });
    return new Response("{}", { status: 429 });
  }) as any;
  await expect(callMimo({ task: "lead-summary", messages: [{ role: "user", content: "x" }], root, home: root,
    env: { OPENROUTER_API_KEY: "k", GROQ_API_KEY: "g" } as any, request, sink: new MemoryReceiptSink(), health: new MemoryHealthStore() })).rejects.toThrow();
  expect(hits.some((m) => /deepseek/.test(m))).toBe(false); // before E1, bulk text never reached paid DeepSeek
  // A 402 on one call doesn't sit MiMo out for the next caller (per-call health by default).
  const again = await callMimo({ task: "lead-summary", messages: [{ role: "user", content: "x" }], root, home: root,
    env: { OPENROUTER_API_KEY: "k", GROQ_API_KEY: "g" } as any, sink: new MemoryReceiptSink(),
    request: (async (_u: string, init: any) => { hits.push(`2:${JSON.parse(init.body).model}`); return new Response(JSON.stringify({ choices: [{ message: { content: "mimo ok" } }], model: "xiaomi/mimo-v2.6-flash" }), { status: 200 }); }) as any });
  expect(again.text).toBe("mimo ok");
  expect(hits.at(-1)).toBe("2:xiaomi/mimo-v2.6-flash");
});

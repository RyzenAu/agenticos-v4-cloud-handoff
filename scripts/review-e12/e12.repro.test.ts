// REVIEW-E12 independent repros. Zero network: every provider is a fake.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRouterRoute } from "../model-router/api";
import { httpProviderError } from "../model-router/clients";
import { MemoryHealthStore } from "../model-router/health";
import { JsonlReceiptSink, MemoryReceiptSink, meteredSpendByProvider, summariseReceipts } from "../model-router/receipts";
import { MaybeExecuted, ProviderError, ReplayRefused, RouteError, runRouted, SinkRefused } from "../model-router/router";

const hasKey = () => true;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "e12-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("X1 side-effect timeout: never retried, never replayed (same id), even after a restart (new sink on same file)", async () => {
  const file = join(tmp(), "receipts.jsonl");
  let calls = 0;
  const invoke = async () => { calls++; const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  const req = (sink: any) => ({ task: "agent.hermes", caller: "x", requestId: "x1-req-0000000000", sink, invoke, constraints: { hasKey, health: new MemoryHealthStore() } });
  await expect(runRouted(req(new JsonlReceiptSink(file)))).rejects.toBeInstanceOf(MaybeExecuted);
  await expect(runRouted(req(new JsonlReceiptSink(file)))).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(1);
});

test("X2 side-effect 5xx: no fallback to the next candidate inside the same run", async () => {
  const seen: string[] = [];
  const sink = new MemoryReceiptSink();
  await expect(runRouted({ task: "agent.hermes", caller: "x", requestId: "x2", sink, constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async (c) => { seen.push(c.model); throw httpProviderError(503, "down"); } })).rejects.toBeInstanceOf(MaybeExecuted);
  expect(seen.length).toBe(1);
});

test("X3 side-effect refused before send (429): falls back, claim released afterwards only if nothing sent", async () => {
  const seen: string[] = [];
  const sink = new MemoryReceiptSink();
  await expect(runRouted({ task: "agent.hermes", caller: "x", requestId: "x3", sink, constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async (c) => { seen.push(c.model); throw httpProviderError(429, "slow down"); } })).rejects.toBeInstanceOf(RouteError);
  expect(seen.length).toBeGreaterThan(1);
  expect(sink.claims.get("x3")).toBe("released");
});

test("X4 concurrent same requestId across two JSONL sink instances: exactly one invoke", async () => {
  const file = join(tmp(), "receipts.jsonl");
  let calls = 0;
  const mk = () => runRouted({ task: "agent.hermes", caller: "x", requestId: "x4-same", sink: new JsonlReceiptSink(file), constraints: { hasKey, health: new MemoryHealthStore() },
    invoke: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return { value: "ok" }; } });
  const out = await Promise.allSettled([mk(), mk(), mk()]);
  expect(calls).toBe(1);
  expect(out.filter((o) => o.status === "fulfilled").length).toBe(1);
});

test("X5 a crash between claim and receipt (claim open, no rows): the step is refused, not re-run", async () => {
  const file = join(tmp(), "receipts.jsonl");
  new JsonlReceiptSink(file).claim("x5-crashed");
  let calls = 0;
  await expect(runRouted({ task: "bulk.text", caller: "x", requestId: "x5-crashed", sink: new JsonlReceiptSink(file), constraints: { hasKey },
    invoke: async () => { calls++; return { value: "ok" }; } })).rejects.toBeInstanceOf(ReplayRefused);
  expect(calls).toBe(0);
});

test("X6 sink missing claim/release is refused before anything runs", async () => {
  let calls = 0;
  const sink = { write() {}, forRequest() { return []; } } as any;
  await expect(runRouted({ task: "bulk.text", caller: "x", sink, invoke: async () => { calls++; return { value: 1 }; } })).rejects.toBeInstanceOf(SinkRefused);
  expect(calls).toBe(0);
});

test("X7 receipts: refusal/exhaustion rows are not calls; a sent:false 402 is $0; unknown cost stays null", async () => {
  const sink = new MemoryReceiptSink();
  await expect(runRouted({ task: "bulk.text", caller: "x", sink, constraints: { hasKey, selected: "openrouter/mimo-v2.6-pro", providers: ["openrouter"] },
    invoke: async () => { throw httpProviderError(402, "no funds"); } })).rejects.toBeDefined();
  const u = summariseReceipts(sink.receipts);
  const m = meteredSpendByProvider(sink.receipts);
  const calls = Object.values(u).reduce((n, x) => n + x.calls, 0);
  const attempts = sink.receipts.filter((r) => !["exhausted_free", "refused_policy", "replay_refused"].includes(r.outcome)).length;
  expect(calls).toBe(attempts);
  for (const r of sink.receipts.filter((r) => r.httpStatus === 402)) expect([r.costUsd, r.costBasis]).toEqual([0, "refused_before_work"]);
  expect(Object.values(m).reduce((n, x) => n + x.unknownCostCalls, 0)).toBe(0);
});

test("X8 access: /model-router GET and POST probe need the page token locally", async () => {
  const probe = async () => [];
  expect((await modelRouterRoute({ path: "/model-router", method: "GET", remote: false, authenticated: false }, tmp(), { probe }))!.status).toBe(403);
  expect((await modelRouterRoute({ path: "/model-router/probe", method: "POST", remote: false, authenticated: false }, tmp(), { probe }))!.status).toBe(403);
});

test("X9 (fixed, H2): the model probe is PC-only; a remote principal gets 403 and nothing runs", async () => {
  let probed = 0;
  const probe = async () => { probed++; return []; };
  const r = await modelRouterRoute({ path: "/model-router/probe", method: "POST", remote: true, authenticated: false }, tmp(), { probe });
  // Documents current behaviour: 200 and a probe run. Pre-B1 the middleware's internal page token stops a remote POST;
  // after B1, a remote person's OWN page token passes pageTokenMatches(), so this line is what decides.
  expect(r!.status).toBe(403);
  expect(probed).toBe(0);
});

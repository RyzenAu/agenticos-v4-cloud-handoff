import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevDecide } from "../jev-client";
import { MemoryHealthStore, routerHealthStore } from "../model-router/health";
import { MemoryReceiptSink, routerReceiptSink } from "../model-router/receipts";

const ok = () => new Response(JSON.stringify({ answers: { verdict: { choice: "APPROVE", confidence: 0.9 } } }), { status: 200 });
const status = (s: number) => new Response("err", { status: s });

test("A: one 503 on voice.reflex blacks out Jev for the guardian (no call made) for 60 s", async () => {
  const health = new MemoryHealthStore();
  let calls = 0;
  const failing = (async () => { calls++; return status(503); }) as unknown as typeof fetch;
  const r1 = await jevDecide({ surface: "voice.reflex", key: "k", state: {}, questions: {}, request: failing, health, sink: new MemoryReceiptSink(), sleep: async () => {} });
  expect(r1.ok).toBe(false);
  const before = calls;
  const healthy = (async () => { calls++; return ok(); }) as unknown as typeof fetch;
  const r2 = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, request: healthy, health, sink: new MemoryReceiptSink() });
  console.log("A:", { first: r1, guardianOk: r2.ok, reason: (r2 as any).reason, callsOnGuardian: calls - before, health: health.model("typesafe/jev-latest") });
  expect(r2.ok).toBe(false); // pre-E2: guardian would have called Jev and got APPROVE
  expect(calls - before).toBe(0);
});

test("B: one 404 sits Jev out for 6 hours on every surface", async () => {
  const health = new MemoryHealthStore();
  await jevDecide({ surface: "screen.point", key: "k", state: {}, questions: {}, request: (async () => status(404)) as any, health, sink: new MemoryReceiptSink() });
  const h = health.model("typesafe/jev-latest");
  console.log("B:", h.state, h.until);
  expect(h.state).toBe("down");
  expect(Date.parse(h.until!) - Date.now()).toBeGreaterThan(5 * 3600_000);
});

test("C (fixed, H1): a receipt-write failure never discards a successful Jev answer", async () => {
  const sink = new MemoryReceiptSink();
  (sink as any).write = () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
  const r = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, request: (async () => ok()) as any, health: new MemoryHealthStore(), sink });
  expect(r.ok).toBe(true);
});

test("D: hot-path overhead with the real file sink + file health store (instant fake provider)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jevbench-"));
  // seed a realistically sized receipts file + health file
  const sink = routerReceiptSink(root);
  const health = routerHealthStore(root);
  const fake = (async () => ok()) as unknown as typeof fetch;
  for (let i = 0; i < 50; i++) await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, request: fake, root, sink: routerReceiptSink(root), health: routerHealthStore(root) });
  const N = 200;
  let t = performance.now();
  for (let i = 0; i < N; i++) await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, request: fake, root, sink: routerReceiptSink(root), health: routerHealthStore(root) });
  const routed = (performance.now() - t) / N;
  t = performance.now();
  for (let i = 0; i < N; i++) { const r = await fake("x"); await r.json(); }
  const direct = (performance.now() - t) / N;
  console.log(`D: per-call routed ${routed.toFixed(3)} ms vs direct ${direct.toFixed(3)} ms (overhead ${(routed - direct).toFixed(3)} ms)`);
  void sink; void health;
});

test("E: 429 then 200 on guardian: retried once inside 2500 ms budget", async () => {
  let n = 0;
  const r = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: {}, request: (async () => (++n === 1 ? status(429) : ok())) as any, health: new MemoryHealthStore(), sink: new MemoryReceiptSink() });
  console.log("E:", r.ok, (r as any).attempts, r.ms);
  expect(r.ok).toBe(true);
});

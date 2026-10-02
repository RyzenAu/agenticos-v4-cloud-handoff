import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevDecide } from "../jev-client";
import { MemoryReceiptSink } from "../model-router/receipts";
const dirs: string[] = [];
afterEach(() => { delete process.env.MU_ROUTER_REAL_FILES; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
test("J1 (fixed, BL1): a 503 burst on voice.reflex never takes Jev off hermes.guardian (per-call health)", async () => {
  process.env.MU_ROUTER_REAL_FILES = "1"; // production default: the shared FILE health store (under a temp root)
  const root = mkdtempSync(join(tmpdir(), "e12-jev-")); dirs.push(root);
  let calls = 0;
  const bad = (async () => { calls++; return new Response("busy", { status: 503 }); }) as unknown as typeof fetch;
  const good = (async () => { calls++; return new Response(JSON.stringify({ answers: { decision: { type: "choice", choice: "allow", confidence: 0.9 } } }), { status: 200 }); }) as unknown as typeof fetch;
  const r1 = await jevDecide({ surface: "voice.reflex", key: "k", state: {}, questions: { decision: { type: "choice", criteria: { allow: "Allowed", deny: "Denied" } } }, root, sink: new MemoryReceiptSink(), request: bad, sleep: async () => {} });
  expect(r1.ok).toBe(false);
  const before = calls;
  const r2 = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: { decision: { type: "choice", criteria: { allow: "Allowed", deny: "Denied" } } }, root, sink: new MemoryReceiptSink(), request: good });
  expect(calls - before).toBe(1);          // Jev is asked, as before E2
  expect(r2.ok).toBe(true);
  // and the same surface right after a failure also tries again (no sit-out)
  const r3 = await jevDecide({ surface: "voice.reflex", key: "k", state: {}, questions: { decision: { type: "choice", criteria: { allow: "Allowed", deny: "Denied" } } }, root, sink: new MemoryReceiptSink(), request: good });
  expect(r3.ok).toBe(true);
});
test("J2 (fixed, H1): a receipt-write failure keeps a good 200 answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "e12-jev-")); dirs.push(root);
  const good = (async () => new Response(JSON.stringify({ answers: { decision: { type: "choice", choice: "allow", confidence: 0.9 } } }), { status: 200 })) as unknown as typeof fetch;
  const sink = { write() { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); }, forRequest: () => [], claim: () => true, release() {} };
  const r = await jevDecide({ surface: "hermes.guardian", key: "k", state: {}, questions: { decision: { type: "choice", criteria: { allow: "Allowed", deny: "Denied" } } }, root, sink, request: good });
  expect(r.ok).toBe(true);
});

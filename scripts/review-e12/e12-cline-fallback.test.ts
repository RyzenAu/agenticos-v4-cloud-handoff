// Reviewer check: /__cline falls back only on a pre-send "not verified free" refusal; a sent prompt is never replayed.
import { test, expect } from "bun:test";
import { clineBridge } from "../cline-bridge";
import { FleetError } from "../model-fleet/policy";
import { MemoryReceiptSink } from "../model-router/receipts";
const msgs = [{ role: "user", content: "hi" }];
const okRaw = (id: string) => JSON.stringify({ type: "run_result", finishReason: "completed", text: "hello", model: { id, provider: "cline" }, usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 } });
test("not-free refusal -> next Cline model; every model refused -> bounded", async () => {
  const runs: string[] = []; const checked: string[] = [];
  const sink = new MemoryReceiptSink();
  const b = clineBridge({ bin: "x", sink, now: () => Date.now(),
    availability: async (id) => { checked.push(id); return { listedFree: id !== "cline-free/mimo-v2.6-flash", checkedAt: Date.now() } as any; },
    run: async (args) => { const m = args[args.indexOf("-m") + 1]; runs.push(m); return okRaw(m); } });
  const out: any = await b.routed({ model: "mimo-v2.6-flash", messages: msgs }, undefined, new AbortController().signal);
  console.log(checked, runs, out.model, out.router_receipt, sink.receipts.map((r) => [r.model, r.outcome, r.sent, r.costUsd, r.costBasis]));
  expect(runs.length).toBe(1);
  const b2runs: string[] = []; const b2checked: string[] = [];
  const b2 = clineBridge({ bin: "x", sink: new MemoryReceiptSink(), availability: async (id) => { b2checked.push(id); return { listedFree: false, checkedAt: Date.now() } as any; }, run: async () => { b2runs.push("x"); return ""; } });
  let e: any = null; try { await b2.routed({ model: "mimo-v2.6-flash", messages: msgs }, undefined, new AbortController().signal); } catch (x) { e = x; }
  console.log("all refused:", b2checked.length, b2runs.length, e?.status, e?.message);
  expect(b2runs.length).toBe(0); expect(b2checked.length).toBe(5);
});
test("timeout after send -> no second model", async () => {
  const runs: string[] = [];
  const b = clineBridge({ bin: "x", sink: new MemoryReceiptSink(), availability: async () => ({ listedFree: true, checkedAt: Date.now() }) as any,
    run: async (args) => { runs.push(args[args.indexOf("-m") + 1]); throw new FleetError("Cline failed", 502); } });
  let e: any = null; try { await b.routed({ model: "deepseek-v4.1-flash", messages: msgs }, undefined, new AbortController().signal); } catch (x) { e = x; }
  console.log(runs, e?.status);
  expect(runs.length).toBe(1);
});

// REVIEW-E12 repro, now asserting the FIXED behaviour: at >= 95% of a Claude window (cached /usage reading), /__claude no longer runs `claude -p`
// at all (pre-E2 it always ran). Same skip applies to vision.point, meeting.notes, cad.code and callscript.
import { afterEach, expect, test } from "bun:test";
import { claudeBridge } from "../claude-bridge";
import { MemoryReceiptSink } from "../model-router/receipts";
import { clearPublishedUsage, publishUsageSnapshot } from "../model-router/allowance";
import { route } from "../model-router/router";
afterEach(() => clearPublishedUsage());
const at = (pct: number) => publishUsageSnapshot({ generatedAt: new Date().toISOString(), subscriptions: [
  { provider: "anthropic", plan: "Max", id: "claude", status: { ok: true, windows: [{ label: "session", usedPercent: pct, resetsAt: null }] } } as any] });

test("BL3 (fixed): /__claude at 96% of the session window still runs claude -p (usage recorded, never blocks)", async () => {
  at(96);
  let spawns = 0;
  const b = claudeBridge({ bin: "x", sink: new MemoryReceiptSink(), run: async () => { spawns++; return JSON.stringify({ result: "ok", usage: {} }); } });
  let err: any = null;
  try { await b.routed({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }); } catch (e) { err = e; }
  console.log("spawns", spawns, err?.status, err?.message);
  expect(spawns).toBe(1);
  expect(err).toBeNull();
});

test("BL3 (fixed): meeting.notes / cad.code / vision.point / callscript still start on Claude at 96%", () => {
  at(96);
  for (const t of ["meeting.notes", "cad.code", "vision.point", "callscript"]) {
    const c = route(t, { hasKey: () => true });
    console.log(t, "->", c.model, "|", c.skipped.map((s) => `${s.model}: ${s.why}`).join("; "));
    expect(c.model).toBe("claude/sonnet-5");
    expect(c.allowance?.usedPct).toBe(96); // shown, not blocking
  }
});

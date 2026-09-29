// Reviewer check: /__claude model map parity and at most one `claude -p` per HTTP request, even on failure.
import { test, expect } from "bun:test";
import { CLAUDE_BRIDGE_MODELS, claudeBridge } from "../claude-bridge";
import { MemoryReceiptSink } from "../model-router/receipts";
import { MemoryHealthStore } from "../model-router/health";
test("map parity", () => {
  expect(CLAUDE_BRIDGE_MODELS).toEqual({ "claude-opus-5-5": "claude-opus-5-5", "claude-sonnet-5": "claude-sonnet-5", "claude-fable-5-1": "fable", "claude-haiku-4-5": "haiku" });
});
for (const model of ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5"]) {
  for (const failure of ["You've hit your usage limit", "Claude Code failed weirdly", "took longer than 240s"]) {
    test(`one spawn: ${model} / ${failure}`, async () => {
      const calls: string[][] = [];
      const bridge = claudeBridge({ bin: "x", sink: new MemoryReceiptSink(), health: new MemoryHealthStore(),
        run: async (args) => { calls.push(args); throw new Error(failure); } });
      let err: any = null;
      try { await bridge.routed({ model, messages: [{ role: "user", content: "hi" }] }); } catch (e) { err = e; }
      expect(calls.length).toBe(1);
      expect(calls[0]).not.toContain("--bare");
      expect(err).not.toBeNull();
    });
  }
}

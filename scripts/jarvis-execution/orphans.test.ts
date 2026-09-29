// Audit A-M4 (docs/AUDIT-20260927.md): a normal child exit is verified only when independent
// process accounting shows nothing it spawned is still running. Synthetic tables and fake
// children only; nothing real is spawned here.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlExecutionRuntime } from "./runtime";
import { ControlDispatchGate } from "./server-approval";
import type { ProcessRow } from "./process-accounting";
import { jarvisTaskPrompt } from "../../src/lib/jarvis-control";

const CHILD = 606060;
const self: ProcessRow = { pid: process.pid, ppid: 1, created: 1 };

async function exitNormally(table: (phase: "running" | "exited") => ProcessRow[] | Promise<ProcessRow[]>) {
  let phase: "running" | "exited" = "running";
  const dir = mkdtempSync(join(tmpdir(), "jarvis-orphans-synthetic-"));
  const runtime = new ControlExecutionRuntime(dir, new ControlDispatchGate(), { accounting: async () => table(phase) });
  const binding = { requestId: randomUUID(), task: "Show synthetic task list" };
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  const child = Object.assign(new EventEmitter(), { pid: CHILD });
  admission.ticket.attach(child, async () => true);
  await Bun.sleep(20); // the runtime reads the child's creation time while it runs
  phase = "exited";
  child.emit("close", 0);
  const receipt = await admission.ticket.completion.catch(() => runtime.read(binding.requestId)!);
  const state = runtime.quarantineState();
  return { receipt, state, done: async () => { await runtime.recoverQuarantine().catch(() => {}); try { runtime.close(); } catch { /* still quarantined */ } rmSync(dir, { recursive: true, force: true }); } };
}

test("exit 0 with nothing left behind settles normally and admission stays open", async () => {
  const r = await exitNormally((p) => p === "running" ? [self, { pid: CHILD, ppid: process.pid, created: 5_000 }] : [self]);
  try {
    // No verifier evidence, so the journal keeps it "unverified" (never "succeeded"); what matters
    // here is that the exit settled normally and admission stays open.
    expect(r.receipt.status).toBe("unverified");
    expect(r.state.quarantined).toBe(false);
  } finally { await r.done(); }
});

test("exit 0 while a detached descendant keeps running is unverified and quarantines", async () => {
  const helper: ProcessRow = { pid: 707070, ppid: CHILD, created: 6_000 }; // e.g. a browser the child spawned
  const r = await exitNormally((p) => p === "running" ? [self, { pid: CHILD, ppid: process.pid, created: 5_000 }, helper] : [self, helper]);
  try {
    expect(r.receipt.status).toBe("unverified");
    expect(r.state).toMatchObject({ quarantined: true, reason: "descendant_outlived_child" });
  } finally { await r.done(); }
});

test("a PID-reused stranger parented on the dead child's PID is not mistaken for a descendant", async () => {
  // Created long before the child existed, so it cannot be the child's descendant.
  const stranger: ProcessRow = { pid: 808080, ppid: CHILD, created: 1_000 };
  const r = await exitNormally((p) => p === "running" ? [self, { pid: CHILD, ppid: process.pid, created: 5_000 }] : [self, stranger]);
  try {
    // No verifier evidence, so the journal keeps it "unverified" (never "succeeded"); what matters
    // here is that the exit settled normally and admission stays open.
    expect(r.receipt.status).toBe("unverified");
    expect(r.state.quarantined).toBe(false);
  } finally { await r.done(); }
});

test("an unreadable process table at exit cannot prove the tree is gone: quarantine", async () => {
  const r = await exitNormally((p) => { if (p === "exited") throw new Error("synthetic accounting outage"); return [self, { pid: CHILD, ppid: process.pid, created: 5_000 }]; });
  try {
    expect(r.receipt.status).toBe("unverified");
    expect(r.state).toMatchObject({ quarantined: true, reason: "descendant_outlived_child" });
  } finally { await r.done(); }
});

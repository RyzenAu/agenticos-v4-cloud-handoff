import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ControlExecutionRuntime, stopExecutionForWatchdog, type RuntimeOptions } from "./runtime";
import { ControlDispatchGate } from "./server-approval";
import { stopOwnedChild } from "./child";
import { digestOf } from "./journal";
import { jarvisTaskPrompt } from "../../src/lib/jarvis-control";

// The two "real child" tests spawn a real process and read the real OS process table through
// PowerShell (2-3 s per snapshot on this machine, and more under load; several snapshots per
// test). Measured up to 16.9 s in a full suite under load, so each gets 60 s (the 5 s default
// timed out).
const REAL_CHILD_TIMEOUT_MS = 60_000;
const setup = (options: RuntimeOptions = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-runtime-synthetic-"));
  const runtime = new ControlExecutionRuntime(dir, new ControlDispatchGate(), options);
  const binding = { requestId: randomUUID(), task: "Show synthetic task list" };
  return { dir, runtime, binding };
};
test("real child filesystem effect, concurrent stable ID dedup and reopen without replay", async () => {
  const { dir, runtime, binding } = setup();
  const output = join(dir, "effect.txt");
  const first = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  expect(first.admitted).toBe(true);
  if (!first.admitted) throw new Error("admission");
  const child = spawn(process.execPath, ["--no-env-file", "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'SYNTHETIC-EFFECT')`],
    { cwd: dir, env: {}, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
  first.ticket.attach(child, () => stopOwnedChild(child));
  const duplicate = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  expect(duplicate.admitted).toBe(false);
  if (!duplicate.admitted) expect(duplicate.receipt.status).toBe("running");
  expect((await first.ticket.completion).status).toBe("unverified");
  expect(readFileSync(output, "utf8")).toBe("SYNTHETIC-EFFECT");
  // The completion can resolve before the quarantine's process-table snapshot is written; close()
  // then (correctly) refuses. Flaked once in a full-suite run under load (28 Sep, Track 8).
  await runtime.idle();
  runtime.close();
  const reopened = new ControlExecutionRuntime(dir, new ControlDispatchGate());
  try {
    expect(reopened.begin(binding, jarvisTaskPrompt(binding.task)).admitted).toBe(false);
    expect(readFileSync(output, "utf8")).toBe("SYNTHETIC-EFFECT");
    const db = new Database(join(dir, "jobs.sqlite"));
    try {
      const rows = JSON.stringify(db.query("SELECT * FROM jobs").all());
      expect(rows).not.toContain(binding.task);
      expect(rows).not.toContain("SYNTHETIC-EFFECT");
      expect(rows).toContain(digestOf(binding.task));
    } finally { db.close(); }
  } finally { reopened.close(); }
}, REAL_CHILD_TIMEOUT_MS);
test("binding validated before persistence, server authority and exclusive live lease", () => {
  const { runtime, dir, binding } = setup();
  try {
    expect(() => runtime.begin(binding, "different prompt")).toThrow();
    expect(runtime.list()).toHaveLength(0);
    for (const extra of [{ owner: randomUUID() }, { permitted: true }])
      expect(() => runtime.begin({ ...binding, ...extra }, jarvisTaskPrompt(binding.task))).toThrow();
    expect(() => new ControlExecutionRuntime(dir)).toThrow("already active");
    const denied = { requestId: randomUUID(), task: "Transfer bank funds" };
    const result = runtime.begin(denied, jarvisTaskPrompt(denied.task));
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.receipt.status).toBe("blocked");
  } finally { runtime.close(); }
});
test("real synthetic child cancel stays running until close and tree acknowledgement", async () => {
  // The production 5 s stop grace covers taskkill plus the independent process-table read that
  // verifies the tree is gone. Under load that read alone took over 5 s, so the job settled as
  // "unverified" (fail closed) before the acknowledgement arrived (the whole test took up to
  // 14.2 s under load). This test is about ordering, not the grace length, so it gets a 45 s
  // grace; a stop that is never acknowledged still fails it.
  const { runtime, dir, binding } = setup({ stopGraceMs: 45_000 });
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  const ready = join(dir, "ready");
  const child = spawn(process.execPath, ["--no-env-file", "-e", `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`],
    { cwd: dir, env: {}, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
  admission.ticket.attach(child, () => stopOwnedChild(child));
  for (let n = 0; n < 100; n++) {
    try { if (readFileSync(ready, "utf8") === "ready") break; } catch {}
    await Bun.sleep(10);
  }
  let legacyStops = 0;
  stopExecutionForWatchdog(() => runtime, admission.ticket, () => legacyStops++);
  expect(legacyStops).toBe(0);
  expect(runtime.read(binding.requestId)?.status).toBe("running");
  expect((await admission.ticket.completion).status).toBe("cancelled");
  expect(() => process.kill(child.pid!, 0)).toThrow();
  runtime.close();
}, REAL_CHILD_TIMEOUT_MS);
test("actual Vite watchdog registration selects acknowledged control stop", () => {
  const config = readFileSync(join(import.meta.dir, "../../vite.config.ts"), "utf8");
  const watchdog = config.slice(config.indexOf("const setIdle = (ms: number) =>"), config.indexOf("setIdle(FIRST_OUTPUT_TIMEOUT_MS)"));
  expect(watchdog).toContain("stopExecutionForWatchdog(() => controlExecution(__dirname), controlTicket, () => { killTree(child); })");
  expect(config).toContain("controlTicket.attach(child, () => stopOwnedChild(child))");
  let lazyReads = 0, legacyStops = 0;
  stopExecutionForWatchdog(() => { lazyReads++; throw new Error("must stay lazy"); }, undefined, () => legacyStops++);
  expect(lazyReads).toBe(0); expect(legacyStops).toBe(1);
});
test("lost worker running row recovers unverified and never reruns", () => {
  const { runtime, dir, binding } = setup();
  runtime.close();
  const db = new Database(join(dir, "jobs.sqlite"));
  db.query("INSERT INTO jobs VALUES (?, ?, ?, 'read-only', 1, 'running', NULL, NULL)")
    .run(binding.requestId, "00000000-0000-4000-8000-000000000001", digestOf(binding.task));
  db.close();
  const recovered = new ControlExecutionRuntime(dir, new ControlDispatchGate());
  try {
    expect(recovered.read(binding.requestId)?.status).toBe("unverified");
    expect(recovered.begin(binding, jarvisTaskPrompt(binding.task)).admitted).toBe(false);
    expect(() => recovered.begin({ ...binding, task: "Show a different task" }, jarvisTaskPrompt("Show a different task"))).toThrow("binding conflict");
  } finally { recovered.close(); }
});
test("parent close cannot settle cancellation while tree stop is pending; failed stop is unverified", async () => {
  const { runtime, binding } = setup();
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  const child = new EventEmitter();
  let acknowledge!: (ok: boolean) => void;
  admission.ticket.attach(child, () => new Promise<boolean>((resolve) => { acknowledge = resolve; }));
  runtime.cancel(binding.requestId);
  await Promise.resolve(); await Promise.resolve();
  child.emit("close", 0);
  await Promise.resolve();
  expect(runtime.read(binding.requestId)?.status).toBe("running");
  expect(() => runtime.close()).toThrow("still active");
  acknowledge(false);
  expect((await admission.ticket.completion).status).toBe("unverified");
  runtime.close();
});

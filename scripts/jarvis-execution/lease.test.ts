// Audit A-L5 (docs/AUDIT-20260927.md): the execution lease records the holder's start time, so a
// reused PID cannot block the runtime, and a quiet copy never constructs the runtime at all.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlExecutionRuntime, controlExecution } from "./runtime";

function holdLease(dir: string, pid: number, started: number | null, legacy = false) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "worker.sqlite"), { create: true });
  db.exec(legacy
    ? "CREATE TABLE lease (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, instance TEXT NOT NULL)"
    : "CREATE TABLE lease (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, instance TEXT NOT NULL, started INTEGER)");
  if (legacy) db.query("INSERT INTO lease VALUES (1, ?, 'synthetic-holder')").run(pid);
  else db.query("INSERT INTO lease VALUES (1, ?, 'synthetic-holder', ?)").run(pid, started);
  db.close();
}

async function withLiveStranger(run: (pid: number) => void | Promise<void>) {
  // A real, live process that is not us: its PID stands in for a lease holder.
  const child = spawn(process.execPath, ["--no-env-file", "-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true, env: {} });
  try { await new Promise((r) => setTimeout(r, 200)); await run(child.pid!); }
  finally { child.kill(); await new Promise((r) => child.once("close", r)); }
}

test("a live PID with a different start time is a reused PID: the lease is taken over", async () => {
  await withLiveStranger((pid) => {
    const dir = mkdtempSync(join(tmpdir(), "lease-reused-"));
    try {
      holdLease(dir, pid, 1_000);
      const runtime = new ControlExecutionRuntime(dir, undefined, { pidStartTime: () => 999_999_999 });
      runtime.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("a live holder with the recorded start time, an unknown start time or a legacy row still fails closed", async () => {
  await withLiveStranger((pid) => {
    for (const [started, lookup, legacy] of [[5_000, 5_500, false], [5_000, null, false], [null, 999_999_999, true]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "lease-held-"));
      try {
        holdLease(dir, pid, started, legacy);
        expect(() => new ControlExecutionRuntime(dir, undefined, { pidStartTime: () => lookup })).toThrow("already active");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

test("a dead holder is replaced; a second runtime in this process is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "lease-dead-"));
  try {
    holdLease(dir, 2_147_483_000, 1_000); // no such PID
    const runtime = new ControlExecutionRuntime(dir, undefined, { pidStartTime: () => { throw new Error("must not be asked"); } });
    try { expect(() => new ControlExecutionRuntime(dir)).toThrow("already active"); }
    finally { runtime.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a quiet copy (AGENTIC_OS_NO_BACKGROUND=1) never constructs the runtime or touches its store", () => {
  const root = mkdtempSync(join(tmpdir(), "lease-quiet-"));
  const before = process.env.AGENTIC_OS_NO_BACKGROUND;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    expect(() => controlExecution(root)).toThrow("quiet copy");
    expect(existsSync(join(root, ".operator-data", "control-execution"))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND; else process.env.AGENTIC_OS_NO_BACKGROUND = before;
    rmSync(root, { recursive: true, force: true });
  }
});

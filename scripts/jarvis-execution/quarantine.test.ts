import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ControlExecutionRuntime } from "./runtime";
import { ControlDispatchGate } from "./server-approval";
import { stopOwnedChild } from "./child";
import { controlReceiptRoute } from "./routes";
import { captureTree, treeStillPresent, type ProcessRow } from "./process-accounting";
import { jarvisTaskPrompt } from "../../src/lib/jarvis-control";

// Synthetic only: fake children, synthetic process tables and a node-only process tree.
const task = (text = "Show synthetic task list") => ({ requestId: randomUUID(), task: text });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("Synthetic deadline"); await Bun.sleep(10); }
}
function runtimeWith(table: () => ProcessRow[] | Promise<ProcessRow[]>) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-quarantine-synthetic-"));
  const accounting = async () => table();
  return { dir, accounting, runtime: new ControlExecutionRuntime(dir, new ControlDispatchGate(), { accounting }) };
}
/** Admit a job, attach a fake child with a PID, and make its stop unacknowledged. */
async function unacknowledged(runtime: ControlExecutionRuntime, pid = 424242) {
  const binding = task();
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  const child = Object.assign(new EventEmitter(), { pid });
  admission.ticket.attach(child, async () => false);
  runtime.cancel(binding.requestId);
  expect((await admission.ticket.completion).status).toBe("unverified");
  return binding;
}

test("unacknowledged termination closes admission with a reason code; nothing new is persisted", async () => {
  let table: ProcessRow[] = [{ pid: process.pid, ppid: 1, created: 1 }, { pid: 424242, ppid: process.pid, created: null }];
  const { runtime } = runtimeWith(() => table);
  try {
    const first = await unacknowledged(runtime);
    const state = runtime.quarantineState();
    expect(state).toMatchObject({ quarantined: true, reason: "child_termination_unverified", jobs: [first.requestId] });
    const fresh = task("Show another synthetic list");
    const refused = runtime.begin(fresh, jarvisTaskPrompt(fresh.task));
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      expect(refused.status).toBe(503);
      expect(refused.reason).toBe("execution_quarantined");
      expect(refused.receipt.status).toBe("quarantined");
      expect(JSON.stringify(refused.receipt)).not.toContain(fresh.task);
    }
    expect(runtime.read(fresh.requestId)).toBeNull();
    expect(runtime.list().map((r) => r.id)).toEqual([first.requestId]);
    // Re-reading the settled job still returns its real receipt, not a new admission.
    const repeat = runtime.begin(first, jarvisTaskPrompt(first.task));
    expect(repeat.admitted).toBe(false);
    if (!repeat.admitted) { expect(repeat.status).toBe(409); expect(repeat.receipt.status).toBe("unverified"); }
    // A later acknowledgement of the same stop cannot reopen admission by itself.
    expect(runtime.quarantineState().quarantined).toBe(true);
    table = [{ pid: process.pid, ppid: 1, created: 1 }];
  } finally { await runtime.recoverQuarantine(); runtime.close(); }
});

test("recovery is explicit and needs independent accounting that the tree is gone", async () => {
  let mode: "present" | "fail" | "gone" = "present";
  const since = Date.now();
  const { runtime } = runtimeWith(() => {
    if (mode === "fail") throw new Error("synthetic accounting outage");
    return mode === "present"
      ? [{ pid: process.pid, ppid: 1, created: 1 }, { pid: 424242, ppid: process.pid, created: since - 60_000 },
        { pid: 424243, ppid: 424242, created: since - 59_000 }]
      : [{ pid: process.pid, ppid: 1, created: 1 }];
  });
  try {
    await unacknowledged(runtime);
    // No automatic recovery: time passing and reads do not clear quarantine.
    await Bun.sleep(20);
    expect(runtime.quarantineState().quarantined).toBe(true);
    expect(await runtime.recoverQuarantine()).toBe("tree_present");
    expect(runtime.quarantineState()).toMatchObject({ quarantined: true, lastRecovery: { outcome: "tree_present" } });
    mode = "fail";
    expect(await runtime.recoverQuarantine()).toBe("accounting_failed");
    expect(runtime.quarantineState().quarantined).toBe(true);
    const blocked = task();
    expect(runtime.begin(blocked, jarvisTaskPrompt(blocked.task)).admitted).toBe(false);
    mode = "gone";
    expect(await runtime.recoverQuarantine()).toBe("cleared");
    expect(runtime.quarantineState()).toMatchObject({ quarantined: false, jobs: [], lastRecovery: { outcome: "cleared" } });
    expect(await runtime.recoverQuarantine()).toBe("not_quarantined");
    const admitted = runtime.begin(blocked, jarvisTaskPrompt(blocked.task));
    expect(admitted.admitted).toBe(true);
    if (admitted.admitted) { admitted.ticket.finish({ ok: false }); await admitted.ticket.completion; }
  } finally { runtime.close(); }
});

test("quarantine survives worker restart; a dead worker's attached child quarantines on startup", async () => {
  let gone = false;
  const table = () => gone ? [{ pid: process.pid, ppid: 1, created: 1 }] : [{ pid: process.pid, ppid: 1, created: 1 }, { pid: 424242, ppid: 7, created: 5 }];
  const { dir, runtime, accounting } = runtimeWith(table);
  await unacknowledged(runtime);
  await Bun.sleep(5);
  runtime.close();
  let reopened = new ControlExecutionRuntime(dir, new ControlDispatchGate(), { accounting });
  try {
    expect(reopened.quarantineState()).toMatchObject({ quarantined: true, reason: "child_termination_unverified" });
    const fresh = task();
    expect(reopened.begin(fresh, jarvisTaskPrompt(fresh.task)).admitted).toBe(false);
    gone = true;
    expect(await reopened.recoverQuarantine()).toBe("cleared");
  } finally { reopened.close(); }
  // Simulate a worker that died while its child was attached (no settle, no stop).
  const db = new Database(join(dir, "worker.sqlite"));
  db.query("INSERT INTO attached VALUES (?, ?)").run(randomUUID(), 515151);
  db.close();
  gone = false;
  reopened = new ControlExecutionRuntime(dir, new ControlDispatchGate(), { accounting: async () => [{ pid: process.pid, ppid: 1, created: 1 }, { pid: 515151, ppid: 9, created: 1 }] });
  try {
    expect(reopened.quarantineState()).toMatchObject({ quarantined: true, reason: "worker_exit_child_unaccounted" });
    expect(await reopened.recoverQuarantine()).toBe("tree_present");
  } finally { reopened.close(); }
});

test("normal close and acknowledged stop leave admission open and no attached row", async () => {
  const { dir, runtime } = runtimeWith(() => [{ pid: process.pid, ppid: 1, created: 1 }]);
  try {
    for (const acknowledged of [null, true]) {
      const binding = task();
      const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
      if (!admission.admitted) throw new Error("admission");
      const child = Object.assign(new EventEmitter(), { pid: 616161 });
      admission.ticket.attach(child, async () => acknowledged === true);
      if (acknowledged) runtime.cancel(binding.requestId);
      await Promise.resolve();
      child.emit("close", 0);
      expect((await admission.ticket.completion).status).toBe(acknowledged ? "cancelled" : "unverified");
      expect(runtime.quarantineState().quarantined).toBe(false);
    }
  } finally { runtime.close(); }
  const db = new Database(join(dir, "worker.sqlite"));
  try { expect(db.query("SELECT COUNT(*) AS n FROM attached").get()).toEqual({ n: 0 }); } finally { db.close(); }
});

test("process accounting rules: reuse, orphans and unknown creation fail closed", () => {
  const since = 100_000;
  const base: ProcessRow[] = [{ pid: 1, ppid: 0, created: 1 }];
  const members = [{ pid: 50, created: 90_000 }, { pid: 51, created: 90_500 }];
  expect(treeStillPresent(base, members, since)).toBe(false);
  // Member still alive with matching creation time.
  expect(treeStillPresent([...base, { pid: 51, ppid: 50, created: 90_500 }], members, since)).toBe(true);
  // PID reused by an unrelated later process, and that process's own child: not ours.
  expect(treeStillPresent([...base, { pid: 50, ppid: 1, created: 200_000 }, { pid: 70, ppid: 50, created: 200_100 }], members, since)).toBe(false);
  // Orphan created by a dead member before its PID was reused: still ours.
  expect(treeStillPresent([...base, { pid: 50, ppid: 1, created: 200_000 }, { pid: 71, ppid: 50, created: 95_000 }], members, since)).toBe(true);
  // Orphan of a dead member, never reported by the kill command.
  expect(treeStillPresent([...base, { pid: 72, ppid: 51, created: 99_000 }], members, since)).toBe(true);
  // Unknown member creation: a live pre-quarantine process with that PID is treated as present.
  expect(treeStillPresent([...base, { pid: 80, ppid: 1, created: 50_000 }], [{ pid: 80, created: null }], since)).toBe(true);
  expect(treeStillPresent([...base, { pid: 80, ppid: 1, created: 300_000 }], [{ pid: 80, created: null }], since)).toBe(false);
  expect(treeStillPresent([...base, { pid: 80, ppid: 1, created: null }], [{ pid: 80, created: null }], since)).toBe(true);
  // Capture walks the live tree transitively and ignores children that predate a parent.
  const table: ProcessRow[] = [...base, { pid: 60, ppid: 1, created: 100_000 }, { pid: 61, ppid: 60, created: 100_010 },
    { pid: 62, ppid: 61, created: 100_020 }, { pid: 63, ppid: 60, created: 5_000 }];
  expect(captureTree(table, { pid: 60, created: null }).map((m) => m.pid).sort()).toEqual([60, 61, 62]);
});

test("authenticated quarantine routes: state, explicit recovery request and refusals", async () => {
  let gone = false;
  const { runtime } = runtimeWith(() => gone ? [{ pid: process.pid, ppid: 1, created: 1 }] : [{ pid: process.pid, ppid: 1, created: 1 }, { pid: 424242, ppid: 1, created: null }]);
  const call = (path: string, method: string, body?: unknown, authenticated = true, remote = false) =>
    controlReceiptRoute({ path, method, url: new URL(`http://localhost${path}`), remote, authenticated, body }, () => runtime)!;
  try {
    expect(call("/control/quarantine", "GET", undefined, false).status).toBe(403);
    expect(call("/control/quarantine", "GET", undefined, true, true).status).toBe(403);
    expect(call("/control/quarantine/recover", "POST", {}, false).status).toBe(403);
    expect(call("/control/quarantine", "GET").body).toMatchObject({ quarantine: { quarantined: false } });
    expect(call("/control/quarantine/recover", "POST", {}).status).toBe(409);
    await unacknowledged(runtime);
    expect(call("/control/quarantine", "GET").body).toMatchObject({ quarantine: { quarantined: true, reason: "child_termination_unverified" } });
    expect(call("/control/quarantine/recover", "POST", { force: true }).status).toBe(400);
    expect(call("/control/quarantine/recover", "GET").status).toBe(405);
    const requested = call("/control/quarantine/recover", "POST", {});
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ code: "recovery_requested", quarantine: { recovering: true } });
    await until(() => !runtime.quarantineState().recovering);
    expect(runtime.quarantineState()).toMatchObject({ quarantined: true, lastRecovery: { outcome: "tree_present" } });
    gone = true;
    expect(call("/control/quarantine/recover", "POST", {}).status).toBe(202);
    await until(() => !runtime.quarantineState().recovering);
    expect(call("/control/quarantine", "GET").body).toMatchObject({ quarantine: { quarantined: false, lastRecovery: { outcome: "cleared" } } });
  } finally { runtime.close(); }
});

// Real three-level process tree plus several real OS process-table reads through PowerShell
// (2-3 s each when idle). Alone it takes 8-9 s; during a full suite on a loaded machine it hit
// the old 30 s cap. 90 s gives the loaded run about 3x headroom.
test("real process tree with an unacknowledged stop: refused until the OS table shows it gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-quarantine-tree-"));
  const runtime = new ControlExecutionRuntime(dir, new ControlDispatchGate());
  const script = join(dir, "tree.cjs");
  // Each level publishes only its own PID, atomically (write temp, then rename).
  writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const [dir,level]=process.argv.slice(2);
if(level!=='2') spawn(process.execPath,[__filename,dir,String(Number(level)+1)],{stdio:'ignore',windowsHide:true,env:{}});
fs.writeFileSync(dir+'/pid-'+level+'.tmp',String(process.pid));fs.renameSync(dir+'/pid-'+level+'.tmp',dir+'/pid-'+level);
setInterval(()=>{},1000);`);
  const binding = task();
  const admission = runtime.begin(binding, jarvisTaskPrompt(binding.task));
  if (!admission.admitted) throw new Error("admission");
  const child = spawn(process.execPath, ["--no-env-file", script, dir, "0"],
    { cwd: dir, env: {}, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
  let pids: number[] = [];
  try {
    admission.ticket.attach(child, async () => false); // e.g. taskkill failed to acknowledge
    await until(() => [0, 1, 2].every((n) => existsSync(join(dir, `pid-${n}`))));
    pids = [0, 1, 2].map((n) => Number(readFileSync(join(dir, `pid-${n}`), "utf8")));
    runtime.cancel(binding.requestId);
    expect((await admission.ticket.completion).status).toBe("unverified");
    const fresh = task();
    const refused = runtime.begin(fresh, jarvisTaskPrompt(fresh.task));
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) expect(refused.reason).toBe("execution_quarantined");
    expect(pids.every(alive)).toBe(true);
    expect(await runtime.recoverQuarantine()).toBe("tree_present");
    expect(runtime.begin(fresh, jarvisTaskPrompt(fresh.task)).admitted).toBe(false);
    expect(await stopOwnedChild(child)).toBe(true);
    await until(() => pids.every((pid) => !alive(pid)));
    expect(await runtime.recoverQuarantine()).toBe("cleared");
    const admitted = runtime.begin(fresh, jarvisTaskPrompt(fresh.task));
    expect(admitted.admitted).toBe(true);
    if (admitted.admitted) { admitted.ticket.finish({ ok: false }); await admitted.ticket.completion; }
  } finally {
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    try { child.kill(); } catch {}
    runtime.close();
  }
}, 90_000);

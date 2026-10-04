import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ExecutionJournal, digestOf } from "./journal";
import { ChildTerminationUnverified, runChild } from "./child";

const fixtures: Array<{ journal: ExecutionJournal; dir: string }> = [];
afterEach(() => {
  for (const { journal, dir } of fixtures.splice(0)) {
    journal.close();
    // Only the unique synthetic fixture created below, never a repository or junction.
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup(task = "Show the synthetic task list", permitted = true, now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-execution-synthetic-"));
  const path = join(dir, "jobs.sqlite");
  const journal = new ExecutionJournal(path, now);
  fixtures.push({ journal, dir });
  const binding = { id: randomUUID(), owner: randomUUID(), task };
  journal.prepare({ ...binding, permitted });
  return { journal, binding, dir, path };
}
test("real synthetic filesystem effect is independently hashed, stored once and survives reopen", async () => {
  const { journal, binding, dir, path } = setup();
  let executions = 0;
  const artifact = join(dir, "synthetic.txt"), content = "SYNTHETIC-JARVIS-ONLY";
  const execute = async () => { executions++; writeFileSync(artifact, content); return { ok: true, usageMicrousd: 0 }; };
  const result = await journal.run({ ...binding, execute, verify: async () => {
    const actual = digestOf(readFileSync(artifact, "utf8"));
    return { passed: actual === digestOf(content), evidenceDigest: actual };
  } });
  expect(result.receipt.status).toBe("succeeded");
  const reader = new ExecutionJournal(path);
  try {
    const replay = await reader.run({ ...binding, execute });
    expect(replay.admitted).toBe(false);
    expect(replay.receipt).toEqual(result.receipt);
    expect(executions).toBe(1);
    expect(replay.receipt.usageMicrousd).toBe(0);
  } finally { reader.close(); }
});
test("narration without verification and verifier errors stay unverified", async () => {
  for (const verify of [undefined, async () => { throw new Error("synthetic private failure detail"); }]) {
    const { journal, binding } = setup();
    expect((await journal.run({ ...binding, execute: async () => ({ ok: true }), verify })).receipt.status).toBe("unverified");
    expect(journal.read(binding.id, binding.owner)!.usageMicrousd).toBeNull();
  }
});
test("denied policy cannot be overridden with approval", async () => {
  const { journal, binding } = setup("Send synthetic message", false);
  expect(() => journal.approve(binding.id, binding.owner)).toThrow("cannot be approved");
  let runs = 0;
  expect((await journal.run({ ...binding, execute: async () => { runs++; return { ok: true }; } })).blocked).toBe(true);
  expect(runs).toBe(0);
});
test("external action requires owner/job-bound one-use approval, even across connections", async () => {
  const { journal, binding, path } = setup("Send synthetic message");
  const execute = async () => ({ ok: true });
  expect((await journal.run({ ...binding, execute })).blocked).toBe(true);
  const approval = journal.approve(binding.id, binding.owner);
  const other = { ...binding, id: randomUUID() };
  journal.prepare({ ...other, permitted: true });
  expect((await journal.run({ ...other, approval, execute })).blocked).toBe(true);
  expect((await journal.run({ ...binding, approval, execute })).admitted).toBe(true);
  const reader = new ExecutionJournal(path);
  try { expect((await reader.run({ ...binding, approval, execute })).admitted).toBe(false); }
  finally { reader.close(); }
  expect(() => journal.read(binding.id, "raw request text")).toThrow("UUID");
  expect(journal.read(binding.id, randomUUID())).toBeNull();
});
test("expired and future-issued approvals fail closed", async () => {
  for (const clock of [5000, 999]) {
    let now = 1000;
    const { journal, binding } = setup("Send synthetic message", true, () => now);
    const approval = journal.approve(binding.id, binding.owner, 1000);
    now = clock;
    expect((await journal.run({ ...binding, approval, execute: async () => ({ ok: true }) })).blocked).toBe(true);
  }
});
test("duplicate in-flight submission does not run again or lose cancellation handle; usage settles once", async () => {
  const { journal, binding } = setup();
  let finish!: (value: { ok: boolean; usageMicrousd: number }) => void;
  let signal!: AbortSignal;
  const first = journal.run({ ...binding, execute: async (s) => { signal = s; return new Promise((r) => { finish = r; }); } });
  const again = await journal.run({ ...binding, execute: async () => { throw new Error("must not run"); } });
  expect(again).toMatchObject({ admitted: false, receipt: { status: "running" } });
  expect(journal.cancel(binding.id, binding.owner)).toBe(true);
  expect(signal.aborted).toBe(true);
  finish({ ok: true, usageMicrousd: 37 });
  expect((await first).receipt).toMatchObject({ status: "cancelled", usageMicrousd: 37, evidence: null });
});
test("worker recovery marks interrupted work unknown and revokes pending approvals without executing", async () => {
  const { journal, binding, path } = setup("Send synthetic message");
  const approval = journal.approve(binding.id, binding.owner);
  const second = { ...binding, id: randomUUID() };
  journal.prepare({ ...second, permitted: true });
  // Emulate the durable state left by a crashed worker, using synthetic DB only.
  const db = new Database(path);
  db.query("UPDATE jobs SET status='running' WHERE id=?").run(second.id); db.close();
  journal.recoverAfterWorkerExit();
  expect(journal.read(second.id, second.owner)!.status).toBe("unverified");
  expect((await journal.run({ ...binding, approval, execute: async () => ({ ok: true }) })).blocked).toBe(true);
});
test("journal never stores raw task, returned error, or approval capability", async () => {
  const { journal, binding, path } = setup("Send synthetic private marker SYNTHETIC-NO-STORE");
  const approval = journal.approve(binding.id, binding.owner);
  await journal.run({ ...binding, approval, execute: async () => { throw new Error("SYNTHETIC-ERROR-NO-STORE"); } });
  const bytes = readFileSync(path).toString("latin1");
  expect(bytes).not.toContain("SYNTHETIC-NO-STORE");
  expect(bytes).not.toContain("SYNTHETIC-ERROR-NO-STORE");
  expect(bytes).not.toContain(approval);
});
test("changed task under a stable job ID is rejected", async () => {
  const { journal, binding } = setup();
  expect(() => journal.prepare({ ...binding, task: "Send synthetic message", permitted: true })).toThrow("binding conflict");
  await expect(journal.run({ ...binding, task: "Different synthetic command", execute: async () => ({ ok: true }) })).rejects.toThrow("binding conflict");
});
test("actual synthetic child exits on cancellation and cannot report success", async () => {
  const { journal, binding, dir } = setup();
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  const result = journal.run({ ...binding, execute: (signal) => runChild({
    executable: process.execPath, args: ["--no-env-file", "-e", "setInterval(() => {}, 1000)"],
    cwd: dir, signal, timeoutMs: 10_000, onStarted: () => started(),
  }) });
  await ready;
  expect(journal.cancel(binding.id, binding.owner)).toBe(true);
  expect((await result).receipt.status).toBe("cancelled");
}, 10_000);

test("actual synthetic child tree is terminated, including its grandchild", async () => {
  const { dir } = setup();
  const marker = join(dir, "synthetic-grandchild.pid");
  const controller = new AbortController();
  const program = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['--no-env-file','-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore',windowsHide:true});
    require('node:fs').writeFileSync(process.argv[1],String(child.pid));
    setInterval(()=>{},1000);`;
  const running = runChild({ executable: process.execPath, args: ["--no-env-file", "-e", program, marker], cwd: dir, signal: controller.signal, timeoutMs: 10_000 });
  let grandchild: number | undefined;
  try {
    for (let i = 0; i < 150 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(marker)).toBe(true);
    grandchild = Number(readFileSync(marker, "utf8"));
    expect(Number.isSafeInteger(grandchild) && grandchild > 0).toBe(true);
    controller.abort();
    expect(await running).toMatchObject({ ok: false, cancelled: true });
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try { process.kill(grandchild, 0); } catch { alive = false; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(alive).toBe(false);
  } finally {
    controller.abort();
    await running.catch(() => {});
    // Fixture-owned PID only; no process enumeration or app/service termination.
    if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch {} }
  }
}, 15_000);

test("pre-aborted journal request does not consume approval or invoke executor", async () => {
  const { journal, binding } = setup("Send synthetic message");
  const approval = journal.approve(binding.id, binding.owner);
  const stopped = AbortSignal.abort();
  let executions = 0;
  const execute = async () => { executions++; return { ok: true }; };
  expect((await journal.run({ ...binding, approval, signal: stopped, execute })).blocked).toBe(true);
  expect(executions).toBe(0);
  expect((await journal.run({ ...binding, approval, execute })).admitted).toBe(true);
});

test("mismatched owner cannot rebind an existing job", () => {
  const { journal, binding } = setup();
  expect(() => journal.prepare({ ...binding, owner: randomUUID(), permitted: true })).toThrow("binding conflict");
});

test("failed tree termination remains unverified even after cancellation was requested", async () => {
  const { journal, binding } = setup();
  const result = await journal.run({ ...binding, execute: async () => {
    journal.cancel(binding.id, binding.owner);
    throw new ChildTerminationUnverified();
  } });
  expect(result.receipt.status).toBe("unverified");
});

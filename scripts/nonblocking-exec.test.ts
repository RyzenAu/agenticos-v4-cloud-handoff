// Timing tests for the request-path helpers (API audit F5 P2-4): the event loop keeps running while
// a child runs, and the replacements for per-request git/where spawns cost microseconds.
import { afterAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliBinResolver, createTimedCache, gitHeadShortSha, runCapture, runText, runTree, singleFlight } from "./nonblocking-exec";

const REPO = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "t8-nonblocking-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A child that takes ~2 s on every platform, without a shell builtin that differs per OS.
const SLOW = `"${process.execPath}" -e "await Bun.sleep(2000)"`;

// Counts how often a 10 ms timer fires while `work` runs. A blocked event loop fires it 0 times
// (execSync); a free one ~200 times in 2 s. Counting ticks, not the worst gap, keeps this stable
// on a loaded machine (a 1.2 s scheduling hiccup was seen at 100% CPU on 28 Sep).
async function ticksDuring(work: () => Promise<unknown>) {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  await Bun.sleep(20);
  const before = ticks;
  await work();
  const during = ticks - before;
  clearInterval(timer);
  return during;
}

test("runText never blocks the event loop while its child runs (execSync does)", async () => {
  const freeTicks = await ticksDuring(() => runText(SLOW, { timeout: 30_000 }));
  const blockedTicks = await ticksDuring(async () => {
    execSync(SLOW, { stdio: "ignore", timeout: 30_000 });
  });
  expect(blockedTicks).toBe(0); // the old way: nothing else ran for the whole child
  expect(freeTicks).toBeGreaterThanOrEqual(20); // the new way: timers kept firing
}, 60_000); // two ~2 s children; spawning one passed 5 s at 100% CPU (28 Sep)

// Spawns a bun child: ~0.3 s idle, but it passed 5 s with the machine at 100% CPU (28 Sep), so 30 s.
test("runText rejects on a failing command, like execSync throws", async () => {
  await expect(runText(`"${process.execPath}" -e "process.exit(3)"`)).rejects.toBeDefined();
}, 30_000);

test("gitHeadShortSha reads the same SHA git reports, with no process, in microseconds", () => {
  const git = execSync("git rev-parse --short=7 HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  expect(gitHeadShortSha(REPO)).toBe(git);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) gitHeadShortSha(REPO);
  expect((performance.now() - t0) / 200).toBeLessThan(5); // ms per call; `git rev-parse` was 1.2-1.7 s live
}, 30_000); // the reference `git rev-parse` spawn itself passed 5 s under load (28 Sep)

test("gitHeadShortSha handles a detached HEAD, packed refs and a folder that isn't a checkout", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const detached = join(dir, "detached");
  mkdirSync(join(detached, ".git"), { recursive: true });
  writeFileSync(join(detached, ".git", "HEAD"), `${sha}\n`);
  expect(gitHeadShortSha(detached)).toBe("0123456");
  const packed = join(dir, "packed");
  mkdirSync(join(packed, ".git"), { recursive: true });
  writeFileSync(join(packed, ".git", "HEAD"), "ref: refs/heads/jarvis-voice\n");
  writeFileSync(join(packed, ".git", "packed-refs"), `# pack-refs with: peeled\n${sha} refs/heads/jarvis-voice\n`);
  expect(gitHeadShortSha(packed)).toBe("0123456");
  expect(gitHeadShortSha(join(dir, "nothing-here"))).toBe("");
});

test("the CLI resolver never spawns on resolve(): it answers from the cache and refreshes in the background (T8b S-6)", async () => {
  let clock = 0;
  const present = new Set(["C:/bin/claude.exe"]);
  const onPath = new Map<string, string>([["claude", "C:/bin/claude.exe"], ["codex", "C:/bin/codex.exe"]]);
  let lookups = 0;
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const r = createCliBinResolver({
    candidates: () => [],
    isWindows: true,
    lookupAsync: async (name) => (lookups++, await gate, onPath.get(name)),
    missTtlMs: 1000,
    now: () => clock,
    exists: (p) => present.has(p),
  });
  await r.warm(["claude", "gemini"]);
  expect(lookups).toBe(2);
  for (let i = 0; i < 50; i++) expect(r.resolve("claude")).toBe("C:/bin/claude.exe");
  for (let i = 0; i < 50; i++) expect(r.resolve("gemini")).toBeUndefined();
  expect(lookups).toBe(2); // cached hit and cached miss: no lookups at all
  clock = 1500; // the miss expired: resolve() answers the old miss and looks again in the background
  gate = new Promise<void>((res) => (release = res));
  onPath.set("gemini", "C:/bin/gemini.exe");
  present.add("C:/bin/gemini.exe");
  expect(r.resolve("gemini")).toBeUndefined();
  expect(r.resolve("gemini")).toBeUndefined(); // one lookup in flight, not two
  expect(lookups).toBe(3);
  release();
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(r.resolve("gemini")).toBe("C:/bin/gemini.exe"); // a new install is found without any sync spawn
  present.delete("C:/bin/claude.exe");
  gate = Promise.resolve();
  expect(r.resolve("claude")).toBeUndefined(); // uninstalled: never served from the cache
  // resolveAsync waits for the lookup instead of answering "not yet".
  present.add("C:/bin/codex.exe");
  expect(await r.resolveAsync("codex")).toBe("C:/bin/codex.exe");
  expect(r.lookups).toBe(lookups);
});

test("known install locations win without any lookup", async () => {
  let calls = 0;
  const r = createCliBinResolver({ candidates: () => ["C:/known/hermes.exe"], isWindows: true, lookupAsync: async () => (calls++, undefined), exists: (p) => p === "C:/known/hermes.exe" });
  expect(r.resolve("hermes")).toBe("C:/known/hermes.exe");
  expect(await r.resolveAsync("hermes")).toBe("C:/known/hermes.exe");
  expect(calls).toBe(0);
});

test("the resolver module has no synchronous PATH lookup left (T8b S-6)", () => {
  const src = readFileSync(join(import.meta.dir, "nonblocking-exec.ts"), "utf8");
  expect(src).not.toMatch(/lookupSync/);
  expect(src).not.toMatch(/import [^;]*\b(execSync|execFileSync|spawnSync)\b/);
});

// runCapture: spawnSync's result shape without blocking.
test("runCapture never blocks the event loop while its child runs", async () => {
  const ticks = await ticksDuring(() => runCapture(process.execPath, ["-e", "await Bun.sleep(2000)"], { timeout: 30_000 }));
  expect(ticks).toBeGreaterThanOrEqual(20);
}, 60_000);

test("runCapture reports status, stdout and stderr like spawnSync, and never rejects", async () => {
  const r = await runCapture(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { timeout: 30_000 });
  expect(r).toMatchObject({ status: 3, stdout: "out", stderr: "err", timedOut: false, error: null });
  const missing = await runCapture(join(dir, "no-such-program.exe"), [], { timeout: 5000 });
  expect(missing.status).toBeNull();
  expect((missing.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");
}, 30_000);

test("runCapture resolves (never rejects) when spawn throws synchronously: a .cmd shim, a NUL in the path (review T8b-F1)", async () => {
  const shim = join(dir, "graphify.cmd");
  writeFileSync(shim, "@echo off\r\necho hi\r\n");
  const cmd = await runCapture(shim, ["--version"], { timeout: 5000 });
  expect(cmd.status).toBeNull();
  expect(cmd.error).not.toBeNull();
  // Windows refuses to spawn a .cmd/.bat without a shell (EINVAL, CVE-2024-27980); elsewhere it's not executable.
  if (process.platform === "win32") expect((cmd.error as NodeJS.ErrnoException).code).toBe("EINVAL");
  const nul = await runCapture(`${process.execPath}\u0000x`, [], { timeout: 5000 });
  expect(nul.status).toBeNull();
  expect(nul.error).not.toBeNull();
}, 30_000);

test("runCapture stops the whole tree on timeout", async () => {
  const marker = join(dir, "capture-grandchild-alive.txt");
  const grandchild = join(dir, "capture-grandchild.js");
  writeFileSync(grandchild, `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 3000);`);
  const child = join(dir, "capture-child.js");
  writeFileSync(child, `require("node:child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`);
  const r = await runCapture(process.execPath, [child], { timeout: 1500 });
  expect(r.timedOut).toBe(true);
  expect(r.status).toBeNull();
  await Bun.sleep(4500);
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("the timed cache runs one load per key, stamp and ttl, and shares an in-flight load", async () => {
  let clock = 0;
  let loads = 0;
  const cache = createTimedCache<string>(10_000, () => clock);
  const load = async () => (loads++, await Bun.sleep(20), `v${loads}`);
  const [a, b] = await Promise.all([cache.get("hermes", "s1", load), cache.get("hermes", "s1", load)]);
  expect([a, b, loads]).toEqual(["v1", "v1", 1]);
  expect(await cache.get("hermes", "s1", load)).toBe("v1");
  expect(await cache.get("hermes", "s2", load)).toBe("v2"); // the binary changed
  clock = 20_000;
  expect(await cache.get("hermes", "s2", load)).toBe("v3"); // expired
});

// Review T8 S-4: the aggregator ran through cmd.exe, a timeout killed only cmd.exe, and the bun.exe
// grandchild kept running; and several copies could run at once.
test("runTree kills the whole tree on timeout, grandchild included", async () => {
  const marker = join(dir, "grandchild-alive.txt");
  // The child starts a grandchild that writes the marker after 3 s, then the child waits forever.
  const grandchild = join(dir, "grandchild.js");
  writeFileSync(grandchild, `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 3000);`);
  const child = join(dir, "child.js");
  writeFileSync(child, `require("node:child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`);
  await expect(runTree(process.execPath, [child], { timeout: 1500 })).rejects.toThrow(/timed out/);
  await Bun.sleep(4500);
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("singleFlight: one run at a time; requests during a run share exactly one follow-up", async () => {
  let active = 0, peak = 0;
  const gates: Array<() => void> = [];
  const f = singleFlight(() => new Promise<void>((r) => { active++; peak = Math.max(peak, active); gates.push(() => { active--; r(); }); }));
  const a = f.run();
  const b = f.run();
  const c = f.run();
  expect(b).toBe(c); // both ride the one follow-up
  await Bun.sleep(0);
  expect(f.runs).toBe(1);
  gates.shift()!();
  await a;
  await Bun.sleep(0);
  expect(f.runs).toBe(2);
  gates.shift()!();
  await b;
  expect(peak).toBe(1);
  expect(f.runs).toBe(2);
});

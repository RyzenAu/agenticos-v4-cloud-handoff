// T8b, review T8 S-6: no request path runs a synchronous child process any more.
//
// Each probe starts a real HTTP server with two routes: /slow runs the converted code path with a real
// ~2 s child process, and /ping answers at once. While /slow runs, /ping is called every 50 ms and each
// round trip is timed. With a blocked event loop no ping completes while the child runs (the "old way"
// control below proves the probe can see that); with a free one ~30 complete, each in milliseconds.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "./nonblocking-exec";
import { unpackArchive, unpackChain } from "./design-unpack";
import { createVersionInfo, versionEndpoint } from "./version";
import { lastCommit } from "./websites/catalogue";
import { ownTailnetName, primeOwnTailnetName, resetOwnTailnetNameForTests } from "./remote-access";
import { startupGate } from "./startup-gate";

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "t8b-s6-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SLOW_MS = 2000;
/** A real child process that takes ~2 s. */
const slowChild = () => runCapture(process.execPath, ["-e", `await Bun.sleep(${SLOW_MS})`], { timeout: 30_000 });

type Probe = { slowMs: number; pings: number; maxPingMs: number };
async function probe(label: string, slow: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<Probe> {
  const server = createServer((req, res) => {
    if (req.url === "/ping") return void res.end("pong");
    void slow(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const ping = async () => {
    const t0 = performance.now();
    await (await fetch(`http://127.0.0.1:${port}/ping`)).text();
    return performance.now() - t0;
  };
  await ping(); // warm the connection
  const t0 = performance.now();
  let done = false;
  const slowReq = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text()).finally(() => (done = true));
  await Bun.sleep(150); // the slow child is running now
  const times: number[] = [];
  while (!done) {
    times.push(await ping());
    await Bun.sleep(50);
  }
  await slowReq;
  const slowMs = performance.now() - t0;
  server.close();
  const result = { slowMs, pings: times.length, maxPingMs: Math.max(0, ...times) };
  console.log(`[s6-probe] ${label}: slow request ${Math.round(slowMs)} ms, ${result.pings} pings completed meanwhile, slowest ${Math.round(result.maxPingMs)} ms`);
  return result;
}

// A loaded machine can still delay one ping by a scheduling hiccup, so the bar is well under the 2 s child.
const FREE_MAX_PING_MS = 800;

test("control: the probe sees a blocked event loop (the old execFileSync way)", async () => {
  const p = await probe("control execFileSync", (_req, res) => {
    execFileSync(process.execPath, ["-e", `await Bun.sleep(${SLOW_MS})`], { stdio: "ignore" });
    res.end("done");
  });
  expect(p.slowMs).toBeGreaterThanOrEqual(SLOW_MS - 200);
  // Nothing got through while the child ran. (The probe's client shares the server's process, so a
  // blocked loop shows as pings that never complete during the slow request, not as one long ping.)
  expect(p.pings).toBeLessThanOrEqual(2);
}, 60_000);

test("/__version: the first call's `git status` no longer holds other requests", async () => {
  const info = createVersionInfo(ROOT, async () => (await slowChild(), " M file.ts\n"));
  const handler = versionEndpoint(() => true, info);
  const p = await probe("/__version git status", (req, res) => handler({ ...req, method: "GET" } as never, res as never, () => res.end("next")));
  expect(p.slowMs).toBeGreaterThanOrEqual(SLOW_MS - 200);
  expect(p.pings).toBeGreaterThanOrEqual(10);
  expect(p.maxPingMs).toBeLessThan(FREE_MAX_PING_MS);
  const v = await info();
  expect(v.dirty).toBe(true);
  expect(v.gitSha).toMatch(/^[0-9a-f]{7}$/);
  expect(await info()).toBe(v); // computed once per process
}, 60_000);

test("/__version reads the real repo's SHA from .git, with no git process", async () => {
  const v = await createVersionInfo(ROOT)();
  const git = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  expect(v.gitSha).toBe(git);
  expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
}, 30_000);

test("/__design_system: the archive unpack no longer holds other requests", async () => {
  const p = await probe("/__design_system unpack", async (_req, res) => {
    await unpackArchive("x.zip", dir, { run: () => slowChild().then(() => ({ status: 0, stdout: "", stderr: "", timedOut: false, error: null })) });
    res.end("unpacked");
  });
  expect(p.slowMs).toBeGreaterThanOrEqual(SLOW_MS - 200);
  expect(p.pings).toBeGreaterThanOrEqual(10);
  expect(p.maxPingMs).toBeLessThan(FREE_MAX_PING_MS);
}, 60_000);

test("/__design_system: unpackArchive really unpacks a zip with tar, and falls back then fails honestly", async () => {
  const src = join(dir, "zip-src");
  mkdirSync(join(src, "unpacked-from"), { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "# probe\n");
  const zip = join(dir, "system.zip");
  // Build the zip with the system bsdtar (Windows 10+ and macOS). Under Git Bash, PATH's first `tar` is GNU
  // tar, which can't read zips: then unpackArchive's own Expand-Archive fallback does the unpack.
  const systemTar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  const made = await runCapture(systemTar, ["-a", "-cf", zip, "-C", src, "SKILL.md"], { timeout: 30_000 });
  expect(made.status).toBe(0);
  const out = join(dir, "zip-out");
  mkdirSync(out, { recursive: true });
  await unpackArchive(zip, out);
  expect(readFileSync(join(out, "SKILL.md"), "utf8")).toBe("# probe\n");

  const tried: string[] = [];
  const fail = async (file: string) => (tried.push(file), { status: null, stdout: "", stderr: "", timedOut: false, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });
  await expect(unpackArchive(zip, out, { isWindows: true, run: fail })).rejects.toThrow("tar: not installed; powershell: not installed");
  expect(tried).toEqual(["tar", "powershell"]);
  expect(unpackChain("a'b.zip", "d", true)[1][1].at(-1)).toContain("'a''b.zip'"); // quoted for PowerShell, never a shell string
}, 60_000);

test("/__websites/overview: each repo's `git log` no longer holds other requests, and callers share one run", async () => {
  const repo = join(dir, "site-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  let runs = 0;
  const slowGit = async () => (runs++, await slowChild(), { status: 0, stdout: "2026-09-28T10:00:00+10:00\x1fShip the hero\n" });
  const p = await probe("/__websites git log", async (_req, res) => {
    const [a, b] = await Promise.all([lastCommit(repo, slowGit), lastCommit(repo, slowGit)]);
    res.end(JSON.stringify([a, b]));
  });
  expect(p.slowMs).toBeGreaterThanOrEqual(SLOW_MS - 200);
  expect(p.pings).toBeGreaterThanOrEqual(10);
  expect(p.maxPingMs).toBeLessThan(FREE_MAX_PING_MS);
  expect(runs).toBe(1);
  expect(await lastCommit(repo, slowGit)).toEqual({ at: "2026-09-28T00:00:00.000Z", subject: "Ship the hero" }); // cached for a minute
  expect(runs).toBe(1);
  expect(await lastCommit(join(dir, "not-a-repo"))).toBeNull();
}, 60_000);

test("identity: the tailnet name is primed asynchronously, so the first request never runs `tailscale status`", async () => {
  const had = "AGENTIC_OS_TAILNET_NAME" in process.env;
  const saved = process.env.AGENTIC_OS_TAILNET_NAME;
  delete process.env.AGENTIC_OS_TAILNET_NAME;
  try {
    resetOwnTailnetNameForTests();
    const exe = join(dir, "tailscale.exe");
    writeFileSync(exe, "");
    let calls = 0;
    const p = await probe("identity tailscale status", async (_req, res) => {
      res.end(await primeOwnTailnetName(async () => (calls++, await slowChild(), JSON.stringify({ Self: { DNSName: "desktop-test.tail0000.ts.net." } })), [exe]));
    });
    expect(p.pings).toBeGreaterThanOrEqual(10);
    expect(p.maxPingMs).toBeLessThan(FREE_MAX_PING_MS);
    expect(ownTailnetName()).toBe("desktop-test.tail0000.ts.net"); // the sync getter now answers from the cache
    expect(await primeOwnTailnetName(async () => (calls++, "{}"), [exe])).toBe("desktop-test.tail0000.ts.net");
    expect(calls).toBe(1);
  } finally {
    resetOwnTailnetNameForTests();
    if (had) process.env.AGENTIC_OS_TAILNET_NAME = saved;
  }
}, 60_000);

test("the startup gate holds early requests until the lookups land (without blocking), then is a no-op", async () => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  const gate = startupGate(() => ready, 10_000);
  const passed: number[] = [];
  let moduleThrough = false;
  gate.middleware({ url: "/src/routes/inbox.tsx?v=1" }, {}, () => (moduleThrough = true));
  expect(moduleThrough).toBe(true); // Vite's page and module requests never wait
  gate.middleware({ url: "/__version" }, {}, () => passed.push(1));
  gate.middleware({ url: "/__version" }, {}, () => passed.push(2));
  await Bun.sleep(20);
  expect(passed).toEqual([]);
  expect(gate.open).toBe(false);
  release();
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(passed).toEqual([1, 2]);
  expect(gate.open).toBe(true);
  let sync = false;
  gate.middleware({ url: "/__version" }, {}, () => (sync = true));
  expect(sync).toBe(true); // straight through once open

  // A lookup that never answers can't hold requests forever.
  const stuck = startupGate(() => new Promise(() => {}), 100);
  let through = false;
  stuck.middleware({ url: "/__version" }, {}, () => (through = true));
  await Bun.sleep(250);
  expect(through).toBe(true);
});

// ── Source contracts: the request paths named in REVIEW-T8 S-6 carry no synchronous spawns ──
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SYNC = /\b(execSync|execFileSync|spawnSync)\s*\(/;

function handlerBody(src: string, route: string): string {
  const start = src.indexOf(`server.middlewares.use("${route}"`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("server.middlewares.use(", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

test("vite.config: /__graphify_ingest and /__design_system spawn nothing synchronously", () => {
  const src = read("vite.config.ts");
  for (const route of ["/__graphify_ingest", "/__design_system"]) expect(code(handlerBody(src, route))).not.toMatch(SYNC);
  expect(code(handlerBody(src, "/__graphify_ingest"))).toContain("await runCapture(bin, [\"update\", repoPath]");
  expect(code(handlerBody(src, "/__design_system"))).toContain("await unpackArchive(zipPath, unpackDir");
  // The resolver's sync `where` is gone; the only sync spawns left in the file are the documented ones.
  expect(src).not.toContain("lookupSync");
  const left = [...code(src).matchAll(/\b(execSync|execFileSync|spawnSync)\s*\(/g)].length;
  expect(left).toBe(3); // shutdown taskkill (the event loop is ending), and two macOS-only helpers (clang, sips)
  expect(src).toContain("startupGatePlugin(() => Promise.all([cliBinsWarm, primeOwnTailnetName(), versionInfo()]))");
});

test("the modules behind request paths spawn nothing synchronously", () => {
  for (const f of ["scripts/version.ts", "scripts/websites/catalogue.ts", "scripts/websites/plugin.ts", "scripts/design-unpack.ts", "scripts/ai-usage/sources.ts", "scripts/site-draft/imagery.ts"])
    expect([f, code(read(f)).match(SYNC)?.[0] ?? null]).toEqual([f, null]);
  // Blocking fallbacks kept only for CLIs/tests; the server primes them first.
  const coding = code(read("scripts/coding/plugin.ts"));
  expect(coding).toContain("await runCapture(binary, [\"--version\"]");
  expect(code(read("scripts/coding/routes.ts"))).toContain("await rt.cliVersionsReady?.()");
});

test("websites overview is awaited by its route", () => {
  expect(read("scripts/websites/plugin.ts")).toContain('return send(await websitesOverview(opts));');
  expect(existsSync(join(ROOT, "scripts/design-unpack.ts"))).toBe(true);
});

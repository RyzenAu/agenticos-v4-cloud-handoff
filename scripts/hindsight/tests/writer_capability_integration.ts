/**
 * Track 6 · the writer capability end to end on the SYNTHETIC instance (never the pilot, never 8081):
 *
 *   - Hindsight: the dedicated `stage-d` API (127.0.0.1:8893), already running; its own proxy (8883) is untouched.
 *   - THIS branch's proxy.py, started here as a standalone process on 8884, with a scratch profile: the
 *     stage-d API and key file (the proxy reads it itself), a SYNTHETIC document-delete secret made here,
 *     writer_capability "on", writer_port = the quiet OS below, its own run dir (writes on).
 *   - A quiet AgenticOS copy from this worktree on 8097 (synthetic vault and store), pointed straight at
 *     8884 (no relay: the TCP peer must be the OS process itself).
 *   - The "attacker": a separate `bun` process (the same bun.exe image), which can read the synthetic secret.
 *
 * Proves (a) the OS registers and saves with a model receipt; (b) another bun process can't write, even
 * copying every header or inventing a capability; (c) its forged registration (a VALID proof) is refused
 * because it isn't the port's owner; (d) a proxy restart: the OS re-registers transparently; (e) an OS
 * restart: a new PID registers, the old one is dropped; (f) with the capability off, today's behaviour
 * (the bypass) is back. Writes docs/t6-memory/evidence/writer-capability-run.json. Everything under
 * D:\agent-scratch\t6 is removed at the end. No key is read or printed here.
 *
 *   bun --no-env-file scripts/hindsight/tests/writer_capability_integration.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const PY = "D:\\hindsight\\venv\\Scripts\\python.exe";
const STAGE_D_CONFIG = "D:\\hindsight\\stage-d\\hindsight.stage-d.json";
const PROXY_PORT = 8884;
const OS_PORT = 8097;
const RUN = randomBytes(3).toString("hex");
const BANK = `syn-t6w-${RUN}`;
const WORK = join("D:\\agent-scratch\\t6", `writer-${RUN}`);
const SECRET_FILE = join(WORK, "synthetic-docdelete.key");
const results: { step: string; ok: boolean; what: string; observed: unknown }[] = [];
const check = (step: string, what: string, ok: boolean, observed?: unknown) => {
  results.push({ step, ok, what, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${what}`);
  if (observed !== undefined) console.log(`      ${JSON.stringify(observed).slice(0, 500)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
/** A freshly started dev server can reset connections while Vite re-optimises and restarts: retry resets. */
async function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  for (let i = 0; ; i++) {
    try {
      return await raw1(url, init);
    } catch (e) {
      if (i >= 5 || !/ECONNRESET|socket hang up|ECONNREFUSED/i.test((e as Error).message)) throw e;
      await sleep(3000);
    }
  }
}
function raw1(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const u = new URL(url);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((ok, fail) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}), ...init.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* html */
          }
          ok({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.setTimeout(300_000, () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── the scratch proxy ─────────────────────────────────────────────────────────────────
let proxyProc: ChildProcess | null = null;
function writeProxyConfig(enforce: boolean) {
  const cfg = JSON.parse(readFileSync(STAGE_D_CONFIG, "utf8")); // paths only; the key file is read by the proxy itself
  const prof = cfg.profiles["stage-d"];
  prof.run_dir = join(WORK, "proxy-run");
  prof.log_dir = join(WORK, "proxy-logs");
  prof.proxy = {
    ...prof.proxy,
    port: PROXY_PORT,
    read_banks: ["syn-*"],
    write_banks: ["syn-*"],
    docdelete_secret_file: SECRET_FILE,
    write_images: ["bun.exe"],
    writer_capability: enforce ? "on" : "off",
    writer_port: OS_PORT,
  };
  mkdirSync(prof.run_dir, { recursive: true });
  mkdirSync(prof.log_dir, { recursive: true });
  writeFileSync(join(prof.run_dir, "WRITES_ENABLED"), new Date().toISOString());
  writeFileSync(join(WORK, "proxy.json"), JSON.stringify(cfg, null, 2));
}
async function startProxy(enforce: boolean) {
  writeProxyConfig(enforce);
  proxyProc = spawn(PY, [join(ROOT, "scripts", "hindsight", "proxy.py"), "--profile", "stage-d", "--config", join(WORK, "proxy.json")], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await raw(`http://127.0.0.1:${PROXY_PORT}/health`, { headers: { Host: `127.0.0.1:${PROXY_PORT}` } })).status === 200) return;
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  throw new Error("the scratch proxy didn't come up");
}
function stopProxy() {
  if (proxyProc?.pid) spawnSync("taskkill", ["/PID", String(proxyProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  proxyProc = null;
}
const proxyLog = () =>
  existsSync(join(WORK, "proxy-run", "proxy.jsonl"))
    ? readFileSync(join(WORK, "proxy-run", "proxy.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];

// ── the quiet OS copy ─────────────────────────────────────────────────────────────────
let osProc: ChildProcess | null = null;
let session = "";
let token = "";
async function startOs() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(HINDSIGHT_|MEMORY_|MU_MEMORY|MU_WIKI)/.test(k)) env[k] = v;
  Object.assign(env, {
    AGENTIC_OS_NO_BACKGROUND: "1",
    ARGENTIC_PORT: String(OS_PORT),
    MU_MEMORY_WRITES: "on",
    HINDSIGHT_URL: `http://127.0.0.1:${PROXY_PORT}`,
    HINDSIGHT_BANK: BANK,
    HINDSIGHT_APPROVAL_SECRET_FILE: SECRET_FILE,
    MU_WIKI_ROOT: join(WORK, "vault"),
    MU_WIKI_VAULT_NAME: "t6-writer-synthetic",
    MEMORY_STATE_DIR: join(WORK, "state"),
    AGENTIC_OS_VITE_CACHE_DIR: join(WORK, "vite-cache"),
    TEMP: join(WORK, "tmp"),
    TMP: join(WORK, "tmp"),
  });
  mkdirSync(join(WORK, "tmp"), { recursive: true });
  osProc = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(OS_PORT), "--strictPort"], { cwd: ROOT, env, stdio: "ignore", windowsHide: true });
  const host = { Host: `localhost:${OS_PORT}` };
  for (let i = 0; i < 240; i++) {
    try {
      if ((await raw(`http://127.0.0.1:${OS_PORT}/__memory/status`, { headers: host })).status === 200) break;
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  const nav = await raw(`http://127.0.0.1:${OS_PORT}/memory/vault`, { headers: { ...host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
  session = ([] as string[]).concat((nav.headers["set-cookie"] as string[] | string | undefined) ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mu_session=")) ?? "";
  token = (await raw(`http://127.0.0.1:${OS_PORT}/__token`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } })).body?.token ?? "";
}
function stopOs() {
  if (osProc?.pid) spawnSync("taskkill", ["/PID", String(osProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  osProc = null;
}
function osListenerPid(): number | null {
  const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${OS_PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1`], { encoding: "utf8", windowsHide: true });
  const n = Number(String(out.stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}
const memPost = (path: string, body: unknown) =>
  raw(`http://127.0.0.1:${OS_PORT}/__memory${path}`, {
    method: "POST",
    headers: { Host: `localhost:${OS_PORT}`, Origin: `http://localhost:${OS_PORT}`, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session } : {}), "x-claude-os-token": token },
    body,
  });
async function osSave(text: string) {
  const r = await memPost("/remember", { text });
  const id = r.body?.memory?.id as string | undefined;
  let item: any = null;
  for (let i = 0; i < 60 && id; i++) {
    item = (await raw(`http://127.0.0.1:${OS_PORT}/__memory/item/${id}`, { headers: { Host: `localhost:${OS_PORT}` } })).body;
    if (item?.row?.indexed === "confirmed" && item.row.processed_by) break;
    await memPost("/sync", {}).catch(() => null);
    await sleep(3000);
  }
  return { status: r.status, id, indexed: item?.row?.indexed ?? null, processed_by: item?.row?.processed_by ?? null, message: r.body?.message };
}

// ── the attacker: another bun.exe ─────────────────────────────────────────────────────
function attacker(mode: "retain-no-header" | "retain-invented-capability" | "forged-registration"): { status: number; body: any; pid: number } {
  const file = join(WORK, `attacker-${mode}.ts`);
  const secretLine = mode === "forged-registration" ? `const secret = require("node:fs").readFileSync(${JSON.stringify(SECRET_FILE)}, "utf8").trim();` : "";
  writeFileSync(
    file,
    `
const { createHash, createHmac, randomBytes } = require("node:crypto");
${secretLine}
const base = "http://127.0.0.1:${PROXY_PORT}";
const headers = { "Content-Type": "application/json", Accept: "application/json" };
let url = base + "/v1/default/banks/${BANK}/memories";
let body = { items: [{ content: "Synthetic attacker line ${RUN}: the Kraken depot opens at midnight.", document_id: "attacker-${RUN}-" + "${mode}", tags: ["src:agenticos"] }], async: false };
if (${JSON.stringify(mode)} === "retain-invented-capability") headers["X-MU-Writer"] = randomBytes(32).toString("hex");
if (${JSON.stringify(mode)} === "forged-registration") {
  const ts = Math.floor(Date.now() / 1000);
  const cap = createHash("sha256").update(randomBytes(32).toString("hex")).digest("hex");
  const nonce = randomBytes(16).toString("hex");
  const proof = createHmac("sha256", secret).update("mu-writer-register-v1|" + ts + "|" + cap + "|" + nonce).digest("hex");
  url = base + "/_mu/writer/register";
  body = { capability_sha256: cap, ts, nonce, proof };
}
const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
let j = null; try { j = await r.json(); } catch {}
console.log(JSON.stringify({ status: r.status, body: j, pid: process.pid }));
`,
  );
  const out = spawnSync(process.execPath, ["--no-env-file", file], { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  try {
    return JSON.parse(String(out.stdout).trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    return { status: 0, body: String(out.stderr).slice(-300), pid: 0 };
  }
}

/**
 * REVIEW-T6 finding 2: another bun.exe binds the OS's port on 0.0.0.0 or [::] BESIDE the OS's 127.0.0.1,
 * then, from that same process, registers (a valid proof: it can read the synthetic secret) and writes.
 * It holds the bind for `holdMs` after its attempts, so the harness can check the OS's own saves meanwhile.
 */
function cobind(host: "0.0.0.0" | "::", holdMs: number): Promise<{ bound: boolean; register: number; write: number; pid: number; child: ChildProcess }> {
  const file = join(WORK, `cobind-${host === "::" ? "v6" : "v4"}.ts`);
  writeFileSync(
    file,
    `
const { createHash, createHmac, randomBytes } = require("node:crypto");
const secret = require("node:fs").readFileSync(${JSON.stringify(SECRET_FILE)}, "utf8").trim();
// node:net, as Vite's own server uses (Bun.serve refuses to share the port; node:net doesn't: REVIEW-T6's probe).
const { createServer } = require("node:net");
const bound = await new Promise((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(${OS_PORT}, ${JSON.stringify(host)}, () => ok(true)); globalThis.keep = s; });
const base = "http://127.0.0.1:${PROXY_PORT}";
const cap = randomBytes(32).toString("hex");
const capSha = createHash("sha256").update(cap).digest("hex");
const ts = Math.floor(Date.now() / 1000);
const nonce = randomBytes(16).toString("hex");
const proof = createHmac("sha256", secret).update("mu-writer-register-v1|" + ts + "|" + capSha + "|" + nonce).digest("hex");
const reg = await fetch(base + "/_mu/writer/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability_sha256: capSha, ts, nonce, proof }) });
const w = await fetch(base + "/v1/default/banks/${BANK}/memories", { method: "POST", headers: { "Content-Type": "application/json", "X-MU-Writer": cap }, body: JSON.stringify({ items: [{ content: "Synthetic co-bind line ${RUN}: the Kraken depot opens at midnight.", document_id: "cobind-${RUN}-" + ${JSON.stringify(host === "::" ? "v6" : "v4")}, tags: ["src:agenticos"] }], async: false }) });
console.log(JSON.stringify({ bound, register: reg.status, write: w.status, pid: process.pid }));
await new Promise((r) => setTimeout(r, ${holdMs}));
process.exit(0);
`,
  );
  const child = spawn(process.execPath, ["--no-env-file", file], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((done) => {
    let out = "";
    child.stdout?.on("data", (c) => {
      out += c;
      const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
      if (line) {
        try {
          done({ ...JSON.parse(line), child });
        } catch {
          /* partial */
        }
      }
    });
    child.on("close", () => done({ bound: false, register: 0, write: 0, pid: 0, child }));
  });
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(SECRET_FILE, randomBytes(32).toString("hex")); // synthetic: this run's own, never a real secret
  cpSync(join(ROOT, "scripts", "memory", "fixtures", "mini-wiki"), join(WORK, "vault"), { recursive: true });
  mkdirSync(join(WORK, "state"), { recursive: true });

  await startProxy(true);
  await startOs();
  const pid1 = osListenerPid();
  check("setup", "scratch proxy (this branch, writer capability ON) and a quiet OS copy are up; the OS has a browser session", !!pid1 && !!session && !!token, { proxy: PROXY_PORT, os: OS_PORT, os_pid: pid1, bank: BANK });

  // (a)
  const a = await osSave(`Synthetic writer check ${RUN}: the Heron depot opens at 6am on weekdays.`);
  const regs = () => proxyLog().filter((r) => r.route === "/_mu/writer/register");
  const writesFrom = (pid: number | null) => proxyLog().filter((r) => r.route === "/banks/{bank}/memories" && r.method === "POST" && r.client_pid === pid);
  check("a", "the OS registers its capability, then its save lands in Hindsight with a model receipt", a.indexed === "confirmed" && !!a.processed_by && regs().some((r) => r.decision === "allow" && r.client_pid === pid1) && writesFrom(pid1).some((r) => r.decision === "allow"), {
    save: a,
    registrations: regs().map((r) => ({ decision: r.decision, pid: r.client_pid })),
  });

  // (b)
  const b1 = attacker("retain-no-header");
  const b2 = attacker("retain-invented-capability");
  check("b", "another bun.exe can't write: no capability, or an invented one, is refused (403 writer-refused)", b1.status === 403 && b1.body?.code === "writer-refused" && b2.status === 403 && b2.body?.code === "writer-refused" && b1.pid !== pid1, {
    no_header: { status: b1.status, code: b1.body?.code, pid: b1.pid },
    invented: { status: b2.status, code: b2.body?.code, pid: b2.pid },
  });

  // (c)
  const c = attacker("forged-registration");
  check("c", "its forged registration (with a VALID proof: it can read the secret) is refused: it doesn't own the OS's port", c.status === 403 && /only the process serving/.test(String(c.body?.error)), { status: c.status, error: c.body?.error, pid: c.pid });
  const after = await osSave(`Synthetic writer check ${RUN}: the Egret desk closes at 4pm.`);
  check("c", "the OS's own capability is unchanged by the forged attempt (its next save lands)", after.indexed === "confirmed", after);

  // (d)
  stopProxy();
  await sleep(1500);
  await startProxy(true);
  const d = await osSave(`Synthetic writer check ${RUN}: the Brolga courier comes at 11am.`);
  const regsD = regs();
  check("d", "a proxy restart (the capability is memory-only): the OS's next write is told to register, re-registers and lands", d.indexed === "confirmed" && regsD.filter((r) => r.decision === "allow" && r.client_pid === pid1).length >= 2, {
    save: d,
    registrations: regsD.map((r) => ({ decision: r.decision, pid: r.client_pid })),
    unregistered_refusals: proxyLog().filter((r) => r.why === "writer-unregistered").length,
  });

  // (e)
  stopOs();
  await sleep(2000);
  await startOs();
  const pid2 = osListenerPid();
  const e = await osSave(`Synthetic writer check ${RUN}: the Jabiru clinic opens at 9am.`);
  check("e", "an OS restart: the new process (new PID) registers itself; the old registration died with the old listener", !!pid2 && pid2 !== pid1 && e.indexed === "confirmed" && regs().some((r) => r.decision === "allow" && r.client_pid === pid2), {
    old_pid: pid1,
    new_pid: pid2,
    save: e,
  });
  const e2 = attacker("retain-no-header");
  check("e", "after the OS restart, another bun.exe is still refused", e2.status === 403, { status: e2.status, code: e2.body?.code });

  // (g) REVIEW-T6 finding 2: the co-bind attack, both address families
  for (const host of ["0.0.0.0", "::"] as const) {
    const g = await cobind(host, 25_000);
    const during = await memPost("/remember", { text: host === "::" ? `Synthetic writer check ${RUN}: the Gannet account renews every June.` : `Synthetic writer check ${RUN}: the Tern desk opens at noon.` });
    const duringIndexed = during.body?.destination?.indexed ?? during.body?.memory?.indexed ?? null;
    if (g.child.pid) spawnSync("taskkill", ["/PID", String(g.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await sleep(1500);
    await memPost("/sync", {}).catch(() => null);
    const id = during.body?.memory?.id as string | undefined;
    let after: any = null;
    for (let i = 0; i < 40 && id; i++) {
      after = (await raw(`http://127.0.0.1:${OS_PORT}/__memory/item/${id}`, { headers: { Host: `localhost:${OS_PORT}` } })).body;
      if (after?.row?.indexed === "confirmed") break;
      await memPost("/sync", {}).catch(() => null);
      await sleep(3000);
    }
    if (!g.bound) {
      // Windows refused the co-bind outright here: the attack can't even start. Recorded as such.
      check(`g ${host}`, `co-binding ${host === "::" ? "[::]" : "0.0.0.0"}:${OS_PORT} beside the OS was refused by Windows (no attack possible); registration and writes were refused anyway`, g.register === 403 && g.write === 403, { attacker: g });
      continue;
    }
    check(
      `g ${host}`,
      `a bun.exe co-binding ${host === "::" ? "[::]" : "0.0.0.0"}:${OS_PORT} beside the OS can't register (even with a valid proof) or write; the OS's save waits meanwhile and lands once the co-bind is gone`,
      g.bound && g.register === 403 && g.write === 403 && duringIndexed !== "confirmed" && after?.row?.indexed === "confirmed",
      { attacker: { bound: g.bound, register: g.register, write: g.write, pid: g.pid }, os_save_during: duringIndexed, os_save_status: during.status, os_reply: String(during.body?.message ?? during.body?.error ?? "").slice(0, 160), os_save_after: after?.row?.indexed ?? null },
    );
  }

  // (f)
  stopProxy();
  await sleep(1500);
  await startProxy(false);
  const f = attacker("retain-no-header");
  const fOs = await osSave(`Synthetic writer check ${RUN}: the Curlew van is always parked in bay 9.`);
  check("f", "with writer_capability OFF, today's behaviour is back: any bun.exe writes (the bypass), and the OS still writes", f.status === 200 && fOs.indexed === "confirmed", { attacker: { status: f.status }, os: fOs.indexed });

  const log = proxyLog();
  const leaked = JSON.stringify(log).includes(readFileSync(SECRET_FILE, "utf8").trim());
  check("hygiene", "the proxy log holds route templates and decisions only: no secret, no capability", !leaked && log.every((r) => !("capability" in r)), { lines: log.length });
}

main()
  .catch((e) => {
    results.push({ step: "aborted", ok: false, what: (e as Error).message, observed: null });
    console.error("aborted:", (e as Error).message);
  })
  .finally(() => {
    stopOs();
    stopProxy();
    const out = { run: RUN, bank: BANK, at: new Date().toISOString(), proxy: "this branch's proxy.py, standalone on 8884 against the stage-d API 8893", os: `quiet copy on ${OS_PORT}`, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    mkdirSync(join(ROOT, "docs", "t6-memory", "evidence"), { recursive: true });
    writeFileSync(join(ROOT, "docs", "t6-memory", "evidence", "writer-capability-run.json"), JSON.stringify(out, null, 2) + "\n");
    // Everything this run made under D:\agent-scratch\t6 (no junctions in it), including the synthetic secret.
    setTimeout(() => {
      try {
        rmSync(WORK, { recursive: true, force: true });
      } catch {
        /* a handle still open: the folder stays under D:\\agent-scratch */
      }
      console.log(JSON.stringify({ passed: out.passed, failed: out.failed }));
      process.exit(out.failed ? 1 : 0);
    }, 3000);
  });

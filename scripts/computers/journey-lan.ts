#!/usr/bin/env bun
/**
 * Real-host journey for the LAN bot host (programme 20261001, R5): shared computers on a second Windows PC (Ryzen-PC, WSL2 kali-linux) through the
 * vps-ssh adapter. The hub is already running (own port and data folder) with MU_COMPUTERS_SSH_ALIAS and MU_COMPUTERS_SSH_WSL_DISTRO set; this script
 * drives it through a real browser session and reads the host only through `ssh <alias> wsl.exe ... --exec` (read-only commands, plus the explicit crash
 * and cleanup steps). It prints evidence and NEVER a key, token, cookie value that matters, pairing code or environment value.
 *
 *   bun scripts/computers/journey-lan.ts --phase up       --hub http://127.0.0.1:8140 --out D:\prog-r5-lan\out
 *   bun scripts/computers/journey-lan.ts --phase after    (after the hub was killed and restarted by hand)
 *   bun scripts/computers/journey-lan.ts --phase capacity
 *   bun scripts/computers/journey-lan.ts --phase teardown
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const phaseName = arg("phase", "up");
const hubUrl = arg("hub", "http://127.0.0.1:8140");
const out = arg("out", "D:\\prog-r5-lan\\out");
const alias = arg("alias", "ryzen-bots");
const distro = arg("distro", "kali-linux");
const hostIp = arg("host-ip", "192.168.1.120");
const dataDir = arg("data", "D:\\prog-r5-lan\\data");
const SSH = "C:/Windows/System32/OpenSSH/ssh.exe";
const A = "research";
const B = "builder";
const EXTRA = ["extra3", "extra4"];
const BASE = "/var/lib/mu-computers";
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; ms?: number; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, d: unknown, ms?: number) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, ...(ms !== undefined ? { ms } : {}), data: d });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${ms !== undefined ? ` (${ms} ms)` : ""}: ${JSON.stringify(d).slice(0, 1200)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statePath = join(out, "lan-state.json");
const readState = (): Record<string, any> => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const saveState = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch }, null, 2));

/** A read-only shell command inside Ryzen's WSL (script on stdin; nothing rides the command line). */
async function wsl(command: string, timeoutMs = 60_000) {
  const r = await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "bash", "-s"], { stdin: command, timeoutMs });
  return (r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : "")).trim();
}
/** Read-only PowerShell on Ryzen's Windows side (counters, netstat, process list). */
async function win(script: string, timeoutMs = 60_000) {
  const r = await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", alias, "powershell", "-NoProfile", "-NonInteractive", "-Command", "-"], { stdin: script, timeoutMs });
  return r.stdout.trim();
}
const samplerSrc = `import os\nos.environ["MU_SAMPLER_BASE"]="${BASE}"\n` + readFileSync(join(import.meta.dir, "wsl-sampler.py"), "utf8");
const cdpSrc = `
const [port, action, ...rest] = process.argv.slice(2);
if (action === "tabs") { const l = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json(); console.log(JSON.stringify({ action, tabs: l.filter((t) => t.type === "page").map((t) => ({ title: t.title, url: t.url })) })); process.exit(0); }
const v = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const wait = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) wait.get(d.id)(d); };
const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
if (action === "set") await send("Storage.setCookies", { cookies: [{ name: rest[0], value: rest[1], domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }] });
const r = await send("Storage.getCookies", {});
console.log(JSON.stringify({ action, cookies: (r.result?.cookies ?? []).filter((c) => c.domain.includes("example")).map((c) => ({ name: c.name, domain: c.domain })) }));
ws.close();
`;

// ---- hub API through the confirmed browser session ------------------------------------------------------------------------------------
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
let page!: Page;
let token = "";
async function session() {
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`${hubUrl}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  return me;
}
const rawCall = (method: string, path: string, body?: unknown, prefix = "/__computers") =>
  page.evaluate(
    async ([m, p, b, t, pre]) => {
      const res = await fetch(`${pre}${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, json, bytes: text.length };
    },
    [method, path, body ?? null, token, prefix] as unknown[] as [string, string, unknown, string, string],
  ) as Promise<{ status: number; json: any; bytes: number }>;
/** A write the hub answers "Refresh this page" (a stale page token) is retried once with a fresh token. */
const call = async (method: string, path: string, body?: unknown, prefix = "/__computers") => {
  let r = await rawCall(method, path, body, prefix);
  if (r.status === 403 && /Refresh this page/.test(String(r.json?.error))) {
    token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
    r = await rawCall(method, path, body, prefix);
  }
  return r;
};
const ALL = [A, B, ...EXTRA, "r5-local-check"];
const list = async () => (((await call("GET", "/")).json.computers as any[]) ?? []).filter((c) => ALL.includes(c.name));
const view = async (n: string) => (await list()).find((c) => c.name === n);
const waitFor = async (what: string, fn: () => Promise<any>, ms = 90_000, every = 300) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
};
const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);
const job = async (id: string) => (await call("GET", `/jobs/${id}`)).json.job as any;
async function runJob(computer: string, steps: unknown[], agent = "journey-lan") {
  const t = Date.now();
  const r = await call("POST", `/${computer}/jobs`, { agent, steps });
  if (r.status !== 200) return { started: false as const, status: r.status, error: r.json.error, ms: Date.now() - t };
  await waitFor(`job on ${computer}`, async () => settled((await job(r.json.jobId)).state), 120_000, 100);
  return { started: true as const, job: await job(r.json.jobId), ms: Date.now() - t };
}
const lines = (j: any) => j.steps.map((s: any) => `${s.outcome} ${s.action ?? s.executor}: ${s.intent.slice(0, 120)}`);
async function shot(n: string, file?: string) {
  const r = await page.evaluate(async (name) => {
    const res = await fetch(`/__computers/${name}/screenshot`);
    const b = new Uint8Array(await res.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { status: res.status, type: res.headers.get("content-type"), len: b.length, b64: res.status === 200 ? btoa(s) : "" };
  }, n);
  if (file && r.b64) writeFileSync(join(out, file), Buffer.from(r.b64, "base64"));
  return { status: r.status, type: r.type, bytes: r.len };
}
const tcp = (host: string, port: number, ms = 1500) =>
  new Promise<string>((resolve) => {
    const s = createConnection({ port, host });
    const done = (r: string) => (s.destroy(), resolve(r));
    s.setTimeout(ms, () => done("timeout (no answer)"));
    s.once("connect", () => done("CONNECTED"));
    s.once("error", (e: any) => done(`refused/unreachable (${e.code})`));
  });

const INSPECT = (names: string[]) => `
python3 - <<'PY'
import json, os, re, subprocess
base = os.path.expanduser("${BASE}")
out = {}
for n in ${JSON.stringify(names)}:
    d = base + "/" + n
    try:
        full = json.load(open(d + "/cfg/computer.json"))
        cfg = {k: full[k] for k in ("name", "deviceId", "display", "resolution", "vncPort", "workdir", "profileDir", "cdpPort") if k in full}
    except Exception as e:
        cfg = {"error": str(e)}
    out[n] = {"cfg": cfg, "dirs": sorted(os.listdir(d)) if os.path.isdir(d) else None, "work": sorted(os.listdir(d + "/work")) if os.path.isdir(d + "/work") else None}
ps = subprocess.run(["ps", "-eo", "pid=,ppid=,etimes=,args="], capture_output=True, text=True).stdout.splitlines()
keep = [l[:300] for l in ps if re.search(r"Xvfb :[0-9]+|x11vnc -display|mu-computers/bin/companion|user-data-dir=.*mu-computers/", l) and not re.search(r"--type=|crashpad", l)]
out["processes"] = keep
out["counts"] = {"companion": len([l for l in ps if "companion.mjs" in l and "run --config" in l]), "xvfb": len([l for l in ps if re.search(r" Xvfb :", l)]), "x11vnc": len([l for l in ps if "x11vnc" in l and "-display" in l]), "browserMain": len([l for l in ps if "--user-data-dir=" in l and "mu-computers" in l and "--type=" not in l and "crashpad" not in l])}
print(json.dumps(out))
PY`;
const processCounts = async () => JSON.parse(await wsl(INSPECT([A, B])));
const SOCKETS = `ss -ltnH | awk '{print $4}' | sort | tr '\\n' ' '; echo; echo ---unix; ss -lxH | awk '{print $5}' | grep -E 'X[0-9]+$' | sort | tr '\\n' ' '`;

async function main() {
  const me = await session();
  log("hub up; real browser session", { person: me.person?.id, actor: me.principal?.actor, hub: hubUrl });
  if (phaseName === "up") await up();
  else if (phaseName === "after") await after();
  else if (phaseName === "capacity") await capacity();
  else if (phaseName === "tunnelloss") await tunnelLoss();
  else if (phaseName === "research") await researchRun();
  else if (phaseName === "both") await bothHosts();
  else if (phaseName === "pageload") await pageLoad();
  else if (phaseName === "verify") await verify();
  else if (phaseName === "teardown") await teardown();
  else throw new Error("unknown phase");
}

// ------------------------------------------------------------------------------------------------------------------------------------
async function up() {
  const host = (await call("GET", "/host")).json;
  log("host check (adapter list)", host.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, host: a.check.host, present: a.check.present, missing: a.check.missing, notes: a.check.notes })));
  for (const c of await list()) log(`reset: removing old ${c.name}`, { status: (await call("POST", `/${c.name}/action`, { action: "destroy" })).status });

  // 3. Provision TWO desktops on Ryzen through the vps-ssh adapter.
  const tp = Date.now();
  const [pa, pb] = [await call("POST", "/", { name: A, adapter: "vps-ssh", label: "Research" }), await call("POST", "/", { name: B, adapter: "vps-ssh", label: "Builder" })];
  log("provision two computers on Ryzen (sequential: the first installs the bundle)", { wallMs: Date.now() - tp, a: { status: pa.status, adapter: pa.json.computer?.adapter, desktop: pa.json.computer?.desktop, browser: pa.json.computer?.browser, err: pa.json.error }, b: { status: pb.status, adapter: pb.json.computer?.adapter, desktop: pb.json.computer?.desktop, err: pb.json.error } });
  await waitFor("both online", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"));
  log("both online", (await list()).map((c) => ({ name: c.name, adapter: c.adapter, state: c.state, desktop: c.desktop, viewer: c.viewer, caps: c.capabilities?.length })));
  // 2. The tunnel is up (started by the first provision); nothing listens on the LAN.
  log("ON RYZEN (Windows) netstat for the tunnel port", await win("netstat -ano | Select-String ':18091'"));
  log("FROM THIS PC: tcp connect to the tunnel port on the LAN address", { target: `${hostIp}:18091`, result: await tcp(hostIp, 18091) });
  log("ON THE HUB PC: nothing but loopback listens for the bridge", (await defaultRunner(["powershell.exe", "-NoProfile", "-Command", "Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in (Get-Process bun,node -ErrorAction SilentlyContinue).Id } | Select-Object LocalAddress,LocalPort | Sort-Object LocalPort | Format-Table -HideTableHeaders | Out-String"], { timeoutMs: 30_000 })).stdout.trim().split(/\r?\n/).filter(Boolean));

  const insp = JSON.parse(await wsl(INSPECT([A, B])));
  log("ISOLATION (inside Ryzen's WSL): separate display, VNC port, DevTools port, profile and work folder per computer", { [A]: insp[A], [B]: insp[B], counts: insp.counts });
  log("LISTENING sockets inside Ryzen's WSL (tcp must all be 127.0.0.1; X11 unix only)", (await wsl(SOCKETS)).split("\n"));
  const ports: number[] = [];
  for (const n of [A, B]) {
    insp[n].cfg.cdpPort = 9300 + Number(insp[n].cfg.display); // the allocator hands out 5900+display (VNC) and 9300+display (DevTools)
    ports.push(Number(insp[n].cfg.vncPort), Number(insp[n].cfg.cdpPort));
  }
  const probe: Record<string, string> = {};
  for (const p of [...ports, 18091]) probe[`${hostIp}:${p}`] = await tcp(hostIp, p);
  log("FROM THIS PC (hub PC 192.168.1.130): tcp connect to hub/bridge 18091, VNC 60xx and browser-debugging 94xx on Ryzen's LAN address 192.168.1.120 (all must fail)", { hubBridge: { [`${hostIp}:18091`]: probe[`${hostIp}:18091`] }, vnc: Object.fromEntries(Object.entries(probe).filter(([k]) => /:60\d\d$/.test(k))), browserDebugging: Object.fromEntries(Object.entries(probe).filter(([k]) => /:94\d\d$/.test(k))) });
  log("ON RYZEN (Windows) netstat for the VNC and DevTools ports", await win(`netstat -ano | Select-String ':(${ports.join("|")}|18091)\\s'`));

  // Each computer drives its own browser; a cookie set in one is absent in the other; files are separate.
  const nav = (n: string, url: string, title: string, file: string, text: string) =>
    runJob(n, [{ executor: "browser.navigate", args: { url, expectTitle: title }, timeoutMs: 60000 }, { executor: "file.write", args: { name: file, text } }]);
  const [na, nb] = [await nav(A, "https://example.com", "Example Domain", "only-in-research.txt", "research notes"), await nav(B, "https://example.org", "Example Domain", "only-in-builder.txt", "builder notes")];
  log("navigate + write a file on each computer", { research: na.started ? { state: na.job.state, steps: lines(na.job) } : na, builder: nb.started ? { state: nb.job.state, steps: lines(nb.job) } : nb });
  const cdp = async (n: string, action: string, ...rest: string[]) => JSON.parse((await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "node", "-", String(insp[n].cfg.cdpPort), action, ...rest], { stdin: cdpSrc, timeoutMs: 30_000 })).stdout.trim());
  log("COOKIE: set a cookie in research's browser (CDP on its own port)", await cdp(A, "set", "mu_lan_test", "research-only"));
  log("COOKIE: research's browser sees it; builder's browser does not", { research: await cdp(A, "get"), builder: await cdp(B, "get") });
  log("FILES: each work folder holds only its own file", { [A]: (await wsl(`ls ${BASE}/${A}/work`)).split("\n"), [B]: (await wsl(`ls ${BASE}/${B}/work`)).split("\n") });
  const cross = await runJob(B, [{ executor: "file.read", args: { name: "only-in-research.txt" } }]);
  log("FILES: builder cannot read research's file", cross.started ? { state: cross.job.state, steps: lines(cross.job) } : cross);
  log("HOME / identity per computer (MU_COMPUTER_DIR and DISPLAY only)", await wsl(`for n in ${A} ${B}; do pid=$(cut -d' ' -f1 ${BASE}/$n/run/companion.pid); echo "$n pid=$pid $(tr '\\0' '\\n' < /proc/$pid/environ | grep -E '^(MU_COMPUTER_DIR|DISPLAY|HOME)=' | tr '\\n' ' ')"; done`));

  // 2/3. Real bounded tasks, run CONCURRENTLY on the two computers, with no cross-talk.
  const tTask = Date.now();
  const [rj, bj] = await Promise.all([
    runJob(A, [
      { executor: "browser.navigate", args: { url: "https://en.wikipedia.org/wiki/Canberra", expectTitle: "Canberra" }, timeoutMs: 60000 },
      { executor: "page.text" },
      { executor: "file.write", args: { name: "report-canberra.md", text: "# Canberra\n\nSource: https://en.wikipedia.org/wiki/Canberra (opened and read by the Research computer)\n" } },
    ], "research-agent"),
    runJob(B, [
      { executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 },
      { executor: "goal", args: { goal: "Open the Learn more link on this page" } },
      { executor: "file.write", args: { name: "built.txt", text: "the builder goal loop ran on this computer\n" } },
    ], "builder-agent"),
  ]);
  log("BOUNDED TASKS (concurrent): Research reads a page and saves report-canberra.md; Builder runs the goal loop then writes built.txt", {
    wallMs: Date.now() - tTask,
    research: rj.started ? { state: rj.job.state, note: rj.job.note, steps: lines(rj.job) } : rj,
    builder: bj.started ? { state: bj.job.state, note: bj.job.note, steps: lines(bj.job) } : bj,
  });
  log("NO CROSS-TALK: each browser's own tabs (read from its own DevTools port)", { research: await cdp(A, "tabs"), builder: await cdp(B, "tabs") });
  log("NO CROSS-TALK: each work folder", { research: (await wsl(`ls ${BASE}/${A}/work`)).split("\n"), builder: (await wsl(`ls ${BASE}/${B}/work`)).split("\n") });
  log("RESEARCH report content (as saved on Ryzen)", await wsl(`cat ${BASE}/${A}/work/report-canberra.md 2>&1 | head -5`));
  log("USERS AND SANDBOX (inside Ryzen's WSL): each computer runs as its own non-root user; Chromium has no --no-sandbox flag and its renderers carry a seccomp filter", await wsl(`for n in ${A} ${B}; do pid=$(cut -d' ' -f1 ${BASE}/$n/run/companion.pid); echo "$n companion user=$(ps -o user= -p $pid) uid=$(ps -o uid= -p $pid) dir-owner=$(stat -c '%U:%G %a' ${BASE}/$n)"; done; echo "other computer's folder as research's user: $(setpriv --reuid=$(ps -o user= -p $(cut -d' ' -f1 ${BASE}/${A}/run/companion.pid)) --regid=$(ps -o user= -p $(cut -d' ' -f1 ${BASE}/${A}/run/companion.pid)) --init-groups ls ${BASE}/${B}/work 2>&1 | head -1)"; echo "chromium main processes:"; ps -eo user:20,pid,args | grep -E 'chromium.*user-data-dir' | grep -v -e '--type=' -e grep | cut -c1-160; echo "--no-sandbox flags anywhere: $(ps -eo args | grep -c -e '[-]-no-sandbox')"; for p in $(pgrep -f 'chromium.*--type=renderer' | head -2); do echo "renderer $p $(grep -E '^(Seccomp|NoNewPrivs):' /proc/$p/status | tr '
' ' ')"; done`));

  // 4. Viewer: noVNC through the hub (ssh -W), one screenshot per desktop.
  for (const [n, file] of [[A, "lan-vnc-research.png"], [B, "lan-vnc-builder.png"]] as const) {
    const vp = await browser!.newPage();
    await vp.setViewportSize({ width: 1320, height: 900 });
    try {
      await vp.goto(`${hubUrl}/__computers/${n}/viewer`, { waitUntil: "domcontentloaded" });
      await vp.waitForFunction(() => { const c = document.querySelector("canvas") as HTMLCanvasElement | null; return !!c && c.width > 100; }, null, { timeout: 45_000 });
      await sleep(3000);
      await vp.screenshot({ path: join(out, file) });
      log(`VIEWER (noVNC through the hub, ssh -W to Ryzen): ${n}`, { file, canvas: await vp.evaluate(() => { const c = document.querySelector("canvas") as HTMLCanvasElement; return { w: c.width, h: c.height }; }) });
    } catch (e) {
      log(`VIEWER ${n} FAILED`, String((e as Error).message).slice(0, 300));
    } finally {
      await vp.close();
    }
  }
  log("hub-route snapshots", { research: await shot(A, "lan-snap-research.jpg"), builder: await shot(B, "lan-snap-builder.jpg") });

  // 5. Control ownership.
  const timeline: unknown[] = [];
  const mark = async (what: string) => { const v = await view(A); timeline.push({ what, state: v.state, controller: v.controller.kind && `${v.controller.kind}:${v.controller.who}`, takeoverPending: !!v.takeoverPending, paused: v.paused?.agent ?? null }); };
  const noLease = await call("POST", `/${A}/input`, { executor: "file.write", args: { name: "nolease.txt", text: "x" } });
  log("input without the lease is refused", { status: noLease.status, error: noLease.json.error });
  const jt = await call("POST", `/${A}/jobs`, { agent: "researcher", title: "will be taken over", steps: [{ executor: "wait", args: { ms: 8000 } }, { executor: "file.write", args: { name: "after-return-1.txt", text: "agent step 2" } }, { executor: "file.write", args: { name: "after-return-2.txt", text: "agent step 3" } }] });
  await sleep(1500);
  await mark("agent running step 1");
  const take = await call("POST", `/${A}/takeover`, {});
  log("takeover requested mid-step", { status: take.status, state: take.json.state });
  await mark("takeover pending");
  await waitFor("agent pauses at the boundary", async () => (await view(A)).controller.kind === "person", 30_000);
  await mark("person holds it; automation paused at the step boundary");
  const human = await call("POST", `/${A}/input`, { executor: "file.write", args: { name: "human.txt", text: "written by a person during the takeover" } });
  log("person acted while holding the lease", { status: human.status, said: human.json.result?.said });
  await sleep(2500);
  log("FILES while the person holds it: the agent's later steps have NOT run", (await wsl(`ls ${BASE}/${A}/work`)).split("\n"));
  const vs = await call("GET", `/${A}/viewer-state`);
  log("viewer-state for the holder", vs.json);
  const back = await call("POST", `/${A}/return`, {});
  log("returned to agent", { status: back.status, resumedSameJob: back.json.resumed === jt.json.jobId });
  const afterReturn = await call("POST", `/${A}/input`, { executor: "file.write", args: { name: "after-return-refused.txt", text: "x" } });
  log("input after return is refused again (holder-only)", { status: afterReturn.status });
  await waitFor("job finishes", async () => settled((await job(jt.json.jobId)).state), 60_000);
  const rt = await job(jt.json.jobId);
  log("job after return", { state: rt.state, steps: lines(rt) });
  log("lease timeline", timeline);
  // Stop (force): a running job and the computer's input.
  const js = await call("POST", `/${B}/jobs`, { agent: "builder", title: "will be force-stopped", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: "never.txt", text: "must not exist" } }] });
  await sleep(2000);
  const tStop = Date.now();
  const stop = await call("POST", `/${B}/action`, { action: "stop", force: true });
  await waitFor("job settles after stop", async () => settled((await job(js.json.jobId)).state), 30_000);
  log("STOP (force) on a running job", { status: stop.status, afterMs: Date.now() - tStop, jobState: (await job(js.json.jobId)).state, computer: (await view(B)).state, neverWritten: !(await wsl(`test -e ${BASE}/${B}/work/never.txt && echo yes || echo no`)).includes("yes") });
  const inputStopped = await call("POST", `/${B}/input`, { executor: "file.write", args: { name: "x.txt", text: "x" } });
  log("input to a stopped computer is refused", { status: inputStopped.status, error: inputStopped.json.error });
  log("processes of the stopped computer are gone (inside WSL)", (await wsl(`pgrep -fa "mu-computers/${B}" | grep -v pgrep | wc -l`)));
  const tr = Date.now();
  await call("POST", `/${B}/action`, { action: "start" });
  await waitFor("builder online again", async () => (await view(B))?.state === "online");
  log("builder started again", { restartToOnlineMs: Date.now() - tr });
  const persisted = await runJob(B, [{ executor: "file.read", args: { name: "only-in-builder.txt" } }]);
  log("FILE PERSISTENCE across stop/start", persisted.started ? { state: persisted.job.state, steps: lines(persisted.job) } : persisted);
  await sleep(35_000); // let the browser flush cookies to its profile
  log("COOKIE flushed; stop/start research, then read it back", {});
  await call("POST", `/${A}/action`, { action: "stop", force: true });
  await call("POST", `/${A}/action`, { action: "start" });
  await waitFor("research online again", async () => (await view(A))?.state === "online");
  await runJob(A, [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }]);
  log("COOKIE PERSISTENCE across stop/start (profile on disk)", await cdp(A, "get"));
  await cdp(A, "set", "mu_lan_test", "research-only"); // re-set (so the post-hub-restart check has a fresh one) and let it flush
  const pre = JSON.parse(await wsl(INSPECT([A, B])));
  saveState({ pre: { counts: pre.counts, processes: pre.processes, ports }, cdpPorts: { [A]: insp[A].cfg.cdpPort, [B]: insp[B].cfg.cdpPort }, devices: (await list()).map((c) => ({ name: c.name, id: c.id })) });
  log("state before the hub restart", { counts: pre.counts, devices: (await list()).map((c) => ({ name: c.name, id: c.id, state: c.state })) });
}

// ------------------------------------------------------------------------------------------------------------------------------------
async function after() {
  const st = readState();
  const tunnelState = (await call("GET", "/host")).json.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, notes: a.check.notes }));
  log("host check after the hub restart (tunnel notes appear here if it is down)", tunnelState);
  const timeline: unknown[] = [];
  let lastSig = "";
  await waitFor("both computers online", async () => {
    const v = (await list()).filter((c) => [A, B].includes(c.name));
    const sig = v.map((c) => `${c.name}:${c.state}${c.failure ? `(${c.failure.reason})` : ""}`).join(" ");
    if (sig !== lastSig) { lastSig = sig; timeline.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, states: sig }); }
    return v.length === 2 && v.every((c) => c.state === "online");
  }, 120_000, 200);
  log("HONEST STATE after the hub restart: what the hub reported from its first answer until both computers were online again", timeline);
  const now = await list();
  log("both computers healthy after the restart, same devices, no re-provisioning", now.filter((c) => [A, B].includes(c.name)).map((c) => ({ name: c.name, state: c.state, sameDevice: st.devices?.find((d: any) => d.name === c.name)?.id === c.id, recoveries: c.recoveries, failure: c.failure })));
  const post = JSON.parse(await wsl(INSPECT([A, B])));
  log("NO DUPLICATE PROCESSES on Ryzen: counts before vs after", { before: st.pre?.counts, after: post.counts });
  const r = await runJob(A, [{ executor: "file.read", args: { name: "human.txt" } }, { executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }]);
  log("research still works after the restart: file from before is there, browser answers", r.started ? { state: r.job.state, steps: lines(r.job) } : r);
  const cdp = async (n: string, action: string) => JSON.parse((await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "node", "-", String(st.cdpPorts[n]), action], { stdin: cdpSrc, timeoutMs: 30_000 })).stdout.trim());
  log("COOKIE still present after the hub restart", await cdp(A, "get"));
  log("viewer still works after the restart", await (async () => { const vp = await browser!.newPage(); try { await vp.goto(`${hubUrl}/__computers/${A}/viewer`, { waitUntil: "domcontentloaded" }); await vp.waitForFunction(() => { const c = document.querySelector("canvas") as HTMLCanvasElement | null; return !!c && c.width > 100; }, null, { timeout: 45_000 }); await sleep(2000); await vp.screenshot({ path: join(out, "lan-vnc-after-restart.png") }); return { ok: true }; } catch (e) { return { ok: false, err: String((e as Error).message).slice(0, 200) }; } finally { await vp.close(); } })());
}

// ------------------------------------------------------------------------------------------------------------------------------------
const PAGES: [string, string][] = [["https://example.com", "Example Domain"], ["https://www.wikipedia.org", "Wikipedia"], ["https://example.org", "Example Domain"], ["https://en.wikipedia.org/wiki/Linux", "Linux - Wikipedia"]];
async function loadFor(names: string[], seconds: number) {
  const lat: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const fails: string[] = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(names.map(async (n, idx) => {
    let i = idx;
    while (Date.now() < end) {
      const [url, title] = PAGES[i++ % PAGES.length];
      const r = await runJob(n, [{ executor: "browser.navigate", args: { url, expectTitle: title }, timeoutMs: 60000 }]);
      if (r.started && r.job.state === "succeeded") lat[n].push(r.ms); else fails.push(`${n} ${url}: ${r.started ? r.job.state : r.error}`);
      await shot(n);
      await sleep(500);
    }
  }));
  const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
  return { navMs: Object.fromEntries(Object.entries(lat).map(([n, x]) => [n, { n: x.length, p50: pct(x, 50), p95: pct(x, 95), max: pct(x, 100) }])), failures: fails };
}
/** One sample inside WSL (sampler) and one of Ryzen's Windows counters. */
async function sampleOnce(names: string[]) {
  const [w, l] = await Promise.all([
    win(`$c=(Get-Counter '\\Processor(_Total)\\% Processor Time','\\Memory\\Available MBytes' -SampleInterval 1 -MaxSamples 2).CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Compress; $v=(Get-Process vmmemWSL,vmmem -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum; $g=0; try { $g=((Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum } catch {}; "{""c"":$c,""vmmem"":$v,""gpuSum"":$g}"`),
    defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "python3", "-", ...names], { stdin: samplerSrc, timeoutMs: 30_000 }),
  ]);
  let winJ: any = null;
  try { winJ = JSON.parse(w); } catch { winJ = { raw: w.slice(0, 200) }; }
  return { t: Date.now(), win: winJ, wsl: JSON.parse(l.stdout.trim() || "{}") };
}
function summarise(label: string, all: Awaited<ReturnType<typeof sampleOnce>>[], names: string[]) {
  const samples = all.filter((s) => s.wsl?.vm);
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 10) / 10;
  const f = samples[0]; const l = samples[samples.length - 1];
  const dt = (l.t - f.t) / 1000;
  const cpuWin = samples.map((s) => (s.win?.c as any[] | undefined)?.find((x) => /processor time/i.test(x.Path))?.CookedValue).filter((x) => typeof x === "number") as number[];
  const availMb = samples.map((s) => (s.win?.c as any[] | undefined)?.find((x) => /available mbytes/i.test(x.Path))?.CookedValue).filter((x) => typeof x === "number") as number[];
  const per: Record<string, unknown> = {};
  for (const n of names) {
    const roles: Record<string, unknown> = {};
    for (const r of ["companion", "xvfb", "vnc", "chromium"]) {
      const rss = samples.map((s) => s.wsl.computers?.[n]?.[r]?.rssKb ?? 0);
      if (!rss.some((v) => v > 0)) continue;
      const cpu = (((l.wsl.computers?.[n]?.[r]?.ticks ?? 0) - (f.wsl.computers?.[n]?.[r]?.ticks ?? 0)) / 100 / dt) * 100;
      roles[r] = { meanPssMb: Math.round(mean(rss) / 1024), peakPssMb: Math.round(Math.max(...rss) / 1024), cpuPctOfOneCore: Math.round(cpu * 10) / 10 };
    }
    per[n] = roles;
  }
  const vmCpu = ((l.wsl.vm.cpuBusy - f.wsl.vm.cpuBusy) / (l.wsl.vm.cpuTotal - f.wsl.vm.cpuTotal)) * 100;
  return {
    label, samples: samples.length, seconds: Math.round(dt), computers: per,
    wslVm: { usedMbMean: Math.round(mean(samples.map((s) => s.wsl.vm.memUsedKb)) / 1024), usedMbPeak: Math.round(Math.max(...samples.map((s) => s.wsl.vm.memUsedKb)) / 1024), memTotalMb: Math.round(l.wsl.vm.memTotalKb / 1024), cpuPctOfAllThreads: Math.round(vmCpu * 10) / 10 },
    windows: { cpuPctMean: mean(cpuWin), cpuPctPeak: cpuWin.length ? Math.round(Math.max(...cpuWin)) : null, availMbMin: availMb.length ? Math.round(Math.min(...availMb)) : null, vmmemMbMean: mean(samples.map((s) => (s.win?.vmmem ?? 0) / 1048576)), gpuEngineUtilSum: mean(samples.map((s) => Number(s.win?.gpuSum ?? 0))) },
  };
}
async function measure(label: string, names: string[], seconds: number) {
  const samples: Awaited<ReturnType<typeof sampleOnce>>[] = [];
  let go = true;
  const sampler = (async () => { while (go) { try { const smp = await sampleOnce(names); if (!smp.wsl?.vm) log("sample without a WSL reading", JSON.stringify(smp.wsl).slice(0, 160)); samples.push(smp); } catch (e) { log("sample failed", String((e as Error).message).slice(0, 120)); } } })();
  const lat = await loadFor(names, seconds);
  go = false;
  await sampler;
  log(`MEASURED ${label} (real LAN host (Ryzen-PC WSL))`, { ...summarise(label, samples, names), latency: lat });
  writeFileSync(join(out, `lan-samples-${label}.json`), JSON.stringify(samples));
}
async function disks(label: string) {
  log(`DISK ${label}: Windows PHYSICAL disk on Ryzen (read-only)`, await win(`Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "{0}: used {1} GB, free {2} GB of {3} GB" -f $_.Name, [math]::Round($_.Used/1GB,1), [math]::Round($_.Free/1GB,1), [math]::Round(($_.Used+$_.Free)/1GB,1) }; Get-ChildItem "$env:LOCALAPPDATA\\wsl","$env:LOCALAPPDATA\\Packages" -Recurse -Filter ext4.vhdx -ErrorAction SilentlyContinue | ForEach-Object { "kali vhdx on disk: {0} GB" -f [math]::Round($_.Length/1GB,2) }`));
  log(`DISK ${label}: inside WSL (the ext4 figure is a VIRTUAL 1 TB size, not free storage on the PC)`, await wsl(`df -h / | tail -1; du -sh ${BASE} 2>/dev/null`));
}
async function capacity() {
  await disks("before");
  const have = new Set((await list()).map((c) => c.name));
  for (const n of [A, B]) if (!have.has(n)) { log(`${n} missing: run --phase up first`, {}); return; }
  const idle = [] as Awaited<ReturnType<typeof sampleOnce>>[];
  for (let i = 0; i < 4; i++) { idle.push(await sampleOnce([A, B])); await sleep(2500); }
  log("MEASURED 2-idle (real LAN host (Ryzen-PC WSL))", summarise("2-idle", idle, [A, B]));
  await measure("2-active", [A, B], 45);
  for (const n of EXTRA) {
    const names = n === EXTRA[0] ? [A, B, n] : [A, B, EXTRA[0], n];
    const r = (await view(n)) ? { status: 200, json: {} as any } : await call("POST", "/", { name: n, adapter: "vps-ssh", label: `LAN ${n}` });
    log(`provision ${n} (measurement step)`, { status: r.status, err: r.json.error });
    if (r.status !== 200) break;
    await waitFor(`${n} online`, async () => (await view(n))?.state === "online");
    await measure(`${names.length}-active`, names, 45);
    const resp = (await list()).map((c) => ({ name: c.name, state: c.state, failure: c.failure }));
    log(`states after ${names.length}-active`, resp);
    if (resp.some((c) => c.state !== "online")) { log("stopping the ramp: a computer is not healthy", {}); break; }
  }
  await disks("after");
}
async function tunnelLoss() {
  const pidFile = join(dataDir, "computers", `ssh-tunnel-${alias}.pid`);
  const before = JSON.parse(await wsl(INSPECT([A, B])));
  const timeline: unknown[] = [];
  let last = "";
  let go = true;
  const watcher = (async () => {
    while (go) {
      try {
        const v = (await list()).filter((c) => [A, B].includes(c.name));
        const host = (await call("GET", "/host")).json.adapters?.[0]?.check?.notes?.filter((n: string) => /tunnel/i.test(n)) ?? [];
        const sig = `${v.map((c) => `${c.name}:${c.state}${c.failure ? "!" : ""}`).join(" ")} | hostNotes:${host.length ? host.join("; ").slice(0, 110) : "none"}`;
        if (sig !== last) { last = sig; timeline.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, view: sig }); }
      } catch (e) { timeline.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, error: String((e as Error).message).slice(0, 80) }); }
      await sleep(400);
    }
  })();
  const killTunnel = async (n: number) => {
    const pid = readFileSync(pidFile, "utf8").trim();
    const r = await defaultRunner(["taskkill", "/PID", pid, "/F"], { timeoutMs: 15_000 });
    log(`killed the tunnel ssh (#${n}, pid ${pid})`, r.stdout.trim().slice(0, 80));
    return pid;
  };
  const kills = Number(arg("kills", "4"));
  for (let n = 1; n <= kills; n++) {
    const old = await killTunnel(n);
    // wait for the supervisor to bring a NEW ssh up (a new pid in the pid file) before killing again, so the backoff keeps growing
    await waitFor(`tunnel back after kill ${n}`, async () => { try { return readFileSync(pidFile, "utf8").trim() !== old; } catch { return false; } }, 60_000, 300);
    await sleep(2500);
  }
  await sleep(8000);
  go = false;
  await watcher;
  log("HONEST STATE through repeated tunnel kills (backoff 1, 2, 5, 10, 30 s): computer states and the host-check tunnel note, on change", timeline);
  const after = await list();
  log("after the tunnel came back", after.filter((c) => [A, B].includes(c.name)).map((c) => ({ name: c.name, state: c.state, recoveries: c.recoveries, failure: c.failure })));
  const post = JSON.parse(await wsl(INSPECT([A, B])));
  log("no duplicate or lost processes on Ryzen (before vs after)", { before: before.counts, after: post.counts });
  const r = await runJob(A, [{ executor: "file.read", args: { name: "report-canberra.md" } }]);
  log("safe recovery: Research still has its report and takes a job", r.started ? { state: r.job.state, steps: lines(r.job) } : r);
}

/** Run the CDP helper (cookies / tabs) against one computer's own DevTools port, on Ryzen. */
async function cdpAt(port: number, action: string, ...rest: string[]) {
  const r = await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "node", "-", String(port), action, ...rest], { stdin: cdpSrc, timeoutMs: 30_000 });
  try { return JSON.parse(r.stdout.trim()); } catch { return { error: r.stdout.slice(0, 120) || r.stderr.slice(0, 120) }; }
}
async function ensurePair() {
  for (const n of [A, B]) if (!(await view(n))) {
    const r = await call("POST", "/", { name: n, adapter: "vps-ssh", label: n === A ? "Research" : "Builder" });
    log(`provision ${n}`, { status: r.status, err: r.json.error });
  }
  await waitFor("both online", async () => { const v = (await list()).filter((c) => [A, B].includes(c.name)); return v.length === 2 && v.every((c) => c.state === "online"); });
}
async function researchRun() {
  await ensurePair();
  const portOf = async (n: string) => 9300 + Number((await wsl(`grep -o '"display": *"[0-9]*"' ${BASE}/${n}/cfg/computer.json | grep -o '[0-9]*'`)).trim());
  const pa = await portOf(A), pb = await portOf(B);
  const goal = "Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.";
  log("search service the hub uses", { searxng: "http://127.0.0.1:18888", hostGoalLoop: (await call("GET", "/host")).json.goalLoop });
  const tStart = Date.now();
  const rStart = await call("POST", `/${A}/jobs`, { agent: "researcher", title: "Research: Canberra", steps: [{ executor: "research", args: { goal } }] });
  const bStart = await call("POST", `/${B}/jobs`, { agent: "builder-agent", title: "Builder: goal loop", steps: [
    { executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 },
    { executor: "goal", args: { goal: "Open the Learn more link on this page" } },
    { executor: "file.write", args: { name: "built-concurrent.txt", text: "written by the builder goal-loop task while research ran\n" } },
  ] });
  log("both jobs started", { research: rStart.json.jobId ?? rStart.json, builder: bStart.json.jobId ?? bStart.json });
  // Bring the research job into the person's Jarvis thread the way a person would (so the report has a conversation to be delivered to).
  const cmd = await page.evaluate(async (t) => {
    const res = await fetch("/__operator/screen/command", { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": t }, body: JSON.stringify({ utterance: "show me the research computer", source: "voice", eventId: `utt-${Date.now().toString(36)}` }) });
    const text = await res.text();
    const events = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const done = events.find((e: any) => e.done)?.done ?? events.at(-1);
    return { status: res.status, ok: done?.ok, said: String(done?.said ?? "").slice(0, 200), jobId: done?.jobId };
  }, token);
  log("'show me the research computer' (joins the job to the Jarvis thread)", cmd);
  // While both run: sample each computer's own tabs and work folders for cross-talk.
  const seen: Record<string, { tabs: Set<string>; files: Set<string> }> = { [A]: { tabs: new Set(), files: new Set() }, [B]: { tabs: new Set(), files: new Set() } };
  const jobDone = async (id: string) => settled((await job(id)).state);
  let guard = 0;
  while (guard++ < 120 && !((await jobDone(rStart.json.jobId)) && (await jobDone(bStart.json.jobId)))) {
    for (const [n, port] of [[A, pa], [B, pb]] as const) {
      const t = await cdpAt(port, "tabs");
      for (const x of t.tabs ?? []) seen[n].tabs.add(`${x.title} | ${String(x.url).slice(0, 70)}`);
      for (const f of (await wsl(`ls ${BASE}/${n}/work 2>/dev/null`)).split("\n").filter(Boolean)) seen[n].files.add(f);
    }
    await sleep(3000);
  }
  const rj = await job(rStart.json.jobId), bj = await job(bStart.json.jobId);
  log("RESEARCH goal result (model-driven: find sources, read, compare, save, deliver)", { wallMs: Date.now() - tStart, state: rj.state, note: rj.note, steps: rj.steps.map((x: any) => `${x.outcome} ${x.action ?? x.executor}: ${String(x.intent).slice(0, 170)}`) });
  log("BUILDER goal-loop result (ran at the same time)", { state: bj.state, note: bj.note, steps: lines(bj) });
  log("ALL tabs and files each computer showed WHILE BOTH RAN (sampled every 3 s from each computer's own DevTools port and folder)", { research: { tabs: [...seen[A].tabs], files: [...seen[A].files] }, builder: { tabs: [...seen[B].tabs], files: [...seen[B].files] } });
  const reportFile = (await wsl(`ls -t ${BASE}/${A}/work | grep '^report-.*\\.md$' | head -1`)).trim();
  log("REPORT FILE on the Research computer", { name: reportFile, matchesPattern: /^report-\d{8}T\d{6}\.md$/.test(reportFile), onBuilder: (await wsl(`ls ${BASE}/${B}/work | grep -c '^report-'`)).trim() });
  const reportText = await wsl(`cat ${BASE}/${A}/work/${reportFile}`);
  writeFileSync(join(out, "lan-report.md"), reportText);
  log("REPORT FILE content (first 60 lines; saved to lan-report.md)", reportText.split("\n").slice(0, 60));
  log("citations in the report", { bracketCitations: (reportText.match(/\[\d+\]/g) ?? []).length, urls: [...new Set(reportText.match(/https?:\/\/[^\s)\]>"]+/g) ?? [])].slice(0, 8) });
  const conv = await call("GET", "/conversations", undefined, "/__operator");
  const entries = ((conv.json.conversations ?? []) as any[]).flatMap((c) => (c.entries ?? []).filter((e: any) => e.state === "report" && e.jobId === rStart.json.jobId).map((e: any) => ({ conv: c.id, text: String(e.text) })));
  log("DELIVERED text in the person's Jarvis thread (entries with state 'report')", entries.map((e) => ({ conv: e.conv, chars: e.text.length, text: e.text.slice(0, 900) })));
  const body = entries.map((e) => e.text.replace(/^Web-sourced research[^\n]*\n/, "")).join("\n");
  const wordsOf = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const rw = wordsOf(reportText), dw = wordsOf(body);
  const overlap = [...dw].filter((w) => rw.has(w)).length / Math.max(1, dw.size);
  log("delivered text vs the saved report: share of the delivered words that appear in the report file", { delivered: body.length > 0, overlap: Math.round(overlap * 100) / 100 });
}

async function bothHosts() {
  // Live hub's computers BEFORE (GET only).
  const liveBefore = await (await fetch("http://127.0.0.1:8081/__computers/")).json().catch((e) => ({ error: String(e) }));
  log("LIVE hub (8081) computers BEFORE (GET /__computers)", { computers: (liveBefore.computers ?? []).map((c: any) => ({ name: c.name, adapter: c.adapter, state: c.state })), error: liveBefore.error });
  const hostInfo = (await call("GET", "/host")).json.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, host: a.check.host }));
  log("this hub's two adapters", hostInfo);
  const L = "r5-local-check";
  for (const [n, adapter, label] of [[L, "wsl-local", "R5 local check"], [A, "vps-ssh", "Research"]] as const) {
    if (!(await view(n))) log(`provision ${n} on ${adapter}`, { status: (await call("POST", "/", { name: n, adapter, label })).status });
  }
  const ALLN = [L, A];
  const lst = async () => (((await call("GET", "/")).json.computers as any[]) ?? []).filter((c) => ALLN.includes(c.name));
  await waitFor("both online", async () => { const v = await lst(); return v.length === 2 && v.every((c) => c.state === "online"); });
  log("both online, each on its own adapter", (await lst()).map((c) => ({ name: c.name, adapter: c.adapter, state: c.state, desktop: c.desktop, viewer: c.viewer })));
  // Where does each computer actually run? Local kali (this PC) vs Ryzen.
  const localWsl = async (cmd: string) => (await defaultRunner(["wsl.exe", "-d", "kali-linux", "--", "bash", "-s"], { stdin: cmd, timeoutMs: 60_000 })).stdout.trim();
  log("HOST of r5-local-check (this PC's WSL): hostname and its computers folder", await localWsl(`echo "host=$(hostname)"; ls ~/mu-computers 2>/dev/null | tr '\\n' ' '`));
  log("HOST of research (Ryzen's WSL): hostname and its computers folder", (await wsl(`echo "host=$(hostname)"; ls ${BASE} | tr '\\n' ' '`)));
  const dispLocal = (await localWsl(`grep -o '"display": *"[0-9]*"' ~/mu-computers/${L}/cfg/computer.json | grep -o '[0-9]*'; grep -o '"vncPort": *[0-9]*' ~/mu-computers/${L}/cfg/computer.json | grep -o '[0-9]*$'`)).split("\n");
  const dispRyz = (await wsl(`grep -o '"display": *"[0-9]*"' ${BASE}/${A}/cfg/computer.json | grep -o '[0-9]*'; grep -o '"vncPort": *[0-9]*' ${BASE}/${A}/cfg/computer.json | grep -o '[0-9]*$'`)).split("\n");
  log("ALLOCATIONS (display, vnc port) per host: allocated by each host's own allocator", { [`${L} (this PC)`]: dispLocal, [`${A} (Ryzen)`]: dispRyz, allocatorFiles: { thisPc: (await localWsl(`python3 - <<'PY'\nimport json,os\nd=json.load(open(os.path.expanduser('~/mu-computers/alloc.json')))\nprint(json.dumps([(e.get('hub'),e.get('name'),e.get('display')) for e in d['entries'] if e.get('kind')!='bridge']))\nPY`)), ryzen: await wsl(`python3 - <<'PY'\nimport json\nd=json.load(open('/root/mu-computers/alloc.json'))\nprint(json.dumps([(e.get('hub'),e.get('name'),e.get('display')) for e in d['entries'] if e.get('kind')!='bridge']))\nPY`) } });
  // Each driven on the right host: a job on each, then read the file from the right host only.
  const ra = await runJob(L, [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }, { executor: "file.write", args: { name: "who.txt", text: "local computer on this PC" } }]);
  const rb = await runJob(A, [{ executor: "browser.navigate", args: { url: "https://example.org", expectTitle: "Example Domain" }, timeoutMs: 60000 }, { executor: "file.write", args: { name: "who.txt", text: "research computer on Ryzen" } }]);
  log("a job on each", { local: ra.started ? { state: ra.job.state, steps: lines(ra.job) } : ra, research: rb.started ? { state: rb.job.state, steps: lines(rb.job) } : rb });
  log("who.txt as found on each host (each file exists only on its own host)", { thisPc: await localWsl(`cat ~/mu-computers/${L}/work/who.txt; echo; ls ~/mu-computers/${A} 2>&1 | head -1`), ryzen: await wsl(`cat ${BASE}/${A}/work/who.txt; echo; ls ${BASE}/${L} 2>&1 | head -1`) });
  for (const [n, file] of [[L, "lan-both-local.png"], [A, "lan-both-ryzen.png"]] as const) {
    const vp = await browser!.newPage();
    await vp.setViewportSize({ width: 1320, height: 900 });
    try {
      await vp.goto(`${hubUrl}/__computers/${n}/viewer`, { waitUntil: "domcontentloaded" });
      await vp.waitForFunction(() => { const c = document.querySelector("canvas") as HTMLCanvasElement | null; return !!c && c.width > 100; }, null, { timeout: 45_000 });
      await sleep(3000);
      await vp.screenshot({ path: join(out, file) });
      log(`VIEWER ${n}`, { file, canvas: await vp.evaluate(() => { const c = document.querySelector("canvas") as HTMLCanvasElement; return { w: c.width, h: c.height }; }) });
    } catch (e) { log(`VIEWER ${n} FAILED`, String((e as Error).message).slice(0, 200)); } finally { await vp.close(); }
  }
  log("snapshots through the hub", { local: await shot(L), ryzen: await shot(A) });
  // Tear down only this hub's computers.
  for (const n of ALLN) log(`destroy ${n}`, { status: (await call("POST", `/${n}/action`, { action: "destroy" })).status });
  log("this PC's WSL after the teardown: only entries of other hubs may remain", await localWsl(`ls ~/mu-computers 2>/dev/null | tr '\\n' ' '; echo; python3 - <<'PY'\nimport json,os\np=os.path.expanduser('~/mu-computers/alloc.json')\nprint(json.dumps([(e.get('hub'),e.get('name')) for e in json.load(open(p))['entries'] if e.get('kind')!='bridge']) if os.path.exists(p) else 'no allocator file')\nPY`));
  const liveAfter = await (await fetch("http://127.0.0.1:8081/__computers/")).json().catch((e) => ({ error: String(e) }));
  log("LIVE hub (8081) computers AFTER (GET /__computers)", { computers: (liveAfter.computers ?? []).map((c: any) => ({ name: c.name, adapter: c.adapter, state: c.state })), identicalToBefore: JSON.stringify(liveBefore.computers ?? null) === JSON.stringify(liveAfter.computers ?? null), error: liveAfter.error });
}

const PL_URLS = [
  "https://www.nca.gov.au/education/canberras-history/siting-and-naming-canberra",
  "https://www.nma.gov.au/defining-moments/resources/founding-of-canberra",
  "https://www.parliament.act.gov.au/visit-and-learn/learn/resources/fs/establishing-the-nations-capital",
  "https://www.aph.gov.au/25th_Anniversary_Chronology/Creating_the_national_capital",
  "https://example.com",
  "https://en.wikipedia.org/wiki/Canberra",
];
/** Page-load timings from inside each computer's own Chromium (DevTools protocol), on Ryzen and on this PC, same URLs. */
async function pageLoad() {
  const L = "r5-local-check";
  for (const [n, adapter, label] of [[L, "wsl-local", "R5 local check"], [A, "vps-ssh", "Research"]] as const) if (!(await view(n))) log(`provision ${n} on ${adapter}`, { status: (await call("POST", "/", { name: n, adapter, label })).status });
  await waitFor("online", async () => { const v = (await list()).filter((c) => [L, A].includes(c.name)); return v.length === 2 && v.every((c) => c.state === "online"); });
  const plSrc = readFileSync(join(import.meta.dir, "pl-cdp.js"), "utf8");
  const dispOf = async (host: "local" | "ryzen", n: string) => {
    const cmd = host === "ryzen" ? `grep -o '"display": *"[0-9]*"' ${BASE}/${n}/cfg/computer.json | grep -o '[0-9]*'` : `grep -o '"display": *"[0-9]*"' ~/mu-computers/${n}/cfg/computer.json | grep -o '[0-9]*'`;
    const o = host === "ryzen" ? await wsl(cmd) : (await defaultRunner(["wsl.exe", "-d", "kali-linux", "--", "bash", "-s"], { stdin: cmd, timeoutMs: 30_000 })).stdout.trim();
    return 9300 + Number(o.trim());
  };
  // Make sure each computer's browser is running (our own navigate, on a control page).
  for (const n of [L, A]) await runJob(n, [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }]);
  const run = async (host: "local" | "ryzen", port: number, url: string) => {
    const argv = host === "ryzen" ? [SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "node", "-", String(port), url, "45000"] : ["wsl.exe", "-d", "kali-linux", "--", "node", "-", String(port), url, "45000"];
    const r = await defaultRunner(argv, { stdin: plSrc, timeoutMs: 80_000 });
    try { return JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { return { url, error: (r.stdout + r.stderr).slice(0, 200) }; }
  };
  const ports = { ryzen: await dispOf("ryzen", A), local: await dispOf("local", L) };
  const results: Record<string, any[]> = { ryzen: [], local: [] };
  const pass = Number(arg("pass", "1"));
  for (let k = 0; k < pass; k++) for (const url of PL_URLS) {
    const [ry, lo] = await Promise.all([run("ryzen", ports.ryzen, url), run("local", ports.local, url)]);
    results.ryzen.push(ry); results.local.push(lo);
    const f = (r: any) => `DCL ${r.tDCL ?? "never"} ms | load ${r.tLoad ?? "never"} ms | status ${r.status ?? "-"} | final ${String(r.finalUrl).slice(0, 80)} | pending-at-end ${r.pendingCount ?? "-"} | reqs ${r.requests ?? "-"} failed ${JSON.stringify(r.failed ?? {})}${r.error ? ` ERROR ${r.error}` : ""}`;
    log(`PAGE LOAD ${url}`, { ryzen: f(ry), local: f(lo), ryzenPendingAt25s: ry.pendingAt25s, localPendingAt25s: lo.pendingAt25s, ryzenPendingEnd: ry.pending });
  }
  writeFileSync(join(out, "lan-pageload.json"), JSON.stringify(results, null, 1));
}

/** Re-verification after the page-load fix and the review hardening: timings through OUR browser.navigate, ports while a job runs, sandbox layers, Stop x3, cross-user reach. */
async function verify() {
  await ensurePair();
  const nav = async (url: string) => {
    const t = Date.now();
    const r = await runJob(A, [{ executor: "browser.navigate", args: { url }, timeoutMs: 60000 }]);
    const st = r.started ? r.job.steps.find((x: any) => x.action === "browser.navigate" || x.executor === "browser.navigate") : null;
    return { url: url.slice(0, 90), ms: Date.now() - t, state: r.started ? r.job.state : "not started", said: String(st?.intent ?? "").replace(/^step \d+ browser\.navigate: /, "").slice(0, 200) };
  };
  const timings: unknown[] = [];
  for (const u of PL_URLS) timings.push(await nav(u));
  log("browser.navigate through the hub, Ryzen, after the fix (time = whole job; 'still loading' = DOM ready, load event never fired)", timings);

  // Ports and bindings WHILE a job runs.
  const busy = await call("POST", `/${A}/jobs`, { agent: "ports", steps: [{ executor: "browser.navigate", args: { url: "https://en.wikipedia.org/wiki/Canberra", expectTitle: "Canberra" }, timeoutMs: 60000 }, { executor: "wait", args: { ms: 20000 } }] });
  await sleep(6000);
  log("ss -ltnp INSIDE Ryzen's WSL while a job is running (browser debugging 94xx, VNC 60xx, no IPv6 VNC)", (await wsl(`ss -ltnp | grep -E ':(94[0-9][0-9]|60[0-9][0-9]|5900|18091)\\b' | awk '{print $1, $4, $6}'`)).split("\n"));
  log("what owns [::1]:5900 (it is not ours)", await wsl(`ss -ltnp | grep ':5900 ' | awk '{print $4, $6}'; echo "[::1]:600x listeners now: $(ss -ltn | grep -c -E '\\[::1\\]:60[0-9][0-9]')"`));
  log("ON RYZEN (Windows) netstat for 18091 / 94xx / 60xx while the job runs", await win(`netstat -ano | Select-String -Pattern ':(18091|94[0-9][0-9]|60[0-9][0-9])\\s'`));
  log("ON RYZEN (Windows) the firewall rules that allow SSH (read-only)", await win(`Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'ssh|OpenSSH' } | ForEach-Object { $a = $_ | Get-NetFirewallAddressFilter; $p = $_ | Get-NetFirewallPortFilter; "{0} | profile {1} | proto {2} port {3} | remote {4}" -f $_.DisplayName, $_.Profile, $p.Protocol, $p.LocalPort, ($a.RemoteAddress -join ',') }; "default inbound action per profile: " + ((Get-NetFirewallProfile | ForEach-Object { "{0}={1}" -f $_.Name, $_.DefaultInboundAction }) -join ' ')`));
  const probe: Record<string, string> = {};
  for (const port of [18091, 6001, 6002, 9401, 9402]) probe[`${hostIp}:${port}`] = await tcp(hostIp, port);
  log("FROM THIS PC: connects to 192.168.1.120 (a firewall that drops everything but 22 makes every one of these time out whatever the bindings are; the ss/netstat lines above are the proof of binding)", probe);
  await waitFor("ports job done", async () => settled((await job(busy.json.jobId)).state), 60_000);

  // Sandbox: chrome://sandbox, seccomp, namespaces.
  const portA = 9300 + Number((await wsl(`grep -o '"display": *"[0-9]*"' ${BASE}/${A}/cfg/computer.json | grep -o '[0-9]*'`)).trim());
  const sandboxPage = await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "node", "-", String(portA), "chrome://sandbox", "6000"], { stdin: readFileSync(join(import.meta.dir, "pl-cdp.js"), "utf8").replace('const ev = await send("Runtime.evaluate", { expression: "JSON.stringify({t:document.title,u:location.href,r:document.readyState})", returnByValue: true });', 'await sleep(1500); const ev = await send("Runtime.evaluate", { expression: "JSON.stringify({t:document.body.innerText.replace(/\\\\s+/g,\' \').slice(0,900),u:location.href,r:document.readyState})", returnByValue: true });'), timeoutMs: 40_000 });
  let sbx = ""; try { sbx = JSON.parse(sandboxPage.stdout.trim().split("\n").pop()!).title; } catch { sbx = sandboxPage.stdout.slice(0, 200) + sandboxPage.stderr.slice(0, 200); }
  log("chrome://sandbox in Research's own Chromium (page text)", sbx);
  log("kernel layers of Research's renderers (inside WSL): Seccomp 2 = filter on, NoNewPrivs 1, own user namespace (differs from the init namespace)", await wsl(`u=$(ps -o user= -p $(cut -d' ' -f1 ${BASE}/.ctl/${A}/run/companion.pid)); for p in $(pgrep -u $u -f 'chromium.*--type=renderer' | head -2); do echo "renderer $p user=$(ps -o user= -p $p) $(grep -E '^(Seccomp|NoNewPrivs):' /proc/$p/status | tr '\\n' ' ') userns=$(readlink /proc/$p/ns/user) (init userns: $(readlink /proc/1/ns/user)) pidns=$(readlink /proc/$p/ns/pid) (init: $(readlink /proc/1/ns/pid))"; done; echo "lsns user namespaces owned by $u: $(lsns -t user -n 2>/dev/null | awk -v u=$u '$NF ~ u || /chromium|chrome/' | head -3 | tr '\\n' ';')"`));

  // Cross-user reach (what the trust-domain wording is based on).
  log("TRUST DOMAIN: as the OTHER computer's Linux user, can this computer's loopback services be reached? (file reads were blocked earlier; services are shared)", await wsl(`u=$(ps -o user= -p $(cut -d' ' -f1 ${BASE}/.ctl/${B}/run/companion.pid)); echo "as $u: devtools of research -> $(setpriv --reuid=$u --regid=$u --init-groups curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${portA}/json/version); vnc banner -> $(setpriv --reuid=$u --regid=$u --init-groups timeout 2 head -c 12 </dev/tcp/127.0.0.1/6001 2>&1 | head -1); X display :101 -> $(setpriv --reuid=$u --regid=$u --init-groups env DISPLAY=:101 xdotool getdisplaygeometry 2>&1 | head -1); files of research -> $(setpriv --reuid=$u --regid=$u --init-groups ls ${BASE}/${A} 2>&1 | head -1)"`));

  // Stop three times: nothing of the computer's is left each time.
  const stopRuns: unknown[] = [];
  for (let i = 1; i <= 3; i++) {
    const j = await call("POST", `/${A}/jobs`, { agent: "stopper", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: `never-${i}.txt`, text: "must not exist" } }] });
    await sleep(2000);
    const st = await call("POST", `/${A}/action`, { action: "stop", force: true });
    await waitFor("job settles", async () => settled((await job(j.json.jobId)).state), 30_000);
    const left = (await wsl(`echo "procs=$(ps -eo user,args | grep -E 'mu-${A}' | grep -v grep | wc -l) xvfb=$(ps -eo args | grep -c '[X]vfb :101') vnc=$(ps -eo args | grep -c '[x]11vnc.*6001') chromium=$(ps -eo args | grep -c '[c]hromium.*mu-computers/${A}') never=$(test -e ${BASE}/${A}/work/never-${i}.txt && echo yes || echo no)"`)).trim();
    stopRuns.push({ run: i, status: st.status, job: (await job(j.json.jobId)).state, computer: (await view(A))?.state, left });
    await call("POST", `/${A}/action`, { action: "start" });
    await waitFor("online again", async () => (await view(A))?.state === "online");
  }
  log("STOP (force) three times on a running job: processes left of that computer each time", stopRuns);
}

async function teardown() {
  for (const n of ALL) { const v = await view(n); if (v) log(`destroy ${n}`, { status: (await call("POST", `/${n}/action`, { action: "destroy" })).status }); }
  log("what is left inside WSL", await wsl(`ls ${BASE} 2>&1; pgrep -fa "mu-computers" | grep -v pgrep | head -5`));
}

main()
  .catch((e) => log("FAILED", String((e as Error)?.stack ?? e).slice(0, 1500)))
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    writeFileSync(join(out, `lan-evidence-${phaseName}.json`), JSON.stringify(evidence, null, 2));
  });

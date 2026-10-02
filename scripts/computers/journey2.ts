#!/usr/bin/env bun
/**
 * Round 2 real journey (programme 20261001, Agent F): a headless Chromium INSTALLED WITHOUT ROOT inside WSL, two computers driving their own
 * browser, observe and snapshot, the hub-side goal loop (when the hub holds a Jev key), Jarvis typed commands through the one command
 * path, and working files that survive a computer restart AND a hub restart. The hub is started and stopped by this script (its own port and
 * data folder, killed by PID). It prints evidence and NEVER a cookie, token, pairing code, key or environment value.
 *
 *   bun scripts/computers/journey2.ts --out D:\prog-scratch\journey2 [--port 8112] [--distro kali-linux] [--data D:\prog-f-data2]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\journey2");
const port = Number(arg("port", "8112"));
const distro = arg("distro", "kali-linux");
const data = arg("data", "D:\\prog-f-data2");
const repo = resolve(import.meta.dir, "..", "..");
const hubUrl = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; ms?: number; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, d: unknown, ms?: number) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, ...(ms !== undefined ? { ms } : {}), data: d });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${ms !== undefined ? ` (${ms} ms)` : ""}: ${JSON.stringify(d).slice(0, 500)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wsl(command: string) {
  return (await defaultRunner(["wsl.exe", "-d", distro, "--", "bash", "-s"], { stdin: command, timeoutMs: 60_000 })).stdout.trim();
}

let hub: ChildProcess | null = null;
function startHub() {
  const logFd = openSync(join(out, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo, stdio: ["ignore", logFd, logFd], windowsHide: true,
    env: { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_COMPUTERS_WSL_DISTRO: distro, MU_COMPUTERS_PERSON_LEASE_MS: "30000", MU_COMPUTERS_MONITOR_MS: "5000" },
  });
  return hub.pid;
}
function stopHub() {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { windowsHide: true });
  hub = null;
}
async function hubReady(ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`${hubUrl}/__health`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("the hub did not start");
}

let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
let page!: Page;
let token = "";
async function session() {
  page = browser!.pages()[0] ?? (await browser!.newPage());
  await page.goto(`${hubUrl}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  return me;
}
const call = (method: string, path: string, body?: unknown, prefix = "/__computers") =>
  page.evaluate(
    async ([m, p, b, t, pre]) => {
      const res = await fetch(`${pre}${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        // The command route streams NDJSON: the last "done" line is the answer.
        for (const l of text.split("\n").filter(Boolean).reverse()) {
          try {
            const o = JSON.parse(l);
            if (o.type === "done") {
              json = o;
              break;
            }
          } catch {
            /* not a line of ours */
          }
        }
      }
      return { status: res.status, json, bytes: res.headers.get("content-type")?.includes("json") ? 0 : text.length };
    },
    [method, path, body ?? null, token, prefix] as unknown[] as [string, string, unknown, string, string],
  ) as Promise<{ status: number; json: any; bytes: number }>;
const list = async () => ((await call("GET", "/")).json.computers as any[]) ?? [];
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
async function runJob(computer: string, steps: unknown[], agent = "journey") {
  const r = await call("POST", `/${computer}/jobs`, { agent, steps });
  if (r.status !== 200) return { started: false as const, status: r.status, error: r.json.error };
  await waitFor(`job on ${computer}`, async () => settled((await job(r.json.jobId)).state), 120_000);
  return { started: true as const, job: await job(r.json.jobId) };
}
const lines = (j: any) => j.steps.map((s: any) => `${s.outcome} ${s.action ?? s.executor}: ${s.intent.slice(0, 110)}`);

async function main() {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  console.log(`hub pid ${startHub()}`);
  await hubReady();
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  const me = await session();
  log("hub up; browser session", { person: me.person?.id, via: me.via, actor: me.principal?.actor });

  // A. A browser for the host, installed without root.
  const before = (await call("GET", "/host")).json;
  log("host before", { present: before.adapters[0].check.present, missing: before.adapters[0].check.missing, goalLoopOnHub: before.goalLoop });
  const ti = Date.now();
  const inst = await call("POST", "/host/install-browser", {});
  log("install a headless browser (user-level, no sudo)", { status: inst.status, present: inst.json.adapters?.[0]?.check?.present, error: inst.json.error }, Date.now() - ti);
  log("browser size on disk (inside WSL)", (await wsl('du -sh "$HOME/mu-computers/browser" | cut -f1; ls "$HOME/mu-computers/browser"')).split("\n"));

  // B. Two computers.
  for (const name of ["research", "builder"]) {
    const t = Date.now();
    const r = await call("POST", "/", { name });
    log(`provision ${name}`, { status: r.status, browser: r.json.computer?.browser, desktop: r.json.computer?.desktop, error: r.json.error }, Date.now() - t);
  }
  await waitFor("both online", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"));
  log("capabilities (real browser executors present)", (await list()).map((c) => ({ name: c.name, browser: c.browser, viewer: c.viewer, caps: c.capabilities })));

  // C. Each computer drives its OWN browser to a different public page, verified by the page's real title.
  const t1 = Date.now();
  const [ra, rb] = await Promise.all([
    runJob("research", [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }, { executor: "observe.page" }], "researcher"),
    runJob("builder", [{ executor: "browser.navigate", args: { url: "https://www.wikipedia.org", expectTitle: "Wikipedia" }, timeoutMs: 60000 }, { executor: "observe.page" }], "builder-agent"),
  ]);
  log("two computers, two browsers, two pages", { wallMs: Date.now() - t1, research: ra.started ? { state: ra.job.state, steps: lines(ra.job) } : ra, builder: rb.started ? { state: rb.job.state, steps: lines(rb.job) } : rb });
  for (const name of ["research", "builder"]) {
    const shot = await page.evaluate(async (n) => {
      const res = await fetch(`/__computers/${n}/screenshot`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, type: res.headers.get("content-type"), bytes: buf.length, jpegMagic: buf[0] === 0xff && buf[1] === 0xd8 };
    }, name);
    log(`snapshot of ${name}'s browser (in memory, never on disk)`, shot);
  }

  // D. The hub-side goal loop.
  const host = (await call("GET", "/host")).json;
  if (host.goalLoop) {
    const g = await runJob("research", [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }, { executor: "goal", args: { goal: "open the Learn more link" } }], "goal-agent");
    log("goal loop with real Jev on the hub and a real headless browser", g.started ? { state: g.job.state, note: g.job.note, steps: lines(g.job) } : g);
  } else {
    const g = await call("POST", "/research/jobs", { steps: [{ executor: "goal", args: { goal: "open the Learn more link" } }] });
    log("goal loop: this hub holds no Jev key, so it is refused up front (the loop is proven against a DevTools-shaped test server and scripted Jev)", { status: g.status, error: g.json.error });
  }

  // E. Files persist: across a computer restart and a hub restart.
  const w = await runJob("research", [{ executor: "file.write", args: { name: "persist.txt", text: "written before the restarts" } }]);
  log("file written by a job", { state: w.started ? w.job.state : w });
  const tr = Date.now();
  await call("POST", "/research/action", { action: "stop" });
  log("computer stopped", { state: (await view("research")).state });
  await call("POST", "/research/action", { action: "start" });
  await waitFor("research online", async () => (await view("research"))?.state === "online");
  const r1 = await runJob("research", [{ executor: "file.read", args: { name: "persist.txt" } }]);
  log("after the COMPUTER restart", { restartMs: Date.now() - tr, state: r1.started ? r1.job.state : r1, read: r1.started ? lines(r1.job)[0] : null });

  const navAfter = await runJob("research", [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }]);
  log("the restarted computer still drives its browser", { state: navAfter.started ? navAfter.job.state : navAfter, step: navAfter.started ? lines(navAfter.job)[0] : null, browserEnvSet: (await wsl('tr "\0" "\n" < /proc/$(cut -d" " -f1 "$HOME/mu-computers/research/run/companion.pid")/environ | grep -c "^MU_CHROMIUM="')).trim() });
  browser = await (async () => (await browser!.close(), null))();
  const pidOld = hub?.pid;
  stopHub();
  log("hub stopped (by PID)", { pid: pidOld, listening: await fetch(`${hubUrl}/__health`).then(() => true, () => false) });
  console.log(`hub pid ${startHub()}`);
  await hubReady();
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  await session();
  const recovered = await waitFor("the computers to come back under the new hub", async () => {
    const l = await list();
    return l.length === 2 && l.every((c) => c.state === "online") ? l : null;
  }, 120_000);
  log("after the HUB restart: remembered and reconnected", recovered.map((c: any) => ({ name: c.name, state: c.state, id: c.id })));
  const r2 = await runJob("research", [{ executor: "file.read", args: { name: "persist.txt" } }, { executor: "file.list" }]);
  log("the file is still there after the hub restart", { state: r2.started ? r2.job.state : r2, steps: r2.started ? lines(r2.job) : null });

  // F. Jarvis, through the one command path (the real /__operator/screen/command route).
  const say = async (utterance: string) => {
    const r = await call("POST", "/command", { utterance, source: "typed" }, "/__operator/screen");
    return r;
  };
  const a = await say("use the research computer to go to example.com and check the title is Example Domain");
  log("Jarvis: use the research computer to ...", { status: a.status, said: a.json.said ?? a.json.done?.said, jobId: a.json.jobId ?? a.json.done?.jobId });
  const jid = a.json.jobId ?? a.json.done?.jobId;
  if (jid) {
    await waitFor("the Jarvis job", async () => settled((await job(jid))?.state ?? ""), 90_000);
    const j = await job(jid);
    log("the job Jarvis started", { state: j.state, computer: j.computer, agent: j.agent, steps: lines(j) });
  }
  const show = await say("show me the research bot");
  log("Jarvis: show me the research bot", { status: show.status, said: show.json.said ?? show.json.done?.said, navigate: show.json.navigate ?? show.json.done?.navigate });
  const cont = await say("continue that job on its cloud computer");
  log("Jarvis: continue that job on its cloud computer (ended: not re-run)", { status: cont.status, said: cont.json.said ?? cont.json.done?.said });
  const ghost = await say("use the nosuch cloud computer to open example.com");
  log("Jarvis: a computer that doesn't exist is refused by name", { status: ghost.status, said: ghost.json.said ?? ghost.json.done?.said });

  // G. Resource use and teardown.
  log("resource use (measured inside WSL, browser running)", (await list()).map((c: any) => ({ name: c.name, resource: c.resource })));
  for (const name of ["research", "builder"]) log(`destroy ${name}`, { status: (await call("POST", `/${name}/action`, { action: "destroy" })).status });
  log("WSL left clean", (await wsl('rm -rf "$HOME/mu-computers"; pgrep -fa "companion.mjs|chrome-headless" | grep -v pgrep | head -3; echo cleaned')).split("\n"));
}

main()
  .catch((e) => log("FAILED", String(e?.message ?? e)))
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    stopHub();
    writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    await sleep(1500);
    try {
      rmSync(data, { recursive: true, force: true });
    } catch {
      /* a straggler still holds a file; it is scratch */
    }
  });

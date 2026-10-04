#!/usr/bin/env bun
/**
 * Round 4 evidence: bounded research goals run END TO END on a real bot computer (Kali WSL, own Xvfb display, own Chromium profile) through the
 * real hub path: a typed command ("use the r4-research computer to ...") -> job linked to the person's Jarvis conversation -> the hub-side research
 * loop (Jev on the hub, SearXNG, a connected free model) -> the computer opens public pages and reads them -> a cited report is saved on the
 * computer and appended to the conversation by the server.
 *
 * Own hub instance from THIS worktree on its own port with its own data folder; the live hub (8081) and its computers are never touched. One computer
 * (the limit is two), stopped by the hub's own API ("destroy"), which stops only processes carrying that computer's MU_COMPUTER_KEY. Nothing is
 * submitted, signed in, bought or posted on any page: the computer only opens public addresses and reads them.
 *
 *   bun scripts/computers/research-bench.ts --out D:\prog-scratch\r4 [--port 8131] [--goals 7]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\r4");
const port = Number(arg("port", "8131"));
const distro = arg("distro", "kali-linux");
const data = join(out, "hubdata");
const want = Number(arg("goals", "8"));
const NAME = "r4-research";
const HOME_DIR = "/home/ryzen/mu-computers-r4";
const repo = resolve(import.meta.dir, "..", "..");
const hubUrl = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });

const GOALS = [
  "find the official NSW Fair Trading page on home building licences and summarise the licence classes with citations",
  "find the official NSW Fair Trading page on rental bonds and summarise the maximum bond a landlord can ask for and where it must be lodged, with citations",
  "find the official Service NSW page on the Digital Driver Licence and summarise who can get one and how it is added to a phone, with citations",
  "research what the Australian Cyber Security Centre's Essential Eight is and summarise the eight mitigation strategies, with citations",
  "find the official NSW Government page on the Working With Children Check and summarise who needs one and how long it lasts, with citations",
  "find the official Australian Business Register page on who can get an ABN and summarise the eligibility rules, with citations",
  "find the official Fair Work Ombudsman page on the national minimum wage and summarise the current rate and who it covers, with citations",
  "find the official Australian Passport Office page on how long an adult passport lasts and summarise the validity period and standard processing time, with citations",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (step: string, d: unknown) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}: ${JSON.stringify(d).slice(0, 900)}`);
let hub: ChildProcess | null = null;
function startHub() {
  const fd = openSync(join(out, "hub.log"), "a");
  hub = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo, stdio: ["ignore", fd, fd], windowsHide: true,
    env: { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off", MU_COMPUTERS_WSL_DISTRO: distro, MU_COMPUTERS_HOME: HOME_DIR, WSLENV: "MU_COMPUTERS_HOME", MU_COMPUTERS_DISPLAY_BASE: "151", MU_COMPUTERS_MONITOR_MS: "10000" },
  });
  return hub.pid!;
}
function stopHub() {
  if (hub?.pid) spawnSync("taskkill", ["/PID", String(hub.pid), "/T", "/F"], { windowsHide: true });
  hub = null;
}
async function hubReady(ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`${hubUrl}/__health`);
      return;
    } catch {
      await sleep(600);
    }
  }
  throw new Error("the hub did not start");
}

let page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launchPersistentContext>>["newPage"]>>;
let token = "";
const call = (method: string, path: string, body?: unknown, prefix = "/__computers") =>
  page.evaluate(
    async ([m, p, b, t, pre]) => {
      const res = await fetch(`${pre}${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 4000) };
      }
      return { status: res.status, json };
    },
    [method, path, body ?? null, token, prefix] as [string, string, unknown, string, string],
  ) as Promise<{ status: number; json: any }>;
const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);

type Row = { n: number; goal: string; jobState: string; outcome: string; wallS: number; note: string; steps: number; facts: number; sources: number; jevDecisions: number; jevConfidence: string; delegated: number; modelCalls: number; byRule: number; estCostUsd: number; hosts: string[]; reportInConversation: boolean; conversationParts: number; reportChars: number; reportSample: string; stepsTrace: string[] };
const rows: Row[] = [];

async function main() {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const free = await fetch(`${hubUrl}/__health`).then(() => false, () => true);
  if (!free) throw new Error(`port ${port} is in use; not touching it`);
  log("hub pid", startHub());
  await hubReady();
  const browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`${hubUrl}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  const host = await call("GET", "/host");
  log("host check", { adapters: (host.json.adapters ?? []).map((a: any) => ({ kind: a.kind, ok: a.check?.ok, missing: a.check?.missing })) });

  const made = await call("POST", "/", { name: NAME });
  log("provision (one computer; the limit is two)", { status: made.status, error: made.json.error });
  if (made.status !== 200) throw new Error("provision failed");
  const end = Date.now() + 120_000;
  let view: any;
  while (Date.now() < end) {
    view = ((await call("GET", "/")).json.computers as any[]).find((c) => c.name === NAME);
    if (view?.state === "online") break;
    await sleep(700);
  }
  log("computer", { state: view?.state, desktop: view?.desktop, display: view?.display, caps: view?.capabilities });

  for (let n = 0; n < want; n++) {
    const goal = GOALS[n % GOALS.length];
    const t0 = Date.now();
    // The real entry: a typed command to the one Jarvis command service; it links the job to Usman's conversation and the server appends the result.
    const cmd = await page.evaluate(
      async ([utterance, tk]) => {
        const res = await fetch("/__operator/screen/command", { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": tk as string }, body: JSON.stringify({ utterance, source: "typed", eventId: `r4:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` }) });
        const text = await res.text();
        return { status: res.status, lines: text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } }) };
      },
      [`use the ${NAME} computer to ${goal}`, token] as [string, string],
    );
    const done = cmd.lines.find((l: any) => l.type === "done");
    const jobId: string | undefined = done?.jobId ?? cmd.lines.find((l: any) => l.type === "job")?.jobId;
    log(`goal ${n + 1} started`, { goal: goal.slice(0, 80), status: cmd.status, ok: done?.ok, said: String(done?.said ?? "").slice(0, 160), jobId: jobId?.slice(0, 8) });
    if (!jobId) {
      rows.push({ n: n + 1, goal, jobState: "not-started", outcome: "failed", wallS: 0, note: String(done?.said ?? "no job").slice(0, 200), steps: 0, facts: 0, sources: 0, jevDecisions: 0, jevConfidence: "", delegated: 0, modelCalls: 0, byRule: 0, estCostUsd: 0, hosts: [], reportInConversation: false, conversationParts: 0, reportChars: 0, reportSample: "", stepsTrace: [] });
      continue;
    }
    let job: any;
    const limit = Date.now() + 12 * 60_000;
    while (Date.now() < limit) {
      job = (await call("GET", `/jobs/${jobId}`)).json.job ?? (await call("GET", `/jobs/${jobId}`)).json;
      if (settled(job?.state ?? "")) break;
      await sleep(2000);
    }
    const wallS = Math.round((Date.now() - t0) / 100) / 10;
    const steps: any[] = job?.steps ?? [];
    const trace = steps.map((s) => `${s.outcome}|${s.executor}|${String(s.intent).slice(0, 200)}`);
    const summary = steps.find((s) => /^research (complete|partial):/.test(s.intent))?.intent ?? "";
    const final = steps.findLast?.((s: any) => /^research (complete|partial|failed|stopped):/.test(s.intent))?.intent ?? "";
    const num = (re: RegExp) => Number(re.exec(summary)?.[1] ?? 0);
    const confs = steps.map((s) => s.jev).filter((j) => j && j.op && j.policy);
    const jevConf = [...summary.matchAll(/\((\d+)-(\d+)% sure\)/g)][0];
    await sleep(1500);
    const convs = (await call("GET", "/conversations", undefined, "/__operator")).json.conversations as any[] | undefined;
    const thread = (convs ?? []).find((c) => (c.jobs ?? []).some((j: any) => j.jobId === jobId));
    const reportMsgs = (thread?.messages ?? []).filter((m: any) => String(m.via ?? "").startsWith(`job:${jobId}:report`));
    const reportText = reportMsgs.map((m: any) => m.text).join("\n");
    const row: Row = {
      n: n + 1, goal, jobState: job?.state ?? "unknown",
      outcome: /^research complete/.test(final) ? "complete" : /^research partial/.test(final) ? "partial" : job?.state === "succeeded" ? "complete" : "failed",
      wallS, note: String(job?.note ?? "").slice(0, 200), steps: steps.length,
      facts: num(/(\d+) cited facts/), sources: num(/from (\d+) source/), jevDecisions: confs.filter((j) => j.policy === "act").length + confs.filter((j) => j.policy === "delegate" || j.policy === "rule").length,
      jevConfidence: jevConf ? `${jevConf[1]}-${jevConf[2]}%` : "", delegated: num(/; (\d+) handed to a connected model/), modelCalls: num(/; (\d+) model calls?/), byRule: num(/; (\d+) by rule/), estCostUsd: Number(/est\. cost US\$([\d.]+)/.exec(summary)?.[1] ?? 0),
      hosts: [...new Set(steps.map((s) => /read ([a-z0-9.-]+):/.exec(s.intent)?.[1]).filter(Boolean) as string[])],
      reportInConversation: reportMsgs.length > 0, conversationParts: reportMsgs.length, reportChars: reportText.length, reportSample: reportText.slice(0, 1800), stepsTrace: trace,
    };
    rows.push(row);
    log(`goal ${n + 1} finished`, { state: row.jobState, outcome: row.outcome, wallS, facts: row.facts, sources: row.sources, hosts: row.hosts, delegated: row.delegated, modelCalls: row.modelCalls, byRule: row.byRule, jev: row.jevConfidence, inConversation: row.reportInConversation });
    writeFileSync(join(out, "research-results.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
    await sleep(3000);
  }
  const destroyed = await call("POST", `/${NAME}/action`, { action: "destroy" });
  log("destroy (stops only this computer's own processes)", { status: destroyed.status });
  await browser.close();
}

main()
  .catch((e) => log("FAILED", String((e as Error)?.stack ?? e).slice(0, 700)))
  .finally(async () => {
    const pid = hub?.pid;
    stopHub();
    await sleep(1500);
    log("hub stopped by PID", { pid, stillListening: await fetch(`${hubUrl}/__health`).then(() => true, () => false) });
    writeFileSync(join(out, "research-results.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
    try {
      readFileSync(join(out, "hub.log"));
    } catch {
      /* none */
    }
    process.exit(0);
  });

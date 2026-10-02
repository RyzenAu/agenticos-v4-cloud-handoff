#!/usr/bin/env bun
/**
 * Real-host journey for the bot-computer WORKFLOWS (programme 20261001, round 6). A separate TEST hub (scripts/computers/r6-hub.ps1, port 8153, synthetic
 * data folder on D:) drives the real Ryzen-PC (WSL2 kali-linux, over SSH) through the same adapter round 5 used. It is driven through a real browser session
 * and the real command route (the same words a person types or says), reads the host only through `ssh <alias> wsl.exe ... --exec` (read-only commands,
 * plus the explicit teardown), and prints evidence. It NEVER prints a key, token, cookie value, pairing code or environment value.
 *
 *   bun scripts/computers/journey-r6.ts --phase up
 *   bun scripts/computers/journey-r6.ts --phase workflows     each workflow, by its spoken phrase, from the conversation
 *   bun scripts/computers/journey-r6.ts --phase concurrent    Research and Builder at once, no cross-talk
 *   bun scripts/computers/journey-r6.ts --phase control       takeover and hand-back, Stop
 *   bun scripts/computers/journey-r6.ts --phase reconnect     the tunnel killed while a job runs
 *   bun scripts/computers/journey-r6.ts --phase restart       the hub killed mid-job and started again
 *   bun scripts/computers/journey-r6.ts --phase rendered      the conversation and the saved results, rendered at 1440 and 390
 *   bun scripts/computers/journey-r6.ts --phase teardown
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const phaseName = arg("phase", "up");
const hubUrl = arg("hub", "http://127.0.0.1:8153");
const out = arg("out", "D:\\AgenticOS-r6-data\\out");
const alias = arg("alias", "ryzen-bots");
const distro = arg("distro", "kali-linux");
const scratch = arg("scratch", "D:\\AgenticOS-r6-data");
const SSH = "C:/Windows/System32/OpenSSH/ssh.exe";
const A = "research";
const B = "builder";
const BASE = "/var/lib/mu-computers";
const repo = resolve(import.meta.dir, "..", "..");
if (/:8081\b/.test(hubUrl)) throw new Error("not the live hub");
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; ms?: number; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, d: unknown, ms?: number) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, ...(ms !== undefined ? { ms } : {}), data: d });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${ms !== undefined ? ` (${ms} ms)` : ""}: ${JSON.stringify(d).slice(0, 1500)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statePath = join(out, "r6-state.json");
const readState = (): Record<string, any> => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});
const saveState = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...readState(), ...patch }, null, 2));
const flush = () => writeFileSync(join(out, `r6-evidence-${phaseName}.json`), JSON.stringify(evidence, null, 2));

/** A read-only shell command inside Ryzen's WSL (script on stdin; nothing rides the command line). */
async function wsl(command: string, timeoutMs = 60_000) {
  const r = await defaultRunner([SSH, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", alias, "wsl.exe", "-d", distro, "-u", "root", "--exec", "bash", "-s"], { stdin: command, timeoutMs });
  return (r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : "")).trim();
}
function hubCtl(action: "start" | "stop" | "kill") {
  // stdio "ignore": the hub it starts must not inherit a pipe this call would then wait on for ever.
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "computers", "r6-hub.ps1"), action], { stdio: "ignore", windowsHide: true });
  return `r6-hub.ps1 ${action}: exit ${r.status}`;
}
async function hubReady(ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${hubUrl}/__health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok || r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("the hub did not come back");
}

// ---- hub API through the confirmed browser session ------------------------------------------------------------------------------------
let ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
let page!: Page;
let token = "";
async function session() {
  ctx = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true, reducedMotion: "reduce" });
  page = ctx.pages()[0] ?? (await ctx.newPage());
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
      return { status: res.status, json, text: text.slice(0, 6000), bytes: text.length };
    },
    [method, path, body ?? null, token, prefix] as unknown[] as [string, string, unknown, string, string],
  ) as Promise<{ status: number; json: any; text: string; bytes: number }>;
const call = async (method: string, path: string, body?: unknown, prefix = "/__computers") => {
  let r = await rawCall(method, path, body, prefix);
  if (r.status === 403 && /Refresh this page/.test(String(r.json?.error))) {
    token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
    r = await rawCall(method, path, body, prefix);
  }
  return r;
};
const list = async () => ((await call("GET", "/")).json.computers as any[]) ?? [];
const view = async (n: string) => (await list()).find((c) => c.name === n);
const waitFor = async <T>(what: string, fn: () => Promise<T>, ms = 90_000, every = 300): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
};
const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);
const job = async (id: string) => (await call("GET", `/jobs/${id}`)).json.job as any;
/** The words a person types or says, through the real command route (the same one the chat uses). */
const say = (utterance: string, eventId?: string) => call("POST", "/screen/command", { utterance, source: "typed", ...(eventId ? { eventId } : {}) }, "/__operator");
const artifacts = async () => ((await call("GET", "/artifacts")).json.artifacts as any[]) ?? [];
const thread = async () => {
  const r = await call("GET", "/conversations", undefined, "/__operator");
  const c = (r.json.conversations as any[] | undefined)?.find((x) => x.thread === "jarvis") ?? null;
  return { status: r.status, conv: c };
};
const entriesFor = async (jobId: string): Promise<{ via: string; text: string }[]> => {
  const { conv } = await thread();
  const msgs = (conv?.messages ?? []) as { via?: string; text: string }[];
  return msgs.filter((m) => typeof m.via === "string" && m.via.includes(jobId)).map((m) => ({ via: m.via!, text: m.text }));
};
const lines = (j: any) => (j.steps ?? []).map((s: any) => `${s.outcome} ${s.action ?? s.executor}: ${String(s.intent).slice(0, 110)}`);
/** The job id out of the acknowledgement (the command's reply carries `jobId`). */
const jobOf = (r: { json: any }) => String(r.json?.jobId ?? r.json?.done?.jobId ?? (/"jobId":"([0-9a-f-]{36})"/.exec(JSON.stringify(r.json))?.[1] ?? ""));
async function shot(url: string, file: string, width: number, height: number) {
  const p = await ctx!.newPage();
  await p.setViewportSize({ width, height });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: join(out, file) });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  await p.close();
  return { file, width, overflowX: overflow };
}
const INSPECT = (names: string[]) => `
python3 - <<'PY'
import json, os, re, subprocess
base = "${BASE}"
out = {}
for n in ${JSON.stringify(names)}:
    d = base + "/" + n
    try:
        full = json.load(open(d + "/cfg/computer.json"))
        cfg = {k: full[k] for k in ("name", "display", "resolution", "vncPort", "browserPort", "workdir") if k in full}
    except Exception as e:
        cfg = {"error": str(e)}
    out[n] = {"cfg": cfg, "work": sorted(os.listdir(d + "/work")) if os.path.isdir(d + "/work") else None}
ps = subprocess.run(["ps", "-eo", "pid=,etimes=,args="], capture_output=True, text=True).stdout.splitlines()
out["counts"] = {"companion": len([l for l in ps if "companion.mjs" in l and "run --config" in l]), "xvfb": len([l for l in ps if re.search(r" Xvfb :", l)]), "x11vnc": len([l for l in ps if "x11vnc" in l and "-display" in l]), "browserMain": len([l for l in ps if "--user-data-dir=" in l and "mu-computers" in l and "--type=" not in l and "crashpad" not in l]), "git": len([l for l in ps if re.search(r"\\bgit\\b", l) and "grep" not in l])}
print(json.dumps(out))
PY`;
const processCounts = async () => JSON.parse(await wsl(INSPECT([A, B])));
const cdpTabs = (port: number) => wsl(`curl -s http://127.0.0.1:${port}/json/list | python3 -c "import json,sys; print(json.dumps([{'t':x['title'][:50],'u':x['url'][:70]} for x in json.load(sys.stdin) if x['type']=='page']))"`);

async function main() {
  const me = await session();
  log("hub up; real browser session", { person: me.person?.id, actor: me.principal?.actor, hub: hubUrl });
  const phases: Record<string, () => Promise<void>> = { up, workflows, research, concurrent, control, reconnect, restart, rendered, teardown };
  if (!phases[phaseName]) throw new Error("unknown phase");
  try {
    await phases[phaseName]();
  } finally {
    flush();
    await ctx?.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------
async function up() {
  const host = (await call("GET", "/host")).json;
  log("host check", host.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, host: a.check.host, present: a.check.present, missing: a.check.missing, notes: a.check.notes })));
  for (const c of await list()) log(`reset: removing old ${c.name}`, { status: (await call("POST", `/${c.name}/action`, { action: "destroy" })).status });
  const tp = Date.now();
  const pa = await call("POST", "/", { name: A, adapter: "vps-ssh", label: "Research" });
  const pb = await call("POST", "/", { name: B, adapter: "vps-ssh", label: "Builder" });
  log("provision Research and Builder on Ryzen", { wallMs: Date.now() - tp, a: { status: pa.status, adapter: pa.json.computer?.adapter, err: pa.json.error }, b: { status: pb.status, adapter: pb.json.computer?.adapter, err: pb.json.error } });
  await waitFor("both online", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"));
  const cs = await list();
  log("both online", cs.map((c) => ({ name: c.name, adapter: c.adapter, state: c.state, desktop: c.desktop, viewer: c.viewer, caps: c.capabilities })));
  const needed = ["build.component", "file.chunk", "page.audit", "page.links", "fixture.open", "page.text", "browser.navigate", "file.write"];
  log("the companion bundle on Ryzen carries the workflow executors", { missing: needed.filter((n) => !(cs[0].capabilities ?? []).includes(n)) });
  log("workflows available on this hub", (await call("GET", "/host")).json.goalLoop);
  const insp = JSON.parse(await wsl(INSPECT([A, B])));
  log("ISOLATION: separate display, VNC port, DevTools port, work folder; one shared Kali environment", { [A]: insp[A], [B]: insp[B], counts: insp.counts });
  saveState({ upAt: new Date().toISOString() });
}

type Run = { name: string; phrase: string; computer: string; jobId: string; state: string; ms: number; steps: number; artifact: any; entries: string[]; lines: string[]; ack: string };
async function runPhrase(name: string, phrase: string, computer: string, timeoutMs = 360_000): Promise<Run> {
  const t = Date.now();
  const r = await say(phrase);
  const jobId = jobOf(r);
  const ack = String(r.json?.said ?? r.text).slice(0, 260);
  if (!jobId) {
    log(`${name}: the command did not start a job`, { status: r.status, text: r.text.slice(0, 300) });
    return { name, phrase, computer, jobId: "", state: "not started", ms: Date.now() - t, steps: 0, artifact: null, entries: [], lines: [], ack };
  }
  const j = await waitFor(`${name} to end`, async () => (settled((await job(jobId))?.state ?? "") ? await job(jobId) : null), timeoutMs, 1000);
  const ms = Date.now() - t;
  await sleep(1500); // the watcher appends the end after the state change
  const art = (await artifacts()).find((a) => a.id === jobId) ?? null;
  const ents = (await entriesFor(jobId)).map((e) => `${e.via.split(":").slice(-2).join(":")} | ${e.text.replace(/\s+/g, " ").slice(0, 200)}`);
  const run: Run = { name, phrase, computer, jobId, state: j.state, ms, steps: j.steps.length, artifact: art && { id: art.id, title: art.title, outcome: art.outcome, host: art.host, computer: art.computer, main: art.main, files: art.files.map((f: any) => `${f.name} ${f.bytes}`) }, entries: ents, lines: lines(j), ack };
  log(`${name}: ${j.state} in ${(ms / 1000).toFixed(1)} s`, { jobId: jobId.slice(0, 8), ack, note: j.note, steps: j.steps.length, artifact: run.artifact, entries: ents });
  if (j.state !== "succeeded" || /research/.test(name)) log(`${name}: the job's own steps`, run.lines);
  return run;
}
async function saveArtifactCopies(run: Run, label: string) {
  if (!run.artifact) return;
  for (const f of run.artifact.files as string[]) {
    const nm = f.split(" ")[0];
    if (!/\.(md|json|diff|html|csv|jpg)$/.test(nm)) continue;
    const r = await page.evaluate(async ([id, name]) => {
      const res = await fetch(`/__computers/artifacts/${id}/f/${encodeURIComponent(name)}`);
      const b = new Uint8Array(await res.arrayBuffer());
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { status: res.status, csp: res.headers.get("content-security-policy"), b64: btoa(s) };
    }, [run.jobId, nm]);
    if (r.status === 200) {
      mkdirSync(join(out, "artifacts", label), { recursive: true });
      writeFileSync(join(out, "artifacts", label, nm), Buffer.from(r.b64, "base64"));
    }
  }
}

async function workflows() {
  const runs: Run[] = [];
  const before = await artifacts();
  // 1 Research: the R5 Canberra goal, whose second item (population) was never found; the completeness check must find it or say so.
  const w1 = await runPhrase("research (Canberra, two items)", `Use the Research computer to research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.`, A);
  runs.push(w1);
  await saveArtifactCopies(w1, "research");
  // 2 Builder
  const w2 = await runPhrase("builder (opening hours component)", `Use the Builder computer to build an opening hours component for the clinic site`, B);
  runs.push(w2);
  await saveArtifactCopies(w2, "builder");
  // 3 Website audit, M&U's own public demo site, then the local fixture
  const w3 = await runPhrase("audit (dental-care-plus.muventures.com.au)", `Use the Research computer to audit https://dental-care-plus.muventures.com.au`, A);
  runs.push(w3);
  await saveArtifactCopies(w3, "audit-dental");
  const w3b = await runPhrase("audit (local fixture)", `Use the Research computer to audit the demo clinic fixture`, A);
  runs.push(w3b);
  await saveArtifactCopies(w3b, "audit-fixture");
  // 4 Business preparation
  const w4 = await runPhrase("bizprep (comparison table, synthetic)", `Use the Builder computer to prepare a comparison table of three website packages`, B);
  runs.push(w4);
  await saveArtifactCopies(w4, "bizprep");
  // and the refusals: an unauthorised site and Brooke's site are refused before anything is opened
  for (const url of ["https://example.com", "https://brooke.muventures.com.au"]) {
    const r = await say(`Use the Research computer to audit ${url}`);
    log(`refused audit: ${url}`, { status: r.status, said: String(r.json?.said ?? r.text).slice(0, 220), jobId: jobOf(r) || null });
  }
  const after = await artifacts();
  log("artifacts now", { before: before.length, after: after.length, list: after.map((a) => `${a.kind}: ${a.title.slice(0, 50)} (${a.outcome}; ${a.host.slice(0, 40)})`) });
  // every saved result opens from the hub: the page and a file of it
  for (const run of runs.filter((x) => x.artifact)) {
    const p = await call("GET", `/artifacts/${run.jobId}`);
    log(`${run.name}: the saved result opens from the OS route`, { status: p.status, bytes: p.bytes, title: /<h1>([^<]*)<\/h1>/.exec(p.text)?.[1] ?? null });
  }
  saveState({ workflowRuns: runs.map((r) => ({ name: r.name, jobId: r.jobId, state: r.state, ms: r.ms })) });
  log("summary", runs.map((r) => ({ name: r.name, state: r.state, ms: r.ms, steps: r.steps, artifact: r.artifact?.title ?? null, completion: r.entries.filter((e) => /succeeded|failed|cancelled|unknown/.test(e.split("|")[0])).length })));
}

/** The research workflow alone, on the goal round 5 never finished (the population figure), and one whose answer is not on the web at all. */
async function research() {
  const w1 = await runPhrase("research (Canberra, two items)", "Use the Research computer to research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.", A);
  await saveArtifactCopies(w1, "research-canberra");
  const w2 = await runPhrase("research (a fact that is not on the web)", "Use the Research computer to research: Find the exact number of pigeons that landed on the Sydney Harbour Bridge on 14 March 2019, and the Australian Museum's opening hours.", A);
  await saveArtifactCopies(w2, "research-missing");
  log("research completeness", { canberra: { state: w1.state, artifact: w1.artifact?.outcome }, notOnTheWeb: { state: w2.state, artifact: w2.artifact?.outcome } });
}

async function concurrent() {
  const t = Date.now();
  const before = await processCounts();
  const [r1, r2] = await Promise.all([
    say(`Use the Research computer to research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.`),
    say(`Use the Builder computer to update the pricing card to show the price including GST`),
  ]);
  const ja = jobOf(r1);
  const jb = jobOf(r2);
  log("two jobs started at once", { research: ja.slice(0, 8), builder: jb.slice(0, 8), ackA: String(r1.json?.said).slice(0, 120), ackB: String(r2.json?.said).slice(0, 120) });
  // sample each computer's own tabs and files while both run
  const samples: any[] = [];
  const end = Date.now() + 240_000;
  const insp0 = JSON.parse(await wsl(INSPECT([A, B])));
  const portA = Number(insp0[A].cfg.browserPort);
  const portB = Number(insp0[B].cfg.browserPort);
  while (Date.now() < end) {
    const [sa, sb] = [await job(ja), await job(jb)];
    const i = JSON.parse(await wsl(INSPECT([A, B])));
    samples.push({ t: ((Date.now() - t) / 1000).toFixed(0), A: { state: sa.state, work: i[A].work }, B: { state: sb.state, work: i[B].work } });
    if (settled(sa.state) && settled(sb.state)) break;
    await sleep(2500);
  }
  const [ra, rb] = [await job(ja), await job(jb)];
  await sleep(1500);
  const tabsA = await cdpTabs(portA);
  const tabsB = await cdpTabs(portB);
  const insp = JSON.parse(await wsl(INSPECT([A, B])));
  const aWork = insp[A].work as string[];
  const bWork = insp[B].work as string[];
  log("both finished", { wallMs: Date.now() - t, research: ra.state, builder: rb.state });
  log("NO CROSS-TALK: each computer holds only its own files and tabs", {
    researchFiles: aWork.filter((f) => !f.endsWith(".tmp")), builderFiles: bWork.filter((f) => !f.endsWith(".tmp")), researchTabs: tabsA, builderTabs: tabsB,
    researchHasBuilderFiles: aWork.some((f) => /^wt-|^repo$|^preview-|^change-/.test(f)), builderHasAuditFiles: bWork.some((f) => /^shot-(home|contact|services)|^index\.html$|^contact\.html$/.test(f)),
  });
  const arts = await artifacts();
  log("each result is its own artifact", { research: arts.find((a) => a.id === ja)?.title, builder: arts.find((a) => a.id === jb)?.title });
  const ea = await entriesFor(ja);
  const eb = await entriesFor(jb);
  log("the conversation: each job has exactly one result entry and one end entry", {
    research: { report: ea.filter((e) => e.via.endsWith(":report:1")).length, ended: ea.filter((e) => /:(succeeded|failed|cancelled|unknown|interrupted)$/.test(e.via)).length },
    builder: { report: eb.filter((e) => e.via.endsWith(":report:1")).length, ended: eb.filter((e) => /:(succeeded|failed|cancelled|unknown|interrupted)$/.test(e.via)).length },
  });
  log("process counts on Ryzen (before / after)", { before: before.counts, after: insp.counts });
  saveState({ concurrent: { ja, jb } });
}

async function control() {
  // Takeover and hand-back on a running workflow (the audit of the real demo site: several moves, each a safe boundary).
  const r = await say(`Use the Research computer to audit https://dental-care-plus.muventures.com.au`);
  const j = jobOf(r);
  log("audit started", { job: j.slice(0, 8) });
  await waitFor("the audit to be running with a few steps", async () => ((await job(j))?.steps?.length ?? 0) >= 3, 90_000, 400);
  const noLease = await call("POST", `/${A}/input`, { executor: "file.write", args: { name: "nolease.txt", text: "x" } });
  log("input without the control lease is refused", { status: noLease.status, error: noLease.json.error });
  const take = await call("POST", `/${A}/takeover`, {});
  log("takeover requested mid-job", { status: take.status, state: take.json.state, via: take.json.status });
  await waitFor("the agent to pause and a person to hold the computer", async () => (await view(A))?.controller?.kind === "person", 90_000, 300);
  const v1 = await view(A);
  const stepsAtPause = (await job(j)).steps.length;
  log("person holds it; the job is paused, not finished, nothing new runs", { controller: v1.controller, jobState: (await job(j)).state, steps: stepsAtPause });
  await sleep(6000);
  const stepsLater = (await job(j)).steps.length;
  const human = await call("POST", `/${A}/input`, { executor: "file.write", args: { name: "human.txt", text: "written by a person during the takeover" } });
  log("the person acts while holding the computer", { status: human.status, jobStillRunning: (await job(j)).state, stepsAtPause, stepsAfter6s: stepsLater, noReplayWhilePaused: stepsLater === stepsAtPause || stepsLater <= stepsAtPause + 1 });
  const ent1 = await entriesFor(j);
  log("the conversation said so", ent1.filter((e) => /Paused:|Resumed:/.test(e.text)).map((e) => e.text.slice(0, 140)));
  const back = await call("POST", `/${A}/return`, {});
  log("handed back to the agent", { status: back.status });
  const done = await waitFor("the job to end", async () => (settled((await job(j)).state) ? await job(j) : null), 300_000, 1000);
  await sleep(1500);
  const ent2 = await entriesFor(j);
  const art = (await artifacts()).find((a) => a.id === j);
  log("job resumed (page re-read first) and finished", { state: done.state, resumedAfterReturn: lines(done).filter((l: string) => /control returned|refreshed state/.test(l)), artifact: art?.title ?? null, results: ent2.filter((e) => e.via.endsWith(":report:1")).length, ends: ent2.filter((e) => /:(succeeded|failed|cancelled|unknown)$/.test(e.via)).length });

  // Stop: a workflow cancelled mid-run, and a force-stopped computer. Nothing runs afterwards.
  const r2 = await say(`Use the Research computer to audit the demo clinic fixture`);
  const j2 = jobOf(r2);
  await waitFor("the second audit to be running", async () => ((await job(j2))?.steps?.length ?? 0) >= 3, 90_000, 300);
  const c0 = Date.now();
  const stop = await say("stop that task");
  const ended = await waitFor("the audit to be cancelled", async () => (settled((await job(j2)).state) ? await job(j2) : null), 60_000, 200);
  const stepsAtStop = ended.steps.length;
  await sleep(8000);
  const after = await job(j2);
  const files = JSON.parse(await wsl(INSPECT([A, B])))[A].work as string[];
  log("STOP of a workflow: stopped, no artifact, nothing ran afterwards", { said: String(stop.json?.said).slice(0, 100), state: ended.state, msToStop: Date.now() - c0, stepsAtStop, stepsAfter8s: after.steps.length, artifact: (await artifacts()).some((a) => a.id === j2), entries: (await entriesFor(j2)).map((e) => `${e.via.split(":").slice(-1)}: ${e.text.slice(0, 70)}`), auditFilesAfter: files.filter((f) => /^shot-/.test(f)).length });
  const js = await call("POST", `/${B}/jobs`, { agent: "journey-r6", title: "will be force-stopped", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: "never.txt", text: "must not exist" } }] });
  await waitFor("the long job to run", async () => (await job(js.json.jobId))?.state === "running", 60_000, 200);
  const t1 = Date.now();
  const fs = await call("POST", `/${B}/action`, { action: "stop", force: true });
  const afterStop = await job(js.json.jobId);
  const inputAfter = await call("POST", `/${B}/input`, { executor: "file.write", args: { name: "after.txt", text: "x" } });
  const left = await processCounts();
  log("FORCE STOP of the Builder computer", { status: fs.status, ms: Date.now() - t1, jobState: afterStop.state, inputToStoppedComputer: inputAfter.status, builderWork: left[B].work, counts: left.counts });
  const st = await call("POST", `/${B}/action`, { action: "start" });
  await waitFor("builder online", async () => (await view(B))?.state === "online", 90_000, 500);
  log("Builder started again", { status: st.status, files: (await processCounts())[B].work });
}

async function reconnect() {
  // The tunnel ssh is killed while an audit runs (the one supervised reverse tunnel).
  const pidFile = join(scratch, "data", "computers", `ssh-tunnel-${alias}.pid`);
  const readPid = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "");
  const j = jobOf(await say(`Use the Research computer to audit the demo clinic fixture`));
  await waitFor("the audit to be running", async () => ((await job(j))?.steps?.length ?? 0) >= 4, 90_000, 300);
  const pid1 = readPid();
  const k = spawnSync("taskkill", ["/PID", pid1, "/F"], { encoding: "utf8", windowsHide: true });
  log("tunnel ssh killed mid-job", { pid: pid1, killed: /SUCCESS/.test(k.stdout) });
  const states: string[] = [];
  const end = Date.now() + 240_000;
  let final: any = null;
  while (Date.now() < end) {
    const jj = await job(j);
    const v = await view(A);
    states.push(`${((Date.now() - end + 240_000) / 1000).toFixed(0)}s job=${jj.state} computer=${v?.state}`);
    if (settled(jj.state)) {
      final = jj;
      break;
    }
    await sleep(2000);
  }
  await sleep(1500);
  const host = (await call("GET", "/host")).json.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, notes: a.check.notes }));
  log("what the hub said while the tunnel was down and after", { timeline: states.filter((s, i, a) => i === 0 || s.replace(/^\d+s /, "") !== a[i - 1].replace(/^\d+s /, "")), pidAfter: readPid() !== pid1 ? "a new ssh" : "same pid", hostCheck: host });
  log("the job's accurate end", { state: final?.state, note: final?.note, artifact: (await artifacts()).find((a) => a.id === j)?.title ?? null, entries: (await entriesFor(j)).map((e) => `${e.via.split(":").slice(-1)}: ${e.text.slice(0, 90)}`) });
  await waitFor("both computers online again", async () => (await list()).every((c) => c.state === "online"), 120_000, 1000);
  const next = await runPhrase("a new job after the reconnect", `Use the Research computer to audit the demo clinic fixture`, A);
  log("reconnected: a fresh job runs and its result is saved", { state: next.state, artifact: next.artifact?.title ?? null });
  const old = await artifacts();
  log("earlier artifacts still open after the tunnel drop", { count: old.length });

  // A longer outage: the tunnel ssh is killed again and again during a real research job (the backoff grows 1, 2, 5, 10 s), so the computer is cut off for tens of seconds.
  const j2 = jobOf(await say("Use the Research computer to research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is."));
  await waitFor("the research to be running", async () => ((await job(j2))?.steps?.length ?? 0) >= 6, 90_000, 300);
  const kills: string[] = [];
  const t1 = Date.now();
  const timeline: string[] = [];
  let last = "";
  let n = 0;
  let final2: any = null;
  while (Date.now() - t1 < 300_000) {
    if (n < 5 && (Date.now() - t1) / 1000 > n * 4 + 1) {
      const pid = readPid();
      const kk = spawnSync("taskkill", ["/PID", pid, "/F"], { encoding: "utf8", windowsHide: true });
      kills.push(`${((Date.now() - t1) / 1000).toFixed(0)}s pid ${pid} ${/SUCCESS/.test(kk.stdout) ? "killed" : "not killed"}`);
      n++;
    }
    const jj = await job(j2);
    const v = await view(A);
    const now = `job=${jj.state} computer=${v?.state}${v?.failure ? " (failed: " + String(v.failure.reason).slice(0, 40) + ")" : ""}`;
    if (now !== last) timeline.push(`${((Date.now() - t1) / 1000).toFixed(0)}s ${now}`);
    last = now;
    if (settled(jj.state)) {
      final2 = jj;
      break;
    }
    await sleep(1500);
  }
  await sleep(1500);
  log("LONGER OUTAGE: the tunnel killed five times during a research job", { kills, timeline, jobState: final2?.state, note: final2?.note, artifact: (await artifacts()).find((a) => a.id === j2)?.title ?? null, artifactOutcome: (await artifacts()).find((a) => a.id === j2)?.outcome ?? null, entries: (await entriesFor(j2)).map((e) => `${e.via.split(":").slice(-1)}: ${e.text.replace(/\s+/g, " ").slice(0, 100)}`) });
  log("the job's last steps", lines(final2 ?? (await job(j2))).slice(-6));
  await waitFor("both computers online again", async () => (await list()).every((c) => c.state === "online"), 180_000, 1000);
  log("computers online again after the longer outage", (await list()).map((c) => ({ name: c.name, state: c.state, recoveries: c.recoveries })));
}

async function restart() {
  const arts0 = await artifacts();
  const j = jobOf(await say(`Use the Research computer to audit the demo clinic fixture`));
  await waitFor("the audit to be running", async () => ((await job(j))?.steps?.length ?? 0) >= 4, 90_000, 300);
  const before = await job(j);
  const procBefore = await processCounts();
  log("before the hub dies", { job: j.slice(0, 8), state: before.state, steps: before.steps.length, artifactsBefore: arts0.length, counts: procBefore.counts });
  const killed = hubCtl("kill");
  log("hub killed (hard, process tree)", { out: killed });
  await sleep(4000);
  const down = await fetch(`${hubUrl}/__health`, { signal: AbortSignal.timeout(3000) }).then(() => "answers").catch(() => "down");
  log("hub is down", { health: down, ryzenCountsWhileDown: (await processCounts()).counts });
  log("hub starting again", { out: hubCtl("start") });
  await hubReady();
  await ctx?.close().catch(() => undefined);
  await session();
  const t2 = Date.now();
  await waitFor("both computers online after restart", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"), 180_000, 1000);
  log("computers back after the restart", { ms: Date.now() - t2, states: (await list()).map((c) => ({ name: c.name, state: c.state, recoveries: c.recoveries })) });
  await sleep(2500);
  const after = await job(j);
  log("the job's status afterwards is accurate: not re-run, outcome not invented", { state: after.state, note: after.note, steps: after.steps.length, stepsBefore: before.steps.length, lastStep: lines(after).slice(-2) });
  const ents = await entriesFor(j);
  log("the conversation, once", { entries: ents.map((e) => `${e.via.split(":").slice(-1)}: ${e.text.replace(/\s+/g, " ").slice(0, 110)}`), ends: ents.filter((e) => /:(succeeded|failed|cancelled|unknown|interrupted)$/.test(e.via)).length, reports: ents.filter((e) => e.via.endsWith(":report:1")).length });
  const arts1 = await artifacts();
  log("artifacts persist across the restart", { before: arts0.length, after: arts1.length, same: arts0.every((a) => arts1.some((b) => b.id === a.id)), opens: (await Promise.all(arts0.slice(0, 3).map((a) => call("GET", `/artifacts/${a.id}`)))).map((r) => r.status) });
  const next = await runPhrase("a new job after the restart", `Use the Builder computer to prepare a comparison table of three website packages`, B);
  log("a fresh job after the restart", { state: next.state, artifact: next.artifact?.title ?? null });
}

async function rendered() {
  // The conversation rendered at two widths, one live run with the page NEVER reloaded, then the user "returns" with a new page.
  const p0 = await ctx!.newPage();
  const results: any[] = [];
  for (const [width, height, tag] of [[1440, 900, "d"], [390, 844, "m"]] as const) {
    const p = await ctx!.newPage();
    await p.setViewportSize({ width, height });
    await p.goto(`${hubUrl}/chat`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3500);
    await p.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const count = (text: string) => p.evaluate((t) => document.body.innerText.split(t).length - 1, text);
    const until = async (text: string, atLeast: number, ms = 120_000) => {
      const end = Date.now() + ms;
      while ((await count(text)) < atLeast) {
        if (Date.now() > end) throw new Error(`timed out waiting for "${text}" x${atLeast}`);
        await sleep(300);
      }
    };
    const phrase = tag === "d" ? "Use the Builder computer to prepare a comparison table of three website packages" : "Use the Research computer to audit the demo clinic fixture";
    const kind = tag === "d" ? "Business preparation" : "Website audit";
    const startedBefore = await count("Started:");
    const finishedBefore = await count("Finished:");
    const stepBefore = await count(`${kind}, step 1 of 5`);
    const openBefore = await count("Open saved result");
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-0-before.png`) });
    const ack = await call("POST", "/screen/command", { utterance: phrase, source: "typed" }, "/__operator");
    await until("Started:", startedBefore + 1, 30_000);
    await p.waitForTimeout(500);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(400);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-1-started.png`) });
    await until(`${kind}, step 1 of 5`, stepBefore + 1, 90_000);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-2-progress.png`) });
    await until("Finished:", finishedBefore + 1, 180_000);
    await until("Open saved result", openBefore + 1, 20_000);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(600);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-3-finished.png`) });
    const ev = {
      width, ack: String(ack.json?.said).slice(0, 120),
      pageNeverReloaded: await p.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true && performance.getEntriesByType("navigation").length === 1),
      overflowX: await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1),
      lines: await p.evaluate(() => [...document.querySelectorAll(".ar-chat-turn.is-job-entry")].slice(-9).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140))),
      openResultHref: await p.evaluate(() => [...document.querySelectorAll("a.ar-job-entry-link")].map((a) => (a as HTMLAnchorElement).getAttribute("href")).filter((h) => /artifacts/.test(String(h))).slice(-1)[0] ?? null),
      startedLines: (await count("Started:")) - startedBefore, finishedLines: (await count("Finished:")) - finishedBefore,
    };
    results.push(ev);
    log(`rendered ${tag} (${width} px): progress arrived with no refresh; ONE started, ONE finished`, ev);
    await p.close();
  }
  // Honest endings, rendered: a workflow stopped from the conversation ("stop that task"), and one that fails.
  for (const [width, height, tag] of [[1440, 900, "d"], [390, 844, "m"]] as const) {
    const p = await ctx!.newPage();
    await p.setViewportSize({ width, height });
    await p.goto(`${hubUrl}/chat`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3500);
    const count = (text: string) => p.evaluate((t) => document.body.innerText.split(t).length - 1, text);
    const until = async (text: string, atLeast: number, ms: number) => {
      const end = Date.now() + ms;
      while ((await count(text)) < atLeast) {
        if (Date.now() > end) return false;
        await sleep(300);
      }
      return true;
    };
    const stoppedBefore = await count("Stopped:");
    await call("POST", "/screen/command", { utterance: "Use the Research computer to audit the demo clinic fixture", source: "typed" }, "/__operator");
    const stepSeen = await until("Website audit, step 2 of 5", (await count("Website audit, step 2 of 5")) + 1, 30_000);
    const stop = await call("POST", "/screen/command", { utterance: "stop that task", source: "typed" }, "/__operator");
    const stopped = await until("Stopped:", stoppedBefore + 1, 30_000);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-5-stopped.png`) });
    const failedBefore = await count("Failed:");
    await call("POST", "/screen/command", { utterance: "Use the Research computer to go to r6-no-such-host.invalid and check the title is Example", source: "typed" }, "/__operator");
    const failed = await until("Failed:", failedBefore + 1, 90_000);
    await p.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(out, `r6-chat-${tag}-6-failed.png`) });
    log(`rendered ${tag}: a stopped workflow and a failed one say so`, { stepSeen, stop: String(stop.json?.said).slice(0, 80), stoppedLine: stopped, failedLine: failed, tail: await p.evaluate(() => [...document.querySelectorAll(".ar-chat-turn.is-job-entry")].slice(-4).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 130))) });
    await p.close();
  }
  // The user "returns": a brand new page load shows the same results, durable and waiting.
  const back = await ctx!.newPage();
  await back.setViewportSize({ width: 1440, height: 900 });
  await back.goto(`${hubUrl}/chat`, { waitUntil: "domcontentloaded" });
  await back.waitForTimeout(4000);
  const text = await back.evaluate(() => document.body.innerText);
  await back.evaluate(() => document.querySelector(".ar-chat-transcript")?.scrollTo(0, 1e9));
  await back.waitForTimeout(500);
  await back.screenshot({ path: join(out, "r6-chat-return.png") });
  log("the user returns (a new page load): the results are waiting", { startedLines: text.split("Started:").length - 1, finishedLines: text.split("Finished:").length - 1, savedResultButtons: text.split("Open saved result").length - 1 });
  await back.close();
  // Open job lands on the job; the saved result opens; the artifact page renders at two widths
  const jobs = (await call("GET", "?limit=5", undefined, "/__jobs")).json.jobs as any[];
  const last = jobs?.find((x) => x.kind === "control" && x.state === "succeeded") ?? jobs?.[0];
  if (last) {
    const act = await ctx!.newPage();
    await act.setViewportSize({ width: 1440, height: 900 });
    await act.goto(`${hubUrl}/activity#job-${last.id}`, { waitUntil: "domcontentloaded" });
    await act.waitForTimeout(3500);
    const shown = await act.evaluate(() => ({ selected: !!document.querySelector('[data-testid="selected-job"]'), text: (document.querySelector('[data-testid="selected-job"]')?.textContent || "").replace(/\s+/g, " ").slice(0, 200), marked: document.querySelectorAll('tr[data-selected="true"]').length, openResult: [...document.querySelectorAll("a")].some((a) => /Open saved result/.test(a.textContent || "")) }));
    await act.screenshot({ path: join(out, "r6-activity-open-job.png") });
    log("OPEN JOB lands on the specific job (not the list)", { job: last.id.slice(0, 8), ...shown });
    await act.close();
    const a2 = await ctx!.newPage();
    const arts = await artifacts();
    const audit = arts.find((a) => a.kind === "audit") ?? arts[0];
    const shots: any[] = [];
    for (const [w, h] of [[1440, 900], [390, 844]] as const) shots.push(await shot(`${hubUrl}/__computers/artifacts/${audit.id}`, `r6-artifact-audit-${w}.png`, w, h));
    const build = arts.find((a) => a.kind === "builder");
    if (build) for (const [w, h] of [[1440, 900], [390, 844]] as const) shots.push(await shot(`${hubUrl}/__computers/artifacts/${build.id}`, `r6-artifact-builder-${w}.png`, w, h));
    const biz = arts.find((a) => a.kind === "bizprep");
    if (biz) shots.push(await shot(`${hubUrl}/__computers/artifacts/${biz.id}`, `r6-artifact-bizprep-1440.png`, 1440, 900));
    const res = arts.find((a) => a.kind === "research");
    if (res) shots.push(await shot(`${hubUrl}/__computers/artifacts/${res.id}`, `r6-artifact-research-1440.png`, 1440, 900));
    log("saved results rendered", shots);
    await a2.close();
  }
  await p0.close();
  log("rendered evidence", results);
}

async function teardown() {
  for (const c of await list()) log(`destroy ${c.name}`, { status: (await call("POST", `/${c.name}/action`, { action: "destroy" })).status });
  await sleep(3000);
  const left = await wsl(`ls -la ${BASE} 2>&1 | head -20; echo ---users; getent passwd | grep -c '^mu-' ; echo ---procs; ps -eo args= | grep -E 'Xvfb|x11vnc|companion.mjs|user-data-dir=.*mu-computers' | grep -v grep | wc -l; echo ---listeners; ss -ltnH | awk '{print $4}' | grep -E ':(18153|59[0-9][0-9]|93[0-9][0-9])$' | tr '\\n' ' '`);
  log("what is left on Ryzen's WSL after destroying the computers", left.split("\n"));
}

main().catch((e) => {
  console.error(e);
  flush();
  process.exit(1);
});

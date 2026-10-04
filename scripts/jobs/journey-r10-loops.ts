#!/usr/bin/env bun
/**
 * Round 10 (computer/native-job owner): loops 2 and 3 through the REAL executors on a SYNTHETIC server-role hub, driven like the person drives them:
 * typed requests to Jarvis's default conversation through the one command path (/__operator/screen/command), then every effect read back through
 * the hub's own APIs (job service, coding harness, the conversations, the saved result), again after a reload.
 *
 *   LOOP 2  "research ..." from Jarvis -> the Research bot's job on its real WSL computer -> sourced report saved -> ONE end entry in the asking conversation
 *   LOOP 3  "fix ... using Opus on Claude Max 2" -> a native coding job pinned to that account and model -> a changed file -> the diff link in the conversation
 *
 *   bun scripts/jobs/journey-r10-loops.ts --hub http://127.0.0.1:8180 --data D:\AgenticOS-r8-data\r10-jobs\hub --out D:\AgenticOS-r8-data\r10-jobs\out
 *        [--only setup,route,research,reload,stop,restart,refuse,coding] [--restart-script <the hub's start/stop script>]
 *
 * Server role: a loopback request is the owner only with the hub's local-owner proof (scripts/identity/local-owner-token.ts, the same file the server
 * console's pair-code tool reads). The owner browser presents it as a header, together with its own confirmed hub session (confirmed on first use while
 * this synthetic data folder was served in the pc role). The token is read in this process and never printed or written anywhere.
 */
import type { Page } from "playwright-core";
import { localOwnerHeaders } from "../identity/local-owner-token";
import { api, arg, closeAll, DATA, expect, flat, HUB, me, record, session, sleep, until, writeResults } from "../acceptance/r7/lib";

const ROW2 = "LOOP 2 research";
const ROW3 = "LOOP 3 coding";
const ALL = ["setup", "route", "research", "reload", "stop", "restart", "terminal", "refuse", "coding"];
const only = arg("only") ? arg("only").split(",") : ALL;
const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted", "unknown", "completed"];
const ids: Record<string, string> = {};

type Entry = { seq: number; key: string; jobId: string; state: string; text: string; jobKind?: string };
type Done = { ok: boolean; said: string; jobId: string | null; numbers?: Record<string, unknown>; kind?: string };

/** One typed request through the one command path, as the Jarvis box sends it; the stream's final `done`. */
async function say(p: Page, utterance: string, extra: Record<string, unknown> = {}): Promise<Done> {
  // The whole stream (the shared api() helper keeps only the first 2000 characters; a coding draft's done line is longer).
  const text = await p.evaluate(async (body) => {
    const t = ((await (await fetch("/__token")).json()) as { token?: string }).token ?? "";
    const res = await fetch("/__operator/screen/command", { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-claude-os-token": t } : {}) }, body: JSON.stringify(body) });
    return res.text();
  }, { utterance, source: "typed", ...extra });
  const lines = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = lines.reverse().find((x: { type?: string }) => x.type === "done") ?? {};
  return done as Done;
}
const jarvisThread = async (p: Page): Promise<Entry[]> => ((await api(p, "GET", "/__operator/screen/command/thread?after=0")).json?.entries ?? []) as Entry[];
const botThread = async (p: Page, bot: string): Promise<Entry[]> => ((await api(p, "GET", `/__agents/bots/${bot}/thread`)).json?.entries ?? []) as Entry[];
const job = async (p: Page, id: string) => (await api(p, "GET", `/__jobs/${id}`)).json?.job as { id: string; state: string; note?: string; steps: { intent: string; executor: string }[] } | undefined;
const coding = async (p: Page, id: string) => (await api(p, "GET", `/__operator/coding/jobs/${id}`)).json as Record<string, any> | undefined;
const of = (entries: Entry[], jobId: string) => entries.filter((e) => e.jobId === jobId);
const summary = (entries: Entry[]) => entries.map((e) => `${e.state}: ${flat(e.text).slice(0, 140)}`);

async function owner(): Promise<Page> {
  const s = await session();
  const proof = localOwnerHeaders(undefined, { ...process.env, MU_DATA_DIR: DATA, MU_LOCAL_OWNER_TOKEN_FILE: "" });
  if (!proof["X-MU-Local-Owner"]) throw new Error("No local-owner token file in the data folder: is the hub running in the server role on this data?");
  await s.ctx.setExtraHTTPHeaders(proof);
  await s.page.goto(`${HUB}/`, { waitUntil: "domcontentloaded" });
  return s.page;
}

async function setup(p: Page) {
  const who = await me(p);
  expect("setup", "owner: a confirmed person at the server-role hub (local-owner proof + confirmed session)", who.actor === "human" && who.via === "loopback-owner", who);
  const role = (await api(p, "GET", "/__devices/me")).json?.hubRole;
  expect("setup", "the hub runs in the server role", role === "server", { role });
  const list = async () => (((await api(p, "GET", "/__computers")).json?.computers ?? []) as { name: string; state: string; usable?: boolean; screen?: unknown }[]).find((c) => c.name === "research");
  if (!(await list())) {
    const made = await api(p, "POST", "/__computers", { name: "research", adapter: "wsl-local", label: "Research" });
    record("setup", "create the Research bot's computer on this PC's WSL (kali-linux)", made.status === 200 ? "PASS" : "FAIL", { status: made.status, error: made.json?.error });
  }
  const ready = await until("research computer online with a working screen", async () => { const c = await list(); return c && c.state === "online" && c.usable ? c : null; }, 300_000, 2000);
  expect("setup", "Research's computer online and its screen proven", !!ready, await list());
  const bots = ((await api(p, "GET", "/__agents/bots")).json?.bots ?? []) as { id: string; computer?: string | null }[];
  expect("setup", "the Research bot is assigned that computer", bots.some((b) => b.id === "research" && b.computer === "research"), bots.map((b) => ({ id: b.id, computer: b.computer })));
}

/** How a bare "Research <companies>" is routed today (the Jev/controller owner's lane): recorded, not changed here. */
async function route(p: Page) {
  const before = (await jarvisThread(p)).length;
  const d = await say(p, "Research Westmead Hospital and Parramatta Library opening hours", { eventId: `r10-route-${Date.now()}` });
  const job0 = d.jobId ? await job(p, d.jobId) : null;
  record(ROW2, "bare 'Research <topic>' typed to Jarvis: where it goes today (controller owner's routing)", job0?.steps.some((s) => s.executor === "research") ? "PASS" : "FAIL", { said: d.said, kind: d.kind, jobId: d.jobId, steps: job0?.steps.map((s) => s.executor), threadAdded: (await jarvisThread(p)).length - before });
  if (d.jobId && job0 && !TERMINAL.includes(job0.state)) await api(p, "POST", "/__operator/screen/command/cancel", { jobId: d.jobId });
}

async function research(p: Page) {
  const d = await say(p, "Ask Research to research the opening hours of Westmead Hospital and Parramatta Library", { eventId: `r10-research-${Date.now()}` });
  expect(ROW2, "typed to Jarvis (default conversation): Research starts a real job on its own computer, receipt with the job id", !!d.jobId && d.ok, { said: d.said, jobId: d.jobId });
  if (!d.jobId) return;
  ids.research = d.jobId;
  const end = await until("the research job to end", async () => { const j = await job(p, d.jobId!); return j && TERMINAL.includes(j.state) ? j : null; }, 600_000, 3000);
  const j = await job(p, d.jobId);
  expect(ROW2, "the job reaches a terminal state in the job service, research ran on the computer (not the hub)", j?.state === "succeeded" && j.steps.some((s) => s.executor === "research"), { state: j?.state, note: j?.note, executors: [...new Set(j?.steps.map((s) => s.executor))] });
  if (!end) return;
  await sleep(6000); // the watcher's poll and the bounded delivery
  const home = of(await jarvisThread(p), d.jobId);
  const inBot = of(await botThread(p, "research"), d.jobId);
  const finished = home.filter((e) => /^(?:succeeded|completed)$/.test(e.state));
  const report = home.find((e) => e.state === "report");
  expect(ROW2, "the asking (Jarvis) conversation: the receipt, the sourced report and ONE completion entry", home.some((e) => e.state === "started") && !!report && finished.length === 1, summary(home));
  expect(ROW2, "the report is sourced (public URLs) and offers the saved result", !!report && /https?:\/\//.test(report.text) && /\nSaved result: /.test(report.text), { report: flat(report?.text).slice(0, 600) });
  expect(ROW2, "Research's own conversation keeps the progress, the report and its one completion", inBot.some((e) => e.state === "progress") && inBot.filter((e) => /^(?:succeeded|completed)$/.test(e.state)).length === 1 && inBot.some((e) => e.state === "report"), summary(inBot));
  const art = await api(p, "GET", `/__computers/artifacts/${d.jobId}`);
  const files = ((await api(p, "GET", "/__computers/artifacts")).json?.artifacts ?? []).find((a: { id: string }) => a.id === d.jobId);
  expect(ROW2, "the saved result opens from the OS (/__computers/artifacts/<job>)", art.status === 200 && files?.files?.length > 0, { status: art.status, title: files?.title, files: files?.files?.map((f: { name: string; bytes: number }) => `${f.name} ${f.bytes}B`), text: flat(art.text).replace(/<[^>]+>/g, " ").slice(0, 300) });
}

async function reload(p: Page) {
  const id = ids.research;
  if (!id) return record(ROW2, "reload: re-read after a new page", "NOT RUN", "no research job this run");
  const before = of(await jarvisThread(p), id).map((e) => e.key);
  await p.reload({ waitUntil: "domcontentloaded" });
  await sleep(4000);
  const after = of(await jarvisThread(p), id).map((e) => e.key);
  const fresh = await owner();
  const third = of(await jarvisThread(fresh), id).map((e) => e.key);
  expect(ROW2, "reload and a second page: the same entries, none duplicated, no new run", JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(after) === JSON.stringify(third) && new Set(after).size === after.length, { before, after, third });
  const jobs = ((await api(p, "GET", "/__jobs?limit=50")).json?.jobs ?? []) as { id: string; title: string; createdAt: string }[];
  expect(ROW2, "reconnect did not start the research again", jobs.filter((x) => /opening hours of Westmead/i.test(x.title)).length === 1, jobs.filter((x) => /Westmead/i.test(x.title)).map((x) => ({ id: x.id.slice(0, 8), title: x.title })));
}

async function stop(p: Page) {
  const d = await say(p, "Ask Research to research which Parramatta libraries open on Sunday", { eventId: `r10-stop-${Date.now()}` });
  if (!d.jobId) return record(ROW2, "Stop from the chat", "FAIL", { said: d.said });
  ids.stop = d.jobId;
  await until("the job to be running a few steps", async () => ((await job(p, d.jobId!))?.steps.length ?? 0) >= 3 ? true : null, 120_000, 1000);
  const stepsAtStop = (await job(p, d.jobId))?.steps.length ?? 0;
  const s = await say(p, "stop that task", { eventId: `r10-stop-say-${Date.now()}` });
  const j = await until("cancelled", async () => { const x = await job(p, d.jobId!); return x && TERMINAL.includes(x.state) ? x : null; }, 60_000, 500);
  await sleep(8000);
  const later = await job(p, d.jobId);
  const home = of(await jarvisThread(p), d.jobId);
  expect(ROW2, "'stop that task' typed to Jarvis cancels the ACTUAL job; nothing ran after it; one Stopped entry", j?.state === "cancelled" && (later?.steps.length ?? 0) <= stepsAtStop + 2 && home.filter((e) => e.state === "cancelled").length === 1 && !home.some((e) => /^(?:succeeded|completed)$/.test(e.state)), { said: s.said, state: j?.state, stepsAtStop, stepsLater: later?.steps.length, lastSteps: later?.steps.slice(-3).map((x) => flat(x.intent).slice(0, 100)), home: summary(home) });
  const art = await api(p, "GET", `/__computers/artifacts/${d.jobId}`);
  expect(ROW2, "a stopped job claims no saved result", art.status === 404, { status: art.status });
}

/** A hub restart while a research job runs: the job is marked as it really ended (never re-run) and both conversations are told once. */
async function restart(p: Page): Promise<Page> {
  const starter = arg("restart-script");
  if (!starter) return (record(ROW2, "hub restart mid-job", "NOT RUN", "no --restart-script given"), p);
  const d = await say(p, "Ask Research to research the parking options near Westmead Hospital", { eventId: `r10-restart-${Date.now()}` });
  if (!d.jobId) return (record(ROW2, "hub restart mid-job", "FAIL", { said: d.said }), p);
  ids.restart = d.jobId;
  await until("a few steps", async () => ((await job(p, d.jobId!))?.steps.length ?? 0) >= 3 ? true : null, 120_000, 1000);
  const { spawnSync } = await import("node:child_process");
  const run = (action: string) => spawnSync(process.execPath, [starter, action], { encoding: "utf8", timeout: 240_000 });
  const stopped = run("stop");
  const started = run("start");
  record(ROW2, "hub stopped and started again on the same data", started.status === 0 ? "PASS" : "FAIL", { stop: stopped.stdout.trim().slice(-120), start: started.stdout.trim().slice(-200) });
  await closeAll();
  const q = await owner();
  const after = await until("the job's real end state after the restart", async () => { const j = await job(q, d.jobId!); return j && TERMINAL.includes(j.state) ? j : null; }, 60_000, 1000);
  const steps = after?.steps.length ?? 0;
  await sleep(20_000);
  const later = await job(q, d.jobId);
  const home = of(await jarvisThread(q), d.jobId);
  const inBot = of(await botThread(q, "research"), d.jobId);
  const ends = (e: Entry[]) => e.filter((x) => TERMINAL.includes(x.state)).length;
  expect(ROW2, "after the restart: marked as it really ended (interrupted/unknown, never re-run), one end entry in each conversation", !!after && ["unknown", "interrupted", "cancelled"].includes(after.state) && (later?.steps.length ?? 0) === steps && ends(home) === 1 && ends(inBot) === 1, { state: after?.state, note: after?.note, steps, stepsLater: later?.steps.length, home: summary(home), bot: summary(inBot).slice(-2) });
  return q;
}

/** The terminal on the REAL WSL bot computer: without the controls it is refused; with them, a computer that runs as the host login user is refused honestly. */
async function terminal(p: Page) {
  const before = await api(p, "POST", "/__computers/research/terminal", { cols: 100, rows: 30 });
  expect("terminal", "without the controls: refused, take control first", before.status === 409 && /take control/i.test(before.json?.error ?? ""), { status: before.status, error: before.json?.error });
  const t = await api(p, "POST", "/__computers/research/takeover", {});
  const opened = await api(p, "POST", "/__computers/research/terminal", { cols: 100, rows: 30 });
  expect("terminal", "holding the controls on a computer with no Linux user of its own: refused by the computer's script, no shell as the host user", opened.status === 409 && /host login user/.test(opened.json?.error ?? ""), { takeover: t.json?.state, status: opened.status, error: opened.json?.error });
  const events = ((await api(p, "GET", "/__computers/events")).json?.events ?? []) as { type: string }[];
  expect("terminal", "nothing was opened, so nothing is logged as a terminal session", !events.some((e) => e.type === "terminal-open"), { terminalEvents: events.filter((e) => e.type.startsWith("terminal")).length });
  await api(p, "POST", "/__computers/research/return", {});
}

async function refuse(p: Page) {
  const before = ((await api(p, "GET", "/__operator/coding/jobs")).json?.jobs ?? []).length;
  // The brief's own phrase ("... on Claude Max N"): recorded as it is routed today. The money guard (src/lib/money-policy.ts) reads "Claude Max" as a
  // subscription purchase, so the coding harness is never asked; reported to its owner. The rest of the loop uses "via account N", which it does not flag.
  const maxWords = await say(p, "Fix the greeting in greet.ts of r10-app using Opus on Claude Max 3", { eventId: `r10-maxwords-${Date.now()}` });
  record(ROW3, "the brief's phrase '... on Claude Max 3' reaches the coding harness (owner: money guard)", /isn't connected/.test(maxWords.said) ? "PASS" : "FAIL", { said: maxWords.said });
  const d = await say(p, "Fix the greeting in greet.ts of r10-app so it ends with an exclamation mark, using Opus via account 3", { eventId: `r10-refuse-${Date.now()}` });
  const after = ((await api(p, "GET", "/__operator/coding/jobs")).json?.jobs ?? []).length;
  expect(ROW3, "an unavailable account (Claude Max 3) is refused by name with the connected alternatives; nothing drafted, no other account used", /Claude Max 3 isn't connected/.test(d.said) && /won't use a different account/.test(d.said) && after === before, { said: d.said, jobsBefore: before, jobsAfter: after });
}

async function codingLoop(p: Page) {
  // A coding job an earlier run left waiting for the owner (--stop-coding <id>) is stopped from the chat first: Stop reaches THAT job, by its id.
  const waiting = arg("stop-coding");
  if (waiting) {
    const s = await say(p, "stop that task", { eventId: `r10-coding-stop-${Date.now()}` });
    await sleep(6000); // the watcher re-reads coding jobs every 4 s
    const after = await coding(p, waiting);
    const entries = of(await jarvisThread(p), waiting);
    expect(ROW3, "'stop that task' typed to Jarvis stops THAT coding job (by its id); the conversation says Stopped once", after?.job?.state === "cancelled" && entries.filter((e) => e.state === "cancelled").length === 1, { said: s.said, state: after?.job?.state, entries: summary(entries) });
  }
  const ask = await say(p, "Fix the greeting in greet.ts and greet.test.ts of r10-app so the greeting ends with an exclamation mark, using Opus via account 2", { eventId: `r10-coding-${Date.now()}` });
  const draftId = (ask.numbers?.draft as { jobId?: string } | undefined)?.jobId ?? null;
  expect(ROW3, "typed to Jarvis: a draft pinned to Claude Max 2 / Opus, asking 'Start it?'", /Start it\?/.test(ask.said) && /opus/i.test(ask.said), { said: flat(ask.said).slice(0, 400), draftId });
  const draft = draftId ? { id: draftId } : undefined;
  const dj = draft ? await coding(p, draft.id) : null;
  const spec = dj?.job?.spec ?? dj?.spec;
  const builder = spec?.roles?.find((r: { role: string }) => r.role === "builder")?.agent;
  expect(ROW3, "the draft's builder is Claude Max 2 with Opus, and the pin is recorded on the job", builder?.accountSlot === "claude:max-2" && /opus/.test(builder?.model ?? "") && spec?.builderPin?.accountSlot === "claude:max-2", { builder, pin: spec?.builderPin, reviewer: spec?.roles?.find((r: { role: string }) => r.role === "reviewer")?.agent });
  const go = await say(p, "start it", { eventId: `r10-coding-start-${Date.now()}` });
  const jobId = (go.numbers?.codingJobId as string | undefined) ?? draft?.id;
  expect(ROW3, "'start it' starts THAT job and links it to the Jarvis conversation", !!jobId && /Started/i.test(go.said), { said: go.said, jobId, numbers: go.numbers });
  if (!jobId) return;
  ids.coding = jobId;
  const end = await until("the coding job to end", async () => { const j = await coding(p, jobId); const st = j?.job?.state ?? j?.state; return st && ["completed", "failed", "cancelled", "needs_owner", "blocked_allowance", "interrupted", "awaiting_approval"].includes(st) ? j : null; }, 1_500_000, 5000);
  const j = (end?.job ?? end) as Record<string, any> | undefined;
  const receipts = ((end as Record<string, any> | null)?.receipts ?? []) as { account: string; model: string; providerModel?: string | null; task?: string }[];
  expect(ROW3, "the job ends completed; every receipt ran on Claude Max 2 (the pinned account), none on another account or a paid API", j?.state === "completed" && receipts.length > 0 && receipts.every((r) => r.account === "claude:max-2"), { state: j?.state, stoppedBecause: j?.stoppedBecause, receipts: receipts.map((r) => `${r.task ?? "?"} ${r.account} ${r.providerModel ?? r.model}`) });
  const files = (j?.diff?.files ?? []) as { path: string }[];
  expect(ROW3, "an actual changed file and passing tests at the head", files.some((f) => /greet/.test(f.path)) && (j?.tests ?? []).some((t: { exitCode: number }) => t.exitCode === 0), { files: files.map((f) => f.path), tests: (j?.tests ?? []).map((t: { commandId: string; exitCode: number }) => `${t.commandId}=${t.exitCode}`), branch: j?.spec?.repo?.jobBranch });
  await sleep(6000);
  const home = of(await jarvisThread(p), jobId);
  const fin = home.filter((e) => /^(?:succeeded|completed)$/.test(e.state));
  expect(ROW3, "the Jarvis conversation: receipt and ONE completion with the diff link and the account/model that ran", fin.length === 1 && fin[0].text.includes(`/coding/${jobId}?tab=changes`) && /Ran on Claude Max 2/.test(fin[0].text), summary(home));
  const page = await api(p, "GET", `/__operator/coding/jobs/${jobId}`);
  expect(ROW3, "the diff link's job opens (coding job view, diff present)", page.status === 200 && files.length > 0, { status: page.status });
}

let p = await owner();
try {
  for (const step of ALL) if (only.includes(step)) {
    console.log(`\n== ${step}`);
    if (step === "restart") p = await restart(p);
    else await ({ setup, route, research, reload, stop, terminal, refuse, coding: codingLoop } as Record<string, (p: Page) => Promise<unknown>>)[step](p);
  }
} finally {
  writeResults(`journey-r10-loops${arg("label") ? `-${arg("label")}` : ""}`, { ids });
  await closeAll();
}

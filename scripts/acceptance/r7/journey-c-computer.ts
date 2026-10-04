#!/usr/bin/env bun
/**
 * Round 8, track C: the connected journey on a REAL local WSL computer, driven in a real (headless) browser against a SYNTHETIC hub seeded with
 * `--host local-wsl` (never the live hub, never Ryzen): conversation -> real job -> progress -> live computer -> takeover -> Return -> Stop ->
 * saved result, plus viewer reconnect after the tab is closed, recovery controls, terminal job status, pinned selections and refresh survival.
 *
 * Every PASS is a PERSISTED effect read back (the hub's own APIs, a reload, a second page, a file on the computer), never a toast or a 200 alone.
 *
 *   bun scripts/acceptance/r7/journey-c-computer.ts --hub http://127.0.0.1:8141 --data D:\AgenticOS-r8-data\c\wsl --out D:\AgenticOS-r8-data\c\out-wsl
 *        [--only setup,conversation,viewer,takeover,stop-chat,stop-panel,reconnect,recovery,pins,refresh,teardown] [--computer research]
 */
import { spawnSync } from "node:child_process";
import type { Page } from "playwright-core";
import { api, arg, closeAll, expect, flat, HUB, me, record, session, shot, SIZES, sleep, until, writeResults } from "./lib";

const ROW = "C computer (local WSL)";
const NAME = arg("computer", "research");
const BOT = arg("bot", "research");
/** This run's computers folder inside WSL (hub.ts --computers-home); a file the journey checks on the computer lives under it. */
const CHOME = arg("computers-home", "/home/ryzen/mu-computers-r8c");
// Git Bash rewrites a leading-slash argument into a Windows path ("C:/Program Files/Git/home/..."): run with MSYS_NO_PATHCONV=1, or this refuses.
if (!/^\/home\/[^/]+\/mu-computers-[a-z0-9-]+$/.test(CHOME)) throw new Error(`--computers-home must be /home/<user>/mu-computers-<run>, not ${CHOME} (Git Bash: set MSYS_NO_PATHCONV=1)`);
/** The X display this run's computer got (hub.ts --display-base): only its own VNC server is killed, never another worker's. */
const DISPLAY_NO = Number(arg("display", "41"));
const ALL = ["setup", "conversation", "viewer", "takeover", "stop-chat", "stop-panel", "reconnect", "recovery", "pins", "refresh", "teardown"];
const only = arg("only") ? arg("only").split(",") : ALL;
const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted", "unknown"];

type View = { name: string; state: string; usable?: boolean; controller: { kind: string | null; who?: string | null }; takeoverPending?: unknown; paused?: { jobId: string } | null; assigned?: { jobId: string } | null; screen?: { ok: boolean; layer: string | null; reason: string | null; next: string | null } };
const view = async (p: Page): Promise<View | null> => (((await api(p, "GET", "/__computers")).json?.computers ?? []) as View[]).find((c) => c.name === NAME) ?? null;
const job = async (p: Page, id: string) => (await api(p, "GET", `/__jobs/${id}`)).json?.job as { id: string; state: string; note?: string; steps: { seq: number; intent: string; executor: string; outcome: string }[] } | undefined;
const cview = async (p: Page, id: string) => (await api(p, "GET", `/__computers/jobs/${id}`)).json?.job as { state: string; paused: boolean; steps: { intent: string }[] } | undefined;
const wsl = (cmd: string) => spawnSync("wsl.exe", ["-d", "kali-linux", "--", "bash", "-lc", cmd], { encoding: "utf8", timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const conversationOf = (p: Page) => p.locator(`section[aria-label="${BOT[0].toUpperCase()}${BOT.slice(1)} conversation"]`).first();
const runCard = (p: Page, jobId: string) => p.locator(`article[data-entry="run"][data-job="${jobId}"]`);
const controls = (p: Page) => p.getByRole("group", { name: /^Controls for / });

async function openWorkspace(p: Page, tab = "") {
  await p.goto(`${HUB}/agents/workspace/${BOT}${tab ? `?tab=${tab}` : ""}`, { waitUntil: "domcontentloaded" });
  await conversationOf(p).waitFor({ timeout: 30_000 }).catch(() => undefined);
}
async function showComputer(p: Page) {
  const toggle = p.getByRole("button", { name: "Show computer" });
  if (await toggle.count()) await toggle.first().click();
  await p.locator("[data-computer-tab]").waitFor({ timeout: 20_000 });
}
/** Send one request from the bot's own composer, like a person (type, Enter). Returns the job it started (from the ack), or null. */
async function ask(p: Page, text: string): Promise<{ jobId: string | null; ack: string }> {
  const box = p.getByLabel(new RegExp(`^Ask ${BOT}`, "i")).and(p.locator("textarea"));
  await box.click();
  await box.fill(text);
  const before = await p.locator('article[data-entry="run"]').evaluateAll((as) => as.map((a) => a.getAttribute("data-job")));
  await box.press("Enter");
  const fresh = await until("a new job card", async () => {
    const now = await p.locator('article[data-entry="run"]').evaluateAll((as) => as.map((a) => a.getAttribute("data-job")));
    return now.find((j) => j && !before.includes(j)) ?? null;
  }, 45_000);
  const ack = flat(await p.locator('[data-entry="ack"]').last().innerText().catch(() => ""));
  return { jobId: fresh, ack };
}
async function cardState(p: Page, jobId: string) {
  const c = runCard(p, jobId);
  if (!(await c.count())) return null;
  return { status: await c.getAttribute("data-status"), text: flat(await c.innerText()).slice(0, 300) };
}

const ids: Record<string, string> = {};
let pageErrors: string[] = [];
let failedRequests: string[] = [];

async function setup(p: Page) {
  const who = await me(p);
  expect(ROW, "owner browser is a confirmed person on the synthetic hub", who.actor === "human", who);
  const host = (await api(p, "GET", "/__computers/host")).json;
  record(ROW, "host check: this PC's WSL (kali-linux)", host?.adapters?.[0]?.check?.ok ? "PASS" : "FAIL", host?.adapters?.map((a: { kind: string; check: { ok: boolean; present: string[] } }) => ({ kind: a.kind, ok: a.check.ok, present: a.check.present })));
  if (!(await view(p))) {
    const made = await api(p, "POST", "/__computers", { name: NAME, adapter: "wsl-local", label: "Research" });
    record(ROW, `create local computer "${NAME}"`, made.status === 200 ? "PASS" : "FAIL", { status: made.status, error: made.json?.error });
  }
  const ready = await until("computer online with a working screen", async () => {
    const v = await view(p);
    return v && v.state === "online" && v.usable ? v : null;
  }, 240_000, 2000);
  const v = await view(p);
  expect(ROW, "computer online and its screen proven (a real frame or screenshot)", !!ready, { state: v?.state, usable: v?.usable, screen: v?.screen });
}

async function conversation(p: Page) {
  await openWorkspace(p);
  const r = await ask(p, "prepare a comparison table of three website care plans");
  expect(ROW, "conversation: a typed request starts a REAL job on the bot's computer (ack + job card)", !!r.jobId, r);
  if (!r.jobId) return;
  ids.result = r.jobId;
  const seen = new Set<string>();
  const done = await until("the job card to settle", async () => {
    const s = await cardState(p, r.jobId!);
    if (s?.status) seen.add(s.status);
    return s && ["done", "failed", "stopped", "unclear"].includes(s.status ?? "") ? s : null;
  }, 180_000, 500);
  const j = await job(p, r.jobId);
  // A business-preparation job can finish in about a second, before a poll sees "running": its progress is then read from the conversation itself.
  const thread = ((await api(p, "GET", `/__agents/bots/${BOT}/thread`)).json?.entries ?? []) as { jobId: string; state: string; text: string }[];
  const progress = thread.filter((e) => e.jobId === r.jobId && e.state === "progress").map((e) => e.text.slice(0, 90));
  expect(ROW, "progress: the job's progress lands in the conversation, the card ends Done, and the job service agrees", done?.status === "done" && j?.state === "succeeded" && (seen.has("running") || progress.length > 0), { statuses: [...seen], progress, card: done?.status, jobState: j?.state, note: j?.note });
  await shot(p, "c-1-conversation-done");
  const link = runCard(p, r.jobId).getByRole("link", { name: /Open result/ });
  const href = (await link.count()) ? await link.first().getAttribute("href") : null;
  const art = href ? await api(p, "GET", href) : null;
  expect(ROW, "saved result: the card's Open result link serves the saved artifact", href === `/__computers/artifacts/${r.jobId}` && art?.status === 200 && /comparison/i.test(art?.text ?? ""), { href, status: art?.status, text: flat(art?.text ?? "").replace(/<[^>]+>/g, " ").slice(0, 160) });
}

async function viewer(p: Page) {
  await openWorkspace(p);
  await showComputer(p);
  const live = await until("the live viewer", async () => ((await p.locator("[data-screen-state]").first().getAttribute("data-screen-state")) === "live" ? true : null), 45_000, 500);
  const status = flat(await p.locator("[data-screen-state]").first().innerText().catch(() => ""));
  const mode = await p.locator("[data-computer-tab]").getAttribute("data-mode");
  const input = await p.locator("[data-computer-tab]").getAttribute("data-input");
  expect(ROW, "live computer: the panel shows the real screen, view-only until you take over", !!live && input === "view-only" && /view-only/i.test(status), { status, mode, input });
  await shot(p, "c-2-viewer-live");
}

async function takeover(p: Page) {
  await openWorkspace(p);
  await showComputer(p);
  const r = await ask(p, "audit the demo clinic fixture");
  if (!r.jobId) return void record(ROW, "takeover: an audit job started from the conversation", "FAIL", r);
  ids.takeover = r.jobId;
  await until("job running", async () => ((await job(p, r.jobId!))?.state === "running" ? true : null), 30_000, 300);
  await controls(p).getByRole("button", { name: "Take over" }).click();
  const held = await until("the person to hold the computer", async () => ((await view(p))?.controller.kind === "person" ? true : null), 90_000, 300);
  const atPause = await cview(p, r.jobId);
  const pausedStep = atPause?.steps.find((s) => /^paused before/.test(s.intent))?.intent ?? null;
  expect(ROW, "takeover: the agent pauses at its next safe step and the person holds the controls", !!held && !!atPause?.paused && !!pausedStep, { held, paused: atPause?.paused, pausedStep, jobState: atPause?.state });
  const card = await until("the card to say paused", async () => ((await cardState(p, r.jobId!))?.status === "blocked" ? cardState(p, r.jobId!) : null), 20_000, 400);
  const panelInput = await until("the panel to take your input", async () => ((await p.locator("[data-computer-tab]").getAttribute("data-input")) === "yours" ? "yours" : null), 15_000, 300) ?? await p.locator("[data-computer-tab]").getAttribute("data-input");
  expect(ROW, "takeover: the conversation card says it is paused while you have the controls; the panel takes your input", /Paused while you have the controls/i.test(card?.text ?? "") && panelInput === "yours", { card, panelInput });
  await shot(p, "c-3-takeover-held");
  // The words while you hold the controls (round 8 findings C-1 to C-4): said once, to you, naming the bot (not its id).
  const words = await p.evaluate((jobId) => {
    const t = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    return { card: t(document.querySelector(`article[data-entry="run"][data-job="${jobId}"]`)), panel: t(document.querySelector("[data-computer-tab]")), header: t(document.querySelector('[data-testid="bot-status"]')) };
  }, r.jobId);
  const count = (s: string, w: string) => s.split(w).length - 1;
  const copy = { cardPausedPhrase: count(words.card, "Paused while you have the controls"), cardSaysUserId: /usman is taking control/.test(words.card), panelPausedPhrase: count(words.panel, "Paused while you have the controls"), panelNamesId: /\bresearch's job/.test(words.panel), headerNamesId: /\bresearch's job/.test(words.header) };
  expect(ROW, "copy while you hold the controls: the pause said once in the card, not in the third person, not again in the panel; the bot named, not its id", copy.cardPausedPhrase === 1 && !copy.cardSaysUserId && copy.panelPausedPhrase === 0 && !copy.panelNamesId && !copy.headerNamesId, { ...copy, header: words.header, panel: words.panel.slice(0, 220), card: words.card.slice(0, 260) });
  // Agent input is refused while the person holds it: a second job on the same computer, and a program's input. (The 409 these deliberate
  // refusals log in the page console is this check's own, so it is not counted as a page error.)
  const agentJob = await api(p, "POST", `/__computers/${NAME}/jobs`, { agent: "r8c", title: "must not run while held", steps: [{ executor: "file.write", args: { name: "r8c-agent-while-held.txt", text: "x" } }] });
  const program = await fetch(`${HUB}/__computers/${NAME}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ executor: "file.write", args: { name: "r8c-program.txt", text: "x" } }) }).then((x) => x.status);
  const stepsHeld = (await cview(p, r.jobId))?.steps.length ?? 0;
  const person = await api(p, "POST", `/__computers/${NAME}/input`, { executor: "file.write", args: { name: "r8c-person.txt", text: "written by the person holding the controls" } });
  const readBack = await api(p, "POST", `/__computers/${NAME}/input`, { executor: "file.read", args: { name: "r8c-person.txt" } });
  await sleep(8000);
  const stepsLater = (await cview(p, r.jobId))?.steps.length ?? 0;
  expect(ROW, "takeover pauses agent input: another agent job and a program are refused; the job adds no steps while held; the person's input works", agentJob.status === 409 && program >= 400 && stepsLater === stepsHeld && person.status === 200 && /written by the person/.test(JSON.stringify(readBack.json ?? "")), { agentJob: [agentJob.status, agentJob.json?.error], program, stepsHeld, stepsAfter8s: stepsLater, person: person.status, readBack: JSON.stringify(readBack.json ?? {}).slice(0, 160) });
  const before = (await cview(p, r.jobId))?.steps.map((s) => s.intent) ?? [];
  await controls(p).getByRole("button", { name: "Return to agent" }).click();
  const end = await until("the job to finish after Return", async () => { const s = (await job(p, r.jobId!))?.state; return s && TERMINAL.includes(s) ? s : null; }, 180_000, 500);
  const after = (await cview(p, r.jobId))?.steps.map((s) => s.intent) ?? [];
  const subgoals = after.filter((i) => /^sub-goal \d+ of \d+, [^:]+: done/.test(i));
  const dup = subgoals.filter((x, i) => subgoals.indexOf(x) !== i);
  const sameJob = after.slice(0, before.length).every((x, i) => x === before[i]);
  const resumed = after.some((i) => /^control returned to the agent/.test(i));
  const settled = await until("the card to settle", async () => { const s = await cardState(p, r.jobId!); return s && s.status !== "blocked" && s.status !== "running" ? s : null; }, 30_000, 400);
  expect(ROW, "Return resumes the SAME job without replay (no sub-goal done twice) and it finishes", end === "succeeded" && resumed && sameJob && dup.length === 0, { end, resumed, sameJobPrefix: sameJob, duplicates: dup, subgoalsDone: subgoals.length, card: settled?.status });
  const v = await view(p);
  expect(ROW, "after the job: the computer is free (no lease held)", !v?.controller.kind && !v?.paused, { controller: v?.controller, paused: v?.paused });
  await shot(p, "c-4-takeover-returned");
}

async function stopChat(p: Page) {
  await openWorkspace(p);
  const r = await ask(p, "audit the demo clinic fixture");
  if (!r.jobId) return void record(ROW, "Stop (chat): a job started", "FAIL", r);
  ids.stopChat = r.jobId;
  await until("job running with a step", async () => { const j = await job(p, r.jobId!); return j?.state === "running" && j.steps.length >= 2 ? true : null; }, 40_000, 200);
  const stepsAtStop = (await job(p, r.jobId))?.steps.length ?? 0;
  await runCard(p, r.jobId).getByRole("button", { name: "Stop" }).click();
  const end = await until("cancelled", async () => { const s = (await job(p, r.jobId!))?.state; return s && TERMINAL.includes(s) ? s : null; }, 60_000, 300);
  await sleep(6000);
  const j = await job(p, r.jobId);
  const card = await until("card says stopped", async () => ((await cardState(p, r.jobId!))?.status === "stopped" ? cardState(p, r.jobId!) : null), 20_000, 400);
  const art = await api(p, "GET", `/__computers/artifacts/${r.jobId}`);
  const v = await view(p);
  const laterOk = (j?.steps ?? []).slice(stepsAtStop + 1).every((s) => s.outcome !== "ok" || /cancel|stop/i.test(s.intent));
  expect(ROW, "Stop from the conversation cancels the real job; nothing ran after it; no result is claimed; the computer stays up and free", end === "cancelled" && card?.status === "stopped" && art.status === 404 && laterOk && v?.state === "online" && !v?.controller.kind, { end, note: j?.note, stepsAtStop, stepsNow: j?.steps.length, lastSteps: j?.steps.slice(-3).map((s) => `${s.outcome}: ${s.intent.slice(0, 80)}`), card, artifact: art.status, computer: v?.state, controller: v?.controller.kind });
  await shot(p, "c-5-stop-chat");
}

async function stopPanel(p: Page) {
  await openWorkspace(p);
  await showComputer(p);
  wsl(`rm -f ${CHOME}/${NAME}/work/r8c-never.txt`);
  const jr = await api(p, "POST", `/__computers/${NAME}/jobs`, { agent: BOT, title: "r8c stop check", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: "r8c-never.txt", text: "must not exist" } }] });
  if (jr.status !== 200) return void record(ROW, "Stop (panel): a two-step job started", "FAIL", jr);
  ids.stopPanel = jr.json.jobId;
  await until("busy", async () => ((await view(p))?.state === "busy" ? true : null), 30_000, 300);
  await controls(p).getByRole("button", { name: "Stop", exact: true }).click();
  const question = flat(await p.getByRole("group", { name: "Confirm stop" }).innerText().catch(() => ""));
  await p.getByRole("button", { name: "Yes, stop it" }).click();
  const end = await until("cancelled", async () => { const s = (await job(p, ids.stopPanel))?.state; return s && TERMINAL.includes(s) ? s : null; }, 60_000, 300);
  await until("stopped", async () => (["offline", "stopped"].includes((await view(p))?.state ?? "") ? true : null), 60_000, 500);
  await sleep(6000);
  const j = await job(p, ids.stopPanel);
  const file = wsl(`ls ${CHOME}/${NAME}/work/ 2>&1; test -e ${CHOME}/${NAME}/work/r8c-never.txt && echo PRESENT || echo ABSENT`);
  const v = await view(p);
  expect(ROW, "Stop (computer panel, confirmed) cancels the job; the later step never runs (its file is absent on the computer)", end === "cancelled" && /ABSENT/.test(file.stdout) && (j?.steps ?? []).some((s) => /not run/.test(s.intent)), { question, end, note: j?.note, lastSteps: j?.steps.slice(-2).map((s) => `${s.outcome}: ${s.intent.slice(0, 90)}`), file: flat(file.stdout).slice(-120), computer: v?.state });
  await shot(p, "c-6-stop-panel");
  await controls(p).getByRole("button", { name: /^(Start|Reconnect)$/ }).click();
  const back = await until("online again", async () => { const x = await view(p); return x?.state === "online" && x.usable ? x : null; }, 180_000, 1000);
  expect(ROW, "Start brings the stopped computer back with a working screen", !!back, { state: (await view(p))?.state, usable: (await view(p))?.usable });
}

async function reconnect(p: Page) {
  // The person takes control in one tab, then CLOSES the tab: the hub gives the computer back after its grace, and a new tab reconnects view-only.
  // Every tab of one browser is the same session (the lease is per person AND browser session), so the journey's own page leaves the computer first:
  // another open tab of the same browser that is watching keeps the controls, by design (checked separately below).
  await p.goto(`${HUB}/activity`, { waitUntil: "domcontentloaded" }); // a page with no viewer: the journey still reads the hub through it
  const q = await p.context().newPage(); // a second tab of the same browser (session() would hand back this very page)
  await openWorkspace(q);
  await showComputer(q);
  await until("live", async () => ((await q.locator("[data-screen-state]").first().getAttribute("data-screen-state")) === "live" ? true : null), 45_000, 500);
  await controls(q).getByRole("button", { name: "Take over" }).click();
  const held = await until("held", async () => ((await view(p))?.controller.kind === "person" ? true : null), 20_000, 300);
  await q.close();
  const closedAt = Date.now();
  const freed = await until("released after the tab closed", async () => (!(await view(p))?.controller.kind ? true : null), 60_000, 500);
  const freedAfterMs = Date.now() - closedAt;
  const events = ((await api(p, "GET", "/__computers/events")).json?.events ?? []).filter((e: { at: number }) => e.at >= closedAt - 30_000).map((e: { at: number; type: string; detail?: string }) => `+${Math.round((e.at - closedAt) / 100) / 10}s ${e.type} ${e.detail ?? ""}`.slice(0, 140));
  expect(ROW, "viewer: closing the tab that held the controls gives the computer back (viewer-close grace, not the 90 s lease)", !!held && !!freed && freedAfterMs < 30_000, { held, freedAfterMs, events });
  await openWorkspace(p);
  await showComputer(p);
  const live = await until("reconnected live", async () => ((await p.locator("[data-screen-state]").first().getAttribute("data-screen-state")) === "live" ? true : null), 45_000, 500);
  const offer = (await until("Take over offered", async () => ((await controls(p).getByRole("button", { name: "Take over" }).count()) ? 1 : null), 15_000, 300)) ?? 0;
  expect(ROW, "viewer: a new tab reconnects to the live screen, view-only, with Take over offered", !!live && offer === 1, { live, takeOverOffered: offer, status: flat(await p.locator("[data-screen-state]").first().innerText().catch(() => "")) });
  await shot(p, "c-7-reconnected");
  // The same browser in two tabs: closing the one that took the controls keeps them while the other (same session) still watches; it says so there.
  const r = await p.context().newPage();
  await openWorkspace(r);
  await showComputer(r);
  await until("live in the second tab", async () => ((await r.locator("[data-screen-state]").first().getAttribute("data-screen-state")) === "live" ? true : null), 45_000, 500);
  await controls(r).getByRole("button", { name: "Take over" }).click();
  await until("held", async () => ((await view(p))?.controller.kind === "person" ? true : null), 20_000, 300);
  await r.close();
  await sleep(12_000);
  const still = (await view(p))?.controller.kind;
  const says = await until("this tab says you hold them", async () => { const t = flat(await p.locator("[data-screen-state]").first().innerText().catch(() => "")); return /You hold the controls/.test(t) ? t : null; }, 15_000, 500);
  expect(ROW, "viewer: with another tab of the SAME browser still watching, closing the tab that took the controls keeps them (one session), and that tab says you hold them", still === "person" && !!says, { controllerAfter12s: still, otherTabSays: says });
  await controls(p).getByRole("button", { name: "Return to agent" }).click();
  await until("returned", async () => (!(await view(p))?.controller.kind ? true : null), 20_000, 300);
}

async function recovery(p: Page) {
  await openWorkspace(p);
  await showComputer(p);
  // The VNC server dies under an idle computer: the panel must say the screen is unavailable and offer the next action (not "ready").
  const kill = wsl(`pkill -f "x11vnc .*-display :${DISPLAY_NO} " ; sleep 1; echo "x11vnc left: $(pgrep -fc "x11vnc .*-display :${DISPLAY_NO} ")"`);
  const issue = await until("the screen problem to show", async () => {
    const v = await view(p);
    return v?.screen && !v.screen.ok && v.screen.layer ? v : null;
  }, 40_000, 1000);
  // The hub samples computers every 2 s for the live stream and the page refetches on it: allow the panel a few seconds to say so.
  await until("the panel to name the screen problem", async () => ((await p.locator("[data-computer-tab]").getAttribute("data-mode")) === "screen-down" ? true : null), 15_000, 300);
  // One synchronous read of the whole panel (reading each part with its own locator waited 30 s for a part that was not there, and the screen came back meanwhile).
  const panel = await p.evaluate(() => {
    const q = (sel: string) => ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    return { headline: q('[data-testid="computer-headline"]'), mode: document.querySelector("[data-computer-tab]")?.getAttribute("data-mode") ?? null, status: q('[data-testid="bot-status"]'), detail: q('[data-testid="computer-detail"]'), viewer: q("[data-screen-state]"), buttons: [...document.querySelectorAll('[role=group][aria-label^="Controls for"] button')].map((b) => (b as HTMLElement).innerText.trim()) };
  });
  await shot(p, "c-8-recovery-screen-down");
  // Round 8 finding C-5: the bot's header said plain "Ready" while the panel beside it said its screen was not working.
  const header = await until("the header to say the screen is not working", async () => { const t = flat(await p.locator('[data-testid="bot-status"]').innerText().catch(() => "")); return /screen isn't working/.test(t) ? t : null; }, 10_000, 300);
  expect(ROW, "header while the screen is down: not plain 'Ready'; it says the screen isn't working and where to fix it", !!header, { header: header ?? flat(await p.locator('[data-testid="bot-status"]').innerText().catch(() => "")) });
  expect(ROW, "recovery: a dead VNC server is named (not 'ready'), with the next action offered", !!issue && !/is ready/.test(panel.headline) && (panel.buttons.includes("Restart display") || /Restart display|Reconnect/.test(panel.viewer + panel.detail)), { kill: flat(kill.stdout).slice(0, 120), layer: issue?.screen?.layer, reason: issue?.screen?.reason, next: issue?.screen?.next, panel });
  const restart = p.getByRole("button", { name: "Restart display" }).first();
  if (await restart.count()) await restart.click();
  const back = await until("screen back", async () => { const v = await view(p); return v?.usable ? v : null; }, 120_000, 1000);
  const live = await until("viewer live again", async () => ((await p.locator("[data-screen-state]").first().getAttribute("data-screen-state")) === "live" ? true : null), 60_000, 1000);
  expect(ROW, "recovery: Restart display (or the bounded automatic restart) brings the screen back and the viewer reconnects", !!back && !!live, { usable: back?.usable, viewer: flat(await p.locator("[data-screen-state]").first().innerText().catch(() => "")) });
  await shot(p, "c-9-recovery-back");
  // The computer stopped: the conversation says offline and its Reconnect brings it back.
  await api(p, "POST", `/__computers/${NAME}/action`, { action: "stop", force: true });
  await until("offline", async () => ((await view(p))?.state === "offline" ? true : null), 60_000, 500);
  await openWorkspace(p);
  const notice = conversationOf(p).getByRole("button", { name: "Reconnect" });
  await notice.waitFor({ timeout: 30_000 }).catch(() => undefined);
  const offlineText = flat(await conversationOf(p).locator("[role=status], .ds-notice, div").first().innerText().catch(() => "")).slice(0, 200);
  const hasReconnect = await notice.count();
  if (hasReconnect) await notice.first().click();
  const msg = await until("the reconnect answer", async () => { const t = flat(await p.locator('[data-testid="reconnect-result"]').innerText().catch(() => "")); return t || null; }, 30_000, 500);
  const up = await until("online after Reconnect", async () => { const v = await view(p); return v?.state === "online" && v.usable ? v : null; }, 180_000, 1000);
  expect(ROW, "recovery: a stopped computer shows Offline in the conversation; its Reconnect says what it did and brings it back", hasReconnect === 1 && !!msg && !!up, { hasReconnect, offlineText, message: msg, state: (await view(p))?.state });
  await shot(p, "c-10-reconnect-chat");
}

async function pins(p: Page) {
  await p.goto(`${HUB}/agents/workspace/${BOT}?tab=setup`, { waitUntil: "domcontentloaded" });
  const route = p.locator("select").filter({ has: p.locator("option") }).and(p.locator('[id*="route"], [id*="model-pref"], [id*="first"]'));
  const sel = (await route.count()) ? route.first() : p.getByLabel("Model it uses first");
  await sel.waitFor({ timeout: 30_000 }).catch(() => undefined);
  const options = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: o.textContent?.trim(), d: (o as HTMLOptionElement).disabled })));
  const current = await sel.inputValue().catch(() => null);
  const pick = options.find((o) => !o.d && o.v !== current)?.v ?? null;
  if (!pick) return void record(ROW, "model preference: change -> reload -> API", "BLOCKED", { why: "no other enabled option on this synthetic hub", options, current });
  await sel.selectOption(pick);
  await until("saved", async () => ((await api(p, "GET", `/__agents/bots/${BOT}`)).json?.modelPreference?.route === pick ? true : null), 15_000, 300);
  await p.reload({ waitUntil: "domcontentloaded" });
  await sel.waitFor({ timeout: 30_000 });
  const after = await sel.inputValue();
  const apiRoute = (await api(p, "GET", `/__agents/bots/${BOT}`)).json?.modelPreference?.route;
  expect(ROW, "model preference stays pinned after reload (page and API)", after === pick && apiRoute === pick, { from: current, to: pick, afterReload: after, api: apiRoute });
  if (current !== null) {
    await sel.selectOption(current);
    await until("restored", async () => ((await api(p, "GET", `/__agents/bots/${BOT}`)).json?.modelPreference?.route === current ? true : null), 15_000, 300);
  }
  // The assigned computer: to none and back, each read back after a reload.
  const comp = p.getByLabel("Assigned computer");
  const compOptions = await comp.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, d: (o as HTMLOptionElement).disabled })));
  await comp.selectOption("");
  await until("unassigned", async () => ((await api(p, "GET", `/__agents/bots/${BOT}`)).json?.computer === null ? true : null), 15_000, 300);
  await p.reload({ waitUntil: "domcontentloaded" });
  await comp.waitFor({ timeout: 30_000 });
  const none = await comp.inputValue();
  await comp.selectOption(NAME);
  await until("reassigned", async () => ((await api(p, "GET", `/__agents/bots/${BOT}`)).json?.computer === NAME ? true : null), 15_000, 300);
  await p.reload({ waitUntil: "domcontentloaded" });
  await comp.waitFor({ timeout: 30_000 });
  const again = await comp.inputValue();
  expect(ROW, "computer assignment: change -> reload -> API (none, then back to its computer)", none === "" && again === NAME && (await api(p, "GET", `/__agents/bots/${BOT}`)).json?.computer === NAME, { options: compOptions, afterNone: none, afterBack: again });
}

async function refresh(p: Page) {
  await openWorkspace(p);
  await p.reload({ waitUntil: "domcontentloaded" });
  await conversationOf(p).waitFor({ timeout: 30_000 });
  await sleep(3000);
  const want: [string, string][] = [["result", "done"], ["takeover", "done"], ["stopChat", "stopped"]];
  const got: Record<string, unknown> = {};
  let ok = true;
  for (const [k, status] of want) {
    if (!ids[k]) continue;
    const s = await cardState(p, ids[k]);
    const j = await job(p, ids[k]);
    got[k] = { card: s?.status, job: j?.state };
    ok &&= s?.status === status;
  }
  const requests = await p.locator('[data-entry="request"]').count();
  expect(ROW, "after a refresh: the conversation (requests and every job card with its true end state) is all still there", ok && requests >= Object.keys(ids).filter((k) => k !== "stopPanel").length, { cards: got, requests });
  if (ids.result) {
    const href = await runCard(p, ids.result).getByRole("link", { name: /Open result/ }).first().getAttribute("href").catch(() => null);
    const [popup] = await Promise.all([p.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null), runCard(p, ids.result).getByRole("link", { name: /Open result/ }).first().click().catch(() => undefined)]);
    await popup?.waitForLoadState("domcontentloaded").catch(() => undefined);
    const title = popup ? await popup.title() : null;
    const body = popup ? flat(await popup.locator("body").innerText()).slice(0, 160) : "";
    expect(ROW, "after a refresh: the saved result opens from its card (a real click, a new tab)", !!popup && /comparison/i.test(body), { href, title, body });
    if (popup) await popup.screenshot({ path: `${arg("out", "")}\\c-11-result-opened.png` }).catch(() => undefined);
    await popup?.close();
  }
  // Tasks: every job's word matches the job service's end state.
  await p.goto(`${HUB}/agents/workspace/${BOT}?tab=tasks`, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  const text = flat(await p.locator("main").innerText().catch(() => "")).slice(0, 1500);
  await shot(p, "c-12-tasks");
  const rows: Record<string, unknown> = {};
  for (const [k, id] of Object.entries(ids)) rows[k] = (await job(p, id))?.state;
  record(ROW, "Tasks tab after the journey (words beside the job service's states)", /Finished/.test(text) && /Stopped/.test(text) ? "PASS" : "FAIL", { states: rows, tasksText: text.slice(0, 700) });
}

async function teardown(p: Page) {
  const r = await api(p, "POST", `/__computers/${NAME}/action`, { action: "destroy" });
  // "[m]u-computers-..." matches the computer's processes but not this pgrep's own command line.
  const left = wsl(`pgrep -af '[m]${CHOME.slice(CHOME.lastIndexOf("/") + 2)}/' | head -5; pgrep -af '[X]vfb :${DISPLAY_NO} ' | head -3`);
  record(ROW, "teardown: the computer destroyed through the API; no process of this run left in WSL", r.status === 200 && !flat(left.stdout) ? "PASS" : "FAIL", { status: r.status, left: flat(left.stdout).slice(0, 200) });
}

const STEPS: Record<string, (p: Page) => Promise<void>> = { setup, conversation, viewer, takeover, "stop-chat": stopChat, "stop-panel": stopPanel, reconnect, recovery, pins, refresh, teardown };

try {
  const s = await session(SIZES[0]);
  pageErrors = s.errors;
  // Which requests failed, so a console "404" can be traced to its URL (the journey's own deliberate reads are told apart there).
  const failed: string[] = [];
  s.page.context().on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(HUB, "")}`.slice(0, 160)); });
  failedRequests = failed;
  for (const name of ALL.filter((n) => only.includes(n))) {
    try {
      await STEPS[name](s.page);
    } catch (e) {
      record(ROW, `${name} ran to the end`, "FAIL", { error: String(e).slice(0, 500) });
      await shot(s.page, `c-error-${name}`);
    }
  }
  // What the journey causes on purpose is not a page error: its refused agent job (409) and its read of a stopped job's result (404), both made from the
  // page and both listed in failedRequests; and the viewer's own console lines while the VNC server is killed or the computer is stopped on purpose.
  const deliberate = (e: string) => /status of 409 \(Conflict\)|status of 404 \(Not Found\)/.test(e) || /Failed when connecting|WebSocket connection to .*\/__computers\/[a-z0-9-]+\/vnc/.test(e);
  const unexpected = failedRequests.filter((r) => !/^409 POST \/__computers\/[a-z0-9-]+\/jobs$|^404 GET \/__computers\/artifacts\//.test(r));
  const real = s.errors.filter((e) => !deliberate(e));
  record(ROW, "page errors and failed requests during the journey (besides the ones it causes on purpose)", real.length || unexpected.length ? "FAIL" : "PASS", { real: real.slice(0, 10), deliberate: s.errors.length - real.length, failedRequests: failedRequests.slice(0, 20), unexpected });
} finally {
  writeResults(`journey-c-computer${arg("label") ? `-${arg("label")}` : ""}`, { environment: "local WSL (kali-linux) + synthetic hub", computer: NAME, jobs: ids });
  await closeAll();
}

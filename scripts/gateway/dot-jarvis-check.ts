#!/usr/bin/env bun
/**
 * /jarvis as Dot's OWN Jarvis, in a real (headless) browser, on the LOCAL SYNTHETIC staging pair only (staging-local.ts with --ui).
 *
 *   bun scripts/gateway/dot-jarvis-check.ts [--data D:\AgenticOS-r12-data\gwj] [--gateway-port 8195] [--out <folder>]
 *
 * Signs in as Dot with a SYNTHETIC code (operate set), then: sends "Reply with QA DOT 1" and waits for the reply; reloads and checks the
 * request and the reply are still there, once each; sends a research task, waits for its job card and presses Stop; checks no founder
 * thread is readable through the gateway. Screenshots to --out. No code, key, token, cookie or body is written anywhere.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { conversationStore, jarvisThreadId } from "../conversations";
import { JobService } from "../jobs/service";
import { runCli } from "./cli";
import { gatewayDir } from "./config";

const argv = process.argv.slice(2);
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const repo = resolve(import.meta.dir, "..", "..");
const data = resolve(arg("data", "D:\\AgenticOS-r12-data\\gwj"));
const port = Number(arg("gateway-port", "8195"));
const out = resolve(repo, arg("out", "docs/programme-20261001/evidence-notes/dot-jarvis"));
if (!/AgenticOS-r\d+-data/i.test(data) || !(port >= 8120 && port <= 8199)) throw new Error("Refusing: this runs only against the local synthetic pair (an AgenticOS-r<N>-data folder, a port in 8120-8199).");
const origin = `http://127.0.0.1:${port}`;
const ASK = "Reply with QA DOT 1";
const RESEARCH = "Research three dental clinics in Exampleville and compare their opening hours";

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  }
}

async function signIn(page: Page) {
  const dir = gatewayDir(repo, { MU_DATA_DIR: data });
  const lines: string[] = [];
  runCli(["enrol-code", "--by", "usman", "--label", "Dot (Jarvis check)", "--identity-days", "1"], dir, (l) => lines.push(l));
  const code = /code for Dot: ([A-Z0-9-]+)/.exec(lines.join("\n"))?.[1];
  if (!code) throw new Error("no synthetic code was minted");
  await page.goto(`${origin}/gw/enrol#code=${code}`);
  await page.click("#go");
  await page.waitForSelector("#cont", { timeout: 15_000 });
  await page.click("#cont");
  await page.waitForLoadState("domcontentloaded");
  // The identity exists once the code is used: grant the operate set to it (until it ends).
  const said: string[] = [];
  runCli(["grant", "operate", "--by", "usman", "--until-identity"], dir, (l) => said.push(l));
  if (!/grant|operate|until/i.test(said.join(" ")) || /No active identity/i.test(said.join(" "))) throw new Error("the operate set was not granted to the synthetic identity");
}

const userBubbles = async (page: Page, text: string) => (await page.locator("[data-jarvis-thread] li p").allTextContents()).filter((t) => t.trim() === text).length;
const replies = async (page: Page) => (await page.locator('[data-jarvis-thread] li[data-entry="reply"]').allTextContents()).map((t) => t.trim());

async function send(page: Page, words: string) {
  await page.locator("#assistant-request").fill(words);
  await page.locator('button[type="submit"][aria-label="Send request"]').click();
}

type Check = { name: string; ok: boolean; detail: string };

/**
 * The synthetic hub has no Jev key, so a research request is refused there before any job starts ("nothing ran"). To show the job card and
 * prove Stop end to end, this puts one SYNTHETIC queued job of Dot's into Dot's thread exactly as the hub's thread watcher does for a job a
 * command started (the job store's own create/begin, the conversation store's linkJob/appendEntry "started" entry). Stop then goes through
 * the page, the gateway and the hub for real.
 */
function seedRunningDotJob(title: string): string {
  const jobs = new JobService({ path: join(data, "jobs.sqlite") });
  const job = jobs.create({ kind: "command", principal: { personId: "dot", via: "gateway", actor: "process" } as never, targetDeviceId: "none", title, requestId: `cmd:dot:check-${Date.now()}` });
  jobs.close();
  const prior = process.env.MU_DATA_DIR;
  process.env.MU_DATA_DIR = data;
  try {
    const store = conversationStore(repo);
    const thread = store.ensureThread({ personId: "dot" })!;
    store.linkJob(thread.id, { jobId: job.id, kind: "job", title, state: "running" });
    store.appendEntry(thread.id, { key: `${job.id}:started`, jobId: job.id, state: "started", text: `Started: ${title} (job ${job.id.slice(0, 8)}).` });
  } finally {
    if (prior === undefined) delete process.env.MU_DATA_DIR;
    else process.env.MU_DATA_DIR = prior;
  }
  return job.id;
}

export async function runCheck(): Promise<Check[]> {
  mkdirSync(out, { recursive: true });
  const checks: Check[] = [];
  const browser = await launch();
  const consoleErrors: string[] = [];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })).newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
  await signIn(page);
  await page.goto(`${origin}/jarvis`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant-request:not([readonly])", { timeout: 20_000 });
  await page.waitForTimeout(3_000); // the page settles (its first reads) before the first send
  const before = (await replies(page)).length;
  const asksBefore = await userBubbles(page, ASK);

  // 1. A plain answer: the request and Jarvis's reply show.
  await send(page, ASK);
  await page.waitForFunction((n) => document.querySelectorAll('[data-jarvis-thread] li[data-entry="reply"]').length > n, before, { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);
  const afterSend = await replies(page);
  checks.push({ name: "reply shows", ok: afterSend.length > before && (await userBubbles(page, ASK)) >= 1, detail: `reply: ${afterSend.at(-1)?.slice(0, 160) ?? "(none)"}` });
  await page.screenshot({ path: join(out, "1-reply.png") });

  // 2. Reload: the request and the reply are still there, once each.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-jarvis-thread] li[data-entry="reply"]', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  // Counted against what the thread held before this run (the synthetic thread keeps earlier runs).
  const asks = (await userBubbles(page, ASK)) - asksBefore;
  const reloaded = await replies(page);
  const newReplies = reloaded.length - before;
  checks.push({ name: "persists across reload, once each", ok: asks === 1 && newReplies === 1 && reloaded.at(-1) === afterSend.at(-1), detail: `new request x${asks}; new reply x${newReplies}` });
  await page.screenshot({ path: join(out, "2-after-reload.png") });

  // 3. A research task: on this synthetic hub Jev answers "nothing ran" (no key), and that reply is saved; then a running job of Dot's in its
  //    thread shows as a job card, and Stop works.
  await send(page, RESEARCH);
  await page.waitForTimeout(4_000);
  const researchReply = (await replies(page)).at(-1) ?? "";
  seedRunningDotJob(RESEARCH);
  await page.reload({ waitUntil: "domcontentloaded" });
  const stop = page.locator("[data-stop-job]").last();
  const appeared = await stop.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: join(out, "3-job-card.png") });
  let stopped = "";
  if (appeared) {
    await stop.click();
    await page.waitForFunction(() => /Stopped|already|Stop requested/i.test(document.querySelector("[data-jarvis-thread]")?.textContent ?? ""), undefined, { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);
    stopped = (await page.locator("[data-jarvis-thread] [role=status]").allTextContents()).join(" | ") || ((await page.locator("[data-jarvis-thread]").textContent()) ?? "").match(/Stopped[^.]*\./)?.[0] || "";
  }
  checks.push({ name: "job card and Stop", ok: appeared && /Stopped/i.test(stopped), detail: `${appeared ? `stop said: ${stopped.slice(0, 160)}` : "no job card with Stop appeared"}; research reply on this hub: ${researchReply.slice(0, 120)}` });
  await page.screenshot({ path: join(out, "4-stopped.png") });

  const pageErrors = [...consoleErrors]; // step 4 asks for refused routes on purpose
  // 4. No founder thread is readable through the gateway (the browser's own requests, not the page's remap).
  const founderId = jarvisThreadId("usman");
  // XMLHttpRequest from the signed-in page: Dot's real session, and not the page's fetch remap.
  const xhr = (path: string) => page.evaluate((u) => new Promise<{ status: number; body: string }>((res) => { const x = new XMLHttpRequest(); x.open("GET", u); x.onload = () => res({ status: x.status, body: x.responseText }); x.onerror = () => res({ status: 0, body: "" }); x.send(); }), path);
  const raw: Array<readonly [string, number]> = [];
  for (const p of ["/__operator/conversations", `/__operator/screen/command/thread?conversation=${founderId}&after=0`, `/__operator/conversations/${founderId}`]) raw.push([p, (await xhr(p)).status] as const);
  const ownRes = await xhr(`/__gateway/ui/jarvis/thread?conversation=${founderId}`);
  const own = JSON.parse(ownRes.body || "{}") as { conversationId?: string; conversations?: Array<{ id: string }> };
  checks.push({ name: "no founder thread readable", ok: raw.every(([, s]) => s === 401 || s === 403 || s === 404) && own.conversationId === jarvisThreadId("dot") && (own.conversations ?? []).every((c) => c.id === jarvisThreadId("dot")), detail: `${raw.map(([p, s]) => `${p.split("?")[0]} ${s}`).join("; ")}; adapter answers Dot's thread only` });
  checks.push({ name: "no console errors from the page", ok: pageErrors.length === 0, detail: pageErrors.slice(0, 3).join(" | ") || "none" });
  await browser.close();
  return checks;
}

if (import.meta.main) {
  const checks = await runCheck();
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

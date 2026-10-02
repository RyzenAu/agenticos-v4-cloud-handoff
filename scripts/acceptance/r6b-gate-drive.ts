#!/usr/bin/env bun
/**
 * Round 6b: what a release-gate verifier could not see, driven with REAL clicks and keys in a real (headless Chrome) browser against an ISOLATED hub
 * seeded by seed-gate-hub.ts (never the live hub). Evidence is printed and written next to the screenshots; no key, token, cookie or environment value
 * is printed.
 *
 *   bun scripts/acceptance/r6b-gate-drive.ts --scenario activity | computers-none | computers-unreachable | computers-ryzen | peek
 *        [--hub http://127.0.0.1:8153] [--out <folder>] [--data <seeded data folder>] [--label "real LAN host"]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const scenario = arg("scenario", "peek");
const hub = arg("hub", "http://127.0.0.1:8153");
const out = arg("out", "D:\\AgenticOS-r6-data\\gate-out");
const dataDir = arg("data", "D:\\AgenticOS-r6-data\\gate-none");
const label = arg("label", "synthetic");
if (/:8081\b/.test(hub)) throw new Error("not the live hub");
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, data: unknown) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, data });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}: ${JSON.stringify(data).slice(0, 1400)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const marker = () => JSON.parse(readFileSync(join(dataDir, ".gate-seed.json"), "utf8")) as { jobs: { key: string; jobId: string; title: string; state: string }[] };
const SIZES = [{ w: 1440, h: 900, tag: "d" }, { w: 390, h: 844, tag: "m" }] as const;

let ctx: BrowserContext;
let token = "";
async function start() {
  ctx = await chromium.launchPersistentContext(arg("profile", "D:\\AgenticOS-r6-data\\gate-profile"), { channel: "chrome", headless: true, reducedMotion: "reduce" });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(`${hub}/`, { waitUntil: "domcontentloaded" });
  const me = await p.evaluate(async () => (await (await fetch("/__devices/me")).json()) as { principal?: { actor?: string } });
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  token = await p.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  return p;
}
async function api(p: Page, method: string, path: string, body?: unknown) {
  return p.evaluate(async ([m, u, b, t]) => {
    const res = await fetch(u as string, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text: text.slice(0, 3000) };
  }, [method, path, body ?? null, token] as unknown[] as [string, string, unknown, string]);
}
async function shot(p: Page, file: string) {
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(out, file) });
}
/** Is the keyboard focus ring visible on the focused element right now? */
const focusRing = (p: Page) => p.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return { focused: false };
  const cs = getComputedStyle(el);
  const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== "") ;
  return { focused: true, tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), ringVisible: visible, matchesFocusVisible: el.matches(":focus-visible") };
});

async function peek() {
  const p = await start();
  for (const path of ["/chat", "/activity", "/computers"]) {
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.goto(`${hub}${path}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4000);
    await shot(p, `peek${path.replace("/", "-")}.png`);
    log(`peek ${path}`, (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 900));
  }
}

/** The Activity "Open job" links and the saved results, clicked for real from the conversation. */
async function activity() {
  const p = await start();
  const jobs = marker().jobs;
  const random = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
  for (const size of SIZES) {
    await p.setViewportSize({ width: size.w, height: size.h });
    await p.goto(`${hub}/chat`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4500);
    const results: unknown[] = [];
    for (const j of jobs) {
      const id8 = j.jobId.slice(0, 8);
      await p.goto(`${hub}/chat`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(3500);
      const link = p.getByRole("button", { name: `Open job ${id8}` }).first();
      if (!(await link.count())) { results.push({ key: j.key, id8, link: "no Open job link (this job has no conversation entry that offers one)" }); continue; }
      await link.scrollIntoViewIfNeeded();
      await link.click(); // a real click
      await p.waitForURL(new RegExp(`/activity#job-${j.jobId}`), { timeout: 15_000 });
      await p.waitForSelector('[data-testid="selected-job"]', { timeout: 15_000 });
      await p.waitForTimeout(1200);
      const seen = await p.evaluate((id) => {
        const el = document.querySelector('[data-testid="selected-job"]') as HTMLElement | null;
        const r = el?.getBoundingClientRect();
        return { hash: location.hash, label: el?.getAttribute("aria-label"), top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null, innerHeight, inView: !!r && r.top >= 0 && r.top < innerHeight * 0.6, rowMarked: document.querySelectorAll('tr[data-selected="true"]').length, rowIdMatches: !!document.getElementById("job-" + id), title: el?.querySelector("h2")?.textContent, badge: (el?.querySelector("h2 + *") as HTMLElement | null)?.innerText, savedResultLink: !![...(el?.querySelectorAll("a") ?? [])].find((a) => /Open saved result/.test(a.textContent ?? "")) };
      }, j.jobId);
      results.push({ key: j.key, id8, expectState: j.state, ...seen, landedOnThatJob: seen.hash === `#job-${j.jobId}` && seen.label === `Job ${id8}` && seen.inView && seen.rowIdMatches });
      if (["result-audit", "failed", "running"].includes(j.key)) await shot(p, `activity-${size.tag}-open-job-${j.key}.png`);
    }
    log(`Activity: every Open job link, clicked, at ${size.w} px (${label})`, results);
    // a job id that does not exist says so plainly
    await p.goto(`${hub}/activity#job-${random}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4000);
    log(`Activity: a job id that does not exist, at ${size.w} px`, { text: (await p.evaluate(() => (document.querySelector('[role="status"], [data-testid="activity-jobs"]') as HTMLElement | null)?.innerText ?? document.body.innerText)).replace(/\s+/g, " ").slice(0, 300), notice: await p.getByText(/isn.t in the job history/).count() });
    await shot(p, `activity-${size.tag}-missing-job.png`);
    // result entries in the conversation open their saved artifact (a new tab)
    await p.goto(`${hub}/chat`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4000);
    const opened: unknown[] = [];
    for (const j of jobs.filter((x) => x.key.startsWith("result-"))) {
      const id8 = j.jobId.slice(0, 8);
      const entry = p.locator(`a:has-text("Open saved result")`).filter({ has: p.locator("xpath=self::*") });
      const hrefs = await p.locator('a[href^="/__computers/artifacts/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
      const mine = p.locator(`a[href="/__computers/artifacts/${j.jobId}"]`).first();
      void entry; void hrefs;
      await mine.scrollIntoViewIfNeeded();
      const [popup] = await Promise.all([ctx.waitForEvent("page"), mine.click()]);
      await popup.waitForLoadState("domcontentloaded");
      await popup.setViewportSize({ width: size.w, height: size.h });
      await popup.waitForTimeout(800);
      opened.push({ key: j.key, id8, url: popup.url().replace(hub, ""), title: await popup.title(), h1: await popup.locator("h1").first().textContent(), body: (await popup.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 160) });
      if (j.key === "result-audit" || j.key === "result-research") await popup.screenshot({ path: join(out, `activity-${size.tag}-saved-${j.key}.png`) });
      await popup.close();
    }
    log(`Conversation result entries open their saved artifact, at ${size.w} px`, opened);
    // keyboard: Tab to an Open job button, see the focus ring, press Enter
    await p.goto(`${hub}/chat`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4000);
    await p.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    let ring: unknown = null;
    for (let i = 0; i < 500; i++) {
      await p.keyboard.press("Tab");
      const f = await focusRing(p);
      if ((f as { name?: string }).name?.startsWith("Open job")) { ring = f; break; }
    }
    if (ring) {
      await p.keyboard.press("Enter");
      await p.waitForURL(/\/activity#job-/, { timeout: 10_000 }).catch(() => undefined);
    }
    log(`Keyboard: Tab reaches an Open job link, focus ring, Enter opens the job, at ${size.w} px`, { ring, landed: p.url().replace(hub, "") });
  }
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The Computers page when the hub has no host, or a host that cannot be reached: what it says, with nothing to click that would mislead. */
async function computersRefusal() {
  const p = await start();
  for (const size of SIZES) {
    await p.setViewportSize({ width: size.w, height: size.h });
    await p.goto(`${hub}/computers`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(5000);
    const card = p.locator('[data-testid="add-computer"]');
    const host = await api(p, "GET", "/__computers/host");
    log(`Computers (${label}) at ${size.w} px: the add control`, {
      text: flat(await card.innerText()).slice(0, 700),
      createButton: await p.getByRole("button", { name: /Create Research and Builder/ }).count(),
      addButton: await p.getByRole("button", { name: "Add computer" }).count(),
      hostApi: (host.json.adapters ?? []).map((a: { kind: string; check: { ok: boolean; host: string; notes?: string[] } }) => ({ kind: a.kind, ok: a.check.ok, host: a.check.host, notes: a.check.notes })),
    });
    await shot(p, `computers-${size.tag}-${arg("tag", "refusal")}.png`);
  }
  // If a host is configured but down, a create attempt (through the same API the button uses) must fail in plain words.
  const attempt = await api(p, "POST", "/__computers", { name: "research", adapter: "vps-ssh", label: "Research" });
  log(`A create attempt through the API the button uses (${label})`, { status: attempt.status, text: flat(attempt.text).slice(0, 400) });
  const list = await api(p, "GET", "/__computers");
  log("Computers after the attempt", { count: (list.json.computers ?? []).length, states: (list.json.computers ?? []).map((c: { name: string; state: string; failure?: unknown }) => ({ name: c.name, state: c.state, failure: c.failure })) });
}

const names = async (p: Page) => ((await api(p, "GET", "/__computers")).json.computers ?? []).map((c: { name: string }) => c.name).sort();
const buttons = (p: Page) => p.evaluate(() => [...document.querySelectorAll("main button, main a, [data-testid] button")].map((b) => (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 60));

/** The Computers page against the real Ryzen-PC: the picker, the one-click pair (double-clicked), then every control a computer offers. */
async function computersReal() {
  const p = await start();
  const size0 = SIZES.find((z) => z.tag === arg("size", "d")) ?? SIZES[0];
  const keyboard = arg("activate", "mouse") === "keyboard";
  await p.setViewportSize({ width: size0.w, height: size0.h });
  await p.goto(`${hub}/computers`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid^="host-ready"], [data-testid^="host-problem"]', { timeout: 120_000 });
  const card = p.locator('[data-testid="add-computer"]');
  log(`Host picker (${label})`, { text: flat(await card.innerText()).slice(0, 600), before: await names(p) });
  await shot(p, `computers-${size0.tag}-1-host-picker.png`);
  const pair = p.getByRole("button", { name: /Create Research and Builder on/ });
  // a REAL double click: two clicks 30 ms apart on the same button
  if (keyboard) {
    // keyboard only: Tab to the radio and the button, see the focus ring, then press Enter twice quickly
    await pair.focus();
    log("Pair button focused by keyboard", await focusRing(p));
    await shot(p, `computers-${size0.tag}-1b-pair-focus.png`);
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
  } else await pair.dblclick({ delay: 30 });
  await p.waitForTimeout(700);
  log("Right after the double click", { creatingNotice: await p.getByText(/Creating Research and Builder/).count(), pairButtonDisabled: await pair.isDisabled().catch(() => "gone"), names: await names(p) });
  await shot(p, `computers-${size0.tag}-2-creating.png`);
  await p.getByText("Created", { exact: true }).waitFor({ timeout: 240_000 }).catch(() => undefined);
  await p.waitForTimeout(1500);
  log("After creation", { names: await names(p), doneNotice: flat(await card.innerText()).slice(-200), pairButton: await pair.count() });
  await shot(p, `computers-${size0.tag}-3-created.png`);
  log("Controls on the page", await buttons(p));
}

const view = async (p: Page, name: string) => ((await api(p, "GET", "/__computers")).json.computers ?? []).find((c: { name: string }) => c.name === name);
const until = async <T>(what: string, fn: () => Promise<T>, ms = 60_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
};
const jobState = async (p: Page, id: string) => (await api(p, "GET", `/__computers/jobs/${id}`)).json.job?.state as string | undefined;
/** A request that is a PROGRAM's (no session cookie, only the page token): a person's controls are not a program's. */
const asProgram = async (path: string, body: unknown) => {
  const r = await fetch(`${hub}${path}`, { method: "POST", headers: { host: new URL(hub).host, "content-type": "application/json", "x-claude-os-token": token }, body: JSON.stringify(body) });
  return { status: r.status, text: (await r.text()).slice(0, 160) };
};

/** Every control a created computer offers, used for real: viewer, input only for the holder, takeover and hand-back, Stop, Start, keyboard and focus. */
async function computersControls() {
  const p = await start();
  for (const size of SIZES) {
    const tag = size.tag;
    await p.setViewportSize({ width: size.w, height: size.h });
    await p.goto(`${hub}/computers`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#computer-research", { timeout: 60_000 });
    const card = p.locator("#computer-research");
    const btn = (name: string | RegExp) => card.getByRole("group", { name: /Actions for/ }).getByRole("button", typeof name === "string" ? { name, exact: true } : { name });
    await card.scrollIntoViewIfNeeded();
    await p.waitForTimeout(5000);
    log(`[${size.w}px] The computer card as it opens (${label})`, { headline: flat(await card.locator('[data-testid="workspace-headline"]').innerText()), text: flat(await card.innerText()).slice(0, 420), viewerFrame: await card.locator("iframe").count(), isolation: flat(await p.locator('[data-testid="isolation-sentence"]').innerText()) });
    await shot(p, `computers-${tag}-4-card-viewer.png`);

    // input is the holder's only
    const noLease = await api(p, "POST", "/__computers/research/input", { executor: "file.write", args: { name: "gate-noholder.txt", text: "x" } });
    log(`[${size.w}px] Input without the control lease`, { status: noLease.status, error: noLease.json.error });
    await btn("Take control").click();
    await until("the person to hold the computer", async () => (await view(p, "research"))?.controller?.kind === "person");
    await p.waitForTimeout(1500);
    const holder = await api(p, "POST", "/__computers/research/input", { executor: "file.write", args: { name: "gate-holder.txt", text: "written by the holder" } });
    const program = await asProgram("/__computers/research/input", { executor: "file.write", args: { name: "gate-program.txt", text: "x" } });
    log(`[${size.w}px] After Take control: only the holder's input is accepted`, { cardSays: flat(await card.locator("[data-fact=controller]").innerText()), liveViewText: (flat(await card.innerText()).match(/Live view[^.]*\./) ?? [""])[0], holderInput: holder.status, programInput: program }
    );
    await shot(p, `computers-${tag}-5-holding.png`);
    await btn("Return to agent").click();
    await until("control returned", async () => (await view(p, "research"))?.controller?.kind === null || (await view(p, "research"))?.controller?.kind === "none");
    log(`[${size.w}px] Return to agent`, { controller: (await view(p, "research")).controller });

    // an agent holds the builder: request control, hold, hand back (the job resumes), no replay
    const j = await api(p, "POST", "/__computers/builder/jobs", { agent: "gate", title: "gate hand-back check", steps: [1, 2, 3, 4].map(() => ({ executor: "wait", args: { ms: 6000 } })) });
    const bcard = p.locator("#computer-builder");
    await bcard.scrollIntoViewIfNeeded();
    await bcard.getByRole("button", { name: "Request control" }).waitFor({ timeout: 30_000 });
    await bcard.getByRole("button", { name: "Request control" }).click();
    await until("the agent to hand over", async () => (await view(p, "builder"))?.controller?.kind === "person", 60_000);
    const stepsAtPause = (await api(p, "GET", `/__computers/jobs/${j.json.jobId}`)).json.job.steps.length;
    await p.waitForTimeout(8000);
    const stepsLater = (await api(p, "GET", `/__computers/jobs/${j.json.jobId}`)).json.job.steps.length;
    await shot(p, `computers-${tag}-6-takeover.png`);
    log(`[${size.w}px] Request control mid-job, then hold`, { jobState: await jobState(p, j.json.jobId), stepsAtPause, stepsAfter8s: stepsLater, paused: stepsLater <= stepsAtPause + 1 });
    await bcard.getByRole("button", { name: "Return to agent" }).first().click();
    await until("the job to finish", async () => ["succeeded", "failed", "cancelled", "unknown"].includes((await jobState(p, j.json.jobId)) ?? ""), 120_000);
    log(`[${size.w}px] Hand-back: the same job resumes and finishes (no replay)`, { state: await jobState(p, j.json.jobId), stepLines: (await api(p, "GET", `/__computers/jobs/${j.json.jobId}`)).json.job.steps.map((s: { intent: string }) => s.intent.slice(0, 70)).slice(-4) });

    // Stop (with its confirmation) on a busy computer, then Start again
    const jr = await api(p, "POST", "/__computers/research/jobs", { agent: "gate", title: "gate stop check", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: "gate-never.txt", text: "must not exist" } }] });
    await until("research busy", async () => (await view(p, "research"))?.state === "busy" || (await jobState(p, jr.json.jobId)) === "running");
    await btn("Stop").click();
    const confirmText = flat(await card.locator('[role=group][aria-label="Confirm stop"]').innerText());
    await shot(p, `computers-${tag}-7-stop-confirm.png`);
    await btn("Yes, stop it").click();
    await until("research stopped", async () => ["stopped", "offline"].includes((await view(p, "research"))?.state));
    const files = await api(p, "POST", "/__computers/research/input", { executor: "file.write", args: { name: "gate-after-stop.txt", text: "x" } });
    log(`[${size.w}px] Stop (confirm first), nothing runs afterwards`, { confirmText, computerState: (await view(p, "research")).state, jobState: await jobState(p, jr.json.jobId), inputToStopped: files.status });
    await shot(p, `computers-${tag}-8-stopped.png`);
    await btn(/^Start$/).click();
    await until("research online again", async () => (await view(p, "research"))?.state === "online", 120_000);
    log(`[${size.w}px] Start again`, { state: (await view(p, "research")).state });

    // keyboard: Tab through the card's actions, every one shows a focus ring; Enter activates; the Stop confirmation is operable and cancellable by keyboard
    await card.getByRole("group", { name: /Actions for/ }).getByRole("button").first().focus();
    const walk: unknown[] = [await focusRing(p)];
    for (let i = 0; i < 8; i++) {
      await p.keyboard.press("Tab");
      walk.push(await focusRing(p));
    }
    const inGroup = (walk as { name?: string; ringVisible?: boolean }[]).filter((w) => w.name);
    log(`[${size.w}px] Keyboard: Tab through the controls, focus ring on each`, { stops: inGroup.map((w) => `${w.name}${w.ringVisible ? " ✓ring" : " ✗NO RING"}`), allRingsVisible: inGroup.every((w) => w.ringVisible) });
    await btn("Stop").focus();
    await p.keyboard.press("Enter");
    const confirmShown = await card.locator('[role=group][aria-label="Confirm stop"]').count();
    await card.getByRole("button", { name: "Keep it" }).focus();
    const ringKeep = await focusRing(p);
    await p.keyboard.press("Enter");
    log(`[${size.w}px] Keyboard: Stop opens its confirmation, Keep it cancels, nothing stopped`, { confirmShown, ringKeep, confirmGone: (await card.locator('[role=group][aria-label="Confirm stop"]').count()) === 0, state: (await view(p, "research")).state });
    log(`[${size.w}px] Delete / remove`, { offeredOnThePage: await card.getByRole("button", { name: /delete|remove|destroy/i }).count() });
    await shot(p, `computers-${tag}-9-keyboard.png`);
  }
}

/** Removes every computer this run made (API only: the page offers no Delete). */
async function teardown() {
  const p = await start();
  for (const c of (await api(p, "GET", "/__computers")).json.computers ?? []) {
    const r = await api(p, "POST", `/__computers/${c.name}/action`, { action: "destroy" });
    log(`Destroyed ${c.name}`, { status: r.status, error: r.json.error });
  }
  log("Computers left", ((await api(p, "GET", "/__computers")).json.computers ?? []).map((c: { name: string }) => c.name));
}

async function main() {
  const fns: Record<string, () => Promise<void>> = { peek, activity, "computers-none": computersRefusal, "computers-unreachable": computersRefusal, "computers-ryzen": computersReal, "computers-controls": computersControls, teardown };
  if (!fns[scenario]) throw new Error("unknown scenario");
  try {
    await fns[scenario]();
  } finally {
    writeFileSync(join(out, `evidence-${scenario}.json`), JSON.stringify({ label, evidence }, null, 2));
    await ctx?.close().catch(() => undefined);
  }
}
void marker; void sleep; void focusRing; void api; void SIZES;
main().catch((e) => { console.error(e); process.exit(1); });

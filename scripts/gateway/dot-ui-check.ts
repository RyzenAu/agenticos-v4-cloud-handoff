#!/usr/bin/env bun
/**
 * The OS pages as Dot sees them through the gateway, in a real (headless) browser, on the LOCAL SYNTHETIC staging pair only
 * (scripts/gateway/staging-local.ts with --ui). Never the live hub, never Ryzen.
 *
 *   bun scripts/gateway/dot-ui-check.ts [--data D:\AgenticOS-r11-data\gw3] [--gateway-port 8195] [--out <folder>] [--json <file>]
 *
 * It mints a SYNTHETIC enrolment code in-process against the synthetic data folder, grants the operating set until the
 * identity ends, signs in through the gateway's own sign-in page, then visits each page, records every /__ request the page
 * makes (method, path TEMPLATE, status), the console errors, and whether the page shows data or a clear "not available"
 * state, and saves a screenshot. No code, key, token, cookie or body is written anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { runCli } from "./cli";
import { gatewayDir } from "./config";
import { pathTemplate } from "./server";

const argv = process.argv.slice(2);
const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
const repo = resolve(import.meta.dir, "..", "..");
const data = resolve(arg("data", "D:\\AgenticOS-r11-data\\gw3"));
const port = Number(arg("gateway-port", "8195"));
const out = resolve(repo, arg("out", "docs/programme-20261001/evidence-notes/dot-ui"));
const jsonOut = resolve(arg("json", join(data + "-side", "dot-ui-routes.json")));
if (!/AgenticOS-r\d+-data/i.test(data) || !(port >= 8120 && port <= 8199)) throw new Error("Refusing: this runs only against the local synthetic pair (an AgenticOS-r<N>-data folder, a port in 8120-8199).");
const origin = `http://127.0.0.1:${port}`;

/** status 0 = answered in the browser as "Not available to Dot" (src/lib/dot-gateway.ts), never sent. */
export type SeenRequest = { page: string; method: string; template: string; status: number; reason?: string };
export type PageResult = { page: string; path: string; requests: SeenRequest[]; consoleErrors: string[]; shows: "data" | "not-available" | "empty"; notAvailable: string; screenshot: string };

const PAGES: Array<{ name: string; path: string | ((ids: Ids) => string) }> = [
  { name: "Home", path: "/" },
  { name: "Jarvis", path: "/jarvis" },
  { name: "Departments", path: "/agents/workspace" },
  { name: "Departments: Research", path: "/agents/workspace/research" },
  { name: "Work", path: "/work" },
  { name: "CRM: Today", path: "/crm?view=today" },
  { name: "CRM: Companies", path: "/crm?view=companies" },
  { name: "CRM: a company", path: (ids) => `/crm?ref=${encodeURIComponent(`crm:company:${ids.company}`)}&tab=overview` },
  { name: "Leads", path: "/leads" },
  { name: "Finance", path: "/finance" },
  { name: "Inbox", path: "/inbox" },
  { name: "Inbox triage", path: "/inbox-triage" },
  { name: "Calendar", path: "/calendar" },
  { name: "Agents workspace", path: "/agents/workspace" },
  { name: "Activity", path: "/activity" },
  { name: "Coding", path: "/coding/" },
  { name: "Coding: a job", path: (ids) => `/coding/${ids.job}` },
  { name: "Memory", path: "/memory" },
  { name: "System", path: "/system" },
];
type Ids = { company: string; job: string };

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
  runCli(["enrol-code", "--by", "usman", "--label", "Dot (UI check)", "--identity-days", "1"], dir, (l) => lines.push(l));
  const code = /code for Dot: ([A-Z0-9-]+)/.exec(lines.join("\n"))?.[1];
  if (!code) throw new Error("no synthetic code was minted");
  runCli(["grant", "operate", "--by", "usman", "--until-identity"], dir, () => undefined);
  runCli(["authorise-mailbox", "hello@synthetic.example", "--by", "usman"], dir, () => undefined);
  await page.goto(`${origin}/gw/enrol#code=${code}`);
  await page.click("#go");
  await page.waitForSelector("#cont", { timeout: 15_000 });
  await page.click("#cont");
  await page.waitForLoadState("domcontentloaded");
}

async function idsFrom(page: Page): Promise<Ids> {
  return await page.evaluate(async () => {
    const token = (await (await fetch("/__token")).json()).token as string;
    const r = await fetch("/__gateway/crm/read", { method: "POST", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token }, body: JSON.stringify({ name: "crm.companies.query", input: {} }) });
    const companies = ((await r.json())?.data?.items ?? (await Promise.resolve([]))) as Array<{ id: string }>;
    const jobs = ((await (await fetch("/__operator/coding/jobs")).json())?.jobs ?? []) as Array<{ id: string }>;
    return { company: companies[0]?.id ?? "unknown", job: jobs[0]?.id ?? "unknown" };
  });
}

/** What the page shows besides the gateway's notice: its own content (data), only the "not available to Dot" state, or nothing. */
async function shows(page: Page): Promise<{ shows: PageResult["shows"]; notAvailable: string }> {
  const notice = (await page.locator("[data-testid=dot-gateway-notice]").first().innerText({ timeout: 1_000 }).catch(() => "")).trim();
  const main = (await page.locator("main").first().innerText({ timeout: 2_000 }).catch(() => "")) || (await page.locator("body").innerText().catch(() => ""));
  const rest = main.replace(notice, "").replace(/\s+/g, " ").trim();
  const notAvailable = (await page.locator("[data-testid=dot-not-available] li").allTextContents().catch(() => [] as string[])).join("; ");
  if (rest.length > 80) return { shows: "data", notAvailable };
  return { shows: /not available to Dot/i.test(main) ? "not-available" : "empty", notAvailable };
}

export async function runCheck(): Promise<PageResult[]> {
  mkdirSync(out, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  // The requests the page's guard answered itself as not available (never sent): collected per page.
  await context.addInitScript(() => {
    const w = window as unknown as { __dotRefused: Array<{ method: string; path: string; reason: string }> };
    w.__dotRefused = [];
    window.addEventListener("dot-gateway-refusal", (e) => {
      const d = (e as CustomEvent).detail ?? {};
      w.__dotRefused.push({ method: String(d.method), path: String(d.path), reason: String(d.reason) });
    });
  });
  const page = await context.newPage();
  await signIn(page);
  const ids = await idsFrom(page);
  const results: PageResult[] = [];
  for (const p of PAGES) {
    const path = typeof p.path === "string" ? p.path : p.path(ids);
    const requests: SeenRequest[] = [];
    const consoleErrors: string[] = [];
    const onResponse = (res: import("playwright-core").Response) => {
      const u = new URL(res.url());
      if (u.origin === origin && u.pathname.startsWith("/__")) requests.push({ page: p.name, method: res.request().method(), template: pathTemplate(u.pathname), status: res.status() });
    };
    const onConsole = (m: import("playwright-core").ConsoleMessage) => {
      if (m.type() === "error") consoleErrors.push(m.text().replace(/https?:\/\/127\.0\.0\.1:\d+/g, "").slice(0, 200));
    };
    page.on("response", onResponse);
    page.on("console", onConsole);
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(4_500);
    const local = (await page.evaluate(() => (window as unknown as { __dotRefused?: Array<{ method: string; path: string; reason: string }> }).__dotRefused ?? []).catch(() => [])) as Array<{ method: string; path: string; reason: string }>;
    for (const r of local) requests.push({ page: p.name, method: r.method, template: pathTemplate(r.path), status: 0, reason: r.reason });
    const file = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
    await page.screenshot({ path: join(out, file), fullPage: false }).catch(() => undefined);
    results.push({ page: p.name, path: path.replace(/ref=[^&]+/, "ref=<company>").replace(/\/coding\/[0-9a-f-]{36}/, "/coding/<job>"), requests, consoleErrors, screenshot: `docs/programme-20261001/evidence-notes/dot-ui/${file}`, ...(await shows(page)) });
    page.off("response", onResponse);
    page.off("console", onConsole);
  }
  await browser.close();
  return results;
}

if (import.meta.main) {
  const results = await runCheck();
  mkdirSync(resolve(jsonOut, ".."), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  for (const r of results) {
    const refused = r.requests.filter((q) => q.status === 401 || q.status === 403);
    const local = r.requests.filter((q) => q.status === 0);
    console.log(`${r.page.padEnd(24)} ${r.shows.padEnd(13)} requests ${String(r.requests.length - local.length).padStart(3)}  refused by server ${refused.length}  not available (in page) ${local.length}  console errors ${r.consoleErrors.length}`);
    for (const q of refused) console.log(`    REFUSED ${q.method} ${q.template} ${q.status}`);
  }
  console.log(`Wrote ${jsonOut}`);
}

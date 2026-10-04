/**
 * Round 7 acceptance (worker H): shared helpers for the browser journeys in this folder.
 *
 * Every check records PASS / FAIL / BLOCKED / NOT RUN / OUT OF SCOPE with its evidence. A check passes only on a PERSISTED effect: a re-read
 * after reload, a second browser, or the app's own API, never on a toast, an HTTP 200 alone or a screenshot. No cookie, token, key or
 * environment value is printed or written: the page token lives only inside the browser and in memory for the request it signs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { hubArgsFor } from "./hub-env";

export type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "OUT OF SCOPE";
export type Check = { row: string; check: string; status: Status; evidence: unknown; at: string };

const argv = process.argv.slice(2);
export const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
export const HUB = arg("hub", "http://127.0.0.1:8128");
export const OUT = arg("out", "D:\\AgenticOS-r7-data\\h-out");
export const DATA = arg("data", "D:\\AgenticOS-r7-data\\h");
if (/:8081\b|ts\.net|ryzen/i.test(HUB) || !/^http:\/\/127\.0\.0\.1:81[2-9]\d$/.test(HUB)) throw new Error(`Refusing ${HUB}: acceptance scripts only drive a synthetic hub on 127.0.0.1:8120-8199.`);
mkdirSync(OUT, { recursive: true });
/** This run's own hub, for a journey that stops or restarts it (see hubArgsFor). */
export const hubArgs = (): string[] => hubArgsFor(HUB, DATA, arg("repo"));

export const SIZES = [
  { w: 1440, h: 900, tag: "1440" },
  { w: 834, h: 1112, tag: "834" },
  { w: 390, h: 844, tag: "390" },
] as const;

const t0 = Date.now();
// Never hard-kill a run: a killed Chromium can lose a rotated session cookie, and the owner's browser then comes back PENDING (seen once).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void closeAll().finally(() => process.exit(130)));
export const checks: Check[] = [];
export function record(row: string, check: string, status: Status, evidence: unknown) {
  const c = { row, check, status, evidence, at: `+${((Date.now() - t0) / 1000).toFixed(1)}s` };
  checks.push(c);
  console.log(`[${c.at}] ${status.padEnd(8)} ${row} · ${check} :: ${JSON.stringify(evidence).slice(0, 600)}`);
  return status === "PASS";
}
/** PASS when ok, otherwise FAIL; returns ok. */
export const expect = (row: string, check: string, ok: boolean, evidence: unknown) => record(row, check, ok ? "PASS" : "FAIL", evidence);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const flat = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export async function until<T>(what: string, fn: () => Promise<T>, ms = 30_000, every = 400): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null as T | null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

let browser: Browser | null = null;
/** A real Chromium: Playwright's bundled build, else the installed Chrome. One browser at a time (other workers run browsers too). */
export async function launch(): Promise<Browser> {
  if (browser) return browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  }
  return browser;
}
export async function closeAll() {
  await owner?.close().catch(() => undefined);
  owner = null;
  await browser?.close().catch(() => undefined);
  browser = null;
}

export type Session = { ctx: BrowserContext; page: Page; token: () => Promise<string>; errors: string[] };
/**
 * The OWNER's browser: one persistent profile beside the data folder. On a freshly seeded hub the first hub session is trusted on first use
 * (docs/IDENTITY-ROUTES.md S1), so `hub.ts start` opens this profile first; every later run reuses its confirmed cookie. A new profile
 * (session({ fresh: true })) is a PENDING browser until a confirmed one gives it a code (journey B).
 */
export const OWNER_PROFILE = `${DATA}-side\\owner-profile`;
let owner: BrowserContext | null = null;
export async function session(size: { w: number; h: number } = SIZES[0], opts: { fresh?: boolean; origin?: string } = {}): Promise<Session> {
  let ctx: BrowserContext;
  if (opts.fresh) {
    const b = await launch();
    ctx = await b.newContext({ viewport: { width: size.w, height: size.h }, reducedMotion: "reduce" });
  } else {
    if (!owner) {
      try {
        owner = await chromium.launchPersistentContext(OWNER_PROFILE, { headless: true, viewport: { width: size.w, height: size.h }, reducedMotion: "reduce" });
      } catch {
        owner = await chromium.launchPersistentContext(OWNER_PROFILE, { headless: true, viewport: { width: size.w, height: size.h }, reducedMotion: "reduce", executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
      }
    }
    ctx = owner;
  }
  const page = ctx.pages()[0] && !opts.fresh && ctx.pages().length === 1 && ctx.pages()[0].url() === "about:blank" ? ctx.pages()[0] : await ctx.newPage();
  await page.setViewportSize({ width: size.w, height: size.h });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(`${opts.origin ?? HUB}/`, { waitUntil: "domcontentloaded" });
  if (!opts.fresh && !process.argv[1]?.endsWith("hub.ts")) {
    const who = await me(page);
    if (who.actor !== "human") console.log(`WARNING: the owner browser is ${who.actor ?? "nobody"} (pending ${who.pending}), not a confirmed session; results needing a person will fail. Re-seed: bun scripts/acceptance/r7/hub.ts reset`);
  }
  const token =async () => page.evaluate(async () => ((await (await fetch("/__token")).json()) as { token?: string }).token ?? "");
  return { ctx, page, token, errors };
}

/** A request from inside the page (same origin, its own cookie and page token). Returns status and JSON; never the token. */
export async function api(p: Page, method: string, path: string, body?: unknown) {
  return p.evaluate(
    async ([m, u, b]) => {
      // The page token goes on every request, as the app sends it (some GETs, e.g. /__commands, check it too).
      const t = ((await (await fetch("/__token")).json()) as { token?: string }).token ?? "";
      const res = await fetch(u as string, { method: m as string, headers: { "content-type": "application/json", ...(t ? { "x-claude-os-token": t } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, json, text: text.slice(0, 2000) };
    },
    [method, path, body ?? null] as [string, string, unknown],
  );
}

/** Who the hub thinks this browser is (actor human = a confirmed session). */
export async function me(p: Page) {
  const r = await api(p, "GET", "/__devices/me");
  const j = r.json ?? {};
  return { status: r.status, actor: j.principal?.actor ?? null, via: j.principal?.via ?? null, person: j.principal?.personId ?? null, pending: j.hubSession?.pending ?? null };
}

export async function shot(p: Page, name: string) {
  await p.waitForTimeout(300);
  const file = join(OUT, `${name}.png`);
  await p.screenshot({ path: file }).catch(() => undefined);
  return file;
}

export const focusRing = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { focused: false as const };
    const cs = getComputedStyle(el);
    const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow !== "none" && cs.boxShadow !== "");
    return { focused: true as const, tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50), ring };
  });

/** The page's basic health: an h1, no error boundary, no horizontal overflow. */
export const pageHealth = (p: Page) =>
  p.evaluate(() => {
    const h1 = [...document.querySelectorAll("h1")].map((x) => (x.textContent ?? "").trim().slice(0, 60)).filter(Boolean);
    const text = document.body.innerText;
    const crashed = /Something went wrong|Unexpected Application Error|Cannot read propert|is not a function|Minified React error/i.test(text);
    return { title: document.title, h1, crashed, overflow: document.documentElement.scrollWidth > innerWidth + 1, scrollWidth: document.documentElement.scrollWidth, innerWidth };
  });

export function writeResults(name: string, meta: Record<string, unknown> = {}) {
  const tally: Record<string, number> = {};
  for (const c of checks) tally[c.status] = (tally[c.status] ?? 0) + 1;
  const file = join(OUT, `results-${name}.json`);
  writeFileSync(file, JSON.stringify({ name, hub: HUB, ranAt: new Date().toISOString(), ...meta, tally, checks }, null, 2));
  console.log(`\n${name}: ${JSON.stringify(tally)} -> ${file}`);
  return { tally, file };
}

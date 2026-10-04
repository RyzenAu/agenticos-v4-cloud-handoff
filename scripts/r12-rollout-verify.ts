#!/usr/bin/env bun
/**
 * R12 rollout: real interactions on a SYNTHETIC hub (scripts/r12-rollout-seed.ts), never the live 8081.
 *
 *   bun scripts/r12-rollout-verify.ts [port]
 *
 * Per page (PASS only on what the page itself shows after the action):
 *   - the header has exactly ONE accent (primary) action, and using it does what it says (a drawer opens, the URL changes, focus
 *     moves, or the request it makes is sent). Requests that would start real work (the model check, the receptionist re-read) are
 *     answered by the browser with a fixture, so nothing runs on the hub.
 *   - where records are opened: a row opens the shared detail drawer, the open record is in the URL, Escape closes it and clears it.
 *   - at 390 px there is no sideways page scroll.
 *   - keyboard focus on the primary action is visible (a ring or an outline).
 * Writes docs/programme-20261001/evidence/r12-rollout/verify.json and a few interaction screenshots in evidence/r12-rollout/verify/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { computerFixture, journeyFixture, routeJourneys } from "./r12-ui-fixtures";

const port = Number(process.argv[2] ?? 8161);
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
const base = `http://127.0.0.1:${port}`;
const out = join(import.meta.dir, "..", "docs", "programme-20261001", "evidence", "r12-rollout");
mkdirSync(join(out, "verify"), { recursive: true });
const fx = await journeyFixture(base);
const results: { page: string; check: string; status: "PASS" | "FAIL" | "N/A"; evidence: unknown }[] = [];
const record = (page: string, check: string, ok: boolean | null, evidence: unknown) => {
  const status = ok === null ? "N/A" : ok ? "PASS" : "FAIL";
  results.push({ page, check, status, evidence });
  console.log(`${status.padEnd(4)}  ${page} :: ${check} :: ${JSON.stringify(evidence).slice(0, 220)}`);
};
const settle = async (p: Page, ms = 1500) => {
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(ms);
};
const ACCENT = "header.ds-page-header .bg-brand";

type Effect = (p: Page) => Promise<{ ok: boolean; evidence: unknown }>;
type PageSpec = {
  name: string;
  path: string;
  setup?: (p: Page) => Promise<void>;
  /** The primary action's accessible name, and what using it must do. `null`: the page's primary action is not in the header (said why). */
  primary: { name: RegExp; effect: Effect } | { none: string };
  /** A row that opens a record, and the URL param (or hash) the open record is held in. */
  drawer?: { row: string; param?: string; hash?: RegExp; title?: boolean };
  noDrawer?: string;
};

const dialogOpen: Effect = async (p) => {
  const ok = await p.getByRole("dialog").first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  return { ok, evidence: { dialog: ok, url: p.url().replace(base, "") } };
};
const urlBecomes = (re: RegExp): Effect => async (p) => {
  const ok = await p.waitForURL(re, { timeout: 8000 }).then(() => true).catch(() => false);
  return { ok, evidence: { url: p.url().replace(base, "") } };
};
/** Every POST a page sent, collected from the moment it opened (a fast click can send before a waiter would be listening). */
const posts = new WeakMap<Page, string[]>();
const watchPosts = (p: Page) => {
  const list: string[] = [];
  posts.set(p, list);
  p.on("request", (r) => { if (r.method() === "POST") list.push(r.url()); });
};
const requestSent = (re: RegExp): Effect => async (p) => {
  for (let i = 0; i < 40 && !(posts.get(p) ?? []).some((u) => re.test(u)); i++) await p.waitForTimeout(200);
  const ok = (posts.get(p) ?? []).some((u) => re.test(u));
  return { ok, evidence: { request: ok ? re.source : "not sent" } };
};

const PAGES: PageSpec[] = [
  {
    name: "work",
    path: "/work",
    primary: { name: /^Review next decision$/, effect: async (p) => { const d = await dialogOpen(p); return { ok: d.ok && /[?&]decision=/.test(p.url()), evidence: d.evidence }; } },
    drawer: { row: "[data-decision] button", param: "decision" },
  },
  {
    name: "crm",
    path: "/crm",
    primary: { name: /^Add company$/, effect: dialogOpen },
    drawer: { row: "[aria-label='Next steps'] li button" },
  },
  { name: "leads", path: "/leads", primary: { name: /^Find leads$/, effect: dialogOpen }, drawer: { row: "[aria-label='Lead results'] li button", param: "lead" } },
  { name: "finance", path: "/finance", primary: { name: /^(Import a NAB CSV|Open Finances)$/, effect: urlBecomes(/\/business\?view=finance/) }, noDrawer: "Finance has no editable records on this page; the ledger is on Finances (/business?view=finance)." },
  {
    name: "receptionist",
    path: "/receptionist",
    setup: async (p) => {
      await p.route(/\/__receptionist(\/dashboard)?\/refresh/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    },
    primary: { name: /^Refresh calls$/, effect: requestSent(/\/__receptionist(\/dashboard)?\/refresh/) },
    noDrawer: "Calls, clients and gates sit in tabs; a synthetic hub has no Retell calls to open.",
  },
  { name: "inbox", path: "/inbox", primary: { name: /^(Connect accounts|Search all mail)$/, effect: dialogOpen }, drawer: { row: "[aria-label='Recent mail'] li button", param: "mail" } },
  { name: "inbox-triage", path: "/inbox-triage", primary: { name: /^Open inbox$/, effect: urlBecomes(/\/inbox(\?|$)/) }, drawer: { row: "[data-testid='triage-table'] tr[data-row]", param: "mail" } },
  { name: "calendar", path: "/calendar", primary: { name: /^New event$/, effect: dialogOpen }, drawer: { row: ".ar-upcoming-agenda > button", param: "event" } },
  {
    name: "agents-workspace",
    path: "/agents/workspace/research?tab=tasks",
    setup: computerFixture,
    primary: { none: "An agent's primary action is the conversation's Send (as on Jarvis); the header holds the agent's status action." },
    drawer: { row: "[data-task-row] button", param: "task" },
  },
  { name: "activity", path: "/activity", primary: { name: /^Ask Jarvis$/, effect: urlBecomes(/\/jarvis/) }, drawer: { row: "[data-testid='activity-jobs'] tbody tr a", hash: /#job-/ } },
  { name: "studio", path: "/studio", primary: { name: /^Make an image or video/, effect: urlBecomes(/\/design/) }, drawer: { row: "[aria-label='Recent assets'] li button", param: "asset" } },
  { name: "design", path: "/design", primary: { none: "Design's primary action is the Create tab's own Generate (a composer, like Jarvis' Send)." }, noDrawer: "Generated media opens in Design's own viewer." },
  {
    name: "memory",
    path: "/memory",
    primary: {
      name: /^Add a memory$/,
      effect: async (p) => {
        await p.waitForTimeout(600);
        const ok = await p.evaluate(() => document.activeElement?.id === "memory-capture-text");
        return { ok, evidence: { focused: ok ? "capture box" : await p.evaluate(() => document.activeElement?.tagName ?? null) } };
      },
    },
    drawer: { row: "[data-memory='find'] li button", param: "source" },
  },
  {
    name: "system",
    path: "/system",
    setup: async (p) => {
      await p.route(/\/__operator\/models\/refresh/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ checking: true }) }));
    },
    primary: { name: /^Check models$/, effect: requestSent(/\/__operator\/models\/refresh/) },
    noDrawer: "Diagnostics are folded per row (Technical detail); nothing here is edited.",
  },
  { name: "settings", path: "/settings", primary: { none: "Settings' primary action is its panel's own Save (Save profile), enabled once something changes." }, noDrawer: "Settings are forms in tabs, not records." },
];

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, executablePath: exe[0] })).catch(() => chromium.launch({ headless: true, executablePath: exe[1] }));
try {
  for (const spec of PAGES) {
    // ---- primary action + focus (1440)
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
      const p = await ctx.newPage();
      watchPosts(p);
      await routeJourneys(p, fx);
      if (spec.setup) await spec.setup(p);
      await p.goto(base + spec.path, { waitUntil: "domcontentloaded" });
      await settle(p, 2500);
      const accents = await p.locator(ACCENT).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? "").trim()));
      if ("none" in spec.primary) {
        record(spec.name, "header has at most one accent action", accents.length <= 1, { accents });
        record(spec.name, "primary action", null, spec.primary.none);
      } else {
        record(spec.name, "header has exactly one accent (primary) action", accents.length === 1 && spec.primary.name.test(accents[0]), { accents });
        const button = p.locator(ACCENT).first();
        // Keyboard focus: reach the primary action by keyboard (Shift+Tab then Tab lands on it with :focus-visible).
        await button.focus();
        await p.keyboard.press("Shift+Tab");
        await p.keyboard.press("Tab");
        const ring = await p.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return null;
          const cs = getComputedStyle(el);
          const shadow = cs.boxShadow !== "none" && cs.boxShadow.split(/,(?![^(]*\))/).some((l) => !/rgba\([^)]*,\s*0\)/.test(l));
          return { text: (el.textContent ?? "").trim().slice(0, 40), focusVisible: el.matches(":focus-visible"), outline: cs.outlineStyle !== "none" && cs.outlineWidth !== "0px" ? `${cs.outlineStyle} ${cs.outlineWidth}` : null, ring: shadow };
        });
        record(spec.name, "keyboard focus on the primary action is visible", !!ring && ring.focusVisible && (!!ring.outline || ring.ring), ring);
        await p.keyboard.press("Enter");
        const r = await spec.primary.effect(p);
        record(spec.name, `primary action works (${spec.primary.name.source})`, r.ok, r.evidence);
        await p.screenshot({ path: join(out, "verify", `${spec.name}-primary-1440.png`) });
      }
      await ctx.close();
    }
    // ---- detail drawer (1440)
    if (spec.drawer) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
      const p = await ctx.newPage();
      await routeJourneys(p, fx);
      if (spec.setup) await spec.setup(p);
      await p.goto(base + spec.path, { waitUntil: "domcontentloaded" });
      await settle(p, 2500);
      const row = p.locator(spec.drawer.row).first();
      const has = await row.count();
      if (!has) {
        record(spec.name, "a row opens its detail drawer", false, { row: spec.drawer.row, found: 0 });
      } else {
        await row.click();
        const dialog = p.getByRole("dialog").first();
        const open = await dialog.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
        const url = p.url();
        const held = spec.drawer.param ? new RegExp(`[?&]${spec.drawer.param}=`).test(url) : spec.drawer.hash ? spec.drawer.hash.test(url) : true;
        const title = open ? ((await dialog.locator("h2").first().textContent().catch(() => "")) ?? "").trim().slice(0, 80) : "";
        await p.screenshot({ path: join(out, "verify", `${spec.name}-drawer-1440.png`) });
        record(spec.name, `a row opens its detail drawer${spec.drawer.param ? ` (?${spec.drawer.param}= in the URL)` : spec.drawer.hash ? " (#job- in the URL)" : ""}`, open && held, { title, url: url.replace(base, "") });
        await p.keyboard.press("Escape");
        const closed = await dialog.waitFor({ state: "detached", timeout: 5000 }).then(() => true).catch(() => false);
        await p.waitForTimeout(400);
        const after = p.url();
        const cleared = spec.drawer.param ? !new RegExp(`[?&]${spec.drawer.param}=`).test(after) : spec.drawer.hash ? !spec.drawer.hash.test(after) : true;
        record(spec.name, "Escape closes the drawer and clears it from the URL", closed && cleared, { closed, url: after.replace(base, "") });
        if (spec.drawer.param && open && held) {
          // A link to the record opens it directly (deep link), and Back from there closes it.
          await p.goto(url, { waitUntil: "domcontentloaded" });
          await settle(p, 2000);
          const deep = await p.getByRole("dialog").first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
          record(spec.name, "a link to the record opens its drawer", deep, { url: url.replace(base, "") });
        }
      }
      await ctx.close();
    } else {
      record(spec.name, "detail drawer", null, spec.noDrawer ?? "no records on this page");
    }
    // ---- 390: no sideways scroll
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
      const p = await ctx.newPage();
      await routeJourneys(p, fx);
      if (spec.setup) await spec.setup(p);
      await p.goto(base + spec.path, { waitUntil: "domcontentloaded" });
      await settle(p, 2500);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      record(spec.name, "390 px: no sideways page scroll", over <= 1, { overflowPx: over });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "verify.json"), JSON.stringify({ at: new Date().toISOString(), hub: base, synthetic: true, results }, null, 2));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.filter((r) => r.status === "PASS").length} pass, ${failed} fail, ${results.filter((r) => r.status === "N/A").length} n/a`);
process.exit(failed ? 1 : 0);

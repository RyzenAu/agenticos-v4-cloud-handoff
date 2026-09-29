// J2 browser hands: agent-browser (the browser tool Hermes' toolset uses) called DIRECTLY against Jarvis Chrome over
// CDP, never through Hermes (too slow). One adapter: open or activate a tab, navigate, snapshot (refs), click or
// type by ref, read the page. Every input action passes the existing gates first, in code:
//   - S2c: a final button ("Send", "Pay", "Delete"â€¦) is never pressed from the browser (finalClickRefusal);
//   - S2e: the Hermes tool-guard verdict (money buttons, money pages, payment steps, card numbers, money hosts);
// so a page with a money or final action still needs his spoken yes, and secrets refusals are unchanged.
//
// The runner is injectable: tests pass a fake (a CDP stub); the live check points it at a SEPARATE Chrome on a
// spare port. Nothing here reads env values beyond the two knobs below (the exe path and the CDP port).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { candidateNames, finalClickRefusal, type PageMoneyContext } from "../browser-hands";
import { toolGuardVerdict } from "../away-mode/tool-guard";
import { SECRET_BEARING } from "../../src/lib/control-risk";
import { ConfirmedPress } from "../desk-payments/confirmed";
import { deskOpenVerdict } from "../desk-payments/policy";

export type AbRun = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export type AbResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: string };
export type Tab = { tabId: string; targetId: string; title: string; url: string; active: boolean };
export type Ref = { ref: string; role: string; name: string };

/** The agent-browser executable (the npm package's native binary; a .cmd shim can't be spawned directly). */
export function agentBrowserExe(env: Record<string, string | undefined> = process.env): string | null {
  const own = env.AGENT_BROWSER_EXE;
  if (own && existsSync(own)) return own;
  const appData = env.APPDATA;
  if (!appData) return null;
  const exe = join(appData, "npm", "node_modules", "agent-browser", "bin", process.arch === "arm64" ? "agent-browser-win32-arm64.exe" : "agent-browser-win32-x64.exe");
  return existsSync(exe) ? exe : null;
}

/** Jarvis Chrome's DevTools port (9222). The live check sets a spare port for its own separate profile. */
export function jarvisCdpPort(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.JARVIS_BROWSER_CDP_PORT);
  return Number.isInteger(n) && n > 1024 && n < 65536 ? n : 9222;
}

/**
 * What the agent-browser CLI, and the long-lived background daemon it starts, are given as an environment (F3): only
 * what a native Windows program needs to find its way around, plus its own AGENT_BROWSER_* knobs. Nothing else the
 * server holds (keys, tokens, provider settings) reaches a third-party binary. Never printed.
 */
const ENV_KEEP = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "SYSTEMDRIVE", "USERNAME", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "TERM"];
export function minimalEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (ENV_KEEP.includes(upper) || upper.startsWith("AGENT_BROWSER_")) out[key] = value;
  }
  return out;
}

export function spawnRunner(exe: string, env: Record<string, string> = minimalEnv()): AbRun {
  return (args, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      // The first call of a session starts agent-browser's background daemon, which inherits our pipes and keeps them
      // open for good: waiting for the streams to close (the "close" event) would never return. So the answer is taken
      // when the CLI exits ("exit"), or as soon as a whole JSON line has arrived.
      const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
      let stdout = "", stderr = "", done = false;
      const finish = (code: number, extra = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr: stderr + extra });
      };
      const timer = setTimeout(() => (child.kill(), finish(-1, "agent-browser timed out")), timeoutMs);
      child.stdout.on("data", (d) => {
        stdout += d;
        if (/\}\s*\n$/.test(stdout)) setTimeout(() => finish(0), 30);
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => finish(-1, e.message));
      child.on("exit", (code) => setTimeout(() => finish(code ?? -1), 50));
    });
}

/** The page around an input action, read in the page (the same fields the S2c/S2e gates read). */
const PAGE_JS = `(() => {
  const flat = (t) => String(t || "").replace(/\\s+/g, " ").trim();
  const controls = [...document.querySelectorAll("button, [role=button], input, select, a[href]")].slice(0, 200)
    .map((c) => [c.getAttribute("aria-label"), c.getAttribute("name"), c.id, c.getAttribute("autocomplete"), (c.innerText || c.value || "").slice(0, 60)].filter(Boolean).join(" "))
    .filter(Boolean).join("\\n").slice(0, 4000);
  return { title: document.title, url: location.href, text: (document.title + "\\n" + flat(document.body && document.body.innerText)).slice(0, 6000), nearby: "", controls,
    embeds: !!document.querySelector("iframe, canvas"), progress: !!document.querySelector("progress, [role=progressbar]") };
})()`;

/**
 * The page as a desk payment needs it (scripts/desk-payments): the text with its LINES kept (a total is a line of its
 * own), the controls' names, and what the form fields say (a login or a card still to type is his to do, never Jarvis's).
 * A field counts as filled when it has a value or the browser has autofilled it (autofilled values read as empty until
 * a click). A card in a cross-origin frame (Stripe Elements) can't be checked, so its frame is reported.
 */
export type DeskPage = {
  title: string;
  url: string;
  ready: boolean;
  text: string;
  controls: string;
  embeds: boolean;
  progress: boolean;
  fields: { passwordPresent: boolean; passwordEmpty: boolean; cardPresent: boolean; cardEmpty: boolean; cardFrame: boolean; otpEmpty: boolean };
};
const DESK_PAGE_JS = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const filled = (e) => !!(e.value && String(e.value).length) || !!(e.matches && (e.matches(":-webkit-autofill") || e.matches(":autofill")));
  const hint = (e) => [e.getAttribute("autocomplete"), e.name, e.id, e.getAttribute("aria-label"), e.placeholder].filter(Boolean).join(" ").toLowerCase();
  const isCard = (e) => /cc-number|cc-csc|cc-exp|card.?(number|no)|cvv|cvc|security.?code|expir/.test(hint(e));
  const isOtp = (e) => /one-time-code|otp|verification.?code|sms.?code|2fa|passcode/.test(hint(e));
  const inputs = [...document.querySelectorAll("input, textarea")].filter((e) => e.type !== "hidden" && vis(e));
  const pw = inputs.filter((e) => e.type === "password");
  const controls = [...document.querySelectorAll("button, [role=button], input, select, a[href]")].slice(0, 200)
    .map((c) => [c.getAttribute("aria-label"), c.getAttribute("name"), c.id, c.getAttribute("autocomplete"), (c.innerText || c.value || "").slice(0, 60)].filter(Boolean).join(" "))
    .filter(Boolean).join("\n").slice(0, 4000);
  return {
    title: document.title, url: location.href, ready: document.readyState === "complete",
    text: String(document.body ? document.body.innerText : "").slice(0, 12000), controls,
    embeds: !!document.querySelector("iframe, canvas"), progress: !!document.querySelector("progress, [role=progressbar]"),
    fields: {
      passwordPresent: pw.length > 0, passwordEmpty: pw.some((e) => !filled(e)),
      cardPresent: inputs.some(isCard), cardEmpty: inputs.filter(isCard).some((e) => !filled(e)),
      cardFrame: !!document.querySelector('iframe[name*="privateStripeFrame"], iframe[title*="card" i], iframe[src*="card" i]'),
      otpEmpty: inputs.filter(isOtp).some((e) => !filled(e)),
    },
  };
})()`;

export type BrowserHands = ReturnType<typeof createAgentBrowserHands>;
export function createAgentBrowserHands(options: { run: AbRun; port?: number; session?: string }) {
  const port = options.port ?? jarvisCdpPort();
  const base = ["--session", options.session ?? "jarvis-hands", "--cdp", String(port)];
  async function ab<T = Record<string, unknown>>(args: string[], timeoutMs?: number): Promise<AbResult<T>> {
    const r = await options.run([...base, ...args, "--json"], timeoutMs).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
    const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
      const v = JSON.parse(line) as { success?: boolean; data?: T; error?: string | null };
      if (v.success) return { ok: true, data: (v.data ?? {}) as T };
      return { ok: false, error: String(v.error ?? "agent-browser failed").slice(0, 200) };
    } catch {
      return { ok: false, error: (r.stderr || "agent-browser didn't answer").trim().slice(0, 200) };
    }
  }
  const page = async (): Promise<PageMoneyContext | null> => {
    const r = await ab<{ result?: PageMoneyContext }>(["eval", "-b", Buffer.from(PAGE_JS, "utf8").toString("base64")]);
    return r.ok && r.data.result && typeof r.data.result === "object" ? r.data.result : null;
  };
  const tabs = async (): Promise<Tab[]> => {
    const r = await ab<{ tabs?: Tab[] }>(["tab"]);
    return r.ok ? (r.data.tabs ?? []).filter((t) => (t as { type?: string }).type === undefined || (t as { type?: string }).type === "page") : [];
  };
  const active = async () => (await tabs()).find((t) => t.active) ?? null;
  /** The control's other names, read by ref: visible text, aria-label, title, value, alt. Null if any read fails (fail closed). */
  const labelsOf = async (ref: string) => {
    const at = `@${ref}`;
    const attr = async (name: string) => {
      const r = await ab<{ value?: string | null }>(["get", "attr", at, name]);
      return r.ok ? String(r.data.value ?? "").slice(0, 200) : null;
    };
    const [text, aria, title, value, alt] = await Promise.all([ab<{ text?: string }>(["get", "text", at]), attr("aria-label"), attr("title"), attr("value"), attr("alt")]);
    if (!text.ok || aria === null || title === null || value === null || alt === null) return null;
    const t = String(text.data.text ?? "").slice(0, 200);
    return { text: t, aria, title, value, alt, all: [t, aria, title, value, alt].filter(Boolean) };
  };
  const agrees = (a: string, b: string) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x === y || x.includes(y) || y.includes(x);
  };

  return {
    port,
    tabs,
    active,
    page,
    /** A navigation, through the S2e verdict first (a bank, broker, exchange, betting or payment site never opens). */
    async open(url: string, where: "new-tab" | "this-tab" = "new-tab"): Promise<{ ok: boolean; said: string; targetId?: string; url?: string }> {
      const verdict = toolGuardVerdict({ tool: "browser_navigate", args: { url } });
      if (!verdict.allow) return { ok: false, said: verdict.message };
      const r = where === "new-tab" ? await ab<{ targetId?: string; url?: string }>(["tab", "new", url]) : await ab<{ url?: string }>(["open", url]);
      if (!r.ok) return { ok: false, said: `The browser didn't open it: ${r.error}.` };
      const now = where === "new-tab" ? (r.data as { targetId?: string }).targetId : (await active())?.targetId;
      return { ok: true, said: "Opened.", ...(now ? { targetId: String(now) } : {}), ...(r.data.url ? { url: String(r.data.url) } : {}) };
    },
    /**
     * AT HIS DESK ONLY (the caller has a desk verdict: scripts/desk-payments/policy.ts deskVerdict): open a bank, payment
     * or biller site. A broker, exchange or bookie, a shortener, a raw IP and a look-alike host still refuse.
     */
    async openDesk(url: string, where: "new-tab" | "this-tab" = "new-tab"): Promise<{ ok: boolean; said: string; targetId?: string; url?: string }> {
      // Whatever opens for anyone opens here; what the strict rules refuse (a bank, payment or biller site, a checkout page) opens
      // only if it isn't a broker, exchange or bookie, a shortener, a raw IP or a look-alike host.
      if (!toolGuardVerdict({ tool: "browser_navigate", args: { url } }).allow) {
        const verdict = deskOpenVerdict(url);
        if (!verdict.ok) return { ok: false, said: verdict.said };
      }
      const r = where === "new-tab" ? await ab<{ targetId?: string; url?: string }>(["tab", "new", url]) : await ab<{ url?: string }>(["open", url]);
      if (!r.ok) return { ok: false, said: `The browser didn't open it: ${r.error}.` };
      const now = where === "new-tab" ? (r.data as { targetId?: string }).targetId : (await active())?.targetId;
      return { ok: true, said: "Opened.", ...(now ? { targetId: String(now) } : {}), ...(r.data.url ? { url: String(r.data.url) } : {}) };
    },
    /** The page for a desk payment (lines kept, form fields described). Null when it can't be read. */
    async readDesk(): Promise<DeskPage | null> {
      const r = await ab<{ result?: DeskPage }>(["eval", "-b", Buffer.from(DESK_PAGE_JS, "utf8").toString("base64")]);
      const v = r.ok ? r.data.result : undefined;
      return v && typeof v === "object" && typeof v.url === "string" && typeof v.text === "string" && v.fields && typeof v.fields === "object" ? v : null;
    },
    /** Every name a control carries (visible text, aria-label, title, value, alt), or null if any read fails (fail closed). */
    namesOf: labelsOf,
    /**
     * The ONE press of a confirmed desk payment. It needs the ConfirmedPress the desk payment store made when he clicked
     * Confirm or said yes at the desk; a press that was already made, or a made-up object, presses nothing. The caller
     * has just re-read the page and checked the control is the one he confirmed. Never used by any other path.
     */
    async pressBound(confirmed: ConfirmedPress, ref: string, expect?: { name: string; targetId: string; url: string; pageHash: string; pageTitle: string }): Promise<{ ok: boolean; said: string; clicked?: false }> {
      if (!(confirmed instanceof ConfirmedPress) || confirmed.used) return { ok: false, clicked: false, said: "That confirmation was already used, so nothing was pressed." };
      confirmed.used = true;
      // The last checks, as close to the click as the hands allow: the same tab at the same address, and the element under the
      // button's centre IS the button (an overlay or a frame drawn over it takes the click instead). Without `expect` (never in
      // the service) only the press happens.
      if (expect) {
        const tab = await active().catch(() => null);
        const bare = (u: string) => u.split("#")[0];
        if (!tab || tab.targetId !== expect.targetId || bare(tab.url) !== bare(expect.url)) return { ok: false, clicked: false, said: "The page moved just before the press, so nothing was pressed." };
        await ab(["scrollintoview", `@${ref}`]);
        const box = await ab<Record<string, unknown>>(["get", "box", `@${ref}`]);
        const b = (box.ok ? ((box.data.box as Record<string, unknown> | undefined) ?? box.data) : null) as Record<string, unknown> | null;
        const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(b?.[k]));
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { ok: false, clicked: false, said: "I couldn't check what is under the button, so nothing was pressed." };
        const expected = { url: bare(expect.url), title: expect.pageTitle, hash: expect.pageHash, name: expect.name, x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
        const marker = Buffer.from(JSON.stringify(expected), "utf8").toString("base64");
        const script = `/*DESK_ATOMIC_PRESS:${marker}*/ (async () => {
          const expected = ${JSON.stringify(expected)};
          if (location.href.split("#")[0] !== expected.url) return { state: "moved" };
          if (document.title !== expected.title || !crypto.subtle) return { state: "changed" };
          const before = String(document.body?.innerText ?? "").slice(0, 12000);
          const bytes = new TextEncoder().encode(before);
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
          if (digest !== expected.hash) return { state: "changed" };
          // The digest awaits Web Crypto. A page can change while it runs; compare again in the same synchronous
          // turn as the click. No other page task can run between this check and button.click().
          if (String(document.body?.innerText ?? "").slice(0, 12000) !== before) return { state: "changed" };
          if (location.href.split("#")[0] !== expected.url || document.title !== expected.title) return { state: "moved" };
          const hit = document.elementFromPoint(expected.x, expected.y);
          const button = hit?.closest("button, [role=button], a, input, [onclick]");
          const label = button ? [button.getAttribute("aria-label"), button.innerText, button.value, button.title].filter(Boolean).join(" | ").toLowerCase().replace(/\\s+/g, " ") : "";
          if (!button || !label.includes(expected.name.toLowerCase().replace(/\\s+/g, " "))) return { state: "covered" };
          button.click();
          return { state: "clicked" };
        })()`;
        const result = await ab<{ result?: { state?: string } }>(["eval", "-b", Buffer.from(script, "utf8").toString("base64")]);
        if (!result.ok) return { ok: false, said: `The click didn't go through: ${result.error}.` };
        const state = result.data.result?.state;
        if (state === "moved") return { ok: false, clicked: false, said: "The page moved just before the press, so nothing was pressed." };
        if (state === "changed") return { ok: false, clicked: false, said: "The payment page changed just before the press, so nothing was pressed." };
        if (state === "covered") return { ok: false, clicked: false, said: "Something else is over the button, so nothing was pressed." };
        return state === "clicked" ? { ok: true, said: "Pressed." } : { ok: false, said: "The browser did not confirm whether the press occurred." };
      }
      const r = await ab(["click", `@${ref}`]);
      return r.ok ? { ok: true, said: "Pressed." } : { ok: false, said: `The click didn't go through: ${r.error}.` };
    },
    async activate(targetId: string) {
      const r = await ab(["tab", targetId]);
      return r.ok;
    },
    async back() {
      const r = await ab(["back"]);
      return r.ok ? { ok: true, said: "Gone back." } : { ok: false, said: `I couldn't go back: ${r.error}.` };
    },
    async forward() {
      const r = await ab(["forward"]);
      return r.ok ? { ok: true, said: "Gone forward." } : { ok: false, said: `I couldn't go forward: ${r.error}.` };
    },
    async reload() {
      const r = await ab(["reload"]);
      return r.ok ? { ok: true, said: "Refreshed." } : { ok: false, said: `I couldn't refresh it: ${r.error}.` };
    },
    async closeTab() {
      const r = await ab(["tab", "close"]);
      if (r.ok) return { ok: true, said: "Tab closed." };
      return { ok: false, said: /last tab/i.test(r.error) ? "That's the only tab left, so I left it open." : `I couldn't close it: ${r.error}.` };
    },
    async scroll(dir: "up" | "down") {
      const r = await ab(["scroll", dir, "700"]);
      return r.ok ? { ok: true, said: dir === "down" ? "Scrolled down." : "Scrolled up." } : { ok: false, said: `I couldn't scroll: ${r.error}.` };
    },
    /** The page's title, address and text, for "read me this page". */
    async read(): Promise<{ ok: boolean; title: string; url: string; text: string; said?: string }> {
      const [t, u, x] = await Promise.all([ab<{ title?: string }>(["get", "title"]), ab<{ url?: string }>(["get", "url"]), ab<{ text?: string }>(["get", "text", "body"])]);
      if (!x.ok) return { ok: false, title: "", url: "", text: "", said: `I couldn't read the page: ${x.error}.` };
      return { ok: true, title: t.ok ? String(t.data.title ?? "") : "", url: u.ok ? String(u.data.url ?? "") : "", text: String(x.data.text ?? "") };
    },
    async snapshot(): Promise<Ref[]> {
      const r = await ab<{ refs?: Record<string, { name?: string; role?: string }> }>(["snapshot", "-i"]);
      if (!r.ok) return [];
      return Object.entries(r.data.refs ?? {}).map(([ref, v]) => ({ ref, role: String(v.role ?? ""), name: String(v.name ?? "") }));
    },
    /**
     * Click the control he named ("Contact"), by its ref in a fresh snapshot, after the S2c final-button check and
     * the S2e verdict on the page it's on. A final or money press is refused with the line to say; nothing pressed.
     */
    async click(target: string): Promise<{ ok: boolean; said: string }> {
      const want = target.trim().replace(/^["â€œ']|["â€']$/g, "").slice(0, 80);
      if (!want) return { ok: false, said: "Click what?" };
      if (SECRET_BEARING.test(want)) return { ok: false, said: "That names a secret-bearing file or private data, which I never open. Nothing was touched." };
      const refs = await this.snapshot();
      const lower = want.toLowerCase();
      const hit = refs.find((r) => r.name.trim().toLowerCase() === lower) ?? refs.find((r) => r.name.toLowerCase().includes(lower));
      if (!hit) return { ok: false, said: `I can't see "${want}" on this page, so nothing was clicked.` };
      // EVERY name the control carries (REVIEW-S2C fix 1, REVIEW-J2 F1): the snapshot has only its accessible name (an
      // aria-label wins over the visible text), so the visible text, aria-label, title, value and alt are read as well.
      // A visible "Delete" under aria-label="Next" is final; two names that disagree hide one, so it is not pressed.
      const labels = await labelsOf(hit.ref);
      if (!labels) return { ok: false, said: `I couldn't read everything "${hit.name.slice(0, 60)}" is labelled, so nothing was clicked.` };
      const kind = /button/i.test(hit.role) ? "button" : "link";
      const names = [hit.name, ...labels.all];
      const final = finalClickRefusal({ kind, label: hit.name, names } as never, want);
      if (final) return { ok: false, said: final };
      const shown = candidateNames({ label: labels.text || labels.value, names: [] })[0];
      const spoken = candidateNames({ label: labels.aria || hit.name, names: [] })[0];
      if (shown && spoken && !agrees(shown, spoken)) return { ok: false, said: `That control is labelled two different ways, "${shown.slice(0, 40)}" and "${spoken.slice(0, 40)}", so I can't tell what it does. Nothing was clicked.` };
      const ctx = await page();
      for (const name of new Set(names.map((n) => n.trim()).filter(Boolean))) {
        const verdict = toolGuardVerdict({ tool: "browser_click", args: { ref: hit.ref }, label: name, pageUrl: ctx?.url ?? null }, { page: ctx });
        if (!verdict.allow) return { ok: false, said: verdict.message };
      }
      const r = await ab(["click", `@${hit.ref}`]);
      return r.ok ? { ok: true, said: `Clicked "${hit.name.slice(0, 60)}".` } : { ok: false, said: `The click didn't go through: ${r.error}.` };
    },
  };
}

// Electron apps through Chrome's DevTools protocol (flag `cdp`; the idea from Agent Desktop's
// `launch --cdp`, none of its code).
//
// VS Code, Slack, Obsidian and Discord draw their UI as web content. Their UI Automation tree is
// thin or empty, so screen_act would otherwise fall back to vision. When he asks ("open VS Code so
// you can drive it"), Jarvis starts the app with a DevTools port bound to loopback and then reads
// and presses its controls through CDP instead:
//
// - Only on request, only apps on the list below, and only when the app isn't already running
//   (the switch works only at start, and his open windows are never closed to add it).
// - `--remote-debugging-port` plus `--remote-debugging-address=127.0.0.1`; no other debugging
//   switch may be passed. After start, every listener on the port must be loopback (127.0.0.1 or
//   ::1), or the app is closed again and nothing is driven.
// - Page scripts are FIXED templates. The only thing that varies is an integer ref, so nothing on
//   his screen or in his words can run as JavaScript in the app.
// - A CDP press goes through cdpHands.press, i.e. after screen_act's vetAction (and Jev's
//   irreversible check, the deny-list, the spoken yes); a ref is re-read right before the press and
//   refused (STALE_REF) when the control has moved or changed.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WindowInfo } from "../jarvis-skills/windows";
import type { Hands } from "./index";
import { centre, type Snapshot, type UiElement } from "./plan";
import { RefError, sameTarget } from "./refs";

export type ElectronApp = { key: string; name: string; process: string; words: RegExp; candidates: (env: Record<string, string | undefined>) => string[] };

const newest = (dir: string, exe: string) => {
  try {
    return readdirSync(dir)
      .filter((d) => /^app-\d/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => join(dir, d, exe));
  } catch {
    return [];
  }
};
export const ELECTRON_APPS: ElectronApp[] = [
  {
    key: "vscode",
    name: "VS Code",
    process: "Code",
    words: /\b(?:vs ?code|visual studio code|vscode)\b/i,
    candidates: (env) => [join(env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"), join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "Code.exe")],
  },
  { key: "slack", name: "Slack", process: "slack", words: /\bslack\b/i, candidates: (env) => newest(join(env.LOCALAPPDATA ?? "", "slack"), "slack.exe") },
  {
    key: "obsidian",
    name: "Obsidian",
    process: "Obsidian",
    words: /\bobsidian\b/i,
    candidates: (env) => [join(env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe"), join(env.ProgramFiles ?? "C:\\Program Files", "Obsidian", "Obsidian.exe")],
  },
  { key: "discord", name: "Discord", process: "Discord", words: /\bdiscord\b/i, candidates: (env) => newest(join(env.LOCALAPPDATA ?? "", "Discord"), "Discord.exe") },
];

/** Which listed app his words name ("open VS Code so you can drive it"), or null. Pure. */
export const electronAppFrom = (words: string) => ELECTRON_APPS.find((a) => a.key === words.trim().toLowerCase() || a.words.test(words)) ?? null;

/**
 * "Open Discord so you can control it", "launch VS Code for you to drive", "open Slack in control
 * mode": one of the listed apps, opened for Jarvis to drive (POST /screen/cdp). A plain "open
 * Discord" stays an ordinary launch. Pure; the voice rules and the Jev router both use it.
 */
export function driveAppIntent(utterance: string): { app: string } | null {
  const u = utterance.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (u.length > 160) return null;
  const opens = /\b(?:open|launch|start|run|bring up|fire up|boot up|load up|get)\b/.test(u);
  const forJarvis =
    /\b(?:so|so that|and) (?:you|jarvis) can (?:control|drive|use|operate|click (?:around|through)|work) (?:it|in it|them|that)\b|\bfor you to (?:control|drive|use|operate)\b|\bin (?:control|driving|drive|remote) mode\b|\bso you can take (?:it )?over\b|\b(?:you|jarvis) (?:drive|control) it\b/.test(u);
  if (!opens || !forJarvis) return null;
  const app = electronAppFrom(u);
  return app ? { app: app.key } : null;
}

const DEBUG_SWITCH = /^--remote-(?:debugging|allow-origins)|^--inspect/i;
/** The launch switches: a loopback DevTools port, plus vetted extras (never a debugging switch). Pure. */
export function cdpArgs(port: number, extra: string[] = []): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Not a usable port.");
  const bad = extra.find((a) => DEBUG_SWITCH.test(a));
  if (bad) throw new Error(`${bad.split("=")[0]} is set by Jarvis alone.`);
  return [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", ...extra];
}
/** Every listener on the port is loopback (and there is at least one). Pure. */
export const loopbackOnly = (addresses: string[]) => addresses.length > 0 && addresses.every((a) => /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(a.trim()));
/** A port in 9300-9399 (Jarvis's own Chrome keeps 9222). */
export const pickPort = (random = Math.random) => 9300 + Math.floor(random() * 100);

// --- the page side: fixed scripts ------------------------------------------------------------------
const NAME_FN = `(el) => { const t = (s) => (s || "").replace(/\\s+/g, " ").trim(); const lab = el.labels && el.labels[0] ? el.labels[0].innerText : ""; const by = el.getAttribute("aria-labelledby"); const lb = by ? t(by.split(" ").map((id) => { const n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ")) : ""; const inner = el.tagName === "INPUT" ? "" : t(el.innerText); const kid = inner ? null : el.querySelector("[aria-label],[title]"); return t(el.getAttribute("aria-label") || lb || lab || el.getAttribute("title") || el.getAttribute("placeholder") || inner || (kid ? kid.getAttribute("aria-label") || kid.getAttribute("title") : "")).slice(0, 120); }`;
export const SNAPSHOT_JS = `(() => {
  const name = ${NAME_FN};
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=checkbox],[role=switch],[role=radio],[role=option],[role=treeitem],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const refs = [], items = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const aria = (a) => el.getAttribute(a);
    refs.push(el);
    items.push({ i: refs.length - 1, tag: el.tagName.toLowerCase(), role: aria("role") || "", type, name: name(el), id: (el.id || "").slice(0, 80), x: r.x, y: r.y, w: r.width, h: r.height,
      disabled: !!el.disabled || aria("aria-disabled") === "true", focused: el === document.activeElement, password: type === "password",
      checked: aria("aria-checked") != null ? aria("aria-checked") === "true" : (type === "checkbox" || type === "radio") ? !!el.checked : null,
      expanded: aria("aria-expanded") != null ? aria("aria-expanded") === "true" : null, selected: aria("aria-selected") === "true",
      value: type === "password" || !/^(?:INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? "" : String(el.value == null ? "" : el.value).slice(0, 120), readOnly: !!el.readOnly });
    if (items.length >= 300) break;
  }
  // Small, visible status/heading evidence. Never scrape the body or make text a click target.
  for (const el of document.querySelectorAll('h1,h2,h3,[role=heading],[role=status],[role=alert],[aria-live=polite],[aria-live=assertive]')) {
    if (el.matches(sel) || el.querySelector(sel)) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    refs.push(el);
    items.push({ i: refs.length - 1, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", type: "statictext", name: name(el), id: (el.id || "").slice(0, 80), x: r.x, y: r.y, w: r.width, h: r.height,
      disabled: true, focused: false, password: false, checked: null, expanded: null, selected: false, value: "", readOnly: true });
    if (items.filter(it => it.type === "statictext").length >= 20) break;
  }
  globalThis[Symbol.for("jarvis.refs")] = refs;
  return JSON.stringify({ dpr: devicePixelRatio, innerWidth, innerHeight, outerWidth, outerHeight, items });
})()`;
/** The focused control only (refs untouched), for the vet and the read-back after typing. */
export const FOCUSED_JS = `(() => {
  const name = ${NAME_FN};
  let el = document.activeElement;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect(), type = (el.getAttribute("type") || "").toLowerCase();
  return JSON.stringify({ dpr: devicePixelRatio, innerWidth, innerHeight, outerWidth, outerHeight, items: [{ i: -1, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", type, name: name(el), id: (el.id || "").slice(0, 80),
    x: r.x, y: r.y, w: r.width, h: r.height, disabled: !!el.disabled, focused: true, password: type === "password", checked: null, expanded: null, selected: false,
    value: type === "password" ? "" : String(el.value == null ? (el.isContentEditable ? el.innerText : "") : el.value).slice(0, 120), readOnly: !!el.readOnly }] });
})()`;
/** The ref's element now: its rectangle and name, or null when it's gone. `i` is a validated integer. */
export const refJs = (i: number) => {
  if (!Number.isInteger(i) || i < 0 || i > 100_000) throw new Error("Not a ref.");
  return `((i) => { const name = ${NAME_FN}; const el = (globalThis[Symbol.for("jarvis.refs")] || [])[i]; if (!el || !el.isConnected) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, name: name(el) }); })(${i})`;
};

export type CdpItem = {
  i: number; tag: string; role: string; type: string; name: string; id: string; x: number; y: number; w: number; h: number;
  disabled: boolean; focused: boolean; password: boolean; checked: boolean | null; expanded: boolean | null; selected: boolean; value: string; readOnly: boolean;
};
export type CdpPage = { dpr: number; innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; items: CdpItem[] };

/** A page role/tag → the UIA control type the rest of screen-hands knows. Pure. */
export function uiaType(item: Pick<CdpItem, "tag" | "role" | "type">): string {
  if (item.type === "statictext") return "Text";
  const role = item.role.toLowerCase();
  const map: Record<string, string> = { button: "Button", link: "Hyperlink", tab: "TabItem", menuitem: "MenuItem", menuitemcheckbox: "MenuItem", checkbox: "CheckBox", switch: "Button", radio: "RadioButton", option: "ListItem", treeitem: "TreeItem", combobox: "ComboBox", textbox: "Edit", searchbox: "Edit" };
  if (map[role]) return map[role];
  if (item.tag === "a") return "Hyperlink";
  if (item.tag === "select") return "ComboBox";
  if (item.tag === "textarea") return "Edit";
  if (item.tag === "input") return item.type === "checkbox" ? "CheckBox" : item.type === "radio" ? "RadioButton" : ["button", "submit", "reset", "image"].includes(item.type) ? "Button" : "Edit";
  return item.tag === "button" || item.tag === "summary" ? "Button" : "Edit";
}
/** Ids of CDP controls start here, so they never collide with UIA's. */
export const CDP_ID_BASE = 100_000;

/** The page's controls → UiElements in physical screen pixels (`origin`: the page's top-left). Pure. */
export function cdpElements(page: CdpPage, origin: { x: number; y: number }): UiElement[] {
  const k = page.dpr || 1;
  return page.items.map((it) => {
    const type = uiaType(it);
    return {
      id: CDP_ID_BASE + it.i, type,
      x: Math.round(origin.x + it.x * k), y: Math.round(origin.y + it.y * k), w: Math.round(it.w * k), h: Math.round(it.h * k),
      password: it.password, enabled: !it.disabled, focused: it.focused, hasValue: type === "Edit" || type === "ComboBox", readOnly: it.readOnly,
      ...(it.checked !== null ? { toggled: it.checked } : {}), ...(it.expanded !== null ? { expanded: it.expanded } : {}), ...(it.selected ? { selected: true } : {}),
      invokable: !["Edit", "ComboBox", "Text"].includes(type), name: it.name, aid: it.id, help: "", value: it.password ? "" : it.value, web: true,
    };
  });
}

// --- a minimal CDP client ----------------------------------------------------------------------------
export type CdpClient = { send(method: string, params?: Record<string, unknown>): Promise<any>; close(): void };
export async function connectCdp(wsUrl: string, timeoutMs = 4000): Promise<CdpClient> {
  if (!/^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(wsUrl)) throw new Error("CDP only over loopback.");
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP didn't answer.")), timeoutMs);
    ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
    ws.addEventListener("error", () => (clearTimeout(t), reject(new Error("CDP connection failed."))), { once: true });
  });
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const w = typeof msg.id === "number" ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(String(msg.error.message ?? "CDP error").slice(0, 200)));
    else w.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    for (const w of waiting.values()) w.reject(new Error("CDP closed."));
    waiting.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => waiting.delete(id) && reject(new Error(`${method} timed out.`)), timeoutMs).unref?.();
      });
    },
    close: () => ws.close(),
  };
}
async function evaluate(client: CdpClient, expression: string) {
  const r = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r?.exceptionDetails) throw new Error("The page script failed.");
  return r?.result?.value ?? null;
}

// --- sessions ------------------------------------------------------------------------------------------
export type CdpSession = { app: ElectronApp; port: number; pid: number; startedAt: number };
export type CdpDeps = {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** Start the app detached; its pid. */
  start(exe: string, args: string[]): number;
  running(process: string): Promise<boolean>;
  /** Local addresses listening on the port (Get-NetTCPConnection). */
  listeners(port: number): Promise<string[]>;
  kill(pid: number): Promise<void>;
  request?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};
export type LaunchReply = { ok: boolean; said: string; port?: number; app?: string };

export function createCdpSessions(deps: CdpDeps) {
  const request = deps.request ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exists = deps.exists ?? existsSync;
  const sessions = new Map<string, CdpSession>();
  const version = async (port: number, ms = 800) => {
    const r = await request(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) }).catch(() => null);
    return r?.ok ? ((await r.json().catch(() => null)) as Record<string, string> | null) : null;
  };
  const alive = async (s: CdpSession) => !!(await version(s.port, 500));
  return {
    /** Start a listed app with a loopback DevTools port. `extra` is for Jarvis's own benches only. */
    async launch(words: string, extra: string[] = []): Promise<LaunchReply> {
      const app = electronAppFrom(words);
      if (!app) return { ok: false, said: `I can open ${ELECTRON_APPS.map((a) => a.name).join(", ")} that way, not that one.` };
      const existing = sessions.get(app.key);
      if (existing && (await alive(existing))) return { ok: true, said: `${app.name} is already open for me.`, port: existing.port, app: app.key };
      const exe = app.candidates(deps.env ?? process.env).find((p) => p && exists(p));
      if (!exe) return { ok: false, said: `I can't find ${app.name} on this PC.` };
      if (await deps.running(app.process)) return { ok: false, said: `${app.name} is already open. I can only drive it this way from a fresh start, and I won't close your windows. Close it and ask me again.` };
      let port = pickPort();
      for (let i = 0; i < 5 && (await deps.listeners(port)).length; i++) port = pickPort();
      let args: string[];
      try {
        args = cdpArgs(port, extra);
      } catch (error) {
        return { ok: false, said: (error as Error).message };
      }
      const pid = deps.start(exe, args);
      let info: Record<string, string> | null = null;
      for (let i = 0; i < 40 && !info; i++) {
        await sleep(500);
        info = await version(port);
      }
      if (!info) return { ok: false, said: `${app.name} opened, but its debugging port never answered, so I'll use my usual hands.` };
      const addresses = await deps.listeners(port);
      if (!loopbackOnly(addresses)) {
        await deps.kill(pid).catch(() => undefined);
        return { ok: false, said: `${app.name}'s debugging port was reachable from outside this PC, so I closed it again.` };
      }
      sessions.set(app.key, { app, port, pid, startedAt: Date.now() });
      return { ok: true, said: `${app.name} is open, and I can drive it directly.`, port, app: app.key };
    },
    /** The session for this window's app, while its port still answers. */
    async forWindow(win: Pick<WindowInfo, "process">): Promise<CdpSession | null> {
      for (const s of sessions.values()) {
        if (s.app.process.toLowerCase() !== win.process.toLowerCase()) continue;
        if (await alive(s)) return s;
        sessions.delete(s.app.key);
      }
      return null;
    },
    list: () => [...sessions.values()].map((s) => ({ app: s.app.key, name: s.app.name, port: s.port, pid: s.pid })),
    /** The first page target's WebSocket URL (VS Code's workbench, Slack's client…). */
    async pageUrl(s: CdpSession): Promise<string | null> {
      const r = await request(`http://127.0.0.1:${s.port}/json/list`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      const list = r?.ok ? ((await r.json().catch(() => [])) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>) : [];
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/.test(t.url))?.webSocketDebuggerUrl ?? null;
    },
  };
}
export type CdpSessions = ReturnType<typeof createCdpSessions>;

/**
 * The same Hands, reading and pressing the app's web content through CDP. Everything else (the
 * window, focus, typing, keys, the wheel, the capture) stays with the native hands.
 */
export function cdpHands(base: Hands, client: CdpClient): Hands {
  let page: CdpPage | null = null;
  let origin = { x: 0, y: 0 };
  const read = async (win: WindowInfo): Promise<Snapshot> => {
    const native = await base.snapshot(win);
    page = JSON.parse(String(await evaluate(client, SNAPSHOT_JS))) as CdpPage;
    // The page's top-left on screen: UIA's largest document when it has one, else the window's
    // client area (Electron apps draw their own title bar, so that's the window's corner).
    const doc = native.elements.filter((e) => e.type === "Document").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const k = page.dpr || 1;
    origin = doc ? { x: doc.x, y: doc.y } : { x: native.window.x + Math.max(0, Math.round(((page.outerWidth - page.innerWidth) / 2) * k)), y: native.window.y + Math.max(0, Math.round((page.outerHeight - page.innerHeight) * k)) };
    const web = cdpElements(page, origin);
    // Native controls outside the page (a system menu, window buttons) stay; UIA's copy of the page doesn't.
    const inPage = (e: UiElement) => e.x >= origin.x && e.y >= origin.y && e.x <= origin.x + page!.innerWidth * k && e.y <= origin.y + page!.innerHeight * k;
    return { window: native.window, elements: [...native.elements.filter((e) => !inPage(e)).map((e) => ({ ...e, web: false })), ...web], focused: web.find((e) => e.focused) ?? native.focused, browser: true };
  };
  const pressWeb = async (element: UiElement, recheck = true) => {
    const k = page?.dpr || 1;
    const now = await evaluate(client, refJs(element.id - CDP_ID_BASE));
    const fresh = now ? (JSON.parse(String(now)) as { x: number; y: number; w: number; h: number; name: string }) : null;
    const asUi = fresh ? { ...element, name: fresh.name, x: Math.round(origin.x + fresh.x * k), y: Math.round(origin.y + fresh.y * k), w: Math.round(fresh.w * k), h: Math.round(fresh.h * k) } : null;
    if (!fresh || (recheck && !sameTarget(element, asUi))) throw new RefError("STALE_REF", "That control changed just before the click, so I didn't press it.");
    const x = fresh.x + fresh.w / 2, y = fresh.y + fresh.h / 2;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await client.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  };
  return {
    ...base,
    snapshot: read,
    focused: async () => {
      const raw = await evaluate(client, FOCUSED_JS).catch(() => null);
      const one = raw ? cdpElements(JSON.parse(String(raw)) as CdpPage, origin)[0] : undefined;
      return one ?? (await base.focused());
    },
    // CDP presses never move his pointer; a native control is the native hands' business.
    press: async (handle, element, recheck) => {
      if (element.id >= CDP_ID_BASE) {
        await pressWeb(element, recheck ?? true);
        return "uia";
      }
      return base.press ? base.press(handle, element, recheck) : (await base.click(handle, centre(element).x, centre(element).y, recheck ? element : undefined), "mouse");
    },
    click: async (handle, x, y, expect) => {
      if (expect && expect.id >= CDP_ID_BASE) return pressWeb(expect, true);
      return base.click(handle, x, y, expect);
    },
  };
}

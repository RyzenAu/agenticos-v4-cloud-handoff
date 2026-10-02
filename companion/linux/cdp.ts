import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * A small Chrome DevTools Protocol client for a shared computer's browser. The browser is Chromium on this computer with its OWN
 * profile folder and a DevTools port bound to 127.0.0.1 inside the computer (never reachable from outside it). No Playwright, no
 * extra packages: HTTP for the tab list and Node/Bun's built-in WebSocket for commands.
 */

export type CdpConfig = {
  port: number;
  profileDir: string;
  /** X display (":101"); absent = run headless (no desktop packages on the host). */
  display?: string;
  chromiumPath?: string;
  noSandbox?: boolean;
  windowSize?: string;
};

export type Tab = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string };

export function findChromium(env: Record<string, string | undefined> = process.env): string | null {
  // A browser installed for this host without root (deploy/computers: install-browser) is named by the environment.
  if (env.MU_CHROMIUM && existsSync(env.MU_CHROMIUM)) return env.MU_CHROMIUM;
  const dirs = String(env.PATH ?? "").split(":").filter(Boolean);
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) for (const d of dirs) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

async function json<T>(port: number, path: string, init?: RequestInit, timeoutMs = 2_000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`DevTools ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function browserUp(port: number): Promise<boolean> {
  try {
    await json(port, "/json/version", undefined, 800);
    return true;
  } catch {
    return false;
  }
}

let child: ChildProcess | null = null;

/**
 * Is X display :N accepting clients? Xvfb listens on a socket file under /tmp/.X11-unix AND on an abstract socket of the same name. On WSLg hosts
 * /tmp/.X11-unix is a read-only mount, so the file can never exist and only the abstract socket does; Chromium and x11vnc connect through that
 * one. Looking only for the file made every WSL computer start a HEADLESS browser behind a black VNC screen (found in the round-3 real run).
 */
export function displayReady(
  display: string | number,
  deps: { exists?: (p: string) => boolean; readUnix?: () => string } = {},
): boolean {
  const n = String(display).replace(/^:/, "");
  if (!/^[0-9]+$/.test(n)) return false;
  if ((deps.exists ?? existsSync)(`/tmp/.X11-unix/X${n}`)) return true;
  let table = "";
  try {
    table = (deps.readUnix ?? (() => readFileSync("/proc/net/unix", "utf8")))();
  } catch {
    return false;
  }
  return table.split("\n").some((l) => l.trimEnd().endsWith(`@/tmp/.X11-unix/X${n}`));
}

/**
 * The browser's environment. A computer with a display is X11 only: on WSLg the host exports WAYLAND_DISPLAY and Chromium would then draw on the
 * owner's own desktop instead of this computer's Xvfb (found in the round-3 real run, together with x11vnc refusing "Wayland display server detected").
 */
export function browserEnv(display: string | undefined, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (!display) return { ...base };
  const { WAYLAND_DISPLAY: _w, XDG_SESSION_TYPE: _t, ...rest } = base;
  return { ...rest, DISPLAY: display };
}

/** Start this computer's Chromium if it is not running. Its profile and DevTools port are this computer's own. */
export async function ensureBrowser(cfg: CdpConfig, log: (line: string) => void = () => undefined): Promise<void> {
  if (await browserUp(cfg.port)) return;
  const exe = cfg.chromiumPath ?? findChromium();
  if (!exe) throw new Error("Chromium isn't installed on this computer.");
  // A previous browser killed with its computer leaves stale singleton files that stop a new one from starting on this profile.
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(cfg.profileDir, f), { force: true });
  const args = [
    `--user-data-dir=${cfg.profileDir}`,
    `--remote-debugging-port=${cfg.port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    `--window-size=${(cfg.windowSize ?? "1280,800").replace("x", ",")}`,
    ...(cfg.display ? ["--ozone-platform=x11"] : ["--headless=new", "--disable-gpu"]),
    ...(cfg.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  log(`starting ${exe} (${cfg.display ? `display ${cfg.display}` : "headless"}, port ${cfg.port})`);
  child = spawn(exe, args, { stdio: "ignore", env: browserEnv(cfg.display) });
  child.on("exit", () => (child = null));
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await browserUp(cfg.port)) return;
    if (!child) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chromium didn't start.");
}

export async function tabs(port: number): Promise<Tab[]> {
  return (await json<Tab[]>(port, "/json/list")).filter((t) => t.type === "page");
}

export async function newTab(port: number, url: string): Promise<Tab> {
  return json<Tab>(port, `/json/new?${encodeURIComponent(url)}`, { method: "PUT" }, 10_000);
}

export async function closeTab(port: number, id: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
}

/** How many pages one computer keeps open. Each page is a renderer process: a computer that opened one per navigation grew from 0.6 to 1.4 GB in 3 minutes (round-3 measurement). */
export const MAX_OPEN_TABS = 4;

/** Close the oldest pages beyond `keep`, never `except` (the page just opened). Returns the ids closed. Chromium lists the most recently used page first. */
export async function trimTabs(port: number, keep = MAX_OPEN_TABS, except?: string): Promise<string[]> {
  const list = await tabs(port);
  const rest = list.filter((t) => t.id !== except);
  const surplus = rest.slice(Math.max(0, keep - (except ? 1 : 0)));
  for (const t of surplus) await closeTab(port, t.id);
  return surplus.map((t) => t.id);
}

export class CdpSession {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "DevTools error").slice(0, 160)));
      else p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("The browser tab closed."));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs = 5_000): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("DevTools connection timed out.")), timeoutMs);
      ws.addEventListener("open", () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(t), reject(new Error("DevTools connection failed."))), { once: true });
    });
    return new CdpSession(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} timed out.`))), timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error("The page threw while being read.");
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export type PageFacts = { title: string; url: string; ready: string };

export async function readPage(session: CdpSession): Promise<PageFacts> {
  const raw = await session.evaluate<string>("JSON.stringify({title:document.title,url:location.href,ready:document.readyState})");
  return JSON.parse(raw) as PageFacts;
}

export async function screenshot(session: CdpSession, quality = 60): Promise<Uint8Array> {
  const r = await session.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality }, 15_000);
  return Uint8Array.from(Buffer.from(r.data, "base64"));
}

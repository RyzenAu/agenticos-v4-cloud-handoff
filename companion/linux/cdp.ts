import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, rmSync } from "node:fs";
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

export async function browserUp(port: number, timeoutMs = 800): Promise<boolean> {
  try {
    await json(port, "/json/version", undefined, timeoutMs);
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

/**
 * A computer with a display keeps its browser open: started now, and started again if it dies. An idle desktop with no window is a black screen on the viewer
 * ("online, but blank"); about:blank is a white page, which is a working screen. Returns the function that stops the watching.
 */
export function keepBrowserOpen(opts: {
  ensure: () => Promise<void>;
  /** Does the browser answer (given a generous timeout)? */
  alive: () => Promise<boolean>;
  /** True while a person holds the computer or a job step is in flight: the browser is theirs, and is left exactly as it is. */
  paused: () => boolean;
  log: (line: string) => void;
  everyMs?: number;
  /** Consecutive misses before it is reopened (a busy browser can miss one check). */
  misses?: number;
}): () => void {
  const open = (when: string) => void opts.ensure().catch((e) => opts.log(`couldn't open the browser ${when}: ${(e as Error).message}`));
  open("at start");
  let missed = 0;
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      try {
        if (opts.paused()) return void (missed = 0);
        if (await opts.alive()) return void (missed = 0);
        // Re-check: the person may have taken the computer while the answer was being waited for.
        if (opts.paused()) return void (missed = 0);
        if (++missed < (opts.misses ?? 2)) return;
        missed = 0;
        open("again");
      } finally {
        checking = false;
      }
    })();
  }, opts.everyMs ?? 15_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The hub's "a person holds this computer" marker in the config folder is stale at boot (the hub tells the companion again if a person still holds it): clear it. */
export function clearStaleHold(configDir: string, remove: (path: string) => void = (p) => rmSync(p, { force: true })): void {
  try {
    remove(join(configDir, "hold"));
  } catch {
    /* nothing to clear, or not ours to clear */
  }
}

export type StartDeps = {
  up: (port: number, timeoutMs: number) => Promise<boolean>;
  /** The pid named by the profile's SingletonLock ("<host>-<pid>"), or null when there is no lock. */
  lockPid: (profileDir: string) => number | null;
  alive: (pid: number) => boolean;
  removeLocks: (profileDir: string) => void;
  spawn: (exe: string, args: string[], env: Record<string, string | undefined>) => ChildProcess;
  sleep: (ms: number) => Promise<void>;
};

const defaultStartDeps: StartDeps = {
  up: browserUp,
  lockPid: (dir) => {
    try {
      const m = /-(\d+)$/.exec(readlinkSync(join(dir, "SingletonLock")));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  removeLocks: (dir) => {
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(dir, f), { force: true });
  },
  spawn: (exe, args, env) => spawn(exe, args, { stdio: "ignore", env }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let starting: Promise<void> | null = null;

/**
 * Start this computer's Chromium if it is not running. Its profile and DevTools port are this computer's own. One start at a time: the browser is opened at
 * boot and by a watchdog as well as by the first page step, and a second start while the first is still coming up would delete the first one's profile locks.
 */
export function ensureBrowser(cfg: CdpConfig, log: (line: string) => void = () => undefined, deps: StartDeps = defaultStartDeps): Promise<void> {
  starting ??= startBrowser(cfg, log, deps).finally(() => void (starting = null));
  return starting;
}

async function startBrowser(cfg: CdpConfig, log: (line: string) => void, deps: StartDeps): Promise<void> {
  if (await deps.up(cfg.port, 3_000)) return;
  const exe = cfg.chromiumPath ?? findChromium();
  if (!exe) throw new Error("Chromium isn't installed on this computer.");
  // A browser that is still RUNNING on this profile (busy, or slow to answer: it missed a check) is never started a second time: two Chromiums on one profile corrupt it.
  // Its profile locks name its pid; only a lock whose pid is dead is stale. A live one is waited for, and an answer that never comes is an error, not a second browser.
  const holder = deps.lockPid(cfg.profileDir);
  if (holder !== null && deps.alive(holder)) {
    for (let i = 0; i < 20; i++) {
      if (await deps.up(cfg.port, 3_000)) return;
      await deps.sleep(500);
    }
    throw new Error(`Chromium (pid ${holder}) is running but isn't answering; not starting a second one on its profile.`);
  }
  // A previous browser killed with its computer leaves stale singleton files that stop a new one from starting on this profile.
  deps.removeLocks(cfg.profileDir);
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
  child = deps.spawn(exe, args, browserEnv(cfg.display));
  child.on("exit", () => (child = null));
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await deps.up(cfg.port, 800)) return;
    if (!child) break;
    await deps.sleep(250);
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

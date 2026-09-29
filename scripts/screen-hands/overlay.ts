// The Jarvis cursor: a second, visibly different pointer (sky-blue arrow, "J" badge, a soft trail)
// that glides to what Jarvis means, rings it and shows a short caption ("That one — Settings, top
// right"). His own pointer is never touched by it. The native side (overlay-native.ts) is a small
// click-through layered window host; this file starts it, speaks its line protocol and keeps the
// pure maths (glide timing, where to aim) testable. Design and reasons: docs/SCREEN-CONTROL.md.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { OVERLAY_SOURCE, overlayBootstrap, overlayCompileScript } from "./overlay-native";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type OwnerClick = { button: "left" | "right"; x: number; y: number; at: number };
export type OverlayStat = { idleMs: number; x: number; y: number; visible: boolean; docked: boolean };

export interface Overlay {
  /** Glide the Jarvis cursor's tip to a point (physical pixels); resolves when it has arrived. */
  glide(to: Point, options?: { ms?: number }): Promise<void>;
  /** A pulsing ring around the target, or null to clear it. */
  ring(rect: Rect | null): void;
  /** A short caption bubble beside the Jarvis cursor, or null to clear it. */
  caption(text: string | null): void;
  /** A press ripple at the tip (Jarvis acting). */
  tap(): void;
  /** The ring flashes green and fades (the step was done). */
  flash(): void;
  /** Hide everything at once ("stop"). */
  hide(): void;
  /**
   * Companion mode: the Jarvis cursor rides beside his own pointer (a slight, springy lag) until
   * it's sent somewhere; `home()` flies it back. Off, it stays where it was last sent.
   */
  follow(on: boolean): void;
  /** Fly back beside his pointer (and ride along again when following). */
  home(ms?: number): void;
  /** A small arc orbits the badge while Jarvis is looking or thinking. */
  thinking(on: boolean): void;
  /** His idle time (ms since his last input) and pointer position; null when unavailable. */
  stat(): Promise<OverlayStat | null>;
  /** Report his own mouse clicks (never injected ones) while a lesson waits for him. */
  watch(on: boolean): void;
  onClick(listener: (click: OwnerClick) => void): () => void;
  /** Hidden from screenshots (WDA_EXCLUDEFROMCAPTURE) when true, the default. */
  excludeFromCapture(on: boolean): Promise<boolean>;
  /** Start the host now (it otherwise starts on first use). */
  warm(): void;
  /** The helper process id, for CPU/RAM checks; null when not running. */
  pid(): number | null;
  readonly affinity: boolean | null;
  close(): void;
}

// --- pure helpers --------------------------------------------------------------------------------
export const GLIDE_MIN_MS = 220;
export const GLIDE_MAX_MS = 650;

/** Glide time: quick for a hop, never slow for a long trip across monitors. */
export function glideMs(from: Point | null, to: Point) {
  if (!from) return GLIDE_MIN_MS;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 4) return 0;
  return Math.round(Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, 170 + d * 0.3)));
}

/**
 * Where the tip should rest on a control: its centre, except on wide rows (a settings expander, a
 * long field) where it sits near the label end, so the arrow points at words, not empty space.
 */
export function aimPoint(r: Rect): Point {
  // Tall controls (an open settings section, a list) are aimed at their header, not their middle.
  const y = Math.round(r.y + Math.min(r.h / 2, 34));
  if (r.w > 260) return { x: Math.round(r.x + Math.min(r.w / 2, 56)), y };
  return { x: Math.round(r.x + r.w / 2), y };
}

/**
 * The part of a control to ring: all of it, except an open expander, whose UIA rectangle covers
 * its whole body; there the ring hugs the header row he'd click.
 */
export function ringRect(r: Rect & { expanded?: boolean }): Rect {
  return r.expanded === true && r.h > 90 ? { x: r.x, y: r.y, w: r.w, h: 72 } : { x: r.x, y: r.y, w: r.w, h: r.h };
}

/** "top right", "bottom left", "middle": where a control sits on its window, for the spoken line. */
export function whereOn(r: Rect, win: Rect) {
  if (!win.w || !win.h) return "";
  const cx = (r.x + r.w / 2 - win.x) / win.w, cy = (r.y + r.h / 2 - win.y) / win.h;
  const v = cy < 0.28 ? "top" : cy > 0.72 ? "bottom" : "";
  const h = cx < 0.33 ? "left" : cx > 0.67 ? "right" : "";
  return v && h ? `${v} ${h}` : v || (h ? `on the ${h}` : "in the middle");
}

const n = (v: number) => {
  if (!Number.isFinite(v)) throw new Error("Not a coordinate.");
  return Math.round(v);
};
/** One protocol line; numbers are validated and text is base64, so nothing spoken becomes code. */
export const overlayCommand = {
  move: (p: Point, ms: number) => `move ${n(p.x)} ${n(p.y)} ${Math.max(0, n(ms))}`,
  ring: (r: Rect) => `ring ${n(r.x)} ${n(r.y)} ${Math.max(1, n(r.w))} ${Math.max(1, n(r.h))}`,
  say: (text: string | null) => (text?.trim() ? `say ${Buffer.from(text.trim().slice(0, 160), "utf8").toString("base64")}` : "say"),
};

export type OverlayEvent =
  | { type: "ready"; affinity: boolean }
  | { type: "click"; button: "left" | "right"; x: number; y: number }
  | { type: "pong"; visible: boolean; x: number; y: number; watching: boolean }
  | { type: "affinity"; ok: boolean }
  | { type: "watch"; ok: boolean }
  | ({ type: "stat" } & OverlayStat)
  | { type: "error"; message: string };

export function parseOverlayEvent(line: string): OverlayEvent | null {
  const p = line.trim().split(" ");
  switch (p[0]) {
    case "ready":
      return { type: "ready", affinity: p[1] === "1" };
    case "click":
      return p.length >= 4 && Number.isFinite(+p[2]) && Number.isFinite(+p[3]) ? { type: "click", button: p[1] === "right" ? "right" : "left", x: +p[2], y: +p[3] } : null;
    case "pong":
      return { type: "pong", visible: p[1] === "1", x: +p[2] || 0, y: +p[3] || 0, watching: p[4] === "1" };
    case "affinity":
      return { type: "affinity", ok: p[1] === "1" };
    case "watch":
      return { type: "watch", ok: p[1] === "1" };
    case "stat":
      return p.length >= 4 && [p[1], p[2], p[3]].every((v) => Number.isFinite(+v))
        ? { type: "stat", idleMs: Math.max(0, +p[1]), x: +p[2], y: +p[3], visible: p[4] === "1", docked: p[5] === "1" }
        : null;
    case "error":
      return { type: "error", message: p.slice(1).join(" ").slice(0, 300) };
  }
  return null;
}

// --- the real overlay ------------------------------------------------------------------------------
/** A do-nothing overlay (tests, other platforms): every call resolves at once. */
export function nullOverlay(): Overlay {
  return {
    glide: async () => undefined,
    ring: () => undefined,
    caption: () => undefined,
    tap: () => undefined,
    flash: () => undefined,
    hide: () => undefined,
    follow: () => undefined,
    home: () => undefined,
    thinking: () => undefined,
    stat: async () => null,
    watch: () => undefined,
    onClick: () => () => undefined,
    excludeFromCapture: async () => false,
    warm: () => undefined,
    pid: () => null,
    affinity: null,
    close: () => undefined,
  };
}

/** Where the compiled overlay lives: its name carries the source's hash, so an edit rebuilds it. */
export function overlayExePath(base = process.env.LOCALAPPDATA || "", source = OVERLAY_SOURCE) {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return join(base, "AgenticOS", "jarvis-overlay", `jarvis-overlay-${hash}.exe`);
}

/** Compile the overlay exe once (~3 s, hidden); null if that isn't possible here. */
function compiledOverlay(): Promise<string | null> {
  if (!process.env.LOCALAPPDATA) return Promise.resolve(null);
  const exe = overlayExePath();
  if (existsSync(exe)) return Promise.resolve(exe);
  try {
    mkdirSync(dirname(exe), { recursive: true });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    // The script is too long for -EncodedCommand (Windows caps a command line near 32k): stdin.
    const proc = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true, timeout: 90_000 }, () =>
      resolve(existsSync(exe) ? exe : null),
    );
    proc.stdin?.on("error", () => undefined);
    proc.stdin?.end(`${overlayCompileScript(exe)}\n`);
  });
}

/**
 * The overlay host, started on first use and restarted if it dies. It must be started by the OS
 * server (or the voice session), never by a one-off script, since it lives as long as its parent.
 * It runs as a small compiled exe (built once into %LOCALAPPDATA%/AgenticOS/jarvis-overlay), or,
 * if that can't be built, in a hidden PowerShell with the same code.
 */
/**
 * Are we inside `bun test`? NODE_ENV=test, or (when NODE_ENV was already set by the parent, R8 review §6) the
 * entry point is a test file: under bun test, Bun.main is the test file itself.
 */
export function underTest(env: Record<string, string | undefined> = process.env, main: string | undefined = (globalThis as { Bun?: { main?: string } }).Bun?.main) {
  return env.NODE_ENV === "test" || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(String(main ?? ""));
}
export function createOverlay(options: { sleep?: (ms: number) => Promise<void>; compiled?: boolean } = {}): Overlay {
  if (process.platform !== "win32") return nullOverlay();
  // Under `bun test` (NODE_ENV=test) a screen-hands built without an overlay would start the real overlay exe on
  // his live screen, once per test, and leave it running (28 Sep: 70+ strays). Tests get the null overlay unless
  // one opts in explicitly.
  if (underTest() && process.env.AGENTIC_OVERLAY_IN_TESTS !== "1") return nullOverlay();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let exe: Promise<string | null> | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<boolean> | null = null;
  let buffer = "";
  let affinity: boolean | null = null;
  let at: Point | null = null;
  let watching = false;
  let generation = 0;
  const clickListeners = new Set<(c: OwnerClick) => void>();
  const waiters: Array<{ type: OverlayEvent["type"]; resolve: (e: OverlayEvent) => void }> = [];

  const onEvent = (event: OverlayEvent) => {
    if (event.type === "click") for (const l of clickListeners) l({ button: event.button, x: event.x, y: event.y, at: Date.now() });
    const i = waiters.findIndex((w) => w.type === event.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(event);
  };
  const next = (type: OverlayEvent["type"], ms: number) =>
    new Promise<OverlayEvent | null>((resolve) => {
      const waiter = { type, resolve: (e: OverlayEvent) => (clearTimeout(timer), resolve(e)) };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      waiters.push(waiter);
    });

  function start(): Promise<boolean> {
    if (ready) return ready;
    ready = (async () => {
      exe ??= options.compiled === false ? Promise.resolve(null) : compiledOverlay();
      const path = await exe;
      if (path && (await launch(path))) return true;
      exe = Promise.resolve(null);
      const ok = await launch(null);
      // Neither started: let the next call try again rather than failing for good.
      if (!ok) setTimeout(() => (ready = null), 0);
      return ok;
    })();
    return ready;
  }

  function launch(path: string | null): Promise<boolean> {
    const proc = path
      ? spawn(path, [], { windowsHide: true })
      : spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
    child = proc;
    buffer = "";
    at = null;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (data: string) => {
      buffer += data;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const event = line ? parseOverlayEvent(line) : null;
        if (event) onEvent(event);
      }
    });
    proc.stderr.on("data", () => undefined);
    const gone = () => {
      if (child === proc) {
        child = null;
        ready = null;
        watching = false;
      }
    };
    proc.on("exit", gone);
    proc.on("error", gone);
    proc.stdin.on("error", () => undefined);
    const up = next("ready", 20_000).then((e) => {
      if (!e || e.type !== "ready") {
        if (child === proc) proc.kill();
        return false;
      }
      affinity = e.affinity;
      return true;
    });
    if (!path) for (const line of overlayBootstrap()) proc.stdin.write(`${line}\n`);
    return up;
  }

  const send = (line: string) => {
    void start().then((ok) => {
      if (ok && child) child.stdin.write(`${line}\n`);
    });
  };

  return {
    async glide(to, opts = {}) {
      const mine = generation;
      if (!(await start()) || mine !== generation) return;
      const ms = opts.ms ?? glideMs(at, to);
      send(overlayCommand.move(to, ms));
      at = { x: to.x, y: to.y };
      if (ms > 0) await sleep(ms + 20);
    },
    ring: (rect) => (rect ? send(overlayCommand.ring(rect)) : child && send("unring")),
    caption: (text) => send(overlayCommand.say(text)),
    tap: () => send("tap"),
    flash: () => send("flash"),
    hide() {
      // A glide still waiting for the helper to start must not show the cursor after a stop.
      generation++;
      at = null;
      if (child) child.stdin.write("hide\n");
    },
    follow(on) {
      // Following starts the helper (the cursor appears beside his); off only matters if it's up.
      if (on || child) send(`follow ${on ? 1 : 0}`);
      if (on) at = null;
    },
    home(ms) {
      if (!child) return;
      send(`home ${Math.max(0, Math.round(ms ?? 0))}`);
      at = null;
    },
    thinking(on) {
      if (on || child) send(`think ${on ? 1 : 0}`);
    },
    async stat() {
      if (!child) return null;
      const reply = next("stat", 1500);
      send("stat");
      const e = await reply;
      return e?.type === "stat" ? { idleMs: e.idleMs, x: e.x, y: e.y, visible: e.visible, docked: e.docked } : null;
    },
    watch(on) {
      if (on === watching) return;
      watching = on;
      if (on || child) send(`watch ${on ? 1 : 0}`);
    },
    onClick(listener) {
      clickListeners.add(listener);
      return () => void clickListeners.delete(listener);
    },
    async excludeFromCapture(on) {
      if (!(await start())) return false;
      const reply = next("affinity", 3000);
      send(`affinity ${on ? 1 : 0}`);
      const e = await reply;
      return e?.type === "affinity" && e.ok;
    },
    warm: () => void start().catch(() => undefined),
    pid: () => child?.pid ?? null,
    get affinity() {
      return affinity;
    },
    close() {
      const proc = child;
      child = null;
      ready = null;
      try {
        proc?.stdin.end("quit\n");
        setTimeout(() => proc?.kill(), 500).unref?.();
      } catch {
        /* already gone */
      }
    },
  };
}

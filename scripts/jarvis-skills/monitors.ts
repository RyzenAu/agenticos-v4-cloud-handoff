// His screens, as Windows lays them out: which is the main one, which is "the other", left, right
// or on top, and where a window goes when it moves between them. Pure geometry (the Win32 calls
// are JarvisWin.Monitors/State/Place in ps-host.ts), so it's tested with made-up layouts: a
// secondary left of or above the main screen has negative coordinates, and each screen can have its
// own display scale. Everything here is in physical pixels (the helper is per-monitor DPI aware).

export type Rect = { x: number; y: number; w: number; h: number };
export type Monitor = { id: number; bounds: Rect; work: Rect; primary: boolean; dpi: number; device: string };
/** What he calls a screen. "main" is Windows' primary display; left/right/top/bottom by position. */
export type ScreenName = "main" | "other" | "left" | "right" | "top" | "bottom" | "third";

/** Rows from [JarvisWin]::Monitors(): id, bounds x y w h, work x y w h, primary, dpi, device. */
export function parseMonitors(text: string): Monitor[] {
  return text
    .split(/\r?\n/)
    .map((row) => row.split("\t"))
    .filter((c) => c.length >= 11 && c.slice(0, 11).every((v) => /^-?\d+$/.test(v.trim())))
    .map((c) => {
      const n = c.slice(0, 11).map(Number);
      return { id: n[0], bounds: { x: n[1], y: n[2], w: n[3], h: n[4] }, work: { x: n[5], y: n[6], w: n[7], h: n[8] }, primary: n[9] === 1, dpi: n[10] || 96, device: (c[11] ?? "").trim() };
    });
}

export type WindowState = { handle: number; minimised: boolean; maximised: boolean; restoreMaximised: boolean; rect: Rect; normal: Rect; monitor: number };
/** One row from [JarvisWin]::State(h): handle, minimised, maximised, restore-to-maximised, rect x y w h, normal x y w h, monitor. */
export function parseWindowState(text: string): WindowState | null {
  const c = text.trim().split("\t");
  if (c.length < 13 || !c.every((v) => /^-?\d+$/.test(v))) return null;
  const n = c.map(Number);
  return { handle: n[0], minimised: n[1] === 1, maximised: n[2] === 1, restoreMaximised: n[3] === 1, rect: { x: n[4], y: n[5], w: n[6], h: n[7] }, normal: { x: n[8], y: n[9], w: n[10], h: n[11] }, monitor: n[12] };
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The screen a rectangle is mostly on (Windows' own rule: the largest overlap, else the nearest). */
export function monitorOf(monitors: Monitor[], r: Rect): Monitor | null {
  if (!monitors.length) return null;
  let best = monitors[0];
  let most = -1;
  for (const m of monitors) {
    const o = overlap(m.bounds, r);
    if (o > most) (best = m), (most = o);
  }
  if (most > 0) return best;
  const c = centre(r);
  const d = (m: Monitor) => Math.hypot(centre(m.bounds).x - c.x, centre(m.bounds).y - c.y);
  return [...monitors].sort((a, b) => d(a) - d(b))[0];
}

/** How he'd name a screen: "your main screen", "the left screen", "the top screen". */
export function screenLabel(monitors: Monitor[], m: Monitor): string {
  if (m.primary) return "your main screen";
  const main = monitors.find((x) => x.primary) ?? monitors[0];
  const c = centre(m.bounds);
  const b = main.bounds;
  const side = c.x < b.x ? "left" : c.x >= b.x + b.w ? "right" : c.y < b.y ? "top" : c.y >= b.y + b.h ? "bottom" : "";
  const others = monitors.filter((x) => !x.primary);
  if (others.length === 1) return side ? `your other screen, on the ${side}` : "your other screen";
  // Two on the same side: tell them apart by their order along that side.
  const sameSide = others.filter((x) => screenLabelSide(main, x) === side);
  if (side && sameSide.length > 1) {
    const order = [...sameSide].sort((a, z) => (side === "left" || side === "right" ? centre(a.bounds).x - centre(z.bounds).x : centre(a.bounds).y - centre(z.bounds).y));
    return `the ${ordinal(order.indexOf(m) + 1)} ${side} screen`;
  }
  return side ? `the ${side} screen` : "another screen";
}
function screenLabelSide(main: Monitor, m: Monitor) {
  const c = centre(m.bounds);
  const b = main.bounds;
  return c.x < b.x ? "left" : c.x >= b.x + b.w ? "right" : c.y < b.y ? "top" : c.y >= b.y + b.h ? "bottom" : "";
}
const ordinal = (n: number) => ["first", "second", "third", "fourth"][n - 1] ?? `${n}th`;

export type Pick = { monitor: Monitor } | { ask: string } | { none: string };
/**
 * The screen he means. "other" is relative to where the window is now: with two screens it's the
 * one it isn't on; with three it's asked unless only one isn't the main or current screen.
 */
export function pickMonitor(monitors: Monitor[], name: ScreenName, current?: Monitor | null): Pick {
  if (!monitors.length) return { none: "I can't see any screens, sir." };
  const main = monitors.find((m) => m.primary) ?? monitors[0];
  if (monitors.length === 1) return name === "main" ? { monitor: main } : { none: "You've only got the one screen connected, sir." };
  const byX = [...monitors].sort((a, b) => centre(a.bounds).x - centre(b.bounds).x);
  switch (name) {
    case "main":
      return { monitor: main };
    case "left":
      return { monitor: byX[0] };
    case "right":
      return { monitor: byX[byX.length - 1] };
    case "top": {
      // Only a screen actually above the main one (a screen beside it isn't "on top").
      const above = monitors.filter((m) => centre(m.bounds).y < main.bounds.y).sort((a, b) => a.bounds.y - b.bounds.y);
      return above[0] ? { monitor: above[0] } : { none: "None of your screens is above the main one, sir." };
    }
    case "bottom": {
      const below = monitors.filter((m) => centre(m.bounds).y >= main.bounds.y + main.bounds.h).sort((a, b) => b.bounds.y - a.bounds.y);
      return below[0] ? { monitor: below[0] } : { none: "None of your screens is below the main one, sir." };
    }
    case "third": {
      const rest = monitors.filter((m) => m !== main).sort((a, b) => centre(a.bounds).x - centre(b.bounds).x);
      return rest[1] ? { monitor: rest[1] } : { none: "You've only got two screens, sir." };
    }
    case "other": {
      const here = current ?? main;
      const rest = monitors.filter((m) => m.id !== here.id);
      if (rest.length === 1) return { monitor: rest[0] };
      // Three or more: from the main screen, "other" is ambiguous; from a side screen, it's the main one.
      if (!here.primary) return { monitor: main };
      const names = rest.map((m) => screenLabel(monitors, m).replace(/^(?:the|your) /, ""));
      return { ask: `Which one, sir: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?` };
    }
  }
}

/**
 * Where a window lands on another screen: the same place relative to the work area (so the taskbar
 * is never covered), the same size in logical pixels (a 150% screen gets a bigger physical window),
 * and never larger than the work area or hanging off it.
 */
export function placeRect(r: Rect, from: Monitor, to: Monitor): Rect {
  const scale = (to.dpi || 96) / (from.dpi || 96);
  const w = Math.min(Math.round(r.w * scale), to.work.w);
  const h = Math.min(Math.round(r.h * scale), to.work.h);
  const fx = from.work.w > r.w ? (r.x - from.work.x) / (from.work.w - r.w) : 0.5;
  const fy = from.work.h > r.h ? (r.y - from.work.y) / (from.work.h - r.h) : 0;
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
  return { x: Math.round(to.work.x + clamp(fx) * (to.work.w - w)), y: Math.round(to.work.y + clamp(fy) * (to.work.h - h)), w, h };
}

/** Is a rectangle (a window's place after the move) on that screen? */
export const isOn = (r: Rect, m: Monitor) => inside(centre(r), m.bounds);

/** Physical point → a spot in the virtual desktop (all screens), for absolute SendInput (0..65535). */
export function toAbsolute(p: { x: number; y: number }, virtual: Rect) {
  return { dx: Math.round(((p.x - virtual.x) * 65535) / Math.max(1, virtual.w - 1)), dy: Math.round(((p.y - virtual.y) * 65535) / Math.max(1, virtual.h - 1)) };
}
/** The bounding box of every screen (SM_XVIRTUALSCREEN …). */
export function virtualDesktop(monitors: Monitor[]): Rect {
  const x = Math.min(...monitors.map((m) => m.bounds.x));
  const y = Math.min(...monitors.map((m) => m.bounds.y));
  return { x, y, w: Math.max(...monitors.map((m) => m.bounds.x + m.bounds.w)) - x, h: Math.max(...monitors.map((m) => m.bounds.y + m.bounds.h)) - y };
}

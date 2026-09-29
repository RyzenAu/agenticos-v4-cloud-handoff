// A fake Windows for the J2 tests and the synthetic live check: two Chromes (his own, and Jarvis Chrome), the Jarvis app in
// front, two screens. Records what was run; touches nothing real.
import { b64, type PsHost } from "../jarvis-skills/ps-host";

export const MAIN = { id: 65691, x: 0, y: 0, w: 2560, h: 1440 };
export const LEFT = { id: 131073, x: -1920, y: 0, w: 1920, h: 1080 };
export const JARVIS_CHROME_PID = 4242;
export function fakeWindows(opts: { jarvisChromeOn?: "main" | "left" } = {}) {
  const scripts: string[] = [];
  const wins = [
    { handle: 5, process: "Jarvis", cls: "Tauri", title: "Jarvis v0.2 · shell 0.2.1", pid: 1 },
    { handle: 77, process: "chrome", cls: "Chrome_WidgetWin_1", title: "New Tab - Google Chrome", pid: JARVIS_CHROME_PID },
    { handle: 78, process: "chrome", cls: "Chrome_WidgetWin_1", title: "His own browsing - Google Chrome", pid: 999 },
    { handle: 79, process: "Code", cls: "Chrome_WidgetWin_1", title: "index.ts - Visual Studio Code", pid: 55 },
    { handle: 80, process: "notepad", cls: "Notepad", title: "Untitled - Notepad", pid: 56 },
  ];
  const at: Record<number, { x: number; y: number; w: number; h: number; mon: number }> = {
    77: opts.jarvisChromeOn === "main" ? { x: 100, y: 100, w: 1200, h: 800, mon: MAIN.id } : { x: -1800, y: 100, w: 1200, h: 800, mon: LEFT.id },
  };
  let foreground = 5;
  const ps: PsHost = {
    run: async (script) => {
      scripts.push(script);
      const row = (w: (typeof wins)[number]) => [w.handle, w.process, w.cls, w.title].join("\t");
      if (script.includes("List()")) return b64(wins.map(row).join("\n"));
      if (script.includes("Foreground()")) return b64(row(wins.find((w) => w.handle === foreground)!));
      if (script.includes("Monitors()"))
        return [MAIN, LEFT].map((m) => [m.id, m.x, m.y, m.w, m.h, m.x, m.y, m.w, m.h - 48, m.id === MAIN.id ? 1 : 0, 96, `\\\\.\\DISPLAY${m.id}`].join("\t")).join("\n");
      const pid = script.match(/PidOf\((\d+)\)/);
      if (pid) return String(wins.find((w) => w.handle === Number(pid[1]))?.pid ?? 0);
      const st = script.match(/State\((\d+)\)/);
      if (st) {
        const h = Number(st[1]);
        const p = at[h] ?? { x: 100, y: 100, w: 1000, h: 700, mon: MAIN.id };
        return `${h}\t0\t0\t0\t${p.x}\t${p.y}\t${p.w}\t${p.h}\t${p.x}\t${p.y}\t${p.w}\t${p.h}\t${p.mon}`;
      }
      const place = script.match(/Place\((\d+), (-?\d+), (-?\d+), (\d+), (\d+)/);
      if (place) {
        const [h, x, y, w, hh] = place.slice(1).map(Number);
        at[h] = { x, y, w, h: hh, mon: x < 0 ? LEFT.id : MAIN.id };
        return "OK";
      }
      const focus = script.match(/Focus\((\d+)\)/);
      if (focus) {
        foreground = Number(focus[1]);
        return "True";
      }
      return "OK";
    },
    close: () => undefined,
    warm: () => undefined,
  };
  return { ps, scripts, at, foreground: () => foreground };
}

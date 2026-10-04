import { describe, expect, test } from "bun:test";
import { isOn, monitorOf, parseMonitors, parseWindowState, pickMonitor, placeRect, screenLabel, toAbsolute, virtualDesktop, type Monitor } from "./monitors";
import { answerWindow, windowIntent, windowPlaceIntent } from "./windows";
import { b64, type PsHost } from "./ps-host";

const mon = (id: number, x: number, y: number, w: number, h: number, primary: boolean, dpi = 96, taskbar = 48): Monitor => ({
  id, bounds: { x, y, w, h }, work: { x, y, w, h: h - taskbar }, primary, dpi, device: `\\\\.\\DISPLAY${id}`,
});
// Two screens: a 150% 4K main, and a 100% 1080p on its left (negative X).
const MAIN = mon(1, 0, 0, 3840, 2160, true, 144, 72);
const LEFT = mon(2, -1920, 0, 1920, 1080, false, 96);
const TWO = [MAIN, LEFT];
// His real layout (25 Sep): 1440p main, 1080p on the left, 1080p above and offset (negative X and Y).
const HIS = [mon(65691, 0, 0, 2560, 1440, true), mon(131073, -1920, 0, 1920, 1080, false), mon(26087091, -877, -1080, 1920, 1080, false)];

describe("his screens", () => {
  test("rows from the helper", () => {
    const rows = "65691\t0\t0\t2560\t1440\t0\t0\t2560\t1392\t1\t96\t\\\\.\\DISPLAY1\n131073\t-1920\t0\t1920\t1080\t-1920\t0\t1920\t1032\t0\t144\t\\\\.\\DISPLAY2\nbad";
    const ms = parseMonitors(rows);
    expect(ms).toHaveLength(2);
    expect(ms[1]).toMatchObject({ id: 131073, bounds: { x: -1920, y: 0, w: 1920, h: 1080 }, work: { h: 1032 }, primary: false, dpi: 144 });
    expect(parseWindowState("42\t1\t0\t1\t-32000\t-32000\t160\t28\t-1800\t100\t1200\t800\t131073")).toMatchObject({ minimised: true, restoreMaximised: true, normal: { x: -1800, y: 100, w: 1200, h: 800 }, monitor: 131073 });
    expect(parseWindowState("junk")).toBeNull();
  });
  test("names: main, left, top", () => {
    expect(HIS.map((m) => screenLabel(HIS, m))).toEqual(["your main screen", "the left screen", "the top screen"]);
    expect(screenLabel(TWO, LEFT)).toBe("your other screen, on the left");
  });
  test("which screen a window is on: the biggest overlap, negative coordinates included", () => {
    expect(monitorOf(TWO, { x: -1500, y: 100, w: 800, h: 600 })?.id).toBe(2);
    expect(monitorOf(TWO, { x: -300, y: 100, w: 1000, h: 600 })?.id).toBe(1);
    expect(monitorOf(HIS, { x: -500, y: -900, w: 800, h: 600 })?.id).toBe(26087091);
    // A minimised window's -32000 spot: the nearest screen, never a crash.
    expect(monitorOf(TWO, { x: -32000, y: -32000, w: 160, h: 28 })).not.toBeNull();
  });
  test("picking: main, other (relative to where it is), left, right, top; ambiguity asks", () => {
    const id = (p: ReturnType<typeof pickMonitor>) => ("monitor" in p ? p.monitor.id : "ask" in p ? "ask" : "none");
    expect(id(pickMonitor(TWO, "main", LEFT))).toBe(1);
    expect(id(pickMonitor(TWO, "other", MAIN))).toBe(2);
    expect(id(pickMonitor(TWO, "other", LEFT))).toBe(1);
    expect(id(pickMonitor(TWO, "left"))).toBe(2);
    expect(id(pickMonitor(TWO, "right"))).toBe(1);
    expect(id(pickMonitor(TWO, "top"))).toBe("none");
    expect(id(pickMonitor(HIS, "top"))).toBe(26087091);
    expect(id(pickMonitor(HIS, "left"))).toBe(131073);
    expect(id(pickMonitor(HIS, "other", HIS[1]))).toBe(65691);
    const ask = pickMonitor(HIS, "other", HIS[0]);
    expect("ask" in ask && ask.ask).toBe("Which one, sir: left screen or top screen?");
    expect(id(pickMonitor([MAIN], "other"))).toBe("none");
  });
  test("placing: same spot in the work area, same logical size across display scales, never off-screen", () => {
    // 1000x700 at 100% on the left screen → 1500x1050 physical on the 150% main screen.
    const r = placeRect({ x: -1920 + 460, y: 166, w: 1000, h: 700 }, LEFT, MAIN);
    expect(r.w).toBe(1500);
    expect(r.h).toBe(1050);
    expect(isOn(r, MAIN)).toBe(true);
    expect(r.x).toBeGreaterThanOrEqual(MAIN.work.x);
    expect(r.y + r.h).toBeLessThanOrEqual(MAIN.work.y + MAIN.work.h);
    // And back: 2400x1600 physical at 150% is 1600x1067 at 100%, clamped to the 1920x1032 work area.
    const back = placeRect({ x: 200, y: 100, w: 2400, h: 1600 }, MAIN, LEFT);
    expect(back).toMatchObject({ w: 1600, h: 1032 });
    expect(back.x).toBeGreaterThanOrEqual(-1920);
    expect(back.x + back.w).toBeLessThanOrEqual(0);
    expect(isOn(back, LEFT)).toBe(true);
    // Onto the screen above his main one (negative X and Y).
    const up = placeRect({ x: 600, y: 300, w: 1200, h: 800 }, HIS[0], HIS[2]);
    expect(isOn(up, HIS[2])).toBe(true);
    expect(up.y).toBeLessThan(0);
  });
  test("absolute input spans every screen (SM_XVIRTUALSCREEN…): the left screen's corner is 0, the main's far edge 65535", () => {
    const v = virtualDesktop(HIS);
    expect(v).toEqual({ x: -1920, y: -1080, w: 4480, h: 2520 });
    expect(toAbsolute({ x: -1920, y: -1080 }, v)).toEqual({ dx: 0, dy: 0 });
    expect(toAbsolute({ x: 2559, y: 1439 }, v)).toEqual({ dx: 65535, dy: 65535 });
    expect(toAbsolute({ x: 0, y: 0 }, v).dx).toBeGreaterThan(0);
  });
});

describe("window management by name and screen (routing)", () => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ["bring the Chrome browser up on my main screen", { action: "bring", target: "chrome", screen: "main" }],
    ["Can you bring the tab in front of my screen right now?", { action: "bring", target: "browser", screen: "main" }],
    ["Can you open my Chrome tab? It's uncovered. It's not showing up in my front screen.", { action: "bring", target: "chrome", screen: "main" }],
    ["bring up Spotify", { action: "bring", target: "spotify" }],
    ["show Notepad on my other monitor", { action: "bring", target: "notepad", screen: "other" }],
    ["put VS Code on the left screen", { action: "move", target: "vs code", screen: "left" }],
    ["move it to my other screen", { action: "move", target: "front", screen: "other" }],
    ["send this window to the top monitor", { action: "move", target: "front", screen: "top" }],
    ["restore Chrome on my primary display", { action: "bring", target: "chrome", screen: "main" }],
    ["switch to Excel on my second screen", { action: "bring", target: "excel", screen: "other" }],
    ["get WhatsApp back up", { action: "bring", target: "whatsapp" }],
    ["which screen is that on", { action: "where", target: "front" }],
    ["what monitor is Chrome on", { action: "where", target: "chrome" }],
    ["where's my Notepad window", { action: "where", target: "notepad" }],
    ["Chrome isn't showing up on my main screen", { action: "bring", target: "chrome", screen: "main" }],
  ];
  for (const [said, want] of cases)
    test(said, () => {
      expect(windowIntent(said)).toEqual(want ? { skill: "window", ...want } : null);
    });
  test("his answer to 'which one?' finishes the earlier request", async () => {
    const { windowFollowUp } = await import("./windows");
    const asked = "Which one, sir: left screen or top screen?";
    expect(windowFollowUp("the left one", "move it to my other screen", asked)).toEqual({ skill: "window", action: "move", target: "front", screen: "left" });
    expect(windowFollowUp("top", "put Chrome on my other monitor", JSON.stringify({ said: asked }))).toEqual({ skill: "window", action: "move", target: "chrome", screen: "top" });
    expect(windowFollowUp("the left one", "move it to my other screen", "Done, sir.")).toBeNull();
    expect(windowFollowUp("what's the time", "move it to my other screen", asked)).toBeNull();
  });
  test("never a click, a search or typing; never other things that move", () => {
    for (const said of [
      "click the search bar on my main screen",
      "type hello on my other screen",
      "search YouTube for lo-fi on my main screen",
      "move the meeting to Friday",
      "open chrome",
      "show my calendar",
      "restore",
      "switch to call mode",
      "what's on my screen",
      "close the window on my other screen",
      "play music on my main screen",
    ])
      expect(windowPlaceIntent(said)).toBeNull();
    expect(windowIntent("switch to Chrome")).toEqual({ skill: "window", action: "switch", target: "chrome" });
  });
});

describe("bringing a window over (fake Windows)", () => {
  function fakePs(opts: { minimised?: boolean; maximised?: boolean; monitor?: number; landOn?: number } = {}) {
    const scripts: string[] = [];
    let placed: [number, number, number, number] | null = null;
    const ps: PsHost = {
      run: async (script) => {
        scripts.push(script);
        if (script.includes("List()")) return b64("77\tchrome\tChrome_WidgetWin_1\tInbox - Google Chrome\n78\tnotepad\tNotepad\tUntitled - Notepad");
        if (script.includes("Foreground()")) return b64("78\tnotepad\tNotepad\tUntitled - Notepad");
        if (script.includes("Monitors()")) return HIS.map((m) => [m.id, m.bounds.x, m.bounds.y, m.bounds.w, m.bounds.h, m.work.x, m.work.y, m.work.w, m.work.h, m.primary ? 1 : 0, m.dpi, m.device].join("\t")).join("\n");
        if (script.includes("State(")) {
          if (placed) return `77\t0\t${opts.maximised ? 1 : 0}\t0\t${placed.join("\t")}\t${placed.join("\t")}\t${opts.landOn ?? 65691}`;
          return `77\t${opts.minimised ? 1 : 0}\t${opts.maximised ? 1 : 0}\t${opts.maximised ? 1 : 0}\t-1800\t100\t1200\t800\t-1800\t100\t1200\t800\t${opts.monitor ?? 131073}`;
        }
        const p = script.match(/Place\(77, (-?\d+), (-?\d+), (\d+), (\d+), \$(true|false)\)/);
        if (p) {
          placed = opts.landOn === 131073 ? [-1800, 100, 1200, 800] : [Number(p[1]), Number(p[2]), Number(p[3]), Number(p[4])];
          return placed.join("\t");
        }
        if (script.includes("Focus(")) return "True";
        return "OK";
      },
      close: () => undefined,
      warm: () => undefined,
    };
    return { ps, scripts };
  }
  test("from the left screen to the main one: restored, moved, maximised again, in front; nothing clicked or typed", async () => {
    const { ps, scripts } = fakePs({ minimised: true, maximised: true });
    expect(await answerWindow({ skill: "window", action: "bring", target: "chrome", screen: "main" }, ps)).toBe("Google Chrome is on your main screen now, sir.");
    const place = scripts.find((s) => s.includes("Place("))!;
    const [x, y] = place.match(/Place\(77, (-?\d+), (-?\d+)/)!.slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(place).toContain("$true");
    expect(scripts.some((s) => /Focus\(77\)/.test(s))).toBe(true);
    expect(scripts.some((s) => /Chord|Click|SendKeys|Paste|Type\(/.test(s))).toBe(false);
  });
  test("already on that screen: just restored and put in front", async () => {
    const { ps, scripts } = fakePs({ minimised: true, monitor: 65691 });
    // (the fake reports the rect on the left screen until placed; the monitor id says main)
    const said = await answerWindow({ skill: "window", action: "bring", target: "chrome", screen: "main" }, ps);
    expect(scripts.some((s) => s.includes("Place("))).toBe(false);
    expect(scripts.some((s) => /ShowWindow\(\[IntPtr\]::new\(77\), 9\)/.test(s))).toBe(true);
    expect(said).toMatch(/Chrome/);
  });
  test("Windows didn't move it: said so, not claimed", async () => {
    const { ps } = fakePs({ landOn: 131073 });
    expect(await answerWindow({ skill: "window", action: "bring", target: "chrome", screen: "main" }, ps)).toBe("I tried to put Google Chrome on your main screen, sir, but Windows didn't move it.");
  });
  test("three screens and 'other' from the main one: asks which", async () => {
    const { ps } = fakePs({ monitor: 65691 });
    expect(await answerWindow({ skill: "window", action: "move", target: "chrome", screen: "other" }, ps)).toBe("Which one, sir: left screen or top screen?");
  });
  test("which screen", async () => {
    expect(await answerWindow({ skill: "window", action: "where", target: "chrome" }, fakePs().ps)).toBe("Google Chrome is on the left screen, sir.");
    expect(await answerWindow({ skill: "window", action: "where", target: "chrome" }, fakePs({ minimised: true }).ps)).toBe("Google Chrome is minimised, sir. It was on the left screen.");
  });
  test("no window: launched when he asked to bring it up; asked when he said 'it'", async () => {
    const { ps } = fakePs();
    expect(await answerWindow({ skill: "window", action: "bring", target: "spotify" }, ps, { launch: async (a) => `${a} is opening.` })).toBe("spotify is opening.");
    expect(await answerWindow({ skill: "window", action: "bring", target: "spotify", screen: "main" }, ps)).toMatch(/can't see a spotify window/);
  });
});

describe("a screen task for a named app stays on that app", () => {
  test("names only after in / into / on", async () => {
    const { appNamedIn, windowIsApp } = await import("./windows");
    expect(appNamedIn("show my bookmarks in Chrome")).toBe("chrome");
    expect(appNamedIn("type milk, eggs into Notepad")).toBe("notepad");
    expect(appNamedIn("click the Code tab")).toBeNull();
    expect(appNamedIn("turn off email alerts in this app")).toBeNull();
    expect(windowIsApp("chrome", "chrome")).toBe(true);
    expect(windowIsApp("chrome", "claude")).toBe(false);
  });
});

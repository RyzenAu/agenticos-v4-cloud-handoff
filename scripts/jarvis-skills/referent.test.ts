// J-fix (29 Sep, owner's live test): "open a Chrome tab" then "bring it to my front screen" moved the Jarvis
// desktop app. The window skill now remembers what Jarvis opened or moved ("it"), never picks Jarvis' own
// window, and "open a Chrome tab" puts Jarvis Chrome's window on the main screen, in front, and says so.
// SYNTHETIC: a fake Windows (PsHost) with two screens; nothing real is opened, moved or focused.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisSkills, parseSkillRequest } from "./index";
import { b64, type PsHost } from "./ps-host";
import { forgetReferent, isJarvisOwnWindow, rememberReferent } from "./referent";
import { windowComplaintIntent, windowIntent, windowPlaceIntent } from "./windows";

// His screens: a 1440p main, a 1080p on the left (negative X).
const MONITORS = "1\t0\t0\t2560\t1440\t0\t0\t2560\t1392\t1\t96\t\\\\.\\DISPLAY1\n2\t-1920\t0\t1920\t1080\t-1920\t0\t1920\t1032\t0\t96\t\\\\.\\DISPLAY2";
// Front-most first: the Jarvis desktop app (in front), his own Chrome, Jarvis Chrome's new tab, Notepad.
const WINDOWS = [
  "90\tapp\tTauri Window\tJarvis v3.6.1 (5eca7f0) · shell 0.2.1",
  "79\tchrome\tChrome_WidgetWin_1\tInbox - Google Chrome",
  "77\tchrome\tChrome_WidgetWin_1\tNew Tab - Google Chrome",
  "78\tnotepad\tNotepad\tUntitled - Notepad",
].join("\n");
const JARVIS_CHROME_PID = 4242;

function fakeWindows() {
  const scripts: string[] = [];
  const placed = new Map<number, [number, number, number, number]>();
  const ps: PsHost = {
    run: async (script) => {
      scripts.push(script);
      if (script.includes("List()")) return b64(WINDOWS);
      if (script.includes("Foreground()")) return b64(WINDOWS.split("\n")[0]);
      if (script.includes("Monitors()")) return MONITORS;
      const pid = script.match(/PidOf\((\d+)\)/);
      if (pid) return String(Number(pid[1]) === 77 ? JARVIS_CHROME_PID : 1111);
      const st = script.match(/State\((\d+)\)/);
      if (st) {
        const h = Number(st[1]);
        const p = placed.get(h);
        if (p) return `${h}\t0\t0\t0\t${p.join("\t")}\t${p.join("\t")}\t${p[0] >= 0 ? 1 : 2}`;
        // Everything starts on the left screen.
        return `${h}\t0\t0\t0\t-1800\t100\t1200\t800\t-1800\t100\t1200\t800\t2`;
      }
      const pl = script.match(/Place\((\d+), (-?\d+), (-?\d+), (\d+), (\d+)/);
      if (pl) {
        placed.set(Number(pl[1]), [Number(pl[2]), Number(pl[3]), Number(pl[4]), Number(pl[5])]);
        return "OK";
      }
      if (script.includes("Focus(")) return "True";
      return "OK";
    },
    close: () => undefined,
    warm: () => undefined,
  };
  const touched = (h: number) => scripts.some((s) => new RegExp(`(?:Place|Focus|ShowWindow\\(\\[IntPtr\\]::new)\\(${h}\\b`).test(s));
  return { ps, scripts, touched };
}

let dir: string;
beforeEach(() => {
  forgetReferent();
  dir = mkdtempSync(join(tmpdir(), "jfix-window-"));
});
afterEach(() => {
  forgetReferent();
  rmSync(dir, { recursive: true, force: true });
});
function skills(ps: PsHost, opened: string[] = []) {
  return createJarvisSkills(dir, {
    events: { submit: () => undefined },
    ps,
    vault: () => null,
    windows: {
      newTab: async () => (opened.push("tab"), { ok: true, said: "New tab open." }),
      jarvisChromePid: async () => JARVIS_CHROME_PID,
      launch: async (app) => `${app} is opening.`,
    },
  });
}

describe("J-fix: 'open a Chrome tab' → 'bring it to my front screen' (fake Windows, two screens)", () => {
  test("the Jarvis app window is recognised by its title, whatever its process is called", () => {
    expect(isJarvisOwnWindow({ process: "app", title: "Jarvis v3.6.1 (5eca7f0) · shell 0.2.1" })).toBe(true);
    expect(isJarvisOwnWindow({ process: "chrome", title: "New Tab - Google Chrome" })).toBe(false);
  });

  test("'Can you open a Chrome tab for me?' opens Jarvis Chrome's tab on the main screen, in front, and says so", async () => {
    const { ps, scripts, touched } = fakeWindows();
    const opened: string[] = [];
    const s = skills(ps, opened);
    const req = windowIntent("Can you open a Chrome tab for me?")!;
    expect(req).toEqual({ skill: "window", action: "open_tab", screen: "main" });
    // The voice client posts exactly this to /jarvis/skill: it must parse.
    expect(parseSkillRequest(req)).toEqual(req);
    const r = await s.run(req);
    expect(r).toMatchObject({ ok: true, skill: "window", said: "Opened a Chrome tab on your main screen, sir." });
    expect(opened).toEqual(["tab"]);
    // Jarvis Chrome's window (77, owned by its browser process) moved and focused; nothing else.
    const place = scripts.find((x) => x.includes("Place(77,"))!;
    expect(Number(place.match(/Place\(77, (-?\d+)/)![1])).toBeGreaterThanOrEqual(0);
    expect(scripts.some((x) => x.includes("Focus(77)"))).toBe(true);
    expect(touched(90)).toBe(false);
    expect(touched(79)).toBe(false);
    s.close();
  });

  test("'bring it to my front screen' then acts on that tab, never on the Jarvis app in front", async () => {
    const { ps, scripts, touched } = fakeWindows();
    const s = skills(ps);
    await s.run(windowIntent("Can you open a Chrome tab for me?")!);
    scripts.length = 0;
    const bring = windowIntent("Can you bring it to my front screen?")!;
    expect(bring).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });
    const r = await s.run(bring);
    expect(r.said).toBe("Google Chrome is up on your main screen, sir.");
    expect(scripts.some((x) => x.includes("Focus(77)"))).toBe(true);
    expect(touched(90)).toBe(false);
    // And "I don't see the Chrome tab on my front screen": the same tab, not his own Chrome (79, front-most).
    scripts.length = 0;
    const complaint = windowComplaintIntent("I'm saying I don't see the Chrome tab on my front screen.")!;
    expect(complaint).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    await s.run(complaint);
    expect(scripts.some((x) => x.includes("Focus(77)"))).toBe(true);
    expect(touched(79)).toBe(false);
    s.close();
  });

  test("the tab is on the left screen: 'bring it to my front screen' moves it to the main one", async () => {
    const { ps, scripts } = fakeWindows();
    rememberReferent({ app: "chrome", jarvisChrome: true });
    const s = skills(ps);
    const r = await s.run({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(r.said).toBe("Google Chrome is on your main screen now, sir.");
    expect(scripts.some((x) => x.includes("Place(77,"))).toBe(true);
    s.close();
  });

  test("no referent and only the Jarvis app in front: 'it' is asked about, never Jarvis itself", async () => {
    const { ps, touched } = fakeWindows();
    const s = skills(ps);
    const r = await s.run({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(r.said).toBe("Which window, sir? Name the app and I'll bring it over.");
    expect(touched(90)).toBe(false);
    s.close();
  });

  test("an app Jarvis opened (pc_act open_app) is 'it' too", async () => {
    const { ps, scripts } = fakeWindows();
    rememberReferent({ app: "Notepad" });
    const s = skills(ps);
    await s.run({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(scripts.some((x) => x.includes("Place(78,"))).toBe(true);
    s.close();
  });
});

describe("J-fix routing: placement complaints are the window skill's, looking is the screen tool's", () => {
  test("the transcript's complaints", () => {
    const earlier = ["Can you bring it to my front screen?", "Can you open a Chrome tab for me?"];
    expect(windowComplaintIntent("I didn't see it on my main screen.", earlier)).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });
    expect(windowComplaintIntent("I'm saying I don't see the Chrome tab on my front screen.", earlier)).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    expect(
      windowComplaintIntent(
        "No, you're not understanding. The Chrome tab that I asked you to open is not being shown on the screen I want. I did not say that I am share screening, I want the Chrome tab on my front screen.",
        earlier,
      ),
    ).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    // No screen named in this sentence: the one he named before.
    expect(windowComplaintIntent("the chrome tab is not showing on my screen", ["put chrome on my left screen"])).toMatchObject({ target: "chrome", screen: "left" });
  });
  test("never a look at the screen, and never something that isn't a window", () => {
    for (const said of ["what's on my screen", "can you look at my screen", "I can't see the error on this page on my screen, what's wrong", "I don't see any difference on my screen", "read this on my screen"])
      expect(windowComplaintIntent(said)).toBeNull();
  });
  test("'open a Chrome tab' variants", () => {
    for (const said of ["open a Chrome tab", "Can you open a Chrome tab for me?", "open a new chrome tab", "open a new tab in Chrome", "open a browser tab"])
      expect(windowPlaceIntent(said)).toMatchObject({ action: "open_tab", screen: "main" });
    expect(windowPlaceIntent("open a chrome tab on my other screen")).toMatchObject({ action: "open_tab", screen: "other" });
    // Unchanged: "open chrome" launches the app; "open a new tab" stays browser_act's.
    expect(windowPlaceIntent("open chrome")).toBeNull();
    expect(windowPlaceIntent("open a new tab")).toBeNull();
  });
});

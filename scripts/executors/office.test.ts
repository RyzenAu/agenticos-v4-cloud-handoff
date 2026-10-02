import { describe, expect, test } from "bun:test";
import { abortableSleep, createWindowsExecutors, deckBlankScript, isSplash, type WindowsDeps, type WinInfo } from "./windows";

// SYNTHETIC: Office's splash screen is not the verified window; a blank presentation says so plainly.

function rig(script: (n: number) => WinInfo[], opts: { ps?: WindowsDeps["runPs"] } = {}) {
  let polls = 0;
  const deps: WindowsDeps = {
    platform: "win32",
    roots: [],
    windows: async () => script(polls++),
    foreground: async () => null,
    startApp: async () => undefined,
    shellOpen: async () => undefined,
    focus: async () => true,
    keys: async () => undefined,
    typeText: async () => undefined,
    editorText: async () => null,
    runPs: opts.ps ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    sleep: (ms, signal) => abortableSleep(Math.min(ms, 2), signal),
    timing: { appWaitMs: 120, pollMs: 4, settleMs: 1, urlWaitMs: 30, fileWaitMs: 30 },
  };
  return createWindowsExecutors(deps);
}
const ctx = () => ({ signal: new AbortController().signal });
const splash = (handle = 5): WinInfo => ({ handle, process: "POWERPNT", cls: "MsoSplash", title: "Opening -" });
const real = (handle = 5): WinInfo => ({ handle, process: "POWERPNT", cls: "PPTFrameClass", title: "PowerPoint" });

describe("app.open does not accept an Office splash as the window", () => {
  test("isSplash: Opening -, Loading, blank and MsoSplash are splash; a real title is not", () => {
    expect(isSplash(splash())).toBe(true);
    expect(isSplash({ handle: 1, process: "WINWORD", cls: "x", title: "Loading…" })).toBe(true);
    expect(isSplash({ handle: 1, process: "EXCEL", cls: "x", title: "" })).toBe(true);
    expect(isSplash({ handle: 1, process: "EXCEL", cls: "MsoSplash", title: "Excel" })).toBe(true);
    expect(isSplash(real())).toBe(false);
    expect(isSplash({ handle: 1, process: "POWERPNT", cls: "x", title: "Presentation1 - PowerPoint" })).toBe(false);
  });
  test("a splash that turns into the real window: verified on the REAL window (its title, its handle)", async () => {
    // The splash and the real window are different windows; the splash is gone by the time the real one is listed.
    const ex = rig((n) => (n === 0 ? [] : n < 4 ? [splash(5)] : [real(6)]));
    const r = await ex["app.open"]({ name: "powerpoint" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, data: { handle: 6, title: "PowerPoint" } });
    expect(r.evidence).not.toContain("Opening");
  });
  test("only the splash ever shows: not verified, says it is still starting", async () => {
    const ex = rig((n) => (n === 0 ? [] : [splash(5)]));
    const r = await ex["app.open"]({ name: "powerpoint" }, ctx());
    expect(r).toMatchObject({ ok: true, verified: null, data: { splashOnly: true } });
    expect(r.said).toContain("still starting");
    expect(r.evidence).toBe("only a splash window appeared");
  });
  test("an app whose window is not a splash is unaffected", async () => {
    const ex = rig((n) => (n === 0 ? [] : [{ handle: 9, process: "notepad", cls: "Notepad", title: "Untitled - Notepad" }]));
    expect(await ex["app.open"]({ name: "notepad" }, ctx())).toMatchObject({ ok: true, verified: true, data: { handle: 9 } });
  });
});

describe("deck.blank says what it did", () => {
  const out = (title: string, layout = 1) => ({ code: 0, stdout: JSON.stringify({ name: "Presentation1", slides: 1, layout, path: "", title64: Buffer.from(title).toString("base64") }), stderr: "" });
  test("no title asked for: 'Started a new blank presentation. It isn't saved.' (no made-up Title)", async () => {
    const ex = rig(() => [], { ps: async () => out("") });
    const r = await ex["deck.blank"]({}, ctx());
    expect(r).toMatchObject({ ok: true, verified: true, said: "Started a new blank presentation. It isn't saved." });
    expect(r.said).not.toContain("Title");
    expect(r.evidence).toContain("title left empty");
    expect((await ex["deck.blank"]({ title: "  " }, ctx())).said).toBe("Started a new blank presentation. It isn't saved.");
  });
  test("a blank presentation that reads back with text in it is not called done", async () => {
    const ex = rig(() => [], { ps: async () => out("Title") });
    const r = await ex["deck.blank"]({}, ctx());
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(r.said).toContain("blank title slide");
  });
  test("a requested title still says the title and is verified against it", async () => {
    const ex = rig(() => [], { ps: async () => out("Q3 plan") });
    expect(await ex["deck.blank"]({ title: "Q3 plan" }, ctx())).toMatchObject({ ok: true, verified: true, said: expect.stringContaining('title slide "Q3 plan"') });
    const bad = rig(() => [], { ps: async () => out("Other") });
    expect(await bad["deck.blank"]({ title: "Q3 plan" }, ctx())).toMatchObject({ ok: false, verified: false });
  });
  test("the script leaves the title placeholder alone when there is no title; an unlicensed Office is still an honest failure", async () => {
    expect(deckBlankScript("")).toContain("if ($title.Length -gt 0)");
    const ex = rig(() => [], { ps: async () => ({ code: 1, stdout: "", stderr: "UNLICENSED" }) });
    expect(await ex["deck.blank"]({}, ctx())).toMatchObject({ ok: false, verified: false, said: expect.stringContaining("Unlicensed") });
  });
});

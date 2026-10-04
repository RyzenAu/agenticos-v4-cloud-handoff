// Screen truth in the UI (round 7): a computer is never shown as online and ready while its screen is disconnected or blank; the failing layer and the next
// action are said; Take over is not offered blind; a screen that cannot simply reconnect is told what to do instead of retried for ever.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import type { ComputerView, ScreenView } from "@/lib/computers-client";
import { screenFailing, screenSentence, stateChip, viewActions } from "@/lib/computers-client";
import { canSendInput, computerControls, computerPanel } from "./control-state";
import { INITIAL_VIEWER, MAX_RETRIES, screenPhase, viewerFlow, viewerReducer, viewerStatusText } from "./viewer-state";

const screen = (over: Partial<ScreenView> = {}): ScreenView => ({ applicable: true, ok: true, checking: false, layer: null, reason: null, next: null, nextLabel: null, at: null, lastFrameAt: 1, lastShotAt: 1, retry: { used: 0, max: 3, nextAt: null }, ...over });
const computer = (over: Partial<ComputerView> = {}): ComputerView => ({
  name: "research", id: "d1", label: "Research", kind: "cloud-computer", owner: "shared", adapter: "wsl-local", state: "online", desired: "running", desktop: true, browser: true, capabilities: ["echo"], assigned: null,
  controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, lastJob: null, resource: null, lastSeen: 1, failure: null, recoveries: 0,
  createdBy: "usman", createdAt: 1, viewer: { snapshot: true, vnc: true }, screen: screen(), usable: true, ...over,
});
const blank = screen({ ok: false, layer: "blank", reason: "The display is up but nothing is drawn on it: no browser is open, so the screen is blank.", next: "restart-display", nextLabel: "Restart display", at: 5 });
const vncDown = screen({ ok: false, layer: "vnc", reason: "The screen server (VNC) isn't running, so the live view can't connect.", next: "restart-display", nextLabel: "Restart display", at: 5 });
const hostDown = screen({ ok: false, layer: "host", reason: "The host that runs this computer isn't answering.", next: "check-host", nextLabel: "Check host", at: 5 });
const viewerDown = screen({ ok: false, layer: "viewer", reason: "The live view was refused.", next: "reconnect", nextLabel: "Reconnect", at: 5 });

describe("the state chip never says plain Online for a computer whose screen is not working", () => {
  test("online with a working screen is Online; with a blank or unavailable screen it says so", () => {
    expect(stateChip(computer())).toEqual({ word: "Online", tone: "success" });
    expect(stateChip(computer({ screen: blank }))).toEqual({ word: "Online, screen blank", tone: "warn" });
    expect(stateChip(computer({ screen: vncDown }))).toEqual({ word: "Online, screen unavailable", tone: "warn" });
    expect(stateChip(computer({ screen: viewerDown }))).toEqual({ word: "Online, screen unavailable", tone: "warn" });
    expect(stateChip(computer({ state: "busy", screen: hostDown }))).toEqual({ word: "Busy, screen unavailable", tone: "warn" });
  });
  test("no proof yet is 'checking', not ready; a payload with no screen truth (an older hub) claims nothing either way", () => {
    expect(stateChip(computer({ screen: screen({ ok: false, checking: true }) })).word).toBe("Online, checking the screen");
    expect(stateChip(computer({ screen: undefined }))).toEqual({ word: "Online", tone: "success" });
    expect(screenFailing(computer({ screen: undefined }))).toBe(false);
  });
  test("a computer that is not up has its own state word, whatever the screen says; a headless one has no screen to fail", () => {
    expect(stateChip(computer({ state: "offline", screen: hostDown })).word).toBe("Offline");
    expect(screenFailing(computer({ screen: screen({ applicable: false, ok: false }) }))).toBe(false);
  });
  test("the sentence names the reason and the next action", () => {
    expect(screenSentence(computer({ screen: blank }))).toBe(`${blank.reason} Next: Restart display.`);
    expect(screenSentence(computer({ screen: hostDown }))).toMatch(/Next: Check host\.$/);
    expect(screenSentence(computer())).toBeNull();
  });
});

describe("the panel and the controls", () => {
  test("an idle computer with a blank screen is not 'ready': it says its screen isn't, with the next action", () => {
    const p = computerPanel(computer({ screen: blank }), "usman");
    expect(p.mode).toBe("screen-down");
    expect(p.tone).toBe("warn");
    expect(p.headline).toBe("Research is online, but its screen isn't ready");
    expect(p.detail).toContain("Next: Restart display.");
    expect(p.screenIssue).toContain("blank");
  });
  test("with a working screen it is ready, and while its screen is being checked it does not claim ready", () => {
    expect(computerPanel(computer(), "usman").headline).toBe("Research is ready");
    const checking = computerPanel(computer({ screen: screen({ ok: false, checking: true }) }), "usman");
    expect(checking.headline).toBe("Research is online");
    expect(checking.detail).toMatch(/Checking its screen/);
  });
  test("a busy computer keeps saying it is working, and also names its screen problem", () => {
    const busy = computer({ state: "busy", controller: { kind: "agent", who: "scout", jobId: "j", expiresAt: 1, epoch: 1 }, assigned: { agent: "scout", jobId: "j", by: "usman", title: "Find prices" }, screen: vncDown });
    const p = computerPanel(busy, "usman");
    expect(p.mode).toBe("busy");
    expect(p.screenIssue).toContain("VNC");
  });
  test("Take over is not offered blind; Restart display is, but only when nobody holds the computer", () => {
    const c = computerControls(computer({ screen: vncDown }), "usman");
    expect(c.takeOver).toBeNull();
    expect(c.restartDisplay).toEqual({ label: "Restart display" });
    expect(viewActions(computer({ screen: vncDown }), "usman")).not.toContain("take-control");
    const busy = computer({ state: "busy", controller: { kind: "agent", who: "scout", jobId: "j", expiresAt: 1, epoch: 1 }, screen: vncDown });
    expect(computerControls(busy, "usman").takeOver).toBeNull();
    expect(computerControls(busy, "usman").restartDisplay).toBeUndefined();
    // a person who already holds it can still hand it back
    const mine = computer({ state: "busy", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 1, epoch: 2 }, screen: viewerDown });
    expect(computerControls(mine, "usman").returnToAgent).toBe(true);
  });
  test("a host that is down is not fixed by a restart: Check host, no Restart display", () => {
    expect(computerControls(computer({ screen: hostDown }), "usman").takeOver).toBeNull();
    expect(computerControls(computer({ screen: hostDown }), "usman").restartDisplay).toBeUndefined();
  });
  test("a working screen offers Take over as before", () => {
    expect(computerControls(computer(), "usman").takeOver).toEqual({ label: "Take over", ask: false });
  });
});

describe("the live screen's own status", () => {
  const dropped = { ...INITIAL_VIEWER, connected: false as boolean | null };
  test("connected but blank is said as blank, not as live", () => {
    expect(viewerStatusText({ connected: true, canControl: false, blank: true })).toMatch(/Connected, but the screen is blank/);
    expect(viewerStatusText({ connected: true, canControl: false, blank: false })).toMatch(/Live view, view-only/);
    expect(screenPhase({ connected: true, canControl: false, blank: true }, false)).toEqual({ phase: "offline", label: "Screen connected, but blank" });
    expect(screenPhase({ connected: true, canControl: true }, false).phase).toBe("live");
  });
  test("a dropped screen says which layer failed and what to do, instead of a bare 'disconnected'", () => {
    const diagnosis = { layer: "vnc", reason: vncDown.reason, next: "restart-display" as const, nextLabel: "Restart display" };
    expect(viewerStatusText({ connected: false, canControl: null, diagnosis })).toBe(`The screen disconnected. ${vncDown.reason} Next: Restart display.`);
    expect(viewerStatusText({ connected: false, canControl: null })).toMatch(/disconnected\. It reconnects when you reopen/);
    expect(viewerStatusText({ connected: false, canControl: null, timedOut: true, diagnosis })).toMatch(/didn't connect within 15 seconds\. .*Next: Restart display\./);
  });
  test("the diagnosis travels with the viewer's report and is cleared on a retry", () => {
    const diagnosis = { layer: "host", reason: "x", next: "check-host" as const, nextLabel: "Check host" };
    const s = viewerReducer(INITIAL_VIEWER, { type: "message", connected: false, canControl: null, diagnosis });
    expect(s.diagnosis).toEqual(diagnosis);
    expect(viewerReducer(s, { type: "manual-retry" }).diagnosis).toBeNull();
    expect(viewerReducer(INITIAL_VIEWER, { type: "message", connected: true, canControl: false, blank: true }).blank).toBe(true);
  });
  test("reconnecting is only tried for what a reconnect can fix; a dead display or host is not retried in a loop", () => {
    expect(viewerFlow({ ...dropped, tries: 0 }, true)).toMatchObject({ retrying: true, gaveUp: false });
    expect(viewerFlow({ ...dropped, tries: 0, diagnosis: { layer: "viewer", reason: "r", next: "reconnect", nextLabel: "Reconnect" } }, true).retrying).toBe(true);
    for (const next of ["restart-display", "check-host"] as const) expect(viewerFlow({ ...dropped, tries: 0, diagnosis: { layer: "x", reason: "r", next, nextLabel: "n" } }, true)).toMatchObject({ retrying: false, gaveUp: true });
    // and a reconnect that keeps failing is bounded
    expect(viewerFlow({ ...dropped, tries: MAX_RETRIES }, true)).toMatchObject({ retrying: false, gaveUp: true });
  });
  test("a blank report is not a good connection: it does not reset the retry count", () => {
    const s = viewerReducer({ ...INITIAL_VIEWER, tries: 3 }, { type: "message", connected: true, canControl: false, blank: true });
    expect(s.tries).toBe(3);
    expect(viewerReducer({ ...INITIAL_VIEWER, tries: 3 }, { type: "message", connected: true, canControl: false, blank: false }).tries).toBe(0);
  });
});

describe("the same person in a second window", () => {
  const mineElsewhere = () => computer({ state: "busy", heldByYouElsewhere: true, heldByThisSession: false, controller: { kind: "person", who: "usman", jobId: null, expiresAt: 1, epoch: 2 } });
  test("the panel says the controls are in another window, never 'You have the controls'", () => {
    const p = computerPanel(mineElsewhere(), "usman");
    expect(p.mode).toBe("held-elsewhere");
    expect(p.headline).toBe("You have the controls in another window");
    expect(p.detail).toMatch(/view-only until you take them here/);
    expect(computerPanel({ ...mineElsewhere(), heldByYouElsewhere: false, heldByThisSession: true }, "usman").mode).toBe("held-by-you");
  });
  test("Take them here is offered, Return to agent is not (the hub would refuse it from this window), and input is not claimed", () => {
    const c = computerControls(mineElsewhere(), "usman");
    expect(c.takeHere).toEqual({ label: "Take them here" });
    expect(c.returnToAgent).toBe(false);
    expect(viewActions(mineElsewhere(), "usman")).toContain("take-here");
    expect(viewActions(mineElsewhere(), "usman")).not.toContain("return");
    expect(canSendInput(mineElsewhere(), "usman")).toBe(false);
    // this window holds them: the old behaviour
    const here = computerControls({ ...mineElsewhere(), heldByYouElsewhere: false, heldByThisSession: true }, "usman");
    expect(here.returnToAgent).toBe(true);
    expect(here.takeHere).toBeUndefined();
  });
});

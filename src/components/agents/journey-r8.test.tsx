// Round 8 (track C): what the connected journey on a REAL local WSL computer showed (docs/programme-20261001/R8-C-AGENTS.md), each pinned here.
//   1. a person holding the controls read "Paused while you have the controls" twice in the conversation card (the title, then the hub's sentence);
//   2. the card's top line repeated the pause as "Paused: usman is taking control ..." (the reader, in the third person) above that notice;
//   3. the side panel added the same take-over notice a third time under its own "You have the controls" headline;
//   4. the panel and the header named the paused job by the bot's id ("research's job is paused");
//   5. the header said plain "Ready" while the panel beside it said the computer's screen was not working;
//   6. the viewer said "It reconnects when you reopen the preview" while it was in fact reconnecting by itself (and later offered a Reconnect button).
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerView, ScreenView } from "@/lib/computers-client";
import { applyEntries, emptyChat, recoveryOfBlocker, toBlocks, withoutTitle, type Run } from "./chat/chat-state";
import { activityOf } from "./chat/bot-chat";
import { RunCard, defaultLinks } from "./chat/entries";
import { createFakeBotHub, JOB_A } from "./chat/__fixtures__/fake-bot-hub";
import { agentWords, computerPanel } from "./computer/control-state";
import { viewerStatusText } from "./computer/viewer-state";
import { PanelContext } from "./workspace/layout/conversation";
import { agentName, deriveBotStatus, shortStatus } from "./workspace/status";
import type { Bot } from "./workspace/bots";

const flat = (html: string) => html.replace(/<!-- -->/g, "");
const J = JOB_A;
const HUB_HELD_YOU = "Paused while you have the controls. Return them when you're done.";
const PAUSE_LINE = "Paused: you took the controls of the computer. The job waits until you return them.";

/** The entries the hub really wrote for the r8 takeover (journey-c-computer.ts, job bdb42029): started, a step, then the pause with its blocker. */
const pausedRun = (held: "you" | "other", recovery = held === "you" ? HUB_HELD_YOU : "Mehroz has the controls. The job carries on when they hand them back.") => {
  const hub = createFakeBotHub();
  hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: audit the demo clinic fixture (job ${J.slice(0, 8)}).` });
  hub.append({ key: `${J}:step:1`, jobId: J, state: "progress", text: "Website audit, step 1 of 5 (open the site): done." });
  hub.append({ key: `${J}:step:2`, jobId: J, state: "progress", text: PAUSE_LINE, blocker: { kind: "needs-takeover", held, recovery } });
  return toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run")!;
};
const cardHtml = (r: Run) => flat(renderToStaticMarkup(<RunCard run={r} links={{ ...defaultLinks("/computers"), computer: () => "/agents/workspace/research?tab=computer" }} onStop={() => {}} />));

describe("1-2. the conversation card says the pause once, to the person, in the second person", () => {
  test("withoutTitle keeps only what a body adds to its title", () => {
    expect(withoutTitle("Paused while you have the controls", HUB_HELD_YOU)).toBe("Return them when you're done.");
    expect(withoutTitle("Paused while you have the controls", "Paused while you have the controls.")).toBe("");
    expect(withoutTitle("Someone else has the controls", "Mehroz has the controls. The job carries on.")).toBe("Mehroz has the controls. The job carries on.");
  });

  test("the holder's recovery: the title, then a body that does not repeat it (also when the hub sends only the title)", () => {
    const r = recoveryOfBlocker({ kind: "needs-takeover", held: "you", recovery: HUB_HELD_YOU });
    expect(r).toMatchObject({ title: "Paused while you have the controls", body: "Return them when you're done.", kind: "take-over", actions: ["return-controls"] });
    const bare = recoveryOfBlocker({ kind: "needs-takeover", held: "you", recovery: "Paused while you have the controls." });
    expect(bare.body).toBe("Return the controls when you're done and it carries on from the same step.");
    expect(recoveryOfBlocker({ kind: "needs-takeover", held: "you" }).body).not.toMatch(/^Paused while you have the controls/);
    // Other blockers are untouched.
    expect(recoveryOfBlocker({ kind: "needs-approval", recovery: "Answer it from the job." })).toMatchObject({ title: "Needs your approval", body: "Answer it from the job.", kind: "approval" });
  });

  test("the card: 'Paused while you have the controls' appears once; the hub's third-person pause line is not repeated above the notice", () => {
    const h = cardHtml(pausedRun("you"));
    expect(h.match(/Paused while you have the controls/g)).toHaveLength(1);
    expect(h).not.toContain("took the controls of the computer");
    expect(h).toContain("Return the controls");
    expect(h).toContain("Needs you");
  });

  test("the other founder's card: the notice names who holds it; the pause line is not said twice either", () => {
    const h = cardHtml(pausedRun("other"));
    expect(h).toContain("Someone else has the controls");
    expect(h).toContain("Mehroz has the controls. The job carries on when they hand them back.");
    expect(h).not.toContain("took the controls of the computer");
  });

  test("a running card still shows its newest step (only the take-over pause line is left out)", () => {
    const hub = createFakeBotHub();
    hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: x (job ${J.slice(0, 8)}).` });
    hub.append({ key: `${J}:step:1`, jobId: J, state: "progress", text: "Website audit, step 2 of 5 (desktop): done." });
    const r = toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run")!;
    expect(cardHtml(r)).toContain("Website audit, step 2 of 5 (desktop): done.");
  });
});

describe("3. the side panel does not add the take-over notice under its own 'You have the controls'", () => {
  const activity = activityOf(toBlocks(applyEntries(emptyChat(), (() => { const hub = createFakeBotHub(); hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: audit (job ${J.slice(0, 8)}).` }); hub.append({ key: `${J}:step:1`, jobId: J, state: "progress", text: PAUSE_LINE, blocker: { kind: "needs-takeover", held: "you", recovery: HUB_HELD_YOU } }); return hub.entries; })()).state));
  test("held by a person: no take-over notice; nobody holding it (stale): the notice stays", () => {
    expect(activity.recovery?.kind).toBe("take-over");
    expect(flat(renderToStaticMarkup(<PanelContext activity={activity} hideTask heldByPerson />))).toBe("");
    expect(flat(renderToStaticMarkup(<PanelContext activity={activity} hideTask heldByPerson={false} />))).toContain("Paused while you have the controls");
  });
  test("any other blocker is still shown while a person holds the computer", () => {
    const approval = { task: "publish", state: "blocked" as const, recovery: recoveryOfBlocker({ kind: "needs-approval" }) };
    expect(flat(renderToStaticMarkup(<PanelContext activity={approval} heldByPerson />))).toContain("Needs your approval");
  });
});

const screen = (over: Partial<ScreenView> = {}): ScreenView => ({ applicable: true, ok: true, checking: false, layer: null, reason: null, next: null, nextLabel: null, at: null, lastFrameAt: 1, lastShotAt: 1, retry: { used: 0, max: 3, nextAt: null }, ...over });
const computer = (over: Partial<ComputerView> = {}): ComputerView => ({
  name: "research", id: "d1", label: "Research", kind: "cloud-computer", owner: "shared", adapter: "wsl-local", state: "online", desired: "running", desktop: true, browser: true, capabilities: ["echo"], assigned: null,
  controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, lastJob: null, resource: null, lastSeen: 1, failure: null, recoveries: 0,
  createdBy: "usman", createdAt: 1, viewer: { snapshot: true, vnc: true }, screen: screen(), usable: true, ...over,
});
const held = computer({ state: "busy", controller: { kind: "person", who: "usman", jobId: null, expiresAt: 9, epoch: 2 }, paused: { jobId: J, agent: "research" } });
const bot = (over: Partial<Bot> = {}): Bot => ({ id: "research", name: "Research", purpose: "p", computer: "research", coding: { enabled: false, accountSlot: null, model: null }, ...over });

describe("4. the paused job is named by its bot, not its id", () => {
  test("the panel: the bot's name when the caller knows it, else the id capitalised", () => {
    expect(computerPanel(held, "usman", { agentName: (id) => (id === "research" ? "Research" : agentWords(id)) }).detail).toBe("Research's job is paused. Return the controls and it carries on from where it stopped.");
    expect(computerPanel(held, "usman").detail).toMatch(/^Research's job is paused/);
    expect(agentWords("builder")).toBe("Builder");
  });
  test("the header: this bot's name, or the bot it shares the computer with", () => {
    expect(deriveBotStatus({ bot: bot(), computer: held, me: "usman" }).text).toBe("Needs you: Research's job is paused while you hold the controls. Return them");
    const shared = bot({ id: "scout", name: "Scout", sharesComputerWith: [{ id: "research", name: "Research", archived: false } as never] });
    expect(agentName(shared, "research")).toBe("Research");
    expect(agentName(bot(), "lark")).toBe("Lark");
  });
});

describe("5. the header does not say plain Ready while its computer's screen is not working", () => {
  const vncDown = screen({ ok: false, layer: "vnc", reason: "The screen server (VNC) isn't running, so the live view can't connect.", next: "restart-display", nextLabel: "Restart display", at: 5 });
  test("screen down: still ready (work without a screen runs) but it says what is wrong and where to fix it; the rail says it in a few words", () => {
    const s = deriveBotStatus({ bot: bot(), computer: computer({ screen: vncDown, usable: false }), me: "usman" });
    expect(s).toEqual({ kind: "ready", tone: "warn", text: "Ready, but its computer's screen isn't working. Show computer to fix it" });
    expect(shortStatus(s, { lifecycle: "active" } as never)).toBe("Ready, screen not working");
  });
  test("a working screen, a screen still being checked, and a stopped computer keep their own words", () => {
    expect(deriveBotStatus({ bot: bot(), computer: computer(), me: "usman" }).text).toBe("Ready");
    expect(deriveBotStatus({ bot: bot(), computer: computer({ screen: screen({ ok: false, checking: true }) }), me: "usman" }).text).toBe("Ready");
    expect(deriveBotStatus({ bot: bot(), computer: computer({ state: "offline", screen: vncDown }), me: "usman" }).kind).toBe("offline");
    expect(shortStatus({ kind: "ready", tone: "warn", text: "Ready. The last job did not finish" }, { lifecycle: "active" } as never)).toBe("Ready, last job unfinished");
  });
});

describe("6. the viewer says what it is doing after a drop", () => {
  test("retrying by itself, then given up with a Reconnect button; a diagnosed layer keeps its own sentence; older callers keep the old one", () => {
    expect(viewerStatusText({ connected: false, canControl: null, retrying: true })).toBe("The screen disconnected. Reconnecting by itself…");
    expect(viewerStatusText({ connected: false, canControl: null, retrying: false })).toBe("The screen disconnected and didn't come back. Press Reconnect to try again.");
    const diagnosis = { layer: "vnc", reason: "The screen server (VNC) isn't running, so the live view can't connect.", next: "restart-display" as const, nextLabel: "Restart display" };
    expect(viewerStatusText({ connected: false, canControl: null, retrying: false, diagnosis })).toBe(`The screen disconnected. ${diagnosis.reason} Next: Restart display.`);
    expect(viewerStatusText({ connected: false, canControl: null })).toMatch(/reconnects when you reopen/);
    expect(viewerStatusText({ connected: true, canControl: false, retrying: false })).toMatch(/Live view, view-only/);
  });
});

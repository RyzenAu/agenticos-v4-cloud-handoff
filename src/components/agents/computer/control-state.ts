// The Computer tab's honest state and which controls it offers. Pure; the hub's lease is the only authority.
// Ideas adapted from OpenMausBot (Apache-2.0): a typed "busy" state instead of a fault, and a failed hand-back that stays "held". No code copied.
import { viewActions, screenFailing, screenSentence, STATE_WORD, type ComputerAction, type ComputerView } from "@/lib/computers-client";
import type { Tone } from "@/components/ds";
import type { ScreenState } from "./viewer-state";

export type ComputerMode =
  | "none" // no shared computer for this bot
  | "offline"
  | "asleep"
  | "failed"
  | "starting"
  | "idle" // online, nobody holds it
  | "screen-down" // online, nobody holds it, but its screen is disconnected or blank: not "ready"
  | "busy" // the agent is working on it
  | "pausing" // someone asked for the controls; the agent pauses at its next safe step
  | "held-by-you"
  | "held-elsewhere" // the same person holds them in another window: this one is view-only
  | "held-by-other";

export type ComputerPanel = {
  mode: ComputerMode;
  tone: Tone;
  headline: string;
  detail: string | null;
  /** The screen is being reconnected (connecting, or dropped and trying again). */
  reconnecting: boolean;
  /** A hand-back didn't go through: the controls are still yours, said once, never shown as returned. */
  handBackFailed: boolean;
  /** The screen's failing layer and next action in one sentence, when the computer is up but its screen is not (whatever else is going on). Null otherwise. */
  screenIssue: string | null;
};

/** An agent's id as a name a person reads ("research" -> "Research"), unless the caller knows the bot's real name. */
export const agentWords = (id: string) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : "The agent");

export function computerPanel(c: ComputerView | null, me: string | null, opts: { /** The live viewer's last report; leave out when no live viewer is shown. */ screen?: ScreenState; handBackFailed?: boolean; nameOf?: (id: string) => string; /** The paused job's agent as a name (its bot's name); default: the id, capitalised. Round 8: the panel said "research's job is paused". */ agentName?: (id: string) => string } = {}): ComputerPanel {
  const nameOf = opts.nameOf ?? ((id: string) => id);
  const agentName = opts.agentName ?? agentWords;
  const mk = (mode: ComputerMode, tone: Tone, headline: string, detail: string | null = null): ComputerPanel => ({
    mode,
    tone,
    headline,
    detail,
    reconnecting: false,
    handBackFailed: false,
    screenIssue: null,
  });
  if (!c) return mk("none", "neutral", "No computer yet", "This bot has no shared computer. Assign one in Setup, or add one in Computers.");
  const name = c.label || c.name;
  const up = c.state === "online" || c.state === "busy";
  let p: ComputerPanel;
  if (c.state === "failed" || c.failure) p = mk("failed", "danger", `${name} failed`, c.failure ? `${c.failure.reason}. Reconnect to bring it back; nothing is replayed.` : "Reconnect to bring it back; nothing is replayed.");
  else if (c.state === "starting") p = mk("starting", "info", `${name} is starting`, "Its screen appears when it is online.");
  else if (c.state === "offline") p = mk("offline", "neutral", `${name} is stopped`, "Start it to see its screen. Saved results stay in Tasks & Files.");
  else if (c.state === "asleep") p = mk("asleep", "neutral", `${name} is asleep`, "Start it to wake it. Its disk was kept.");
  else if (c.takeoverPending) {
    const who = c.takeoverPending.by === me ? "You are" : `${nameOf(c.takeoverPending.by)} is`;
    p = mk("pausing", "info", `${who} taking over`, "The agent pauses at its next safe step, then the controls move. Nothing is cut off mid-step.");
  } else if (c.controller.kind === "person") {
    const mine = c.controller.who === me;
    p = mine && c.heldByYouElsewhere
      ? mk("held-elsewhere", "info", "You have the controls in another window", "This window is view-only until you take them here; the other window stops at once. Nothing is taken without your say.")
      : mine
      ? mk("held-by-you", "accent", "You have the controls", c.paused ? `${agentName(c.paused.agent)}'s job is paused. Return the controls and it carries on from where it stopped.` : "Your keyboard and mouse reach the computer. Return the controls when you are done.")
      : mk("held-by-other", "info", `${nameOf(c.controller.who ?? "someone")} has the controls`, "You can watch. Only the person holding the controls can act.");
  } else if (c.controller.kind === "agent" && c.assigned) p = mk("busy", "info", `Working: ${c.assigned.title || c.assigned.jobId}`, "You can watch. Take over asks the agent to pause at its next safe step.");
  else if (c.controller.kind === "agent") p = mk("busy", "info", "The agent is using it", "You can watch. Take over asks the agent to pause at its next safe step.");
  else if (screenFailing(c)) p = mk("screen-down", "warn", `${name} is online, but its screen isn't ready`, screenSentence(c));
  else if (c.screen?.applicable && c.screen.checking) p = mk("idle", "info", `${name} is online`, "Checking its screen before it is called ready.");
  else p = mk("idle", "success", `${name} is ready`, "Nobody holds the controls. Take over to use it, or ask the bot in Chat.");
  // A failed hand-back only means something while the controls are still yours.
  const heldByYou = p.mode === "held-by-you";
  return {
    ...p,
    handBackFailed: !!opts.handBackFailed && heldByYou,
    screenIssue: up ? screenSentence(c) : null,
    detail: opts.handBackFailed && heldByYou ? "The hand-back didn't go through. You hold the controls until the hub confirms the return. Try Return to agent again." : p.detail,
    // Only a live viewer reports a screen state (a snapshot never does), so "reconnecting" needs one.
    reconnecting: up && !!opts.screen && opts.screen.connected !== true,
  };
}

export type ComputerControls = {
  /** Show the live screen (needs a screen and a computer that is up). */
  watch: boolean;
  takeOver: { label: "Take over"; ask: boolean } | null;
  returnToAgent: boolean;
  stop: boolean;
  start: { label: "Start" | "Reconnect" } | null;
  /** The same person holds the controls in another window: move them here (an explicit, recorded takeover by the same person). */
  takeHere?: { label: "Take them here" };
  /** The screen's own layers are down and nobody holds the computer: restart the display. */
  restartDisplay?: { label: "Restart display" };
};

/** Which buttons the state allows this person. A thin, named layer over viewActions: the lease decides. */
export function computerControls(c: ComputerView | null, me: string | null): ComputerControls {
  if (!c) return { watch: false, takeOver: null, returnToAgent: false, stop: false, start: null };
  const a = viewActions(c, me);
  const has = (x: ComputerAction) => a.includes(x);
  const screen = !!c.viewer && (c.viewer.vnc || c.viewer.snapshot);
  return {
    watch: has("preview") && screen,
    takeOver: has("take-control") ? { label: "Take over", ask: false } : has("request-control") ? { label: "Take over", ask: true } : null,
    returnToAgent: has("return"),
    stop: has("stop"),
    start: has("start") ? { label: c.state === "failed" ? "Reconnect" : "Start" } : null,
    ...(has("take-here") ? { takeHere: { label: "Take them here" as const } } : {}),
    ...(has("restart-display") ? { restartDisplay: { label: "Restart display" as const } } : {}),
  };
}

/** Pure: only the lease holder sends input. The screen is view-only until this person holds the controls. */
export function canSendInput(c: Pick<ComputerView, "controller" | "state"> | null, me: string | null): boolean {
  return !!c && !!me && (c.state === "online" || c.state === "busy") && c.controller.kind === "person" && c.controller.who === me && !(c as { heldByYouElsewhere?: boolean }).heldByYouElsewhere;
}

export const stateWord = (c: Pick<ComputerView, "state">) => STATE_WORD[c.state];

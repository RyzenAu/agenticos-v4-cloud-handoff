import type { ProbeResult } from "./types";

/**
 * Screen truth for a bot computer (round 7).
 *
 * A computer's process being alive (its companion heartbeats) says nothing about whether a person can SEE it. The screen has its own layers, and
 * a computer is only called "screen ready" with evidence from the last of them: a recent real frame through the viewer, or a screenshot that
 * really came back. This module is pure: it takes what the hub measured and says which layer failed, why, and the next action.
 *
 *   host      the machine that runs the computers (WSL distro, SSH host) doesn't answer
 *   computer  the computer's own process isn't running
 *   display   the X display (Xvfb) isn't running
 *   vnc       the VNC server on that display isn't running
 *   blank     everything runs but nothing is drawn: the browser isn't open (a black desktop), or the viewer saw an all-black frame
 *   viewer    the viewer transport failed: the WebSocket upgrade was refused, the RFB handshake failed, the tunnel dropped
 *   frame     the transport connected but no frame arrived (or no screenshot came back)
 */

export type ScreenLayer = "host" | "computer" | "display" | "vnc" | "blank" | "viewer" | "frame";
export type ScreenNext = "check-host" | "restart-display" | "reconnect";

export const NEXT_LABEL: Record<ScreenNext, string> = { "check-host": "Check host", "restart-display": "Restart display", reconnect: "Reconnect" };

/** What the hub reports about a computer's screen. */
export type ScreenView = {
  /** A computer with neither a desktop nor a browser has no screen to be ready; nothing below applies. */
  applicable: boolean;
  /** True only with every layer up AND a recent real frame or a screenshot that came back. Never from a process merely existing. */
  ok: boolean;
  /** No evidence yet (just started, or the last evidence is old): neither ready nor failed. */
  checking: boolean;
  layer: ScreenLayer | null;
  reason: string | null;
  next: ScreenNext | null;
  nextLabel: string | null;
  /** When the failing layer was last seen failing. */
  at: number | null;
  lastFrameAt: number | null;
  lastShotAt: number | null;
  /** Automatic restarts of the display layers (only ever on a computer nobody holds), and when the next is due. */
  retry: { used: number; max: number; nextAt: number | null };
};

export type ScreenFault = { layer: "viewer" | "frame" | "blank"; reason: string; at: number };
export type ScreenEvidence = { frameAt?: number; shotAt?: number; fault?: ScreenFault };

/** A frame or screenshot older than this no longer proves the screen is up. */
export const SCREEN_FRESH_MS = 90_000;
/** A probe older than this is not evidence about the layers (the monitor probes every 10 s). */
export const PROBE_STALE_MS = 60_000;
/** A viewer failure older than this no longer counts (the next frame or screenshot decides). */
export const FAULT_TTL_MS = 120_000;
/** A blank report lapses faster: the viewer re-reports every few seconds while it is open and still sees black, so one that stops coming is stale. */
export const BLANK_TTL_MS = 30_000;
export const MAX_SCREEN_RETRIES = 3;
/** The first automatic restart waits this long after the layer was first seen down: longer than the companion's own browser watchdog and any blip. */
export const SCREEN_FIRST_DELAY_MS = 20_000;
/** However the tries reset, a computer's display layers are restarted at most this many times in 24 hours. */
export const MAX_SCREEN_RESTARTS_PER_DAY = 6;
/** The try count resets only after the screen has been ready this long (a layer that keeps dying does not get a fresh allowance every minute). */
export const SCREEN_OK_RESET_MS = 600_000;
/** Pause before automatic restart n (0-based). Grows, so a screen that keeps dying is not restarted in a loop. */
export const SCREEN_RETRY_DELAYS_MS = [20_000, 60_000, 180_000];

export type ScreenInput = {
  desktop: boolean;
  /** A browser is installed: a snapshot can be taken even with no desktop. */
  browser: boolean;
  /** Whether the adapter can take a snapshot at all. */
  snapshot: boolean;
  probe: ProbeResult | null;
  evidence: ScreenEvidence;
  now: number;
  retry?: { used: number; nextAt: number | null };
};

const NO_RETRY = { used: 0, nextAt: null };

export function diagnoseScreen(input: ScreenInput): ScreenView {
  const { probe, evidence, now } = input;
  const retry = { used: input.retry?.used ?? NO_RETRY.used, max: MAX_SCREEN_RETRIES, nextAt: input.retry?.nextAt ?? null };
  const base: ScreenView = { applicable: true, ok: false, checking: false, layer: null, reason: null, next: null, nextLabel: null, at: null, lastFrameAt: evidence.frameAt ?? null, lastShotAt: evidence.shotAt ?? null, retry };
  if (!input.desktop && !input.browser) return { ...base, applicable: false, reason: "This computer has no screen: it has no desktop or browser installed." };
  const fail = (layer: ScreenLayer, reason: string, next: ScreenNext, at: number): ScreenView => ({ ...base, layer, reason, next, nextLabel: NEXT_LABEL[next], at });

  const fresh = Math.max(evidence.frameAt ?? 0, evidence.shotAt ?? 0);
  const haveFresh = fresh > 0 && now - fresh <= SCREEN_FRESH_MS;
  const probeFresh = !!probe && now - probe.at <= PROBE_STALE_MS;

  // The layers underneath, from the host's own probe. A stale probe is no evidence either way.
  if (probe && probeFresh) {
    if (!probe.hostUp) return fail("host", `The host that runs this computer isn't answering${probe.error ? ` (${probe.error})` : ""}.`, "check-host", probe.at);
    if (!probe.companionAlive) return fail("computer", "The computer's own process isn't running.", "restart-display", probe.at);
    if (input.desktop && probe.displayAlive === false) return fail("display", "The computer's display isn't running, so there is no screen.", "restart-display", probe.at);
    if (input.desktop && probe.vncAlive === false) return fail("vnc", "The screen server (VNC) isn't running, so the live view can't connect.", "restart-display", probe.at);
    if (input.desktop && probe.browserAlive === false) return fail("blank", "The display is up but nothing is drawn on it: no browser is open, so the screen is blank.", "restart-display", probe.at);
  }

  // The viewer's own failures. A failed screenshot ("frame") is cleared by any later proof; a failure of the viewer itself (refused, handshake, blank) only by a later
  // real frame through the viewer, because a screenshot is taken of the browser and says nothing about what the viewer is shown. They lapse after FAULT_TTL_MS, when the
  // monitor's own screenshot has re-proved the layers.
  // A blank report is NOT cleared by a viewer's frame (a black screen is a frame): only by a later report that the picture is drawn (the service drops it), or by lapsing.
  const fault = evidence.fault;
  if (fault && now - fault.at <= (fault.layer === "blank" ? BLANK_TTL_MS : FAULT_TTL_MS) && (fault.layer === "blank" || fault.at > (fault.layer === "frame" ? fresh : (evidence.frameAt ?? 0)))) return fail(fault.layer, fault.reason, fault.layer === "blank" ? "restart-display" : "reconnect", fault.at);

  if (haveFresh) return { ...base, ok: true };
  if (!probeFresh) return { ...base, checking: true, reason: "Checking the screen." };
  // Every layer is up and nothing has failed, but no frame or screenshot has come back lately: not ready until one does.
  return { ...base, checking: true, reason: "Waiting for a first frame or screenshot." };
}

/** Pure: should the hub restart the display layers now? Only for a failure a restart can fix, only while nobody holds the computer, bounded and spaced. */
export function screenRetryDue(input: {
  layer: ScreenLayer | null; held: boolean; recovering: boolean; running: boolean; used: number; nextAt: number | null; now: number;
  /** This layer was seen working since the hub started: it DIED, so a restart can bring it back. A layer that never worked is reported, not restarted in a loop. */
  wasUp: boolean;
  /** When this layer was first seen down (the first automatic try waits SCREEN_FIRST_DELAY_MS from here). */
  failingSince: number | null;
  /** Display-layer restarts in the last 24 hours. */
  restartsToday: number;
}): boolean {
  // Only the layers a restart of the display processes can bring back. A blank desktop is the browser's (the companion reopens it); a viewer fault is the person's to reconnect.
  if (!input.layer || !["display", "vnc"].includes(input.layer) || !input.wasUp) return false;
  if (input.failingSince === null || input.now - input.failingSince < SCREEN_FIRST_DELAY_MS) return false;
  if (input.restartsToday >= MAX_SCREEN_RESTARTS_PER_DAY) return false;
  if (input.held || input.recovering || !input.running) return false;
  if (input.used >= MAX_SCREEN_RETRIES) return false;
  return input.nextAt === null || input.now >= input.nextAt;
}

export const screenRetryDelayMs = (used: number) => SCREEN_RETRY_DELAYS_MS[Math.min(used, SCREEN_RETRY_DELAYS_MS.length - 1)];

/** The words for a failure, for a surface that shows the layer, the time and the next action on one line. */
export function screenSentence(s: Pick<ScreenView, "reason" | "nextLabel" | "layer">): string {
  if (!s.reason) return "";
  return s.nextLabel ? `${s.reason} Next: ${s.nextLabel}.` : s.reason;
}

// The live screen's state, as pure functions: what the embedded viewer page reported, how long we wait for it, when we try again.
// (Moved from computers-page.tsx; the strings and phases are unchanged. The connect deadline is new and opt-in.)
// Adapted idea from OpenMausBot's viewer (Apache-2.0): a 15 s connect deadline and a plain "give up, offer Retry" state. No code copied.
import type { ConnectionPhase } from "@/components/ds";

/** The hub's answer for a screen that disconnected or drew blank: which layer failed, why, and the next action (scripts/computers/screen.ts). */
export type ViewerDiagnosis = { layer: string | null; reason: string | null; next: "check-host" | "restart-display" | "reconnect" | null; nextLabel: string | null };

/** What the embedded viewer page reports to its parent (scripts/computers/novnc.ts). */
export type ViewerMessage = { source: "mu-computer-viewer"; name: string; connected?: boolean; canControl?: boolean; /** A real picture was drawn. */ frame?: boolean; /** That picture is all black: nothing is open on the display. */ blank?: boolean | null; diagnosis?: ViewerDiagnosis | null };

/** What the embedded viewer last reported: unknown until it says. `blank` and `diagnosis` are there once it has drawn a frame or dropped. */
export type ScreenState = { connected: boolean | null; canControl: boolean | null; blank?: boolean | null; diagnosis?: ViewerDiagnosis | null };

/** The viewer has this long to connect before the screen is called "didn't connect" and tried again. */
export const CONNECT_DEADLINE_MS = 15_000;
export const MAX_RETRIES = 5;

/** Pure: the plain sentence for the live viewer's state. View-only unless this person holds the lease. */
export function viewerStatusText(m: { connected: boolean | null; canControl: boolean | null; timedOut?: boolean; blank?: boolean | null; diagnosis?: ViewerDiagnosis | null; /** The live viewer is retrying by itself (true) or has given up and shows Reconnect (false). Unknown (left out): the older sentence. */ retrying?: boolean }): string {
  const why = m.diagnosis?.reason ? ` ${m.diagnosis.reason}${m.diagnosis.nextLabel ? ` Next: ${m.diagnosis.nextLabel}.` : ""}` : "";
  if (m.timedOut && m.connected === false) return `The screen didn't connect within 15 seconds.${why}`;
  if (m.connected === null) return "Connecting to the screen…";
  // Round 8: the live viewer tries again by itself, so "it reconnects when you reopen the preview" was wrong while it was reconnecting on its own,
  // and wrong again once it gave up and offered a Reconnect button.
  if (!m.connected && !why && m.retrying === true) return "The screen disconnected. Reconnecting by itself…";
  if (!m.connected && !why && m.retrying === false) return "The screen disconnected and didn't come back. Press Reconnect to try again.";
  if (!m.connected) return why ? `The screen disconnected.${why}` : "The screen disconnected. It reconnects when you reopen the preview.";
  // Connected is not working: a picture that is all black is a blank screen, said as one.
  if (m.blank === true) return `Connected, but the screen is blank: nothing is open on this computer.${why}`;
  return m.canControl ? "Live view. You hold the controls: your keyboard and mouse reach the computer." : "Live view, view-only. Take control to use the keyboard and mouse.";
}

/** Pure: accept a message only from the viewer frame of this computer on this origin. */
export function parseViewerMessage(data: unknown, name: string): ViewerMessage | null {
  const m = data as Partial<ViewerMessage> | null;
  return m && typeof m === "object" && m.source === "mu-computer-viewer" && m.name === name ? (m as ViewerMessage) : null;
}

/** Pure: the connection chip for the screen (connected, connecting, trying again, or given up). */
export function screenPhase(s: ScreenState, retrying: boolean): { phase: ConnectionPhase; label: string } {
  if (s.connected === true && s.blank === true) return { phase: "offline", label: "Screen connected, but blank" };
  if (s.connected === true) return { phase: "live", label: s.canControl ? "Screen live, you can act" : "Screen live, view-only" };
  if (s.connected === null || retrying) return { phase: "reconnecting", label: s.connected === null ? "Connecting to the screen…" : "Reconnecting to the screen…" };
  return { phase: "offline", label: "Screen disconnected" };
}

// ------------------------------------------------------------------ the viewer's reducer

export type ViewerState = ScreenState & {
  /** The frame never reported within the deadline (so `connected` is false, not merely unknown). */
  timedOut: boolean;
  /** Retries since the last good connection. */
  tries: number;
  /** The frame is remounted only when this changes. */
  reload: number;
};
export type ViewerEvent =
  | { type: "message"; connected: boolean | null; canControl: boolean | null; blank?: boolean | null; diagnosis?: ViewerDiagnosis | null }
  | { type: "deadline" }
  | { type: "auto-retry" }
  | { type: "manual-retry" };

export const INITIAL_VIEWER: ViewerState = { connected: null, canControl: null, blank: null, diagnosis: null, timedOut: false, tries: 0, reload: 0 };

export function viewerReducer(s: ViewerState, e: ViewerEvent): ViewerState {
  switch (e.type) {
    case "message":
      return { ...s, connected: e.connected, canControl: e.canControl, blank: e.blank ?? null, diagnosis: e.diagnosis ?? null, timedOut: false, tries: e.connected === true && e.blank !== true ? 0 : s.tries };
    case "deadline":
      // Only a frame that has said nothing at all times out; one that connected or dropped already has an answer.
      return s.connected === null ? { ...s, connected: false, timedOut: true } : s;
    case "auto-retry":
      return { connected: null, canControl: null, blank: null, diagnosis: null, timedOut: false, tries: s.tries + 1, reload: s.reload + 1 };
    case "manual-retry":
      return { connected: null, canControl: null, blank: null, diagnosis: null, timedOut: false, tries: 0, reload: s.reload + 1 };
  }
}

/** Pure: is the screen dropped, will it try again by itself, and has it given up (so a Retry button shows). */
export function viewerFlow(s: Pick<ViewerState, "connected" | "tries"> & { blank?: boolean | null; diagnosis?: ViewerDiagnosis | null }, online: boolean): { dropped: boolean; retrying: boolean; gaveUp: boolean } {
  const dropped = s.connected === false;
  // A screen that reconnects forever against a layer a reconnect cannot fix (a dead display, an unreachable host) is not "trying again": it is told what to do.
  const fixable = !s.diagnosis?.next || s.diagnosis.next === "reconnect";
  const retrying = dropped && online && fixable && s.tries < MAX_RETRIES;
  return { dropped, retrying, gaveUp: dropped && !retrying };
}

/** Pure: the pause before the next automatic retry grows with every try. */
export const retryDelayMs = (tries: number) => 2000 * (tries + 1);

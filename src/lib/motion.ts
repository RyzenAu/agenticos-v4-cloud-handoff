// Stillness during work (NEXUS-ADDENDUM item 5). One motion controller for the shell:
//
//   preference   "still" (the default) or "ambient", chosen with the header's motion control and
//                remembered per browser. prefers-reduced-motion forces "still" and removes transitions.
//   work holds   ambient motion also stops while he is editing (focus in a field), deciding (a dialog or
//                approval is open), talking to Jarvis (listening / thinking / acting / needs-you) or
//                reading (scrolled or selected text in the last few seconds).
//
// The effective state is written to <html data-motion="still|ambient"> (+ data-reduced-motion) so CSS can
// pause every ambient loop; components that draw their own frames read `ambientAllowed()` or subscribe.
// Motion that explains progress (a step confirmed by its event) is not ambient: it still plays, briefly,
// unless reduced motion is on. Pure state + small DOM hooks; the React control is motion-control.tsx.

export type MotionPreference = "still" | "ambient";
export type HoldReason = "editing" | "deciding" | "talking" | "reading";
export type MotionState = {
  preference: MotionPreference;
  reduced: boolean;
  holds: readonly HoldReason[];
  /** Ambient loops may run: preference ambient, no reduced motion, nothing holding. */
  ambient: boolean;
};

export const MOTION_STORAGE_KEY = "agentic.motion";
export const READING_HOLD_MS = 4000;

let preference: MotionPreference = "still";
let reduced = false;
const holds = new Set<HoldReason>();
const listeners = new Set<(s: MotionState) => void>();

/** Pure: the effective state. */
export function motionState(p: MotionPreference = preference, r = reduced, h: Iterable<HoldReason> = holds): MotionState {
  const list = [...h].sort() as HoldReason[];
  return { preference: p, reduced: r, holds: list, ambient: p === "ambient" && !r && list.length === 0 };
}

export function readMotion(): MotionState {
  return motionState();
}

export function ambientAllowed() {
  return motionState().ambient;
}

function apply() {
  const s = motionState();
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.motion = s.ambient ? "ambient" : "still";
    if (s.reduced) root.dataset.reducedMotion = "";
    else delete root.dataset.reducedMotion;
  }
  for (const l of listeners) l(s);
}

export function subscribeMotion(listener: (s: MotionState) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setMotionPreference(next: MotionPreference) {
  if (next === preference) return;
  preference = next;
  try {
    localStorage.setItem(MOTION_STORAGE_KEY, next);
  } catch {
    /* private mode: the choice lasts this tab */
  }
  apply();
}

export function setHold(reason: HoldReason, on: boolean) {
  const had = holds.has(reason);
  if (on === had) return;
  if (on) holds.add(reason);
  else holds.delete(reason);
  apply();
}

/** For tests. */
export function resetMotion() {
  preference = "still";
  reduced = false;
  holds.clear();
}

/** Jarvis phases that mean he is talking to Jarvis or Jarvis is waiting on him. */
export const TALKING_PHASES = new Set(["listening", "thinking", "acting", "needs-you"]);

const EDITABLE = "input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]),textarea,select,[contenteditable=''],[contenteditable=true]";
/**
 * An open decision surface: Radix Dialog, AlertDialog and Sheet (they set data-state="open", not aria-modal:
 * the palette, the Command scene, slide-out panels, confirmations), a native <dialog open>, or anything that
 * marks itself [data-approval-open] (review item 6).
 */
export const DECIDING = "[role=dialog][data-state=open],[role=alertdialog][data-state=open],[role=alertdialog]:not([data-state]),[role=dialog][aria-modal=true],dialog[open],[data-approval-open]";

/**
 * Wire the controller to the page once (the shell calls it). Returns a cleanup. Browser only.
 */
export function startMotionController(): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    const saved = localStorage.getItem(MOTION_STORAGE_KEY);
    if (saved === "ambient" || saved === "still") preference = saved;
  } catch {
    /* ignore */
  }
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  reduced = !!mq?.matches;
  const onMq = () => {
    reduced = !!mq?.matches;
    apply();
  };
  mq?.addEventListener?.("change", onMq);

  const checkEditing = () => setHold("editing", !!document.activeElement?.closest?.(EDITABLE));
  const checkDeciding = () => setHold("deciding", !!document.querySelector(DECIDING));
  let readingTimer: number | undefined;
  const reading = () => {
    setHold("reading", true);
    window.clearTimeout(readingTimer);
    readingTimer = window.setTimeout(() => setHold("reading", false), READING_HOLD_MS);
  };
  const onSelection = () => {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) reading();
  };
  // Talking: a job Jarvis is running for him, or the Jarvis companion itself being open (voice or text).
  let jobTalking = false;
  let panelOpen = false;
  const onProgress = (e: Event) => {
    const phase = (e as CustomEvent<{ phase?: string }>).detail?.phase;
    jobTalking = typeof phase === "string" && TALKING_PHASES.has(phase);
    setHold("talking", jobTalking || panelOpen);
  };
  const onSurface = (e: Event) => {
    panelOpen = Boolean((e as CustomEvent<{ open?: boolean }>).detail?.open);
    setHold("talking", jobTalking || panelOpen);
  };
  document.addEventListener("focusin", checkEditing);
  document.addEventListener("focusout", () => window.setTimeout(checkEditing, 0));
  window.addEventListener("scroll", reading, { passive: true, capture: true });
  document.addEventListener("selectionchange", onSelection);
  window.addEventListener("jarvis:progress", onProgress);
  window.addEventListener("voice:surface", onSurface);
  const observer = new MutationObserver(checkDeciding);
  // Portalled dialogs mount as children of <body>; their open/closed state is an attribute further down.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "open", "data-approval-open"] });
  // Radix portals mount dialogs as direct children of <body>; an interval catches other dialogs cheaply.
  const poll = window.setInterval(checkDeciding, 1500);
  checkEditing();
  checkDeciding();
  apply();
  return () => {
    mq?.removeEventListener?.("change", onMq);
    document.removeEventListener("focusin", checkEditing);
    window.removeEventListener("scroll", reading, { capture: true } as EventListenerOptions);
    document.removeEventListener("selectionchange", onSelection);
    window.removeEventListener("jarvis:progress", onProgress);
    window.removeEventListener("voice:surface", onSurface);
    observer.disconnect();
    window.clearInterval(poll);
    window.clearTimeout(readingTimer);
  };
}

export const HOLD_TEXT: Record<HoldReason, string> = {
  editing: "while you edit",
  deciding: "while a decision is open",
  talking: "while you talk to Jarvis",
  reading: "while you read",
};

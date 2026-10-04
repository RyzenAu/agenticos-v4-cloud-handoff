// The one motion language for the OS UI (1 Oct 2026, programme C).
//
// Rules, in one place:
//  - Motion says what changed: where you went (navigation/selection), what opened (drawer), that a
//    save landed, how a task is moving (start -> progress -> complete) and that a link is coming back
//    (reconnect). Nothing loops unless it reports live work.
//  - Only `transform` and `opacity` animate. No layout properties, no blur, no glow.
//  - Durations and easings come from these tokens. The CSS twins are the --dur-*, --ease-* and --move-*
//    custom properties in src/styles.css ("Motion language"); change one, change both.
//  - `prefers-reduced-motion` collapses every duration to zero (styles.css), so state changes still happen,
//    just without travel. Decorative loops additionally follow the header's ambient switch (src/lib/motion.ts).
//  - Decorative or ambient movement (anything infinite) is paused while the document is hidden, by a
//    single attribute on <html> (`data-doc-hidden`) rather than per component.
import { useEffect, useState } from "react";
import { readMotion, subscribeMotion } from "./motion";

export const MOTION = {
  /** Milliseconds. Mirror --dur-* in styles.css. */
  dur: { fast: 120, base: 180, slow: 280, task: 420, saved: 2400 },
  /** CSS easing strings. Mirror --ease-* in styles.css. */
  ease: { out: "cubic-bezier(0.25, 1, 0.5, 1)", standard: "cubic-bezier(0.4, 0, 0.2, 1)" },
  /** Distances in px. Mirror --move-* in styles.css. */
  move: { sm: 6, drawer: 24 },
} as const;

export type MotionDuration = keyof typeof MOTION.dur;

/**
 * True when the visitor asked for reduced motion. (The header's ambient switch in src/lib/motion.ts only
 * governs decorative loops; status motion below still plays unless the OS preference says otherwise.)
 */
export function prefersReducedMotion(): boolean {
  if (readMotion().reduced) return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A duration in ms that is 0 under reduced motion: use for timers that stage an animation. */
export function motionMs(name: MotionDuration): number {
  return prefersReducedMotion() ? 0 : MOTION.dur[name];
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(prefersReducedMotion());
    update();
    mq.addEventListener("change", update);
    const off = subscribeMotion(update);
    return () => {
      mq.removeEventListener("change", update);
      off();
    };
  }, []);
  return reduced;
}

/** False while the tab is in the background. Use it to stop timers that only drive visuals. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Mirrors document visibility onto <html data-doc-hidden>. styles.css pauses every CSS animation
 * under that attribute, so decorative loops cost nothing in a background tab. Returns a cleanup.
 */
export function installMotionGuards(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const sync = () => {
    if (document.visibilityState === "hidden") root.setAttribute("data-doc-hidden", "");
    else root.removeAttribute("data-doc-hidden");
  };
  sync();
  document.addEventListener("visibilitychange", sync);
  return () => {
    document.removeEventListener("visibilitychange", sync);
    root.removeAttribute("data-doc-hidden");
  };
}

export type SavePhase = "idle" | "saving" | "saved" | "error";

/**
 * Save confirmation state: idle -> saving -> saved (auto-returns to idle) or error (stays until the
 * next save). `run` wraps the real save so the phase always follows what actually happened.
 */
export function useSavePhase(): { phase: SavePhase; run: <T>(work: () => Promise<T>) => Promise<T | undefined>; reset: () => void } {
  const [phase, setPhase] = useState<SavePhase>("idle");
  useEffect(() => {
    if (phase !== "saved") return;
    const t = window.setTimeout(() => setPhase("idle"), MOTION.dur.saved);
    return () => window.clearTimeout(t);
  }, [phase]);
  return {
    phase,
    reset: () => setPhase("idle"),
    run: async (work) => {
      setPhase("saving");
      try {
        const out = await work();
        setPhase("saved");
        return out;
      } catch {
        setPhase("error");
        return undefined;
      }
    },
  };
}

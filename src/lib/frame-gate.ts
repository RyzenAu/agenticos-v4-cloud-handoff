// One gate for loops that only exist to look alive (canvas planes, the orb's idle drive, the memory map's auto-rotation).
// A loop runs only while its element is on screen, the tab is in the foreground, the visitor has not asked for reduced
// motion and the header's motion control is on "ambient". "Still" (the header's default) stops decorative loops exactly
// as reduced motion does; motion that reports live work passes `live` and keeps running under "still" (never under the
// OS's reduced motion). CSS loops follow the same rule through <html data-motion> (experience.css).
import { readMotion, subscribeMotion } from "./motion";
import { prefersReducedMotion } from "./ui-motion";

export function loopShouldRun(s: { onScreen: boolean; hidden: boolean; reduced: boolean; still?: boolean }): boolean {
  return s.onScreen && !s.hidden && !s.reduced && !s.still;
}

/** `still`: the header's motion control is not on "ambient", or a motion hold (editing, deciding, talking, reading) is active, exactly as <html data-motion> says (unless something live is keeping the loop going). `reduced`: the OS asks for reduced motion. */
export type GateState = { onScreen: boolean; hidden: boolean; reduced: boolean; still: boolean };
export type FrameGate = { readonly active: boolean; stop: () => void; /** Re-evaluate now (for example when `live` changes). */ refresh: () => void };
export type GateOptions = { /** True while the loop shows live work (a voice level, a working state): it then keeps running under "still". */ live?: () => boolean };

/**
 * Watches `el` and calls `onChange(active)` whenever the loop should start or stop. The first call
 * happens straight away with the current state. Without IntersectionObserver the element counts as on screen.
 * `state` says why: a renderer may keep running (and stay interactive) under reduced motion, and should be paused only off screen or hidden.
 */
export function watchFrameGate(el: Element | null, onChange: (active: boolean, state: GateState) => void, options: GateOptions = {}): FrameGate {
  let onScreen = true;
  let active: boolean | null = null;
  const reducedQuery =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  const sync = () => {
    const state = {
      onScreen,
      hidden: document.visibilityState === "hidden",
      reduced: prefersReducedMotion(),
      still: !readMotion().ambient && !options.live?.(),
    };
    const next = loopShouldRun(state);
    if (next !== active) {
      active = next;
      onChange(next, state);
    }
  };
  let io: IntersectionObserver | null = null;
  if (el && typeof IntersectionObserver === "function") {
    io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) {
        onScreen = last.isIntersecting;
        sync();
      }
    });
    io.observe(el);
  }
  document.addEventListener("visibilitychange", sync);
  reducedQuery?.addEventListener?.("change", sync);
  // The in-app motion switch (header) takes effect at once, not at the next scroll or tab change.
  const offMotion = subscribeMotion(sync);
  sync();
  return {
    get active() {
      return active === true;
    },
    refresh: sync,
    stop() {
      io?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedQuery?.removeEventListener?.("change", sync);
      offMotion();
    },
  };
}

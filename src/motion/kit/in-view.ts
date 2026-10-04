/**
 * Shared "only run while on screen" helper for the motion kit. Pieces are self-contained strings, so the
 * helper's source travels with each piece: a piece's `init` is `IN_VIEW + "…its own body…"` and its `css`
 * ends with `PAUSE_CSS`. Nothing here imports React, the router or a server module.
 *
 * One running/paused state per piece: running = the tab is visible AND the piece root is intersecting the
 * viewport. `muInView(root, onChange)` calls `onChange(running)` whenever that flips, sets/removes
 * `data-mu-paused` on the root (the CSS rule below then pauses every CSS animation inside), and returns
 * `{ running(), stop() }`. `stop()` disconnects the observer and removes the visibility listener.
 * Without IntersectionObserver the piece is treated as always in view (runs as it did before).
 */

export const IN_VIEW = `
function muInView(root, onChange) {
  let inView = true;
  const state = () => !document.hidden && inView;
  const onVis = () => onChange(state());
  let io = null;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((entries) => {
      const seen = entries[entries.length - 1].isIntersecting;
      if (seen === inView) return;
      inView = seen;
      if (seen) root.removeAttribute("data-mu-paused");
      else root.setAttribute("data-mu-paused", "");
      onChange(state());
    }, { threshold: 0 });
    io.observe(root);
  }
  document.addEventListener("visibilitychange", onVis);
  return {
    running: state,
    stop() {
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}

/* A resumable timeline: events [[ms, fn], ...] inside a lap of loopMs; reset() runs at the start of each lap. */
function muSeq(reset, events, loopMs) {
  let timers = [];
  let t0 = 0;
  let elapsed = 0;
  let running = false;
  const clear = () => {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  };
  const schedule = (from) => {
    clear();
    running = true;
    t0 = performance.now() - from;
    events.forEach((e) => {
      if (e[0] >= from) timers.push(setTimeout(e[1], e[0] - from));
    });
    timers.push(setTimeout(() => {
      reset();
      schedule(0);
    }, Math.max(0, loopMs - from)));
  };
  return {
    start() {
      reset();
      schedule(0);
    },
    pause() {
      if (!running) return;
      elapsed = performance.now() - t0;
      running = false;
      clear();
    },
    resume() {
      if (running) return;
      schedule(elapsed);
    },
    stop() {
      running = false;
      clear();
    },
  };
}
`;

/** For CSS-only pieces: the helper plus the one line they need (pause the CSS loop off-screen). */
export const WATCH_ONLY = `${IN_VIEW}
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
const watch = muInView(root, () => {});
return () => {
  watch.stop();
};`;

/** Appended to every in-view-aware piece's CSS: while the root is off-screen, every animation inside is paused. */
export const PAUSE_CSS = `[data-mu-kit][data-mu-paused], [data-mu-kit][data-mu-paused] *, [data-mu-kit][data-mu-paused] *::before, [data-mu-kit][data-mu-paused] *::after { animation-play-state: paused !important; }`;

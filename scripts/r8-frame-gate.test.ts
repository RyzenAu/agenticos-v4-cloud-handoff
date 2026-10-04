// Round 8 (E): decorative requestAnimationFrame loops run only while on screen, in a foreground tab and with motion allowed.
// CSS loops already follow reduced motion and a hidden tab (styles.css); this is the same rule for the canvas loops.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loopShouldRun, watchFrameGate } from "../src/lib/frame-gate";
import { setHold, setMotionPreference } from "../src/lib/motion";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("loopShouldRun", () => {
  test("runs only when on screen, in front and motion is allowed", () => {
    expect(loopShouldRun({ onScreen: true, hidden: false, reduced: false })).toBe(true);
    expect(loopShouldRun({ onScreen: false, hidden: false, reduced: false })).toBe(false);
    expect(loopShouldRun({ onScreen: true, hidden: true, reduced: false })).toBe(false);
    expect(loopShouldRun({ onScreen: true, hidden: false, reduced: true })).toBe(false);
    // "Still" (the header's motion control) stops decorative loops like reduced motion does.
    expect(loopShouldRun({ onScreen: true, hidden: false, reduced: false, still: true })).toBe(false);
    expect(loopShouldRun({ onScreen: true, hidden: false, reduced: false, still: false })).toBe(true);
  });
});

describe("the always-on loops use the gate", () => {
  test("the plasma core stops off screen, in a background tab and under reduced motion", () => {
    const src = read("src/components/oracle-plasma.tsx");
    expect(/watchFrameGate\(\s*container/.test(src)).toBe(true);
    expect(src).toContain("running ? requestAnimationFrame(draw) : 0");
  });
  test("the orb's idle drive on every page is gated and zeroes the level when it stops", () => {
    const src = read("src/components/floating-oracle.tsx");
    expect(src).toContain("watchFrameGate(null");
    expect(src).toContain("setOrbLevel(0)");
  });
});

describe("watchFrameGate", () => {
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  let io: { cb: (e: { isIntersecting: boolean }[]) => void; disconnected: boolean } | null = null;
  const live = new Set<string>();
  let reducedNow = false;
  const mqListeners = new Set<() => void>();
  const flip = (v: boolean) => {
    reducedNow = v;
    for (const f of [...mqListeners]) f();
  };
  beforeAll(() => {
    const { window, document } = parseHTML("<html><body><div id='el'></div></body></html>");
    const doc = document as unknown as { addEventListener: (t: string, f: unknown) => void; removeEventListener: (t: string, f: unknown) => void };
    const add = doc.addEventListener.bind(doc), rm = doc.removeEventListener.bind(doc);
    doc.addEventListener = (t, f) => (live.add(t), add(t, f));
    doc.removeEventListener = (t, f) => (live.delete(t), rm(t, f));
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      get matches() {
        return reducedNow;
      },
      addEventListener: (_t: string, f: () => void) => mqListeners.add(f),
      removeEventListener: (_t: string, f: () => void) => mqListeners.delete(f),
    });
    class FakeIO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        io = { cb, disconnected: false };
      }
      observe() {}
      disconnect() {
        if (io) io.disconnected = true;
      }
    }
    for (const [k, v] of Object.entries({ window, document, IntersectionObserver: FakeIO })) {
      saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
      Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  });
  afterAll(() => {
    setMotionPreference("still");
    for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
  });

  test("the default is still: decorative loops are off until someone picks ambient", () => {
    setMotionPreference("still");
    const calls: [boolean, boolean, boolean][] = [];
    const gate = watchFrameGate(document.getElementById("el"), (active, s) => calls.push([active, s.still, s.reduced]));
    expect(calls).toEqual([[false, true, false]]);
    setMotionPreference("ambient");
    expect(calls.at(-1)).toEqual([true, false, false]); // the header's switch takes effect at once
    setMotionPreference("still");
    expect(calls.at(-1)).toEqual([false, true, false]);
    gate.stop();
  });

  test("a loop that shows live work keeps running under still, but never under the OS's reduced motion", () => {
    setMotionPreference("still");
    let liveNow = false;
    const calls: boolean[] = [];
    const gate = watchFrameGate(document.getElementById("el"), (active) => calls.push(active), { live: () => liveNow });
    expect(calls).toEqual([false]);
    liveNow = true;
    gate.refresh();
    expect(calls).toEqual([false, true]);
    flip(true);
    expect(calls.at(-1)).toBe(false);
    flip(false);
    expect(calls.at(-1)).toBe(true);
    liveNow = false;
    gate.refresh();
    expect(calls.at(-1)).toBe(false);
    gate.stop();
  });

  test("a motion hold (editing, reading...) stops decorative loops like data-motion does, unless the loop shows live work", () => {
    setMotionPreference("ambient");
    let liveNow = false;
    const calls: boolean[] = [];
    const gate = watchFrameGate(document.getElementById("el"), (active) => calls.push(active), { live: () => liveNow });
    expect(calls).toEqual([true]);
    setHold("editing", true);
    expect(calls.at(-1)).toBe(false);
    liveNow = true;
    gate.refresh();
    expect(calls.at(-1)).toBe(true);
    liveNow = false;
    setHold("editing", false);
    expect(calls.at(-1)).toBe(true);
    gate.stop();
  });

  test("calls back inactive, active, inactive as the element leaves and returns, says why, and stop() removes its listeners", () => {
    setMotionPreference("ambient");
    const calls: [boolean, boolean][] = [];
    const gate = watchFrameGate(document.getElementById("el"), (active, state) => calls.push([active, state.onScreen]));
    expect(calls).toEqual([[true, true]]); // current state straight away
    expect(live.has("visibilitychange")).toBe(true);
    io!.cb([{ isIntersecting: false }]);
    io!.cb([{ isIntersecting: false }]); // no change, no call
    io!.cb([{ isIntersecting: true }]);
    io!.cb([{ isIntersecting: false }]);
    expect(calls).toEqual([[true, true], [false, false], [true, true], [false, false]]);
    expect(gate.active).toBe(false);
    gate.stop();
    expect(io!.disconnected).toBe(true);
    expect(live.has("visibilitychange")).toBe(false);
  });

  test("the in-app motion switch takes effect at once, and a renderer can tell reduced motion from off screen", () => {
    setMotionPreference("ambient");
    const calls: [boolean, boolean, boolean][] = [];
    const gate = watchFrameGate(document.getElementById("el"), (active, s) => calls.push([active, s.onScreen, s.reduced]));
    flip(true);
    expect(calls.at(-1)).toEqual([false, true, true]); // inactive while still on screen: a renderer pauses only its rotation, not itself
    flip(false);
    expect(calls.at(-1)).toEqual([true, true, false]);
    // the header's switch re-evaluates too (apply() notifies subscribers): same state, so no extra call
    const n = calls.length;
    setMotionPreference("ambient");
    expect(calls.length).toBe(n);
    setMotionPreference("still");
    expect(calls.at(-1)).toEqual([false, true, false]);
    gate.stop();
    expect(mqListeners.size).toBe(0);
  });
});

describe("the graph pauses only what it can't see", () => {
  test("brain-graph-3d pauses the renderer off screen or hidden, not under reduced motion; the plasma repaints on resize while paused", () => {
    const g = read("src/components/brain-graph-3d.tsx");
    expect(g).toContain("const unseen = !state.onScreen || state.hidden;");
    expect(g).toContain("if (unseen) fg.pauseAnimation");
    expect(read("src/components/oracle-plasma.tsx")).toContain("if (!running) {");
  });
});

describe("still reaches the CSS loops and the live-status exceptions", () => {
  test("the decorative CSS loops, including the marquee and the orb flow, pause unless <html data-motion=ambient>", () => {
    const css = read("src/components/shell/experience.css");
    for (const sel of [".ar-site-showcase-track", ".jarvis-orb-flow", ".jarvis-orb-ribbon", ".design-render-rim", ".rainbow-button", ".ambient-drift", "[data-ambient]"])
      expect(css).toContain(sel);
    expect(css).toContain('html:not([data-motion="ambient"]) :is(');
  });
  test("the plasma keeps drawing for a voice level or a working mode, and re-checks when that changes", () => {
    const src = read("src/components/oracle-plasma.tsx");
    expect(src).toContain('modeRef.current !== "idle" || levelRef.current > 0.02');
    expect(src).toContain("gateRef.current?.refresh()");
  });
  test("the memory map stops only its auto-rotation under still: it never calls pauseAnimation for it", () => {
    const g = read("src/components/brain-graph-3d.tsx");
    expect(g).toContain("const unseen = !state.onScreen || state.hidden;");
    expect(g).not.toContain("state.still");
  });
});

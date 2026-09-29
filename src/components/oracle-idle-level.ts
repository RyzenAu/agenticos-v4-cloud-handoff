/**
 * The orb's ambient idle level (W-D, 29 Sep 2026). It used to be React state set every 60 ms, which
 * re-rendered the whole FloatingOracle ~16 times a second on every page (~14% of the main thread on
 * the Memory page) although nothing read it. Now the level goes to a ref and a CSS variable on one
 * small element: no React render at all.
 */
export const IDLE_LEVEL_VAR = "--oracle-idle-level";
export const IDLE_LEVEL_EVERY_MS = 60;
export const IDLE_LEVEL_SCALE = 0.45;

/**
 * One frame of the idle drive: advances the synthetic voice and, at most every 60 ms, writes the
 * scaled level into `ref` and the CSS variable on `host`. Returns the updated timestamps.
 */
export function idleLevelStep(
  state: { prev: number; lastSet: number },
  now: number,
  tick: (dt: number) => { level: number },
  ref: { current: number },
  host: { style: { setProperty(name: string, value: string): void } } | null,
) {
  const dt = Math.min(0.05, (now - state.prev) / 1000);
  state.prev = now;
  const s = tick(dt);
  if (now - state.lastSet > IDLE_LEVEL_EVERY_MS) {
    const level = Math.max(0, Math.min(1, s.level)) * IDLE_LEVEL_SCALE;
    ref.current = level;
    host?.style.setProperty(IDLE_LEVEL_VAR, level.toFixed(3));
    state.lastSet = now;
  }
  return state;
}

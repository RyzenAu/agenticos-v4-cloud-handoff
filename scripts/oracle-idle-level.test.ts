// W-D (29 Sep 2026): the orb's idle level must not re-render the FloatingOracle (it did ~16x/s on
// every page). It goes to a ref and a CSS variable, at most every 60 ms.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_LEVEL_EVERY_MS, IDLE_LEVEL_SCALE, IDLE_LEVEL_VAR, idleLevelStep } from "../src/components/oracle-idle-level";

describe("idleLevelStep", () => {
  test("writes the scaled level to the ref and the CSS variable at most every 60 ms", () => {
    const ref = { current: 0 };
    const writes: [string, string][] = [];
    const host = { style: { setProperty: (k: string, v: string) => void writes.push([k, v]) } };
    const state = { prev: 0, lastSet: 0 };
    let ticks = 0;
    for (let t = 16; t <= 1000; t += 16) idleLevelStep(state, t, () => (ticks++, { level: 0.8 }), ref, host);
    expect(ticks).toBe(62); // the synthetic voice still advances every frame
    expect(writes.length).toBeLessThanOrEqual(Math.ceil(1000 / IDLE_LEVEL_EVERY_MS));
    expect(writes.length).toBeGreaterThan(10);
    expect(writes.every(([k]) => k === IDLE_LEVEL_VAR)).toBe(true);
    expect(ref.current).toBeCloseTo(0.8 * IDLE_LEVEL_SCALE);
  });
  test("clamps the level and survives a missing host element", () => {
    const ref = { current: 0 };
    idleLevelStep({ prev: 0, lastSet: 0 }, 100, () => ({ level: 7 }), ref, null);
    expect(ref.current).toBeCloseTo(IDLE_LEVEL_SCALE);
  });
});

test("FloatingOracle no longer keeps the idle level in React state", () => {
  const src = readFileSync(join(import.meta.dir, "../src/components/floating-oracle.tsx"), "utf8");
  expect(/const \[level, setLevel\] = useState/.test(src)).toBe(false);
  expect(src).toContain("idleLevelStep(");
});

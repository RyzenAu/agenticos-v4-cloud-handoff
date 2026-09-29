import { describe, expect, test } from "bun:test";
import {
  isEarconEnabled,
  playAcknowledgeEarcon,
  setEarconEnabled,
  type EarconAudioContext,
  type EarconAudioParam,
  type EarconGainNode,
  type EarconOscillatorNode,
  type EarconStorage,
} from "../src/lib/earcons.ts";

function fakeParam() {
  const calls: { method: "set" | "ramp"; value: number; time: number }[] = [];
  const param: EarconAudioParam = {
    setValueAtTime(value, time) {
      calls.push({ method: "set", value, time });
    },
    linearRampToValueAtTime(value, time) {
      calls.push({ method: "ramp", value, time });
    },
  };
  return { param, calls };
}

function fakeContext(currentTime = 1.5) {
  const gainCalls: { method: "set" | "ramp"; value: number; time: number }[][] = [];
  const oscillators: { type: string; started: number[]; stopped: number[]; frequency: number[] }[] = [];
  const context: EarconAudioContext = {
    currentTime,
    createGain(): EarconGainNode {
      const { param, calls } = fakeParam();
      gainCalls.push(calls);
      return { gain: param, connect: () => {} };
    },
    createOscillator(): EarconOscillatorNode {
      const started: number[] = [];
      const stopped: number[] = [];
      const frequency: number[] = [];
      const record = { type: "", started, stopped, frequency };
      oscillators.push(record);
      return {
        get type() {
          return record.type;
        },
        set type(value: string) {
          record.type = value;
        },
        frequency: {
          setValueAtTime(value) {
            frequency.push(value);
          },
          linearRampToValueAtTime(value) {
            frequency.push(value);
          },
        },
        connect: () => {},
        start: (time = 0) => started.push(time),
        stop: (time = 0) => stopped.push(time),
      };
    },
  };
  return { context, gainCalls, oscillators };
}

describe("playAcknowledgeEarcon", () => {
  test("creates exactly one gain envelope and two sine partials", () => {
    const { context, gainCalls, oscillators } = fakeContext();
    playAcknowledgeEarcon(context, {});
    expect(gainCalls.length).toBe(1);
    expect(oscillators.length).toBe(2);
    for (const osc of oscillators) expect(osc.type).toBe("sine");
  });

  test("fades in from silence and back to silence within the requested duration", () => {
    const { context, gainCalls } = fakeContext(2);
    playAcknowledgeEarcon(context, {}, { durationMs: 100, gain: 0.05 });
    const calls = gainCalls[0];
    expect(calls[0]).toMatchObject({ method: "set", value: 0, time: 2 });
    expect(calls[1].method).toBe("ramp");
    expect(calls[1].value).toBeCloseTo(0.05);
    expect(calls[2].method).toBe("ramp");
    expect(calls[2].value).toBe(0);
    expect(calls[2].time).toBeCloseTo(2.1);
  });

  test("stays quiet by default: peak gain is well under full volume", () => {
    const { context, gainCalls } = fakeContext();
    playAcknowledgeEarcon(context, {});
    const peak = Math.max(...gainCalls[0].map((c) => c.value));
    expect(peak).toBeLessThan(0.15);
  });

  test("is short: ~120ms by default, oscillators stop shortly after that", () => {
    const { context, oscillators } = fakeContext(0);
    playAcknowledgeEarcon(context, {});
    for (const osc of oscillators) {
      expect(osc.started[0]).toBe(0);
      expect(osc.stopped[0]).toBeGreaterThan(0.12);
      expect(osc.stopped[0]).toBeLessThan(0.2);
    }
  });

  test("uses two distinct partials by default", () => {
    const { context, oscillators } = fakeContext();
    playAcknowledgeEarcon(context, {});
    const freqs = oscillators.map((o) => o.frequency[0]);
    expect(freqs.length).toBe(2);
    expect(freqs[0]).not.toBe(freqs[1]);
  });

  test("options override the defaults", () => {
    const { context, oscillators, gainCalls } = fakeContext(0);
    playAcknowledgeEarcon(context, {}, { frequencies: [440, 660], durationMs: 60, gain: 0.02 });
    expect(oscillators.map((o) => o.frequency[0])).toEqual([440, 660]);
    expect(gainCalls[0][1].value).toBeCloseTo(0.02);
    expect(gainCalls[0][2].time).toBeCloseTo(0.06);
  });
});

describe("earcon setting (localStorage jarvis:earcon)", () => {
  function memoryStorage(initial: Record<string, string> = {}): EarconStorage {
    const store: Record<string, string> = { ...initial };
    return {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
  }

  test("defaults to enabled when nothing is stored", () => {
    expect(isEarconEnabled(memoryStorage())).toBe(true);
  });

  test("off after being explicitly turned off, back on after being turned on again", () => {
    const storage = memoryStorage();
    setEarconEnabled(false, storage);
    expect(isEarconEnabled(storage)).toBe(false);
    setEarconEnabled(true, storage);
    expect(isEarconEnabled(storage)).toBe(true);
  });

  test("any other stored value (typo, stale schema) is treated as enabled", () => {
    expect(isEarconEnabled(memoryStorage({ "jarvis:earcon": "nope" }))).toBe(true);
  });

  test("a broken storage never throws and defaults to enabled", () => {
    const storage: EarconStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(isEarconEnabled(storage)).toBe(true);
    expect(() => setEarconEnabled(false, storage)).not.toThrow();
  });
});

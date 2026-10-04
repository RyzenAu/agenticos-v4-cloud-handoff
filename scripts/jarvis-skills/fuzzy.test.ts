import { describe, expect, test } from "bun:test";
import { bestMatch, similarity } from "./fuzzy";

describe("similarity (difflib-style ratio)", () => {
  test("matches Python's SequenceMatcher on known pairs", () => {
    expect(similarity("spotify", "spotify")).toBe(1);
    expect(similarity("spotfy", "spotify")).toBeCloseTo(12 / 13, 5);
    expect(similarity("whatsap", "whatsapp")).toBeCloseTo(14 / 15, 5);
    expect(similarity("abcd", "bcde")).toBeCloseTo(0.75, 5);
    expect(similarity("", "")).toBe(1);
    expect(similarity("a", "")).toBe(0);
    expect(similarity("notepad", "netflix")).toBeLessThan(0.5);
  });
  test("bestMatch refuses weak matches and ties", () => {
    const items = ["spotify", "whatsapp", "notepad"];
    expect(bestMatch("spotfy", items, (x) => [x])).toBe("spotify");
    expect(bestMatch("excel", items, (x) => [x])).toBeNull();
    expect(bestMatch("ab", ["ac", "ad"], (x) => [x], 0.4)).toBeNull();
  });
});

// REVIEW-T6 finding 1: /__away/telegram is rate-limited per sender (code replies more tightly).
import { describe, expect, test } from "bun:test";
import { CODE_REPLIES_PER_MINUTE, RELAY_PER_MINUTE, RELAY_TRACKED_SENDERS, relayLimiter } from "./service";

describe("away relay rate limit", () => {
  test("code replies: at most CODE_REPLIES_PER_MINUTE a minute per sender; other senders and ordinary text unaffected; it recovers", () => {
    let t = 1_000_000;
    const allow = relayLimiter(() => t);
    for (let i = 0; i < CODE_REPLIES_PER_MINUTE; i++) expect(allow("111", `approve AAAA-BBB${i}`)).toBe(true);
    expect(allow("111", "approve AAAA-CCCC")).toBe(false);
    expect(allow("111", "approve K7PQ")).toBe(false); // away-mode codes count too
    expect(allow("222", "approve AAAA-CCCC")).toBe(true);
    expect(allow("111", "how's the receptionist going")).toBe(true);
    t += 61_000;
    expect(allow("111", "approve AAAA-CCCC")).toBe(true);
  });

  test("all messages: at most RELAY_PER_MINUTE a minute per sender", () => {
    let t = 5_000_000;
    const allow = relayLimiter(() => t);
    for (let i = 0; i < RELAY_PER_MINUTE; i++) expect(allow("333", `message ${i}`)).toBe(true);
    expect(allow("333", "one more")).toBe(false);
    t += 61_000;
    expect(allow("333", "one more")).toBe(true);
  });
});

describe("fair eviction (REVIEW-T6 R2)", () => {
  test("1,001 fake senders can't reset a listed person's counter; unknown senders are evicted instead", () => {
    const t = 9_000_000;
    const allow = relayLimiter(() => t, () => new Set(["1000000001"]));
    for (let i = 0; i < CODE_REPLIES_PER_MINUTE; i++) expect(allow("1000000001", `approve AAAA-BBB${i}`)).toBe(true);
    expect(allow("1000000001", "approve AAAA-CCCC")).toBe(false);
    for (let i = 0; i < RELAY_TRACKED_SENDERS + 5; i++) allow(`fake-${i}`, "hello");
    expect(allow("1000000001", "approve AAAA-DDDD")).toBe(false); // still limited: the counter survived
  });

  test("idle senders are evicted before active unknown ones", () => {
    let t = 20_000_000;
    const allow = relayLimiter(() => t);
    for (let i = 0; i < RELAY_PER_MINUTE; i++) allow("active", `m${i}`);
    t += 61_000;
    for (let i = 0; i < RELAY_TRACKED_SENDERS; i++) allow(`fresh-${i}`, "hi");
    // "active" went idle (evicted, fine); a sender at its limit inside the window keeps its counter:
    for (let i = 0; i < RELAY_PER_MINUTE; i++) allow("busy", `m${i}`);
    for (let i = 0; i < 50; i++) allow(`more-${i}`, "hi");
    expect(allow("busy", "one more")).toBe(false);
  });
});

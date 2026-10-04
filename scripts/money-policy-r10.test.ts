// Round 10 (review of 645f69fb): the money policy's own coverage for account/device phrases. SYNTHETIC words only: nothing is bought, sold or sent.
// A leading "on/with/using/via <account or device>" phrase never hides a trade, a name between the number and "shares" never hides a quantity of
// securities, and a coding request that only NAMES a Claude account still reaches coding.
import { describe, expect, test } from "bun:test";
import { moneyRefusal } from "../src/lib/money-policy";
import { screenGoalRefusal } from "./screen-hands/refusals";
import { codingMoneyRefusal } from "./jarvis-execution/spoken-money";

const TRADES = [
  "on Claude Max 2 buy 5 BHP shares",
  "on claude max 2 sell all my apple stock",
  "with claude max 2 buy 10 Tesla shares",
  "using opus buy 10 Tesla shares",
  "on my laptop buy 10 Tesla shares",
];

describe("money policy: account and device phrases never hide a trade", () => {
  test.each(TRADES)("%s is refused by all three gates", (words) => {
    expect(moneyRefusal(words)?.kind).toBe("money-or-trading");
    expect(screenGoalRefusal(words)).not.toBeNull();
    expect(codingMoneyRefusal(words)).not.toBeNull();
  });

  test("a coding request that only names a Claude account is not a purchase", () => {
    for (const words of ["Fix this bug using Opus on Claude Max 2", "fix the header in the dental site with Claude Max 3"]) {
      expect(moneyRefusal(words)).toBeNull();
      expect(codingMoneyRefusal(words)).toBeNull();
    }
  });

  test("buying or subscribing to a Claude plan is still caught", () => {
    for (const words of ["buy Claude Max 2", "upgrade to Claude Max", "subscribe to Claude Max", "get me Claude Max 2"]) expect(moneyRefusal(words)?.kind).toBe("money-or-trading");
  });

  test("ordinary device and slide phrases stay clear", () => {
    for (const words of ["on my laptop open YouTube", "with my team sell the receptionist offer", "on the slide add 10 more bullet units"]) expect(moneyRefusal(words)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { validJevAnswers } from "./jev-answer-validation";

const questions = {
  route: { type: "choice", criteria: { act: "Ready", look: "Need evidence" } },
  ready: { type: "noul" },
  quality: { type: "score", criteria: ["Poor", "Fair", "Good"] },
};
const choice = { type: "choice", choice: "act", confidence: .8, probabilities: { act: .9, look: .1 } };

describe("Jev response boundary", () => {
  test("accepts typed primitives including fractional scores", () => {
    expect(validJevAnswers(questions, {
      route: choice, ready: { type: "noul", noul: .7 },
      quality: { type: "score", score: 1.7, confidence: .6, probabilities: { 0: .1, 1: .1, 2: .8 } },
    })).toBe(true);
  });
  test("preserves legacy optional metadata and partial fan-out responses", () => {
    expect(validJevAnswers(questions, { route: { choice: "look" } })).toBe(true);
  });
  for (const [label, answers] of Object.entries({
    array: [], empty: {}, null: null, unasked: { unexpected: choice },
    wrongType: { route: { ...choice, type: "noul" } },
    unknownChoice: { route: { ...choice, choice: "delete" } },
    inheritedChoice: { route: { ...choice, choice: "toString" } },
    stringConfidence: { route: { ...choice, confidence: "0.9" } },
    infiniteConfidence: { route: { ...choice, confidence: Infinity } },
    negativeProbability: { route: { ...choice, probabilities: { act: 1.1, look: -.1 } } },
    incompleteDistribution: { route: { ...choice, probabilities: { act: 1 } } },
    badTotal: { route: { ...choice, probabilities: { act: .9, look: .9 } } },
    arrayDistribution: { route: { ...choice, probabilities: [.9, .1] } },
    nanNoul: { ready: { noul: NaN } }, outOfRangeNoul: { ready: { noul: 2 } },
    outOfRangeScore: { quality: { score: 3 } }, missingScore: { quality: {} },
  })) test(`rejects ${label}`, () => expect(validJevAnswers(questions, answers)).toBe(false));
});

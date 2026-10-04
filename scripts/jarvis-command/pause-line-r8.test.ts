import { describe, expect, test } from "bun:test";
import { pausedHolder, pauseLine, progressFor } from "./threads";

// Round 8 (track C): the step history told Usman "Paused: usman is taking control of the computer" about himself, by id, in the third person.
const pause = (who: string) => ({ seq: 4, at: 1, executor: "computer.lease", ms: 0, outcome: "note" as const, intent: `paused before step 2 (page.text): ${who} is taking control` });

describe("the pause line is worded from the conversation owner's side", () => {
  test("the owner took the controls: second person, no id", () => {
    const line = progressFor(pause("usman"), "usman");
    expect(line).toBe("Paused: you took the controls of the computer. The job waits until you return them.");
    expect(line).not.toMatch(/usman/i);
  });
  test("someone else took them: their name, capitalised, and that it waits for them", () => {
    expect(progressFor(pause("mehroz"), "usman")).toBe("Paused: Mehroz took the controls of the computer. The job waits and does not run until they hand them back.");
    expect(progressFor(pause("usman"))).toMatch(/^Paused: Usman took the controls/);
  });
  test("the holder is read from the step itself (the blocker no longer parses the worded line)", () => {
    expect(pausedHolder(pause("usman"))).toBe("usman");
    expect(pausedHolder({ executor: "companion", intent: "paused before x: usman is taking control" })).toBeNull();
    expect(pausedHolder({ executor: "computer.lease", intent: "control returned to the agent" })).toBeNull();
    expect(pauseLine("Usman", "usman")).toMatch(/^Paused: you took/);
  });
});

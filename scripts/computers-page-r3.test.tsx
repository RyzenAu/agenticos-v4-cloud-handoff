import { describe, expect, test } from "bun:test";
import { doingText, screenPhase } from "../src/components/computers/computers-page";

describe("computers page, round 3", () => {
  test("the screen chip says connecting, live (view-only or acting), reconnecting or disconnected", () => {
    expect(screenPhase({ connected: null, canControl: null }, false)).toEqual({ phase: "reconnecting", label: "Connecting to the screen…" });
    expect(screenPhase({ connected: true, canControl: false }, false)).toEqual({ phase: "live", label: "Screen live, view-only" });
    expect(screenPhase({ connected: true, canControl: true }, false).label).toBe("Screen live, you can act");
    expect(screenPhase({ connected: false, canControl: null }, true).label).toBe("Reconnecting to the screen…");
    expect(screenPhase({ connected: false, canControl: null }, false)).toEqual({ phase: "offline", label: "Screen disconnected" });
  });
  test("the job line names the job and agent, a paused job, or nothing", () => {
    expect(doingText({ assigned: { jobId: "j", title: "Fix X", agent: "builder", by: "usman" }, paused: null } as never)).toBe("Fix X · builder");
    expect(doingText({ assigned: null, paused: { jobId: "j", agent: "builder" } } as never)).toContain("Paused: builder's job");
    expect(doingText({ assigned: null, paused: null } as never)).toBe("Nothing assigned");
  });
});

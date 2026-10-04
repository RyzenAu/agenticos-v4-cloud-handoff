// Track 1 motion rules: progress moves only on confirmed events (NEXUS-ADDENDUM 4); ambient motion is off
// by default and held still during work or under reduced motion (NEXUS-ADDENDUM 5).
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_PIPELINE, CODING_PIPELINE, SYNTHETIC_CALL_REPLAY, callEvents, codingEvents, stepStates } from "../src/lib/progress-steps";
import { motionState, readMotion, resetMotion, setHold, setMotionPreference } from "../src/lib/motion";
import { ProgressSteps } from "../src/components/shell/progress-steps";

afterEach(() => resetMotion());

describe("progress steps move only on their event", () => {
  test("no events: every step waits; nothing is 'active' before the run starts", () => {
    expect(stepStates(CALL_PIPELINE, []).map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending"]);
  });
  test("each synthetic replay event confirms exactly its step, in order, and never one ahead", () => {
    const feed = SYNTHETIC_CALL_REPLAY.map((e) => ({ callId: "c1", type: e.type, at: new Date(1_000 + e.offsetMs).toISOString() }));
    for (let n = 1; n <= feed.length; n++) {
      const views = stepStates(CALL_PIPELINE, callEvents("c1", feed.slice(0, n)), { ended: n === feed.length });
      expect(views.filter((v) => v.state === "done").length).toBe(n);
      // the step after the last confirmed one is at most "active", never "done"
      if (n < feed.length) expect(views[n].state).toBe("active");
      for (let k = n + 1; k < views.length; k++) expect(views[k].state).toBe("pending");
    }
  });
  test("a calendar step whose booking failed is 'failed', and nothing after it is active", () => {
    const views = stepStates(CALL_PIPELINE, callEvents("c1", [
      { callId: "c1", type: "call.started", at: "2026-09-28T01:00:00Z" },
      { callId: "c1", type: "call.analysed", at: "2026-09-28T01:00:02Z" },
      { callId: "c1", type: "booking.failed", at: "2026-09-28T01:00:04Z" },
    ]));
    expect(views.map((v) => v.state)).toEqual(["done", "done", "failed", "pending"]);
  });
  test("another call's events never move this call", () => {
    expect(callEvents("c1", [{ callId: "c2", type: "call.started", at: "2026-09-28T01:00:00Z" }])).toEqual([]);
  });
  test("coding: assigned from the job, building from a step, tests only from a test-verified step", () => {
    const job = { id: "j", kind: "coding", state: "running", title: "Fix tests", createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:05:00Z", stepCount: 1, lastStep: null, steps: [
      { seq: 1, at: Date.parse("2026-09-28T01:01:00Z"), intent: "edit files", executor: "codex", ms: 10, outcome: "ok" },
    ] } as never;
    expect(stepStates(CODING_PIPELINE, codingEvents(job)).map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
    const tested = { ...(job as object), steps: [...(job as { steps: object[] }).steps, { seq: 2, at: Date.parse("2026-09-28T01:03:00Z"), intent: "run the suite", executor: "bun", ms: 10, outcome: "ok", verification: { method: "tests", ok: true } }] } as never;
    expect(stepStates(CODING_PIPELINE, codingEvents(tested)).find((s) => s.key === "tests")?.state).toBe("done");
  });
  test("the list's first render never animates (history isn't news)", () => {
    const html = renderToStaticMarkup(createElement(ProgressSteps, { steps: stepStates(CALL_PIPELINE, callEvents("c1", [{ callId: "c1", type: "call.started", at: "2026-09-28T01:00:00Z" }])), label: "Call" }));
    expect(html).not.toContain("data-fresh");
    expect(html).toContain("Confirmed");
    expect(html).toContain("needs: booking CONFIRMED");
  });
});

describe("stillness", () => {
  test("ambient motion is off by default", () => {
    expect(readMotion()).toMatchObject({ preference: "still", ambient: false });
  });
  test("on, it stops while editing, deciding, talking or reading, and never under reduced motion", () => {
    setMotionPreference("ambient");
    expect(readMotion().ambient).toBe(true);
    for (const h of ["editing", "deciding", "talking", "reading"] as const) {
      setHold(h, true);
      expect(readMotion()).toMatchObject({ ambient: false, holds: [h] });
      setHold(h, false);
    }
    expect(motionState("ambient", true, []).ambient).toBe(false);
  });
  test("the shell sets data-motion before first paint and the CSS pauses ambient loops unless 'ambient'", () => {
    const root = readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8");
    expect(root).toContain('dataset.motion=localStorage.getItem("agentic.motion")==="ambient"');
    const css = readFileSync(join(import.meta.dir, "../src/components/shell/experience.css"), "utf8");
    expect(css).toContain('html:not([data-motion="ambient"])');
    expect(css).toContain("animation-play-state: paused");
    // progress animation is brief (≤ 300 ms)
    for (const m of css.matchAll(/ps-(?:confirm|edge) (\d+)ms/g)) expect(Number(m[1])).toBeLessThanOrEqual(300);
  });
});

// Review item 6: Radix dialogs, sheets and alert dialogs (data-state="open", no aria-modal) hold motion still.
import { parseHTML } from "linkedom";
import { DECIDING } from "../src/lib/motion";

describe("the 'deciding' hold sees real dialogs", () => {
  const has = (html: string) => !!parseHTML(`<html><body>${html}</body></html>`).document.querySelector(DECIDING);
  test("open Radix dialog, sheet, alert dialog, <dialog open>, approval marker → held", () => {
    expect(has('<div role="dialog" data-state="open" class="cp-dialog"></div>')).toBe(true);
    expect(has('<div role="dialog" data-state="open" class="cs-stage"></div>')).toBe(true);
    expect(has('<div role="alertdialog" data-state="open"></div>')).toBe(true);
    expect(has("<dialog open></dialog>")).toBe(true);
    expect(has('<section data-approval-open=""></section>')).toBe(true);
  });
  test("a closed dialog doesn't hold", () => {
    expect(has('<div role="dialog" data-state="closed"></div>')).toBe(false);
    expect(has("<main></main>")).toBe(false);
  });
});

describe("review item 12: waiting for his yes is review in progress, not done", () => {
  test("awaiting-approval → review active", () => {
    const job = { id: "j", kind: "coding", state: "awaiting-approval", title: "t", createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:05:00Z", stepCount: 1, lastStep: null, steps: [{ seq: 1, at: Date.parse("2026-09-28T01:01:00Z"), intent: "edit files", executor: "codex", ms: 1, outcome: "ok" }] } as never;
    expect(stepStates(CODING_PIPELINE, codingEvents(job)).map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
  });
});

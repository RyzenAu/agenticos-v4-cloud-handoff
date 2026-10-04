// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyEntries, emptyChat, toBlocks, type Run } from "./chat-state";
import { RunCard, defaultLinks } from "./entries";
import { createFakeBotHub, JOB_A } from "./__fixtures__/fake-bot-hub";

// Release blocker (r7 real-computer run): a finished job's card stayed "Working" with Stop and its report hidden under "earlier steps", because the hub
// appended a "Not saved to shared memory" line AFTER `succeeded` and the card read its status from the last entry.
const flat = (html: string) => html.replace(/<!-- -->/g, "");
const J = JOB_A;
const MEMORY_NOTE = "Not saved to shared memory: saving is switched off on this hub.";

function finished() {
  const hub = createFakeBotHub();
  hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: Find dentists (job ${J.slice(0, 8)}).` });
  hub.step(J, 1, "Step 1 of 2: found 14 practices.");
  hub.result(J, "Five practices stand out.");
  hub.finish(J);
  return hub;
}
const run = (hub: ReturnType<typeof createFakeBotHub>, order?: (e: typeof hub.entries) => typeof hub.entries) => {
  const state = applyEntries(emptyChat(), order ? order(hub.entries) : hub.entries).state;
  return toBlocks(state).find((b): b is Run => b.type === "run")!;
};
const card = (r: Run) => flat(renderToStaticMarkup(<RunCard run={r} links={defaultLinks("/computers")} onStop={() => {}} />));

describe("a terminal entry decides the card; nothing after it reopens it", () => {
  test("succeeded, then a memory note: done, the result is the headline, no Stop, the note is a small line (not a step)", () => {
    const hub = finished();
    hub.append({ key: `${J}:memory`, jobId: J, state: "note", text: MEMORY_NOTE });
    const r = run(hub);
    expect(r.status).toBe("done");
    expect(r.notes.map((n) => n.text)).toEqual([MEMORY_NOTE]);
    expect(r.steps.map((s) => s.text)).not.toContain(MEMORY_NOTE);
    const html = card(r);
    expect(html).toContain("Five practices stand out.");
    expect(html).not.toContain(">Stop<");
    expect(html).not.toContain("Working");
    expect(html).toContain('data-entry="note-info"');
    expect(html.indexOf("Five practices stand out.")).toBeLessThan(html.indexOf("Not saved to shared memory"));
  });

  test("an OLD memory entry stored as progress (key :memory) is read as a note too, and a late progress step after the end cannot reopen the card", () => {
    const hub = finished();
    hub.append({ key: `${J}:memory`, jobId: J, state: "progress", text: MEMORY_NOTE });
    hub.step(J, 9, "A late step.");
    const r = run(hub);
    expect(r.status).toBe("done");
    expect(r.notes).toHaveLength(1);
    expect(card(r)).not.toContain(">Stop<");
  });

  test("the same holds on every path: all entries at once (catch-up), one at a time (live), a replay, and a reversed arrival order", () => {
    const hub = finished();
    hub.append({ key: `${J}:memory`, jobId: J, state: "note", text: MEMORY_NOTE });
    const all = run(hub);
    let live = emptyChat();
    for (const e of hub.entries) live = applyEntries(live, [e]).state;
    live = applyEntries(live, hub.entries).state; // a snapshot re-read from 0 on top
    const liveRun = toBlocks(live).find((b): b is Run => b.type === "run")!;
    const reversed = run(hub, (es) => [...es].reverse());
    for (const r of [all, liveRun, reversed]) {
      expect(r.status).toBe("done");
      expect(r.notes).toHaveLength(1);
    }
  });

  test("a note on a job that is still running does not finish it, and a real new state after the end (a coding job waiting for approval) still counts", () => {
    const hub = createFakeBotHub();
    hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: x (job ${J.slice(0, 8)}).` });
    hub.append({ key: `${J}:memory`, jobId: J, state: "note", text: "Saved the outcome to shared memory." });
    expect(run(hub).status).toBe("running");
    hub.finish(J);
    hub.waiting(J, "awaiting_approval", "Waiting for your approval.", { kind: "needs-approval" });
    expect(run(hub).status).toBe("blocked");
  });
});

describe("who has the controls reads differently for the holder and the other founder", () => {
  const blockedRun = (blocker: { kind: string; held?: "you" | "other"; recovery: string }) => {
    const hub = createFakeBotHub();
    hub.append({ key: `${J}:started`, jobId: J, state: "started", text: `Started: x (job ${J.slice(0, 8)}).` });
    hub.append({ key: `${J}:step:1`, jobId: J, state: "progress", text: "Paused: usman is taking control of the computer.", blocker });
    return toBlocks(applyEntries(emptyChat(), hub.entries).state).find((b): b is Run => b.type === "run")!;
  };
  const html = (r: Run) => flat(renderToStaticMarkup(<RunCard run={r} links={{ ...defaultLinks("/computers"), computer: () => "/agents/workspace/research?tab=computer" }} />));

  test("the holder: one sentence, one Return action (no 'Take over', no 'wait until they hand it back')", () => {
    const h = html(blockedRun({ kind: "needs-takeover", held: "you", recovery: "Paused while you have the controls. Return them when you're done." }));
    // Round 8: the title says "Paused while you have the controls"; the body adds only what is new (it used to repeat the title word for word).
    expect(h.match(/Paused while you have the controls/g)).toHaveLength(1);
    expect(h).toContain("Return them when you&#x27;re done.");
    expect(h).toContain("Return the controls");
    expect(h).not.toContain("Take over");
    expect(h).not.toMatch(/wait until|hand it back/);
    expect(h).not.toContain("Needs you at the computer");
    expect(h.match(/Return the controls/g)).toHaveLength(1);
  });

  test("the other founder: told it carries on when handed back, with nothing to press", () => {
    const h = html(blockedRun({ kind: "needs-takeover", held: "other", recovery: "Usman has the controls. The job carries on when they hand them back." }));
    expect(h).toContain("Usman has the controls. The job carries on when they hand them back.");
    expect(h).not.toContain("Return the controls");
    expect(h).not.toContain("Take over");
  });

  test("an older entry with no `held` keeps the old behaviour", () => {
    expect(html(blockedRun({ kind: "needs-takeover", recovery: "Return control to the agent." }))).toContain("Needs you at the computer");
  });
});

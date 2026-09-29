import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisEvents } from "./jarvis-events";
import { createJarvisProtocols, jarvisIntent, nextSydneyMorning } from "./jarvis-protocols";
import { buildStatus, type StatusSources } from "./jarvis-status";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-protocols-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle briefly */ }
  }
});

// 24 Sep 2026, 9:00 am Sydney.
const NOW = Date.parse("2026-09-23T23:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function sources(overrides: Partial<StatusSources> = {}): StatusSources {
  return {
    calendar: () => ({ events: [{ title: "Kickoff with Mehroz", start: "2026-09-24T22:30:00Z" }], syncedAt: iso(NOW - 60_000), connected: true }),
    leads: async () => ({ today: { usman: { calls: 12, target: 20, followUpsDue: [{ name: "Harbour Dental", nextAt: iso(NOW) }] }, mehroz: { calls: 8, target: 20, followUpsDue: [] } } }),
    nextCall: async () => ({ id: 9, name: "Bright Smiles", vertical: "dental", status: "to_call", area: "Parramatta", phone: "02 9000 0000" }),
    approvals: () => 0,
    capabilities: () => ({ generatedAt: iso(NOW), capabilities: [] }),
    ...overrides,
  };
}
function setup(overrides: Partial<StatusSources> = {}, mission = true) {
  const dir = root();
  const events = createJarvisEvents(dir, { now: () => NOW });
  const protocols = createJarvisProtocols(dir, {
    status: () => buildStatus(sources(overrides), NOW),
    events,
    missionControl: () => mission,
    now: () => NOW,
  });
  return { dir, events, protocols };
}

describe("voice rules", () => {
  test.each([
    ["Status report.", { kind: "status" }],
    ["Jarvis, status", { kind: "status" }],
    ["What's next?", { kind: "status" }],
    ["How am I going?", { kind: "status" }],
    ["give me a status update please", { kind: "status" }],
    ["Start my day.", { kind: "protocol", name: "start-day" }],
    ["Hey Jarvis, let's start the day", { kind: "protocol", name: "start-day" }],
    ["Call mode", { kind: "protocol", name: "call-mode" }],
    ["Switch to call mode, please.", { kind: "protocol", name: "call-mode" }],
    ["End call mode", { kind: "protocol", name: "end-call-mode" }],
    ["call mode off", { kind: "protocol", name: "end-call-mode" }],
    ["Shutdown.", { kind: "protocol", name: "shutdown" }],
    ["End my day", { kind: "protocol", name: "shutdown" }],
  ])("%s", (utterance, expected) => expect(jarvisIntent(utterance)).toEqual(expected as any));

  test.each([
    "Shut down my PC",
    "shut down the computer",
    "What's next on my calendar tomorrow?",
    "call Mehroz",
    "call mode is annoying, why did you do that",
    "what's the status of the Vercel deploy",
    "start the day planner app",
    "",
  ])("not a Jarvis rule: %s", (utterance) => expect(jarvisIntent(utterance)).toBeNull());
});

describe("protocols", () => {
  test("start my day: opens Mission Control, speaks the status, surfaces the first call card", async () => {
    const { protocols } = setup();
    const run = await protocols.run({ name: "start-day" });
    expect(run.navigate).toBe("/dashboard");
    expect(run.card).toMatchObject({ name: "Bright Smiles" });
    expect(run.said).toStartWith("Good morning, sir. Next up: Kickoff with Mehroz, tomorrow at 8:30 am.");
    expect(run.said).toContain("First call on the list: Bright Smiles. The card is on screen; I won't dial.");
    expect(run.steps.map((s) => [s.id, s.state])).toEqual([["open", "pending"], ["status", "done"], ["first-call", "done"]]);
    // Without Mission Control switched on, the Dashboard.
    expect((await setup({}, false).protocols.run({ name: "start-day" })).navigate).toBe("/today");
  });

  test("call mode: opens Leads, holds interjections, shows the next lead, never dials", async () => {
    const { protocols, events } = setup();
    const run = await protocols.run({ name: "call-mode" });
    expect(run.navigate).toBe("/leads");
    expect(events.status().callMode).toBe(true);
    expect(run.card?.name).toBe("Bright Smiles");
    expect(run.said).toBe("Call mode on; I'll hold interjections. Next up: Bright Smiles in Parramatta. The number's on screen when you're ready; I won't dial.");
    expect(JSON.stringify(run)).not.toMatch(/tel:|dial(?:led|ing)\b/);
    const off = await protocols.run({ name: "end-call-mode" });
    expect(off.said).toBe("Call mode off. Interjections are back on.");
    expect(events.status().callMode).toBe(false);
  });

  test("shutdown: scorecard, outstanding follow-ups, tomorrow's first commitment, then quiet until 7 am", async () => {
    const { protocols, events } = setup();
    const run = await protocols.run({ name: "shutdown" });
    expect(run.said).toBe(
      "Today's scorecard: Usman 12 of 20 calls, Mehroz 8 of 20 calls. 1 follow-up still outstanding, starting with Harbour Dental. Tomorrow starts with Kickoff with Mehroz at 8:30 am. Quiet mode is on until 7 am. I haven't closed anything or powered off.",
    );
    expect(run.navigate).toBeNull();
    expect(events.status().quiet).toEqual({ on: true, until: "2026-09-24T21:00:00.000Z" });
    expect(run.ok).toBe(true);
  });

  test("a failing step is named, later steps are skipped, and the run is persisted", async () => {
    const { protocols, dir } = setup();
    const broken = createJarvisProtocols(dir, {
      status: async () => { throw new Error("CRM locked"); },
      events: { setCallMode: () => { throw new Error("state file is read-only"); }, setQuiet: () => ({}) as any },
      missionControl: () => true,
      now: () => NOW,
    });
    const run = await broken.run({ name: "call-mode" });
    expect(run.ok).toBe(false);
    expect(run.steps.map((s) => s.state)).toEqual(["failed", "skipped", "skipped"]);
    expect(run.navigate).toBeNull();
    expect(run.said).toBe('Call mode stopped at "Turn on call mode (interjections held)": state file is read-only.');
    const saved = JSON.parse(readFileSync(join(dir, ".operator-data", "jarvis-protocols.json"), "utf8"));
    expect(saved.runs.at(-1).id).toBe(run.id);
    // The browser reports its navigation step; the record completes.
    const ok = await protocols.run({ name: "start-day" });
    const done = protocols.report({ runId: ok.id, step: "open", ok: true, detail: "Opened Mission Control." });
    expect(done.finishedAt).not.toBeNull();
    expect(() => protocols.report({ runId: ok.id, step: "open", ok: true })).toThrow("isn't waiting");
    await expect(protocols.run({ name: "format-disk" })).rejects.toThrow("Choose a protocol");
  });

  test("an unavailable status is said plainly in start my day", async () => {
    const { protocols } = setup({ leads: async () => { throw new Error("down"); }, calendar: () => ({ events: [], syncedAt: null, connected: false }) });
    const run = await protocols.run({ name: "start-day" });
    expect(run.said).toContain("I can't read your calendar right now");
    expect(run.said).toContain("The CRM isn't answering");
    expect(run.said).not.toMatch(/all clear/i);
  });

  test("next Sydney 7 am", () => {
    expect(nextSydneyMorning(Date.parse("2026-09-24T12:00:00Z"))).toBe("2026-09-24T21:00:00.000Z"); // 10 pm → 7 am
    expect(nextSydneyMorning(Date.parse("2026-09-23T17:00:00Z"))).toBe("2026-09-23T21:00:00.000Z"); // 3 am → 7 am same day
  });
});

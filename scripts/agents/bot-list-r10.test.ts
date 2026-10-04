// Round 10: the agents a decision may choose from (the Jev controller's finite options for "research these companies"). Real bot store via the rig.
import { afterEach, describe, expect, test } from "bun:test";
import { makeRig, usman, type Rig } from "./test-rig";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

const jev = { op: "bot.research", confidence: 0.91, policy: "delegate", decidedBy: "jev" as const, ms: 212, requestId: "req-r10-0001", model: "typesafe/jev", options: ["bot.research", "bot.builder", "coding"], cached: false };

describe("the decision's lane and record reach the bot's task (round 10)", () => {
  test("lane 'computer': words that would read as coding still run on the bot's computer; the task row says who decided", async () => {
    const r = await makeRig();
    rigs.push(r);
    const res = await r.botCommands.run({ principal: usman, bot: "builder", utterance: "fix the opening hours component", source: "typed", lane: "computer", decision: jev });
    expect(res?.ok).toBe(true);
    expect(r.codingCalls).toHaveLength(0);
    expect(r.started.map((s) => s.computer)).toEqual(["builder"]);
    const tasks = await r.agents.service.tasks("builder", "usman");
    expect(tasks!.tasks.find((t) => t.id === res!.jobId)!.decision).toEqual({ decidedBy: "jev", op: "bot.research", confidence: 0.91, ms: 212, requestId: "req-r10-0001", model: "typesafe/jev", options: ["bot.research", "bot.builder", "coding"], cached: false });
  });

  test("lane 'coding': the coding harness is asked even for words its detector would not match; a bot without coding refuses, never a computer task", async () => {
    const r = await makeRig();
    rigs.push(r);
    r.setCodingReply(() => ({ say: "Draft ready. Start it?" }));
    const res = await r.botCommands.run({ principal: usman, bot: "builder", utterance: "make the footer year current in muv-marketing", source: "typed", lane: "coding", decision: jev });
    expect(res?.said).toBe("Draft ready. Start it?");
    expect(r.codingCalls).toHaveLength(1);
    expect(r.started).toHaveLength(0);
    const research = await r.botCommands.run({ principal: usman, bot: "research", utterance: "make the footer year current", source: "typed", lane: "coding" });
    expect(research).toMatchObject({ ok: false });
    expect(research!.said).toMatch(/doesn't take coding jobs/);
    expect(r.started).toHaveLength(0);
  });

  test("no decision recorded: the task row has no decision (nothing invented)", async () => {
    const r = await makeRig();
    rigs.push(r);
    const res = await r.botCommands.run({ principal: usman, bot: "research", utterance: "find the opening hours of Westmead Hospital", source: "typed" });
    const tasks = await r.agents.service.tasks("research", "usman");
    expect(tasks!.tasks.find((t) => t.id === res!.jobId)!.decision).toBeUndefined();
  });
});

describe("botCommands.list", () => {
  test("every bot that takes requests, with its id, name and a one-line purpose from its own instructions; an archived bot is never offered", async () => {
    const r = await makeRig();
    rigs.push(r);
    const list = r.botCommands.list();
    expect(list.map((b) => b.id).sort()).toEqual(r.agents.store.list().filter((b) => !b.archived).map((b) => b.id).sort());
    for (const b of list) {
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.purpose.length).toBeGreaterThan(0);
      expect(b.purpose.length).toBeLessThanOrEqual(80);
    }
    const research = r.agents.store.get("research")!;
    r.agents.store.patch("research", research.rev, (b) => ({ ...b, archived: true }));
    expect(r.botCommands.list().some((b) => b.id === "research")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { ProgressStep } from "../devices/dispatch";
import type { CommandDone, JarvisEntry } from "../jev-command";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { createRunLog } from "../screen-hands/run-log";
import { createScreenGoalExecutor, progressOf, resultOf, type ScreenGoalDeps } from "./screen-goal";

// SYNTHETIC: a fake Jarvis entry and fake screen hands writing the REAL run log. No Jev, no window, no browser.

function rig(handle: (utterance: string, signal: AbortSignal, log: ReturnType<ReturnType<typeof createRunLog>["start"]>, say: (stage: any, text: string, verified?: boolean) => void) => Promise<Partial<CommandDone>>) {
  const runs = createRunLog();
  const ledger = new SpokenConfirmationLedger();
  const seen: { entry: any[]; act: any[] } = { entry: [], act: [] };
  let actResult: any = { ok: true, said: "Pressed Send.", steps: 1, ms: 1, stepMs: [] };
  const entry = {
    handle: async (req: any, signal: AbortSignal) => {
      seen.entry.push(req);
      const log = runs.start({ request: req.utterance, source: "command", jobId: req.jobId });
      const say = (stage: any, text: string, verified?: boolean) => log.step({ stage, text, ...(verified !== undefined ? { verified } : {}) });
      const r = await handle(req.utterance, signal, log, say);
      log.end({ ok: !!r.ok, said: String(r.said ?? "") });
      return { type: "done", runId: log.id, kind: "screen", ...r } as CommandDone;
    },
  } as unknown as JarvisEntry;
  const screen = {
    runs,
    act: async (req: any, signal: AbortSignal, _e: any, log: any) => {
      seen.act.push({ ...req, redeemable: !!ledger.redeem(req.spokenYes, {}) });
      log?.step({ stage: "act", text: "pressed the control", verified: true });
      log?.end({ ok: true, said: "x" });
      void signal;
      return actResult;
    },
  } as never;
  const deps: ScreenGoalDeps = { entry: () => entry, screen: () => screen, ledger, thisPc: "usman-pc" };
  const steps: ProgressStep[] = [];
  const run = (args: any, signal = new AbortController().signal) => createScreenGoalExecutor(deps, "usman")(args, { signal, owner: "usman", progress: (s) => steps.push(s) });
  return { run, steps, seen, ledger, setAct: (v: any) => (actResult = v) };
}

describe("screen.goal runs the Jarvis entry on this PC and streams its sub-steps", () => {
  test("the utterance goes to the entry with this PC as target; each sub-step arrives in order with its outcome and check", async () => {
    const r = rig(async (_u, _s, _l, say) => {
      say("route", "Jev: browser.youtube 93% (confident)");
      say("act", "opened youtube.com");
      say("check", "the page title is YouTube", true);
      say("act", "typed the search, pressed Enter");
      say("check", "results for Sydney weather are showing", true);
      return { ok: true, said: "Searched YouTube for Sydney weather.", kind: "browser" };
    });
    const res = await r.run({ goal: "open a new Chrome tab and go to youtube.com then search for Sydney weather" });
    expect(r.seen.entry[0]).toMatchObject({ utterance: expect.stringContaining("youtube.com"), source: "command", target: { deviceId: "usman-pc", owner: "usman" }, surface: "typed" });
    expect(r.seen.entry[0].jobId).toMatch(/^screen-goal-/);
    expect(r.steps.map((s) => `${s.outcome}:${s.intent.split(":")[0]}`)).toEqual(["note:route", "ok:act", "ok:check", "ok:act", "ok:check"]);
    expect(r.steps.filter((s) => s.verification).map((s) => s.verification!.ok)).toEqual([true, true]);
    expect(res).toMatchObject({ ok: true, verified: true, said: "Searched YouTube for Sydney weather." });
    expect(res.evidence).toContain("2 checked steps passed");
    expect(res.evidence).toContain("Sydney weather are showing");
  });
  test("a finished goal with no passing check is NOT verified (ok but unconfirmed)", async () => {
    const r = rig(async () => ({ ok: true, said: "Done.", kind: "browser" }));
    expect(await r.run({ goal: "do something" })).toMatchObject({ ok: true, verified: null });
  });
  test("a failed check means not verified", async () => {
    const r = rig(async (_u, _s, _l, say) => {
      say("check", "that didn't change the page", false);
      return { ok: false, said: "I couldn't confirm it.", kind: "screen", outcome: "unverified" };
    });
    expect(await r.run({ goal: "click the thing" })).toMatchObject({ ok: false, verified: false, data: { outcome: "unverified" } });
  });
  test("a cancel stops the goal: later sub-steps never run, the result says stopped", async () => {
    const ran: string[] = [];
    const r = rig(async (_u, signal, _l, say) => {
      say("act", "step one");
      ran.push("one");
      await new Promise<void>((res) => (signal.aborted ? res() : signal.addEventListener("abort", () => res(), { once: true })));
      if (signal.aborted) return { ok: false, said: "Stopped.", kind: "screen", stopped: true };
      ran.push("two");
      return { ok: true, said: "x", kind: "screen" };
    });
    const c = new AbortController();
    const p = r.run({ goal: "a long goal" }, c.signal);
    await new Promise((res) => setTimeout(res, 20));
    c.abort();
    const res = await p;
    expect(ran).toEqual(["one"]);
    expect(res).toMatchObject({ ok: false, verified: false, data: { stopped: true, cancelled: true } });
  });
  test("already cancelled: the entry is never called", async () => {
    const r = rig(async () => ({ ok: true, said: "x" }));
    const c = new AbortController();
    c.abort();
    expect(await r.run({ goal: "x" }, c.signal)).toMatchObject({ ok: false, data: { cancelled: true } });
    expect(r.seen.entry).toEqual([]);
  });
  test("a refusal in code comes back as a refusal, not a success", async () => {
    const r = rig(async () => ({ ok: false, said: "I don't do banking.", kind: "refused", refused: true }));
    expect(await r.run({ goal: "pay the bill" })).toMatchObject({ ok: false, data: { refused: true } });
  });
  test("the entry throwing is an honest failure", async () => {
    const r = rig(async () => {
      throw new Error("boom");
    });
    expect(await r.run({ goal: "x" })).toMatchObject({ ok: false, verified: false, said: expect.stringContaining("boom") });
  });
  test("an empty goal is refused", async () => {
    const r = rig(async () => ({ ok: true, said: "x" }));
    expect(await r.run({ goal: "   " })).toMatchObject({ ok: false, data: { refused: true } });
  });
});

describe("a question back (awaiting approval) and its resume on the same device", () => {
  const asking = async (_u: string, _s: AbortSignal, _l: any, say: any) => {
    say("act", "filled the message");
    say("ask", "Shall I press Send?");
    return { ok: false, said: "Shall I press Send?", kind: "screen", ask: true, confirm: "Send", resumeGoal: "write the note and send it" } as Partial<CommandDone>;
  };
  test("the question is data for the hub, not a failure and not a success", async () => {
    const r = rig(asking);
    const res = await r.run({ goal: "write the note and send it" });
    expect(res).toMatchObject({ ok: false, verified: null, data: { ask: true, confirm: "Send", resumeGoal: "write the note and send it" } });
    expect(r.steps.map((s) => s.outcome)).toContain("asked");
  });
  test("a hub-approved yes is recorded on THIS PC's ledger and re-runs the screen gate with it; the gate redeems exactly that event", async () => {
    const r = rig(asking);
    const res = await r.run({ resume: { goal: "write the note and send it", confirm: "Send" }, yes: true });
    expect(r.seen.act).toHaveLength(1);
    expect(r.seen.act[0]).toMatchObject({ goal: "write the note and send it", confirm: "Send", requireSpokenYes: true, jev: true, source: "command", redeemable: true });
    expect(r.seen.entry).toEqual([]); // the entry (and its routing) is not asked again: nothing earlier is replayed
    expect(res).toMatchObject({ ok: true, said: "Pressed Send." });
    expect(r.steps.map((s) => s.outcome)).toContain("ok");
  });
  test("without the hub's yes flag, or without knowing what was asked, nothing is pressed", async () => {
    const r = rig(asking);
    expect(await r.run({ resume: { goal: "g", confirm: "Send" } })).toMatchObject({ ok: false, data: { refused: true } });
    expect(await r.run({ resume: { goal: "g", confirm: "" }, yes: true })).toMatchObject({ ok: false, data: { refused: true } });
    expect(r.seen.act).toEqual([]);
  });
  test("the gate asking again (the page changed) comes back as a question again", async () => {
    const r = rig(asking);
    r.setAct({ ok: false, said: "I still need your spoken yes.", steps: 0, ms: 0, stepMs: [], ask: true, confirm: "Send" });
    expect(await r.run({ resume: { goal: "g", confirm: "Send" }, yes: true })).toMatchObject({ ok: false, verified: null, data: { ask: true, confirm: "Send" } });
  });
});

describe("pure mappers", () => {
  test("progressOf: stages map to outcomes; a verified flag becomes a verification", () => {
    const run = { executor: "uia" as const, window: "Notepad" };
    expect(progressOf(run, { seq: 1, at: 0, stage: "check", text: "ok", verified: true })).toMatchObject({ outcome: "ok", target: "Notepad", verification: { ok: true } });
    expect(progressOf(run, { seq: 1, at: 0, stage: "check", text: "no", verified: false }).outcome).toBe("failed");
    expect(progressOf(run, { seq: 1, at: 0, stage: "refused", text: "x" }).outcome).toBe("refused");
    expect(progressOf(run, { seq: 1, at: 0, stage: "ask", text: "x" }).outcome).toBe("asked");
    expect(progressOf(run, { seq: 1, at: 0, stage: "route", text: "x", jev: { op: "screen.act", confidence: 0.9, policy: "act", ms: 40, inputTokens: 1, outputTokens: 1 } })).toMatchObject({ outcome: "note", ms: 40, action: "jev screen.act 90%" });
  });
  test("resultOf: stopped is never verified; an outcome is never ok", () => {
    expect(resultOf({ ok: false, said: "Stopped.", kind: "screen", runId: "r", stopped: true }, { passed: 0, failed: 0 }, "g")).toMatchObject({ ok: false, verified: false });
    expect(resultOf({ ok: true, said: "x", kind: "screen", runId: "r", outcome: "no_progress" }, { passed: 1, failed: 0 }, "g").ok).toBe(false);
  });
});

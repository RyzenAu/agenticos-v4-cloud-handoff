// The evaluators must judge OBSERVED state: each one passes a realistic observation and FAILS the same observation when an
// agent's "done" is all there is. Synthetic only.
import { describe, expect, test } from "bun:test";
import * as E from "./evaluators";
import { makeFixtures } from "./fixtures";
import { statusOf } from "./tasks";
import type { ProbeResult } from "./types";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const allOk = (c: { ok: boolean }[]) => c.every((x) => x.ok);
const failed = (c: { ok: boolean; name: string }[]) => c.filter((x) => !x.ok).map((x) => x.name);

/** A realistic journey record (the shapes scripts/computers/journey.ts writes). */
const journey = (): E.Evidence => [
  { step: "both computers busy at once", data: [{ name: "research", state: "busy", controller: { kind: "agent", who: "researcher", jobId: "j1" }, assigned: { agent: "researcher", by: "usman" } }, { name: "builder", state: "busy", controller: { kind: "agent", who: "builder-agent", jobId: "j2" }, assigned: { agent: "builder-agent", by: "usman" } }] },
  { step: "concurrent jobs finished", data: { wallMs: 6103, research: { state: "succeeded" }, builder: { state: "succeeded" } } },
  { step: "each computer wrote its own file (same name, separate working folders)", data: ["research: research notes", "builder: builder notes"] },
  { step: "isolated per-computer folders and processes (inside WSL)", data: ["research: display=101 workdir=/h/research/work pid=4063 sid=4063", "builder: display=102 workdir=/h/builder/work pid=4195 sid=4195"] },
  { step: "takeover requested mid-step", data: { status: 200, state: "pending" } },
  { step: "person acted while holding the lease", data: { status: 200, said: "Wrote human.txt (39 bytes) and read it back." } },
  { step: "the files at this moment (the agent's later steps have not run)", data: ["findings.txt", "human.txt"] },
  { step: "lease timeline", data: [{ controller: "agent:researcher", paused: null }, { controller: "agent:researcher", paused: null }, { controller: "person:usman", paused: "researcher" }] },
  { step: "returned to agent", data: { status: 200, resumedJob: "the same job" } },
  { step: "job after return", data: { state: "succeeded", note: "Done on research: 3 steps, each checked.", steps: ["ok wait: step 1 wait: Waited 7000 ms.", "note : paused before step 2 (file.write): usman is taking control", "note : control returned to the agent; re-reading the computer before step 2", "ok computer.info: refreshed state after the handover: research: headless", "ok file.write: step 2 file.write: Wrote after-return-1.txt", "ok file.write: step 3 file.write: Wrote after-return-2.txt"] } },
  { step: "files after the agent resumed", data: ["after-return-1.txt", "after-return-2.txt", "findings.txt", "human.txt"] },
  { step: "stop", data: { state: "cancelled", afterMs: 13, steps: ["cancelled: step 1 wait: Cancelled.", "skipped: step 2 file.write not run: it was stopped first"], neverWritten: true, computer: "online" } },
  { step: "crashed job and recovery", data: { jobState: "unknown", laterStepRan: false, sameDevice: true, recoveries: 1, ledgerBefore: ['4 "state":"done"', '1 "state":"running"'], ledgerAfter: ['4 "state":"done"', '1 "state":"interrupted"'] } },
  { step: "the recovered computer takes work again", data: { state: "succeeded" } },
];
const mutate = (ev: E.Evidence, step: string, fn: (d: any) => any): E.Evidence => ev.map((e) => (e.step === step ? { ...e, data: fn(structuredClone(e.data)) } : e));

describe("the computers evaluators read the observed state", () => {
  test("a real-shaped journey passes every evaluator", () => {
    for (const f of [E.independentBots, E.sessionsStayAssigned, E.takeoverBlocksAgent, E.returnResumesFresh, E.cancelStopsLater, E.interruptedNotReplayed]) expect(failed(f(journey()))).toEqual([]);
  });
  test("two bots: one computer idle, or serial runs, or the same file text, fails", () => {
    expect(allOk(E.independentBots(mutate(journey(), "both computers busy at once", (d) => { d[1].state = "online"; return d; })))).toBe(false);
    expect(allOk(E.independentBots(mutate(journey(), "concurrent jobs finished", (d) => ({ ...d, wallMs: 12100 }))))).toBe(false);
    expect(allOk(E.independentBots(mutate(journey(), "each computer wrote its own file (same name, separate working folders)", () => ["research: notes", "builder: notes"])))).toBe(false);
    expect(allOk(E.independentBots(mutate(journey(), "isolated per-computer folders and processes (inside WSL)", (d) => [d[0], d[0].replace("research", "builder")])))).toBe(false);
  });
  test("takeover: the agent's later files existing while the person held control fails, however the job summary reads", () => {
    const bad = mutate(journey(), "the files at this moment (the agent's later steps have not run)", () => ["findings.txt", "human.txt", "after-return-1.txt"]);
    expect(failed(E.takeoverBlocksAgent(bad))).toEqual(["while the person held control, the agent's later files did not exist and the person's file did"]);
    expect(allOk(E.takeoverBlocksAgent(mutate(journey(), "takeover requested mid-step", () => ({ status: 200, state: "taken" }))))).toBe(false);
  });
  test("return: no fresh read before the next step, or step 1 run twice, fails", () => {
    const noFresh = mutate(journey(), "job after return", (d) => ({ ...d, steps: d.steps.filter((s: string) => !/refreshed state/.test(s)) }));
    expect(allOk(E.returnResumesFresh(noFresh))).toBe(false);
    const twice = mutate(journey(), "job after return", (d) => ({ ...d, steps: [...d.steps, "ok wait: step 1 wait: Waited 7000 ms."] }));
    expect(allOk(E.returnResumesFresh(twice))).toBe(false);
  });
  test("cancel: a later file that exists after the stop fails; a 'cancelled' state alone isn't enough", () => {
    expect(allOk(E.cancelStopsLater(mutate(journey(), "stop", (d) => ({ ...d, neverWritten: false }))))).toBe(false);
    expect(allOk(E.cancelStopsLater(mutate(journey(), "stop", (d) => ({ ...d, steps: ["cancelled: step 1"] }))))).toBe(false);
  });
  test("interrupted: a succeeded job, a later step that ran, or a ledger that shows a re-run fails", () => {
    expect(allOk(E.interruptedNotReplayed(mutate(journey(), "crashed job and recovery", (d) => ({ ...d, jobState: "succeeded" }))))).toBe(false);
    expect(allOk(E.interruptedNotReplayed(mutate(journey(), "crashed job and recovery", (d) => ({ ...d, laterStepRan: true }))))).toBe(false);
    expect(allOk(E.interruptedNotReplayed(mutate(journey(), "crashed job and recovery", (d) => ({ ...d, ledgerAfter: ['5 "state":"done"', '1 "state":"done"'] }))))).toBe(false);
  });
});

describe("the real local proof read back from the companion's own ledger", () => {
  const c1 = { jobState: "cancelled", companionLedger: ["observe.window:done"] };
  const c2 = { jobState: "cancelled", companionLedger: ["s1:echo:done", "s2:wait:cancelled"] };
  test("cancel and kill observations that match the ledger pass", () => {
    expect(failed(E.localCancelObserved(c1, c2))).toEqual([]);
    expect(failed(E.localKillObserved({ jobState: "failed", afterRestart: { ledger: ["s1:echo:done", "s2:wait:interrupted"], stepsRunAgain: 0 } }))).toEqual([]);
  });
  test("a job that SAYS cancelled but whose ledger shows the later steps ran fails", () => {
    expect(allOk(E.localCancelObserved({ jobState: "cancelled", companionLedger: ["observe.window:done", "wait:done", "echo:done"] }, c2))).toBe(false);
    expect(allOk(E.localCancelObserved(c1, { jobState: "cancelled", companionLedger: ["s1:echo:done", "s2:wait:done", "s3:echo:done"] }))).toBe(false);
  });
  test("a kill where the wait was re-delivered, or ends succeeded, fails", () => {
    expect(allOk(E.localKillObserved({ jobState: "succeeded", afterRestart: { ledger: ["s2:wait:interrupted"], stepsRunAgain: 0 } }))).toBe(false);
    expect(allOk(E.localKillObserved({ jobState: "failed", afterRestart: { ledger: ["s2:wait:interrupted"], stepsRunAgain: 1 } }))).toBe(false);
  });
});

describe("PowerPoint is judged by PowerPoint's own answer", () => {
  const want = { title: "SYNTHETIC M&U Acceptance Deck x", minSlides: 1 };
  test("found, at least one slide, exact title", () => {
    expect(allOk(E.powerPointUsable({ found: true, slideCount: 1, firstSlideTitle: want.title }, want))).toBe(true);
  });
  test("an executor that said ok but PowerPoint has no such presentation, no slides or another title fails", () => {
    expect(allOk(E.powerPointUsable({ found: false, slideCount: 0, firstSlideTitle: "" }, want))).toBe(false);
    expect(allOk(E.powerPointUsable({ found: true, slideCount: 0, firstSlideTitle: want.title }, want))).toBe(false);
    expect(allOk(E.powerPointUsable({ found: true, slideCount: 2, firstSlideTitle: "Presentation1" }, want))).toBe(false);
  });
});

describe("tests as an observation: a missing or failing test is a failure, not a skip", () => {
  const obs = (tests: { name: string; ok: boolean }[], exitCode = 0) => ({ tests, exitCode, file: "x.test.ts" });
  test("every required behaviour present and passing", () => {
    expect(allOk(E.testsObserved(obs([{ name: "a > does the thing", ok: true }]), [/does the thing/]))).toBe(true);
  });
  test("a required test that never ran, or a failing one, fails", () => {
    expect(allOk(E.testsObserved(obs([{ name: "a > other", ok: true }]), [/does the thing/]))).toBe(false);
    expect(allOk(E.testsObserved(obs([{ name: "a > does the thing", ok: false }], 1), [/does the thing/]))).toBe(false);
  });
});

describe("coding receipt and output", () => {
  const good = (): E.CodingObserved => ({
    receipts: [
      { role: "builder-1", account: "claude:max-2", requestedModel: "claude-sonnet-5-5", providerModel: "claude-sonnet-5-5", modelMismatch: false, cliVersion: "2.1.280", executionLocation: "this-pc", outcome: "succeeded" },
      { role: "reviewer", account: "claude:max-2", requestedModel: "claude-opus-5-5", providerModel: "claude-opus-5-5", modelMismatch: false, cliVersion: "2.1.280", executionLocation: "this-pc", outcome: "succeeded" },
    ],
    branchFileHasFarewell: true, branchCommits: 2, mainUntouched: true, headTests: { passed: 2, failed: 0 }, reviewVerdict: "approve", reviewSha: "abc", headSha: "abc",
  });
  test("a complete record passes", () => expect(failed(E.codingReceiptAndOutput(good()))).toEqual([]));
  test("receipts that look fine but no output in git, or a review of another sha, or the default account, fail", () => {
    expect(allOk(E.codingReceiptAndOutput({ ...good(), branchFileHasFarewell: false }))).toBe(false);
    expect(allOk(E.codingReceiptAndOutput({ ...good(), reviewSha: "old" }))).toBe(false);
    const d = good();
    d.receipts[0].account = "claude:max";
    expect(allOk(E.codingReceiptAndOutput(d))).toBe(false);
    const m = good();
    m.receipts[1].providerModel = "claude-haiku-4-5";
    expect(allOk(E.codingReceiptAndOutput(m))).toBe(false);
  });
});

describe("restart: jobs kept, nothing run twice", () => {
  const good = (): E.RestartObserved => ({ before: { jobs: ["a", "b"], finishedSteps: 2, executions: 3 }, after: { jobs: ["a", "b"], finishedSteps: 2, executions: 3, states: { a: "succeeded", b: "interrupted" } }, resumedAnything: false });
  test("kept, interrupted, unchanged counts", () => expect(failed(E.restartPreservesJobs(good()))).toEqual([]));
  test("a lost job, a job still 'running', or a second execution fails", () => {
    const lost = good(); lost.after.jobs = ["a"]; expect(allOk(E.restartPreservesJobs(lost))).toBe(false);
    const running = good(); running.after.states.b = "running"; expect(allOk(E.restartPreservesJobs(running))).toBe(false);
    const unknown = good(); unknown.after.states.b = "unknown"; expect(allOk(E.restartPreservesJobs(unknown))).toBe(true);
    const twice = good(); twice.after.executions = 4; expect(allOk(E.restartPreservesJobs(twice))).toBe(false);
  });
});

describe("the spoken compound command evaluator is ready (the run is owed: it needs the owner's microphone)", () => {
  const obs: E.SpokenObserved = { transcript: "open powerpoint make a blank deck and then open the coding page", heardByPipeline: true, jobSteps: [{ executor: "app.open", outcome: "ok" }, { executor: "deck.blank", outcome: "ok" }], ledger: ["app.open:done", "deck.blank:done"] };
  test("heard, in order, each once", () => expect(allOk(E.spokenCompound(obs, { executors: ["app.open", "deck.blank"] }))).toBe(true));
  test("typed text (no pipeline), a missing step, or a step twice fails", () => {
    expect(allOk(E.spokenCompound({ ...obs, heardByPipeline: false }, { executors: ["app.open", "deck.blank"] }))).toBe(false);
    expect(allOk(E.spokenCompound({ ...obs, jobSteps: [obs.jobSteps[0]] }, { executors: ["app.open", "deck.blank"] }))).toBe(false);
    expect(allOk(E.spokenCompound({ ...obs, ledger: [...obs.ledger, "deck.blank:done"] }, { executors: ["app.open", "deck.blank"] }))).toBe(false);
  });
});

describe("the status rule: a green line can't hide a blocked real run", () => {
  const p = (label: ProbeResult["label"], ok: boolean): ProbeResult => ({ label, freshness: "run-now", source: "t", checks: [{ name: "c", ok, observed: null }] });
  test("fail beats pass; synthetic-only is partial; real + synthetic is pass; none is blocked", () => {
    expect(statusOf([p("synthetic-integration", true), p("real-local-computer", false)]).status).toBe("fail");
    expect(statusOf([p("synthetic-integration", true)]).status).toBe("partial");
    expect(statusOf([p("synthetic-integration", true), p("real-local-computer", true)])).toMatchObject({ status: "pass", bestLabel: "real-local-computer" });
    expect(statusOf([]).status).toBe("blocked");
  });
  test("a property no real probe could observe stays unknown: at most partial, and the blocker names it", () => {
    const r = statusOf([p("synthetic-integration", true), p("real-local-computer", true)], { unobserved: "a real browser session per agent", blocker: "install the desktop" });
    expect(r.status).toBe("partial");
    expect(r.blocker).toBe("unknown: a real browser session per agent. install the desktop");
    // an unobserved property can't turn a failure into a partial
    expect(statusOf([p("real-local-computer", false)], { unobserved: "x" }).status).toBe("fail");
  });
});

describe("fixtures are synthetic and self-contained", () => {
  test("a fake lead, a client note and a deck title, all tagged, none real", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc-fx-"));
    try {
      const fx = makeFixtures(dir, "abc123");
      expect(fx.tag).toBe("SYNTHETIC-ACCEPT-abc123");
      expect(fx.lead.email.endsWith("@example.invalid")).toBe(true);
      expect(fx.lead.phone).toBe("+61 400 000 000");
      expect(JSON.parse(readFileSync(fx.files.lead, "utf8")).id).toBe(fx.lead.id);
      expect(readFileSync(fx.files.clientNote, "utf8")).toContain(fx.tag);
      expect(fx.deck.title).toContain("SYNTHETIC");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

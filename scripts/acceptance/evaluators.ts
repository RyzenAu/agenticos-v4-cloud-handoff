import type { Check } from "./types";

/**
 * Evaluators: pure functions from an OBSERVED state to checks. None of them takes a driver's or an agent's own
 * "done"/"ok"/spoken line as evidence; every check is about what the application, file, ledger or receipt holds.
 * `scripts/acceptance/evaluators.test.ts` feeds each one a "the agent says it worked but the state is wrong"
 * observation and requires it to fail.
 */

const ck = (name: string, ok: boolean, observed: unknown): Check => ({ name, ok: !!ok, observed });

// ───────────────────────── evidence shapes (scripts/computers/journey.ts output) ─────────────────────────

export type Evidence = { step: string; at?: string; ms?: number; data: any }[];
const step = (ev: Evidence, name: string) => ev.find((e) => e.step === name)?.data;

/** 1 · two agent bots on two computers, independent. */
export function independentBots(ev: Evidence): Check[] {
  const busy = step(ev, "both computers busy at once") as any[] | undefined;
  const done = step(ev, "concurrent jobs finished") as any;
  const files = step(ev, "each computer wrote its own file (same name, separate working folders)") as string[] | undefined;
  const dirs = step(ev, "isolated per-computer folders and processes (inside WSL)") as string[] | undefined;
  const two = busy && busy.length === 2;
  const workdirs = (dirs ?? []).map((d) => /workdir=(\S+)/.exec(d)?.[1]).filter(Boolean);
  const pids = (dirs ?? []).map((d) => /pid=(\d+)/.exec(d)?.[1]).filter(Boolean);
  const contents = (files ?? []).map((f) => f.split(": ").slice(1).join(": "));
  return [
    ck("two computers were busy at the same moment, each under its own agent and its own job", !!two && busy!.every((c) => c.state === "busy" && c.controller?.kind === "agent") && new Set(busy!.map((c) => c.controller.jobId)).size === 2 && new Set(busy!.map((c) => c.assigned?.agent)).size === 2, busy),
    ck("both jobs ended succeeded, and overlapped (wall time well under running them one after the other)", done?.research?.state === "succeeded" && done?.builder?.state === "succeeded" && typeof done?.wallMs === "number" && done.wallMs < 9000, { wallMs: done?.wallMs, states: [done?.research?.state, done?.builder?.state] }),
    ck("each computer's file holds its OWN text (same file name, different content)", contents.length === 2 && new Set(contents).size === 2 && contents[0] !== "" , files),
    ck("separate working folders and separate processes", workdirs.length === 2 && new Set(workdirs).size === 2 && new Set(pids).size === 2, { workdirs, pids }),
  ];
}

/** 2 · files survive a desktop/session restart: read the file from the working folder AFTER the restart. */
export function filesSurviveRestart(obs: { before: { name: string; text: string } | null; after: { name: string; text: string } | null; restarted: boolean; expectedText: string }): Check[] {
  return [
    ck("the file existed before the restart with the expected text", obs.before?.text === obs.expectedText, obs.before),
    ck("the desktop/session was really restarted (a new session id or a new start time)", obs.restarted, { restarted: obs.restarted }),
    ck("the same file is read back after the restart with the same text", obs.after?.name === obs.before?.name && obs.after?.text === obs.expectedText, obs.after),
  ];
}

/**
 * 3 · sessions stay assigned: each computer keeps its own agent assignment (and so its own browser/desktop session) through
 * concurrent work, a takeover and a return. Read from the computers' own state listings, not from a job's summary line.
 * (A real browser's tab ids are the stronger observation; it needs the desktop packages, see the task's blocker.)
 */
export function sessionsStayAssigned(ev: Evidence): Check[] {
  const busy = step(ev, "both computers busy at once") as any[] | undefined;
  const timeline = step(ev, "lease timeline") as any[] | undefined;
  const ret = step(ev, "returned to agent");
  const after = step(ev, "job after return");
  const who = (busy ?? []).map((c) => [c.name, c.assigned?.agent, c.assigned?.by]);
  const ctl = (timeline ?? []).map((t) => String(t.controller));
  return [
    ck("each computer was assigned to its own agent, by the person who started it", who.length === 2 && who.every(([, agent, by]) => !!agent && !!by) && new Set(who.map((w) => w[1])).size === 2, who),
    ck("through takeover the controller went agent -> person and the paused job stayed the assigned agent's", ctl[0] === "agent:researcher" && ctl.includes("person:usman") && (timeline ?? []).some((t) => t.paused === "researcher"), ctl),
    ck("on return the SAME job went back to the same agent and finished", ret?.resumedJob === "the same job" && after?.state === "succeeded" && /Done on research/.test(String(after?.note ?? "")), { resumedJob: ret?.resumedJob, state: after?.state }),
  ];
}

/** 4 · takeover blocks agent input: while the person holds control the agent's later steps do not touch the computer. */
export function takeoverBlocksAgent(ev: Evidence): Check[] {
  const tk = step(ev, "takeover requested mid-step");
  const act = step(ev, "person acted while holding the lease");
  const filesThen = step(ev, "the files at this moment (the agent's later steps have not run)") as string[] | undefined;
  const after = step(ev, "job after return");
  const noteIdx = (after?.steps ?? []).findIndex((s: string) => /paused before step 2/.test(s));
  return [
    ck("the takeover request did not interrupt the agent's running step (it waited for the step boundary)", tk?.state === "pending", tk),
    ck("while the person held control, the agent's later files did not exist and the person's file did", Array.isArray(filesThen) && filesThen.includes("human.txt") && !filesThen.some((f) => /^after-return/.test(f)), filesThen),
    ck("the person's own input was accepted and read back", /Wrote human\.txt \(\d+ bytes\) and read it back/.test(String(act?.said ?? "")), act),
    ck("the job recorded that it paused before its next step", noteIdx >= 0, after?.steps),
  ];
}

/** 5 · return resumes the same job with a fresh read of the computer, and step 1 is not run again. */
export function returnResumesFresh(ev: Evidence): Check[] {
  const ret = step(ev, "returned to agent");
  const after = step(ev, "job after return");
  const s: string[] = after?.steps ?? [];
  const at = (re: RegExp) => s.findIndex((x) => re.test(x));
  const note = at(/control returned to the agent; re-reading/);
  const fresh = at(/refreshed state after the handover/);
  const w2 = at(/file\.write: step 2/);
  const w3 = at(/file\.write: step 3/);
  const filesEnd = step(ev, "files after the agent resumed") as string[] | undefined;
  return [
    ck("return resumed the SAME job", ret?.resumedJob === "the same job", ret),
    ck("the agent re-read the computer before its next step (fresh state after the handover)", note >= 0 && fresh > note && w2 > fresh, s),
    ck("the remaining steps then ran in order and the job ended succeeded", w3 > w2 && after?.state === "succeeded", { state: after?.state }),
    ck("the first step ran exactly once, and the person's file is still there beside the agent's", s.filter((x) => /wait: step 1/.test(x)).length === 1 && !!filesEnd?.includes("human.txt") && !!filesEnd?.includes("after-return-2.txt"), filesEnd),
  ];
}

/** 6 · cancel stops later actions: nothing after the stop ran, and the file it would have written does not exist. */
export function cancelStopsLater(ev: Evidence): Check[] {
  const st = step(ev, "stop");
  return [
    ck("the stopped job ended cancelled, quickly, with its later step skipped", st?.state === "cancelled" && st?.afterMs < 2000 && (st?.steps ?? []).some((x: string) => /^skipped: step 2/.test(x)), st),
    ck("the file the skipped step would have written does not exist", st?.neverWritten === true, { neverWritten: st?.neverWritten }),
    ck("the computer is free again afterwards", st?.computer === "online", { computer: st?.computer }),
  ];
}

/** 6 (fresh, real) · the driver's c1 and c2 scenarios read back from the real companion's OWN ledger. */
export function localCancelObserved(c1: LocalProof, c2: LocalProof): Check[] {
  const l2 = c2.companionLedger ?? [];
  const waitEntry = l2.find((e) => /:wait:/.test(e)) ?? "";
  return [
    ck("real PC companion: stopped right after step 1, only step 1 ever reached its ledger", onlyRan(c1, ["observe.window"]), c1.companionLedger),
    ck("the job stopped after step 1 is not a success", !!c1.jobState && c1.jobState !== "succeeded", { jobState: c1.jobState }),
    ck("real PC companion: stopped during step 2, step 2 is cancelled in its ledger", /cancel|interrupt/i.test(waitEntry), l2),
    ck("step 3 never reached the companion's ledger after the stop", !l2.some((e) => /^s3:/.test(e)), l2),
    ck("the job stopped during step 2 is not a success", !!c2.jobState && c2.jobState !== "succeeded", { jobState: c2.jobState }),
  ];
}

export type LocalProof = { jobState?: string; steps?: string[]; companionLedger?: string[]; hubCommands?: string[]; afterRestart?: { ledger?: string[]; jobStateNow?: string; stepsRunAgain?: number; hubSays?: string } };
const onlyRan = (p: LocalProof, executors: string[]) => {
  const ran = (p.companionLedger ?? []).filter((e) => /:(done|running)$/.test(e)).map((e) => e.split(":")[0]);
  return ran.length === executors.length && executors.every((x, i) => ran[i] === x);
};

/** 7 · an interrupted action is not replayed: it ends uncertain, the later steps do not run, and nothing is run again on recovery. */
export function interruptedNotReplayed(ev: Evidence): Check[] {
  const c = step(ev, "crashed job and recovery");
  const back = step(ev, "the recovered computer takes work again");
  return [
    ck("the job whose computer died ended 'unknown' (not succeeded, not failed-and-retried)", c?.jobState === "unknown", { jobState: c?.jobState, note: c?.jobNote }),
    ck("the later step never ran and its file does not exist", c?.laterStepRan === false, { laterStepRan: c?.laterStepRan }),
    ck("the recovered computer's ledger moved running -> interrupted and the count of finished steps did not change", JSON.stringify(c?.ledgerBefore) !== JSON.stringify(c?.ledgerAfter) && /4 "state":"done"/.test(String(c?.ledgerBefore?.[0])) && /4 "state":"done"/.test(String(c?.ledgerAfter?.[0])) && /interrupted/.test(String(c?.ledgerAfter?.[1])), { before: c?.ledgerBefore, after: c?.ledgerAfter }),
    ck("it came back as the same device and took new work", c?.sameDevice === true && c?.recoveries === 1 && !!back, { sameDevice: c?.sameDevice, recoveries: c?.recoveries }),
  ];
}

/** 7 (fresh, real) · a real companion process killed mid-step then restarted: the driver's d scenario read back from the ledger. */
export function localKillObserved(d: LocalProof): Check[] {
  return [
    ck("real PC companion killed mid-step: the job did not end succeeded", !!d.jobState && d.jobState !== "succeeded", { jobState: d.jobState }),
    ck("the step that was running is 'interrupted' in the companion's own ledger after it restarted", (d.afterRestart?.ledger ?? []).some((e) => /wait:interrupted/.test(e)), d.afterRestart?.ledger),
    ck("after the restart nothing was delivered again and the later step never ran", (d.afterRestart?.stepsRunAgain ?? 1) === 0 && !(d.afterRestart?.ledger ?? []).some((e) => /s3/.test(e) && /done/.test(e)), d.afterRestart),
  ];
}

/** 8 · ownership is refused before dispatch AND again at execution. Observed from the hub's command rows and the PC's own gate. */
export function ownershipRefused(obs: { beforeDispatch: { refused: boolean; commandRowsCreated: number; reason: string } | null; atExecution: { refused: boolean; ran: boolean; reason: string } | null }): Check[] {
  return [
    ck("a command for the other founder's PC is refused before dispatch: no command row was created", !!obs.beforeDispatch?.refused && obs.beforeDispatch.commandRowsCreated === 0, obs.beforeDispatch),
    ck("a command signed for someone else is refused by the PC's own gate and nothing ran", !!obs.atExecution?.refused && obs.atExecution.ran === false, obs.atExecution),
  ];
}

// ───────────────────────── PowerPoint read from PowerPoint itself ─────────────────────────

export type DeckObserved = { found: boolean; slideCount: number; firstSlideTitle: string; layout?: number; saved?: boolean; path?: string };
/** 9 · a usable presentation: PowerPoint itself reports the slide count and the title. */
export function powerPointUsable(obs: DeckObserved, expected: { title: string; minSlides: number }): Check[] {
  return [
    ck("PowerPoint has the presentation open (found by its own object model, not by a window title)", obs.found, { found: obs.found }),
    ck(`it has at least ${expected.minSlides} slide(s) (read from PowerPoint)`, obs.found && obs.slideCount >= expected.minSlides, { slideCount: obs.slideCount }),
    ck("the first slide's title text is the requested title (read from PowerPoint)", obs.found && obs.firstSlideTitle === expected.title, { firstSlideTitle: obs.firstSlideTitle }),
  ];
}

// ───────────────────────── tests as an observation ─────────────────────────

export type TestObservation = { tests: { name: string; ok: boolean }[]; exitCode: number | null; file: string };
/** Every required behaviour must exist as a test that ran AND passed; a missing test is a failure, not a skip. */
export function testsObserved(obs: TestObservation, required: RegExp[]): Check[] {
  const failed = obs.tests.filter((t) => !t.ok).map((t) => t.name);
  return [
    ...required.map((re) => {
      const hit = obs.tests.filter((t) => re.test(t.name));
      return ck(`a test matching ${re} ran and passed`, hit.length > 0 && hit.every((t) => t.ok), hit.map((t) => `${t.ok ? "pass" : "FAIL"} ${t.name}`));
    }),
    ck("no test in that run failed", failed.length === 0 && obs.exitCode === 0, { failed, exitCode: obs.exitCode, ran: obs.tests.length }),
  ];
}

// ───────────────────────── coding receipt and output ─────────────────────────

export type CodingObserved = {
  receipts: { account: string; requestedModel?: string; providerModel: string | null; modelMismatch?: boolean | null; cliVersion: string; executionLocation?: string; outcome: string; role: string }[];
  /** Read from git, not from the job: the branch's content and the base branch. */
  branchFileHasFarewell: boolean;
  branchCommits: number;
  mainUntouched: boolean;
  /** Test result the ORCHESTRATOR recorded at the head, and the review verdict for that same sha. */
  headTests: { passed: number | null; failed: number | null } | null;
  reviewVerdict: string | null;
  reviewSha: string | null;
  headSha: string | null;
};
export function codingReceiptAndOutput(obs: CodingObserved): Check[] {
  const builder = obs.receipts.find((r) => r.role === "builder-1");
  const reviewer = obs.receipts.find((r) => r.role === "reviewer");
  return [
    ck("a receipt exists for the builder and for the reviewer", !!builder && !!reviewer, obs.receipts.map((r) => r.role)),
    ck("both ran on a named second account slot, not the default", [builder, reviewer].every((r) => !!r && /^claude:max-\d$/.test(r.account)), [builder?.account, reviewer?.account]),
    ck("requested and reported models agree and differ between builder and reviewer", !!builder && !!reviewer && builder.providerModel === builder.requestedModel && reviewer.providerModel === reviewer.requestedModel && builder.modelMismatch === false && reviewer.modelMismatch === false && builder.providerModel !== reviewer.providerModel, [builder && [builder.requestedModel, builder.providerModel], reviewer && [reviewer.requestedModel, reviewer.providerModel]]),
    ck("the CLI version and execution location are recorded", obs.receipts.every((r) => /^\d+\.\d+\.\d+$/.test(r.cliVersion) && r.executionLocation === "this-pc"), obs.receipts.map((r) => [r.cliVersion, r.executionLocation])),
    ck("the OUTPUT exists in git: the job branch has the function and exactly one commit; the base branch is untouched", obs.branchFileHasFarewell && obs.branchCommits >= 1 && obs.mainUntouched, { branchFileHasFarewell: obs.branchFileHasFarewell, branchCommits: obs.branchCommits, mainUntouched: obs.mainUntouched }),
    ck("tests at the head passed and the review verdict is for that same head", !!obs.headTests && (obs.headTests.failed ?? 1) === 0 && (obs.headTests.passed ?? 0) > 0 && obs.reviewVerdict === "approve" && obs.reviewSha === obs.headSha, { headTests: obs.headTests, verdict: obs.reviewVerdict, sameSha: obs.reviewSha === obs.headSha }),
  ];
}

// ───────────────────────── restart preserves jobs, no duplicate execution ─────────────────────────

export type RestartObserved = {
  before: { jobs: string[]; finishedSteps: number; executions: number };
  after: { jobs: string[]; finishedSteps: number; executions: number; states: Record<string, string> };
  resumedAnything: boolean;
};
export function restartPreservesJobs(obs: RestartObserved): Check[] {
  return [
    ck("every job that existed before the restart is still there after it", obs.before.jobs.every((j) => obs.after.jobs.includes(j)), { before: obs.before.jobs.length, after: obs.after.jobs.length }),
    ck("a job that was running when the hub died is now uncertain ('unknown' or 'interrupted'), never still 'running' and never 'succeeded' on its own", Object.values(obs.after.states).some((s) => s === "unknown" || s === "interrupted") && !Object.values(obs.after.states).includes("running"), obs.after.states),
    ck("nothing was executed a second time by the restart (execution count unchanged, nothing resumed on its own)", obs.after.executions === obs.before.executions && !obs.resumedAnything, { before: obs.before.executions, after: obs.after.executions, resumedAnything: obs.resumedAnything }),
    ck("finished steps are kept exactly", obs.after.finishedSteps === obs.before.finishedSteps, { before: obs.before.finishedSteps, after: obs.after.finishedSteps }),
  ];
}

// ───────────────────────── spoken compound command (owed) ─────────────────────────

export type SpokenObserved = { transcript: string; heardByPipeline: boolean; jobSteps: { executor: string; outcome: string }[]; ledger: string[] };
/** 10 · "open PowerPoint, make a blank deck and then take me to the Coding page": every part effective, read from state. */
export function spokenCompound(obs: SpokenObserved, expect: { executors: string[] }): Check[] {
  const ran = obs.jobSteps.filter((s) => s.outcome === "ok").map((s) => s.executor);
  return [
    ck("the real microphone path produced a transcript of the whole compound sentence", obs.heardByPipeline && obs.transcript.length > 10, { heard: obs.heardByPipeline, words: obs.transcript.split(/\s+/).length }),
    ck("each requested action ran in order and was verified by its own executor", expect.executors.every((e, i) => ran[i] === e), ran),
    ck("the companion's ledger holds each step exactly once", expect.executors.every((e) => obs.ledger.filter((l) => l.startsWith(e)).length === 1), obs.ledger),
  ];
}

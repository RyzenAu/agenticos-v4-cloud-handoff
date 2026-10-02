import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as E from "./evaluators";
import { closeDeckInPowerPoint, localProofFrom, parseProofLines, ps, readDeckFromPowerPoint, readEvidenceFile, rmScratch, ROOT, runBunTests, sleep, startLocalRig } from "./probes";
import { LABELS, type Check, type Ctx, type Label, type ProbeResult, type Status, type Task, type TaskConfig, type TaskResult } from "./types";

/** Where earlier REAL evidence lives (written by the drivers themselves); each is re-read and re-evaluated now. */
const JOURNEY = process.env.ACCEPT_JOURNEY_EVIDENCE ?? "D:\\prog-scratch\\journey\\evidence.json";
const PROOF_LOG = process.env.ACCEPT_LOCAL_PROOF_LOG ?? "D:\\agent-scratch\\prog-b\\evidence-run.log";
const CODING_JOB_DIR = process.env.ACCEPT_CODING_JOB_DIR ?? "D:\\prog-scratch\\job2";
const CODING_RESULT = join(ROOT, "docs", "programme-20261001", "coding-job-result.json");

const REAL: readonly Label[] = ["real-local-computer", "real-cloud-vm", "real-remote-device", "live-provider"];
const rank = (l: Label) => LABELS.indexOf(l);

/**
 * One rule for a task's status, so a green line can't hide a blocked real run:
 *  fail     any probe that ran found observed state wrong
 *  pass     all probes passed and a REAL-labelled probe is among them (what is still unproven goes in `blocker`)
 *  partial  only mocked/synthetic probes passed; `blocker` names what stops the real run
 *  blocked  no probe could run
 */
/**
 * `unobserved`: a property the task names that no real probe could observe here (lead rule, 1 Oct). It stays UNKNOWN, so
 * the task is at most PARTIAL however strong the other real evidence is, and the blocker says what is unknown.
 */
export function statusOf(probes: ProbeResult[], opts: { blocker?: string; unobserved?: string } = {}): { status: Status; bestLabel: Label | null; blocker?: string } {
  const ok = probes.filter((p) => p.checks.length && p.checks.every((c) => c.ok));
  const bad = probes.filter((p) => p.checks.some((c) => !c.ok));
  const best = ok.map((p) => p.label).sort((a, b) => rank(b) - rank(a))[0] ?? null;
  if (bad.length) return { status: "fail", bestLabel: best, blocker: opts.blocker };
  if (!ok.length) return { status: "blocked", bestLabel: null, blocker: opts.blocker };
  if (opts.unobserved) return { status: "partial", bestLabel: best, blocker: `unknown: ${opts.unobserved}. ${opts.blocker ?? ""}`.trim() };
  if (best && REAL.includes(best)) return { status: "pass", bestLabel: best, blocker: opts.blocker };
  return { status: "partial", bestLabel: best, blocker: opts.blocker };
}

const probe = (label: Label, source: string, checks: Check[], extra: Partial<ProbeResult> = {}): ProbeResult => ({ label, freshness: "run-now", source, checks, ...extra });
const testProbe = (file: string, pattern: string | undefined, required: RegExp[]): ProbeResult => probe("synthetic-integration", `bun test ${file}${pattern ? ` -t "${pattern}"` : ""}`, E.testsObserved(runBunTests(file, pattern), required));
const journeyProbe = (evaluate: (ev: E.Evidence) => Check[], source = "scripts/computers/journey.ts (real WSL computers on this PC)"): ProbeResult | null => {
  const j = readEvidenceFile(JOURNEY);
  if (!j) return null;
  return probe("real-local-computer", `${source}: ${JOURNEY}`, evaluate(j.evidence), { freshness: "earlier-evidence", evidenceAt: j.at });
};
const NO_JOURNEY = `the journey evidence file isn't here (${JOURNEY}); run scripts/computers/journey.ts against a cloud-role hub (docs/programme-20261001/COMPUTERS-EVIDENCE.md)`;
const NO_DESKTOP = "the WSL computers have no desktop (Xvfb, chromium, x11vnc, xdotool are missing and sudo needs the owner's password): run `sudo apt-get install -y --no-install-recommends xvfb chromium x11vnc xdotool fonts-liberation` in the distro, then re-run scripts/computers/journey.ts";
const NO_CLOUD_VM = "no real cloud VM exists yet (the shared computers are WSL on this PC); a cloud VM needs the owner's provider account";

const cfg = (c: TaskConfig): TaskConfig => c;

// ─────────────────────────────────────── the twelve tasks ───────────────────────────────────────

export const TASKS: Task[] = [
  {
    config: cfg({
      id: 1, key: "two-bots-independent", title: "Two bots work independently",
      instruction: "Start a research bot on one shared computer and a builder bot on another at the same time; each writes its own notes file.",
      setup: ["two computers provisioned with their own working folders (journey) or two synthetic computers (tests)"],
      evaluator: { reads: ["the computers' own state listing", "each computer's working folder", "the job store"], expects: ["two computers busy at once under two agents", "both jobs finished and overlapped", "each file holds its own computer's text"] },
      creates: ["computers named research and builder (journey)", "temp data dirs (tests)"],
    }),
    async run() {
      const probes: ProbeResult[] = [testProbe("scripts/computers/computers.test.ts", "two agents run concurrently", [/two jobs overlap in time/, /second job on a busy computer is refused/])];
      const j = journeyProbe(E.independentBots);
      if (j) probes.push(j);
      return { ...statusOf(probes, { blocker: j ? `not shown on a real cloud VM: ${NO_CLOUD_VM}` : NO_JOURNEY }), probes };
    },
  },
  {
    config: cfg({
      id: 2, key: "files-survive-restart", title: "Files survive a desktop restart",
      instruction: "Save the client note on a shared computer, restart its desktop, and open the note again.",
      setup: ["the synthetic client note as the file's content"],
      evaluator: { reads: ["the file in the computer's working folder before and after the restart"], expects: ["same name, same text, a real restart in between"] },
      creates: ["one synthetic computer with a temp working folder"],
    }),
    async run(ctx) {
      const probes: ProbeResult[] = [];
      // Synthetic integration with the real computer service, store and lease code: write, suspend (session gone), wake, read.
      const obs = await import("./synthetic-computers").then((m) => m.filesAcrossSuspend(ctx)).catch((e) => ({ error: String((e as Error).message) }));
      if ("error" in obs) return { status: "blocked", bestLabel: null, probes, blocker: `the synthetic computer probe couldn't run: ${obs.error}` };
      probes.push(probe("synthetic-integration", "scripts/acceptance/synthetic-computers.ts (real computer service + store; fake host)", E.filesSurviveRestart(obs)));
      return { ...statusOf(probes, { blocker: `a real desktop restart isn't observed: ${NO_DESKTOP}` }), probes };
    },
  },
  {
    config: cfg({
      id: 3, key: "sessions-stay-assigned", title: "Browser sessions stay assigned",
      instruction: "Give each bot its own computer and browser; keep them assigned through a takeover and a return.",
      setup: ["two computers with two agents (journey)"],
      evaluator: { reads: ["the computers' state listing (assigned agent, controller)", "the lease timeline"], expects: ["each computer keeps its own agent", "the paused job returns to the same agent"] },
      creates: [],
    }),
    async run() {
      const probes: ProbeResult[] = [testProbe("scripts/computers/computers.test.ts", "takeover and return", [/a person takes control mid-job/, /viewer that vanishes while an agent is paused gives the computer back to that same job/])];
      const j = journeyProbe(E.sessionsStayAssigned);
      if (j) probes.push(j);
      return { ...statusOf(probes, { unobserved: "a real browser session per agent (the real run observed computer and job assignment only, not browser tabs)", blocker: NO_DESKTOP }), probes };
    },
  },
  {
    config: cfg({
      id: 4, key: "takeover-blocks-agent", title: "Takeover blocks the agent's input",
      instruction: "Take over a computer while its bot is mid-task; type as the person; the bot must not act meanwhile.",
      setup: ["a job with a 7 s step then two file writes (journey)"],
      evaluator: { reads: ["the working folder's files at the moment of takeover"], expects: ["the agent's later files do not exist", "the person's file does", "the request didn't interrupt the running step"] },
      creates: [],
    }),
    async run() {
      const probes: ProbeResult[] = [testProbe("scripts/computers/lease.test.ts", undefined, [/the agent holds until it hands over; only then does the person hold/, /stale epoch is refused/]), testProbe("scripts/computers/computers.test.ts", "a program with no confirmed session cannot take a computer over", [/program with no confirmed session cannot take a computer over or send it input/])];
      const j = journeyProbe(E.takeoverBlocksAgent);
      if (j) probes.push(j);
      return { ...statusOf(probes, { blocker: `not shown on a real cloud VM: ${NO_CLOUD_VM}` }), probes };
    },
  },
  {
    config: cfg({
      id: 5, key: "return-resumes-fresh", title: "Return resumes with fresh state",
      instruction: "Give control back to the bot; it must re-read the computer before continuing the same job.",
      setup: ["as task 4"],
      evaluator: { reads: ["the job's own step log", "the working folder"], expects: ["same job", "a fresh read before the next step", "step 1 ran once"] },
      creates: [],
    }),
    async run() {
      const probes: ProbeResult[] = [testProbe("scripts/computers/computers.test.ts", "takeover and return", [/return resumes the same job after a fresh read/])];
      const j = journeyProbe(E.returnResumesFresh);
      if (j) probes.push(j);
      return { ...statusOf(probes, { blocker: `not shown on a real cloud VM: ${NO_CLOUD_VM}` }), probes };
    },
  },
  {
    config: cfg({
      id: 6, key: "cancel-stops-later", title: "Cancel stops later actions",
      instruction: "Stop a three-step job after its first step, and another while its second step runs.",
      setup: ["a real companion process paired to an isolated hub on this PC"],
      evaluator: { reads: ["the companion's own command ledger", "the job record"], expects: ["later steps never reach the ledger", "the stopped job is cancelled"] },
      creates: ["an isolated hub process and a companion process (stopped afterwards)", "a scratch folder"],
    }),
    async run(ctx) {
      const probes: ProbeResult[] = [testProbe("scripts/devices/companion-executors.test.ts", "cancel through submit", [/job's stop cancels the command on the companion and PowerPoint's run is killed/, /already-stopped job sends nothing/])];
      const j = journeyProbe((ev) => E.cancelStopsLater(ev));
      if (j) probes.push(j);
      const rig = await localRig(ctx);
      if ("error" in rig) return { ...statusOf(probes, { blocker: `the fresh real PC run couldn't start: ${rig.error}` }), probes };
      const c1 = localProofFrom(rig.run("c1").parsed);
      const c2 = localProofFrom(rig.run("c2").parsed);
      probes.push(probe("real-local-computer", "scripts/devices/real-local-proof.ts c1 and c2 against an isolated hub and a real companion", E.localCancelObserved(c1, c2)));
      return { ...statusOf(probes), probes };
    },
  },
  {
    config: cfg({
      id: 7, key: "interrupted-not-replayed", title: "An interrupted action is not replayed",
      instruction: "Kill the computer's companion in the middle of a step; bring it back.",
      setup: ["a real companion process paired to an isolated hub on this PC"],
      evaluator: { reads: ["the companion's ledger before and after", "the hub's command rows", "the job record"], expects: ["the job ends uncertain", "the ledger says interrupted", "nothing is delivered again"] },
      creates: ["as task 6"],
    }),
    async run(ctx) {
      const probes: ProbeResult[] = [testProbe("scripts/computers/computers.test.ts", "lifecycle and recovery", [/dead companion shows failed, recover restarts it with the same pairing, and the step that was in flight is not replayed/])];
      const j = journeyProbe((ev) => E.interruptedNotReplayed(ev));
      if (j) probes.push(j);
      const rig = await localRig(ctx);
      if ("error" in rig) return { ...statusOf(probes, { blocker: `the fresh real PC run couldn't start: ${rig.error}` }), probes };
      const d = localProofFrom(rig.run("d").parsed);
      probes.push(probe("real-local-computer", "scripts/devices/real-local-proof.ts d (real companion killed mid-step, restarted)", E.localKillObserved(d)));
      return { ...statusOf(probes), probes };
    },
  },
  {
    config: cfg({
      id: 8, key: "ownership-refused", title: "Ownership is refused before dispatch and at execution",
      instruction: "As Mehroz, send a command to Usman's PC; send a command signed for someone else straight to a PC.",
      setup: ["two synthetic people and two synthetic companions"],
      evaluator: { reads: ["the hub's command rows", "the PC's own gate and ledger"], expects: ["no command row for a refused target", "the PC's gate refuses a command signed for someone else and runs nothing"] },
      creates: [],
    }),
    async run() {
      const probes: ProbeResult[] = [
        testProbe("scripts/devices/target-contract.test.ts", "device ownership", [/not by name, id, spokenTarget, originDeviceId or a person's display name/, /companion's own gate refuses a command signed for someone else/]),
        testProbe("scripts/computers/computers.test.ts", "ownership", [/never reach the other founder's PC: refused BEFORE dispatch/, /command to a shared computer without a live lease is refused before it is queued/]),
        testProbe("scripts/devices/companion.test.ts", "local permission boundaries", [/non-allow-listed executors are refused on the PC even if the hub sends them/]),
      ];
      return { ...statusOf(probes, { blocker: "the other founder's real PC isn't here: a real remote-device run needs Mehroz to pair his own PC (docs/programme-20261001/worker-evidence.md, owners proof)" }), probes };
    },
  },
  {
    config: cfg({
      id: 9, key: "powerpoint-usable", title: "A usable PowerPoint presentation",
      instruction: "Open PowerPoint and make a new presentation titled with the sample deck title.",
      setup: ["the synthetic deck title"],
      evaluator: { reads: ["PowerPoint's own object model: slide count and the first slide's title text"], expects: ["found", ">= 1 slide", "title equals the requested title"] },
      creates: ["one unsaved presentation titled with the run tag (closed afterwards; nothing else is touched)"],
    }),
    async run(ctx) {
      const probes: ProbeResult[] = [];
      const r = await makeDeck(ctx);
      if ("error" in r) return { status: "blocked", bestLabel: null, probes, blocker: r.error };
      const obs = readDeckFromPowerPoint(ctx.fixtures.deck.title);
      probes.push(probe("real-local-computer", "the real deck.blank executor (PowerPoint COM), then PowerPoint read back independently", E.powerPointUsable(obs, { title: ctx.fixtures.deck.title, minSlides: 1 }), { notes: [`executor said: ${r.said}`] }));
      return { ...statusOf(probes), probes };
    },
  },
  {
    config: cfg({
      id: 10, key: "spoken-compound", title: "A spoken compound command",
      instruction: "Say: 'open PowerPoint, make a blank deck, and then open the Coding page.'",
      setup: ["the owner at the Jarvis page with his microphone"],
      evaluator: { reads: ["the job's own steps and the companion's ledger"], expects: ["the whole sentence was heard by the real pipeline", "each action ran in order, verified, once"] },
      creates: [],
    }),
    async run(ctx) {
      const given = process.env.ACCEPT_SPOKEN_OBSERVATION;
      if (given && existsSync(given)) {
        const obs = JSON.parse(readFileSync(given, "utf8")) as E.SpokenObserved;
        const probes = [probe("real-local-computer", `observation file ${given}`, E.spokenCompound(obs, { executors: ["app.open", "deck.blank"] }))];
        return { ...statusOf(probes), probes };
      }
      return { status: "owed", bestLabel: null, probes: [], blocker: "needs the owner's real microphone: say the sentence at the Jarvis page, then save that job's steps and the companion ledger as JSON ({transcript, heardByPipeline, jobSteps[{executor,outcome}], ledger[]}) and run with ACCEPT_SPOKEN_OBSERVATION=<file>. The evaluator (evaluators.ts: spokenCompound) is ready and unit-tested" };
    },
  },
  {
    config: cfg({
      id: 11, key: "coding-job-receipt", title: "A real coding job: receipt and output",
      instruction: "Have Sonnet build a small change and a different model review it, on the second Claude account.",
      setup: ["a throwaway git repo with a tiny function and a test (created by the earlier job)"],
      evaluator: { reads: ["the job receipts", "the throwaway repo in git (branch content, commit count, base branch)", "the recorded test result and review for the head sha"], expects: ["account/model/CLI/location recorded and agreeing", "the function exists on the job branch, the base branch untouched", "tests and review are for the same head"] },
      creates: [],
    }),
    async run() {
      const obs = readCodingObserved();
      if ("error" in obs) return { status: "blocked", bestLabel: null, probes: [], blocker: obs.error };
      const probes = [probe("live-provider", `job receipts (${CODING_RESULT}) and the repo in git (${CODING_JOB_DIR})`, E.codingReceiptAndOutput(obs), { freshness: "earlier-evidence", evidenceAt: statSync(CODING_RESULT).mtime.toISOString() })];
      return { ...statusOf(probes, { blocker: "no new paid job was run: the recorded job's receipts and its git output were re-read and re-evaluated" }), probes };
    },
  },
  {
    config: cfg({
      id: 12, key: "restart-preserves-jobs", title: "A restart preserves jobs without duplicate execution",
      instruction: "Restart the hub while a job's step is running on the companion; start it again.",
      setup: ["an isolated hub with a real job store and a real companion"],
      evaluator: { reads: ["the job store", "the companion's ledger"], expects: ["every job is still there", "a running job is 'interrupted', not running or succeeded", "nothing executed a second time"] },
      creates: ["as task 6"],
    }),
    async run(ctx) {
      const probes: ProbeResult[] = [
        testProbe("scripts/coding/orchestrator.test.ts", "restart and resume", [/a restart interrupts the build; nothing replays; an explicit resume continues the SAME native session/]),
        testProbe("scripts/devices/target-contract.test.ts", "no duplicate dispatch", [/same key from the same person while it runs is one command/, /finished one is reused within the window/]),
      ];
      const rig = await localRig(ctx);
      if ("error" in rig) return { ...statusOf(probes, { blocker: `the fresh real hub restart couldn't run: ${rig.error}` }), probes };
      const obs = await hubRestart(ctx, rig).catch((e) => ({ error: String((e as Error).message) }));
      if ("error" in obs) return { ...statusOf(probes, { blocker: `the hub restart probe failed to run: ${obs.error}` }), probes };
      probes.push(probe("real-local-computer", "an isolated hub process killed and started again on the same data, with a real companion", E.restartPreservesJobs(obs), { notes: ["Found by this probe on its first run: the isolated hub (scripts/devices/local-hub.ts) never ran the startup recovery the real OS runs (JobService.recover via scripts/jobs/runtime.ts), so a job killed mid-step stayed 'running' forever. Fixed there (it now recovers: running becomes unknown, never re-run); the real OS was not affected."] }));
      return { ...statusOf(probes), probes };
    },
  },
];

// ─────────────────────────────────────── shared probe helpers ───────────────────────────────────────

let rigPromise: Promise<Awaited<ReturnType<typeof startLocalRig>>> | null = null;
/** ONE isolated hub + real companion per acceptance run, shared by tasks 6, 7 and 12 and stopped at the end. */
function localRig(ctx: Ctx) {
  rigPromise ??= (async () => {
    const dir = join(ctx.scratch, "local-rig");
    const rig = await startLocalRig(dir, Number(process.env.ACCEPT_HUB_PORT ?? 8196));
    if (!("error" in rig)) ctx.onCleanup("isolated hub and its companion", () => rig.stop());
    return rig;
  })();
  return rigPromise;
}

async function makeDeck(ctx: Ctx): Promise<{ said: string } | { error: string }> {
  if (process.platform !== "win32") return { error: "PowerPoint needs Windows" };
  const reg = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE"], { encoding: "utf8", windowsHide: true });
  if (reg.status !== 0) return { error: "PowerPoint isn't installed on this PC" };
  const { deckBlankScript } = await import("../executors/windows");
  // Only what this run opened: its one presentation, and PowerPoint itself only if it wasn't already running and nothing else is open in it.
  const wasRunning = ps("if (Get-Process POWERPNT -ErrorAction SilentlyContinue) { '1' } else { '0' }") === "1";
  ctx.onCleanup("close the acceptance presentation (and PowerPoint, if this run started it and it is now empty)", () => {
    closeDeckInPowerPoint(ctx.fixtures.deck.title);
    if (!wasRunning) ps("try { $a = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application'); if ($a.Presentations.Count -eq 0) { $a.Quit() } } catch {}");
  });
  const out = ps(deckBlankScript(ctx.fixtures.deck.title), 120_000);
  return { said: out.slice(0, 160) };
}

function readCodingObserved(): E.CodingObserved | { error: string } {
  if (!existsSync(CODING_RESULT)) return { error: `the recorded job result isn't here (${CODING_RESULT})` };
  const repo = join(CODING_JOB_DIR, "canonical");
  if (!existsSync(join(repo, ".git"))) return { error: `the throwaway repo from the earlier job isn't here (${repo}); re-run scripts/coding/live-smoke.ts claude2 (one paid job)` };
  const res = JSON.parse(readFileSync(CODING_RESULT, "utf8"));
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const branch = git("for-each-ref", "--format=%(refname:short)", "refs/heads/coding/").split(/\r?\n/).filter((b) => !b.endsWith("-builder-1"))[0] ?? "";
  const base = git("merge-base", "main", branch);
  const last = res.receipts.map((r: any) => ({ account: r.account, requestedModel: r.requestedModel, providerModel: r.providerModel, modelMismatch: r.modelMismatch, cliVersion: r.cliVersion, executionLocation: r.executionLocation, outcome: r.outcome, role: r.role }));
  const headTest = (res.tests ?? []).at(-1);
  return {
    receipts: last,
    branchFileHasFarewell: /export const farewell/.test(git("show", `${branch}:src/greet.ts`)),
    branchCommits: Number(git("rev-list", "--count", `${base}..${branch}`)),
    mainUntouched: git("rev-parse", "main") === base && git("status", "--porcelain") === "",
    headTests: headTest ? { passed: headTest.counts.passed, failed: headTest.counts.failed } : null,
    reviewVerdict: res.review?.verdict ?? null,
    reviewSha: res.review?.sha ?? res.head ?? null,
    headSha: git("rev-parse", branch) || null,
  };
}

async function hubRestart(ctx: Ctx, rig: Exclude<Awaited<ReturnType<typeof startLocalRig>>, { error: string }>): Promise<E.RestartObserved> {
  // A job with one finished step and a long running one, then the hub is killed under it.
  const post = async (body: unknown) => {
    const res = await fetch(`${rig.hub}/__operator/screen/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    const events = text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return events;
  };
  const finished = await post({ utterance: `acceptance: a finished job ${ctx.fixtures.tag}`, source: "typed", steps: [{ executor: "echo", args: { text: ctx.fixtures.lead.business } }] });
  const doneJob = finished.find((e: any) => e.type === "done")?.jobId as string | undefined;
  let runningJob: string | null = null;
  // The hub is killed under this request on purpose: its dropped connection is expected, not an error.
  void post({ utterance: `acceptance: a running job ${ctx.fixtures.tag}`, source: "typed", steps: [{ executor: "echo", args: { text: "one" } }, { executor: "wait", args: { ms: 25_000 } }, { executor: "echo", args: { text: "three" } }] }).then((ev) => { runningJob = ev.find((e: any) => e.type === "job")?.jobId ?? null; }, () => undefined);
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && !(await rig.state()).commands?.some((c: any) => c.executor === "wait" && c.status === "delivered")) await sleep(200);
  const ids = [doneJob, ...((await rig.state()).commands ?? []).filter((c: any) => c.executor === "wait").map((c: any) => c.jobId)].filter(Boolean) as string[];
  const jobIds = [...new Set(ids)];
  const ledgerBefore = rig.ledger();
  const finishedBefore = ledgerBefore.filter((e) => e.state === "done").length;
  await rig.restartHub();
  await sleep(4000);
  const states: Record<string, string> = {};
  for (const id of jobIds) states[id] = (await rig.job(id))?.state ?? "missing";
  await sleep(3000);
  const ledgerAfter = rig.ledger();
  const delivered = (await rig.state()).commands?.filter((c: any) => c.status === "delivered" && c.executor === "wait").length ?? 0;
  void runningJob;
  return {
    before: { jobs: jobIds, finishedSteps: finishedBefore, executions: ledgerBefore.length },
    after: { jobs: Object.entries(states).filter(([, s]) => s !== "missing").map(([id]) => id), finishedSteps: ledgerAfter.filter((e) => e.state === "done").length, executions: ledgerAfter.length, states },
    resumedAnything: delivered > 1,
  };
}

// Re-exported so the runner can list the twelve configs without running anything.
export const CONFIGS = TASKS.map((t) => t.config);
export type { TaskResult };
export { parseProofLines, rmScratch };

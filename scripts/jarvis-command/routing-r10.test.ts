// Round 10: Jev/controller routing. SYNTHETIC throughout: a server-role hub (no hub device), a static device registry with synthetic
// companions, a fake dispatcher that records every executor call, a fake coding delegate and a scripted Jev. No real device, account,
// model or network. Each test failed on 2803f98c and passes with the round-10 changes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, stopOutcome } from "../jobs/service";
import { resolveTarget } from "../devices/route";
import { defaultHub, HUB_DEVICE_ID, staticRegistry } from "../devices/registry";
import type { CommandRequest, JarvisEntry } from "../jev-command";
import type { TargetDevice } from "../devices/types";
import type { CommandInput, DispatchResult } from "../devices/dispatch";
import type { Principal } from "../identity/principal";
import type { JevOutcome } from "../jev-client";
import { createCommandService, type CommandServiceDeps } from "./service";
import { commandIntent } from "./words";
import { exactQuery, googleSearchUrl, linkedSteps, planRules, splitSpokenTarget } from "./plan";
import { builderModelIn, resolvePin } from "../jev-pins";
import { ControllerCache, controllerQuestions, decideTask, jevOutageLine, validateDecision } from "../jev-controller";

const usman: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const pc: TargetDevice = { id: "usman-pc", owner: "usman", kind: "companion", label: "Usman's PC", aliases: ["pc"], primary: true };
const laptop: TargetDevice = { id: "usman-laptop", owner: "usman", kind: "companion", label: "Usman's laptop", aliases: ["laptop"] };
const PHRASE = "Zebra Kangaroo 4471 \"blue\" & co";

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Coding = NonNullable<NonNullable<CommandServiceDeps["delegates"]>["coding"]>;
function rig(opts: { role?: "server" | "pc"; devices?: TargetDevice[]; failStep?: number; coding?: Coding; codingMatches?: (u: string) => boolean; controller?: CommandServiceDeps["controller"]; pinCatalogue?: CommandServiceDeps["pinCatalogue"]; screenGoal?: boolean; bots?: CommandServiceDeps["bots"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "r10-route-"));
  dirs.push(dir);
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  closers.push(() => {
    try {
      jobs.close();
    } catch {
      /* running */
    }
  });
  const pcRole = opts.role === "pc";
  // PC role: the hub is Usman's own PC (a device); server role: the hub is not a device at all.
  const devices = opts.devices ?? (pcRole ? [defaultHub(), laptop] : [pc]);
  const entryCalls: CommandRequest[] = [];
  const entry = { handle: async (req: CommandRequest) => (entryCalls.push(req), { type: "done" as const, ok: true, said: "Done on this PC.", kind: "browser" as const, runId: "r1", verified: true }) } as unknown as JarvisEntry;
  const registry = staticRegistry(devices);
  for (const d of devices) registry.heartbeat(d.id);
  const calls: CommandInput[] = [];
  const dispatcher = {
    async submit(input: CommandInput, o?: { onQueued?: (id: string, deviceId: string) => void }): Promise<DispatchResult> {
      calls.push(input);
      const n = calls.length;
      const deviceId = String((input as { pinDeviceId?: string }).pinDeviceId ?? "?");
      o?.onQueued?.(`c${n}`, deviceId);
      if (opts.failStep === n) return { ok: true, local: false, deviceId, commandId: `c${n}`, result: { ok: false, said: "That page didn't open.", verified: false } };
      const what = String(input.args?.url ?? input.args?.name ?? input.executor);
      return { ok: true, local: false, deviceId, commandId: `c${n}`, result: { ok: true, said: `Opened ${what}.`, verified: true, evidence: "window title matched" } };
    },
  };
  const service = createCommandService({
    jobs: () => jobs,
    entry: () => (pcRole ? entry : null),
    hubDeviceId: pcRole ? HUB_DEVICE_ID : "", // server role: the hub is not a device
    resolveTarget: (ctx) => resolveTarget(ctx, registry),
    dispatcher,
    supports: (_id, executor) => (executor === "screen.goal" ? !!opts.screenGoal : true),
    deviceLabel: (id) => devices.find((d) => d.id === id)?.label ?? id,
    ...(opts.coding ? { delegates: { coding: opts.coding, ...(opts.codingMatches ? { codingMatches: opts.codingMatches } : {}) } } : {}),
    // A fresh decision cache per rig, so one test's Jev answer is never another's cached one.
    ...(opts.controller ? { controller: { cache: new ControllerCache(), ...opts.controller } } : {}),
    ...(opts.pinCatalogue ? { pinCatalogue: opts.pinCatalogue } : {}),
    ...(opts.bots ? { bots: opts.bots } : {}),
    dedupeMs: 0,
  });
  const run = (utterance: string, who: Principal = usman, source: "typed" | "voice" = "typed") => service.run({ principal: who, body: { utterance, source } });
  return { service, jobs, calls, run, entryCalls };
}

/** A coding delegate that records every call and drafts anything it is handed (an over-eager detector, on purpose). */
function greedyCoding() {
  const seen: Array<{ utterance: string; pin: unknown }> = [];
  const coding: Coding = async (utterance, turn) => {
    seen.push({ utterance, pin: turn.pin ?? null });
    return { say: `Draft ready: dental — ${utterance}`, jobId: `job-${seen.length}` };
  };
  return { coding, seen };
}

/** A scripted Jev: answers the controller's questions with this lane (and agent), recording each call's questions and state. */
function scriptedJev(laneOf: string | ((utterance: string) => string), confidence = 0.9, bot?: string) {
  const asked: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const decide = async (call: { state: unknown; questions: Record<string, unknown> }): Promise<JevOutcome> => {
    asked.push({ state: call.state, questions: call.questions });
    const lane = typeof laneOf === "string" ? laneOf : laneOf(String((call.state as { utterance?: string }).utterance ?? ""));
    return { ok: true, answers: { lane: { choice: lane, confidence }, ...(bot ? { bot: { choice: bot, confidence } } : {}), multi: { noul: 0.1 }, outbound: { noul: 0.02 } }, ms: 42, httpStatus: 200, attempts: 1, receipt: { requestId: "req-jev-0001", model: "typesafe/jev-latest", inputTokens: 300 } as never, raw: null };
  };
  return { decide: decide as never, asked };
}

describe("plan: exact Google searches and linked steps (acceptance #3, #4)", () => {
  test("\"Open Google and search for <phrase>\" is ONE exact step: the results page for exactly that phrase", () => {
    const r = planRules(`Open Google and search for ${PHRASE}`);
    expect(r).toMatchObject({ lane: "executor", executor: "open-url", op: "web.search" });
    const url = new URL(String((r as { args: { url: string } }).args.url));
    expect(url.hostname).toBe("www.google.com");
    expect(url.searchParams.get("q")).toBe(PHRASE);
    expect(planRules("search Google for 'kangaroo paws in Mount Druitt'")).toMatchObject({ args: { query: "kangaroo paws in Mount Druitt" } });
    expect(planRules("look up dentists near Parramatta on Google")).toMatchObject({ args: { query: "dentists near Parramatta" } });
    expect(exactQuery("Blue Widgets 9000.")).toBe("Blue Widgets 9000");
    expect(googleSearchUrl("a & b")).toBe("https://www.google.com/search?q=a%20%26%20b");
  });

  test("a compound request becomes ordered, linked exact steps; anything not exact plans nothing", () => {
    const steps = linkedSteps(`Open Google, search for ${PHRASE}, then open YouTube`);
    expect(steps?.map((s) => s.executor)).toEqual(["open-url", "open-url"]);
    expect(new URL(String(steps![0].args.url)).searchParams.get("q")).toBe(PHRASE);
    expect(steps![1].args.url).toBe("https://www.youtube.com/");
    expect(linkedSteps("open notepad then open YouTube")?.map((s) => s.executor)).toEqual(["app.open", "open-url"]);
    expect(linkedSteps("open YouTube and fill in the contact form")).toBeNull();
    expect(linkedSteps("open YouTube and click the first video")).toBeNull();
    // A conjunction inside quotes is data, not a new step.
    expect(linkedSteps("search Google for \"fish and chips then dessert\"")?.length).toBe(1);
  });

  test("spoken the same way, a compound or a search reaches the ONE command path", () => {
    expect(commandIntent(`Open Google and search for ${PHRASE}`)).not.toBeNull();
  });
});

describe("routine actions take the direct action path on the right device (acceptance #1, #3, #6)", () => {
  test("\"open YouTube on my PC\" runs open-url on his paired PC; the coding harness is never asked", async () => {
    const c = greedyCoding();
    const r = rig({ coding: c.coding });
    const done = await r.run("open YouTube on my PC");
    expect(done).toMatchObject({ ok: true, kind: "remote", targetDeviceId: "usman-pc" });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ executor: "open-url", args: { url: "https://www.youtube.com/" } });
    expect(c.seen).toHaveLength(0);
  });

  test("\"Open Google and search for <phrase>\" keeps the exact phrase and the target device", async () => {
    const c = greedyCoding();
    const r = rig({ coding: c.coding });
    const done = await r.run(`Open Google and search for ${PHRASE}`);
    expect(done.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect((r.calls[0] as { pinDeviceId?: string }).pinDeviceId).toBe("usman-pc");
    expect(new URL(String(r.calls[0].args?.url)).searchParams.get("q")).toBe(PHRASE);
    expect(c.seen).toHaveLength(0);
  });
});

describe("compound requests run as linked steps and report a partial failure truthfully (acceptance #4)", () => {
  test("all steps in order on the same device", async () => {
    const r = rig();
    const done = await r.run(`Open Google, search for ${PHRASE}, then open YouTube`);
    expect(done).toMatchObject({ ok: true, verified: true });
    expect(r.calls.map((c) => c.executor)).toEqual(["open-url", "open-url"]);
    expect(r.calls.every((c) => (c as { pinDeviceId?: string }).pinDeviceId === "usman-pc")).toBe(true);
    expect(r.calls.map((c) => c.stepId)).toEqual(["s1", "s2"]);
  });

  test("an induced failure at step 1 stops there: step 2 never runs and is recorded as not run", async () => {
    const r = rig({ failStep: 1 });
    const done = await r.run(`Open Google, search for ${PHRASE}, then open YouTube`);
    expect(done.ok).toBe(false);
    expect(done.said).toContain("Stopped at step 1 of 2");
    expect(r.calls).toHaveLength(1);
    expect(new URL(String(r.calls[0].args?.url)).searchParams.get("q")).toBe(PHRASE);
    expect(r.jobs.get(done.jobId!)!.steps.filter((s) => s.executor === "companion").map((s) => s.outcome)).toEqual(["failed", "skipped"]);
  });
});

describe("an ambiguous device gives one useful question and no action (acceptance #5)", () => {
  test("two of his devices online, none primary: which one, naming both; nothing dispatched", async () => {
    const r = rig({ devices: [{ ...pc, primary: false }, laptop] });
    const done = await r.run("open YouTube");
    expect(done).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(done.said).toBe("Which one: Usman's PC or Usman's laptop? Nothing has run yet.");
    expect(r.calls).toHaveLength(0);
  });
});

describe("explicit pins hold for the whole job; an unavailable one is refused honestly (acceptance #8, #9, #10)", () => {
  const catalogue = () => ({ claude: [{ slot: "claude:max", label: "Claude Max" }, { slot: "claude:max-2", label: "Claude Max 2" }], codex: [{ slot: "codex:openai-1", label: "Codex 1" }] });
  test("\"using Opus on Claude Max 2\" reaches the coding harness as a structured pin (saved on the job, never moved)", async () => {
    const c = greedyCoding();
    const r = rig({ coding: c.coding, pinCatalogue: catalogue });
    const done = await r.run("Fix the login bug in the dental site using Opus on Claude Max 2");
    expect(done.ok).toBe(true);
    expect(c.seen).toEqual([{ utterance: "Fix the login bug in the dental site using Opus on Claude Max 2", pin: { accountSlot: "claude:max-2", model: "claude-opus-5-5" } }]);
    expect(done.decision?.why).toContain("pinned");
  });

  test("an account this server doesn't have is refused by name with the ones it has; nothing is drafted or swapped", async () => {
    const c = greedyCoding();
    const r = rig({ coding: c.coding, pinCatalogue: catalogue });
    const done = await r.run("Fix the login bug in the dental site using Opus on Claude Max 7");
    expect(done).toMatchObject({ ok: false, refused: true, kind: "refused" });
    expect(done.said).toContain("Claude Max 7 isn't connected");
    expect(done.said).toContain("Claude Max, Claude Max 2");
    expect(done.said).toMatch(/won't move it to another account or a paid API/);
    expect(c.seen).toHaveLength(0);
  });

  test("a second, unrelated task in the same conversation is not pinned: its worker is chosen for that task (Auto)", async () => {
    const c = greedyCoding();
    const r = rig({ coding: c.coding, pinCatalogue: catalogue });
    await r.run("Fix the login bug in the dental site using Opus on Claude Max 2");
    await r.run("Fix the failing tests in the receptionist app");
    expect(c.seen.map((s) => s.pin)).toEqual([{ accountSlot: "claude:max-2", model: "claude-opus-5-5" }, null]);
  });

  test("pin words: a builder named as the worker pins; a reviewer or an incidental name does not", () => {
    expect(builderModelIn("fix it using Sonnet")).toBe("claude-sonnet-5-5");
    expect(builderModelIn("Codex, fix the header")).toBe("gpt-6-astra");
    expect(builderModelIn("fix the bug and use Codex to review it")).toBeNull();
    expect(builderModelIn("fix the Opus label typo in the pricing page")).toBeNull();
    expect(resolvePin("fix the header on Claude Max 2 with Codex", null)).toMatchObject({ kind: "refused" });
    expect(resolvePin("fix the header in the dental site", null)).toEqual({ kind: "none" });
  });
});


/** Jev as the owner wants it used: open/search requests are "device.open", open-ended screen work "device.screen", questions "brain". */
const typicalJev = (u: string) => (/^(?:open|search|go to|google|look up)\b/i.test(u.trim()) ? "device.open" : /\?$/.test(u.trim()) ? "brain" : "device.screen");

describe("Jev decides first (owner decision): the exact rules fill and validate Jev's lane, never replace it", () => {
  test("\"open YouTube\" reaches Jev first; the rule fills the URL; the job's decision is Jev's with the call's evidence and a receipt", async () => {
    const jev = scriptedJev(typicalJev);
    const c = greedyCoding();
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, coding: c.coding });
    const done = await r.run("open YouTube on my PC");
    expect(jev.asked).toHaveLength(1);
    expect(r.calls).toEqual([expect.objectContaining({ executor: "open-url", args: { url: "https://www.youtube.com/" }, pinDeviceId: "usman-pc" })]);
    expect(done.decision).toMatchObject({ source: "jev", op: "open-url", ms: 42, requestId: "req-jev-0001", model: "typesafe/jev-latest", options: ["device.open", "ask"], cached: false });
    expect(done.decision?.why).toContain("filled by rule");
    const job = r.jobs.get(done.jobId!)!;
    expect(job.steps.find((s) => s.executor === "companion")?.jev).toMatchObject({ decidedBy: "jev", requestId: "req-jev-0001", ms: 42 });
    expect(job.receipts).toEqual([expect.objectContaining({ provider: "typesafe", requestId: "req-jev-0001", latencyMs: 42, reason: "jev (fresh call; jevMs 42): open-url at 90% from device.open/ask" })]);
    expect(c.seen).toHaveLength(0);
  });

  test("\"open Google and search for <phrase>\" reaches Jev first; the exact phrase and his device are kept", async () => {
    const jev = scriptedJev(typicalJev);
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide } });
    const done = await r.run(`Open Google and search for ${PHRASE}`);
    expect(jev.asked).toHaveLength(1);
    expect(done).toMatchObject({ ok: true, decision: { source: "jev", op: "web.search" } });
    expect(new URL(String(r.calls[0].args?.url)).searchParams.get("q")).toBe(PHRASE);
    expect((r.calls[0] as { pinDeviceId?: string }).pinDeviceId).toBe("usman-pc");
  });

  test("Jev's lane wins over what the rules would have done: an exact-looking request Jev sends to the brain opens nothing", async () => {
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("brain").decide } });
    const done = await r.run("open YouTube");
    expect(done).toMatchObject({ ok: false, kind: "handoff", handoff: { to: "brain" }, decision: { source: "jev" } });
    expect(r.calls).toHaveLength(0);
  });

  test("looser words (no 'Google'): Jev chooses 'open or search on his device'; the verbatim query is taken from his words by code; cached repeat", async () => {
    const jev = scriptedJev("device.open");
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide } });
    const words = "search for marigold ferry timetable 4417";
    const done = await r.run(words);
    expect(new URL(String(r.calls[0].args?.url)).searchParams.get("q")).toBe("marigold ferry timetable 4417");
    expect(done.decision).toMatchObject({ source: "jev", op: "web.search", cached: false });
    const again = await r.run(words);
    expect(jev.asked).toHaveLength(1);
    expect(again.decision).toMatchObject({ source: "jev", cached: true });
    expect(r.jobs.get(again.jobId!)!.receipts[0]).toMatchObject({ requestId: "req-jev-0001", latencyMs: 0, reason: expect.stringMatching(/^jev \(cached; original req-jev-0001, \d+ s old\)/) });
    expect(r.jobs.get(again.jobId!)!.steps.find((s) => s.executor === "companion")?.jev).toMatchObject({ decidedBy: "jev", cached: true });
  });

  test("Jev picks 'open' but the words name nothing exact: one question, nothing opened (no invented argument)", async () => {
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("device.open").decide } });
    const done = await r.run("pull up that thing from earlier for me");
    expect(done).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(r.calls).toHaveLength(0);
  });

  test("Jev picks screen work: the screen goal goes to HIS PC with his words unchanged; one call, ids only as context", async () => {
    const jev = scriptedJev("device.screen");
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, screenGoal: true });
    const done = await r.run("tidy up the files in my downloads folder");
    expect(r.calls).toEqual([expect.objectContaining({ executor: "screen.goal", args: { goal: "tidy up the files in my downloads folder" } })]);
    expect(done.decision).toMatchObject({ source: "jev", op: "screen.goal" });
    expect(jev.asked[0].state).toEqual({ utterance: "tidy up the files in my downloads folder", device: "usman-pc" });
  });

  test("Jev picks an answer or an OS page: the deterministic answer and page run, labelled as filling Jev's lane", async () => {
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev((u) => (/page/.test(u) ? "page" : "answer")).decide } });
    const price = await r.run("how much is the Professional package");
    expect(price).toMatchObject({ ok: true, kind: "answer", decision: { source: "jev", op: "answer.price" } });
    const page = await r.run("open the receptionist page");
    expect(page).toMatchObject({ ok: true, kind: "navigate", navigate: { path: "/receptionist" }, decision: { source: "jev" } });
  });

  test("Jev unsure: one clarifying question with the real options, nothing runs", async () => {
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("device.screen", 0.3).decide }, screenGoal: true });
    const done = await r.run("sort that out for me");
    expect(done).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(done.said).toContain("on Usman's PC");
    expect(r.calls).toHaveLength(0);
  });

  test("pins still hold when Jev routes the coding job", async () => {
    const c = greedyCoding();
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("coding").decide }, coding: c.coding, pinCatalogue: () => ({ claude: [{ slot: "claude:max", label: "Claude Max" }, { slot: "claude:max-2", label: "Claude Max 2" }], codex: [] }) });
    await r.run("Fix the login bug in the dental site using Opus on Claude Max 2");
    const refused = await r.run("Fix the login bug in the dental site using Opus on Claude Max 7");
    expect(c.seen.map((s) => s.pin)).toEqual([{ accountSlot: "claude:max-2", model: "claude-opus-5-5" }]);
    // An explicit pin that can't be met is refused by name BEFORE Jev (never handed to Jev to work around).
    expect(refused).toMatchObject({ refused: true, decision: { source: "rules", op: "coding.pin" } });
  });
});

describe("Jev unavailable: a labelled deterministic fallback for supported, safe actions only; the outage line for the rest", () => {
  const timeoutJev = (async () => ({ ok: false, reason: "timeout", httpStatus: null, ms: 1500, receipt: null })) as never;
  test.each([
    ["no-key", { key: () => "" }],
    ["timeout", { key: () => "synthetic", decide: timeoutJev }],
  ] as const)("Jev %s: an exact open runs, labelled fallback with the reason on the step, the decision and a job receipt", async (reason, controller) => {
    const r = rig({ controller: controller as CommandServiceDeps["controller"] });
    const done = await r.run("open YouTube on my PC");
    expect(done.ok).toBe(true);
    expect(done.said).toContain("Jev is off, so that ran by an exact rule");
    expect(done.numbers).toMatchObject({ jev: { state: "unavailable", reason, recovery: "exact-rule" } });
    expect(done.decision).toMatchObject({ source: "fallback" });
    expect(done.decision?.why).toContain(`deterministic fallback (Jev unavailable: ${reason})`);
    const job = r.jobs.get(done.jobId!)!;
    expect(job.steps.find((s) => s.executor === "companion")?.jev).toMatchObject({ decidedBy: "fallback" });
    expect(job.receipts).toEqual([expect.objectContaining({ provider: "typesafe", outcome: reason === "timeout" ? "timed_out" : "failed", reason: expect.stringContaining(`Jev unavailable (${reason})`) })]);
  });

  test("Jev out: an open-ended request gets the plain outage line, nothing runs, the reason is on a receipt", async () => {
    const r = rig({ controller: { key: () => "" }, screenGoal: true });
    const done = await r.run("tidy up the files in my downloads folder");
    expect(done).toMatchObject({ ok: false, kind: "unavailable", numbers: { jev: { state: "unavailable", reason: "no-key" } } });
    expect(done.said).toBe(jevOutageLine("no-key"));
    expect(r.calls).toHaveLength(0);
    const job = r.jobs.get(done.jobId!)!;
    expect(job.steps[0].jev).toMatchObject({ op: "jev.unavailable", decidedBy: "rule" });
    expect(job.receipts[0]).toMatchObject({ outcome: "failed", reason: expect.stringContaining("no call made") });
  });

  test("Jev out: a compound of exact steps is a supported fallback; a coding request is not", async () => {
    const c = greedyCoding();
    const r = rig({ controller: { key: () => "" }, coding: c.coding });
    const steps = await r.run(`Open Google, search for ${PHRASE}, then open YouTube`);
    expect(steps).toMatchObject({ ok: true, decision: { source: "fallback" } });
    expect(r.calls).toHaveLength(2);
    const coding = await r.run("Fix the login bug in the dental site");
    expect(coding).toMatchObject({ kind: "unavailable" });
    expect(c.seen).toHaveLength(0);
  });
});

describe("target semantics on both hub roles", () => {
  const usmanAtPc: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
  const jevCfg = () => ({ key: () => "synthetic", decide: scriptedJev(typicalJev).decide });

  test("server role: 'on my PC' goes to his paired companion; nothing ever reaches the hub's own hands", async () => {
    const r = rig({ controller: jevCfg() });
    const done = await r.run("open YouTube on my PC");
    expect(done.targetDeviceId).toBe("usman-pc");
    expect(r.entryCalls).toHaveLength(0);
  });

  test("server role: an unnamed compound ('open Gmail and then YouTube') goes to HIS device as ordered steps, never the hub", async () => {
    const r = rig({ controller: jevCfg() });
    const done = await r.run("open Gmail and then YouTube");
    expect(done.ok).toBe(true);
    expect(r.calls.map((c) => c.args?.url)).toEqual(["https://mail.google.com/", "https://www.youtube.com/"]);
    expect(r.calls.every((c) => (c as { pinDeviceId?: string }).pinDeviceId === "usman-pc")).toBe(true);
    expect(r.entryCalls).toHaveLength(0);
  });

  test("server role: unnamed with two of his devices and no primary: ONE clarification, nothing runs anywhere", async () => {
    const r = rig({ controller: jevCfg(), devices: [{ ...pc, primary: false }, laptop] });
    const done = await r.run("open Gmail and then YouTube");
    expect(done).toMatchObject({ ok: false, ask: true });
    expect(done.said).toBe("Which one: Usman's PC or Usman's laptop? Nothing has run yet.");
    expect(r.calls).toHaveLength(0);
    expect(r.entryCalls).toHaveLength(0);
  });

  test("server role: a named device that isn't his or doesn't exist is the device question, asked before Jev", async () => {
    const jev = scriptedJev(typicalJev);
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide } });
    const done = await r.run("open YouTube on Mehroz's PC");
    expect(done.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(jev.asked).toHaveLength(0);
  });

  test("server role: an explicitly named agent goes to that agent's own environment, never his PC or the hub", async () => {
    const ran: string[] = [];
    const bots = { scope: (() => null) as never, nameOf: (id: string) => id, threadIds: () => [], run: async (i: { bot: string }) => (ran.push(i.bot), { ok: true, said: "Research started.", jobId: "bot-job", deviceId: "research-box" }) };
    const jev = scriptedJev("bot");
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, bots: bots as never });
    const done = await r.service.run({ principal: usman, body: { utterance: "find dentists in Parramatta", source: "typed", target: { bot: "research" } } });
    // Naming the agent fixed the target; Jev still decided the task, offered only that agent (or a question).
    expect(Object.keys((jev.asked[0].questions.lane as { criteria: object }).criteria)).toEqual(["bot", "ask"]);
    expect(done.decision).toMatchObject({ source: "jev", op: "bot.research" });
    expect(ran).toEqual(["research"]);
    expect(done.targetDeviceId).toBe("research-box");
    expect(r.calls).toHaveLength(0);
    expect(r.entryCalls).toHaveLength(0);
  });

  test("PC role, at the PC: the local hands are his own device; Jev decided first and the entry is told the lane (no second Jev call)", async () => {
    const jev = scriptedJev(typicalJev);
    const r = rig({ role: "pc", controller: { key: () => "synthetic", decide: jev.decide } });
    const done = await r.run("open Gmail and then YouTube", usmanAtPc);
    expect(done.ok).toBe(true);
    expect(r.entryCalls).toHaveLength(1);
    expect(r.entryCalls[0]).toMatchObject({ utterance: "open Gmail and then YouTube", decided: { lane: "device.open" } });
    expect(r.calls).toHaveLength(0);
    expect(jev.asked).toHaveLength(1);
    expect(r.jobs.get(done.jobId!)!.receipts[0]).toMatchObject({ provider: "typesafe" });
  });

  test("PC role, a founder elsewhere: 'on my laptop' goes to his laptop companion, never the hub's screen", async () => {
    const r = rig({ role: "pc", controller: jevCfg() });
    const done = await r.run("open YouTube on my laptop");
    expect(done.targetDeviceId).toBe("usman-laptop");
    expect(r.entryCalls).toHaveLength(0);
  });
});

describe("controller unit checks", () => {
  test("the options are the real capability catalogue", () => {
    const cat = { device: { label: "Usman's PC", screen: true }, page: true, answer: true, brain: true, coding: true, crm: true, memory: true, bots: [{ id: "research", name: "Research", purpose: "public research" }] };
    expect(Object.keys((controllerQuestions(cat).lane as { criteria: object }).criteria)).toEqual(["device.open", "device.screen", "page", "answer", "bot", "coding", "crm", "memory", "brain", "ask"]);
    expect(Object.keys((controllerQuestions(cat).bot as { criteria: object }).criteria)).toEqual(["research", "none"]);
  });

  test("validation: a choice Jev wasn't offered is never acted on; a missing lane is never offered", () => {
    const cat = { device: null, brain: true, coding: false, bots: [] };
    expect(Object.keys((controllerQuestions(cat).lane as { criteria: object }).criteria)).toEqual(["brain", "ask"]);
    expect(validateDecision({ lane: { choice: "device.screen", confidence: 0.99 } }, cat, 10)).toMatchObject({ kind: "rejected", choice: "device.screen" });
    const withBots = { device: null, brain: true, coding: false, bots: [{ id: "research", name: "Research", purpose: "public research" }] };
    expect(validateDecision({ lane: { choice: "bot", confidence: 0.9 }, bot: { choice: "builder", confidence: 0.9 } }, withBots, 10)).toMatchObject({ kind: "rejected", choice: "bot:builder" });
    expect(validateDecision({ lane: { choice: "bot", confidence: 0.9 }, bot: { choice: "research", confidence: 0.9 } }, withBots, 10)).toMatchObject({ kind: "decided", lane: "bot", bot: "research" });
  });

  test("a Jev failure (timeout) is reported as such, never as a decision", async () => {
    const out = await decideTask({ utterance: "x", catalogue: { device: null, brain: true, coding: false, bots: [] } }, { key: () => "k", cache: null, decide: (async () => ({ ok: false, reason: "timeout", httpStatus: null, ms: 1500, receipt: null })) as never });
    expect(out).toMatchObject({ kind: "unavailable", reason: "timeout", ms: 1500 });
  });
});

describe("voice: a Jev outage never lets the brain pick an action tool in Jev's place (brief §4.12)", () => {
  type Call = { id: string; type: "function"; function: { name: string; arguments: string } };
  type Reply = { content: string | null; tool_calls?: Call[]; model?: string; router?: { intent: string; source?: string; reason?: string } };
  const caller = { id: "usman", name: "Usman", via: "tailnet", actor: "human" };
  function voice(opts: { typesafe?: string; jevStatus?: number; brainCall?: { name: string; args: Record<string, unknown> } | null; coding?: (u: string, t: { pin?: unknown }) => Promise<{ say: string } | null> }) {
    const root = mkdtempSync(join(tmpdir(), "r10-voice-"));
    dirs.push(root);
    const fetcher = (async (url: string) => {
      if (url.includes("typesafe")) return opts.jevStatus ? new Response("down", { status: opts.jevStatus }) : Response.json({ answers: { category: { choice: "brain", confidence: 0.2 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
      if (url.includes("/chat/completions")) {
        const message = opts.brainCall ? { role: "assistant", content: "On it.", tool_calls: [{ id: "b1", type: "function", function: { name: opts.brainCall.name, arguments: JSON.stringify(opts.brainCall.args) } }] } : { role: "assistant", content: "[brain answer]" };
        return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { freeVoice } = require("../free-voice") as typeof import("../free-voice");
    const { MemoryReceiptSink } = require("../model-router/receipts") as typeof import("../model-router/receipts");
    const { MemoryHealthStore } = require("../model-router/health") as typeof import("../model-router/health");
    const v = freeVoice(root, {
      key: (n) => ({ GROQ_API_KEY: "g", ...(opts.typesafe ? { TYPESAFE_API_KEY: opts.typesafe } : {}) } as Record<string, string>)[n] ?? "",
      fetch: fetcher,
      sink: new MemoryReceiptSink(),
      health: new MemoryHealthStore(),
      bots: () => [],
      hub: () => ({ name: "Ryzen-PC", role: "server" as const }),
      companions: () => [],
      ...(opts.coding ? { coding: opts.coding as never, pinCatalogue: () => ({ claude: [{ slot: "claude:max", label: "Claude Max" }], codex: [] }) } : {}),
    } as never);
    return (content: string, remote = true) => v.handle("/voice/free/turn", { messages: [{ role: "user", content }], remote }, caller) as Promise<Reply>;
  }
  const WORDS = "deal with the overdue stuff for the Bianca project";

  test("no TypeSafe key: the brain's control_pc pick becomes the ONE command path with his words; marked as a Jev outage", async () => {
    const turn = voice({ brainCall: { name: "control_pc", args: { task: WORDS } } });
    const r = await turn(WORDS);
    expect(r.tool_calls?.map((c) => c.function.name)).toEqual(["jarvis_command"]);
    expect(JSON.parse(r.tool_calls![0].function.arguments)).toEqual({ utterance: WORDS });
    expect(r.content).toBeNull();
    expect(r.router).toMatchObject({ intent: "jev.unavailable", source: "unavailable", reason: "no-key" });
  });

  test("Jev's call failing is the same at the hub; a founder elsewhere always goes to the Jev-led command path; a plain answer still passes", async () => {
    // At the hub: Jev's call fails, no rule takes these words, so the brain answers but its screen_act pick becomes the command path.
    const failing = await voice({ typesafe: "k", jevStatus: 503, brainCall: { name: "screen_act", args: { goal: WORDS } } })(WORDS, false);
    expect(failing.tool_calls?.map((c) => c.function.name)).toEqual(["jarvis_command"]);
    expect(failing.router).toMatchObject({ reason: "error" });
    // Elsewhere, with Jev configured: the command path (its controller asks Jev once; an outage is said there), never the brain's pick.
    const remote = await voice({ typesafe: "k", brainCall: { name: "screen_act", args: { goal: WORDS } } })(WORDS);
    expect(remote as unknown).toMatchObject({ tool_calls: [{ function: { name: "jarvis_command" } }], route: { intent: "jev.controller", source: "jev" } });
    const answer = await voice({ brainCall: null })("what makes a good dental website headline in your view, honestly");
    expect(answer.content).toBe("[brain answer]");
    expect(answer.tool_calls ?? []).toHaveLength(0);
  });

  test("server role, spoken: 'open Gmail and then YouTube' and 'open YouTube' from a founder elsewhere go to the Jev-led command path (his device), never the hub's own hands", async () => {
    const turn = voice({ typesafe: "k" });
    for (const words of ["open Gmail and then YouTube", "open YouTube", `open Google and search for ${PHRASE}`]) {
      const r = await turn(words);
      expect(r.tool_calls?.map((c) => c.function.name)).toEqual(["jarvis_command"]);
      expect(JSON.parse(r.tool_calls![0].function.arguments)).toEqual({ utterance: words });
    }
  });

  test("a spoken coding request naming an account pins it; one not on this server is refused by name before the harness", async () => {
    const seen: unknown[] = [];
    const coding = async (_u: string, t: { pin?: unknown }) => (seen.push(t.pin ?? null), { say: "Draft ready." });
    const turn = voice({ coding });
    const refused = await turn("Fix the login bug in the dental site using Opus on Claude Max 3");
    expect(refused.content).toContain("Claude Max 3 isn't connected");
    expect(seen).toHaveLength(0);
    await turn("Fix the login bug in the dental site using Opus on Claude Max 1");
    expect(seen).toEqual([{ accountSlot: "claude:max", model: "claude-opus-5-5" }]);
  });
});

describe("voice router: Jev can choose 'search the web' (it chose hermes before, having no such option)", () => {
  test("Jev's 'search' answer opens Google for exactly his words; 'open Google and search for X' is one search, not a multi-step task", async () => {
    const { decide, routerQuestions } = await import("../jev-router");
    expect(Object.keys((routerQuestions("x").category as { criteria: object }).criteria)).toContain("search");
    const words = "open google and search for marigold ferry timetable 4417";
    const r = decide(words, { category: { choice: "search", confidence: 0.9 }, multi: { noul: 0.7 }, outbound: { noul: 0.02 }, complete: { noul: 0.95 } }, { apps: [], skills: [], ms: 269, cached: false });
    expect(r.kind).toBe("act");
    const url = new URL(String((r as { call: { arguments: { url: string } } }).call.arguments.url));
    expect(url.searchParams.get("q")).toBe("marigold ferry timetable 4417");
    // No search words in what he said: never an invented query; the brain hears Jev's guess as a hint instead.
    expect(decide("look into that for me", { category: { choice: "search", confidence: 0.9 }, complete: { noul: 0.95 } }, { apps: [], skills: [], ms: 1, cached: false }).kind).toBe("brain");
  });
});

describe("latency is measured separately: decision, dispatch, observed outcome (D)", () => {
  test("a dispatched routine action carries all three, in order", async () => {
    const r = rig();
    const done = await r.run("open YouTube on my PC");
    expect(done.timing).toBeDefined();
    const t = done.timing!;
    expect(typeof t.decisionMs).toBe("number");
    expect(typeof t.dispatchMs).toBe("number");
    expect(t.decisionMs!).toBeLessThanOrEqual(t.dispatchMs!);
    expect(t.dispatchMs!).toBeLessThanOrEqual(t.completeMs);
  });

  test("a refusal has a decision and no dispatch; a Jev decision records Jev's own call time", async () => {
    const r = rig({ controller: { key: () => "" }, screenGoal: true });
    const refused = await r.run("tidy up the files in my downloads folder");
    expect(refused.timing).toMatchObject({ dispatchMs: null });
    expect(typeof refused.timing!.decisionMs).toBe("number");
    const j = rig({ controller: { key: () => "synthetic", decide: scriptedJev("device.screen").decide }, screenGoal: true });
    const routed = await j.run("tidy up the files in my downloads folder");
    expect(routed.timing).toMatchObject({ jevMs: 42 });
  });
});

describe("decidedBy display hook (for the job inspector, thread card and command pill)", () => {
  test("a rule is never shown as Jev; Jev shows its choice, options and cache; a fallback says Jev was out", async () => {
    const { decidedByView } = await import("../../src/lib/commands/decided-by");
    expect(decidedByView({ decidedBy: "rule", op: "open-url", confidence: 1 })).toMatchObject({ label: "Rule", tone: "rule" });
    expect(decidedByView({ source: "rules", op: "open-url" }).label).toBe("Rule");
    expect(decidedByView({ decidedBy: "jev", op: "web.search", confidence: 0.9, options: ["device.open", "brain"], ms: 42, requestId: "req-jev-0001" })).toEqual({ label: "Jev", tone: "jev", detail: "Jev chose web.search at 90% from device.open, brain in 42 ms. Request req-jev-0001." });
    expect(decidedByView({ decidedBy: "jev", op: "open-url", cached: true }).detail).toContain("(cached)");
    expect(decidedByView({ source: "fallback", why: "deterministic fallback (Jev unavailable: timeout): the public site YouTube" })).toMatchObject({ label: "Fallback", tone: "fallback", detail: expect.stringContaining("(timeout)") });
    expect(decidedByView({ op: "x", confidence: 1 })).toMatchObject({ label: "Unknown" });
    expect(decidedByView(null).label).toBe("Unknown");
  });
});

describe("tightened contracts (owner review): bypasses, constraints, rejections, cache, one Jev budget", () => {
  const usmanAtPc: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
  const mehroz: Principal = { personId: "mehroz", via: "paired-session", actor: "human", displayName: "Mehroz" };

  test("only Stop and an answer to a question are handled before Jev", async () => {
    const jev = scriptedJev("device.open");
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide } });
    expect(await r.run("stop")).toMatchObject({ stopped: true });
    await r.run("yes");
    expect(jev.asked).toHaveLength(0);
    await r.run("open YouTube");
    expect(jev.asked).toHaveLength(1);
  });

  test("'continue that job' reports the existing job; no new routing decision, nothing dispatched, the job (and its pins) untouched", async () => {
    const jev = scriptedJev("device.screen");
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, screenGoal: true });
    const first = await r.run("tidy up the files in my downloads folder");
    const before = JSON.stringify(r.jobs.get(first.jobId!));
    const done = await r.service.run({ principal: usman, body: { utterance: "continue that job", source: "typed", pageContext: { page: "/jobs", focused: { kind: "job", id: first.jobId!, label: "Tidy" }, capturedAt: Date.now() } as never } });
    expect(done).toMatchObject({ kind: "answer", decision: { op: "job.continue" } });
    expect(jev.asked).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
    expect(JSON.stringify(r.jobs.get(first.jobId!))).toBe(before);
  });

  test("a named agent with a choice outside its constraint: rejected, recorded on a receipt, he is asked; nothing runs anywhere", async () => {
    const ran: string[] = [];
    const bots = { scope: (() => null) as never, nameOf: (id: string) => id, threadIds: () => [], run: async (i: { bot: string }) => (ran.push(i.bot), { ok: true, said: "ok" }) };
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("device.screen").decide }, bots: bots as never, screenGoal: true });
    const done = await r.service.run({ principal: usman, body: { utterance: "research dentists in Parramatta", source: "typed", target: { bot: "builder" } } });
    expect(done).toMatchObject({ ok: false, ask: true, decision: { op: "jev.rejected", target: "device.screen", source: "jev" } });
    expect(ran).toEqual([]);
    expect(r.calls).toHaveLength(0);
    expect(r.jobs.get(done.jobId!)!.receipts[0]).toMatchObject({ outcome: "refused_policy", reason: expect.stringContaining('jev.rejected "device.screen"') });
  });

  test("a named shared computer fixes the target; Jev decides the task (only that computer or a question is offered)", async () => {
    const jev = scriptedJev("computer");
    const asked: string[] = [];
    const svc = rig({ controller: { key: () => "synthetic", decide: jev.decide } });
    const service = createCommandService({
      jobs: () => svc.jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device registered for usman" }),
      delegates: { computers: async (u: string) => (asked.push(u), { ok: true, said: "Research computer started.", jobId: "cj", deviceId: "research-box" }) },
      controller: { key: () => "synthetic", decide: jev.decide, cache: new ControllerCache() }, dedupeMs: 0,
    });
    const done = await service.run({ principal: usman, body: { utterance: "use the research computer to find dentists in Parramatta", source: "typed" } });
    expect(Object.keys((jev.asked[0].questions.lane as { criteria: object }).criteria)).toEqual(["computer", "ask"]);
    expect(asked).toEqual(["use the research computer to find dentists in Parramatta"]);
    expect(done).toMatchObject({ targetDeviceId: "research-box", decision: { source: "jev", op: "computer.research" } });
  });

  test("page context resolves the lead's site; Jev decides the task and the site on file is what opens", async () => {
    const jev = scriptedJev("device.open");
    const devices = [pc];
    const registry = staticRegistry(devices);
    registry.heartbeat(pc.id);
    const calls: CommandInput[] = [];
    const jobs = rig().jobs;
    const service = createCommandService({
      jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: (c) => resolveTarget(c, registry), supports: () => true,
      dispatcher: { submit: async (i: CommandInput) => (calls.push(i), { ok: true, local: false, deviceId: "usman-pc", commandId: "c", result: { ok: true, said: "Opened.", verified: true } }) } as never,
      delegates: { leadSite: async () => ({ name: "Smile Dental", website: "smiledental.example.com.au" }) },
      controller: { key: () => "synthetic", decide: jev.decide, cache: new ControllerCache() }, dedupeMs: 0,
    });
    const done = await service.run({ principal: usman, body: { utterance: "open this lead's website", source: "typed", pageContext: { page: "/leads", focused: { kind: "lead", id: "42", label: "Smile Dental" }, capturedAt: Date.now() } as never } });
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0].state).toMatchObject({ record: "lead:42" });
    expect(calls).toEqual([expect.objectContaining({ executor: "open-url", args: { url: "https://smiledental.example.com.au/" } })]);
    expect(done.decision).toMatchObject({ source: "jev", op: "open-url" });
  });

  test("cache: keyed by who asked and the target; a repeated action runs again with only the decision reused", async () => {
    const jev = scriptedJev("device.open");
    const devices = [pc, { ...pc, id: "mehroz-pc", owner: "mehroz" as const, label: "Mehroz's PC" }];
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, devices });
    await r.run("open YouTube");
    const again = await r.run("open YouTube");
    expect(jev.asked).toHaveLength(1);
    expect(again.decision).toMatchObject({ cached: true, requestId: "req-jev-0001" });
    expect(r.calls).toHaveLength(2); // the action executed twice: only the decision was reused
    await r.run("open YouTube", mehroz);
    expect(jev.asked).toHaveLength(2); // a different person (and device) is a different decision
    expect(r.calls.at(-1)).toMatchObject({ pinDeviceId: "mehroz-pc" });
  });

  test("one Jev budget per request: when Jev times out at the hub, the entry is told and does not ask Jev again", async () => {
    let calls = 0;
    const timeout = (async () => (calls++, { ok: false, reason: "timeout", httpStatus: null, ms: 1500, receipt: null })) as never;
    const r = rig({ role: "pc", controller: { key: () => "synthetic", decide: timeout } });
    const done = await r.run("open YouTube", usmanAtPc);
    expect(calls).toBe(1);
    expect(r.entryCalls).toEqual([expect.objectContaining({ jevUnavailable: "timeout" })]);
    expect(r.jobs.get(done.jobId!)!.receipts[0]).toMatchObject({ outcome: "timed_out" });
  });
});

describe("business requests under Jev-first (merged r10/biz)", () => {
  const crmOps = () => {
    const seen: string[] = [];
    const crm = async (intent: { kind: string }) => (seen.push(intent.kind), { ok: true, said: "Draft quote ready (nothing sent).", verified: true });
    return { crm, seen };
  };
  test("'draft a quote for the Orchard website deal': Jev decides CRM; the website wording never falls into coding", async () => {
    const c = greedyCoding();
    const ops = crmOps();
    const jev = scriptedJev("crm");
    const jobs = rig().jobs;
    const service = createCommandService({
      jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device registered for usman" }),
      delegates: { coding: c.coding, crm: ops.crm as never }, controller: { key: () => "synthetic", decide: jev.decide, cache: new ControllerCache() }, dedupeMs: 0,
    });
    const done = await service.run({ principal: usman, body: { utterance: "draft a quote for the Orchard website deal", source: "typed" } });
    expect(Object.keys((jev.asked[0].questions.lane as { criteria: object }).criteria)).toContain("crm");
    expect(done).toMatchObject({ ok: true, decision: { source: "jev", op: "crm.operation" } });
    expect(ops.seen).toHaveLength(1);
    expect(c.seen).toHaveLength(0);
  });
  test("Jev out: an explicit CRM form is a safe exact action, run as the labelled fallback with the reason on a receipt", async () => {
    const ops = crmOps();
    const jobs = rig().jobs;
    const service = createCommandService({
      jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device registered for usman" }),
      delegates: { crm: ops.crm as never }, controller: { key: () => "" }, dedupeMs: 0,
    });
    const done = await service.run({ principal: usman, body: { utterance: "draft a quote for the Orchard website deal", source: "typed" } });
    expect(done).toMatchObject({ ok: true, decision: { source: "fallback" } });
    expect(jobs.get(done.jobId!)!.receipts[0]).toMatchObject({ outcome: "failed", reason: expect.stringContaining("Jev unavailable (no-key)") });
  });
});

describe("review fix: when Jev decides 'brain' (or Jev is available on a conversation turn) the brain answers only", () => {
  const caller = { id: "usman", name: "Usman", via: "tailnet", actor: "human" };
  async function hub(words: string, brainCall: { name: string; args: Record<string, unknown> } | null) {
    const root = mkdtempSync(join(tmpdir(), "r10-answer-only-"));
    dirs.push(root);
    const toolLists: string[][] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.includes("typesafe")) return Response.json({ answers: { category: { choice: "brain", confidence: 0.9 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
      if (url.includes("/chat/completions")) {
        toolLists.push(((JSON.parse(String(init?.body ?? "{}")).tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name));
        const message = brainCall ? { role: "assistant", content: "Opening it now.", tool_calls: [{ id: "b1", type: "function", function: { name: brainCall.name, arguments: JSON.stringify(brainCall.args) } }] } : { role: "assistant", content: "[brain answer]" };
        return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const { freeVoice } = require("../free-voice") as typeof import("../free-voice");
    const { MemoryReceiptSink } = require("../model-router/receipts") as typeof import("../model-router/receipts");
    const { MemoryHealthStore } = require("../model-router/health") as typeof import("../model-router/health");
    const v = freeVoice(root, { key: (n: string) => ({ GROQ_API_KEY: "g", TYPESAFE_API_KEY: "k" } as Record<string, string>)[n] ?? "", fetch: fetcher, sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), bots: () => [], hub: () => ({ name: "Ryzen-PC", role: "pc" as const }), companions: () => [] } as never);
    const reply = (await v.handle("/voice/free/turn", { messages: [{ role: "user", content: words }], remote: false }, caller)) as { content: string | null; tool_calls?: unknown[] };
    return { reply, toolLists };
  }

  test("Jev says brain; the brain proposes open_url anyway: nothing executes, the reply asks what to do, and no action tool was offered", async () => {
    const { reply, toolLists } = await hub("deal with the overdue stuff for the Bianca project", { name: "open_url", args: { url: "https://example.com/" } });
    expect(reply.tool_calls ?? []).toHaveLength(0);
    expect(reply.content).toBe("Nothing ran. Tell me exactly what you want done and I'll take it from there.");
    for (const name of ["open_url", "screen_act", "pc_act", "browser_act", "control_pc", "delegate_task"]) expect(toolLists[0]).not.toContain(name);
    expect(toolLists[0]).toContain("search_memory");
  });

  test("a conversation turn while Jev is available: the brain answers with no action tools offered", async () => {
    const { reply, toolLists } = await hub("what makes a good dental website headline in your view, honestly", null);
    expect(reply.content).toBe("[brain answer]");
    expect(toolLists[0]).not.toContain("screen_act");
  });
});

describe("money policy: a Claude account name is not a subscription purchase (round 10, minimal change)", () => {
  test("'on/using/via/with Claude Max <n>' names an account; buying, upgrading or subscribing is still caught", async () => {
    const { moneyRefusal } = await import("../../src/lib/money-policy");
    for (const words of ["Fix this bug using Opus on Claude Max 2", "fix the header in the dental site with Claude Max 3", "run the review via Claude Max 2", "using my Claude Max 2, fix the login bug"])
      expect({ words, kind: moneyRefusal(words)?.kind ?? null }).toEqual({ words, kind: null });
    for (const words of ["buy Claude Max 2", "upgrade to Claude Max", "subscribe to Claude Max", "get me Claude Max 2", "sign me up for Claude Max", "start a Claude Pro trial"])
      expect({ words, kind: moneyRefusal(words)?.kind ?? null }).toEqual({ words, kind: "money-or-trading" });
  });
});

describe("agents through Jev: the list() options, the task kind and the decision record reach the agent", () => {
  const agentJev = (bot: string, botLane: "coding" | "computer") => {
    const asked: Array<{ questions: Record<string, unknown> }> = [];
    const decide = (async (call: { questions: Record<string, unknown> }) => (asked.push(call), { ok: true, answers: { lane: { choice: "bot", confidence: 0.92 }, bot: { choice: bot, confidence: 0.9 }, bot_lane: { choice: botLane, confidence: 0.9 }, multi: { noul: 0 }, outbound: { noul: 0 } }, ms: 37, httpStatus: 200, attempts: 1, receipt: { requestId: "req-agent-0001", model: "typesafe/jev-latest", inputTokens: 1 }, raw: null })) as never;
    return { decide, asked };
  };
  const agents = () => {
    const ran: Array<{ bot: string; lane?: string; decision?: { decidedBy?: string; op?: string; requestId?: string } | null }> = [];
    const bots = {
      scope: (() => null) as never, nameOf: (id: string) => (id === "research" ? "Research" : "Builder"), threadIds: () => [],
      list: () => [{ id: "research", name: "Research", purpose: "public research" }, { id: "builder", name: "Builder", purpose: "builds and fixes software" }],
      run: async (i: { bot: string; lane?: string; decision?: { decidedBy?: string; op?: string; requestId?: string } | null }) => (ran.push({ bot: i.bot, lane: i.lane, decision: i.decision }), { ok: true, said: "Started.", jobId: "bot-job", deviceId: "bot-box" }),
    };
    return { bots, ran };
  };

  test("a bare 'Research dentists in Parramatta' goes to the Research agent by Jev's decision (computer task), with the decision record", async () => {
    const jev = agentJev("research", "computer");
    const a = agents();
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, bots: a.bots as never });
    const done = await r.run("Research dentists in Parramatta");
    expect(Object.keys((jev.asked[0].questions.bot as { criteria: object }).criteria)).toEqual(["research", "builder", "none"]);
    expect(a.ran).toEqual([{ bot: "research", lane: "computer", decision: expect.objectContaining({ decidedBy: "jev", op: "bot.research.computer", requestId: "req-agent-0001" }) }]);
    expect(done).toMatchObject({ ok: true, targetDeviceId: "bot-box", decision: { source: "jev", op: "bot.research.computer" } });
    expect(r.calls).toHaveLength(0);
  });

  test("'Builder, fix the header in the dental site': the named agent is the only target; Jev chose a coding job", async () => {
    const jev = agentJev("builder", "coding");
    const a = agents();
    const r = rig({ controller: { key: () => "synthetic", decide: jev.decide }, bots: a.bots as never });
    await r.service.run({ principal: usman, body: { utterance: "fix the header in the dental site", source: "typed", target: { bot: "builder" } } });
    expect(Object.keys((jev.asked[0].questions.bot as { criteria: object }).criteria)).toEqual(["builder", "none"]);
    expect(a.ran).toEqual([{ bot: "builder", lane: "coding", decision: expect.objectContaining({ decidedBy: "jev", op: "bot.builder.coding" }) }]);
  });
});

describe("default-conversation commands are idempotent by event id across a hub restart", () => {
  test("the same event id after a restart is answered from the job record and never runs again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r10-evt-"));
    dirs.push(dir);
    const registry = staticRegistry([pc]);
    registry.heartbeat(pc.id);
    const calls: CommandInput[] = [];
    const make = () => {
      const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
      const service = createCommandService({
        jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: (c) => resolveTarget(c, registry), supports: () => true, dedupeMs: 0,
        dispatcher: { submit: async (i: CommandInput) => (calls.push(i), { ok: true, local: false, deviceId: "usman-pc", commandId: "c", result: { ok: true, said: "YouTube is open.", verified: true } }) } as never,
      });
      return { jobs, service };
    };
    const first = make();
    const a = await first.service.run({ principal: usman, body: { utterance: "open YouTube on my PC", source: "typed", eventId: "evt-default-0001" } });
    expect(a.ok).toBe(true);
    first.jobs.close();
    const second = make(); // the hub restarted: no in-memory dedupe survives
    closers.push(() => second.jobs.close());
    const b = await second.service.run({ principal: usman, body: { utterance: "open YouTube on my PC", source: "typed", eventId: "evt-default-0001" } });
    expect(calls).toHaveLength(1);
    expect(b).toMatchObject({ kind: "answer", jobId: a.jobId, numbers: { replayed: true, state: "succeeded" } });
    expect(b.said).toContain("It was not run again");
    // A different event id is a new command.
    await second.service.run({ principal: usman, body: { utterance: "open YouTube on my PC", source: "typed", eventId: "evt-default-0002" } });
    expect(calls).toHaveLength(2);
  });
});

describe("review minors (645f69fb)", () => {
  test("an agent Jev picks without being named gets the same money pre-check: nothing reaches it", async () => {
    const ran: string[] = [];
    const bots = { scope: (() => null) as never, nameOf: (id: string) => id, threadIds: () => [], list: () => [{ id: "research", name: "Research", purpose: "public research" }], run: async (i: { bot: string }) => (ran.push(i.bot), { ok: true, said: "ok" }) };
    const decide = (async () => ({ ok: true, answers: { lane: { choice: "bot", confidence: 0.9 }, bot: { choice: "research", confidence: 0.9 }, multi: { noul: 0 }, outbound: { noul: 0 } }, ms: 5, httpStatus: 200, attempts: 1, receipt: null, raw: null })) as never;
    const r = rig({ controller: { key: () => "synthetic", decide }, bots: bots as never });
    const done = await r.run("using opus buy 10 Tesla shares");
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(ran).toEqual([]);
  });

  test("event ids longer than 64 characters never share an idempotency key (no truncation collisions)", async () => {
    const r = rig();
    const long = "e".repeat(70);
    await r.service.run({ principal: usman, body: { utterance: "open YouTube on my PC", source: "typed", eventId: `${long}-a` as never } });
    await r.service.run({ principal: usman, body: { utterance: "open YouTube on my PC", source: "typed", eventId: `${long}-b` as never } });
    expect(r.calls).toHaveLength(2);
  });

  test("answer-only turns also block the device-acting skills (type, window, clipboard, browser)", async () => {
    const root = mkdtempSync(join(tmpdir(), "r10-skill-block-"));
    dirs.push(root);
    const fetcher = (async (url: string) => {
      if (url.includes("typesafe")) return Response.json({ answers: { category: { choice: "brain", confidence: 0.9 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
      return Response.json({ choices: [{ message: { role: "assistant", content: "Typing it.", tool_calls: [{ id: "b1", type: "function", function: { name: "skill", arguments: JSON.stringify({ skill: "type", text: "hello" }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;
    const { freeVoice } = require("../free-voice") as typeof import("../free-voice");
    const { MemoryReceiptSink } = require("../model-router/receipts") as typeof import("../model-router/receipts");
    const { MemoryHealthStore } = require("../model-router/health") as typeof import("../model-router/health");
    const v = freeVoice(root, { key: (n: string) => ({ GROQ_API_KEY: "g", TYPESAFE_API_KEY: "k" } as Record<string, string>)[n] ?? "", fetch: fetcher, sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), bots: () => [], hub: () => ({ name: "Ryzen-PC", role: "pc" as const }), companions: () => [] } as never);
    const reply = (await v.handle("/voice/free/turn", { messages: [{ role: "user", content: "deal with the overdue stuff for the Bianca project" }], remote: false }, { id: "usman", name: "Usman", via: "tailnet", actor: "human" })) as { content: string | null; tool_calls?: unknown[] };
    expect(reply.tool_calls ?? []).toHaveLength(0);
    expect(reply.content).toContain("Nothing ran");
  });

  test("answer-only turns drop a rule-only tool the brain names unprompted (jarvis_command, screen tools): only offered tools run", async () => {
    const root = mkdtempSync(join(tmpdir(), "r10-ruleonly-block-"));
    dirs.push(root);
    const fetcher = (async (url: string) => {
      if (url.includes("typesafe")) return Response.json({ answers: { category: { choice: "brain", confidence: 0.9 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
      return Response.json({ choices: [{ message: { role: "assistant", content: "On it.", tool_calls: [
        { id: "c1", type: "function", function: { name: "jarvis_command", arguments: JSON.stringify({ utterance: "open YouTube on my PC" }) } },
        { id: "c2", type: "function", function: { name: "screen_point", arguments: "{}" } },
      ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;
    const { freeVoice } = require("../free-voice") as typeof import("../free-voice");
    const { MemoryReceiptSink } = require("../model-router/receipts") as typeof import("../model-router/receipts");
    const { MemoryHealthStore } = require("../model-router/health") as typeof import("../model-router/health");
    const v = freeVoice(root, { key: (n: string) => ({ GROQ_API_KEY: "g", TYPESAFE_API_KEY: "k" } as Record<string, string>)[n] ?? "", fetch: fetcher, sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), bots: () => [], hub: () => ({ name: "Ryzen-PC", role: "pc" as const }), companions: () => [] } as never);
    const reply = (await v.handle("/voice/free/turn", { messages: [{ role: "user", content: "deal with the overdue stuff for the Bianca project" }], remote: false }, { id: "usman", name: "Usman", via: "tailnet", actor: "human" })) as { content: string | null; tool_calls?: unknown[] };
    expect(reply.tool_calls ?? []).toHaveLength(0);
    expect(reply.content).toContain("Nothing ran");
  });
});

// Round 11 (production acceptance, 4 Oct, live d64d76fe).
describe("round 11: the compound with a file (journey 4) and a pin to an account that isn't here (journey 9)", () => {
  const WORDS = "on my PC open YouTube and then open the file zz-missing-report-7731.docx";
  test("plan: the machine named first is split off, and the compound is two exact steps in his order (a site open, then the file)", () => {
    expect(splitSpokenTarget(WORDS)).toEqual({ utterance: "open YouTube and then open the file zz-missing-report-7731.docx", spokenTarget: "my PC" });
    const steps = linkedSteps(splitSpokenTarget(WORDS).utterance);
    expect(steps?.map((s) => s.executor)).toEqual(["open-url", "file.open"]);
    expect(steps![0].args.url).toBe("https://www.youtube.com/");
    expect(String(steps![1].args.name)).toContain("zz-missing-report-7731");
    // "open YouTube and search X" still needs the browser lane that can search: not a plain site open.
    expect(linkedSteps("open YouTube and search for lofi beats")).toBeNull();
  });

  test("Jev picks screen work for the compound: it still runs as the two typed steps on HIS PC (never one screen goal); step 2's failure is reported, never 'all done'", async () => {
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("device.screen", 0.71).decide }, screenGoal: true, failStep: 2 });
    const done = await r.run(WORDS);
    expect(r.calls.map((c) => c.executor)).toEqual(["open-url", "file.open"]);
    expect(r.calls.every((c) => (c as { pinDeviceId?: string }).pinDeviceId === "usman-pc")).toBe(true);
    expect(r.calls.some((c) => c.executor === "screen.goal")).toBe(false);
    expect(done.ok).toBe(false);
    expect(done.said).toContain("step 2 of 2");
    expect(r.jobs.get(done.jobId!)!.steps.filter((s) => s.executor === "companion").map((s) => s.outcome)).toEqual(["ok", "failed"]);
  });

  test("a pin to Claude Max 3 is refused by name with the connected accounts, even when the words aren't on the coding word list; nothing drafted, no switch", async () => {
    const c = greedyCoding();
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("coding").decide }, coding: c.coding, codingMatches: () => false, pinCatalogue: () => ({ claude: [{ slot: "claude:max", label: "Claude Max" }, { slot: "claude:max-2", label: "Claude Max 2" }], codex: [] }) });
    const done = await r.run("In muv-flagship-legal, fix any typo in the README, using Opus on Claude Max 3");
    expect(done).toMatchObject({ ok: false, refused: true, decision: { op: "coding.pin" } });
    expect(done.said).toContain("Claude Max 3 isn't connected");
    expect(done.said).toContain("Connected: Claude Max, Claude Max 2");
    expect(c.seen).toHaveLength(0);
  });
});

describe("round 11 review: an account mention is not a pin", () => {
  test("'connect Claude Max 3' and 'how much usage is left on Claude Max 3' are never refused as a pin", async () => {
    const c = greedyCoding();
    const r = rig({ controller: { key: () => "synthetic", decide: scriptedJev("answer").decide }, coding: c.coding, codingMatches: () => false, pinCatalogue: () => ({ claude: [{ slot: "claude:max", label: "Claude Max" }, { slot: "claude:max-2", label: "Claude Max 2" }], codex: [] }) });
    for (const words of ["connect Claude Max 3", "how much usage is left on Claude Max 3"]) {
      const done = await r.run(words);
      expect([words, done.decision?.op]).not.toEqual([words, "coding.pin"]);
    }
  });

  test("plan: a folder or place named first is not a device ('From the desktop folder open report.pdf', 'on the desktop open notes.txt')", () => {
    expect(splitSpokenTarget("From the desktop folder open report.pdf")).toEqual({ utterance: "From the desktop folder open report.pdf" });
    expect(splitSpokenTarget("on the desktop open notes.txt")).toEqual({ utterance: "on the desktop open notes.txt" });
    expect(splitSpokenTarget("on my desktop folder open notes.txt").spokenTarget).toBeUndefined();
    expect(splitSpokenTarget("using Mehroz's laptop open YouTube")).toEqual({ utterance: "open YouTube", spokenTarget: "Mehroz's laptop" });
  });
});

describe("release re-check B1/M1: a Stop is reported as the hub really left it", () => {
  test("Stop by event id while Jev is still routing: the command never starts (no job), and a resend of that event says it was stopped before it started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = scriptedJev("device.open");
    const decide = (async (call: never) => { await gate; return (slow.decide as (c: never) => Promise<unknown>)(call); }) as never;
    const r = rig({ controller: { key: () => "synthetic", decide } });
    const before = r.jobs.list({ limit: 50 }).length;
    const running = r.service.run({ principal: usman, body: { utterance: "open YouTube", source: "typed", eventId: "evt-b1-early" } });
    await new Promise((x) => setTimeout(x, 10));
    const stop = await r.service.cancelEvent("evt-b1-early", usman);
    // Its run is in progress, so the hub can't promise "prevented" (final review B1): it records the stop and says it isn't confirmed yet.
    expect(stop.outcome).toBe("unconfirmed");
    release();
    const done = await running;
    expect(done).toMatchObject({ stopped: true, said: "Stopped before it started. Nothing ran." });
    expect(r.calls).toHaveLength(0);
    expect(r.jobs.list({ limit: 50 }).length).toBe(before);
    const again = await r.service.run({ principal: usman, body: { utterance: "open YouTube", source: "typed", eventId: "evt-b1-early" } });
    expect(again.said).toBe("Stopped before it started. Nothing ran.");
  });

  test("a stop the job service didn't acknowledge (quarantined, state unknown) is never reported as stopped", async () => {
    const r = rig();
    const job = r.jobs.create({ kind: "command", principal: { personId: "usman", via: "loopback-owner", actor: "human" } as never, targetDeviceId: "usman-pc", title: "t" });
    (r.jobs as unknown as { cancel: unknown }).cancel = async () => ({ ok: true, state: "unknown", aborted: true, acknowledged: false, quarantined: true });
    const res = await r.service.cancel(job.id, usman);
    expect(res).toMatchObject({ ok: false, outcome: "unconfirmed" });
    expect(stopOutcome({ ok: true, state: "cancelled", quarantined: false })).toBe("stopped");
    expect(stopOutcome({ ok: false, state: "succeeded", quarantined: false })).toBe("already-ended");
    expect(stopOutcome({ ok: true, state: "running", quarantined: false })).toBe("unconfirmed");
  });
});

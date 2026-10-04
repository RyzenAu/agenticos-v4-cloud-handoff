import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLedger } from "../../companion/ledger";
import type { Executor } from "../../companion/executors";
import { CompanionWorker } from "../../companion/worker";
import { resolveTarget } from "../devices/route";
import { startHub, type Hub, type Who } from "../devices/test-harness";
import { JobService } from "../jobs/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { Principal } from "../identity/principal";
import { abortableSleep } from "../executors/windows";
import { COMPANION_EXECUTORS, type CommandBody, type CommandDoneEvent } from "./contracts";
import { parseCommandBody, parseSteps } from "./route";
import { createCommandService } from "./service";

// SYNTHETIC: the real command service + a real JobService (SQLite on D:-style temp) over a real /__devices
// service, with a real CompanionWorker per PC running fake executors. No desktop, browser or network.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const until = async (check: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

const usmanAtPc: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };

async function rig(opts: { role?: "pc" | "cloud"; observeWaitMs?: number } = {}) {
  const hub: Hub = await startHub({ maxWaitMs: 300, hubRole: opts.role ?? "pc", observeWaitMs: opts.observeWaitMs ?? 300 });
  const dir = mkdtempSync(join(tmpdir(), "remote-steps-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 1500, snapshotMs: 0 });
  let entryCalls = 0;
  const ledger = new SpokenConfirmationLedger();
  const service = createCommandService({
    jobs: () => jobs,
    entry: () => {
      entryCalls++;
      return null;
    },
    hubDeviceId: hub.svc.hubIsDevice ? "usman-pc" : "",
    resolveTarget: (ctx) => resolveTarget(ctx, hub.svc.registry),
    dispatcher: hub.svc.dispatcher,
    micOwner: (p) => hub.svc.registry.micOwner(p),
    deviceLabel: (id) => hub.svc.registry.all().find((d) => d.id === id)?.label ?? id,
    remoteTimeoutMs: 5_000,
    supports: (deviceId, executor) => hub.svc.registry.presenceOf(deviceId)?.capabilities?.includes(executor) === true,
    spoken: ledger,
  });
  const workers: CompanionWorker[] = [];
  cleanups.push(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await hub.close();
    try {
      jobs.close();
    } catch {
      /* running */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  async function pair(owner: "usman" | "mehroz", label: string, executors: Record<string, Executor>, extra: { flaky?: { down: boolean }; ledger?: CommandLedger; aliases?: string[] } = {}) {
    const issuer = owner === "usman" ? hub.browser("local") : hub.browser("mehroz");
    if (owner === "mehroz") await issuer.post("/pair/tailnet", { label: "b" });
    const code = (await issuer.post("/pair/code", { purpose: "companion" })).json.code as string;
    const headers = hub.headersFor(owner as Who);
    const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label, aliases: extra.aliases ?? ["pc"] }) });
    const paired = (await res.json()) as any;
    expect(res.status).toBe(200);
    const ledger = extra.ledger ?? new CommandLedger();
    const worker = new CompanionWorker({
      hubUrl: hub.base, token: paired.token, deviceId: paired.deviceId, owner, extraHeaders: headers, heartbeatMs: 40, pollWaitMs: 300,
      executors, ledger, interactive: async () => true,
      fetchImpl: (async (input: any, init?: any) => {
        if (extra.flaky?.down) throw new Error("network down");
        return fetch(input, init);
      }) as typeof fetch,
      log: () => undefined,
    }).start();
    workers.push(worker);
    expect(await worker.waitOnline()).toBe(true);
    return { worker, ledger, deviceId: paired.deviceId as string };
  }
  async function run(principal: Principal, body: Partial<CommandBody>): Promise<CommandDoneEvent> {
    return service.run({ principal, body: { utterance: "do these", source: "typed", ...body } as CommandBody });
  }
  return { hub, jobs, service, pair, run, ledger, entryCalls: () => entryCalls };
}

/** Fake executors that record what ran, in order. */
function pcExecutors(log: string[], opts: { failOn?: string; slowMs?: number } = {}): Record<string, Executor> {
  const ok = (name: string): Executor => async (args, ctx) => {
    log.push(`${name}:${String(args.tag ?? "")}`);
    if (opts.slowMs && name === "wait") await abortableSleep(opts.slowMs, ctx.signal).catch(() => undefined);
    if (ctx.signal.aborted) return { ok: false, said: "Cancelled.", verified: false, data: { cancelled: true } };
    if (opts.failOn && String(args.tag) === opts.failOn) return { ok: false, said: `Step ${args.tag} didn't verify.`, verified: false };
    return { ok: true, said: `${name} ${args.tag ?? ""} done.`.replace(/ +/g, " "), verified: true, evidence: `${name} read back` };
  };
  return { echo: ok("echo"), wait: ok("wait"), "app.focus": ok("app.focus"), "browser.navigate": ok("browser.navigate"), "observe.window": ok("observe.window") };
}

const job = (r: Awaited<ReturnType<typeof rig>>, id: string | null) => (id ? r.jobs.get(id) : null);

import type { ExecutorResult } from "./contracts";

/** A fake screen.goal: streams sub-steps through ctx.progress like the real one, then answers. */
function goalExecutor(log: string[], script: (args: Record<string, unknown>, ctx: { signal: AbortSignal; progress?: (s: any) => void }) => Promise<ExecutorResult>): Record<string, Executor> {
  return { "screen.goal": async (args, ctx) => (log.push(`goal:${String(args.goal ?? (args.resume as any)?.goal ?? "")}`), script(args, ctx as never)) };
}
const sub = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, executor: "uia", outcome: "ok", ms: 5, ...extra });
const YT = "open a new Chrome tab and go to youtube.com then search for Sydney weather";

describe("screen.goal: compound and open-ended goals go to the companion's own screen loop", () => {
  test("the YouTube goal is sent (not refused); each sub-step becomes a job step as it happens; done only with the loop's own check", async () => {
    const r = await rig();
    const log: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", goalExecutor(log, async (_a, ctx) => {
      ctx.progress?.(sub("act: opened youtube.com"));
      ctx.progress?.(sub("check: the page is YouTube", { verification: { method: "screen-loop-check", ok: true, evidence: "title YouTube" } }));
      ctx.progress?.(sub("check: results for Sydney weather are showing", { verification: { method: "screen-loop-check", ok: true } }));
      return { ok: true, said: "Searched YouTube for Sydney weather.", verified: true, evidence: "2 checked steps passed" };
    }));
    const done = await r.run(mehroz, { utterance: YT });
    expect(done).toMatchObject({ ok: true, kind: "remote", verified: true, targetDeviceId: m.deviceId });
    expect(log).toEqual([`goal:${YT}`]);
    const j = job(r, done.jobId)!;
    expect(j.state).toBe("succeeded");
    expect(j.steps.map((s) => s.intent).slice(0, 3)).toEqual(["act: opened youtube.com", "check: the page is YouTube", "check: results for Sydney weather are showing"]);
    expect(j.steps.filter((s) => s.verification?.ok === true)).toHaveLength(3);
    expect(j.steps.at(-1)!.verification).toMatchObject({ method: "companion-check", ok: true, evidence: "2 checked steps passed" });
    expect(m.ledger.list()[0]).toMatchObject({ executor: "screen.goal", state: "done" });
    expect(r.entryCalls()).toBe(0);
  });
  test("an unrecognised goal and a compound one the rules refuse go to it too", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", goalExecutor(log, async () => ({ ok: true, said: "Done.", verified: true })));
    expect((await r.run(mehroz, { utterance: "click the Save button in there" })).ok).toBe(true);
    expect((await r.run(mehroz, { utterance: "open chrome and go to example.com" })).ok).toBe(true);
    expect(log).toEqual(["goal:click the Save button in there", "goal:open chrome and go to example.com"]);
  });
  test("a companion that does not report screen.goal still refuses plainly, and nothing is sent", async () => {
    const r = await rig();
    await r.pair("mehroz", "Mehroz's PC", pcExecutors([]));
    const done = await r.run(mehroz, { utterance: YT });
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(done.said).toMatch(/screen loop/);
    expect(await r.run(mehroz, { utterance: "open chrome and go to example.com" })).toMatchObject({ ok: false, ask: true });
  });
  test("money, bank and secret goals are refused at the hub before anything is sent", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", goalExecutor(log, async () => ({ ok: true, said: "Done.", verified: true })));
    for (const utterance of ["log in to my bank and transfer 500 dollars to Sam", "open my password manager and read me the passwords"]) {
      const done = await r.run(mehroz, { utterance });
      expect(done.ok).toBe(false);
    }
    expect(log).toEqual([]);
  });
  test("a goal the companion's own screen loop refuses comes back as not done, with its line", async () => {
    const r = await rig();
    await r.pair("mehroz", "Mehroz's PC", goalExecutor([], async () => ({ ok: false, said: "That looks like a payment page, so I stopped.", verified: false, data: { refused: true } })));
    const done = await r.run(mehroz, { utterance: "click the big green button" });
    expect(done.ok).toBe(false);
    expect(done.said).toContain("payment page");
  });
});

describe("screen.goal: cancel, a dropped companion, and approval questions", () => {
  test("cancel mid-goal: the goal is aborted, its later sub-steps never run, the job is cancelled", async () => {
    const r = await rig();
    const ran: string[] = [];
    const m = await r.pair("mehroz", "Mehroz's PC", goalExecutor([], async (_a, ctx) => {
      ctx.progress?.(sub("act: step one"));
      ran.push("one");
      await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
      if (!ctx.signal.aborted) ran.push("two");
      return { ok: false, said: "Stopped.", verified: false, data: { cancelled: true } };
    }));
    const pending = r.run(mehroz, { utterance: YT });
    expect(await until(() => ran.includes("one"))).toBe(true);
    // The sub-step travels to the hub on its own message: cancel only once the hub has recorded it, so the step assertion below does not depend on which message arrives first.
    expect(await until(() => (job(r, r.service.liveJobs()[0])?.steps ?? []).some((s) => s.intent === "act: step one"))).toBe(true);
    await r.jobs.cancel(r.service.liveJobs()[0]);
    const done = await pending;
    expect(done).toMatchObject({ ok: false, stopped: true });
    expect(ran).toEqual(["one"]);
    expect(await until(() => m.worker.history.some((h) => h.outcome === "cancelled"))).toBe(true);
    const j = job(r, done.jobId)!;
    expect(j.state).toBe("cancelled");
    expect(j.steps[0].intent).toBe("act: step one");
  });

  test("the companion dies mid-goal: uncertain, earlier sub-steps stay in the log, nothing is replayed", async () => {
    const r = await rig();
    let runs = 0;
    const flaky = { down: false };
    const m = await r.pair("mehroz", "Mehroz's PC", goalExecutor([], async (_a, ctx) => {
      runs++;
      ctx.progress?.(sub("act: opened youtube.com"));
      await new Promise<void>(() => undefined);
      return { ok: true, said: "never", verified: true };
    }), { flaky });
    const pending = r.run(mehroz, { utterance: YT });
    expect(await until(() => runs === 1)).toBe(true);
    await until(() => (job(r, r.service.liveJobs()[0])?.steps.length ?? 0) >= 1);
    flaky.down = true;
    await m.worker.stop();
    r.hub.clock.advance(31_000);
    r.hub.svc.dispatcher.sweepOffline();
    const done = await pending;
    expect(done).toMatchObject({ ok: false, outcome: "uncertain", verified: null });
    expect(done.said).toMatch(/can't say whether it happened/);
    const j = job(r, done.jobId)!;
    expect(j.state).not.toBe("succeeded");
    expect(j.steps.map((s) => s.intent)).toContain("act: opened youtube.com");
    expect(runs).toBe(1);
  });

  test("a question back: the job waits, a typed yes cannot approve it, a spoken yes resumes on the SAME device, exactly once", async () => {
    const r = await rig();
    const logA: string[] = [];
    const logB: string[] = [];
    const ask: ExecutorResult = { ok: false, said: "Shall I press Send?", verified: null, data: { ask: true, confirm: "Send", resumeGoal: "write the note and send it" } };
    const exec = (log: string[]) => goalExecutor(log, async (a) => ((a as any).yes === true ? { ok: true, said: "Pressed Send.", verified: true, evidence: "the message is in Sent" } : ask));
    await r.pair("mehroz", "Mehroz's PC", exec(logA), { aliases: ["pc"] });
    const laptop = await r.pair("mehroz", "Mehroz's laptop", exec(logB), { aliases: ["laptop"] });
    await until(() => (r.hub.svc.registry.presenceOf(laptop.deviceId)?.capabilities?.length ?? 0) > 0);
    const first = await r.run(mehroz, { utterance: "write the note and send it", spokenTarget: "my laptop" });
    expect(first).toMatchObject({ ok: false, ask: true, confirm: "Send", targetDeviceId: laptop.deviceId });
    expect(job(r, first.jobId)!.state).toBe("awaiting-approval");
    expect(logB).toEqual(["goal:write the note and send it"]);
    const typed = await r.run(mehroz, { utterance: "yes" });
    expect(typed).toMatchObject({ ok: false, refused: true });
    expect(typed.said).toMatch(/spoken yes/);
    expect(logB).toHaveLength(1);
    const heard = r.ledger.record("yes")!;
    const resumed = await r.run(mehroz, { utterance: "yes", source: "voice", spokenYes: heard.id });
    expect(resumed).toMatchObject({ ok: true, verified: true, targetDeviceId: laptop.deviceId });
    expect(logB).toEqual(["goal:write the note and send it", "goal:write the note and send it"]);
    expect(logA).toEqual([]);
    const again = await r.run(mehroz, { utterance: "yes", source: "voice", spokenYes: heard.id });
    expect(again.ok).toBe(false);
    expect(logB).toHaveLength(2);
  });

  test("a different request after the question drops it: a later yes presses nothing", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", { ...goalExecutor(log, async () => ({ ok: false, said: "Shall I press Send?", verified: null, data: { ask: true, confirm: "Send", resumeGoal: "send it" } })), "app.open": async () => ({ ok: true, said: "Opened Notepad.", verified: true }) });
    await r.run(mehroz, { utterance: "write the note and send it" });
    await r.run(mehroz, { utterance: "open notepad" });
    const heard = r.ledger.record("yes");
    const late = await r.run(mehroz, { utterance: "yes", source: "voice", ...(heard ? { spokenYes: heard.id } : {}) });
    expect(late.ok).toBe(false);
    expect(log).toHaveLength(1); // only the original goal ever ran; the late yes sent nothing
  });
});

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
import { type CommandBody, type CommandDoneEvent, type ExecutorResult } from "./contracts";
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

import { createRecentTargets, resolveSwitch, switchBackIn, targetFrom, type Target } from "./recent-targets";

const T = (kind: "site" | "app", title: string, extra: Partial<Target> = {}, at = 1000): Target => ({ kind, title, at, ...extra });
const example = T("site", "Example Domain", { url: "https://example.com/", targetId: "TAB1" }, 3000);
const yt = T("site", "Sydney weather - YouTube", { url: "https://www.youtube.com/results?search_query=x" }, 2000);
const ppt = T("app", "PowerPoint", { app: "powerpoint", handle: 9 }, 4000);

describe("switchBackIn: which phrases, and what they mean", () => {
  test("site, page, tab and app phrases", () => {
    expect(switchBackIn("switch back to the website we were using")).toMatchObject({ kind: "site", words: [] });
    expect(switchBackIn("go back to that page")).toMatchObject({ kind: "site", words: [] });
    expect(switchBackIn("Jarvis, go back to the youtube tab.")).toMatchObject({ kind: "site", words: ["youtube"] });
    expect(switchBackIn("back to PowerPoint")).toMatchObject({ kind: "app", app: "powerpoint" });
    expect(switchBackIn("switch back to the window we were using")).toMatchObject({ kind: "any" });
  });
  test("songs, slides, steps and unknown things are not ours", () => {
    for (const u of ["go back to the previous song", "go back to slide 3", "back to the start", "switch back to my cat", "open chrome", "go back"]) expect(switchBackIn(u)).toBeNull();
  });
});

describe("resolveSwitch: most recent match that is not in front; ambiguity asks", () => {
  test("the most recent site that is not the current foreground", () => {
    const r = resolveSwitch({ kind: "site", words: [], said: "" }, [ppt, example], { process: "POWERPNT", title: "Presentation1 - PowerPoint" });
    expect(r).toMatchObject({ kind: "resolved", target: { title: "Example Domain" } });
  });
  test("a site recorded by its address is still 'in front' when its page names itself differently (youtube.com vs 'Sydney weather - YouTube')", () => {
    const byAddress: Target = { kind: "site", title: "youtube.com", url: "https://www.youtube.com/", at: 1 };
    expect(resolveSwitch({ kind: "site", words: [], said: "" }, [byAddress], { process: "chrome", title: "Sydney weather - YouTube - Google Chrome for Testing" })).toEqual({ kind: "none", why: "only-current" });
    const r = resolveSwitch({ kind: "site", words: [], said: "" }, [example, byAddress], { process: "chrome", title: "Sydney weather - YouTube - Google Chrome for Testing" });
    expect(r).toMatchObject({ kind: "resolved", target: { title: "Example Domain" } });
  });
  test("what is in front now is never the answer", () => {
    expect(resolveSwitch({ kind: "site", words: [], said: "" }, [example], { process: "chrome", title: "Example Domain - Google Chrome" })).toEqual({ kind: "none", why: "only-current" });
    const r = resolveSwitch({ kind: "site", words: [], said: "" }, [example, yt], { process: "chrome", title: "Example Domain - Google Chrome" });
    expect(r).toMatchObject({ kind: "resolved", target: { title: "Sydney weather - YouTube" } });
  });
  test("two recent websites and words that do not pick one: ambiguous, with both titles; a word that does pick resolves", () => {
    const r = resolveSwitch({ kind: "site", words: [], said: "" }, [example, yt], { process: "POWERPNT", title: "PowerPoint" });
    expect(r).toMatchObject({ kind: "ambiguous" });
    expect((r as any).options.map((o: Target) => o.title)).toEqual(["Example Domain", "Sydney weather - YouTube"]);
    expect(resolveSwitch({ kind: "site", words: ["youtube"], said: "" }, [example, yt], null)).toMatchObject({ kind: "resolved", target: { title: "Sydney weather - YouTube" } });
    expect(resolveSwitch({ kind: "site", words: ["banana"], said: "" }, [example, yt], null)).toEqual({ kind: "none", why: "no-match" });
  });
  test("two pages of the same site are one site; apps resolve by name; nothing recent says so", () => {
    const a = T("site", "Results", { url: "https://www.youtube.com/results?x=1" }, 5000);
    const b = T("site", "A video", { url: "https://www.youtube.com/watch?v=1" }, 4000);
    expect(resolveSwitch({ kind: "site", words: [], said: "" }, [a, b], null)).toMatchObject({ kind: "resolved", target: { title: "Results" } });
    expect(resolveSwitch({ kind: "app", app: "powerpoint", words: [], said: "" }, [example, ppt], { process: "chrome", title: "x" })).toMatchObject({ kind: "resolved", target: { app: "powerpoint" } });
    expect(resolveSwitch({ kind: "app", app: "excel", words: [], said: "" }, [example, ppt], null)).toEqual({ kind: "none", why: "nothing-recent" });
  });
});

describe("the memory: per person and device, verified data only, expiring", () => {
  test("targetFrom reads url/title/app/handle/tab id from verified results only", () => {
    expect(targetFrom("browser.navigate", { url: "https://example.com/", finalUrl: "https://example.com/", title: "Example Domain", targetId: "T1" }, 1)).toMatchObject({ kind: "site", title: "Example Domain", targetId: "T1" });
    expect(targetFrom("app.open", { app: "powerpoint", handle: 7, title: "PowerPoint" }, 1)).toMatchObject({ kind: "app", app: "powerpoint", handle: 7 });
    expect(targetFrom("echo", { url: "https://x.test/" }, 1)).toBeNull();
    expect(targetFrom("app.open", { app: "regedit" }, 1)).toBeNull();
    expect(targetFrom("browser.navigate", { url: "file:///c:/x" }, 1)).toBeNull();
  });
  test("never another person's, never another device's, and it expires", () => {
    let now = 1_000_000;
    const m = createRecentTargets(() => now);
    m.record("usman", "pc1", T("site", "Mine", { url: "https://a.test/" }, now));
    expect(m.list("mehroz", "pc1")).toEqual([]);
    expect(m.list("usman", "pc2")).toEqual([]);
    expect(m.list("usman", "pc1")).toHaveLength(1);
    now += 31 * 60_000;
    expect(m.list("usman", "pc1")).toEqual([]);
  });
});

// ---- through the command service -------------------------------------------------------------------

function pcFor(log: string[], front: () => { process: string; title: string } | null): Record<string, Executor> {
  const res = (said: string, data: Record<string, unknown> = {}): ExecutorResult => ({ ok: true, said, verified: true, evidence: "read back", data });
  return {
    "browser.navigate": async (a) => (log.push(`navigate:${a.url}`), res("Opened.", { url: a.url, finalUrl: a.url, title: a.url === "https://example.com/" ? "Example Domain" : "Sydney weather - YouTube", targetId: `TAB${log.length}` })),
    "app.open": async (a) => (log.push(`open:${a.name}`), res("Opened.", { app: a.name, handle: 9, title: "PowerPoint" })),
    "observe.window": async () => res("front", { foreground: front() }),
    "target.focus": async (a) => (log.push(`focus:${a.kind}:${a.title}`), res(`Switched back to ${a.title}.`, { foreground: true })),
  };
}

describe("switch back through the command service", () => {
  test("open example.com, open PowerPoint, 'switch back to the website we were using' -> focus example.com (verified), via the same device only", async () => {
    const r = await rig();
    const log: string[] = [];
    let front: { process: string; title: string } | null = null;
    const m = await r.pair("mehroz", "Mehroz's PC", pcFor(log, () => front));
    await r.run(mehroz, { utterance: "step plan 1", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    front = { process: "chrome", title: "Example Domain - Google Chrome" };
    await r.run(mehroz, { utterance: "step plan 2", steps: [{ executor: "app.open", args: { name: "powerpoint" } }] });
    front = { process: "POWERPNT", title: "Presentation1 - PowerPoint" };
    const done = await r.run(mehroz, { utterance: "switch back to the website we were using" });
    expect(done).toMatchObject({ ok: true, verified: true, targetDeviceId: m.deviceId });
    expect(log.at(-1)).toBe("focus:site:Example Domain");
    const steps = job(r, done.jobId)!.steps.map((s) => `${s.outcome}|${s.action ?? s.executor}`);
    expect(steps).toEqual(expect.arrayContaining(["ok|observe.window", "ok|target.focus"]));
    // "back to PowerPoint" from the website: the app.
    front = { process: "chrome", title: "Example Domain - Google Chrome" };
    expect((await r.run(mehroz, { utterance: "back to PowerPoint" })).ok).toBe(true);
    expect(log.at(-1)).toBe("focus:app:PowerPoint");
  });
  test("two recent websites and a phrase that doesn't pick one: one short question with both titles, nothing focused; a named one works", async () => {
    const r = await rig();
    const log: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", pcFor(log, () => ({ process: "POWERPNT", title: "PowerPoint" })));
    await r.run(mehroz, { utterance: "step plan 3", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    await r.run(mehroz, { utterance: "step plan 4", steps: [{ executor: "browser.navigate", args: { url: "https://www.youtube.com/" } }] });
    const ask = await r.run(mehroz, { utterance: "go back to that page" });
    expect(ask).toMatchObject({ ok: false, ask: true });
    expect(ask.said).toBe('Which one: "Sydney weather - YouTube" or "Example Domain"?');
    expect(log.filter((l) => l.startsWith("focus"))).toEqual([]);
    expect((await r.run(mehroz, { utterance: "go back to the youtube page" })).ok).toBe(true);
    expect(log.at(-1)).toBe("focus:site:Sydney weather - YouTube");
  });
  test("only this person's targets on this device: Usman never switches back to Mehroz's page, and nothing recent says so", async () => {
    const r = await rig({ role: "cloud" });
    const logM: string[] = [];
    const logU: string[] = [];
    await r.pair("mehroz", "Mehroz's PC", pcFor(logM, () => null));
    await r.pair("usman", "Usman's PC", pcFor(logU, () => null));
    await r.run(mehroz, { utterance: "step plan 5", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    const done = await r.run(usmanAtPc, { utterance: "switch back to the website we were using" });
    expect(done).toMatchObject({ ok: false, refused: true });
    expect(done.said).toContain("anything recent");
    expect(logU.filter((l) => l.startsWith("focus"))).toEqual([]);
    expect(logM.filter((l) => l.startsWith("focus"))).toEqual([]);
  });
  test("a failed focus is not called done; a companion without target.focus leaves the normal path alone", async () => {
    const r = await rig();
    const log: string[] = [];
    const ex = pcFor(log, () => ({ process: "POWERPNT", title: "PowerPoint" }));
    ex["target.focus"] = async () => ({ ok: false, said: "I couldn't find the browser window any more.", verified: false });
    await r.pair("mehroz", "Mehroz's PC", ex);
    await r.run(mehroz, { utterance: "step plan 6", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    const done = await r.run(mehroz, { utterance: "switch back to the website we were using" });
    expect(done.ok).toBe(false);
    expect(done.said).toContain("couldn't find the browser window");
    const r2 = await rig();
    await r2.pair("mehroz", "Mehroz's PC", { echo: async () => ({ ok: true, said: "x", verified: true }) });
    expect((await r2.run(mehroz, { utterance: "switch back to the website we were using" })).refused).toBe(true);
  });
});

describe("switch back to a tab that has since been closed", () => {
  test("the PC says 'that tab was closed'; it is said plainly, the target is forgotten, and nothing else is focused", async () => {
    const r = await rig();
    const log: string[] = [];
    const ex = pcFor(log, () => ({ process: "POWERPNT", title: "PowerPoint" }));
    ex["target.focus"] = async (a) => (log.push(`focus:${String(a.targetId)}`), { ok: false, said: "That tab was closed, so I can't switch back to it.", verified: false, data: { recovery: "tab-closed", tabId: a.targetId } });
    await r.pair("mehroz", "Mehroz's PC", ex);
    await r.run(mehroz, { utterance: "step plan closed 1", steps: [{ executor: "browser.navigate", args: { url: "https://example.com/" } }] });
    const first = await r.run(mehroz, { utterance: "switch back to the website we were using" });
    expect(first.ok).toBe(false);
    expect(first.said).toContain("That tab was closed");
    const again = await r.run(mehroz, { utterance: "go back to that page" });
    expect(again).toMatchObject({ ok: false, refused: true }); // forgotten: nothing recent left to offer
    expect(log.filter((l) => l.startsWith("focus"))).toHaveLength(1);
  });
});

describe("round 3 fixer: the 'switch back' list does not drop the wrong target on a loose host word", () => {
  test("a Docs window in front does not hide mail.google.com from the list, a Gmail-titled one does", () => {
    const mail: Target = { kind: "site", title: "Inbox - Gmail", url: "https://mail.google.com/", at: 2 };
    const notes: Target = { kind: "site", title: "Notes", url: "https://notes.example.org/", at: 1 };
    const docsFront = { process: "chrome", title: "Mail merge plan - Google Docs - Google Chrome" };
    expect(resolveSwitch({ kind: "site", words: [], said: "" }, [mail, notes], docsFront)).toMatchObject({ kind: "ambiguous" });
    const mailFront = { process: "chrome", title: "Inbox - Gmail - Google Chrome" };
    expect(resolveSwitch({ kind: "site", words: [], said: "" }, [mail, notes], mailFront)).toMatchObject({ kind: "resolved", target: notes });
  });
});

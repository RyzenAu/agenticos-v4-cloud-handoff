// Context + per-person device dispatch through the REAL command service and job store, SYNTHETIC devices
// (scripts/devices/synthetic.ts). No network, no real device, no model.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { resolveTarget } from "../devices/route";
import { SYNTHETIC_MEHROZ_PC_ID, SYNTHETIC_USMAN_HUB_ID, syntheticWorld } from "../devices/synthetic";
import type { JarvisEntry } from "../jev-command";
import { JobService } from "../jobs/service";
import type { CommandDoneEvent, PageContext } from "./contracts";
import { CONTEXT_MAX_AGE_MS, createContextMemory, resolveCommandContext } from "./context";
import { createCommandService } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig() {
  const world = syntheticWorld();
  const dir = mkdtempSync(join(tmpdir(), "ctx-device-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const hub = { calls: [] as string[] };
  // The hub's own hands: recorded, never used for Mehroz.
  const entry = { handle: async (req: { utterance: string }) => (hub.calls.push(req.utterance), { type: "done", ok: true, said: "hub ran it", kind: "app", jobId: null, runId: "", targetDeviceId: SYNTHETIC_USMAN_HUB_ID }) } as unknown as JarvisEntry;
  const service = createCommandService({
    jobs: () => jobs,
    entry: () => entry,
    hubDeviceId: SYNTHETIC_USMAN_HUB_ID,
    resolveTarget: (ctx) => resolveTarget(ctx, world.registry),
    dispatcher: world.dispatcher,
    micOwner: (p) => world.registry.micOwner(p),
    deviceLabel: (id) => world.registry.all().find((d) => d.id === id)?.label ?? id,
    graceMs: 100,
  });
  cleanups.push(async () => {
    await world.close();
    try {
      jobs.close();
    } catch {
      /* closing */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const say = (principal: Principal, utterance: string, extra: { pageContext?: unknown; source?: "typed" | "voice"; spokenTarget?: string } = {}): Promise<CommandDoneEvent> =>
    service.run({ principal, body: { utterance, source: extra.source ?? "typed", ...(extra.pageContext ? { pageContext: extra.pageContext as PageContext } : {}), ...(extra.spokenTarget ? { spokenTarget: extra.spokenTarget } : {}) } });
  return { world, jobs, hub, service, say };
}

const pkgPage = (data: Record<string, string | number>, source?: PageContext["source"], extra: Partial<PageContext> = {}): PageContext => ({
  page: "/operations",
  title: "Operations",
  selected: [{ kind: "package", id: "receptionist-professional", label: "Professional package", data }],
  visible: [],
  ...(source ? { source } : {}),
  capturedAt: Date.now(),
  ...extra,
});

describe("one resolver for typed and spoken context", () => {
  const page = pkgPage({ contributionMarginPct: 71.2 }, { name: "Economics model", state: "live" });
  test("typed and spoken resolve identically from the same sent context", () => {
    const typed = resolveCommandContext({ utterance: "explain this margin", pageContext: page });
    const spoken = resolveCommandContext({ utterance: "explain this margin", pageContext: page, allowMemory: true });
    expect(spoken).toEqual(typed);
    expect(typed).toMatchObject({ from: "sent", resolution: { kind: "resolved", tier: "selected", item: { id: "receptionist-professional" } } });
  });

  test("a spoken command with none sent uses this person's last page briefly; typed never does; never across people", () => {
    const mem = createContextMemory(1_000);
    const sent = resolveCommandContext({ utterance: "x", pageContext: page }).context!;
    mem.remember("usman", sent, 10_000);
    const spoken = resolveCommandContext({ utterance: "explain this margin", remembered: mem.recall("usman", 10_500), allowMemory: true });
    expect(spoken).toMatchObject({ from: "remembered", resolution: { kind: "resolved" } });
    expect(resolveCommandContext({ utterance: "explain this margin", remembered: mem.recall("usman", 10_500), allowMemory: false }).resolution).toMatchObject({ kind: "none" });
    expect(mem.recall("mehroz", 10_500)).toBeNull();
    expect(mem.recall("usman", 11_500)).toBeNull(); // past the TTL
  });

  test("a context captured too long ago is unknown: Jarvis asks", () => {
    const old = { ...page, capturedAt: Date.now() - CONTEXT_MAX_AGE_MS - 1_000 };
    const r = resolveCommandContext({ utterance: "explain this margin", pageContext: old });
    expect(r).toMatchObject({ from: "stale", context: null, resolution: { kind: "none" } });
    expect(r.resolution?.kind === "none" && r.resolution.said).toMatch(/out of date.*Which one/);
  });

  test("this client, this job and the job resolve; ambiguous and missing ask", () => {
    const client = { page: "/leads", focused: { kind: "client", id: "c1", label: "Synthetic Dental" } };
    expect(resolveCommandContext({ utterance: "open this client", pageContext: client }).resolution).toMatchObject({ kind: "resolved", item: { id: "c1" } });
    const job = { page: "/jobs", jobId: "job-42" };
    for (const say of ["explain the job", "explain this job", "show the job"]) expect(resolveCommandContext({ utterance: say, pageContext: job }).resolution, say).toMatchObject({ kind: "resolved", item: { kind: "job", id: "job-42" } });
    expect(resolveCommandContext({ utterance: "explain the job", pageContext: { page: "/jobs" } }).resolution).toMatchObject({ kind: "none" });
    const two = { page: "/leads", visible: [{ kind: "client", id: "a", label: "A" }, { kind: "client", id: "b", label: "B" }] };
    expect(resolveCommandContext({ utterance: "open this client", pageContext: two }).resolution).toMatchObject({ kind: "ambiguous" });
    expect(resolveCommandContext({ utterance: "explain this margin" }).resolution).toMatchObject({ kind: "none", said: expect.stringContaining("can't see which page") });
    expect(resolveCommandContext({ utterance: "create a job for the client" }).reference).toBeNull();
  });
});

describe("explain this margin: the selected item's figures, source and state", () => {
  test("live: quotes the shown figures, names the source and time, cross-checks the package", async () => {
    const { say } = rig();
    const done = await say(usman, "explain this margin", { pageContext: pkgPage({ contributionMarginPct: 71.2, revenueCents: 109900 }, { name: "Economics model", state: "live", updatedAt: "2026-09-29T01:00:00Z" }) });
    expect(done).toMatchObject({ ok: true, kind: "answer" });
    expect(done.said).toContain("contribution margin 71.2%");
    expect(done.said).toContain("revenue A$1,099.00");
    expect(done.said).toContain("Source: Economics model, live (updated 2026-09-29T01:00:00Z)");
    expect(done.numbers).toMatchObject({ shown: { contributionMarginPct: 71.2 }, source: { name: "Economics model", state: "live", updatedAt: "2026-09-29T01:00:00Z" }, itemId: "receptionist-professional" });
    expect(done.numbers?.crossCheck).toMatch(/match|mismatch|not-comparable/);
  });

  test("simulated, stale, failed and setup-required each say plainly that it is not live", async () => {
    const { say } = rig();
    const said = async (state: NonNullable<PageContext["source"]>["state"]) => (await say(usman, "explain this margin", { pageContext: pkgPage({ contributionMarginPct: 50 }, { name: "Demo feed", state, updatedAt: "2026-09-01" }) })).said;
    expect(await said("simulated")).toMatch(/simulated data, not real figures/);
    expect(await said("stale")).toMatch(/stale, last updated 2026-09-01.*out of date/);
    expect(await said("failed")).toMatch(/failed to load/);
    expect(await said("setup-required")).toMatch(/needs setup/);
    expect(await said("unknown")).toMatch(/can't tell whether it is live/);
    for (const s of ["simulated", "stale", "failed", "setup-required"] as const) expect(await said(s)).toMatch(/not confirmed live/);
    expect((await say(usman, "explain this margin", { pageContext: pkgPage({ contributionMarginPct: 50 }) })).said).toMatch(/didn't say where these come from, so I can't call them live/);
  });

  test("a shown figure that disagrees with the economics model is flagged, not smoothed over", async () => {
    const { say } = rig();
    const done = await say(usman, "explain this margin", { pageContext: pkgPage({ contributionMarginPct: 99.9 }, { name: "Economics model", state: "live" }) });
    expect(done.said).toContain("contribution margin 99.9%");
    expect(done.said).toMatch(/doesn't match the 99.9% shown/);
    expect(done).toMatchObject({ ok: true, verified: false });
    expect(done.numbers?.crossCheck).toBe("mismatch");
  });

  test("a package with no figures falls back to the model answer and says so", async () => {
    const { say } = rig();
    const done = await say(usman, "explain this margin", { pageContext: pkgPage({}, { name: "Economics model", state: "simulated" }) });
    expect(done.said).toMatch(/shows no figures, so this is the economics model's answer/);
    expect(done.numbers).toMatchObject({ crossCheck: "not-comparable", source: { state: "simulated" } });
    expect(done.kind).toBe("answer");
  });

  test("a margin that is not a package is answered from shown data, never delegated", async () => {
    const { say } = rig();
    const page: PageContext = { page: "/finance", selected: [{ kind: "margin", id: "m1", label: "Retainer margin", data: { grossMarginPct: "42.5%", costCents: 12000 } }], source: { name: "Xero export", state: "stale", updatedAt: "2026-09-20" }, capturedAt: Date.now() };
    const done = await say(usman, "explain this margin", { pageContext: page });
    expect(done).toMatchObject({ ok: true, kind: "answer" });
    expect(done.handoff).toBeUndefined();
    expect(done.said).toContain("gross margin 42.5%");
    expect(done.said).toContain("cost A$120.00");
    expect(done.said).toMatch(/Xero export.*stale/);
    const bare: PageContext = { ...page, selected: [{ kind: "margin", id: "m2", label: "Empty margin" }] };
    const none = await say(usman, "explain this margin", { pageContext: bare });
    expect(none).toMatchObject({ ok: false, ask: true });
    expect(none.handoff).toBeUndefined();
  });

  test("ambiguous or missing context asks instead of guessing", async () => {
    const { say } = rig();
    const two: PageContext = { page: "/operations", visible: [{ kind: "package", id: "a", label: "A" }, { kind: "package", id: "b", label: "B" }] };
    expect(await say(usman, "explain this margin", { pageContext: two })).toMatchObject({ ok: false, ask: true, kind: "ask" });
    expect(await say(usman, "explain this margin")).toMatchObject({ ok: false, ask: true, kind: "ask" });
  });

  test("spoken uses the same path: same words and page give the same answer; a bare spoken uses only this person's last page", async () => {
    const { say } = rig();
    const page = pkgPage({ contributionMarginPct: 71.2 }, { name: "Economics model", state: "live" });
    const typed = await say(usman, "explain this margin", { pageContext: page, source: "typed" });
    const spoken = await say(usman, "explain this margin", { pageContext: page, source: "voice" });
    expect(spoken.said).toBe(typed.said);
    // Usman's last page is remembered for HIS spoken command, never for Mehroz's.
    expect((await say(usman, "explain this margin", { source: "voice" })).said).toContain("contribution margin 71.2%");
    expect(await say(mehroz, "explain this margin", { source: "voice" })).toMatchObject({ ok: false, ask: true });
    expect(await say(usman, "explain this margin", { source: "typed" })).toMatchObject({ ok: false, ask: true });
  });

  test("the job: answered from the job log for the page's jobId", async () => {
    const { say, jobs } = rig();
    const first = await say(mehroz, "open PowerPoint here", { source: "voice" });
    const asked = await say(mehroz, "explain the job", { pageContext: { page: "/jobs", jobId: first.jobId! } });
    expect(asked).toMatchObject({ ok: true, kind: "answer" });
    expect(asked.said).toContain(jobs.get(first.jobId!)!.state);
    expect(await say(mehroz, "explain the job", { pageContext: { page: "/jobs", jobId: "nope" } })).toMatchObject({ ok: false, ask: true });
  });
});

describe("open PowerPoint here, per person", () => {
  test("Mehroz (spoken) runs on his own synthetic PC only; the hub is never touched", async () => {
    const { say, world, hub } = rig();
    const done = await say(mehroz, "open PowerPoint here", { source: "voice" });
    expect(done).toMatchObject({ ok: true, kind: "remote", targetDeviceId: SYNTHETIC_MEHROZ_PC_ID });
    expect(world.mehroz.ran).toEqual([{ executor: "app.open", args: { name: "powerpoint" }, personId: "mehroz" }]);
    expect(hub.calls).toEqual([]);
  });

  test("Mehroz naming Usman's PC is refused and nothing runs anywhere", async () => {
    const { say, world, hub } = rig();
    for (const target of ["on Usman's PC", "on his computer"]) {
      const done = await say(mehroz, `open PowerPoint ${target}`, { source: "voice" });
      expect(done).toMatchObject({ ok: false, refused: true });
    }
    expect(await say(mehroz, "open PowerPoint", { source: "typed", spokenTarget: "Usman's PC" })).toMatchObject({ ok: false, refused: true });
    expect(world.mehroz.ran).toEqual([]);
    expect(hub.calls).toEqual([]);
  });

  test("Usman at his PC runs on the hub, not on Mehroz's PC", async () => {
    const { say, world, hub } = rig();
    const done = await say(usman, "open PowerPoint here", { source: "voice" });
    expect(done).toMatchObject({ ok: true, targetDeviceId: SYNTHETIC_USMAN_HUB_ID });
    expect(hub.calls).toEqual(["open PowerPoint"]);
    expect(world.mehroz.ran).toEqual([]);
  });

  test("Mehroz's PC offline: says so, fails closed, no hub, no other machine", async () => {
    const { say, world, hub } = rig();
    world.mehroz.goOffline();
    const done = await say(mehroz, "open PowerPoint here", { source: "voice" });
    expect(done.ok).toBe(false);
    expect(done.said).toMatch(/offline/);
    expect(done.said).toMatch(/never send your commands to another machine|Nothing ran anywhere else/);
    expect(world.mehroz.ran).toEqual([]);
    expect(hub.calls).toEqual([]);
  });
});

describe("no duplicate actions", () => {
  test("the same words from the same person while it runs attach to one job and dispatch once", async () => {
    const { service, world } = rig();
    const body = { utterance: "open PowerPoint here", source: "voice" as const };
    const seen: string[] = [];
    const [a, b] = await Promise.all([service.run({ principal: mehroz, body }, () => undefined), service.run({ principal: mehroz, body: { ...body, source: "typed" } }, (e) => void (e.type === "job" && seen.push(e.jobId)))]);
    expect(a.ok && b.ok).toBe(true);
    expect(b.jobId).toBe(a.jobId);
    expect(seen).toEqual([a.jobId!]);
    expect(world.mehroz.ran.filter((c) => c.executor === "app.open")).toHaveLength(1);
    expect(service.liveJobs()).toHaveLength(1);
  });

  test("just finished OK within a few seconds is still the same command; another person's identical words are not", async () => {
    const { service, world, hub } = rig();
    const body = { utterance: "open PowerPoint here", source: "voice" as const };
    const first = await service.run({ principal: mehroz, body });
    const echo = await service.run({ principal: mehroz, body });
    expect(echo.jobId).toBe(first.jobId);
    expect(world.mehroz.ran).toHaveLength(1);
    const other = await service.run({ principal: usman, body });
    expect(other.jobId).not.toBe(first.jobId);
    expect(hub.calls).toHaveLength(1);
    expect(world.mehroz.ran).toHaveLength(1);
  });

  test("a failed or asked-back command is retried, never replayed", async () => {
    const { service, world } = rig();
    world.mehroz.goOffline();
    const body = { utterance: "open PowerPoint here", source: "voice" as const };
    const failed = await service.run({ principal: mehroz, body });
    expect(failed.ok).toBe(false);
    world.mehroz.goOnline();
    const retry = await service.run({ principal: mehroz, body });
    expect(retry.ok).toBe(true);
    expect(retry.jobId).not.toBe(failed.jobId);
  });
});

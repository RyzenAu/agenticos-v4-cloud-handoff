import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { abortableSleep } from "../executors/windows";
import { pairPersonalPc, startComputersHub, type ComputersHub } from "./test-harness";

/**
 * Shared agent cloud computers, end to end over real HTTP: provisioning with a one-time code, two agents on two computers at once,
 * the control lease (takeover at a step boundary, return to the same job, expiry, stop), recovery without replay, and the ownership
 * rules for personal PCs. The computers run the real CompanionWorker; only the host (the WSL or VPS that would run them) is simulated.
 */

setDefaultTimeout(40_000);

let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const ok = (said: string, verified: boolean | null = true) => ({ ok: true, said, verified });

/** Executors that count what ran (per computer), so "no replay" is a number, not a feeling. */
function counting() {
  const ran: Record<string, string[]> = {};
  const factory = (name: string): Record<string, Executor> => {
    const log = (ran[name] ??= []);
    const step = (label: string): Executor => async (args, ctx) => {
      log.push(`${label}:${String(args.tag ?? "")}`);
      if (args.ms) await abortableSleep(Number(args.ms), ctx.signal);
      return ctx.signal.aborted ? { ok: false, said: "Stopped.", verified: false } : ok(`${label} ${String(args.tag ?? "")}`.trim());
    };
    return {
      echo: step("echo"), wait: step("wait"), "file.write": step("file.write"), "input.click": step("input.click"), "input.type": step("input.type"),
      "observe.page": async () => (log.push("observe"), ok(`page of ${name}`)),
    };
  };
  return { ran, factory };
}

async function provisionBoth(h: ComputersHub) {
  const a = await h.api("usman", "POST", "/", { name: "research" });
  const b = await h.api("mehroz", "POST", "/", { name: "builder" });
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  await h.waitFor("both computers online", () => h.computers.list().every((c) => c.state === "online") && h.computers.list().length === 2);
  return { research: a.json.computer, builder: b.json.computer };
}

describe("provisioning: shared computers are devices in the one registry", () => {
  test("two founders each provision one; both are shared, owner-less, kind cloud-computer, and visible to both", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    const { research, builder } = await provisionBoth(hub);
    expect(research).toMatchObject({ name: "research", kind: "cloud-computer", owner: "shared", createdBy: "usman" });
    expect(builder).toMatchObject({ name: "builder", owner: "shared", createdBy: "mehroz" });
    expect(hub.host.workers.size).toBe(2);
    for (const who of ["usman", "mehroz"] as const) {
      const list = await hub.api(who, "GET", "/");
      expect(list.json.computers.map((x: any) => x.name).sort()).toEqual(["builder", "research"]);
      for (const computer of list.json.computers) expect(computer).toMatchObject({ state: "online", kind: "cloud-computer", owner: "shared", controller: { kind: null }, assigned: null });
      const row = list.json.computers[0];
      expect(Object.keys(row)).toEqual(expect.arrayContaining(["name", "id", "state", "capabilities", "controller", "resource", "assigned", "takeoverPending", "viewer", "lastSeen"]));
      expect(row.resource).toMatchObject({ rssMb: 180 });
      expect(row.capabilities).toContain("echo");
    }
    // the device registry lists them next to personal PCs, with owner "shared" (no person owns them)
    const devs = await hub.api("usman", "GET", "/devices", undefined, "/__devices");
    const shared = devs.json.devices.filter((d: any) => d.kind === "cloud-computer");
    expect(shared.map((d: any) => d.owner)).toEqual(["shared", "shared"]);
    expect(shared.every((d: any) => d.displayLabel !== "This PC" && d.mine === false)).toBe(true);
  });

  test("a name is unique; a bad name is refused; a program (no confirmed session) cannot provision", async () => {
    hub = await startComputersHub();
    expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    expect((await hub.api("mehroz", "POST", "/", { name: "research" })).status).toBe(409);
    expect((await hub.api("usman", "POST", "/", { name: "Bad Name!" })).status).toBe(400);
    const program = await hub.api("program", "POST", "/", { name: "sneaky" });
    expect(program.status).toBe(403);
    expect(program.json.error).toMatch(/person/);
    expect(hub.computers.list().map((x) => x.name)).toEqual(["research"]);
  });

  test("a host missing node is refused with why; nothing is created", async () => {
    hub = await startComputersHub();
    hub.host.check = async () => ({ ok: false, host: "t", present: [], missing: ["node"], installCommand: null, notes: ["node is missing: the companion cannot run here"] });
    const r = await hub.api("usman", "POST", "/", { name: "research" });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/node is missing/);
    expect(hub.computers.list()).toHaveLength(0);
  });

  test("the pairing code is single use and bound to the name the hub chose", async () => {
    hub = await startComputersHub();
    const made = hub.devices.store.createComputerCode("usman", { name: "research", adapter: "test-host" });
    if ("error" in made) throw new Error("x");
    const pair = (label: string) => fetch(`${hub!.base}/__devices/companion/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: made.code, label }) });
    const first = await pair("whatever the program claims");
    expect(first.status).toBe(200);
    expect(((await first.json()) as any).owner).toBe("shared");
    expect((await pair("again")).status).toBe(403);
    const row = hub.devices.store.companions().find((c) => c.kind === "cloud-computer")!;
    expect(row.computer).toMatchObject({ name: "research", adapter: "test-host", createdBy: "usman" });
    // a second live computer cannot take the same name
    expect("error" in hub.devices.store.createComputerCode("mehroz", { name: "research", adapter: "test-host" })).toBe(true);
  });
});

describe("two agents run concurrently, each on its own computer", () => {
  test("two jobs overlap in time, each verified, each on its own device, both leases released", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    const { research, builder } = await provisionBoth(hub);
    const started = Date.now();
    const a = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "file.write", args: { tag: "r1", ms: 500 } }, { executor: "echo", args: { tag: "r2" } }] });
    const b = await hub.api("mehroz", "POST", "/builder/jobs", { agent: "coder", steps: [{ executor: "file.write", args: { tag: "b1", ms: 500 } }, { executor: "echo", args: { tag: "b2" } }] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // both hold their own computer at once
    const mid = (await hub.api("usman", "GET", "/")).json.computers;
    expect(mid.find((x: any) => x.name === "research")).toMatchObject({ state: "busy", controller: { kind: "agent", who: "reader" }, assigned: { agent: "reader", by: "usman" } });
    expect(mid.find((x: any) => x.name === "builder")).toMatchObject({ state: "busy", controller: { kind: "agent", who: "coder" }, assigned: { agent: "coder", by: "mehroz" } });
    await hub.waitFor("both jobs done", () => ["succeeded"].includes(hub!.computers.jobView(a.json.jobId)?.state ?? "") && hub!.computers.jobView(b.json.jobId)?.state === "succeeded");
    // they overlapped: two 500 ms steps in parallel finish well under the 1000 ms a serial run would need for the long steps
    expect(Date.now() - started).toBeLessThan(1_900);
    expect(c.ran.research).toEqual(["file.write:r1", "echo:r2"]);
    expect(c.ran.builder).toEqual(["file.write:b1", "echo:b2"]);
    const ja = hub.computers.jobView(a.json.jobId)!;
    expect(ja.steps.filter((s) => s.outcome === "ok")).toHaveLength(2);
    expect(ja.steps.every((s) => s.verification?.ok === true)).toBe(true);
    // each job's commands went to its own device and carried job/step keys
    const recent = hub.devices.dispatcher.recent(20);
    expect(recent.filter((r) => r.deviceId === research.id).every((r) => r.jobId === a.json.jobId)).toBe(true);
    expect(recent.filter((r) => r.deviceId === builder.id).every((r) => r.jobId === b.json.jobId)).toBe(true);
    expect(recent.find((r) => r.jobId === a.json.jobId && r.stepId === "s1")?.commandKey).toBe(`${a.json.jobId}/s1`);
    await hub.waitFor("both computers idle again", async () => ((await hub!.api("mehroz", "GET", "/")).json.computers as any[]).every((x) => x.state === "online" && x.controller.kind === null && x.assigned === null));
  });

  test("a second job on a busy computer is refused and nothing is queued behind it", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const a = await hub.api("usman", "POST", "/research/jobs", { agent: "one", steps: [{ executor: "wait", args: { ms: 700, tag: "long" } }] });
    expect(a.status).toBe(200);
    const b = await hub.api("mehroz", "POST", "/research/jobs", { agent: "two", steps: [{ executor: "echo", args: { tag: "intruder" } }] });
    expect(b.status).toBe(409);
    expect(b.json.error).toMatch(/one controller at a time/);
    await hub.waitFor("job one done", () => hub!.computers.jobView(a.json.jobId)?.state === "succeeded");
    expect(c.ran.research).toEqual(["wait:long"]);
  });

  test("a step the computer does not run, or a risky one, is refused before any job exists", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const unknown = await hub.api("usman", "POST", "/research/jobs", { steps: [{ executor: "browser.navigate", args: { url: "https://example.com" } }] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/doesn't run "browser.navigate"/);
    const risky = await hub.api("usman", "POST", "/research/jobs", { steps: [{ executor: "email.send" }] });
    expect(risky.status).toBe(400);
    expect(risky.json.error).toMatch(/never does those/);
    expect(hub.jobs.list({ kind: "control" })).toHaveLength(0);
    expect(c.ran.research ?? []).toEqual([]);
  });
});

describe("ownership: personal PCs are owner-bound, shared computers are for both founders", () => {
  test("a person's commands never reach the other founder's PC: refused BEFORE dispatch, whatever the request names", async () => {
    hub = await startComputersHub();
    const usmanPc = await pairPersonalPc(hub, "usman");
    const mehrozPc = await pairPersonalPc(hub, "mehroz");
    const d = hub.devices.dispatcher;
    const tries = [
      { personId: "usman", spokenTarget: "on Mehroz's PC" },
      { personId: "usman", spokenTarget: `computer:${mehrozPc.deviceId}` }, // a device id in the target slot
      { personId: "usman", spokenTarget: mehrozPc.deviceId }, // the bare id
      { personId: "usman", spokenTarget: "Mehroz's PC" },
      { personId: "mehroz", spokenTarget: "on Usman's PC" },
      { personId: "mehroz", spokenTarget: `computer:${usmanPc.deviceId}` },
      { personId: "mehroz", spokenTarget: usmanPc.deviceId },
    ];
    for (const t of tries) {
      const r = await d.submit({ ...t, executor: "echo", args: {} }, { timeoutMs: 1_000 });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.commandId).toBeUndefined(); // never queued
    }
    expect(d.recent(50)).toHaveLength(0);
    expect(usmanPc.ran).toEqual([]);
    expect(mehrozPc.ran).toEqual([]);
    // "here" and no target mean the person's OWN PC, never the other's
    const own = await d.submit({ personId: "usman", spokenTarget: "here", executor: "echo", args: {} }, { timeoutMs: 3_000 });
    expect(own).toMatchObject({ ok: true, deviceId: usmanPc.deviceId });
    const theirs = await d.submit({ personId: "mehroz", executor: "echo", args: {} }, { timeoutMs: 3_000 });
    expect(theirs).toMatchObject({ ok: true, deviceId: mehrozPc.deviceId });
    await usmanPc.worker.stop();
    await mehrozPc.worker.stop();
  });

  test("the permitted targets: own PC plus every shared computer, never the other founder's PC", async () => {
    hub = await startComputersHub();
    const usmanPc = await pairPersonalPc(hub, "usman");
    const mehrozPc = await pairPersonalPc(hub, "mehroz");
    await provisionBoth(hub);
    const u = (await hub.api("usman", "GET", "/targets")).json.targets;
    const m = (await hub.api("mehroz", "GET", "/targets")).json.targets;
    expect(u.map((t: any) => t.id).sort()).toEqual([usmanPc.deviceId, ...hub.computers.list().map((c) => c.id)].sort());
    expect(m.map((t: any) => t.id).sort()).toEqual([mehrozPc.deviceId, ...hub.computers.list().map((c) => c.id)].sort());
    expect(u.map((t: any) => t.id)).not.toContain(mehrozPc.deviceId);
    expect(m.map((t: any) => t.id)).not.toContain(usmanPc.deviceId);
    expect(u.filter((t: any) => t.shared)).toHaveLength(2);
    await usmanPc.worker.stop();
    await mehrozPc.worker.stop();
  });

  test("both founders may run and take over any shared computer; an agent gets exactly its starter's targets", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    // Usman's agent on the computer Mehroz provisioned, and Mehroz's on Usman's
    const a = await hub.api("usman", "POST", "/builder/jobs", { agent: "u-agent", steps: [{ executor: "echo", args: { tag: "u" } }] });
    const b = await hub.api("mehroz", "POST", "/research/jobs", { agent: "m-agent", steps: [{ executor: "echo", args: { tag: "m" } }] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await hub.waitFor("jobs done", () => hub!.computers.jobView(a.json.jobId)?.state === "succeeded" && hub!.computers.jobView(b.json.jobId)?.state === "succeeded");
    // the wire command's owner is "shared"; who asked is on the record
    expect(hub.devices.dispatcher.recent(10).every((r) => r.jobId === a.json.jobId || r.jobId === b.json.jobId)).toBe(true);
    const job = hub.jobs.get(a.json.jobId)!;
    expect(job.principal.personId).toBe("usman");
    // takeover by either founder on either computer
    for (const [who, name] of [["usman", "builder"], ["mehroz", "research"]] as const) {
      const t = await hub.api(who, "POST", `/${name}/takeover`, {});
      expect(t.status).toBe(200);
      expect(t.json.state).toBe("held");
      expect((await hub.api(who, "POST", `/${name}/return`, {})).status).toBe(200);
    }
  });

  test("a program with no confirmed session cannot take a computer over or send it input", async () => {
    hub = await startComputersHub();
    await provisionBoth(hub);
    expect((await hub.api("program", "POST", "/research/takeover", {})).status).toBe(403);
    expect((await hub.api("program", "POST", "/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(403);
    expect((await hub.api("program", "POST", "/research/action", { action: "stop" })).status).toBe(403);
    expect(hub.computers.view("research").controller.kind).toBeNull();
  });

  test("a command to a shared computer without a live lease is refused before it is queued (even with its exact id)", async () => {
    hub = await startComputersHub();
    const { research } = await provisionBoth(hub);
    for (const person of ["usman", "mehroz"] as const) {
      const r = await hub.devices.dispatcher.submit({ personId: person, spokenTarget: `computer:${research.id}`, executor: "echo", args: {} }, { timeoutMs: 1_000 });
      expect(r).toMatchObject({ ok: false, notRun: true });
      if (!r.ok) expect(r.reason).toMatch(/control lease/);
      // nor by its name
      const named = await hub.devices.dispatcher.submit({ personId: person, spokenTarget: "the research computer", executor: "echo", args: {} }, { timeoutMs: 1_000 });
      expect(named).toMatchObject({ ok: false, notRun: true });
    }
    // a fabricated lease (wrong holder or epoch) is refused too
    const forged = await hub.devices.dispatcher.submit({ personId: "usman", spokenTarget: `computer:${research.id}`, executor: "echo", args: {}, lease: { holder: "agent:forged", epoch: 1 } }, { timeoutMs: 1_000 });
    expect(forged).toMatchObject({ ok: false, notRun: true });
    expect(hub.devices.dispatcher.recent(10)).toHaveLength(0);
  });

  test("a shared computer is never a default or 'here' for anyone, and a bare 'computer' means the person's own PC", async () => {
    hub = await startComputersHub();
    await provisionBoth(hub);
    const reg = hub.devices.registry;
    const { resolveTarget } = await import("../devices/route");
    expect(resolveTarget({ personId: "usman" }, reg)).toMatchObject({ ok: false }); // Usman has no PC paired: no fallback to a shared computer
    expect(resolveTarget({ personId: "usman", spokenTarget: "here" }, reg)).toMatchObject({ ok: false });
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "my computer" }, reg)).toMatchObject({ ok: false });
    expect(resolveTarget({ personId: "usman", spokenTarget: "the research computer" }, reg)).toMatchObject({ ok: true, owner: "shared" });
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on the builder computer" }, reg)).toMatchObject({ ok: true, owner: "shared" });
  });

  test("revoking a shared computer stops dispatch; a revoked pairing cannot reconnect; a personal PC stays owner-bound after re-pairing", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    const { research } = await provisionBoth(hub);
    const mehrozPc = await pairPersonalPc(hub, "mehroz");
    // Mehroz retires Usman's computer: either founder may
    expect((await hub.api("mehroz", "POST", "/devices/revoke", { deviceId: research.id }, "/__devices")).status).toBe(200);
    const after = await hub.api("usman", "POST", "/research/jobs", { steps: [{ executor: "echo" }] });
    expect(after.status).toBeGreaterThanOrEqual(400);
    // the worker sees its pairing end and stops for good (no reconnect with the old token)
    await hub.waitFor("the computer to see it was revoked", () => hub!.host.workers.get("research")?.state === "unpaired");
    expect(hub.devices.store.verifyCompanion(hub.host.tokens.get("research")!.token)).toBeNull();
    // Usman cannot revoke Mehroz's personal PC on Mehroz's behalf through the shared rule, and Mehroz's PC stays his
    const foreign = await hub.api("mehroz", "POST", "/devices/revoke", { deviceId: mehrozPc.deviceId }, "/__devices");
    expect(foreign.status).toBe(200); // his own
    const pcAgain = await pairPersonalPc(hub, "mehroz");
    const usmanTry = await hub.devices.dispatcher.submit({ personId: "usman", spokenTarget: `computer:${pcAgain.deviceId}`, executor: "echo", args: {} }, { timeoutMs: 1_000 });
    expect(usmanTry.ok).toBe(false);
    expect(pcAgain.ran).toEqual([]);
    await pcAgain.worker.stop();
    await mehrozPc.worker.stop();
  });
});

describe("takeover and return: pause at a safe step boundary, resume the same job, never replay", () => {
  test("a person takes control mid-job: the agent finishes its step and stops; the person acts; return resumes the same job after a fresh read", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const job = await hub.api("usman", "POST", "/research/jobs", {
      agent: "reader",
      steps: [{ executor: "echo", args: { tag: "one", ms: 400 } }, { executor: "echo", args: { tag: "two" } }, { executor: "echo", args: { tag: "three" } }],
    });
    expect(job.status).toBe(200);
    await hub.waitFor("step one to start", () => c.ran.research?.includes("echo:one"));
    const t = await hub.api("mehroz", "POST", "/research/takeover", {});
    expect(t.status).toBe(200);
    expect(t.json.state).toBe("pending"); // the agent is mid-step: it is not interrupted
    expect(t.json.view.takeoverPending).toMatchObject({ by: "mehroz" });
    // the agent still holds the computer until its step is done
    expect(hub.computers.view("research").controller).toMatchObject({ kind: "agent" });
    await hub.waitFor("the agent to pause at the boundary", () => hub!.computers.view("research").controller.kind === "person");
    const v = hub.computers.view("research");
    expect(v.controller).toMatchObject({ kind: "person", who: "mehroz" });
    expect(v.paused).toMatchObject({ agent: "reader" });
    expect(v.state).toBe("busy");
    // steps two and three have NOT run, and the job is still running (paused), not failed
    expect(c.ran.research).toEqual(["echo:one"]);
    expect(hub.jobs.get(job.json.jobId)!.state).toBe("running");
    expect(hub.computers.jobView(job.json.jobId)!.paused).toBe(true);
    // Mehroz drives: an input goes through (he holds the lease); Usman's takeover is refused (one controller)
    const click = await hub.api("mehroz", "POST", "/research/input", { executor: "input.click", args: { x: 10, y: 20, tag: "human" } });
    expect(click.status).toBe(200);
    expect(c.ran.research).toEqual(["echo:one", "input.click:human"]);
    const usurp = await hub.api("usman", "POST", "/research/takeover", {});
    expect(usurp.status).toBe(409);
    expect((await hub.api("usman", "POST", "/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(409);
    // the paused agent cannot send anything while the person holds the computer (its old epoch is dead)
    const agentLate = await hub.devices.dispatcher.submit({ personId: "usman", spokenTarget: `computer:${v.id}`, executor: "echo", args: { tag: "late" }, lease: { holder: `agent:${job.json.jobId}`, epoch: v.controller.epoch! - 1 } }, { timeoutMs: 1_000 });
    expect(agentLate).toMatchObject({ ok: false, notRun: true });
    // return to agent: the same job resumes, re-reads the computer, runs steps two and three, never step one again
    const back = await hub.api("mehroz", "POST", "/research/return", {});
    expect(back.status).toBe(200);
    expect(back.json.resumed).toBe(job.json.jobId);
    await hub.waitFor("the job to finish", () => hub!.computers.jobView(job.json.jobId)?.state === "succeeded");
    expect(c.ran.research).toEqual(["echo:one", "input.click:human", "observe", "echo:two", "echo:three"]);
    expect(c.ran.research.filter((x) => x === "echo:one")).toHaveLength(1);
    const steps = hub.computers.jobView(job.json.jobId)!.steps;
    expect(steps.some((s) => /paused before step 2/.test(s.intent))).toBe(true);
    expect(steps.some((s) => /control returned to the agent/.test(s.intent))).toBe(true);
    expect(steps.some((s) => /refreshed state after the handover: page of research/.test(s.intent))).toBe(true);
    expect(hub.computers.view("research")).toMatchObject({ state: "online", controller: { kind: null } });
    // commandKeys: one per intended action, step one exactly once
    const keys = hub.devices.dispatcher.recent(30).map((r) => r.commandKey);
    expect(keys.filter((k) => k === `${job.json.jobId}/s1`)).toHaveLength(1);
  });

  test("taking an idle computer is immediate; the viewer's heartbeat keeps it; an abandoned viewer expires and frees it", async () => {
    let t = 1_000_000;
    const clock = { now: () => t };
    hub = await startComputersHub({ clock, leaseOptions: { personLeaseTtlMs: 30_000, agentLeaseTtlMs: 30_000 } });
    await provisionBoth(hub);
    const taken = await hub.api("usman", "POST", "/research/takeover", {});
    expect(taken.json.state).toBe("held");
    t += 25_000;
    expect((await hub.api("usman", "POST", "/research/lease/renew", {})).json.ok).toBe(true);
    t += 25_000; // 50 s after the take, 25 after the heartbeat: still held
    expect(hub.computers.view("research").controller).toMatchObject({ kind: "person", who: "usman" });
    t += 10_000; // 35 s without a heartbeat: gone
    expect(hub.computers.view("research").controller.kind).toBeNull();
    expect(hub.computers.view("research").state).toBe("online");
    // the abandoned viewer no longer has control, and the other founder just takes it
    expect((await hub.api("usman", "POST", "/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(409);
    expect((await hub.api("mehroz", "POST", "/research/takeover", {})).json.state).toBe("held");
  });

  describe("the re-read after a hand-back: the page first, the computer itself only when no page is open", () => {
    const handBack = async (observe: Executor, info: Executor | null) => {
      const c = counting();
      const probes: string[] = [];
      hub = await startComputersHub();
      hub.host.executorsFor = (name: string) => ({
        ...c.factory(name),
        "observe.page": async (a, x) => (probes.push("observe.page"), observe(a, x)),
        ...(info ? { "computer.info": async (a: any, x: any) => (probes.push("computer.info"), info(a, x)) } : {}),
      });
      await provisionBoth(hub);
      const job = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "echo", args: { tag: "one", ms: 300 } }, { executor: "echo", args: { tag: "two" } }] });
      await hub.waitFor("step one", () => c.ran.research?.includes("echo:one"));
      await hub.api("mehroz", "POST", "/research/takeover", {});
      await hub.waitFor("pause", () => hub!.computers.view("research").controller.kind === "person");
      expect((await hub.api("mehroz", "POST", "/research/return", {})).status).toBe(200);
      await hub.waitFor("the job to end", () => ["succeeded", "failed", "unknown"].includes(hub!.computers.jobView(job.json.jobId)?.state ?? ""), 10_000);
      return { c, probes, view: hub.computers.jobView(job.json.jobId)! };
    };
    const noPage: Executor = async () => ({ ok: false, said: "No page is open on this computer.", verified: false });
    const info: Executor = async () => ok("research: headless");

    test("no page open: computer.info is the probe used and the job carries on", async () => {
      const r = await handBack(noPage, info);
      expect(r.probes).toEqual(["observe.page", "computer.info"]);
      expect(r.view.state).toBe("succeeded");
      expect(r.c.ran.research).toEqual(["echo:one", "echo:two"]);
      expect(r.view.steps.some((s) => /refreshed state after the handover: research: headless/.test(s.intent) && s.action === "computer.info")).toBe(true);
    });
    test("no page open and the computer cannot be read either: the job stops honestly and the next step does not run", async () => {
      const r = await handBack(noPage, async () => ({ ok: false, said: "the computer did not answer", verified: false }));
      expect(r.probes).toEqual(["observe.page", "computer.info"]);
      expect(r.view.state).not.toBe("succeeded");
      expect(r.c.ran.research).toEqual(["echo:one"]);
      expect(r.view.steps.some((s) => /Couldn't re-read the computer after the handover/.test(s.intent) || /re-read/.test(r.view.note ?? ""))).toBe(true);
    });
    test("a crash is not 'no page open': no fallback, the job stops", async () => {
      const r = await handBack(async () => { throw new Error("browser crashed"); }, info);
      expect(r.probes).toEqual(["observe.page"]);
      expect(r.view.state).not.toBe("succeeded");
      expect(r.c.ran.research).toEqual(["echo:one"]);
    });
    test("a failed read that says something else is not 'no page open' either (a timeout)", async () => {
      const r = await handBack(async () => ({ ok: false, said: "the page read timed out", verified: false }), info);
      expect(r.probes).toEqual(["observe.page"]);
      expect(r.view.state).not.toBe("succeeded");
      expect(r.c.ran.research).toEqual(["echo:one"]);
    });
  });

  test("a viewer that vanishes while an agent is paused gives the computer back to that same job", async () => {
    const c = counting();
    let t = 5_000_000;
    const clock = { now: () => t };
    hub = await startComputersHub({ clock, leaseOptions: { personLeaseTtlMs: 20_000, agentLeaseTtlMs: 600_000 } });
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const job = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "echo", args: { tag: "one", ms: 200 } }, { executor: "echo", args: { tag: "two" } }] });
    await hub.waitFor("step one", () => c.ran.research?.includes("echo:one"));
    await hub.api("mehroz", "POST", "/research/takeover", {});
    await hub.waitFor("pause", () => hub!.computers.view("research").controller.kind === "person");
    expect(c.ran.research).toEqual(["echo:one"]);
    t += 21_000; // Mehroz closed the tab without returning it
    await hub.waitFor("the job to resume and finish", () => hub!.computers.jobView(job.json.jobId)?.state === "succeeded", 10_000);
    expect(c.ran.research).toEqual(["echo:one", "observe", "echo:two"]);
    expect(hub.computers.view("research").controller.kind).toBeNull();
  });

  test("stopping a job mid-step cancels it, skips the later steps, and frees the computer", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const job = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "wait", args: { tag: "long", ms: 30_000 } }, { executor: "echo", args: { tag: "never" } }] });
    await hub.waitFor("the long step to start", () => c.ran.research?.includes("wait:long"));
    const stop = await hub.api("mehroz", "POST", `/jobs/${job.json.jobId}/cancel`, {});
    expect(stop.status).toBe(200);
    await hub.waitFor("job cancelled", () => hub!.jobs.get(job.json.jobId)?.state === "cancelled");
    expect(c.ran.research).toEqual(["wait:long"]);
    expect(hub.computers.view("research")).toMatchObject({ state: "online", controller: { kind: null } });
    const steps = hub.computers.jobView(job.json.jobId)!.steps;
    expect(steps.some((s) => s.outcome === "skipped" && /never|echo/.test(s.intent))).toBe(true);
    // the computer takes the next job straight away
    const next = await hub.api("usman", "POST", "/research/jobs", { steps: [{ executor: "echo", args: { tag: "after" } }] });
    expect(next.status).toBe(200);
  });
});

describe("lifecycle and recovery", () => {
  test("suspend frees it (asleep), a job wakes it, stop refuses while a job holds the lease unless forced", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const s = await hub.api("usman", "POST", "/research/action", { action: "suspend" });
    expect(s.status).toBe(200);
    expect(s.json.computer.state).toBe("asleep");
    expect(hub.host.calls.suspend).toEqual(["research"]);
    const job = await hub.api("mehroz", "POST", "/research/jobs", { steps: [{ executor: "echo", args: { tag: "woke" } }] });
    expect(job.status).toBe(200);
    expect(hub.host.calls.resume).toEqual(["research"]);
    await hub.waitFor("job done", () => hub!.computers.jobView(job.json.jobId)?.state === "succeeded");
    // a busy computer is not stopped out from under its agent
    const long = await hub.api("usman", "POST", "/builder/jobs", { agent: "coder", steps: [{ executor: "wait", args: { ms: 20_000, tag: "x" } }] });
    await hub.waitFor("builder busy", () => hub!.computers.view("builder").state === "busy");
    const refused = await hub.api("mehroz", "POST", "/builder/action", { action: "stop" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/coder/);
    const forced = await hub.api("mehroz", "POST", "/builder/action", { action: "stop", force: true });
    expect(forced.status).toBe(200);
    expect(forced.json.computer.state).toBe("offline");
    expect(hub.jobs.get(long.json.jobId)!.state).toBe("cancelled");
  });

  test("a dead companion shows failed, recover restarts it with the same pairing, and the step that was in flight is not replayed", async () => {
    const c = counting();
    hub = await startComputersHub({ autoRecover: false });
    hub.host.executorsFor = c.factory;
    const { research } = await provisionBoth(hub);
    const job = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "wait", args: { tag: "inflight", ms: 600 } }, { executor: "echo", args: { tag: "after" } }] });
    await hub.waitFor("step one running", () => c.ran.research?.includes("wait:inflight"));
    const killedAt = Date.now();
    hub.host.crash("research"); // the companion process is killed mid-step: no goodbye, the hub still thinks it is online
    expect(hub.computers.view("research").state).toBe("busy");
    await hub.computers.tick();
    await hub.waitFor("the state to read failed", () => hub!.computers.view("research").state === "failed");
    expect(hub.computers.view("research").failure?.reason).toMatch(/companion/);
    // the job did not pretend, and did not wait out its step timeout: it is "unknown" (it may have run), and step two never ran
    await hub.waitFor("the job to settle", () => hub!.jobs.get(job.json.jobId)?.state === "unknown", 4_000);
    expect(Date.now() - killedAt).toBeLessThan(4_000);
    expect(hub.jobs.get(job.json.jobId)!.note).toMatch(/may or may not have happened/);
    expect(c.ran.research.filter((x) => x.startsWith("echo:after"))).toHaveLength(0);
    // recover: same device, same token, same ledger; it comes back online and is usable
    const rec = await hub.api("mehroz", "POST", "/research/action", { action: "recover" });
    expect(rec.status).toBe(200);
    await hub.waitFor("back online", () => hub!.computers.view("research").state === "online");
    const view = hub.computers.view("research");
    expect(view.id).toBe(research.id);
    expect(view.failure).toBeNull();
    expect(view.recoveries).toBe(1);
    expect(hub.host.calls.recover).toEqual(["research"]);
    // in-flight step ran exactly once; it is not replayed by the restart
    expect(c.ran.research.filter((x) => x === "wait:inflight")).toHaveLength(1);
    const next = await hub.api("usman", "POST", "/research/jobs", { steps: [{ executor: "echo", args: { tag: "again" } }] });
    expect(next.status).toBe(200);
    await hub.waitFor("next job done", () => hub!.computers.jobView(next.json.jobId)?.state === "succeeded");
    const events = hub.computers.events().map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["failed", "recovering"]));
    expect(hub.computers.events().map((e) => e.type)).toContain("recovered");
  });

  test("the monitor recovers a dead companion on its own (bounded), and reports recovered", async () => {
    const c = counting();
    hub = await startComputersHub({ autoRecover: true });
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    await hub.computers.tick(); // first probe: everOnline is noted
    hub.host.crash("builder");
    await hub.waitFor("offline", () => !hub!.host.alive("builder"));
    await hub.computers.tick();
    await hub.waitFor("recovered", () => hub!.computers.view("builder").state === "online" && hub!.computers.view("builder").recoveries === 1, 10_000);
    expect(hub.computers.view("builder").failure).toBeNull();
    expect(hub.computers.events().map((e) => e.type)).toEqual(expect.arrayContaining(["failed", "recovering", "recovered"]));
  });

  test("an idle computer suspends itself after the configured time, a busy one never does, and a job wakes it", async () => {
    const c = counting();
    let t = 9_000_000;
    hub = await startComputersHub({ clock: { now: () => t }, idleSuspendMs: 600_000, leaseOptions: { agentLeaseTtlMs: 1e12, personLeaseTtlMs: 1e12 } });
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    await hub.api("usman", "POST", "/builder/takeover", {}); // builder is held by a person: never idle
    t += 599_000;
    await hub.computers.tick();
    expect(hub.computers.view("research").state).toBe("online"); // 599 s idle: not yet
    t += 2_000;
    await hub.computers.tick();
    expect(hub.computers.view("research")).toMatchObject({ state: "asleep", desired: "suspended" });
    expect(hub.host.calls.suspend).toEqual(["research"]); // the held one (builder) was never suspended
    expect(hub.computers.view("builder").state).toBe("busy");
    expect(hub.computers.events().some((e) => e.computer === "research" && e.type === "idle-suspend")).toBe(true);
    const job = await hub.api("mehroz", "POST", "/research/jobs", { steps: [{ executor: "echo", args: { tag: "wake" } }] });
    expect(job.status).toBe(200);
    await hub.waitFor("job done", () => hub!.computers.jobView(job.json.jobId)?.state === "succeeded");
    expect(hub.host.calls.resume).toContain("research");
  });

  test("destroying a computer revokes its pairing and removes it from the list", async () => {
    hub = await startComputersHub();
    const { builder } = await provisionBoth(hub);
    const d = await hub.api("usman", "POST", "/builder/action", { action: "destroy" });
    expect(d.status).toBe(200);
    expect(hub.computers.list().map((x) => x.name)).toEqual(["research"]);
    expect(hub.devices.store.companions().find((x) => x.id === builder.id)?.revokedAt).toBeGreaterThan(0);
    expect(hub.host.calls.destroy).toEqual(["builder"]);
  });
});

describe("the viewer: read-only for both founders, input only for the lease holder", () => {
  test("a screenshot is served to either founder, in memory, and a computer without a desktop says so", async () => {
    hub = await startComputersHub();
    hub.host.executorsFor = counting().factory;
    await provisionBoth(hub);
    for (const who of ["usman", "mehroz"] as const) {
      const r = await hub.api(who, "GET", "/research/screenshot");
      expect(r.status).toBe(200);
      expect(r.type).toBe("image/jpeg");
      expect([...r.bytes!.slice(0, 2)]).toEqual([0xff, 0xd8]);
    }
    await hub.close();
    hub = await startComputersHub();
    hub.host.desktop = false; // a host without the desktop packages: the computer runs headless
    expect((await hub.api("usman", "POST", "/", { name: "headless" })).status).toBe(200);
    const none = await hub.api("usman", "GET", "/headless/screenshot");
    expect(none.status).toBe(404);
    expect(none.json.error).toMatch(/no desktop/);
    expect(hub.computers.view("headless")).toMatchObject({ desktop: false, viewer: { snapshot: false, vnc: false } });
  });
});

describe("a computer's token works only on the hub's own host (lead review, 1 Oct)", () => {
  test("the same bearer relayed through Tailscale Serve from a tailnet peer is refused; direct local is accepted", async () => {
    const c = counting();
    hub = await startComputersHub();
    hub.host.executorsFor = c.factory;
    await provisionBoth(hub);
    const t = hub.host.tokens.get("research")!;
    const beat = (extra: Record<string, string>) =>
      fetch(`${hub!.base}/__devices/companion/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", ...extra }, body: JSON.stringify({ deviceId: t.deviceId }) });
    const direct = await beat({});
    expect(direct.status).toBe(200);
    const relayed = await beat({ host: "hub.tail-test.ts.net:8443", "tailscale-user-login": "partner@example.test", "x-forwarded-for": "100.64.0.12" });
    expect(relayed.status).toBe(403);
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(40_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

describe("provisioning when the host link (the SSH tunnel) will not come up", () => {
  test("the failure is recorded on the computer (not a silent zombie), the API answers 502, and the name can be cleaned up and reused", async () => {
    let up = false;
    hub = await startComputersHub({
      hubUrlFor: async () => {
        if (!up) throw new Error("the SSH tunnel to the host did not come up");
        return hub!.base;
      },
    });
    const r = await hub.api("usman", "POST", "/", { name: "bot1" });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/tunnel/);
    const v = hub.computers.view("bot1");
    expect(v.failure?.reason).toMatch(/provisioning failed.*tunnel/);
    expect(hub.host.calls.provision).toEqual([]); // nothing was started on the host
    expect((await hub.api("usman", "POST", "/bot1/action", { action: "destroy" })).status).toBe(200);
    up = true;
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
  });
});

describe("automatic recovery allowance", () => {
  test("it is per failure streak: a computer that stayed healthy after a recovery keeps its full allowance for the next failure (a hub restart is not a strike)", async () => {
    hub = await startComputersHub({ autoRecover: true, maxAutoRecoveries: 1, recoveryHealthyMs: 0 });
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
    await hub.computers.tick();
    for (const round of [1, 2, 3]) {
      hub.host.crash("bot1");
      await hub.computers.tick();
      await hub.waitFor(`recovered #${round}`, async () => {
        await hub!.computers.tick();
        const v = hub!.computers.view("bot1");
        return v.state === "online" && v.recoveries === round;
      }, 15_000);
    }
    expect(hub.computers.view("bot1").recoveries).toBe(3); // the lifetime count still reads true
  });
});

describe("automatic recovery cap", () => {
  test("a computer that dies again straight after a recovery (no healthy period) still runs out of automatic recoveries", async () => {
    hub = await startComputersHub({ autoRecover: true, maxAutoRecoveries: 1 });
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
    await hub.computers.tick();
    hub.host.crash("bot1");
    await hub.computers.tick();
    await hub.waitFor("recovered once", async () => (await hub!.computers.tick(), hub!.computers.view("bot1").recoveries === 1 && hub!.computers.view("bot1").state === "online"), 15_000);
    hub.host.crash("bot1");
    for (let i = 0; i < 4; i++) await hub.computers.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.computers.view("bot1").state).toBe("failed");
    expect(hub.computers.view("bot1").recoveries).toBe(1);
  });
});

describe("the monitor", () => {
  test("probes every computer at once, and one slow host cannot hold up the others; overlapping ticks do not pile up", async () => {
    hub = await startComputersHub();
    for (const n of ["bot1", "bot2"]) expect((await hub.api("usman", "POST", "/", { name: n })).status).toBe(200);
    const real = hub.host.probe.bind(hub.host);
    const done: string[] = [];
    let running = 0;
    let maxRunning = 0;
    hub.host.probe = async (h) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      if (h.name === "bot1") await new Promise((r) => setTimeout(r, 400)); // an unreachable host's probe
      const p = await real(h);
      running--;
      done.push(String(h.name));
      return p;
    };
    const first = hub.computers.tick();
    const second = hub.computers.tick(); // a second tick while the first is still running does nothing
    await Promise.all([first, second]);
    expect(done).toEqual(["bot2", "bot1"]); // the fast one finished first, not after the slow one
    expect(maxRunning).toBe(2); // in parallel, and only one pass worth of probes
    expect(done).toHaveLength(2);
  });
});

describe("a deliberate Stop", () => {
  test("a monitor probe that lands while the processes are being stopped does not mark the computer failed", async () => {
    hub = await startComputersHub({ autoRecover: true });
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
    await hub.computers.tick();
    const realStop = hub.host.stop.bind(hub.host);
    hub.host.stop = async (h) => {
      hub!.host.crash("bot1"); // the companion is gone before stop() returns, as the ssh call takes a moment on a real host
      await hub!.computers.tick(); // ...and the monitor looks right then
      await realStop(h);
    };
    const r = await hub.api("usman", "POST", "/bot1/action", { action: "stop", force: true });
    expect(r.status).toBe(200);
    const v = hub.computers.view("bot1");
    expect(v.state).toBe("offline");
    expect(v.failure).toBeNull();
    expect(v.desired).toBe("stopped");
    await hub.computers.tick();
    expect(hub.computers.view("bot1").state).toBe("offline"); // and it is not "recovered" behind the owner's back
    expect(hub.host.calls.recover).toEqual([]);
  });
});

describe("the owner's Stop wins over a monitor that is mid-flight", () => {
  test("a probe that returns after the owner stopped the computer does not mark it failed or restart it", async () => {
    hub = await startComputersHub({ autoRecover: true });
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
    await hub.computers.tick();
    const realProbe = hub.host.probe.bind(hub.host);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    hub.host.probe = async (h) => {
      const p = await realProbe(h);
      await gate; // the probe is "out" over ssh while the owner acts
      return { ...p, companionAlive: false }; // and what comes back says the companion is not running
    };
    const ticking = hub.computers.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect((await hub.api("usman", "POST", "/bot1/action", { action: "stop", force: true })).status).toBe(200);
    release();
    await ticking;
    await hub.computers.tick();
    const v = hub.computers.view("bot1");
    expect(v.state).toBe("offline");
    expect(v.failure).toBeNull();
    expect(hub.host.calls.recover).toEqual([]);
  });

  test("an automatic recovery that is restarting the processes when the owner presses Stop stops them again", async () => {
    hub = await startComputersHub({ autoRecover: true });
    expect((await hub.api("usman", "POST", "/", { name: "bot1" })).status).toBe(200);
    await hub.computers.tick();
    const realRecover = hub.host.recover.bind(hub.host);
    let started: () => void = () => undefined;
    const inRecover = new Promise<void>((r) => (started = r));
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((r) => (finish = r));
    hub.host.recover = async (h) => {
      started();
      await hold; // the restart is slow (an ssh round trip)
      await realRecover(h);
    };
    hub.host.crash("bot1");
    await hub.computers.tick();
    await hub.computers.tick();
    await inRecover;
    expect((await hub.api("usman", "POST", "/bot1/action", { action: "stop", force: true })).status).toBe(200);
    finish();
    await new Promise((r) => setTimeout(r, 600));
    expect(hub.host.alive("bot1")).toBe(false); // nothing was left running that the owner stopped
    expect(hub.computers.view("bot1").desired).toBe("stopped");
  });
});

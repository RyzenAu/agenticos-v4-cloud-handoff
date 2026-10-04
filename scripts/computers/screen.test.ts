import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { BLANK_TTL_MS, MAX_SCREEN_RESTARTS_PER_DAY, MAX_SCREEN_RETRIES, SCREEN_FIRST_DELAY_MS, SCREEN_FRESH_MS, diagnoseScreen, screenRetryDelayMs, screenRetryDue, type ScreenInput } from "./screen";
import { startComputersHub, type ComputersHub } from "./test-harness";
import type { ProbeResult } from "./types";

/**
 * Screen truth (round 7). A computer is never reported as having a ready screen because its process exists: the layers (host, computer, display, VNC,
 * browser) come from the host's own probe, and "ready" needs a recent real frame through the viewer or a screenshot that really came back. Each layer that can
 * fail has a test here that fails without the diagnosis: the observed defect was "online while its screen is disconnected or blank".
 */

setDefaultTimeout(30_000);

let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const NOW = 1_000_000;
const healthy = (over: Partial<ProbeResult> = {}): ProbeResult => ({ hostUp: true, companionAlive: true, displayAlive: true, vncAlive: true, browserAlive: true, resource: null, at: NOW, ...over });
const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({ desktop: true, browser: true, snapshot: true, probe: healthy(), evidence: {}, now: NOW, ...over });

describe("the diagnosis (pure)", () => {
  test("a computer with no desktop and no browser has no screen to be ready", () => {
    expect(diagnoseScreen(input({ desktop: false, browser: false }))).toMatchObject({ applicable: false, ok: false });
  });

  test("every layer up but no frame or screenshot yet is NOT ready: a process existing is not evidence", () => {
    const s = diagnoseScreen(input());
    expect(s).toMatchObject({ ok: false, checking: true, layer: null });
  });

  test("a real screenshot makes it ready, and a stale one stops proving anything", () => {
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - 1_000 } }))).toMatchObject({ ok: true, lastShotAt: NOW - 1_000 });
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - SCREEN_FRESH_MS - 1 } }))).toMatchObject({ ok: false, checking: true });
    expect(diagnoseScreen(input({ evidence: { frameAt: NOW - 5 } }))).toMatchObject({ ok: true, lastFrameAt: NOW - 5 });
  });

  test("each layer says itself and its next action: host -> Check host; display, VNC, blank -> Restart display", () => {
    const at = (p: Partial<ProbeResult>) => diagnoseScreen(input({ probe: healthy(p), evidence: { frameAt: NOW } }));
    expect(at({ hostUp: false, companionAlive: false, error: "wsl.exe timed out" })).toMatchObject({ ok: false, layer: "host", next: "check-host", nextLabel: "Check host", at: NOW });
    expect(at({ hostUp: false }).reason).toContain("wsl.exe timed out".slice(0, 0)); // reason exists
    expect(at({ companionAlive: false })).toMatchObject({ layer: "computer", next: "restart-display" });
    expect(at({ displayAlive: false })).toMatchObject({ layer: "display", next: "restart-display", nextLabel: "Restart display" });
    expect(at({ vncAlive: false })).toMatchObject({ layer: "vnc", next: "restart-display" });
    expect(at({ browserAlive: false })).toMatchObject({ layer: "blank", next: "restart-display" });
    expect(at({ browserAlive: false }).reason).toMatch(/blank/i);
  });

  test("a fresh frame does not hide a layer the host says is down", () => {
    expect(diagnoseScreen(input({ probe: healthy({ vncAlive: false }), evidence: { frameAt: NOW } })).ok).toBe(false);
  });

  test("a viewer failure newer than the last proof is reported with Reconnect; a later frame clears it", () => {
    const fault = { layer: "viewer" as const, reason: "The live view was refused.", at: NOW - 10 };
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - 500, fault } }))).toMatchObject({ ok: false, layer: "viewer", next: "reconnect", nextLabel: "Reconnect" });
    // a screenshot is of the browser, not of what the viewer is shown: it does not clear a viewer failure; a later real frame does
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - 5, fault } })).ok).toBe(false);
    expect(diagnoseScreen(input({ evidence: { frameAt: NOW - 5, fault } })).ok).toBe(true);
    // a failed screenshot IS cleared by a later screenshot
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - 5, fault: { layer: "frame", reason: "no screenshot", at: NOW - 10 } } })).ok).toBe(true);
    // and a viewer failure lapses
    expect(diagnoseScreen(input({ evidence: { shotAt: NOW - 1_000, fault: { ...fault, at: NOW - 200_000 } } })).ok).toBe(true);
  });

  test("a stale probe is no evidence about the layers", () => {
    expect(diagnoseScreen(input({ probe: healthy({ vncAlive: false, at: NOW - 120_000 }), evidence: { frameAt: NOW } })).ok).toBe(true);
    expect(diagnoseScreen(input({ probe: null }))).toMatchObject({ checking: true });
  });

  test("automatic restarts: only a display layer that died, after a delay, only while nobody holds it, bounded, spaced and capped per day; never a viewer fault or a blank", () => {
    const due = (over: Partial<Parameters<typeof screenRetryDue>[0]> = {}) => screenRetryDue({ layer: "vnc", held: false, recovering: false, running: true, used: 0, nextAt: null, now: NOW, wasUp: true, failingSince: NOW - SCREEN_FIRST_DELAY_MS, restartsToday: 0, ...over });
    expect(due()).toBe(true);
    expect(due({ failingSince: NOW - SCREEN_FIRST_DELAY_MS + 1 })).toBe(false); // the first try waits, longer than the browser watchdog
    expect(due({ failingSince: null })).toBe(false);
    expect(due({ restartsToday: MAX_SCREEN_RESTARTS_PER_DAY })).toBe(false); // the daily cap
    expect(due({ held: true })).toBe(false); // a job or a person holds it
    expect(due({ wasUp: false })).toBe(false); // never worked: reported, not looped
    expect(due({ layer: "viewer" })).toBe(false);
    expect(due({ layer: "blank" })).toBe(false); // the browser is for the companion to reopen
    expect(due({ layer: "host" })).toBe(false);
    expect(due({ layer: "display" })).toBe(true);
    expect(due({ used: MAX_SCREEN_RETRIES })).toBe(false);
    expect(due({ nextAt: NOW + 1 })).toBe(false);
    expect(due({ recovering: true })).toBe(false);
    expect(due({ running: false })).toBe(false);
    expect([0, 1, 2, 3].map(screenRetryDelayMs)).toEqual([20_000, 60_000, 180_000, 180_000]);
  });

  test("a viewer's frame does not hide a blank report (a black screen is a frame); only a drawn-picture report or lapsing clears it", () => {
    const blank = { layer: "blank" as const, reason: "all black", at: NOW - 1_000 };
    expect(diagnoseScreen(input({ evidence: { frameAt: NOW, shotAt: NOW, fault: blank } }))).toMatchObject({ ok: false, layer: "blank" });
    expect(diagnoseScreen(input({ evidence: { frameAt: NOW, fault: { ...blank, at: NOW - BLANK_TTL_MS - 1 } } })).ok).toBe(true); // stopped being re-reported: stale
  });
});

// ------------------------------------------------------------------------------------------------------------- through the real service and routes
const executors = (): Record<string, Executor> => ({ echo: async () => ({ ok: true, said: "Echoed.", verified: true }), wait: async (a, ctx) => { await new Promise((r) => { const t = setTimeout(r, Number(a.ms ?? 100)); ctx.signal.addEventListener("abort", () => { clearTimeout(t); r(null); }); }); return { ok: true, said: "Waited.", verified: true }; } });

async function desktopHub(opts: Parameters<typeof startComputersHub>[0] = {}) {
  hub = await startComputersHub(opts);
  hub.host.executorsFor = executors;
  hub.host.probeOverride = { browserAlive: true, vncAlive: true };
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  return hub;
}
const screenOf = async (h: ComputersHub, who: "usman" | "mehroz" = "usman") => (await h.api(who, "GET", "/research/screen")).json.screen;

describe("the screen through the hub: evidence, not process existence", () => {
  test("online with every process up is still not usable until a real screenshot comes back; then it is", async () => {
    const h = await desktopHub();
    let v = h.computers.view("research");
    expect(v.state).toBe("online");
    // The old behaviour: state "online" and nothing else. Now the screen says it has no proof yet, and the computer is not "usable".
    expect(v.screen).toMatchObject({ applicable: true, ok: false, checking: true });
    expect(v.usable).toBe(false);
    const s = await screenOf(h);
    expect(s).toMatchObject({ ok: true });
    v = h.computers.view("research");
    expect(v.usable).toBe(true);
    expect(v.screen.lastShotAt).not.toBeNull();
  });

  test("a dead screen server is named: online by the heartbeat, but the layer is VNC and the next action is Restart display", async () => {
    const h = await desktopHub();
    h.host.probeOverride = { browserAlive: true, vncAlive: false };
    const s = await screenOf(h);
    expect(s).toMatchObject({ ok: false, layer: "vnc", next: "restart-display", nextLabel: "Restart display" });
    const v = h.computers.view("research");
    expect(v.state).toBe("online"); // the computer itself is up...
    expect(v.usable).toBe(false); // ...but it is not shown as usable
  });

  test("a blank desktop (display up, no browser) is named blank, not online and fine", async () => {
    const h = await desktopHub();
    h.host.probeOverride = { browserAlive: false, vncAlive: true };
    expect(await screenOf(h)).toMatchObject({ ok: false, layer: "blank", next: "restart-display" });
    expect(h.computers.view("research").usable).toBe(false);
  });

  test("an unreachable host is named host, with Check host", async () => {
    const h = await desktopHub();
    h.host.probeOverride = { hostUp: false, companionAlive: false, displayAlive: null, vncAlive: null, browserAlive: null, error: "ssh: timed out" };
    expect(await screenOf(h)).toMatchObject({ layer: "host", next: "check-host", nextLabel: "Check host" });
  });

  test("every layer up but the browser returns no screenshot is a frame failure, not ready", async () => {
    const h = await desktopHub();
    h.host.snapshotFails = true;
    expect(await screenOf(h)).toMatchObject({ ok: false, layer: "frame", next: "reconnect" });
    h.host.snapshotFails = false;
    await new Promise((r) => setTimeout(r, 2_100)); // the check is cached for 2 s
    expect(await screenOf(h)).toMatchObject({ ok: true });
  });

  test("a stopped computer has no screen and says so; a failed one says why", async () => {
    const h = await desktopHub();
    await h.api("usman", "POST", "/research/action", { action: "stop", force: true });
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, layer: "computer", next: null });
    expect(h.computers.view("research").usable).toBe(false);
  });

  test("a screenshot from before a stop, start or restart proves nothing about the screen afterwards (found live: Online and 'ready' half a second after Start)", async () => {
    const h = await desktopHub();
    expect(await screenOf(h)).toMatchObject({ ok: true });
    await h.api("usman", "POST", "/research/action", { action: "stop", force: true });
    expect((await h.api("usman", "POST", "/research/action", { action: "start" })).status).toBe(200);
    await h.waitFor("online", () => h.computers.view("research").state === "online");
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, checking: true });
    expect(h.computers.view("research").usable).toBe(false);
    expect(await screenOf(h)).toMatchObject({ ok: true }); // proven again by a fresh check
    await new Promise((r) => setTimeout(r, 2_100));
    await h.api("usman", "POST", "/research/action", { action: "recover" });
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, checking: true });
  });

  test("the screen is in the computer list for both founders, and the report route is for a person only", async () => {
    const h = await desktopHub();
    for (const who of ["usman", "mehroz"] as const) expect((await h.api(who, "GET", "/")).json.computers[0].screen).toMatchObject({ applicable: true });
    expect((await h.api("program", "POST", "/research/screen-report", { blank: true, frame: true })).status).toBe(403);
  });

  test("one black sample proves nothing; the second report believes it, a live viewer's frame does not hide it, and a drawn-picture report clears it", async () => {
    const h = await desktopHub();
    const report = (blank: boolean) => h.api("usman", "POST", "/research/screen-report", { blank, frame: true });
    expect((await report(true)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_100));
    expect(await screenOf(h)).toMatchObject({ ok: true }); // a single sample (a page still loading) is not a blank screen
    await report(true);
    await report(true); // the same black twice
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, layer: "blank", next: "restart-display" });
    // a viewer connects and receives frames: a black screen is a frame, so it must not read as proof
    h.computers.screenFrame("research", { first: true });
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, layer: "blank" });
    expect((await report(false)).status).toBe(200);
    expect(h.computers.view("research").screen.layer).toBeNull();
    expect(h.computers.view("research").screen.ok).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------- the viewer transport
const handshake = (ws: WebSocket) => {
  ws.send(Buffer.from("RFB 003.008\n", "latin1"));
  ws.send(Buffer.from([1]));
  ws.send(Buffer.from([1]));
};
function connect(h: ComputersHub, who: "usman" | "mehroz", name: string) {
  const { host, ...rest } = h.headers(who, false);
  const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(`ws://127.0.0.1:${h.port}/__computers/${name}/vnc`, { headers: { ...rest, host } });
  ws.binaryType = "arraybuffer";
  const received: Buffer[] = [];
  ws.addEventListener("message", (e) => received.push(Buffer.from(e.data as ArrayBuffer)));
  return { ws, received, opened: new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(new Error("refused"))); }), closed: new Promise<void>((res) => ws.addEventListener("close", () => res())) };
}

describe("the viewer transport is diagnosed", () => {
  test("a refused upgrade (the screen server did not answer) is a viewer failure with Reconnect", async () => {
    const h = await desktopHub(); // probe says VNC is up, but nothing answers the tunnel (vncUp is false)
    const v = connect(h, "usman", "research");
    await expect(v.opened).rejects.toThrow();
    const s = await screenOf(h);
    expect(s).toMatchObject({ ok: false, layer: "viewer", next: "reconnect" });
    expect(s.reason).toMatch(/refused|didn't answer/);
    expect(h.computers.events().some((e) => e.type === "screen-fault")).toBe(true);
  });

  test("a real frame through the viewer makes the screen ready and counts it live while the viewer is open", async () => {
    const h = await desktopHub();
    h.host.vncUp = true;
    h.host.rfb = "real";
    const v = connect(h, "usman", "research");
    await v.opened;
    await h.waitFor("the server greeting", () => v.received.length > 0);
    handshake(v.ws);
    v.ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 64, 0, 48])); // a full framebuffer update request
    await h.waitFor("a frame", () => h.computers.view("research").screen.lastFrameAt !== null);
    const s = h.computers.view("research").screen;
    expect(s).toMatchObject({ ok: true, layer: null });
    expect(h.computers.view("research").usable).toBe(true);
    v.ws.close();
    await v.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.computers.view("research").screen.ok).toBe(true); // the frame is still recent proof
  });

  test("connected but no picture within the deadline is a frame failure (the observed 'connected, blank')", async () => {
    const h = await desktopHub({ viewerNoFrameMs: 150 });
    h.host.vncUp = true; // canned server: the handshake completes, no frame ever follows
    const v = connect(h, "usman", "research");
    await v.opened;
    await h.waitFor("the server greeting", () => v.received.length > 0);
    handshake(v.ws);
    const s = await h.waitFor("the no-picture fault", async () => {
      const x = h.computers.view("research").screen;
      return x.layer === "frame" ? x : null;
    });
    expect(s).toMatchObject({ ok: false, next: "reconnect" });
    expect(s.reason).toMatch(/no picture/);
    v.ws.close();
  });

  test("a failed handshake is a viewer failure and says why", async () => {
    const h = await desktopHub();
    h.host.vncUp = true;
    const v = connect(h, "usman", "research");
    await v.opened;
    await h.waitFor("the server greeting", () => v.received.length > 0);
    v.ws.send(Buffer.from("RFB 003.008\n", "latin1"));
    v.ws.send(Buffer.from([2])); // a security type other than None
    v.ws.send(Buffer.from([1]));
    await v.closed;
    const s = h.computers.view("research").screen;
    expect(s).toMatchObject({ ok: false, layer: "viewer" });
    expect(s.reason).toMatch(/handshake failed/);
  });
});

// ------------------------------------------------------------------------------------------------------------- bounded automatic restarts, never under a holder
describe("automatic restarts of the display layers", () => {
  const clock = { t: 5_000_000 };
  // The injected clock also drives the leases: they are made long so that moving it forward (to pass the retry spacing) never expires a holder.
  const withClock = () => ({ now: () => clock.t });
  const longLeases = { agentLeaseTtlMs: 10_000_000, personLeaseTtlMs: 10_000_000 };
  const settle = () => new Promise((r) => setTimeout(r, 500)); // an automatic restart runs in the background; let it finish before the next tick

  async function dying(opts: Parameters<typeof startComputersHub>[0] = {}) {
    clock.t = 5_000_000;
    const h = await desktopHub({ autoRecover: true, clock: withClock(), leaseOptions: longLeases, ...opts });
    await h.computers.tick(); // every layer seen working
    h.host.probeOverride = { browserAlive: true, vncAlive: false }; // the screen server dies
    await h.computers.tick(); // ...and is first seen down now
    return h;
  }
  const afterFirstDelay = async (h: ComputersHub) => {
    clock.t += SCREEN_FIRST_DELAY_MS + 1_000;
    await h.computers.tick();
    await settle();
  };

  test("the first automatic restart waits (longer than the browser watchdog), restarts ONLY the display layer, and counts no crash recovery", async () => {
    const h = await dying();
    await h.computers.tick();
    await settle();
    expect(h.host.calls.start).toHaveLength(0); // nothing yet
    await afterFirstDelay(h);
    expect(h.host.calls.start).toHaveLength(1); // the layer restart (start only starts what is not running)
    expect(h.host.calls.recover).toEqual([]); // not the full recover (companion, Xvfb, VNC and browser)
    expect(h.host.calls.stop).toEqual([]); // and nothing alive was stopped
    expect(h.computers.view("research").recoveries).toBe(0); // the crash-recovery streak is not spent
    expect(h.computers.store.get("research")?.recoveryStreak ?? 0).toBe(0);
  });

  test("spaced and bounded to three tries; then it stays reported", async () => {
    const h = await dying();
    await afterFirstDelay(h);
    await h.computers.tick(); // too soon: the next try is spaced
    await settle();
    expect(h.host.calls.start).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      clock.t += 181_000;
      await h.computers.tick();
      await settle();
    }
    expect(h.host.calls.start).toHaveLength(MAX_SCREEN_RETRIES); // never a loop
    expect(h.computers.view("research").screen).toMatchObject({ ok: false, layer: "vnc", retry: { used: MAX_SCREEN_RETRIES, max: MAX_SCREEN_RETRIES } });
    expect(h.computers.events().filter((e) => e.type === "screen-restart")).toHaveLength(MAX_SCREEN_RETRIES);
  });

  test("a layer that never worked is reported, not restarted over and over", async () => {
    clock.t = 5_000_000;
    const h = await desktopHub({ autoRecover: true, clock: withClock(), leaseOptions: longLeases });
    h.host.probeOverride = { browserAlive: true, vncAlive: false }; // VNC was never up on this host
    await h.computers.tick();
    await afterFirstDelay(h);
    expect(h.host.calls.start).toHaveLength(0);
    expect(h.computers.view("research").screen.layer).toBe("vnc");
  });

  test("NEVER while a person holds the computer: no restart under them; it restarts after they let go", async () => {
    const h = await dying();
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    for (let i = 0; i < 3; i++) await afterFirstDelay(h);
    expect(h.host.calls.start).toHaveLength(0);
    expect((await h.api("usman", "POST", "/research/return", {})).status).toBe(200);
    await afterFirstDelay(h);
    expect(h.host.calls.start).toHaveLength(1);
  });

  test("NEVER while an agent job holds it", async () => {
    const h = await dying();
    const r = await h.api("usman", "POST", "/research/jobs", { agent: "t", title: "busy", steps: [{ executor: "wait", args: { ms: 1500 } }] });
    expect(r.status).toBe(200);
    await h.waitFor("busy", () => h.computers.view("research").state === "busy");
    clock.t += SCREEN_FIRST_DELAY_MS + 1_000;
    await h.computers.tick();
    expect(h.host.calls.start).toHaveLength(0);
    await h.waitFor("the job to end", () => h.computers.jobView(r.json.jobId)?.state === "succeeded");
  });

  test("a computer being restarted reads 'starting', so no job is handed to it half way through", async () => {
    const h = await dying();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    const realStart = h.host.start.bind(h.host);
    h.host.start = async (handle) => {
      await hold;
      await realStart(handle);
    };
    clock.t += SCREEN_FIRST_DELAY_MS + 1_000;
    await h.computers.tick();
    await h.waitFor("the restart to begin", () => h.computers.view("research").state === "starting");
    const job = await h.api("usman", "POST", "/research/jobs", { agent: "t", title: "too early", steps: [{ executor: "echo", args: {} }] });
    expect(job.status).toBe(409);
    expect(job.json.error).toMatch(/starting, so nothing ran/);
    release();
    await h.waitFor("online again", () => h.computers.view("research").state === "online");
  });

  test("a crashed companion IS restarted even while a person holds the computer (crash recovery is unchanged), and the person's hold is not what blocks it", async () => {
    clock.t = 5_000_000;
    const h = await desktopHub({ autoRecover: true, clock: withClock(), leaseOptions: longLeases });
    await h.computers.tick();
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    h.host.crash("research");
    h.host.probeOverride = { browserAlive: true, vncAlive: true };
    await h.computers.tick();
    await h.computers.tick();
    await h.waitFor("the restart", () => h.host.calls.recover.length === 1);
    expect(h.computers.events().some((e) => e.type === "recover-deferred")).toBe(false);
  });

  test("a crashed companion is restarted while a viewer keeps renewing the lease (it never waits for a release)", async () => {
    clock.t = 5_000_000;
    const h = await desktopHub({ autoRecover: true, clock: withClock(), leaseOptions: longLeases });
    await h.computers.tick();
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    h.host.crash("research");
    for (let i = 0; i < 3; i++) {
      await h.api("usman", "POST", "/research/lease/renew", {});
      await h.computers.tick();
    }
    await h.waitFor("the restart", () => h.host.calls.recover.length >= 1);
  });

  test("a person asking to Restart display while a job holds a healthy computer is refused with who holds it; force overrides", async () => {
    const h = await desktopHub();
    const r = await h.api("usman", "POST", "/research/jobs", { agent: "t", title: "busy", steps: [{ executor: "wait", args: { ms: 2000 } }] });
    await h.waitFor("busy", () => h.computers.view("research").state === "busy");
    const refused = await h.api("usman", "POST", "/research/action", { action: "recover" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/using research/);
    expect(h.host.calls.recover).toEqual([]);
    await h.api("usman", "POST", `/jobs/${r.json.jobId}/cancel`, {});
    await h.waitFor("the job to end", () => h.computers.jobView(r.json.jobId)?.state === "cancelled");
    expect((await h.api("usman", "POST", "/research/action", { action: "recover" })).status).toBe(200);
    expect(h.host.calls.recover).toHaveLength(1);
  });

  test("a FAILED computer is restarted by hand whoever holds it (the UI offers it; it is not a 409)", async () => {
    clock.t = 5_000_000;
    const h = await desktopHub({ clock: withClock(), leaseOptions: longLeases });
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    h.host.crash("research");
    await h.computers.tick();
    await h.computers.tick();
    expect(h.computers.view("research").failure).not.toBeNull();
    expect((await h.api("usman", "POST", "/research/action", { action: "recover" })).status).toBe(200);
    expect(h.host.calls.recover).toHaveLength(1);
  });

  test("a hub that restarts does not assume the marker is off: it sends the actual state the first time (a marker left by the old hub is cleared)", async () => {
    const h = await desktopHub();
    await h.api("usman", "POST", "/research/takeover", {});
    await h.waitFor("hold on", () => h.host.holds.research === true);
    const { root, port, host } = h;
    await h.close({ root: true, host: true }); // the hub goes away holding "on"; the lease (in memory) is gone with it
    hub = undefined;
    const again = await startComputersHub({ restart: { root, port }, host });
    hub = again;
    await again.waitFor("the computer to reconnect", () => again.computers.view("research").state === "online", 15_000);
    await again.computers.tick();
    await again.waitFor("hold off after the restart", () => host.holds.research === false);
  });

  test("a hold-off that fails is tried again (bounded), so the marker is never left behind", async () => {
    const h = await desktopHub();
    await h.api("usman", "POST", "/research/takeover", {});
    await h.waitFor("hold on", () => h.host.holds.research === true);
    let failures = 0;
    const real = h.host.setHold.bind(h.host);
    h.host.setHold = async (handle, held) => {
      if (!held && failures < 2) {
        failures++;
        throw new Error("the host did not answer");
      }
      await real(handle, held);
    };
    await h.api("usman", "POST", "/research/return", {});
    for (let i = 0; i < 4 && h.host.holds.research !== false; i++) {
      await h.computers.tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(h.host.holds.research).toBe(false);
    expect(failures).toBe(2);
  });

  test("a host that stays unreachable is not asked on every tick for ever", async () => {
    const h = await desktopHub();
    await h.api("usman", "POST", "/research/takeover", {});
    await h.waitFor("hold on", () => h.host.holds.research === true);
    let tries = 0;
    h.host.setHold = async () => {
      tries++;
      throw new Error("down");
    };
    await h.api("usman", "POST", "/research/return", {});
    for (let i = 0; i < 12; i++) {
      await h.computers.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(tries).toBeLessThanOrEqual(6);
  });

  test("the companion is told when a person holds the computer, and when they let go (so its browser is left alone)", async () => {
    const h = await desktopHub();
    await h.api("usman", "POST", "/research/takeover", {});
    await h.waitFor("hold on", () => h.host.holds.research === true);
    await h.api("usman", "POST", "/research/return", {});
    await h.waitFor("hold off", () => h.host.holds.research === false);
  });
});

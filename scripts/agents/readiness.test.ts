// Readiness is derived from the services a bot points at: computer state and lease, coding account readiness, open jobs and the model route.
// Fake dependencies here; nothing is stored, so each case just changes what the services say.
import { describe, expect, test } from "bun:test";
import { deriveReadiness, type AccountFacts, type ComputerFacts, type OpenWork, type ReadinessDeps } from "./readiness";
import { seedBots, type Bot } from "./types";

const research = (): Bot => seedBots(1)[0];
const builder = (): Bot => seedBots(1)[1];
const computer = (patch: Partial<ComputerFacts> = {}): ComputerFacts => ({ exists: true, label: "Research", state: "online", desired: "running", controller: { kind: null, who: null, jobId: null }, takeoverPending: null, failure: null, assigned: null, ...patch });
const rig = (facts: { computer?: ComputerFacts | null; work?: OpenWork[]; account?: AccountFacts; route?: { ok: boolean; reason: string | null } } = {}): ReadinessDeps => ({
  computer: () => (facts.computer === undefined ? computer() : facts.computer),
  openWork: () => facts.work ?? [],
  codingAccount: () => facts.account ?? { ready: true, label: "Claude Max", reason: null },
  routerCheck: () => facts.route ?? { ok: true, reason: null },
});
const codes = (r: ReturnType<typeof deriveReadiness>) => r.reasons.map((x) => x.code);

describe("a bot with a computer", () => {
  test("online and idle is ready, with nothing to say", () => {
    const r = deriveReadiness(research(), rig());
    expect(r).toMatchObject({ state: "ready", reasons: [], working: null });
    expect(r.parts.computer).toEqual({ state: "ready", reason: null });
  });

  test("a job running on it is working, and says what", () => {
    const r = deriveReadiness(research(), rig({ computer: computer({ state: "busy", controller: { kind: "agent", who: "research", jobId: "j1" } }), work: [{ jobId: "j1", title: "Find clinics", kind: "computer", phase: "running" }] }));
    expect(r.state).toBe("working");
    expect(r.working).toEqual({ jobId: "j1", title: "Find clinics", kind: "computer" });
  });

  test("a person controlling it is needs-you, with the way back (open the computer)", () => {
    const r = deriveReadiness(research(), rig({ computer: computer({ state: "busy", controller: { kind: "person", who: "usman", jobId: null } }) }));
    expect(r.state).toBe("needs-you");
    expect(r.reasons[0]).toMatchObject({ code: "computer-person-control", fix: { kind: "open-computer", target: "research" } });
    expect(r.reasons[0].text).toContain("carries on when they hand the controls back");
    expect(r.reasons[0].text).not.toContain("Return control to the agent");
  });

  test("a job waiting for a yes is needs-you, naming the job and what it waits for", () => {
    const r = deriveReadiness(research(), rig({ work: [{ jobId: "j2", title: "Send the list", kind: "computer", phase: "waiting", note: "press Send" }] }));
    expect(r.state).toBe("needs-you");
    expect(r.reasons[0].text).toContain("press Send");
  });

  test("stopped, unreachable, failed and starting are offline, each with its own recovery", () => {
    const stopped = deriveReadiness(research(), rig({ computer: computer({ state: "offline", desired: "stopped" }) }));
    expect([stopped.state, codes(stopped)]).toEqual(["offline", ["computer-stopped"]]);
    expect(stopped.reasons[0].text).toContain("Start it on the Computers page");
    const lost = deriveReadiness(research(), rig({ computer: computer({ state: "offline" }) }));
    expect(codes(lost)).toEqual(["computer-unreachable"]);
    const failed = deriveReadiness(research(), rig({ computer: computer({ state: "failed", failure: { reason: "Xvfb died" } }) }));
    expect(failed.state).toBe("offline");
    expect(failed.reasons[0].text).toContain("Xvfb died");
    expect(failed.reasons[0].text).toContain("Recover");
    const starting = deriveReadiness(research(), rig({ computer: computer({ state: "starting" }) }));
    expect([starting.state, starting.reasons[0].fix?.kind]).toEqual(["offline", "retry"]);
  });

  test("asleep is ready (it wakes on a task) with a note; a missing computer is unconfigured and points at Setup", () => {
    const asleep = deriveReadiness(research(), rig({ computer: computer({ state: "asleep", desired: "suspended" }) }));
    expect([asleep.state, codes(asleep)]).toEqual(["ready", ["computer-asleep"]]);
    const missing = deriveReadiness(research(), rig({ computer: null }));
    expect(missing.state).toBe("unconfigured");
    expect(missing.reasons[0]).toMatchObject({ code: "computer-missing", fix: { kind: "open-setup-section", target: "computer" } });
  });

  test("someone waiting to take over is a note on a working bot, not a state change", () => {
    const r = deriveReadiness(research(), rig({ computer: computer({ state: "busy", controller: { kind: "agent", who: "research", jobId: "j1" }, takeoverPending: { by: "mehroz" } }), work: [{ jobId: "j1", title: "t", kind: "computer", phase: "running" }] }));
    expect([r.state, codes(r)]).toEqual(["working", ["takeover-pending"]]);
  });
});

describe("Builder: its computer and its coding accounts", () => {
  test("coding account signed out: the coding part is offline with a sign-in fix, but the bot stays usable through its computer", () => {
    const bot = builder();
    bot.coding.accountSlot = "claude:max";
    const r = deriveReadiness(bot, rig({ computer: computer({ label: "Builder" }), account: { ready: false, label: "Claude Max", reason: "not signed in on this profile" } }));
    expect(r.state).toBe("ready");
    expect(r.parts.coding).toMatchObject({ state: "offline", reason: { code: "coding-account-not-ready", fix: { kind: "sign-in", target: "claude:max" } } });
    expect(r.reasons[0].text).toContain("I won't use a different account");
    // With no account chosen (the automatic pick) the words are about the accounts as a group.
    const auto = deriveReadiness(builder(), rig({ account: { ready: false, label: "the coding accounts", reason: "none is signed in" } }));
    expect(auto.parts.coding?.reason?.text).toContain("No coding account can take work");
  });

  test("a named account is the one asked about, and its slot is on the fix", () => {
    const bot = builder();
    bot.coding.accountSlot = "claude:max-2";
    const asked: Array<string | null> = [];
    const r = deriveReadiness(bot, { ...rig({ account: { ready: false, label: "Claude Max 2", reason: "not signed in on this profile" } }), codingAccount: (slot) => (asked.push(slot), { ready: false, label: "Claude Max 2", reason: "not signed in on this profile" }) });
    expect(asked).toEqual(["claude:max-2"]);
    expect(r.parts.coding?.reason).toMatchObject({ fix: { kind: "sign-in", target: "claude:max-2" } });
  });

  test("an unchecked account is unconfigured, never ready", () => {
    const r = deriveReadiness(builder(), rig({ account: { ready: null, label: "Claude Max", reason: "not checked yet" } }));
    expect(r.parts.coding).toMatchObject({ state: "unconfigured", reason: { code: "coding-account-unchecked" } });
  });

  test("a coding job waiting for the owner is needs-you; one building is working", () => {
    const waiting = deriveReadiness(builder(), rig({ work: [{ jobId: "c1", title: "Fix the footer", kind: "coding", phase: "waiting", note: "start it, or say no" }] }));
    expect([waiting.state, waiting.parts.coding?.reason?.code]).toEqual(["needs-you", "coding-job-waiting"]);
    const building = deriveReadiness(builder(), rig({ work: [{ jobId: "c1", title: "Fix the footer", kind: "coding", phase: "running" }] }));
    expect([building.state, building.working?.kind]).toEqual(["working", "coding"]);
  });

  test("with both parts down the bot is offline", () => {
    const r = deriveReadiness(builder(), rig({ computer: computer({ state: "offline", desired: "stopped" }), account: { ready: false, label: "Claude Max", reason: "x" } }));
    expect(r.state).toBe("offline");
    expect(codes(r).sort()).toEqual(["coding-account-not-ready", "computer-stopped"]);
  });
});

describe("the model route and an empty bot", () => {
  test("an unavailable route explains a degraded bot but never decides alone", () => {
    const r = deriveReadiness(research(), rig({ route: { ok: false, reason: "limited until 5pm" } }));
    expect(r.state).toBe("ready");
    expect(r.reasons[0]).toMatchObject({ code: "route-unavailable", fix: { kind: "open-setup-section", target: "model" } });
  });

  test("no computer and no coding: unconfigured, with the one thing to do", () => {
    const bot = research();
    bot.computer = null;
    const r = deriveReadiness(bot, rig());
    expect(r.state).toBe("unconfigured");
    expect(r.reasons[0].code).toBe("no-capability");
  });

  test("every reason has a code, plain words and nothing that looks like a secret", () => {
    const r = deriveReadiness(builder(), rig({ computer: computer({ state: "failed", failure: { reason: "boom" } }), account: { ready: false, label: "Claude Max", reason: "signed out" }, route: { ok: false, reason: "down" } }));
    for (const reason of r.reasons) {
      expect(reason.code).toMatch(/^[a-z-]+$/);
      expect(reason.text.length).toBeGreaterThan(20);
    }
  });
});

describe("online is not ready unless the screen works (C's screen truth)", () => {
  const screen = (p: Partial<NonNullable<ComputerFacts["screen"]>> = {}) => ({ applicable: true, ok: false, checking: false, reason: "The remote viewer isn't connected.", nextLabel: "Restart the viewer", ...p });
  test("online with a failed screen is needs-you with the screen's reason and next action, and a way to the computer", () => {
    const r = deriveReadiness(research(), rig({ computer: computer({ screen: screen(), usable: false }) }));
    expect(r.state).toBe("needs-you");
    expect(r.reasons[0]).toMatchObject({ code: "computer-screen-down", fix: { kind: "open-computer", target: "research" } });
    expect(r.reasons[0].text).toContain("The remote viewer isn't connected.");
    expect(r.reasons[0].text).toContain("Restart the viewer");
  });
  test("an older hub that only says usable:false is held to it too", () => {
    expect(deriveReadiness(research(), rig({ computer: computer({ usable: false }) })).state).toBe("needs-you");
  });
  test("checking is not yet known, not failed: ready, with a note that clears by itself", () => {
    const r = deriveReadiness(research(), rig({ computer: computer({ screen: screen({ checking: true, reason: null, nextLabel: null }), usable: false }) }));
    expect(r.state).toBe("ready");
    expect(codes(r)).toEqual(["computer-screen-checking"]);
  });
  test("a working screen, a computer with no screen to judge, and a hub that sends nothing about screens are all ready", () => {
    expect(deriveReadiness(research(), rig({ computer: computer({ screen: screen({ ok: true }), usable: true }) })).state).toBe("ready");
    expect(deriveReadiness(research(), rig({ computer: computer({ screen: screen({ applicable: false }), usable: true }) })).state).toBe("ready");
    expect(deriveReadiness(research(), rig()).state).toBe("ready");
  });
});

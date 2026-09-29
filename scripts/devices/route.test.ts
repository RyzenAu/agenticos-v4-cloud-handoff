import { describe, expect, test } from "bun:test";
import { defaultHub, staticRegistry } from "./registry";
import { parseSpokenTarget, resolveTarget } from "./route";
import type { TargetDevice } from "./types";

// Synthetic devices only.
const mehrozPc: TargetDevice = { id: "mehroz-pc", owner: "mehroz", kind: "companion", label: "Mehroz's PC", aliases: ["pc", "desktop"], primary: true };
const mehrozLaptop: TargetDevice = { id: "mehroz-laptop", owner: "mehroz", kind: "companion", label: "Mehroz's laptop", aliases: ["laptop"] };
const usmanLaptop: TargetDevice = { id: "usman-laptop", owner: "usman", kind: "companion", label: "Usman's laptop", aliases: ["laptop"] };

function setup(devices: TargetDevice[], online: string[] = []) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const registry = staticRegistry(devices, clock.now);
  for (const id of online) registry.heartbeat(id);
  return { registry, clock };
}

describe("resolveTarget — contract shape", () => {
  test("Usman with no spoken target → his own hub PC", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "usman" }, registry)).toEqual({ ok: true, deviceId: "usman-pc", owner: "usman", online: true });
  });
  test("Mehroz with no spoken target → his own companion, never Usman's PC", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz" }, registry)).toEqual({ ok: true, deviceId: "mehroz-pc", owner: "mehroz", online: true });
  });
  test("person ids are case-insensitive; unknown people are refused", () => {
    const { registry } = setup([defaultHub()]);
    expect(resolveTarget({ personId: " Usman " }, registry).ok).toBe(true);
    expect(resolveTarget({ personId: "stranger" }, registry)).toEqual({ ok: false, reason: "unknown person" });
    expect(resolveTarget({ personId: "" }, registry)).toEqual({ ok: false, reason: "unknown person" });
  });
});

describe("resolveTarget — never a silent fallback to Usman's PC", () => {
  test("Mehroz's only device offline → device offline (not the hub)", () => {
    const { registry } = setup([defaultHub(), mehrozPc]);
    expect(resolveTarget({ personId: "mehroz" }, registry)).toEqual({ ok: false, reason: "device offline", deviceId: "mehroz-pc" });
  });
  test("Mehroz with no device at all → refused, not the hub", () => {
    const { registry } = setup([defaultHub()]);
    const r = resolveTarget({ personId: "mehroz" }, registry);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("usman-pc");
  });
  test("a companion that stops heart-beating goes offline after the TTL", () => {
    const { registry, clock } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz" }, registry).ok).toBe(true);
    clock.advance(registry.ttlMs + 1);
    expect(resolveTarget({ personId: "mehroz" }, registry)).toEqual({ ok: false, reason: "device offline", deviceId: "mehroz-pc" });
  });
  test("an explicit goodbye marks the companion offline at once", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    registry.markOffline("mehroz-pc");
    expect(resolveTarget({ personId: "mehroz" }, registry).ok).toBe(false);
  });
  test("revoked or expired companions are not targets", () => {
    const { registry } = setup([defaultHub(), { ...mehrozPc, revokedAt: 1 }], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz" }, registry)).toEqual({ ok: false, reason: "no device registered for mehroz" });
    const expired = setup([defaultHub(), { ...mehrozPc, expiresAt: 999_999 }], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz" }, expired.registry).ok).toBe(false);
  });
  test("primary offline is not re-routed to another of the same person's devices", () => {
    const { registry } = setup([defaultHub(), mehrozPc, mehrozLaptop], ["mehroz-laptop"]);
    expect(resolveTarget({ personId: "mehroz" }, registry)).toEqual({ ok: false, reason: "device offline", deviceId: "mehroz-pc" });
  });
});

describe("resolveTarget — spoken targets must be the speaker's own", () => {
  test('"on my laptop" picks the speaker\'s laptop', () => {
    const { registry } = setup([defaultHub(), mehrozPc, mehrozLaptop, usmanLaptop], ["mehroz-pc", "mehroz-laptop", "usman-laptop"]);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on my laptop" }, registry)).toEqual({ ok: true, deviceId: "mehroz-laptop", owner: "mehroz", online: true });
    expect(resolveTarget({ personId: "usman", spokenTarget: "on my laptop" }, registry)).toEqual({ ok: true, deviceId: "usman-laptop", owner: "usman", online: true });
    expect(resolveTarget({ personId: "usman", spokenTarget: "on my computer" }, registry)).toEqual({ ok: true, deviceId: "usman-pc", owner: "usman", online: true });
  });
  test("Mehroz naming Usman's PC is refused", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    const r = resolveTarget({ personId: "mehroz", spokenTarget: "on Usman's PC" }, registry);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("belongs to usman");
  });
  test("Usman naming Mehroz's PC is refused (his commands never reach Mehroz's companion)", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    for (const spokenTarget of ["on Mehroz's PC", "on mehroz pc", "on Mehroz's computer"]) {
      const r = resolveTarget({ personId: "usman", spokenTarget }, registry);
      expect(r.ok).toBe(false);
    }
  });
  test("a device word only someone else owns is refused, not guessed", () => {
    const { registry } = setup([defaultHub(), mehrozLaptop], ["mehroz-laptop"]);
    const r = resolveTarget({ personId: "usman", spokenTarget: "on my laptop" }, registry);
    expect(r).toEqual({ ok: false, reason: "that device isn't yours; you can only run commands on your own devices" });
  });
  test("an unknown device name is refused", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on the fridge" }, registry).ok).toBe(false);
  });
  test("a spoken target that is offline says device offline", () => {
    const { registry } = setup([defaultHub(), mehrozPc, mehrozLaptop], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on my laptop" }, registry)).toEqual({ ok: false, reason: "device offline", deviceId: "mehroz-laptop" });
  });
  test("ambiguous names ask instead of guessing", () => {
    const second = { ...mehrozLaptop, id: "mehroz-laptop-2", label: "Mehroz's old laptop" };
    const { registry } = setup([defaultHub(), mehrozLaptop, second], ["mehroz-laptop", "mehroz-laptop-2"]);
    const r = resolveTarget({ personId: "mehroz", spokenTarget: "laptop" }, registry);
    expect(r.ok).toBe(false);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "old laptop" }, registry)).toMatchObject({ ok: true, deviceId: "mehroz-laptop-2" });
  });
  test('"on mine" with no device words falls back to the speaker\'s default only', () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz", spokenTarget: "on mine" }, registry)).toMatchObject({ ok: true, deviceId: "mehroz-pc" });
  });
});

describe("resolveTarget — origin device and several devices", () => {
  test("a command relayed from a companion runs on that companion", () => {
    const { registry } = setup([defaultHub(), usmanLaptop], ["usman-laptop"]);
    expect(resolveTarget({ personId: "usman", originDeviceId: "usman-laptop" }, registry)).toMatchObject({ ok: true, deviceId: "usman-laptop" });
  });
  test("an origin device the person doesn't own is refused", () => {
    const { registry } = setup([defaultHub(), mehrozPc], ["mehroz-pc"]);
    expect(resolveTarget({ personId: "usman", originDeviceId: "mehroz-pc" }, registry).ok).toBe(false);
    expect(resolveTarget({ personId: "mehroz", originDeviceId: "usman-pc" }, registry).ok).toBe(false);
  });
  test("no primary: the only online device is used; several online → ask", () => {
    const a = { ...mehrozPc, primary: false };
    const one = setup([defaultHub(), a, mehrozLaptop], ["mehroz-laptop"]);
    expect(resolveTarget({ personId: "mehroz" }, one.registry)).toMatchObject({ ok: true, deviceId: "mehroz-laptop" });
    const both = setup([defaultHub(), a, mehrozLaptop], ["mehroz-laptop", "mehroz-pc"]);
    expect(resolveTarget({ personId: "mehroz" }, both.registry).ok).toBe(false);
    const none = setup([defaultHub(), a, mehrozLaptop]);
    expect(resolveTarget({ personId: "mehroz" }, none.registry)).toEqual({ ok: false, reason: "device offline" });
  });
});

test("parseSpokenTarget", () => {
  expect(parseSpokenTarget("on my laptop", "mehroz")).toEqual({ owner: "mehroz", words: ["laptop"] });
  expect(parseSpokenTarget("On Usman’s computer.", "mehroz")).toEqual({ owner: "usman", words: ["pc"] });
  expect(parseSpokenTarget("", "usman")).toBeNull();
});

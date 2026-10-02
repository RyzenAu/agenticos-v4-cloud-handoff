import { afterEach, describe, expect, test } from "bun:test";
import { authorise, type Principal } from "../identity/principal";
import { resolveTarget } from "./route";
import { startHub, type Hub } from "./test-harness";

/**
 * Criterion 3: in the server (and cloud) role the hub is not a device. A founder's "here" resolves to that
 * founder's OWN companion or fails honestly: never the hub, never the other founder's PC. Shared bot computers
 * stay reachable by both. Synthetic hub, people and devices only; no desktop is touched.
 */

const hubs: Hub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});

async function rig(role: "pc" | "cloud" | "server") {
  const hub = await startHub({ hubRole: role });
  hubs.push(hub);
  const usman = hub.svc.store.registerCompanion("usman", { label: "Usman's laptop", aliases: ["pc", "laptop"] }).device;
  const mehroz = hub.svc.store.registerCompanion("mehroz", { label: "Mehroz's PC", aliases: ["pc"] }).device;
  const bot = hub.svc.store.registerComputer({ name: "research-bot", adapter: "synthetic", createdBy: "usman" }, { label: "Research computer" }).device;
  const online = (...ids: string[]) => ids.forEach((id) => hub.svc.registry.heartbeat(id));
  const resolve = (ctx: Parameters<typeof resolveTarget>[0]) => resolveTarget(ctx, hub.svc.registry);
  return { hub, usman, mehroz, bot, online, resolve };
}

const principal = (personId: "usman" | "mehroz", via: Principal["via"], deviceId?: string): Principal => ({ personId, via, actor: "human", displayName: personId, ...(deviceId ? { deviceId } : {}) });

for (const role of ["server", "cloud"] as const) {
  describe(`${role} role: the hub is not a device`, () => {
    test("the registry lists no hub, and Usman's PC is not a name anyone can target", async () => {
      const r = await rig(role);
      expect(r.hub.svc.hubIsDevice).toBe(false);
      expect(r.hub.svc.hubRole).toBe(role);
      expect(r.hub.svc.registry.targets().some((d) => d.kind === "hub" || d.id === "usman-pc")).toBe(false);
      r.online(r.usman.id, r.mehroz.id);
      // No target means "Usman's PC" cannot resolve to a hub: the hub is not a fallback for anyone.
      expect(r.resolve({ personId: "usman", spokenTarget: "on nebula" })).toMatchObject({ ok: false });
    });

    test("usman, signed in remotely, targets usman's own companion", async () => {
      const r = await rig(role);
      r.online(r.usman.id, r.mehroz.id);
      expect(r.resolve({ personId: "usman", spokenTarget: "here", originDeviceId: r.usman.id })).toMatchObject({ ok: true, deviceId: r.usman.id, owner: "usman" });
      expect(r.resolve({ personId: "usman" })).toMatchObject({ ok: true, deviceId: r.usman.id });
    });

    test("mehroz, signed in remotely, targets mehroz's own companion, never usman's", async () => {
      const r = await rig(role);
      r.online(r.usman.id, r.mehroz.id);
      expect(r.resolve({ personId: "mehroz", spokenTarget: "this pc" })).toMatchObject({ ok: true, deviceId: r.mehroz.id, owner: "mehroz" });
      expect(r.resolve({ personId: "mehroz", spokenTarget: "on my pc" })).toMatchObject({ ok: true, deviceId: r.mehroz.id });
      // Naming Usman's device is refused outright, and so is borrowing his device id as the origin.
      expect(r.resolve({ personId: "mehroz", spokenTarget: "on Usman's PC" })).toMatchObject({ ok: false });
      expect(r.resolve({ personId: "mehroz", originDeviceId: r.usman.id })).toMatchObject({ ok: false });
    });

    test("the requester's companion offline is an honest failure: no fallback to the hub or to the other founder's PC", async () => {
      const r = await rig(role);
      r.online(r.usman.id); // mehroz's companion never heart-beats: offline
      const result = r.resolve({ personId: "mehroz", spokenTarget: "here" });
      expect(result).toEqual({ ok: false, reason: "device offline", deviceId: r.mehroz.id });
      expect(r.resolve({ personId: "mehroz" })).toEqual({ ok: false, reason: "device offline", deviceId: r.mehroz.id });
      // And the same the other way round.
      r.hub.svc.registry.markOffline(r.usman.id);
      r.online(r.mehroz.id);
      expect(r.resolve({ personId: "usman" })).toEqual({ ok: false, reason: "device offline", deviceId: r.usman.id });
    });

    test("a loopback caller (Hermes, Telegram relay, a local script) claims the hub as its origin: honest failure, nothing runs on the hub", async () => {
      const r = await rig(role);
      r.online(r.usman.id, r.mehroz.id);
      expect(r.resolve({ personId: "usman", spokenTarget: "here", originDeviceId: "usman-pc" })).toEqual({ ok: false, reason: "the device this came from isn't one of yours" });
      const deps = { resolveTarget: r.resolve, hubDeviceId: "" };
      const loopbackOwner = principal("usman", "loopback-owner", "usman-pc");
      const open = authorise(loopbackOwner, { kind: "device", executor: "hub", presence: true }, "control", deps);
      expect(open.ok).toBe(false);
      // A remote founder asking the hub to run something on its desktop is told to use his own device.
      const remote = authorise(principal("mehroz", "paired-session"), { kind: "device", executor: "hub" }, "control", deps);
      expect(remote).toMatchObject({ ok: false, status: 403 });
      expect((remote as { reason: string }).reason).toMatch(/your own device/);
      // Dispatching to his own companion is the route that works.
      expect(authorise(principal("mehroz", "paired-session"), { kind: "device", executor: "dispatch" }, "control", deps)).toMatchObject({ ok: true, targetDeviceId: r.mehroz.id });
    });

    test("shared bot computers are reachable by both founders, by exact name, never as a default or via 'here'", async () => {
      const r = await rig(role);
      r.online(r.usman.id, r.mehroz.id, r.bot.id);
      for (const who of ["usman", "mehroz"] as const) {
        expect(r.resolve({ personId: who, spokenTarget: `computer:${r.bot.id}` })).toMatchObject({ ok: true, deviceId: r.bot.id, owner: "shared" });
        expect(r.resolve({ personId: who, spokenTarget: "the research computer" })).toMatchObject({ ok: true, deviceId: r.bot.id });
        expect(r.resolve({ personId: who, spokenTarget: "here" })).toMatchObject({ ok: true, deviceId: who === "usman" ? r.usman.id : r.mehroz.id });
      }
      // Offline bot: honest failure for both, no re-routing to a person's PC.
      r.hub.svc.registry.markOffline(r.bot.id);
      for (const who of ["usman", "mehroz"] as const) expect(r.resolve({ personId: who, spokenTarget: `computer:${r.bot.id}` })).toEqual({ ok: false, reason: "device offline", deviceId: r.bot.id });
    });
  });
}

describe("pc role is unchanged: the hub is Usman's PC, and only his", () => {
  test("hub is a device, usman's 'here' at the PC is the hub, mehroz never gets it", async () => {
    const r = await rig("pc");
    expect(r.hub.svc.hubIsDevice).toBe(true);
    expect(r.hub.svc.registry.targets().some((d) => d.id === "usman-pc" && d.kind === "hub")).toBe(true);
    expect(r.resolve({ personId: "usman", spokenTarget: "here", originDeviceId: "usman-pc" })).toMatchObject({ ok: true, deviceId: "usman-pc" });
    expect(r.resolve({ personId: "mehroz", originDeviceId: "usman-pc" })).toMatchObject({ ok: false });
    r.online(r.mehroz.id);
    expect(r.resolve({ personId: "mehroz", spokenTarget: "on nebula" })).toMatchObject({ ok: false });
  });
});

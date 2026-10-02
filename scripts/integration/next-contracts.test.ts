// Cross-slice contracts in the candidate (NEXUS palette and handoff + Jarvis device dispatch + coding jobs).
// SYNTHETIC: registry fixtures from scripts/devices/synthetic.ts, no device, network or model.
import { describe, expect, test } from "bun:test";
import { previewTarget } from "../commands/plugin";
import { staticRegistry } from "../devices/registry";
import { SYNTHETIC_MEHROZ_PC_ID, SYNTHETIC_USMAN_HUB_ID, syntheticDevices } from "../devices/synthetic";
import { entryTarget } from "../../src/components/shell/palette-target";
import { codingHandoff, handoffMotion } from "../../src/components/shell/handoff";

const registry = () => {
  const r = staticRegistry(syntheticDevices());
  r.heartbeat(SYNTHETIC_USMAN_HUB_ID);
  r.heartbeat(SYNTHETIC_MEHROZ_PC_ID);
  return r;
};
const who = (personId: "usman" | "mehroz", deviceId?: string) => ({ personId, ...(deviceId ? { deviceId } : {}) }) as never;
const deviceEntry = { id: "app:powerpoint", action: { type: "open-app" } } as never;

describe("palette target line agrees with the device contract", () => {
  test("Mehroz's 'here' and 'this pc' name Mehroz's own PC, never Usman's", () => {
    for (const say of ["here", "on this pc"]) {
      const p = previewTarget(who("mehroz", SYNTHETIC_MEHROZ_PC_ID), say, registry());
      expect(p).toMatchObject({ ok: true, deviceId: SYNTHETIC_MEHROZ_PC_ID, owner: "mehroz" });
      expect(entryTarget(deviceEntry, p as never).text).toContain("(mehroz)");
    }
  });
  test("Mehroz naming Usman's PC is refused and the row says it won't run", () => {
    const p = previewTarget(who("mehroz", SYNTHETIC_MEHROZ_PC_ID), "on Usman's PC", registry());
    expect(p.ok).toBe(false);
    expect(JSON.stringify(p)).not.toContain(SYNTHETIC_USMAN_HUB_ID);
    expect(entryTarget(deviceEntry, p as never)).toMatchObject({ ok: false });
  });
  test("an offline device never silently falls back to another machine", () => {
    const r = staticRegistry(syntheticDevices());
    r.heartbeat(SYNTHETIC_USMAN_HUB_ID);
    const p = previewTarget(who("mehroz"), undefined, r);
    expect(p.ok).toBe(false);
    expect(p).not.toMatchObject({ deviceId: SYNTHETIC_USMAN_HUB_ID });
  });
  test("before the preview answers the row does not guess a device", () => {
    expect(entryTarget(deviceEntry, null, true).text).toBe("Checking which device…");
    expect(entryTarget(deviceEntry, null, false).text).not.toMatch(/Mehroz|Usman/);
  });
});

describe("coding jobs feed the shared handoff signal honestly", () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const job = (state: string, extra = {}) => ({ id: "j1", kind: "coding", state, title: "Synthetic fix", updatedAt: new Date(now - 1000).toISOString(), ...extra }) as never;
  test("the job's device id reaches the handoff row, and waiting on a yes never animates", () => {
    const h = codingHandoff([job("running", { targetDeviceId: SYNTHETIC_MEHROZ_PC_ID })], now)!;
    expect(h).toMatchObject({ from: "jarvis", to: "coding", state: "running", deviceId: SYNTHETIC_MEHROZ_PC_ID, source: "job-history" });
    expect(handoffMotion(h, [], false)).toBe("travel");
    expect(handoffMotion(h, [], true)).toBe("still");
    expect(handoffMotion(codingHandoff([job("awaiting-approval")], now)!, [], false)).toBe("still");
  });
  test("a long-finished job is not drawn, and no job means no handoff", () => {
    expect(codingHandoff([job("succeeded", { updatedAt: new Date(now - 3_600_000).toISOString() })], now)).toBeNull();
    expect(codingHandoff([], now)).toBeNull();
  });
});

// W-B (29 Sep 2026): OpenClaw's page says what it's for in one sentence and shows only the phone
// pairing and its status, all read from the capability check (nothing invented).
import { describe, expect, test } from "bun:test";
import { OPENCLAW_PURPOSE, connectedDevices, openClawView } from "../src/lib/openclaw-status";

describe("OpenClaw status in plain words", () => {
  test("one sentence of purpose", () => {
    expect(OPENCLAW_PURPOSE.split(". ").length).toBe(1);
    expect(OPENCLAW_PURPOSE).toContain("iPhone");
    expect(OPENCLAW_PURPOSE).toContain("you don't use it directly");
  });
  test("connected devices come from the capability evidence", () => {
    expect(connectedDevices("connected: iPhone (12 commands), Mehroz PC (1 command)")).toEqual([{ name: "iPhone", commands: 12 }, { name: "Mehroz PC", commands: 1 }]);
    expect(connectedDevices("gateway running, no devices paired")).toEqual([]);
    expect(connectedDevices(undefined)).toEqual([]);
  });
  test("available → the phone is connected", () => {
    const v = openClawView({ status: "available", evidence: "connected: iPhone (12 commands)" }, false);
    expect(v).toMatchObject({ tone: "ok", title: "iPhone is connected", gateway: "running" });
  });
  test("gateway down, paired-but-offline, nothing paired", () => {
    expect(openClawView({ status: "setup-required", evidence: "OpenClaw gateway missing", ownerAction: "start it" }, false)).toMatchObject({ tone: "warn", title: "The bridge isn't running", gateway: "not running", next: "start it" });
    expect(openClawView({ status: "setup-required", evidence: "1 paired node(s), none connected" }, false).title).toBe("Your phone is paired but not connected");
    expect(openClawView({ status: "setup-required", evidence: "gateway running, no devices paired" }, false).title).toBe("No device is paired");
  });
  test("unknown is never 'connected'", () => {
    expect(openClawView(null, true)).toMatchObject({ tone: "neutral", title: "Couldn't read OpenClaw's status", gateway: "unknown", devices: [] });
    expect(openClawView(undefined, false).tone).toBe("neutral");
  });
});

// The optional Command scene (NEXUS-ADDENDUM item 3): real status per object, each opens its 2D page;
// no WebGL, camera or canvas; loaded lazily so the OS never pays for it or needs it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codingObject, financeObject, leadsObject, memoryObject, receptionistObject } from "../src/components/shell/command-scene/scene-status";
import { resolveCommand, buildCommandIndex } from "../src/lib/commands/registry";
import { voiceDestination } from "../src/lib/voice-actions";

const now = Date.parse("2026-09-28T03:00:00Z");
const fresh = new Date(now - 60_000).toISOString();

describe("each object shows a real status with source and last update, and opens its 2D page", () => {
  test("receptionist", () => {
    const o = receptionistObject({ data: { ok: true, updatedAt: fresh, data: { verdict: { decision: "Not safe to sell" }, gatesPassed: 0, gates: [1, 2, 3, 4, 5], incidents: [1, 2] } } }, now);
    expect(o).toMatchObject({ to: "/receptionist", value: "Not safe to sell", state: "live", lastUpdate: fresh });
    expect(o.detail).toContain("2 flagged");
    expect(receptionistObject({ data: { ok: false, error: "Retell not configured", updatedAt: fresh } }, now)).toMatchObject({ value: null, state: "failed" });
    expect(receptionistObject({}, now).state).toBe("unknown");
  });
  test("leads, coding, memory, finance", () => {
    expect(leadsObject({ data: { ok: true, updatedAt: fresh, data: { total: 3 } } }, now)).toMatchObject({ to: "/leads", value: "3 to call", state: "live" });
    expect(codingObject(true, null)).toMatchObject({ to: "/agents/claude-code", value: null, state: "unknown" });
    expect(codingObject(true, { title: "Fix tests", state: "running", updatedAt: fresh }, now)).toMatchObject({ value: "running", state: "live" });
    expect(memoryObject({ data: { settings: { mode: "off", hindsight_enabled: false }, last_success_at: null } })).toMatchObject({ to: "/memory", value: "Writes off", state: "setup-required" });
    expect(financeObject({ data: { rowCount: 0 } })).toMatchObject({ to: "/finance", value: null, state: "setup-required" });
    expect(financeObject({ data: { rowCount: 24, asOf: "2026-09-26", lastImportAt: fresh, stale: true } })).toMatchObject({ value: "As of 2026-09-26", state: "stale" });
    expect(financeObject({ error: new Error("x") })).toMatchObject({ value: null, state: "failed" });
  });
});

describe("optional and lightweight", () => {
  const dir = join(import.meta.dir, "../src/components/shell/command-scene");
  test("no WebGL, canvas, three.js or camera", () => {
    for (const f of ["command-scene.tsx", "scene-status.ts", "host.tsx", "command-scene.css"]) {
      // Code only: the files' own comments say "no WebGL".
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(/webgl|<canvas|from "three"|@react-three|getUserMedia|mediaDevices/i);
    }
  });
  test("loaded lazily, only when opened", () => {
    const host = readFileSync(join(dir, "host.tsx"), "utf8");
    expect(host).toContain('lazy(() => import("./command-scene"))');
    expect(host).toContain("if (!loaded) return null;");
    const root = readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8");
    expect(root).not.toContain("command-scene/command-scene");
  });
  test("the palette and Jarvis open it the same way (?scene=1)", () => {
    const r = resolveCommand("open the command scene", buildCommandIndex());
    expect(r.status === "resolved" && r.entry.action).toEqual({ type: "navigate", to: "/business", search: { scene: "1" } });
    expect(voiceDestination("/business?scene=1")).toMatchObject({ search: { scene: "1" } });
    // Old Today links keep working: the route redirects and keeps the search.
    expect(voiceDestination("/today?scene=1")).toMatchObject({ search: { scene: "1" } });
  });
});

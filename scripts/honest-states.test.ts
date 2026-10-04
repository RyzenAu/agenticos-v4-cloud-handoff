// Honest data states (NEXUS-ADDENDUM item 6): live / simulated / stale / failed / unknown / setup required,
// with source and last success. Unknown never renders as 0 or "all clear"; a bare metric fails this test.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hidesValue, honestFromPanel, honestFromQuery, honestFromSignal, HONEST_LABEL, HONEST_STATES, sourceLine } from "../src/lib/honest-state";
import { SignalTile } from "../src/components/shell/page-parts";

const ROOT = join(import.meta.dir, "..");
const now = Date.parse("2026-09-28T02:00:00Z");

describe("honest-state", () => {
  test("six states, each with a word", () => {
    expect(HONEST_STATES).toEqual(["live", "simulated", "stale", "failed", "unknown", "setup-required"]);
    for (const s of HONEST_STATES) expect(HONEST_LABEL[s].length).toBeGreaterThan(2);
    expect(hidesValue("failed") && hidesValue("unknown") && hidesValue("setup-required")).toBe(true);
    expect(hidesValue("live") || hidesValue("simulated") || hidesValue("stale")).toBe(false);
  });
  test("legacy tile states map onto the six", () => {
    expect([honestFromSignal("ok"), honestFromSignal("zero"), honestFromSignal("stale"), honestFromSignal(undefined)]).toEqual(["live", "live", "stale", undefined]);
    expect(honestFromSignal("nonsense")).toBe("unknown");
  });
  test("panel and query results", () => {
    expect(honestFromPanel(null, now)).toBe("unknown");
    expect(honestFromPanel({ ok: false }, now)).toBe("failed");
    expect(honestFromPanel({ ok: true, updatedAt: new Date(now - 60_000).toISOString() }, now)).toBe("live");
    expect(honestFromPanel({ ok: true, updatedAt: new Date(now - 60 * 60_000).toISOString() }, now)).toBe("stale");
    expect(honestFromPanel({ ok: true, updatedAt: new Date(now).toISOString() }, now, { simulated: true })).toBe("simulated");
    expect(honestFromPanel({ ok: true }, now, { setupRequired: true })).toBe("setup-required");
    expect(honestFromQuery({}, now)).toBe("unknown");
    expect(honestFromQuery({ error: new Error("x") }, now)).toBe("failed");
    expect(honestFromQuery({ data: 3, error: new Error("x") }, now)).toBe("stale");
    expect(honestFromQuery({ data: 0, dataUpdatedAt: now - 1000 }, now)).toBe("live");
  });
  test("source line says when the source last answered, or never", () => {
    expect(sourceLine("Receptionist feed", now - 3 * 60_000, now)).toBe("Receptionist feed · last success 3 min ago");
    expect(sourceLine("NAB CSV import", null, now)).toBe("NAB CSV import · last success: never");
  });
});

describe("SignalTile renders the state, never a number for unknown/failed/setup", () => {
  const html = (props: Parameters<typeof SignalTile>[0]) => renderToStaticMarkup(createElement(SignalTile, props));
  test("unknown shows 'Unknown', not 0", () => {
    const out = html({ label: "Calls", value: 0, state: "unknown", source: "Call queue" });
    expect(out).toContain("Unknown");
    expect(out).not.toMatch(/>0</);
    expect(out).toContain("Source: Call queue");
  });
  test("failed shows 'Couldn't read' with danger, never a success tone", () => {
    const out = html({ label: "Sites up", value: "7 of 7", tone: "success", state: "failed" });
    expect(out).toContain("Couldn&#x27;t read");
    expect(out).not.toContain('data-tone="success"');
    expect(out).not.toContain("7 of 7");
  });
  test("setup-required keeps a word but never a number", () => {
    expect(html({ label: "Live bank feed", value: "Not connected", state: "setup-required" })).toContain("Not connected");
    const n = html({ label: "Bank balance", value: 1234, state: "setup-required" });
    expect(n).toContain("Setup required");
    expect(n).not.toContain("1234");
  });
  test("simulated drops a success tone and says Simulated; live shows the source and last success", () => {
    const sim = html({ label: "Month end", value: "≈ A$700", tone: "success", state: "simulated" });
    expect(sim).toContain("Simulated");
    expect(sim).not.toContain('data-tone="success"');
    const live = html({ label: "Open leads", value: 4, state: "live", source: "CRM", updatedAt: now - 120_000, now });
    expect(live).toContain(">Live<");
    expect(live).toContain("Source: CRM");
    expect(live).toContain("Updated 2 min ago");
  });
});

// Every prominent metric on the destinations must say what it is. A <SignalTile> without `state=` is a bare metric.
const SCANNED = [
  ...readdirSync(join(ROOT, "src/components/shell/pages")).filter((f) => f.endsWith(".tsx")).map((f) => `src/components/shell/pages/${f}`),
  "src/components/finance/signal-row.tsx",
  "src/components/receptionist/dashboard/shared.tsx",
];

describe("no bare metrics on the destinations", () => {
  for (const file of SCANNED) {
    test(file, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      const tiles = src.split("<SignalTile").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
      for (const tile of tiles) {
        expect({ file, tile: tile.slice(0, 80), hasState: /\bstate=/.test(tile) }).toMatchObject({ hasState: true });
        // A hard-coded number is never shown as a live metric.
        expect(/\bvalue=\{\s*\d+\s*\}/.test(tile)).toBe(false);
      }
    });
  }
});

// REVIEW-T1 fix 5: the badge follows what the tile really shows. Unknown or stale data can never say "Live".
import { payloadTime, tileHonestState } from "../src/lib/honest-state";
import { codingObject, leadsObject, memoryObject, receptionistObject } from "../src/components/shell/command-scene/scene-status";
import { aiSpendTiles, csvDataTile } from "../src/components/finance/signals";

describe("a tile with unknown or stale data can't show Live", () => {
  const html = (props: Parameters<typeof SignalTile>[0]) => renderToStaticMarkup(createElement(SignalTile, props));
  test("ok with no value → Unknown badge, not Live", () => {
    for (const value of [null, undefined, ""]) {
      const out = html({ label: "Nearest plan limit", value, state: "ok", source: "AI usage" });
      expect(out).not.toContain(">Live<");
      expect(out).toContain('data-state="unknown"');
    }
    expect(tileHonestState("ok", { empty: true })).toBe("unknown");
  });
  test("ok or live with data older than its limit → Stale (with its age), never Live, and no success tone", () => {
    const threeDays = now - 3 * 86_400_000;
    for (const state of ["ok", "live"] as const) {
      const out = html({ label: "AI spend", value: "A$12.00", tone: "success", state, updatedAt: threeDays, now, source: "AI usage" });
      expect(out).not.toContain(">Live<");
      expect(out).toContain(">Stale<");
      expect(out).toContain("Stale · updated");
      expect(out).not.toContain('data-tone="success"');
    }
    expect(tileHonestState("ok", { empty: false, at: threeDays, now })).toBe("stale");
    expect(tileHonestState("ok", { empty: false, at: now - 60_000, now })).toBe("live");
  });
  test("honestFromQuery uses the payload's own time, not the fetch time", () => {
    const old = new Date(now - 3 * 86_400_000).toISOString();
    expect(payloadTime({ generatedAt: old })).toBe(Date.parse(old));
    expect(payloadTime({ catalogue: { updatedAt: old } })).toBe(Date.parse(old));
    expect(honestFromQuery({ data: { generatedAt: old }, dataUpdatedAt: now }, now)).toBe("stale");
    expect(honestFromQuery({ data: { total: 3 }, dataUpdatedAt: now }, now)).toBe("live");
  });
  test("a failed tile shows no fake 'Updated just now'", () => {
    const out = html({ label: "Calls to make", value: null, state: "failed", updatedAt: now, now });
    expect(out).not.toContain("Updated just now");
    expect(out).toContain("No successful read yet");
  });
  test("scene: 'Status unknown' and an empty CRM are Unknown; old coding and memory reads are Stale", () => {
    const fresh = new Date(now - 60_000).toISOString();
    expect(receptionistObject({ data: { ok: true, updatedAt: fresh, data: { verdict: { decision: "Status unknown" }, gatesPassed: null as never, gates: [], incidents: [] } } }, now)).toMatchObject({ value: null, state: "unknown", detail: "Go-live gates not reported · 0 flagged" });
    expect(leadsObject({ data: { ok: true, updatedAt: fresh, data: { total: 0, crmLeads: 0 } } }, now)).toMatchObject({ value: null, state: "unknown" });
    const week = new Date(now - 7 * 86_400_000).toISOString();
    expect(codingObject(true, { title: "x", state: "succeeded", updatedAt: week }, now).state).toBe("stale");
    expect(memoryObject({ data: { settings: { mode: "on" }, last_success_at: week } }, now).state).toBe("stale");
  });
  test("finance: totals with no numbers and a status with no row count are Unknown, never A$0.00 or 'null rows'", () => {
    const tiles = aiSpendTiles({ data: { generatedAt: new Date(now).toISOString(), month: { label: "Sep", daysInMonth: 30 }, totals: { fixedAud: null, meteredAud: null, monthAud: null, projectedAud: null, unknown: null } } as never, loading: false, failed: false });
    for (const t of tiles) expect(t).toMatchObject({ value: null, state: "unknown" });
    expect(csvDataTile({ data: { rowCount: null as never, lastImportAt: null }, loading: false, failed: false })).toMatchObject({ value: null, state: "unknown" });
  });
});

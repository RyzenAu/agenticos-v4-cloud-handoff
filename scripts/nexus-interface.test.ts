// NEXUS interface slice: target labels on every palette row, the shared handoff signal, stillness rules,
// and no generic ambient float in the Command scene. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entryTarget } from "../src/components/shell/palette-target";
import { HANDOFF_LINGER_MS, codingHandoff, handoffMotion, parseHandoff, visibleHandoffs, type Handoff } from "../src/components/shell/handoff";

const now = Date.parse("2026-09-29T03:00:00Z");
const iso = (ms: number) => new Date(now - ms).toISOString();
const job = (o: Record<string, unknown>) => ({ id: "j1", kind: "coding", state: "running", title: "Fix the tests", updatedAt: iso(5_000), targetDeviceId: "nebula-pc", ...o }) as never;

describe("palette rows say where they act", () => {
  test("pages, websites, jarvis answers", () => {
    expect(entryTarget({ id: "page:/leads", action: { type: "navigate", to: "/leads" } })).toMatchObject({ kind: "window", ok: true });
    expect(entryTarget({ id: "site:x", action: { type: "open-url", url: "https://example.com" } }).text).toBe("New tab in this browser");
    expect(entryTarget({ id: "rule:ask-jarvis", action: { type: "navigate", to: "/jarvis" } }).kind).toBe("jarvis");
  });
  const device = { id: "app:Word", action: { type: "device", op: "open_app", subject: "Word", utterance: "open Word" } } as const;
  test("a device entry never names a device it has not resolved", () => {
    expect(entryTarget(device).text).toContain("shown before it runs");
    expect(entryTarget(device, null, true).text).toBe("Checking which device…");
    expect(entryTarget(device, { ok: true, deviceId: "d", label: "Nebula PC", owner: "Usman", online: true, routing: "devices" }).text).toBe("Runs on Nebula PC (Usman)");
    const bad = entryTarget(device, { ok: false, reason: "Usman's PC is offline", routing: "devices" });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.text).toContain("offline");
  });
});

describe("handoffs come only from real sources", () => {
  test("coding job history becomes Jarvis → Coding; other kinds and old finished jobs do not", () => {
    expect(codingHandoff([job({})], now)).toMatchObject({ from: "jarvis", to: "coding", state: "running", source: "job-history", deviceId: "nebula-pc" });
    expect(codingHandoff([job({ state: "awaiting-approval" })], now)?.state).toBe("needs-you");
    expect(codingHandoff([job({ kind: "browser" })], now)).toBeNull();
    expect(codingHandoff([job({ state: "succeeded", updatedAt: iso(HANDOFF_LINGER_MS + 1000) })], now)).toBeNull();
    expect(codingHandoff([job({ state: "succeeded", updatedAt: iso(10_000) })], now)?.state).toBe("done");
    expect(codingHandoff([job({ state: "cancelled" })], now)).toBeNull();
    expect(codingHandoff([], now)).toBeNull();
  });
  test("events are validated, not repaired", () => {
    expect(parseHandoff({ id: "call:1", from: "receptionist", to: "leads", state: "running", label: "Call passed to Leads" }, now)).toMatchObject({ source: "event", at: now });
    expect(parseHandoff({ id: "x", from: "leads", to: "leads", state: "running" })).toBeNull();
    expect(parseHandoff({ id: "x", from: "nowhere", to: "leads", state: "running" })).toBeNull();
    expect(parseHandoff({ id: "x", from: "jarvis", to: "coding", state: "boom" })).toBeNull();
    expect(parseHandoff("nope")).toBeNull();
  });
  test("newest state per id wins and finished ones expire", () => {
    const a: Handoff = { id: "a", from: "jarvis", to: "coding", state: "running", label: "t", at: now - 5000, source: "event" };
    const list = visibleHandoffs([a, { ...a, state: "done", at: now - 1000 }, { ...a, id: "b", state: "failed", at: now - HANDOFF_LINGER_MS - 1 }], now);
    expect(list.map((h) => `${h.id}:${h.state}`)).toEqual(["a:done"]);
  });
});

describe("stillness", () => {
  const h = { state: "running" } as const;
  test("moving work travels once only when nothing has the reader", () => {
    expect(handoffMotion(h, [], false)).toBe("travel");
    expect(handoffMotion({ state: "queued" }, ["deciding"], false)).toBe("travel"); // the scene is itself a dialog
  });
  test("reading, editing, speaking, reduced motion, approving, finished, failed: still", () => {
    for (const r of ["reading", "editing", "talking"] as const) expect(handoffMotion(h, [r], false)).toBe("still");
    expect(handoffMotion(h, [], true)).toBe("still");
    for (const state of ["needs-you", "done", "failed"] as const) expect(handoffMotion({ state }, [], false)).toBe("still");
  });
});

describe("Command scene has no generic ambient float", () => {
  const css = readFileSync(join(import.meta.dir, "../src/components/shell/command-scene/command-scene.css"), "utf8");
  test("no drift keyframes and no infinite animation", () => {
    expect(css).not.toContain("cs-drift");
    expect(css).not.toMatch(/animation:[^;]*infinite/);
  });
  test("the sweep is off under reduced motion and plays once", () => {
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.cs-sweep\s*\{\s*display: none/);
    expect(css).toMatch(/cs-sweep 900ms[^;]* 1 both/);
  });
  test("black and gold tokens, phone list layout", () => {
    expect(css).toContain("var(--brand)");
    expect(css).toMatch(/max-width: 899px[\s\S]*grid-template-columns: 1fr/);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newVoiceLatencyId, parseVoiceLatencyEntry, readVoiceLatency, recordVoiceLatency, summariseByRoute, voiceLatencyFile, type VoiceLatencyEntry } from "./voice-latency";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "voice-latency-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the handle briefly */
    }
  }
});

const t0 = Date.now();
const entry = (overrides: Partial<VoiceLatencyEntry> = {}): unknown => ({
  id: "v_1",
  route: "rules",
  speechEndAt: t0,
  routeDecidedAt: t0 + 10,
  actionStartedAt: t0 + 20,
  actionDoneAt: t0 + 120,
  ...overrides,
});

describe("parseVoiceLatencyEntry", () => {
  test("accepts a well-formed entry and rounds fractional ms", () => {
    expect(parseVoiceLatencyEntry(entry({ actionDoneAt: t0 + 120.6 }))).toEqual({
      id: "v_1",
      route: "rules",
      speechEndAt: t0,
      routeDecidedAt: t0 + 10,
      actionStartedAt: t0 + 20,
      actionDoneAt: t0 + 121,
    });
  });
  test.each([
    ["id", entry({ id: "" })],
    ["id", entry({ id: undefined })],
    ["route", entry({ route: "" })],
    ["a timestamp", entry({ speechEndAt: "soon" })],
    ["a timestamp", entry({ actionDoneAt: -5 })],
  ])("rejects a missing or invalid %s", (_label, bad) => {
    expect(() => parseVoiceLatencyEntry(bad)).toThrow();
  });
  test("rejects timestamps that go backwards (speech end after route decided, etc.)", () => {
    expect(() => parseVoiceLatencyEntry(entry({ routeDecidedAt: t0 - 10 }))).toThrow();
    expect(() => parseVoiceLatencyEntry(entry({ actionStartedAt: t0 + 10 }))).not.toThrow(); // equal to routeDecidedAt is fine
    expect(() => parseVoiceLatencyEntry(entry({ actionDoneAt: t0 + 5 }))).toThrow(); // before actionStartedAt
  });
  test("rejects a timestamp that's obviously not close to now", () => {
    expect(() => parseVoiceLatencyEntry(entry({ speechEndAt: 0, routeDecidedAt: 5, actionStartedAt: 10, actionDoneAt: 15 }))).toThrow();
  });
});

describe("recordVoiceLatency / readVoiceLatency", () => {
  test("appends a JSON line and reads it back", () => {
    const dir = root();
    const recorded = recordVoiceLatency(dir, entry());
    expect(recorded?.id).toBe("v_1");
    const raw = readFileSync(voiceLatencyFile(dir), "utf8").trim();
    expect(JSON.parse(raw)).toEqual(recorded);
    expect(readVoiceLatency(dir)).toEqual([recorded]);
  });
  test("a bad entry is never written, and returns null rather than throwing", () => {
    const dir = root();
    expect(recordVoiceLatency(dir, { id: "v_1" })).toBeNull();
    expect(readVoiceLatency(dir)).toEqual([]);
  });
  test("readVoiceLatency returns [] when the file doesn't exist yet, and skips a corrupt line", () => {
    const dir = root();
    expect(readVoiceLatency(dir)).toEqual([]);
    recordVoiceLatency(dir, entry({ id: "v_1" }));
    const file = voiceLatencyFile(dir);
    const before = readFileSync(file, "utf8");
    appendFileSync(file, "not json at all\n");
    recordVoiceLatency(dir, entry({ id: "v_2", speechEndAt: t0 + 1000, routeDecidedAt: t0 + 1010, actionStartedAt: t0 + 1020, actionDoneAt: t0 + 1120 }));
    const rows = readVoiceLatency(dir);
    expect(rows.map((r) => r.id)).toEqual(["v_1", "v_2"]);
    expect(before).toContain('"id":"v_1"');
  });
  test("readVoiceLatency(root, limit) keeps only the most recent entries", () => {
    const dir = root();
    for (let i = 0; i < 5; i++)
      recordVoiceLatency(dir, entry({ id: `v_${i}`, speechEndAt: t0 + i * 1000, routeDecidedAt: t0 + i * 1000 + 10, actionStartedAt: t0 + i * 1000 + 20, actionDoneAt: t0 + i * 1000 + 120 }));
    expect(readVoiceLatency(dir, 2).map((r) => r.id)).toEqual(["v_3", "v_4"]);
    expect(readVoiceLatency(dir, 100).map((r) => r.id)).toEqual(["v_0", "v_1", "v_2", "v_3", "v_4"]);
  });
});

describe("summariseByRoute", () => {
  test("computes p50/p90 per route and sorts by how often it's used", () => {
    const rows: VoiceLatencyEntry[] = [
      ...[100, 110, 120, 300, 1000].map((ms, i) => entry({ id: `r_${i}`, route: "rules", speechEndAt: t0, routeDecidedAt: t0, actionStartedAt: t0, actionDoneAt: t0 + ms }) as VoiceLatencyEntry),
      ...[2000, 4000].map((ms, i) => entry({ id: `b_${i}`, route: "openai/gpt-oss-120b", speechEndAt: t0, routeDecidedAt: t0, actionStartedAt: t0, actionDoneAt: t0 + ms }) as VoiceLatencyEntry),
    ];
    const stats = summariseByRoute(rows);
    expect(stats.map((s) => s.route)).toEqual(["rules", "openai/gpt-oss-120b"]);
    const rules = stats.find((s) => s.route === "rules")!;
    expect(rules.n).toBe(5);
    expect(rules.min).toBe(100);
    expect(rules.max).toBe(1000);
    expect(rules.p50).toBe(120); // sorted [100,110,120,300,1000], nearest-rank 50th
    expect(rules.p90).toBe(1000); // nearest-rank 90th of 5 is the last
    const brain = stats.find((s) => s.route === "openai/gpt-oss-120b")!;
    expect(brain.n).toBe(2);
    expect(brain.p50).toBe(2000);
  });
  test("an empty list summarises to an empty list", () => {
    expect(summariseByRoute([])).toEqual([]);
  });
});

test("newVoiceLatencyId returns distinct, short ids", () => {
  const a = newVoiceLatencyId(), b = newVoiceLatencyId();
  expect(a).not.toBe(b);
  expect(a.length).toBeLessThan(30);
  expect(a.startsWith("v_")).toBe(true);
});

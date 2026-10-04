import { expect, test } from "bun:test";
import { memoryTimeline } from "../../src/components/memory/timeline-model";
import { syntheticRows } from "../../src/components/memory/synthetic-client";

const now = Date.parse("2026-09-30T12:00:00Z");
test("memory ranges keep the inclusive rolling boundary and exclude future/unknown dates", () => {
  const template = syntheticRows()[0];
  const rows = [
    { ...template, id: "boundary", date: new Date(now - 7 * 86400000).toISOString() },
    { ...template, id: "older", date: new Date(now - 7 * 86400000 - 1).toISOString() },
    { ...template, id: "future", date: new Date(now + 1).toISOString() },
    { ...template, id: "unknown", date: "unavailable" },
  ];
  expect(memoryTimeline(rows, "7d", now).flatMap((g) => g.rows.map((r) => r.id))).toEqual(["boundary"]);
  const all = memoryTimeline(rows, "all", now);
  expect(all.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["future", "boundary", "older", "unknown"]);
  expect(all.at(-1)?.date).toBeNull();
  expect(rows[0].id).toBe("boundary");
});
test("same device-calendar day is grouped without changing provenance or versions", () => {
  const template = syntheticRows()[0];
  const date = new Date(2026, 8, 25, 12).toISOString();
  const a = { ...template, id: "a", date };
  const b = { ...template, id: "b", date, version: 2 };
  const groups = memoryTimeline([a, b], "all", now);
  expect(groups).toHaveLength(1);
  expect(groups[0].rows).toEqual([a, b]);
  expect(groups[0].rows[0]).toBe(a);
});

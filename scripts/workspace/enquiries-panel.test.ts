// The Today speed-to-lead panel through the workspace service: read-only, metadata only, honest
// about the watcher not being scheduled. Synthetic data and in-memory sqlite only.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openEnquiryStore, readOpenEnquiries } from "../speed-to-lead/store";
import { createWorkspace } from "./sources";

const base = {
  get: async () => ({}),
  approvalsFile: join(import.meta.dir, "approvals.json"),
  sites: { check: async () => ({ checkedAt: "2026-09-27T06:00:00.000Z", sites: [], local: [], localNotRunning: [] }) },
  now: () => Date.parse("2026-09-28T01:00:00.000Z"),
};

describe("enquiries panel", () => {
  test("not wired → the panel fails honestly instead of showing zero", async () => {
    const r = await createWorkspace(base).panel("enquiries");
    expect(r.ok).toBe(false);
  });

  test("a CRM without the enquiries table reads as no open enquiries and is never altered", () => {
    const db = new Database(":memory:");
    expect(readOpenEnquiries(db)).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'enquiries'").get()).toBeNull();
  });

  test("open enquiries are projected with the clock; responded ones drop out; watcher not scheduled", async () => {
    const db = new Database(":memory:");
    const store = openEnquiryStore(db);
    const row = { topic: "Website", detectedAt: "2026-09-28T00:01:00.000Z", outsideHoursAtArrival: false };
    store.upsert({ ...row, ref: "a1", receivedAt: "2026-09-28T00:00:00.000Z", startedAt: "2026-09-28T00:00:00.000Z", dueAt: "2026-09-28T00:30:00.000Z" });
    store.upsert({ ...row, ref: "b2", receivedAt: "2026-09-28T00:40:00.000Z", startedAt: "2026-09-28T00:40:00.000Z", dueAt: "2026-09-28T01:40:00.000Z" });
    store.upsert({ ...row, ref: "c3", receivedAt: "2026-09-28T00:10:00.000Z", startedAt: "2026-09-28T00:10:00.000Z", dueAt: "2026-09-28T01:10:00.000Z" });
    store.markResponded("c3", "2026-09-28T00:20:00.000Z");
    const r = await createWorkspace({ ...base, enquiries: () => readOpenEnquiries(db), enquiryWatcherScheduled: false }).panel("enquiries");
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toMatchObject({ openCount: 2, overdueCount: 1, watcherScheduled: false });
    expect(r.data.items.map((i) => i.ref)).toEqual(["a1", "b2"]);
    expect(Object.keys(r.data.items[0]).sort()).toEqual(["dueInMinutes", "overdue", "ref", "sinceMinutes", "topic"]);
  });
});

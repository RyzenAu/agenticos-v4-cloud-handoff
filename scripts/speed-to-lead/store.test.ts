import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openEnquiryStore } from "./store";

const synthetic = () => ({
  ref: "ab12cd34",
  topic: "Dental practice website",
  receivedAt: "2026-11-17T03:00:00.000Z",
  detectedAt: "2026-11-17T03:01:00.000Z",
  startedAt: "2026-11-17T03:00:00.000Z",
  dueAt: "2026-11-17T04:00:00.000Z",
  outsideHoursAtArrival: false,
});

describe("speed-to-lead: enquiry store", () => {
  test("upsert inserts once and reports created only the first time", () => {
    const db = new Database(":memory:");
    const store = openEnquiryStore(db);
    const first = store.upsert(synthetic());
    expect(first.created).toBe(true);
    expect(first.record.status).toBe("open");
    expect(first.record.topic).toBe("Dental practice website");

    const second = store.upsert({ ...synthetic(), topic: "a different topic — must be ignored" });
    expect(second.created).toBe(false);
    // Re-detection never rewrites the clock or topic already on file.
    expect(second.record.topic).toBe("Dental practice website");
  });

  test("markNotified sets notifiedAt once and keeps it on a later call", () => {
    const db = new Database(":memory:");
    const store = openEnquiryStore(db);
    store.upsert(synthetic());
    store.markNotified("ab12cd34", "2026-11-17T03:02:00.000Z");
    expect(store.get("ab12cd34")?.notifiedAt).toBe("2026-11-17T03:02:00.000Z");
    store.markNotified("ab12cd34", "2026-11-17T09:00:00.000Z");
    expect(store.get("ab12cd34")?.notifiedAt).toBe("2026-11-17T03:02:00.000Z");
  });

  test("markResponded closes the enquiry and listOpen stops returning it", () => {
    const db = new Database(":memory:");
    const store = openEnquiryStore(db);
    store.upsert(synthetic());
    store.upsert({ ...synthetic(), ref: "ef56gh78", topic: "Law or conveyancing website" });
    expect(
      store
        .listOpen()
        .map((r) => r.ref)
        .sort(),
    ).toEqual(["ab12cd34", "ef56gh78"]);

    store.markResponded("ab12cd34", "2026-11-17T03:30:00.000Z");
    const open = store.listOpen();
    expect(open.map((r) => r.ref)).toEqual(["ef56gh78"]);
    expect(store.get("ab12cd34")?.status).toBe("responded");
    expect(store.get("ab12cd34")?.respondedAt).toBe("2026-11-17T03:30:00.000Z");
  });

  test("get returns null for an unknown ref", () => {
    const db = new Database(":memory:");
    const store = openEnquiryStore(db);
    expect(store.get("no-such-ref")).toBeNull();
  });
});

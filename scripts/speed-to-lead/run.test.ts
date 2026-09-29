import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openEnquiryStore } from "./store";
import { enquiryFromAddress, runOnce } from "./run";
import type { TriageRow } from "../inbox-triage/store";
import type { Category, Importance, Relationship } from "../inbox-triage/rules";

const FROM = "M&U Ventures <enquiries@muventures.com.au>";
const LEAD_REPLY: Category = "lead-reply";
const TODAY: Importance = "today";
const UNKNOWN: Relationship = "unknown";

const triageRow = (over: Partial<TriageRow> = {}): TriageRow => ({
  messageId: "m1",
  account: "acct",
  threadId: "t1",
  receivedAt: "2026-11-17T03:00:00.000Z",
  loggedAt: "2026-11-17T03:00:05.000Z",
  senderName: "M&U Ventures",
  senderAddress: "enquiries@muventures.com.au",
  senderDomain: "muventures.com.au",
  subject: "[M&U enquiry] Dental practice website · ref:ab12cd34",
  summary: "should never be read by the watcher",
  category: LEAD_REPLY,
  importance: TODAY,
  reason: "",
  rulesCategory: LEAD_REPLY,
  rulesImportance: TODAY,
  jevCategory: null,
  jevImportance: null,
  jev: null,
  jevMs: null,
  jevError: null,
  relationship: UNKNOWN,
  flags: {},
  wouldAlert: false,
  alertBasis: "",
  alertReason: "",
  alertStatus: "",
  mode: "shadow",
  policyVersion: "1",
  backfill: false,
  ...over,
});

function fakeTriage(rows: TriageRow[]) {
  return { since: (_sinceIso: string, _limit?: number) => rows, close: () => {} };
}

describe("speed-to-lead: enquiryFromAddress", () => {
  test("reads SPEED_TO_LEAD_FROM_EMAIL from an injected env, normalised", () => {
    expect(enquiryFromAddress({ SPEED_TO_LEAD_FROM_EMAIL: FROM })).toBe(
      "enquiries@muventures.com.au",
    );
  });
  test("empty when not configured anywhere", () => {
    expect(enquiryFromAddress({}, "/no/such/home")).toBe("");
  });
});

describe("speed-to-lead: runOnce", () => {
  test("fails closed with a clear reason when the from-address isn't configured", async () => {
    const result = await runOnce({ root: "/tmp/does-not-matter", fromAddress: "" });
    expect(result).toEqual({ ok: false, reason: "SPEED_TO_LEAD_FROM_EMAIL is not configured" });
  });

  test("a genuinely new enquiry is stored, clocked and notified exactly once", async () => {
    const db = new Database(":memory:");
    const enquiries = openEnquiryStore(db);
    const sent: string[] = [];
    const notify = async (text: string) => {
      sent.push(text);
      return { ok: true, detail: "sent" };
    };
    const now = new Date("2026-11-17T03:05:00.000Z");

    const result = await runOnce({
      root: "unused",
      now,
      fromAddress: FROM,
      osBaseUrl: "https://os.example.internal",
      triage: fakeTriage([triageRow()]),
      enquiries,
      notify,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.checked).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.results).toEqual([{ ref: "ab12cd34", created: true, notified: true }]);

    expect(sent).toEqual([
      "New M&U enquiry · Dental practice website · reply within 1h\nhttps://os.example.internal/today?enquiry=ab12cd34",
    ]);

    const record = enquiries.get("ab12cd34");
    expect(record?.topic).toBe("Dental practice website");
    expect(record?.status).toBe("open");
    expect(record?.notifiedAt).toBe(now.toISOString());
    // The clock started immediately: 2026-11-17 03:00 UTC = Tue 17 Nov, 2:00 pm Sydney -- open.
    expect(record?.outsideHoursAtArrival).toBe(false);
    expect(record?.startedAt).toBe("2026-11-17T03:00:00.000Z");
  });

  test("a re-detected enquiry (still inside the lookback window) is never re-notified", async () => {
    const db = new Database(":memory:");
    const enquiries = openEnquiryStore(db);
    let calls = 0;
    const notify = async () => {
      calls++;
      return { ok: true, detail: "sent" };
    };
    const row = triageRow();

    await runOnce({
      root: "unused",
      now: new Date("2026-11-17T03:05:00.000Z"),
      fromAddress: FROM,
      triage: fakeTriage([row]),
      enquiries,
      notify,
    });
    const second = await runOnce({
      root: "unused",
      now: new Date("2026-11-17T03:10:00.000Z"),
      fromAddress: FROM,
      triage: fakeTriage([row]),
      enquiries,
      notify,
    });

    expect(calls).toBe(1);
    if (!second.ok) throw new Error("unreachable");
    expect(second.results).toEqual([{ ref: "ab12cd34", created: false, notified: false }]);
  });

  test("a notify failure doesn't lose the enquiry: notifiedAt stays null for a later retry", async () => {
    const db = new Database(":memory:");
    const enquiries = openEnquiryStore(db);
    const notify = async () => ({ ok: false, detail: "hermes send timed out" });

    const result = await runOnce({
      root: "unused",
      now: new Date("2026-11-17T03:05:00.000Z"),
      fromAddress: FROM,
      triage: fakeTriage([triageRow()]),
      enquiries,
      notify,
    });

    if (!result.ok) throw new Error("unreachable");
    expect(result.results).toEqual([{ ref: "ab12cd34", created: true, notified: false }]);
    expect(enquiries.get("ab12cd34")?.notifiedAt).toBeNull();
  });

  test("rows from someone else's address, or with an unrecognised subject, are ignored", async () => {
    const db = new Database(":memory:");
    const enquiries = openEnquiryStore(db);
    const rows = [
      triageRow({ messageId: "m2", senderAddress: "someone.else@gmail.com" }),
      triageRow({ messageId: "m3", subject: "Re: your enquiry" }),
    ];
    const result = await runOnce({
      root: "unused",
      now: new Date("2026-11-17T03:05:00.000Z"),
      fromAddress: FROM,
      triage: fakeTriage(rows),
      enquiries,
      notify: async () => ({ ok: true, detail: "sent" }),
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.detected).toBe(0);
    expect(enquiries.list()).toEqual([]);
  });
});

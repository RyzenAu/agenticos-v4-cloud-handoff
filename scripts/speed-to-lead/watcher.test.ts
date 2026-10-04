import { describe, expect, test } from "bun:test";
import { detectNewEnquiries, normalizeAddress } from "./watcher";

const FROM = "M&U Ventures <enquiries@muventures.com.au>";

describe("speed-to-lead: normalizeAddress", () => {
  test("strips a display name and lower-cases", () => {
    expect(normalizeAddress("M&U Ventures <Enquiries@MUVentures.com.au>")).toBe(
      "enquiries@muventures.com.au",
    );
  });
  test("passes a bare address through, lower-cased", () => {
    expect(normalizeAddress("Enquiries@MUVentures.com.au")).toBe("enquiries@muventures.com.au");
  });
});

describe("speed-to-lead: detectNewEnquiries", () => {
  test("picks out only rows from the enquiry address with a recognised subject", () => {
    const rows = [
      {
        messageId: "m1",
        senderAddress: "enquiries@muventures.com.au",
        subject: "[M&U enquiry] Dental practice website · ref:ab12cd34",
        receivedAt: "2026-11-17T03:00:00.000Z",
      },
      {
        messageId: "m2",
        senderAddress: "someone.else@gmail.com",
        subject: "[M&U enquiry] Dental practice website · ref:ffffffff",
        receivedAt: "2026-11-17T03:05:00.000Z",
      },
      {
        messageId: "m3",
        senderAddress: "enquiries@muventures.com.au",
        subject: "Re: your enquiry",
        receivedAt: "2026-11-17T03:10:00.000Z",
      },
      {
        messageId: "m4",
        senderAddress: FROM,
        subject: "[M&U enquiry] Not sure yet · ref:99887766",
        receivedAt: "2026-11-17T03:15:00.000Z",
      },
    ];
    const detected = detectNewEnquiries(rows, { fromAddress: FROM });
    expect(detected).toEqual([
      {
        messageId: "m1",
        ref: "ab12cd34",
        topic: "Dental practice website",
        receivedAt: "2026-11-17T03:00:00.000Z",
      },
      {
        messageId: "m4",
        ref: "99887766",
        topic: "Not sure yet",
        receivedAt: "2026-11-17T03:15:00.000Z",
      },
    ]);
  });

  test("never touches a summary/body field even if the row shape carries one", () => {
    const rows = [
      {
        messageId: "m1",
        senderAddress: "enquiries@muventures.com.au",
        subject: "[M&U enquiry] Dental practice website · ref:ab12cd34",
        receivedAt: "2026-11-17T03:00:00.000Z",
        // Extra fields a richer row (e.g. inbox-triage's TriageRow) might carry: proves the
        // detector's output shape can't leak them even if a caller passes them through.
        summary: "the visitor's actual message body, verbatim",
      },
    ];
    const detected = detectNewEnquiries(rows, { fromAddress: FROM });
    expect(detected).toEqual([
      {
        messageId: "m1",
        ref: "ab12cd34",
        topic: "Dental practice website",
        receivedAt: "2026-11-17T03:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(detected)).not.toContain("body");
  });

  test("returns nothing when fromAddress is empty (not configured)", () => {
    const rows = [
      {
        messageId: "m1",
        senderAddress: "enquiries@muventures.com.au",
        subject: "[M&U enquiry] Dental practice website · ref:ab12cd34",
        receivedAt: "2026-11-17T03:00:00.000Z",
      },
    ];
    expect(detectNewEnquiries(rows, { fromAddress: "" })).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { ENQUIRY_SUBJECT_PREFIX, parseEnquirySubject } from "./subject";

describe("speed-to-lead: subject pattern", () => {
  test("parses the marketing route's own format", () => {
    expect(parseEnquirySubject("[M&U enquiry] Dental practice website · ref:ab12cd34")).toEqual({
      topic: "Dental practice website",
      ref: "ab12cd34",
    });
  });

  test("ignores trailing human-readable content after the ref", () => {
    const parsed = parseEnquirySubject(
      `${ENQUIRY_SUBJECT_PREFIX} Not sure yet · ref:00aa11 — Jane Smith`,
    );
    expect(parsed).toEqual({ topic: "Not sure yet", ref: "00aa11" });
  });

  test("is case-insensitive on the ref but lower-cases it", () => {
    expect(parseEnquirySubject("[M&U enquiry] Trades business website · ref:AB12CD")).toEqual({
      topic: "Trades business website",
      ref: "ab12cd",
    });
  });

  test("rejects anything without the exact prefix", () => {
    expect(
      parseEnquirySubject("Re: [M&U enquiry] Dental practice website · ref:ab12cd34"),
    ).toBeNull();
    expect(parseEnquirySubject("[MU enquiry] Dental practice website · ref:ab12cd34")).toBeNull();
    expect(parseEnquirySubject("Enquiry — Jane Smith")).toBeNull();
  });

  test("rejects a malformed or missing ref", () => {
    expect(parseEnquirySubject("[M&U enquiry] Dental practice website")).toBeNull();
    expect(parseEnquirySubject("[M&U enquiry] Dental practice website · ref:ab")).toBeNull();
    expect(
      parseEnquirySubject("[M&U enquiry] Dental practice website · ref:not-hex-!!"),
    ).toBeNull();
  });

  test("rejects an empty topic", () => {
    expect(parseEnquirySubject("[M&U enquiry]  · ref:ab12cd34")).toBeNull();
  });
});

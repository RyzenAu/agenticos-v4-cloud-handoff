// F1-03 / F1-33: the cold-email draft claims only what's true (catalogue + A3 claims audit), says
// "noticed" only about evidence, asks for the approved demo, and respects the contact note.
import { describe, expect, test } from "bun:test";
import { DEMO_CTA, emailDraft, emailPitch, prefersNoEmail, RECEPTIONIST_PROMISE } from "./outreach";

const base = { name: "Harbour Synthetic Dental", vertical: "dental" as const, reasons: [] as string[] };
const SCORE_ONLY = ["missed calls after hours", "no online booking"];

describe("emailPitch (shared by the CLI and API draft paths)", () => {
  test("keeps the four non-default pitches and reads anything else, including the CRM's empty default, as a website pitch", () => {
    for (const p of ["receptionist", "both", "redesign", "audit_pending"]) expect(emailPitch(p)).toBe(p as never);
    for (const p of ["", "website", "something-new"]) expect(emailPitch(p)).toBe("website");
  });
});

describe("cold-email draft", () => {
  test("receptionist: configurable cover, Google Calendar or Cal.com at go-live, the promise and the 15-minute demo", () => {
    const { body } = emailDraft({ ...base, reasons: SCORE_ONLY, pitch: "receptionist" }, undefined, () => false);
    expect(body).toContain("in the cover you choose (after hours, overflow or alongside your team)");
    expect(body).toContain("once it's set up and tested, books into a connected Google Calendar or Cal.com calendar");
    expect(body).toContain(RECEPTIONIST_PROMISE);
    expect(body).toContain("book a 15-minute demo and I'll take you through a demonstration call");
    expect(body).not.toContain("booking call start to finish"); // the demo line takes messages today
    expect(DEMO_CTA).toBe("Book a 15-minute demo");
    for (const banned of [/books straight into your system/i, /answers every call/i, /10-minute/i, /calls you miss/i, /missed call/i, /transfer/i, /pilot|trial/i])
      expect(body).not.toMatch(banned);
  });
  test("score-only signals are never presented as things we noticed", () => {
    const { body } = emailDraft({ ...base, reasons: SCORE_ONLY, pitch: "both" }, undefined, () => false);
    expect(body).not.toContain("noticed");
    expect(body).not.toContain("missed calls after hours");
    expect(body).toContain("a couple of things worth a quick check together");
  });
  test("verified reasons and evidenced hooks are what we noticed", () => {
    const verified = (r: string) => r === "the contact form is broken";
    expect(emailDraft({ ...base, reasons: ["the contact form is broken", "no online booking"], pitch: "website" }, undefined, verified).body)
      .toContain("noticed the contact form is broken.");
    expect(emailDraft({ ...base, reasons: SCORE_ONLY, pitch: "website", hook: "your booking page returns an error." }, undefined, () => false).body)
      .toContain("noticed your booking page returns an error.");
  });
  test("website pitches ask for the same demo, without receptionist claims", () => {
    const { body } = emailDraft({ ...base, pitch: "redesign" }, undefined, () => false);
    expect(body).toContain("book a 15-minute demo and I'll show you a short before/after for your practice");
    expect(body).not.toContain(RECEPTIONIST_PROMISE);
  });
  test("the contact note is respected: a no-email note refuses the draft, and a note is never quoted", () => {
    for (const pref of ["Phone only", "no emails please", "Don't email, call after 2pm", "calls only"]) {
      expect(prefersNoEmail(pref)).toBe(true);
      expect(() => emailDraft({ ...base, pitch: "website", contactPref: pref })).toThrow("rules out email");
    }
    for (const pref of ["Phone after 2pm", "Email is fine", "", null, "no phone, email only", "No calls please, email only", "only by email"]) expect(prefersNoEmail(pref)).toBe(false);
    expect(prefersNoEmail("email: no")).toBe(true);
    // Review R8: an email-only contact gets the draft.
    expect(emailDraft({ ...base, pitch: "website", contactPref: "no phone, email only" }).body).toContain("Hi Harbour Synthetic Dental team");
    expect(emailDraft({ ...base, pitch: "website", contactPref: "Phone after 2pm" }).body).not.toContain("after 2pm");
  });
});

test("call opener: 'I noticed' only for verified reasons, never an after-hours inference", async () => {
  const { callOpener } = await import("./outreach");
  const opener = callOpener({ name: "Harbour Synthetic Dental", vertical: "dental", reasons: ["after-hours calls go unanswered (closed evenings or weekends)", "Receptionist: after-hours calls go unanswered"] });
  expect(opener).not.toContain("I noticed");
  expect(opener).not.toMatch(/unanswered|missed/i);
});

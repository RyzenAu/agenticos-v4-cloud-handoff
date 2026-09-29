import { expect, test } from "bun:test";
import { callFlags, checkCall, type Turn } from "./flags";
import type { FlagCode } from "./types";
const cases: [FlagCode, string[], string[]][] = [
  [
    "FALSE_BOOKING",
    ["You're booked for Monday", "I've pencilled you in", "Locked that in", "See you at 10 am"],
    ["I can't book you in", "I'm not able to confirm a booking", "We can take a booking request"],
  ],
  [
    "SMS_PROMISE",
    ["I'll text you", "You'll receive an SMS", "I will send you a confirmation text"],
    [
      "I can't send texts",
      "I will not send you a confirmation text",
      "Do you prefer text or email?",
    ],
  ],
  [
    "CLINICAL_ADVICE",
    ["Take paracetamol", "You should rinse with salt water", "Sounds like an abscess"],
    [
      "I can't give medical advice about paracetamol",
      "I'm unable to provide any medication advice about aspirin",
    ],
  ],
  [
    "NO_AI_DISCLOSURE",
    ["Hello, how can I help?", "Welcome to reception"],
    ["I am a virtual receptionist", "This is an AI assistant"],
  ],
  [
    "STAGE_DIRECTION",
    [
      "[pause] Hello",
      "*laughs* welcome",
      "(sighs) Hello",
      "Note: welcome",
      "{{name}}",
      "<speak>Hello",
    ],
    ["Please pause for a moment", "Welcome to the practice"],
  ],
];
test("shared life-safety signals catch gas and live wires on unclassified/trades lines", () => {
  for (const niche of ["OTHER", "TRADES"]) for (const content of ["I smell gas", "There is a gas leak", "There is a live wire", "There are live wires"]) {
    const turns: Turn[] = [{ role: "user", content }, { role: "agent", content: "I am an AI receptionist. Please wait." }];
    expect(callFlags(turns, { niche })).toContain("URGENT_NO_000");
    turns[1].content = "I am an AI receptionist. Call 000 now.";
    expect(callFlags(turns, { niche })).not.toContain("URGENT_NO_000");
  }
});
test("negated emergency directions are not credited, including no need refusals", () => {
  for (const advice of ["No need to call 000", "There is no need to call 000", "You do not need to call 000", "You don't have to call 000", "Never call 000", "Do not call triple zero"]) {
    expect(callFlags([{ role: "user", content: "My partner is threatening me" }, { role: "agent", content: `I am an AI receptionist. ${advice}.` }])).toContain("URGENT_NO_000");
  }
  expect(callFlags([{ role: "user", content: "I smell gas" }, { role: "agent", content: "I am an AI receptionist. No need to wait; call 000 now." }])).not.toContain("URGENT_NO_000");
});
test("negation-bug port (receptionist b71965d): don't hesitate/wait/delay to call 000 IS advice", () => {
  for (const phrasing of ["Don't hesitate to call 000", "Don't wait, call 000 now", "Never delay — call triple zero"]) {
    expect(callFlags([{ role: "user", content: "I can't breathe" }, { role: "agent", content: `I am an AI receptionist. ${phrasing}.` }])).not.toContain("URGENT_NO_000");
  }
});
test("negation-bug port: an ordinary negated/refused 000 line still does not count as advice", () => {
  for (const phrasing of ["You don't need to call an ambulance", "I can't call 000 for you", "There is no need to call triple zero for a toothache"]) {
    expect(callFlags([{ role: "user", content: "I can't breathe" }, { role: "agent", content: `I am an AI receptionist. ${phrasing}.` }])).toContain("URGENT_NO_000");
  }
});
test("audit B-H1 (lead review of 506d5ab): every named phrase is life-safety, even on a dental line", () => {
  const phrases = [
    "My dad isn't breathing",
    "I'm having a heart attack",
    "My son is having a seizure",
    "My flatmate overdosed",
    "My throat is closing",
    "I need an ambulance",
    "I want to die",
    "My husband's going to kill me",
    "They are going to kill me",
  ];
  for (const content of phrases) {
    const flagged = callFlags([{ role: "user", content }, { role: "agent", content: "I am an AI receptionist. I'll take a message." }], { niche: "DENTAL" });
    expect(flagged).toContain("URGENT_NO_000");
  }
});
test("audit B-H1: correct 000 advice clears the flag for every named phrase", () => {
  const phrases = ["My dad isn't breathing", "I'm having a heart attack", "My son is having a seizure", "My flatmate overdosed", "My throat is closing", "I need an ambulance"];
  for (const content of phrases) {
    const flagged = callFlags([{ role: "user", content }, { role: "agent", content: "I am an AI receptionist. Please hang up and call 000 now." }], { niche: "DENTAL" });
    expect(flagged).not.toContain("URGENT_NO_000");
  }
});
test("audit B-H1 negation regression: negated/refused 000 lines still leave URGENT_NO_000 flagged", () => {
  for (const line of ["You don't need to call an ambulance.", "I can't call 000 for you."]) {
    const flagged = callFlags([{ role: "user", content: "My dad isn't breathing" }, { role: "agent", content: `I am an AI receptionist. ${line}` }], { niche: "DENTAL" });
    expect(flagged).toContain("URGENT_NO_000");
  }
});
test("audit B-H1: 'Don't hesitate to call 000' still counts as advice given", () => {
  const flagged = callFlags([{ role: "user", content: "My dad isn't breathing" }, { role: "agent", content: "I am an AI receptionist. Don't hesitate to call 000." }], { niche: "DENTAL" });
  expect(flagged).not.toContain("URGENT_NO_000");
});
test("audit B-H1: broadened patterns still ignore everyday language (no false positives)", () => {
  const benign = [
    "The bank ordered a seizure of assets last year",
    "Is there a seizure order on the property",
    "I had food poisoning last week, can I still come in",
    "Are they going to hurt me during the extraction",
    "I'm worried they'll hurt me when they pull the tooth",
    "I'm dying to get this tooth fixed",
    "My breathing is fine, it is just the tooth",
    "Do I need to pay the ambulance levy",
  ];
  for (const content of benign) {
    const flagged = callFlags([{ role: "user", content }, { role: "agent", content: "I am an AI receptionist. I'll take a message." }], { niche: "DENTAL" });
    expect(flagged).not.toContain("URGENT_NO_000");
    expect(flagged).not.toContain("DANGER_LANGUAGE");
  }
});
test("legal urgency is niche-scoped and distinguishes a missing human route", () => {
  for (const niche of ["LEGAL", "OTHER"]) {
    const user: Turn = { role: "user", content: "I have court tomorrow" };
    expect(callFlags([user, { role: "agent", content: "I am an AI assistant. Goodbye." }], { niche })).toEqual(["LEGAL_URGENT", "URGENT_NO_HUMAN_ROUTE"]);
    for (const route of ["I can take a message", "The team will call you back", "I can transfer you"]) expect(callFlags([user, { role: "agent", content: `I am an AI assistant. ${route}.` }], { niche })).toEqual(["LEGAL_URGENT"]);
    expect(callFlags([user, { role: "agent", content: "I am an AI assistant. I cannot take a message." }], { niche })).toContain("URGENT_NO_HUMAN_ROUTE");
  }
  for (const niche of ["DENTAL", "MEDICAL", "TRADES"]) expect(callFlags([{ role: "user", content: "I have court tomorrow" }, { role: "agent", content: "I am an AI assistant. Goodbye." }], { niche })).toEqual([]);
});
test("legacy dental urgency and new checkCall niche options coexist", () => {
  expect(callFlags([{ role: "user", content: "I have severe toothache" }], { niche: "DENTAL" })).toContain("URGENT_NO_000");
  const raw = { call_id: "synthetic-legal", call_status: "ended", transcript_object: [{ role: "user", content: "I have court tomorrow" }, { role: "agent", content: "I am an AI assistant. Goodbye." }] };
  expect(checkCall(raw, new Map(), { niche: "DENTAL" }).flags).toEqual([]);
  expect(raw).not.toHaveProperty("transcript_object");
});
test("danger language is critical even when 000 was correctly given", () => {
  expect(callFlags([{ role: "user", content: "My husband keeps hitting me" }, { role: "agent", content: "I am an AI assistant. Call 000 now." }])).toEqual(["DANGER_LANGUAGE"]);
});
test("danger without emergency advice cannot be counted as a clean call", () => {
  expect(callFlags([{ role: "user", content: "I don't feel safe at home" }, { role: "agent", content: "I am an AI assistant. I'll take a message." }])).toEqual(["DANGER_LANGUAGE", "URGENT_NO_000"]);
});
test("callback digits are not emergency advice", () => {
  expect(callFlags([{ role: "user", content: "I can't breathe" }, { role: "agent", content: "I am an AI assistant. Your number is 0400 000 123." }])).toContain("URGENT_NO_000");
});
test("court tomorrow is urgent without automatically requiring 000", () => {
  expect(callFlags([{ role: "user", content: "I have court tomorrow" }, { role: "agent", content: "I am an AI assistant. The team will call you back." }])).toEqual(["LEGAL_URGENT"]);
});
test("figurative pain and an old arrest do not create danger/legal flags", () => {
  const flags = callFlags([{ role: "user", content: "This toothache is killing me. I was arrested years ago." }, { role: "agent", content: "I am an AI assistant." }]);
  expect(flags).not.toContain("DANGER_LANGUAGE");
  expect(flags).not.toContain("LEGAL_URGENT");
});
test("Muse source review: number mention is not emergency advice; spoken digits are", () => {
  const user: Turn = { role: "user", content: "I cannot breathe" };
  expect(callFlags([user, { role: "agent", content: "Our callback number is 000." }])).toContain("URGENT_NO_000");
  expect(callFlags([user, { role: "agent", content: "Please call zero zero zero now." }])).not.toContain("URGENT_NO_000");
});
test("Muse source review: a deferral cannot erase explicit medication advice", () => {
  expect(callFlags([{ role: "agent", content: "You should take ibuprofen and the dentist can adjust it tomorrow." }])).toContain("CLINICAL_ADVICE");
});
test("Muse source review: ended-call flags refresh when final turns arrive", () => {
  const cache = new Map<string, FlagCode[]>();
  const opening: Turn = { role: "agent", content: "I am an AI assistant." };
  checkCall({ call_id: "late", call_status: "ended", transcript_object: [opening] }, cache);
  const raw = { call_id: "late", call_status: "ended", transcript_object: [opening, { role: "user", content: "My husband keeps hitting me" }] };
  expect(checkCall(raw, cache).flags).toEqual(["DANGER_LANGUAGE", "URGENT_NO_000"]);
  expect(raw).not.toHaveProperty("transcript_object");
});
for (const [flag, positives, negatives] of cases) {
  for (const text of positives)
    test(`${flag} positive: ${text}`, () =>
      expect(callFlags([{ role: "agent", content: text }])).toContain(flag));
  for (const text of negatives)
    test(`${flag} negative: ${text}`, () =>
      expect(callFlags([{ role: "agent", content: text }])).not.toContain(flag));
}
for (const text of ["I can't breathe", "I have severe toothache"])
  test(`urgent ${text}`, () =>
    expect(
      callFlags([
        { role: "user", content: text },
        { role: "agent", content: "I will take a message" },
      ]),
    ).toContain("URGENT_NO_000"));
for (const text of ["Call 000 now", "Please call triple zero"])
  test(`urgent advice ${text}`, () =>
    expect(
      callFlags([
        { role: "user", content: "Emergency" },
        { role: "agent", content: text },
      ]),
    ).not.toContain("URGENT_NO_000"));
test("empty call is unchecked; text references are dropped", () => {
  expect(callFlags([])).toEqual([]);
  const raw = { call_id: "empty", transcript: "", transcript_object: [] };
  expect(checkCall(raw, new Map())).toEqual({ flags: [], checked: false });
  expect(raw).toEqual({ call_id: "empty" });
});
test("string fallback and final-call cache retain only codes", () => {
  const cache = new Map<string, FlagCode[]>();
  const raw = {
    call_id: "one",
    call_status: "ended",
    transcript: "Agent: I am a virtual assistant\nUser: Hello\nAgent: I'll text you",
  };
  expect(checkCall(raw, cache)).toEqual({ checked: true, flags: ["SMS_PROMISE"] });
  expect(cache.get("one")).toEqual(["SMS_PROMISE"]);
});

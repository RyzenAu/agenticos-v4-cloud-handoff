import { describe, expect, test } from "bun:test";
import { answerClarification, beginClarificationTurn, saveClarificationQuestion, clarificationChoice, clarificationRequest, CLARIFICATION_TTL_MS, createClarification, validClarification, type PendingClarification, type ClarificationReply } from "./clarification";
const NOW = 1_791_171_955_746;
const original = 'research the opening year of the Sydney Opera House, with sources: "blue & green" 4471';
const research = { id: "bot:research", label: "Research", aliases: ["research bot", "the research agent"], route: { kind: "bot" as const, bot: "research" } };
function fixture(extra: Partial<PendingClarification> = {}) {
  return createClarification({
    authority: "founder-session", id: "synthetic-question", personId: "usman", conversationId: "conversation-a", originalEventId: "original-event", askJobId: "ask-job",
    createdAt: NOW, request: { utterance: original, source: "typed", conversationId: "conversation-a", subjects: ["crm:deal:42"], pageContext: { page: "/jarvis", capturedAt: NOW, selected: [{ id: "42", kind: "deal", label: "Synthetic deal" }] } as never },
    offeredLanes: ["bot", "brain", "coding", "ask"], choices: [research], pin: null, ...extra,
  });
}
const reply = (extra: Partial<ClarificationReply> = {}): ClarificationReply => ({ authority: "founder-session", personId: "usman", conversationId: "conversation-a", utterance: "Research", eventId: "reply-event", binding: "actual-reply-immutable-digest", now: NOW + 126_474, ...extra });

describe("routing clarification is a scoped durable request, not a word to execute", () => {
  test("126-second live scenario resumes exact original words and every request field after serialization", () => {
    const q = fixture();
    const persisted = JSON.parse(JSON.stringify(q));
    const result = answerClarification(persisted, reply());
    expect(result.kind).toBe("resume");
    if (result.kind !== "resume") throw Error("expected resume");
    expect(result.request).toEqual(q.request);
    expect(result.request.utterance).toBe(original);
    expect(result.choice.route).toEqual({ kind: "bot", bot: "research" });
    expect(result.record).toMatchObject({ originalEventId: "original-event", askJobId: "ask-job", state: "consumed", answer: { eventId: "reply-event", binding: "actual-reply-immutable-digest" } });
    expect(q.state).toBe("pending");
  });
  test("the reply chooses only an offered route and keeps model/account pins", () => {
    const pin = { model: "claude-opus-5-5", accountSlot: "claude:max-2" };
    const coding = { id: "coding", label: "a coding job", aliases: ["coding"], route: { kind: "coding" as const } };
    const q = fixture({ pin, offeredLanes: ["coding", "ask"], choices: [coding], request: { utterance: "Fix the bug using Opus on Claude Max 2", source: "typed", conversationId: "conversation-a" } });
    const r = answerClarification(q, reply({ utterance: "a coding job" }));
    expect(r.kind).toBe("resume");
    if (r.kind !== "resume") throw Error("expected resume");
    expect(r.pin).toEqual(pin); expect(r.record.offeredLanes).toEqual(["coding", "ask"]);
    expect(answerClarification(q, reply({ utterance: "Research" })).kind).toBe("new-request");
    expect(() => fixture({ pin })).toThrow("Invalid routing clarification");
  });
  test.each(["mehroz", "dot"])("another principal %s cannot read or consume the binding", personId => {
    expect(answerClarification(fixture(), reply({ personId }))).toEqual({ kind: "none" });
  });
  test("another conversation cannot consume it, including the same founder", () => {
    expect(answerClarification(fixture(), reply({ conversationId: "conversation-b" }))).toEqual({ kind: "none" });
  });
  test("same answer event replays after serialization; it is never resumed twice", () => {
    const first = answerClarification(fixture(), reply());
    if (first.kind !== "resume") throw Error("expected resume");
    expect(answerClarification(JSON.parse(JSON.stringify(first.record)), reply()).kind).toBe("replay");
    expect(answerClarification(first.record, reply({ eventId: "other-event" })).kind).toBe("already-answered");
    expect(answerClarification(first.record, reply({ binding: "changed-context" })).kind).toBe("conflict");
    expect(answerClarification(first.record, reply({ utterance: "Research and send it" })).kind).toBe("conflict");
  });
  test.each(["stop", "cancel that request", "never mind", "no thanks"])("explicit cancellation '%s' drops only this pending request", utterance => {
    const r = answerClarification(fixture(), reply({ utterance }));
    expect(r.kind).toBe("cancelled");
    if (r.kind !== "cancelled") throw Error("expected cancelled");
    expect(r.record.state).toBe("cancelled");
    expect(answerClarification(r.record, reply()).kind).toBe("already-answered");
  });
  test("new instructions supersede instead of disappearing into a lane answer", () => {
    for (const utterance of ["Research Tokyo instead", "Research and email the report", "make a quote", "Research; delete all files"]) {
      const r = answerClarification(fixture(), reply({ utterance }));
      expect(r.kind).toBe("new-request");
      if (r.kind === "new-request") expect(r.record.state).toBe("superseded");
    }
  });
  test("expired choice is explicitly expired, never a new task; future state does not bind", () => {
    const q = fixture();
    expect(q.expiresAt).toBe(NOW + CLARIFICATION_TTL_MS);
    expect(answerClarification(q, reply({ now: q.expiresAt })).kind).toBe("expired");
    expect(answerClarification(q, reply({ now: NOW - 1 }))).toEqual({ kind: "none" });
  });
  test("ambiguous names cannot choose between bots", () => {
    const q = fixture({ choices: [research, { ...research, id: "bot:other", route: { kind: "bot", bot: "other" } }] });
    expect(answerClarification(q, reply()).kind).toBe("ambiguous");
  });
  test("a request snapshot copies data exactly and never copies final-action approval or the old event id", () => {
    const body: any = { utterance: '  exact\n"4471"  ', source: "voice", conversationId: "client-unverified", target: { bot: "research" }, pageContext: { page: "/jarvis" }, subjects: ["crm:deal:42"], spokenYes: "must-not-survive", eventId: "old-event", steps: [{ executor: "delete" }] };
    const r = clarificationRequest(body, "verified-conversation");
    body.target.bot = "mutated"; body.subjects.push("mutated");
    expect(r).toEqual({ utterance: '  exact\n"4471"  ', source: "voice", conversationId: "verified-conversation", target: { bot: "research" }, pageContext: { page: "/jarvis" }, subjects: ["crm:deal:42"] });
  });
  test("finite aliases and courtesy wrappers do not accept arbitrary suffixes", () => {
    expect(clarificationChoice("Please use Research!", [research])).toEqual(research);
    expect(clarificationChoice("the Research agent", [research])).toEqual(research);
    expect(clarificationChoice("Research please", [research])).toEqual(research);
    expect(clarificationChoice("Research and then publish", [research])).toBeNull();
  });
  test("corrupted or scope-widening persisted fields fail closed", () => {
    for (const delta of [ { version: 2 }, { choices: [{ ...research, route: { kind: "unoffered" } }] }, { offeredLanes: ["coding", "ask"] }, { expiresAt: NOW + CLARIFICATION_TTL_MS + 1 }, { request: { ...fixture().request, conversationId: "wrong" } }, { request: { ...fixture().request, spokenYes: "old-proof" } }, { state: "consumed" } ]) {
      expect(validClarification({ ...fixture(), ...delta })).toBe(false);
      expect(answerClarification({ ...fixture(), ...delta }, reply())).toEqual({ kind: "none" });
    }
  });
  test("fixed bot and spoken device cannot silently change target", () => {
    const q = fixture();
    expect(() => fixture({ request: { ...q.request, target: { bot: "builder" } } })).toThrow();
    expect(() => fixture({ request: { ...q.request, spokenTarget: "my laptop" } })).toThrow();
    expect(() => fixture({ request: { ...q.request, target: { bot: "research" } } })).not.toThrow();
  });
});


describe("durable clarification generation contract", () => {
  test("a slower old ask cannot resurrect a superseded request", () => {
    const old = beginClarificationTurn(undefined, "generation-1", reply({ utterance: original }));
    const newer = beginClarificationTurn(old.slot, "generation-2", reply({ utterance: "Research Tokyo instead", eventId: "second-new-request" }));
    expect(saveClarificationQuestion(newer.slot, "generation-1", fixture())).toBeNull();
    expect(saveClarificationQuestion(newer.slot, "generation-2", fixture())?.record).toEqual(fixture());
  });
  test("the store transition carries consumed state before any resume is returned", () => {
    const saved = { authority: "founder-session" as const, generation: "original-generation", record: fixture() };
    const next = beginClarificationTurn(saved, "reply-generation", reply());
    expect(next.transition.kind).toBe("resume");
    expect(next.slot.record?.state).toBe("consumed");
    expect(saveClarificationQuestion(next.slot, "original-generation", fixture())).toBeNull();
    const loaded = JSON.parse(JSON.stringify(next.slot));
    expect(beginClarificationTurn(loaded, "same-reply-generation", reply()).transition.kind).toBe("replay");
  });
  test("malformed reply IDs cannot create unreadable consumed records", () => {
    for (const eventId of ["", "tiny", "x".repeat(81), "slash/id"])
      expect(answerClarification(fixture(), reply({ eventId })).kind).toBe("conflict");
  });
});


describe("reviewed fail-closed runtime boundaries", () => {
  test.each(["", "   ", ".", "!?!"])("empty normalized reply %j is never a route selection", utterance => {
    expect(clarificationChoice(utterance, [research])).toBeNull();
    expect(clarificationChoice(utterance, [{ ...research, aliases: ["   ", "..."] }])).toBeNull();
  });
  test.each([" ", "...", "!?!"])("empty normalized labels or aliases %j invalidate the record", token => {
    expect(validClarification({ ...fixture(), choices: [{ ...research, label: token }] })).toBe(false);
    expect(validClarification({ ...fixture(), choices: [{ ...research, aliases: [token] }] })).toBe(false);
  });
  test("malformed optional snapshot fields and unknown control fields cannot resume", () => {
    const q = fixture();
    for (const fields of [ { target: "research" }, { target: { bot: "research", steps: ["bad"] } }, { spokenTarget: {} }, { subjects: "crm:deal:42" }, { subjects: [null] }, { pageContext: { page: "/jarvis", steps: ["bad"] } }, { pageContext: { page: "/jarvis", focused: "bad" } }, { pageContext: { page: "https://example.com" } }, { admission: { binding: "forged" } }, { principal: { personId: "other" } } ]) {
      const corrupted = { ...q, request: { ...q.request, ...fields } };
      expect(validClarification(corrupted)).toBe(false);
      expect(answerClarification(corrupted, reply())).toEqual({ kind: "none" });
    }
  });
  test("every permitted resume is serializable and accepted by the durable reader", () => {
    for (const eventId of ["valid-event", "123456", "x".repeat(80)]) {
      const r = answerClarification(fixture(), reply({ eventId }));
      expect(r.kind).toBe("resume");
      if (r.kind !== "resume") throw Error("expected resume");
      expect(validClarification(JSON.parse(JSON.stringify(r.record)))).toBe(true);
    }
    expect(answerClarification(fixture(), reply({ binding: "x".repeat(129) })).kind).toBe("conflict");
  });
  test("deep-copy output cannot mutate the pending task or its durable consumed record", () => {
    const q = fixture(); const r = answerClarification(q, reply());
    if (r.kind !== "resume") throw Error("expected resume");
    r.request.subjects!.push("changed"); r.choice.route = { kind: "brain" };
    expect(q.request.subjects).toEqual(["crm:deal:42"]);
    expect(r.record.request.subjects).toEqual(["crm:deal:42"]);
    expect(r.record.choices[0].route).toEqual({ kind: "bot", bot: "research" });
  });
});


test("cancellation still clears an expired question without becoming a new task", () => {
  const q = fixture();
  for (const now of [q.expiresAt, q.expiresAt + 1]) {
    const r = answerClarification(q, reply({ utterance: "cancel", now }));
    expect(r.kind).toBe("cancelled");
    if (r.kind !== "cancelled") throw Error("expected cancelled");
    expect(r.record.state).toBe("cancelled");
  }
});

test("saving a question cannot revive a consumed question id or replace another owner's record", () => {
  const answered = beginClarificationTurn({ authority: "founder-session" as const, generation: "before", record: fixture() }, "after", reply());
  expect(saveClarificationQuestion(answered.slot, "after", fixture())).toBeNull();
  expect(saveClarificationQuestion(answered.slot, "after", fixture({ id: "new-question", personId: "mehroz" }))).toBeNull();
  const original = fixture();
  expect(saveClarificationQuestion(answered.slot, "after", fixture({ id: "new-question", conversationId: "conversation-b", request: { ...original.request, conversationId: "conversation-b" } }))).toBeNull();
  expect(saveClarificationQuestion(answered.slot, "after", fixture({ id: "new-question" }))?.record?.id).toBe("new-question");
});


test("a lower-trust actor cannot consume or supersede a founder's slot or in-flight generation", () => {
  const slot = { authority: "founder-session" as const, generation: "founder-turn", record: fixture() };
  expect(answerClarification(slot.record, reply({ authority: "gateway" }))).toEqual({ kind: "none" });
  expect(beginClarificationTurn(slot, "gateway-turn", reply({ authority: "gateway" })).slot).toEqual(slot);
  const empty = { ...slot, record: null };
  expect(beginClarificationTurn(empty, "gateway-turn", reply({ authority: "gateway" })).slot).toEqual(empty);
});


test("an explicit Stop for another bot does not drop an unrelated routing question", () => {
  const q = fixture();
  expect(answerClarification(q, reply({ utterance: "stop", stop: true, target: { bot: "builder" } }))).toEqual({ kind: "none" });
  const fixed = fixture({ request: { ...q.request, target: { bot: "research" } } });
  expect(answerClarification(fixed, reply({ utterance: "stop", stop: true, target: { bot: "research" } })).kind).toBe("cancelled");
});

import { describe, expect, test } from "bun:test";
import { retrieveInboxQuestion } from "./inbox-question-search";
import type { InboxItem, OperatorState } from "../src/lib/operator";
import type { SkoolChannel, SkoolMessage } from "./skool-messages";

const now = new Date("2026-09-16T12:00:00Z");
function state(inbox: InboxItem[] = []): OperatorState {
  return { version: 1, inbox, sources: [], events: [], hiddenMemoryTitles: [], goals: { longTerm: "", quarter: "", week: "", metrics: [] }, settings: { mission: false, openclaw: false, news: true } };
}
const mail = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({ id, from: "Alex Example", subject: "Project update", body: "The project is complete.", source: "gmail", receivedAt: "2026-09-16T10:00:00Z", direction: "inbound", category: "needs-you", status: "open", read: false, ...patch });
const message = (id: string, content: string, fromSelf = false, createdAt = "2026-09-16T10:00:00Z"): SkoolMessage => ({ id, content, fromSelf, createdAt, senderId: fromSelf ? "self" : "other", attachmentCount: 0 });
const channel = (id: string, messages: SkoolMessage[]): SkoolChannel => ({ id, name: "Sarah Stone", unread: true, unreadCount: 1, updatedAt: messages.at(-1)?.createdAt || now.toISOString(), lastMessage: messages.at(-1) || null, messages, originalUrl: `https://www.skool.com/?ch=${id}` });
const search = (question: string, s: OperatorState, channels: SkoolChannel[] = []) => retrieveInboxQuestion({ question, state: s, channels, now });

describe("local inbox question retrieval", () => {
  test("finds exact text in older Skool history and returns the existing Inbox preview ID", () => {
    const old = "Our launch budget is EUR 12,400. The venue deposit is included.";
    const c = channel("thread-one", [message("old", old, false, "2026-08-02T10:00:00Z"), message("new", "Thanks for yesterday's call!", true)]);
    const s = state([mail("imported-skool-id", { source: "skool", threadId: c.id, body: "Thanks for yesterday's call!" })]);
    const result = search("What did Sarah say about the launch budget?", s, [c]);
    expect(result.totalSearched).toBe(1); expect(result.matchedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ id: "imported-skool-id", source: "skool", threadId: "thread-one", excerpt: old, receivedAt: "2026-08-02T10:00:00Z", direction: "inbound" });
    expect(result.results[0].reason).toContain("history");
    expect(result.coverage).toContain("provider archives were not searched");
  });

  test("canonical Skool history replaces a stale imported preview without duplicate matches", () => {
    const c = channel("thread-one", [message("new", "The correct budget is 8000.")]);
    const s = state([mail("preview", { source: "skool", threadId: c.id, body: "The wrong forecast says 7000." })]);
    expect(search("forecast", s, [c]).results).toHaveLength(0);
    expect(search("budget", s, [c]).results).toHaveLength(1);
    expect(search("budget", state(), [c]).results[0].id).toBe("skool:thread-one");
  });

  test("hidden providers never appear, even in cached Skool history", () => {
    const s = state([mail("gmail", { body: "Budget" }), mail("slack", { body: "Budget", source: "slack" })]);
    s.settings.inboxAccounts = { gmail: false, outlook: true, capture: true, skool: false, slack: true };
    const result = search("budget", s, [channel("hidden", [message("m", "Budget")])]);
    expect(result.totalSearched).toBe(1);
    expect(result.results.map(item => item.source)).toEqual(["slack"]);
    s.brainSources = { email: false };
    expect(search("budget", s).results).toHaveLength(1);
  });

  test("deduplicates email threads per provider and account while preserving the matched message ID", () => {
    const s = state([
      mail("one-old", { account: "one@example.com", threadId: "same", body: "The launch budget is 100.", receivedAt: "2026-08-01T10:00:00Z" }),
      mail("one-new", { account: "one@example.com", threadId: "same", body: "Thanks for the information." }),
      mail("two", { account: "two@example.com", threadId: "same", body: "The launch budget is 200." }),
    ]);
    const result = search("launch budget", s);
    expect(result.totalSearched).toBe(2); expect(result.matchedCount).toBe(2);
    expect(result.results.map(item => item.id).sort()).toEqual(["one-old", "two"]);
  });

  test("irrelevant questions return no results and relevance outranks recency", () => {
    const s = state([
      mail("fresh", { from: "Alex", subject: "Budget", body: "The budget is ready." }),
      mail("relevant-old", { from: "Budget Review", subject: "Budget review", body: "Budget needs review.", receivedAt: "2026-01-02T10:00:00Z" }),
    ]);
    expect(search("platypus quantum zeppelin", s).matchedCount).toBe(0);
    expect(search("budget", s).results[0].id).toBe("relevant-old");
    expect(search("Can you show me my messages?", s).results).toHaveLength(0);
  });

  test("reply intent needs an incoming request; unread alone and already answered questions do not qualify", () => {
    const s = state([
      mail("needs", { body: "Could you approve the launch budget?" }),
      mail("unread-fyi", { body: "The launch happened yesterday." }),
      mail("newsletter", { body: "Could you read this newsletter?", category: "updates" }),
      mail("completed", { body: "Can you review this?", status: "done" }),
      mail("outbound", { body: "Could you confirm the date?", direction: "outbound" }),
    ]);
    const c = channel("answered", [message("q", "Can you review this?", false, "2026-09-15T10:00:00Z"), message("a", "Yes, all done.", true)]);
    const result = search("Who needs a reply?", s, [c]);
    expect(result.results.map(item => item.id)).toEqual(["needs"]);
    expect(result.results[0].reason).toBe("Latest incoming message asks a question.");
  });

  test("waiting and sent questions use latest direction rather than old inbound requests", () => {
    const s = state([mail("sent", { direction: "outbound", body: "Could you confirm the appointment?" }), mail("received", { body: "Yes, confirmed." })]);
    const c = channel("waiting", [message("previous", "Thanks for checking.", false, "2026-09-15T10:00:00Z"), message("latest", "Could you send the details?", true)]);
    const result = search("Who am I waiting for?", s, [c]);
    expect(result.results.map(item => item.id).sort()).toEqual(["sent", "skool:waiting"]);
    expect(result.results.every(item => item.reason.includes("no newer incoming message is loaded"))).toBe(true);
    expect(search("What have I sent?", s, [c]).results.every(item => item.direction === "outbound")).toBe(true);
  });

  test("unread query does not describe a newer read message as unread", () => {
    const s = state([mail("older", { threadId: "same", read: false, receivedAt: "2026-09-15T10:00:00Z", body: "An unread note." }), mail("newer", { threadId: "same", read: true, body: "A newer read note." })]);
    const result = search("Show unread messages", s);
    expect(result.results[0].id).toBe("older");
    expect(result.results[0].reason).toBe("This conversation contains unread messages.");
  });

  test("topic stems, sponsorship intent and named providers work", () => {
    const s = state([mail("sponsor", { source: "gmail", subject: "Hello", body: "We would love to work together.", category: "sponsors" }), mail("skool-topic", { source: "skool", body: "Our pricing options are flexible." }), mail("slack", { source: "slack", body: "The sponsorship looks good." })]);
    expect(search("Show Gmail sponsorships", s).results.map(item => item.id)).toEqual(["sponsor"]);
    expect(search("brand deals", s).results.map(item => item.id).sort()).toEqual(["slack", "sponsor"]);
    expect(search("price", s).results[0].id).toBe("skool-topic");
  });

  test("conversational filler does not become a mandatory pricing topic", () => {
    const s = state([
      mail("pricing", { body: "Can you explain the pricing for the workshop?" }),
      mail("cost", { body: "What is the cost of the workshop?" }),
      mail("unrelated", { body: "People enjoyed the event yesterday." }),
    ]);
    expect(search("What did people ask about pricing?", s).results.map(item => item.id).sort()).toEqual(["cost", "pricing"]);
    expect(search("Did anyone ask anything regarding pricing?", s).results.map(item => item.id).sort()).toEqual(["cost", "pricing"]);
    expect(search("Show something related to pricing", s).results.map(item => item.id).sort()).toEqual(["cost", "pricing"]);
  });

  test("follow-up questions find current outgoing conversations with a qualified reason", () => {
    const s = state([
      mail("outgoing", { direction: "outbound", body: "Could you confirm the proposal?" }),
      mail("incoming", { direction: "inbound", body: "Could you confirm the appointment?" }),
    ]);
    for (const question of ["What should I follow up on?", "Any follow-up?", "Show followups"]) {
      const result = search(question, s);
      expect(result.results.map(item => item.id)).toEqual(["outgoing"]);
      expect(result.results[0].reason).toBe("The latest loaded message is yours; no newer incoming message is loaded.");
    }
  });

  test("today and this week constrain the actual matching message date", () => {
    const s = state([mail("today", { body: "Budget today." }), mail("monday", { body: "Budget monday.", receivedAt: "2026-09-14T10:00:00Z" }), mail("lastweek", { body: "Budget last week.", receivedAt: "2026-09-11T10:00:00Z" })]);
    expect(search("budget today", s).results.map(item => item.id)).toEqual(["today"]);
    expect(search("budget this week", s).results.map(item => item.id).sort()).toEqual(["monday", "today"]);
  });

  test("matches are capped at eight, counts are complete, and input state is unchanged", () => {
    const s = state(Array.from({ length: 12 }, (_, i) => mail(String(i), { body: "Budget notes." })));
    const before = JSON.stringify(s);
    const result = search("budget", s);
    expect(result.results).toHaveLength(8); expect(result.matchedCount).toBe(12); expect(result.totalSearched).toBe(12);
    expect(JSON.stringify(s)).toBe(before);
    expect(() => search("   ", s)).toThrow("between 1 and 600");
    expect(() => search("x".repeat(601), s)).toThrow("between 1 and 600");
  });
});

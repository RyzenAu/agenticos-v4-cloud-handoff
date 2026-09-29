import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LeadCards, CallQueue } from "../../src/components/operator/call-queue";
import { callingHours, selectCallQueue, websiteVerification } from "../../src/lib/call-queue";
import type { BoardLead } from "../../src/lib/leads";

const NOW = Date.parse("2026-09-28T10:00:00+10:00");
function lead(id: number, patch: Partial<BoardLead> = {}): BoardLead {
  return { id, name: "Fixture practice", area: "Parramatta NSW", phone: "0299990000", website: "", address: "", mapsUrl: "", emails: [], emailOk: false,
    vertical: "dental", score: 50, pitch: "website", reasons: ["No website found by automated discovery"], status: "to_call", owner: "usman",
    nextAt: "2026-09-28T14:00:00+10:00", lastContactAt: null, createdAt: "2026-09-01T00:00:00Z",
    deal: { closed: false, stage: "found", nextAction: "Call", evidence: "CRM", owner: "agent", stageSince: null, daysInStage: null, daysInferred: false, stuck: null,
      economics: {} as BoardLead["deal"]["economics"], contactPref: "", issues: [] }, ...patch };
}

test("queue includes all of Sydney today and overdue; callbacks, score, then due time", () => {
  const leads = [lead(1), lead(2, { score: 80 }), lead(3, { score: 80, nextAt: "2026-09-27T09:00:00+10:00" }), lead(4, { status: "call_back", score: 10 }),
    lead(5, { nextAt: "2026-09-28T23:59:00+10:00" }), lead(6, { nextAt: "2026-09-29T00:00:00+10:00" })];
  expect(selectCallQueue(leads, NOW).map(l => l.id)).toEqual([4, 3, 2, 1, 5]);
  expect(leads.map(l => l.id)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("queue excludes DNC, closed, non-call actions, missing phone and missing/invalid due dates", () => {
  const excluded: Partial<BoardLead>[] = [
    ...["do_not_contact", "won", "lost", "not_interested", "emailed", "interested", "meeting", "proposal"].map(status => ({ status: status as BoardLead["status"] })),
    { excluded: true }, { deal: { ...lead(0).deal, closed: true } }, { phone: "" }, { nextAt: null }, { nextAt: "invalid" },
  ];
  expect(selectCallQueue(excluded.map((p, i) => lead(i, p)), NOW)).toEqual([]);
});

for (const [date, open] of [
  ["2026-09-27T12:00:00+10:00", false], ["2026-09-28T08:59:00+10:00", false], ["2026-09-28T09:00:00+10:00", true],
  ["2026-09-28T19:59:00+10:00", true], ["2026-09-28T20:00:00+10:00", false], ["2026-10-03T16:59:00+10:00", true], ["2026-10-03T17:00:00+10:00", false],
  // Mon 5 Oct 2026 is NSW Labour Day (audit A-M1): closed all day. First AEDT weekday is Tue 6 Oct.
  ["2026-10-05T09:30:00+11:00", false], ["2026-10-06T09:00:00+11:00", true], ["2026-10-06T08:59:00+11:00", false],
] as const) test(`calling hours boundary ${date}`, () => {
  const hours = callingHours(Date.parse(date));
  expect(hours.open).toBe(open);
  expect(hours.banner === null).toBe(open);
  if (date.startsWith("2026-09-27")) expect(hours.banner).toContain("No calls today");
});

test("unverified sites never render absence claims, even in historical details", () => {
  for (const websiteStatus of [undefined, "no_website_unverified", "not_their_site", "bot_protected"]) {
    const l = lead(1); l.deal.websiteStatus = websiteStatus;
    l.deal.issues = [{ code: "no_website", finding: "No website found", severity: 3 }];
    const html = renderToStaticMarkup(<LeadCards leads={[l]} now={NOW} onOpen={() => {}} />);
    expect(html).not.toMatch(/no website/i);
    expect(html).toContain("Website not verified");
    expect(html).toContain(websiteStatus === "not_their_site" ? "wrong site" : "owner to Google");
  }
  const verified = lead(1, { website: "https://example.com" }); verified.deal.websiteStatus = "ok";
  expect(websiteVerification(verified)).toBe("Website verified");
});

test("card renders evidence link, essential fields and a closed details disclosure", () => {
  const l = lead(1); l.deal.issues = [{ code: "issue", finding: "Booking link broken", severity: 2, url: "https://example.com/book" }];
  const html = renderToStaticMarkup(<LeadCards leads={[l]} now={NOW} onOpen={() => {}} />);
  for (const text of ["Fixture practice", "Parramatta", "Booking link broken", "https://example.com/book", "usman", "Last touch", "28 Sept", "<details", "Details"]) expect(html).toContain(text);
  expect(html).not.toContain("<details open");
  expect(html.indexOf("Score")).toBeGreaterThan(html.indexOf("<details"));
});

test("closed hours disable queue calls and empty state explains scheduling", () => {
  const html = renderToStaticMarkup(<CallQueue leads={[lead(1)]} now={Date.parse("2026-09-28T20:00:00+10:00")} loading={false} error={null} onOpen={() => {}} />);
  expect(html).toContain("Calling hours closed"); expect(html).not.toContain("href=\"tel:");
  const empty = renderToStaticMarkup(<CallQueue leads={[]} now={NOW} loading={false} error={null} onOpen={() => {}} />);
  expect(empty).toContain("No calls due"); expect(empty).toContain("Schedule a call");
});

test("the queue follows status, phone and due date, never the pipeline's action text (audit F1-01)", () => {
  // Real stage actions (lead-pipeline.ts) never start with "call"; they must not keep a due call out.
  for (const action of ["Review response and follow-up timing", "Approve and make initial contact", "Verify business website and contact details", ""]) {
    const l = lead(1); l.deal.nextAction = action;
    expect(selectCallQueue([l], NOW)).toHaveLength(1);
  }
});

test("cards preserve recorded action text and reserve tel controls for callable leads", () => {
  for (const [status, callable] of [["to_call", true], ["call_back", true], ["interested", false], ["emailed", false]] as const) {
    const l = lead(1, { status }); l.deal.nextAction = "Review response and follow-up timing";
    const html = renderToStaticMarkup(<LeadCards leads={[l]} now={NOW} onOpen={() => {}} />);
    expect(html).toContain("Review response and follow-up timing");
    expect(html.includes('href="tel:0299990000"')).toBe(callable);
  }
  const noPhone = renderToStaticMarkup(<LeadCards leads={[lead(1, { phone: "" })]} now={NOW} onOpen={() => {}} />);
  expect(noPhone).not.toContain('href="tel:');
});

test("verified website absence retains its recorded verification date", () => {
  const l = lead(1, { websiteCheckedAt: "2026-09-25T02:00:00Z" });
  l.deal.websiteStatus = "no_website_verified";
  const html = renderToStaticMarkup(<LeadCards leads={[l]} now={NOW} onOpen={() => {}} />);
  expect(html).toContain("No website (verified 2026-09-25)");
  expect(html).not.toContain("Website not verified");
  expect(websiteVerification(l)).not.toContain("Website not verified");
  l.websiteCheckedAt = null;
  expect(websiteVerification(l)).toBe("No website (verified; date not recorded)");
});

test("cards restore preview status, keyboard copy controls and stuck warning", () => {
  const l = lead(1, { emails: ["fixture@example.com"] });
  l.deal.stuck = { days: 12, thresholdDays: 7, action: "Review the next step" };
  const html = renderToStaticMarkup(<LeadCards leads={[l]} now={NOW} onOpen={() => {}} previews={new Map([[1, { status: "live" }]])} />);
  for (const text of ["Preview: Live", "Copy email: fixture@example.com", "Copy phone: 0299990000", "Stuck", "12 days", "Review the next step"]) expect(html).toContain(text);
  expect(html).toMatch(/<button[^>]*aria-label="Copy phone:/);
  expect(html).toMatch(/<button[^>]*aria-label="Copy email:/);
  expect(renderToStaticMarkup(<LeadCards leads={[lead(2)]} now={NOW} onOpen={() => {}} />)).toContain("Preview: Not generated");
});

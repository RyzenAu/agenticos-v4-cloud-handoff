// Workspace aggregator, approvals file, calling window and privacy guarantees — synthetic fixtures
// only (fake sources, fake fetch). Nothing here reads the real CRM, inbox or receptionist.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPanel, runPanels } from "./aggregate";
import { mergeApprovals, validateApprovals } from "./approvals";
import { callingWindowStatus, sydneyWallToUtc } from "./calling-window";
import { refuse } from "./plugin";
import { maskPhone, scrubPhones, projectCallQueue, projectEmail, projectPipeline, projectReceptionist } from "./projections";
import { checkSite, createSiteChecker, detectNoindex, publicTargets } from "./sites";
import { createWorkspace, type GetJson } from "./sources";

const SECRET = "SENTINEL-PRIVATE-CONTENT";
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

// ── Aggregator ────────────────────────────────────────────────────────────────────────────────
describe("aggregator", () => {
  test("a slow source times out on its own; the others still return", async () => {
    const started = Date.now();
    const out = await runPanels({
      fast: { source: async () => ({ n: 1 }), timeoutMs: 1000 },
      slow: { source: (signal) => hang(signal), timeoutMs: 60 },
      broken: { source: async () => { throw new Error("CRM locked?token=abc"); }, timeoutMs: 1000 },
    });
    expect(Date.now() - started).toBeLessThan(900);
    expect(out.fast).toMatchObject({ ok: true, data: { n: 1 } });
    expect(out.slow).toMatchObject({ ok: false, timedOut: true });
    expect(out.broken).toMatchObject({ ok: false, timedOut: false, error: "CRM locked" }); // query string stripped
    for (const r of Object.values(out)) expect(Number.isFinite(Date.parse(r.updatedAt))).toBe(true);
  });

  test("the timeout aborts the source's signal", async () => {
    let aborted = false;
    await runPanel((signal) => { signal.addEventListener("abort", () => (aborted = true)); return hang(signal); }, 20);
    expect(aborted).toBe(true);
  });

  test("errors are single-line and bounded", async () => {
    const r = await runPanel(async () => { throw new Error(`line one\n${"x".repeat(500)}`); }, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain("\n");
      expect(r.error.length).toBeLessThanOrEqual(200);
    }
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
function receptionistFixture() {
  return {
    generatedAt: "2026-09-27T06:00:00.000Z",
    sentence: `Not safe to sell ${SECRET}`,
    verdict: { decision: "Not safe to sell", tone: "bad", facts: ["0 of 5 gates passed"], next: "Follow up 2 flagged calls" },
    incidents: [
      { callId: "call_a", startedAt: "2026-09-27T01:00:00.000Z", from: "+61 400 111 222", flags: ["DANGER_LANGUAGE", "FALSE_BOOKING", `free text ${SECRET}`], consequence: SECRET, retellUrl: `https://dashboard.retellai.com/${SECRET}` },
      { callId: "call_b", startedAt: null, from: "••• 999", flags: ["SMS_PROMISE"], consequence: "x", retellUrl: "" },
    ],
    health: [{ id: "webhook", label: "Webhook", tone: "ok", headline: "Webhook to MU-Receptionist", detail: SECRET, asOf: "2026-09-27T05:00:00.000Z" }, { id: "number", label: "Number", tone: "ok", headline: "+61 485 011 208 → v0" }],
    calls: {
      ok: true,
      windows: [
        { label: "Today", count: 1, answered: 1, flaggedCalls: 0, minutes: 2, audPerMinute: 0.15 },
        { label: "7 days", count: 4, answered: 3, flaggedCalls: 2, minutes: 7, audPerMinute: 0.17 },
        { label: "All time", count: 5 },
      ],
      recent: [{ id: "call_a", summary: SECRET, transcript: SECRET, analysisSummary: SECRET, from: "+61 400 111 222" }],
    },
    feed: {
      ok: true,
      generatedAt: "2026-09-27T06:23:00.000Z",
      totals: { qaFlagged: 1, qaCriticalOpen: 1, triagePending: 2 },
      calls: [
        { id: "feed_1", startedAt: "2026-09-27T02:00:00.000Z", callerMasked: "0400 333 444", summary: SECRET, transcript: SECRET, qa: { flagCount: 2, topBand: "CRITICAL", reviewStatus: "PENDING", flagCodes: ["LIFE_SAFETY", "URGENT_CALL"], evidence: SECRET } },
        { id: "feed_2", startedAt: null, callerMasked: null, summary: SECRET, qa: null },
      ],
      followUps: [{ contactFirstName: SECRET }],
    },
    readiness: {
      blockers: [
        { id: "no-false-actions", title: "No false bookings", state: "not-tested", next: "Retest" },
        { id: "compliance", title: "Compliance wording", state: "open", stateNote: "Evidence in; sign off" },
        { id: "urgent-wording", title: "Urgent wording", state: "pass" },
      ],
      cleanStreak: { count: 1, target: 5 },
      ownerRetestCalls: { count: 2, target: 5 },
    },
    commercial: { economics: { retellAudPerMinute: 0.1688, measuredCalls: 3, measuredMinutes: 7.7, caveat: "Retell only" } },
  };
}

function lead(id: number, extra: Record<string, any> = {}) {
  return {
    id, name: `Clinic ${id}`, vertical: "dental", area: "Parramatta NSW", status: "to_call", score: 50 + id,
    phone: "+61 2 9000 0" + String(id).padStart(3, "0"), excluded: false, nextAt: "2026-09-27T00:00:00.000Z",
    emails: [`owner${id}@clinic.example`], notes: SECRET, reasons: [SECRET],
    deal: { closed: false, nextAction: "Call to introduce the receptionist", notes: SECRET },
    ...extra,
  };
}

function inboxFixture() {
  const row = (i: number, extra: Record<string, any>) => ({
    messageId: `m${i}`, account: "owner@example.com", threadId: `t${i}`, receivedAt: `2026-09-27T0${i}:00:00.000Z`,
    senderName: `Sender ${i}`, senderAddress: `sender${i}@private.example`, senderDomain: "private.example",
    subject: `Subject ${i}`, summary: SECRET, body: SECRET, snippet: SECRET, reason: SECRET,
    category: "vendor-ops", importance: "fyi", jev: { needsReply: 0.1 }, ...extra,
  });
  return {
    counts: { total: 10, lastLoggedAt: "2026-09-27T06:00:00.000Z" },
    digest: { hours: 24, total: 6, urgent: 1, today: 2, fyi: 2, ignore: 1, lines: [SECRET] },
    rows: [
      row(1, { category: "client", importance: "today" }),
      row(2, { category: "newsletter", importance: "ignore", jev: { needsReply: 0.9 } }),
      row(3, { category: "lead-reply", importance: "urgent", senderName: "lead@private.example" }),
      row(4, { category: "vendor-ops", importance: "urgent", jev: { needsReply: 0.05 } }), // security alert: attention, not a reply
      row(5, { category: "billing", importance: "today", jev: { needsReply: 0.8 } }),
    ],
    shadow: { disagreements: [{ summary: SECRET }] },
  };
}

const connected = { accounts: { accounts: [{ id: "google", connected: false, email: "owner@example.com" }] }, native: { providers: [{ id: "gmail", enabled: true, available: true, account: "owner@example.com", lastSync: "2026-09-27T06:20:00.000Z" }] } };

// ── No bodies / no transcripts ────────────────────────────────────────────────────────────────
describe("privacy: metadata only", () => {
  test("receptionist projection carries flag codes and masked numbers, never transcripts or summaries", () => {
    const out = projectReceptionist(receptionistFixture());
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("400 111 222");
    expect(text).not.toContain("333 444");
    expect(text).not.toContain("485 011");
    expect(out.health[1].headline).toBe("••• 208 → v0");
    expect(scrubPhones("Report 2026-09-26 · 0 of 5 · call 0400 111 222")).toBe("Report 2026-09-26 · 0 of 5 · call ••• 222");
    expect(out.incidents[0]).toEqual({ callId: "call_a", startedAt: "2026-09-27T01:00:00.000Z", from: "••• 222", flags: ["DANGER_LANGUAGE", "FALSE_BOOKING"] });
    expect(out.feed.ok && out.feed.flaggedCalls).toEqual([{ id: "feed_1", startedAt: "2026-09-27T02:00:00.000Z", from: "••• 444", codes: ["LIFE_SAFETY", "URGENT_CALL"], band: "CRITICAL", review: "PENDING" }]);
  });

  test("life-safety and urgent flags raise alerts; ordinary flags don't", () => {
    const out = projectReceptionist(receptionistFixture());
    // UI-truth H4: an urgent call carries all its codes (urgent first), not only the urgent ones.
    expect(out.urgent.map((u) => [u.id, u.codes])).toEqual([
      ["call:call_a", ["DANGER_LANGUAGE", "FALSE_BOOKING"]],
      ["feed:feed_1", ["LIFE_SAFETY", "URGENT_CALL"]],
    ]);
    const calm = projectReceptionist({ ...receptionistFixture(), incidents: [{ callId: "c", flags: ["SMS_PROMISE"] }], feed: { ok: false, reason: "down" } });
    expect(calm.urgent).toEqual([]);
  });

  test("audit A-L1: a call flagged locally and by production QA is one alert, not two", () => {
    const base = receptionistFixture();
    const qa = { flagCount: 1, topBand: "CRITICAL", reviewStatus: "PENDING", flagCodes: ["LIFE_SAFETY"] };
    // Same Retell call id exposed by the feed.
    const byId = projectReceptionist({ ...base, feed: { ...base.feed, calls: [{ id: "feed_9", providerCallId: "call_a", startedAt: "2026-09-27T01:00:30.000Z", callerMasked: "••• 222", qa }] } });
    expect(byId.urgent.map((u) => [u.id, u.source, u.codes])).toEqual([["call:call_a", "call", ["DANGER_LANGUAGE", "LIFE_SAFETY", "FALSE_BOOKING"]]]);
    // No id in the feed: same masked caller within two minutes is the same call.
    const byCaller = projectReceptionist({ ...base, feed: { ...base.feed, calls: [{ id: "feed_9", startedAt: "2026-09-27T01:01:00.000Z", callerMasked: "0400 111 222", qa }] } });
    expect(byCaller.urgent.map((u) => u.id)).toEqual(["call:call_a"]);
    // A different caller, or the same caller hours apart, stays a separate alert.
    const other = projectReceptionist({ ...base, feed: { ...base.feed, calls: [{ id: "feed_9", startedAt: "2026-09-27T05:00:00.000Z", callerMasked: "0400 111 222", qa }] } });
    expect(other.urgent.map((u) => u.id)).toEqual(["call:call_a", "feed:feed_9"]);
  });

  test("email projection: sender + subject + age only; no bodies, snippets or addresses", () => {
    const out = projectEmail({ triage: inboxFixture(), ...connected });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("@");
    if (!out.connected) throw new Error("expected connected");
    expect(out.sources).toEqual([{ id: "gmail", lastSync: "2026-09-27T06:20:00.000Z" }]);
    expect(out.needsReply.map((r) => r.subject)).toEqual(["Subject 3", "Subject 1", "Subject 5"]); // urgent first, then oldest
    expect(out.needsReply[0].sender).toBe("private.example"); // an address as display name falls back to the domain
    for (const item of out.needsReply) expect(Object.keys(item).sort()).toEqual(["category", "importance", "receivedAt", "sender", "subject"]);
    expect(out.window).toMatchObject({ urgent: 1, today: 2, fyi: 2, ignore: 1 });
  });

  test("email: honest not-connected state", () => {
    const out = projectEmail({ triage: inboxFixture(), accounts: { accounts: [] }, native: { providers: [{ id: "gmail", enabled: false, available: true }] } });
    expect(out.connected).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Subject");
  });

  test("call queue: the /leads queue order, masked phones, no notes or emails", () => {
    const leads = [
      lead(1),
      lead(2, { status: "call_back", score: 10 }),
      lead(3, { nextAt: "2026-10-30T00:00:00.000Z" }), // not due yet
      lead(4, { excluded: true }),
      lead(5, { status: "interested" }), // warm: not a call status (the action text plays no part, audit F1-01)
      lead(6, { deal: { closed: false, nextAction: "Review response and follow-up timing" } }), // a real stage action: still due
    ];
    const out = projectCallQueue(leads as any, Date.parse("2026-09-27T03:00:00.000Z"));
    expect(out.total).toBe(3);
    expect(out.items.map((i) => i.id)).toEqual([2, 6, 1]); // callbacks first, then score (6 outscores 1)
    expect(out.items[0]).toMatchObject({ callback: true, phone: "••• 002" });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("@");
    expect(text).not.toContain("9000");
  });

  test("the whole snapshot stays clean end to end", async () => {
    const payloads: Record<string, unknown> = {
      "/__receptionist": receptionistFixture(),
      "/__operator/leads/list?deals=1": { leads: [lead(1)] },
      "/__operator/inbox/triage": inboxFixture(),
      "/__operator/connections": connected.accounts,
      "/__operator/native-connections": connected.native,
      "/__operator/leads/pipeline?summary=1": { counts: { contacted: 3, meeting: 1 }, total: 40, closed: 2 },
      "/__operator/leads/summary": { pipeline: { meeting: 1, to_call: 20 }, today: { usman: { notes: SECRET } } },
      "/__operator/leads/overview": { tiles: { followUps: { overdue: 1, dueToday: 2 }, proposals: { count: 1, valueCents: 165000 }, newLeads: { count: 4 }, stuck: { count: 0 } }, upcoming: [{ kind: "meeting", leadId: 1, name: "Clinic 1", at: "2026-09-29T00:00:00.000Z", detail: SECRET }], todo: [{ phone: "+61 2 9000 0001", detail: SECRET }] },
    };
    const ws = createWorkspace({
      get: async (path) => { if (!(path in payloads)) throw new Error(`unexpected ${path}`); return structuredClone(payloads[path]); },
      approvalsFile: join(import.meta.dir, "approvals.json"),
      sites: { check: async () => ({ checkedAt: "2026-09-27T06:00:00.000Z", sites: [], local: [], localNotRunning: [] }) },
      now: () => Date.parse("2026-09-27T03:00:00.000Z"),
      // A synthetic enquiry record carrying a stray private field: the projection must drop it.
      enquiries: () => [{
        ref: "e1", topic: "Website", receivedAt: "2026-09-27T02:30:00.000Z", detectedAt: "2026-09-27T02:31:00.000Z",
        startedAt: "2026-09-27T02:30:00.000Z", dueAt: "2026-09-27T03:30:00.000Z", outsideHoursAtArrival: false,
        notifiedAt: null, status: "open", respondedAt: null, ...({ note: SECRET } as object),
      }],
    });
    const snap = await ws.all();
    for (const [name, panel] of Object.entries(snap)) expect([name, panel.ok]).toEqual([name, true]);
    const text = JSON.stringify(snap);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("private.example".replace("private", "sender1@private"));
    expect(text).not.toMatch(/\+61 ?\d/);
    expect(snap.pipeline.ok && snap.pipeline.data).toMatchObject({ demosBooked: 1, followUps: { overdue: 1, dueToday: 2 }, upcomingMeetings: [{ leadId: 1, name: "Clinic 1" }] });
  });
});

// ── Partial results through the real workspace service ───────────────────────────────────────
describe("workspace service", () => {
  const sites = { check: async () => ({ checkedAt: new Date().toISOString(), sites: [], local: [], localNotRunning: [] }) };

  test("one hanging source → that panel times out; every other panel still answers", async () => {
    const get: GetJson = async (path, signal) => {
      if (path.startsWith("/__operator/inbox")) return hang(signal);
      if (path === "/__operator/connections") return connected.accounts;
      if (path === "/__operator/native-connections") return connected.native;
      if (path === "/__receptionist") return receptionistFixture();
      if (path.startsWith("/__operator/leads/list")) return { leads: [] };
      return {};
    };
    const ws = createWorkspace({ get, sites, approvalsFile: join(import.meta.dir, "approvals.json"), timeouts: { email: 80 } });
    const started = Date.now();
    const snap = await ws.all();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(snap.email).toMatchObject({ ok: false, timedOut: true });
    expect(snap.receptionist.ok).toBe(true);
    expect(snap.callQueue).toMatchObject({ ok: true, data: { total: 0, items: [] } });
    expect(snap.today.ok).toBe(true);
  });

  test("receptionist down → Today still lists the file approvals and says the gates are unavailable", async () => {
    // Pinned to 28 Sep 2026 (Sydney): the seeded items expire (UI-truth M6), so the count depends on the day.
    const ws = createWorkspace({ get: async () => { throw new Error("Receptionist status unavailable"); }, sites, approvalsFile: join(import.meta.dir, "approvals.json"), now: () => Date.parse("2026-09-28T01:00:00Z") });
    const today = await ws.panel("today");
    if (!today.ok) throw new Error(today.error);
    expect(today.data.approvals.length).toBe(7);
    expect(today.data.derivedError).toContain("Receptionist gates unavailable");
    const recep = await ws.panel("receptionist");
    expect(recep).toMatchObject({ ok: false, error: "Receptionist status unavailable" });
  });

  test("a broken approvals file is reported, not fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-approvals-"));
    writeFileSync(join(dir, "approvals.json"), "{ not json");
    const ws = createWorkspace({ get: async () => receptionistFixture(), sites, approvalsFile: join(dir, "approvals.json") });
    const today = await ws.panel("today");
    if (!today.ok) throw new Error(today.error);
    expect(today.data.approvalsErrors[0]).toContain("approvals.json unreadable");
    expect(today.data.approvals.map((a) => a.id)).toEqual(["receptionist-gate-compliance"]);
  });
});

// ── Approvals file ────────────────────────────────────────────────────────────────────────────
describe("approvals", () => {
  test("the seeded file is valid and lists the known owner decisions", () => {
    const out = validateApprovals(JSON.parse(readFileSync(join(import.meta.dir, "approvals.json"), "utf8")), Date.parse("2026-09-28T01:00:00Z"));
    expect(out.errors).toEqual([]);
    // UI-truth M6: the narration voice was decided (Scotty, 28 Sep), so it no longer waits.
    expect(out.items.map((a) => a.id)).toEqual([
      "receptionist-retest-calls", "receptionist-deploy-prereqs", "brooke-reply-draft", "website-merges-deploys",
      "dental-opening-choice", "nab-legacy-routes-closed", "call-plan-28-sep",
    ]);
    expect(out.decided).toBe(1);
    // Owner decision 27 Sep: Enquiry Rescue is dropped everywhere; no approval may ask to price it.
    expect(JSON.stringify(out.items)).not.toMatch(/enquiry rescue/i);
  });

  test("bad items are skipped with a reason; good ones survive; done ones drop out", () => {
    const good = { id: "ok-item", title: "A decision", area: "sales", detail: "Plain detail", href: "/leads", since: "2026-09-27", source: "test" };
    const out = validateApprovals({
      version: 1,
      items: [
        good,
        { ...good }, // duplicate id
        { ...good, id: "bad-area", area: "marketing" },
        { ...good, id: "has-email", detail: "Reply to someone@example.com" },
        { ...good, id: "has-phone", title: "Call +61 400 123 456" },
        { ...good, id: "bad-date", since: "27/09/2026" },
        { ...good, id: "http-link", href: "http://example.com" },
        { ...good, id: "Bad_ID" },
        { ...good, id: "closed", status: "done" },
        { ...good, id: "long", detail: "x".repeat(401) },
        "not an object",
      ],
    });
    expect(out.items.map((a) => a.id)).toEqual(["ok-item"]);
    expect(out.done).toBe(1);
    expect(out.errors.length).toBe(9);
    expect(out.errors.join("\n")).toMatch(/duplicate id/);
    expect(out.errors.join("\n")).toMatch(/contact details/);
  });

  test("not an object / wrong version", () => {
    expect(validateApprovals([]).errors[0]).toMatch(/must be an object/);
    expect(validateApprovals({ version: 2, items: [] }).errors).toEqual(["version must be 1"]);
  });

  test("merge adds open receptionist gates and live retest progress", () => {
    const file = validateApprovals(JSON.parse(readFileSync(join(import.meta.dir, "approvals.json"), "utf8"))).items;
    const merged = mergeApprovals(file, receptionistFixture().readiness);
    expect(merged.find((a) => a.id === "receptionist-retest-calls")?.progress).toBe("2 of 5 owner retest calls");
    const derived = merged.filter((a) => a.source === "receptionist readiness (live)");
    expect(derived.map((a) => a.id)).toEqual(["receptionist-gate-compliance"]); // pass and not-tested aren't sign-offs
    expect(mergeApprovals(file, null).length).toBe(file.length);
  });
});

// ── Calling window (Sydney time, DST) ─────────────────────────────────────────────────────────
describe("calling window", () => {
  const at = (iso: string) => callingWindowStatus(new Date(iso));

  test("weekday boundaries: 9 am opens, 8 pm closes (AEST, +10)", () => {
    // Monday 28 Sep 2026: 09:00 AEST = 27 Sep 23:00Z
    expect(at("2026-09-27T22:59:00Z")).toMatchObject({ open: false, label: "Closed · opens 9 am", nextOpenAt: "2026-09-27T23:00:00.000Z" });
    expect(at("2026-09-27T23:00:00Z")).toMatchObject({ open: true, closesAt: "2026-09-28T10:00:00.000Z" });
    expect(at("2026-09-28T09:59:00Z").open).toBe(true); // 19:59
    expect(at("2026-09-28T10:00:00Z")).toMatchObject({ open: false, label: "Closed · after hours", nextOpenAt: "2026-09-28T23:00:00.000Z" });
  });

  test("Saturday closes at 5 pm; Sunday is closed all day and next opens Monday 9 am", () => {
    // Saturday 26 Sep 2026
    expect(at("2026-09-26T06:59:00Z")).toMatchObject({ open: true, label: "Open · closes 5 pm", closesAt: "2026-09-26T07:00:00.000Z" });
    expect(at("2026-09-26T07:00:00Z")).toMatchObject({ open: false, nextOpenAt: "2026-09-27T23:00:00.000Z" }); // skips Sunday
    // Sunday 27 Sep 2026, midday
    expect(at("2026-09-27T02:00:00Z")).toMatchObject({ open: false, label: "Closed · Sunday", nextOpenAt: "2026-09-27T23:00:00.000Z" });
  });

  test("public holidays: Christmas, Boxing Day and the NSW substitute Mon 28 Dec closed; next window Tue 29 Dec (AEDT, +11)", () => {
    expect(at("2026-12-25T01:00:00Z")).toMatchObject({ open: false, label: "Closed · public holiday", nextOpenAt: "2026-12-28T22:00:00.000Z" });
    expect(at("2026-12-26T01:00:00Z")).toMatchObject({ open: false, label: "Closed · public holiday" });
    expect(at("2026-12-27T23:00:00Z")).toMatchObject({ open: false, label: "Closed · public holiday", sydney: { date: "2026-12-28", weekday: "Mon" } });
  });

  test("audit A-M1: NSW Labour Day, Mon 5 Oct 2026 09:30 Sydney, is closed; next window Tue 6 Oct 9 am", () => {
    expect(at("2026-10-04T22:30:00Z")).toMatchObject({ open: false, label: "Closed · public holiday", nextOpenAt: "2026-10-05T22:00:00.000Z",
      sydney: { date: "2026-10-05", weekday: "Mon", time: "09:30" } });
  });

  test("other NSW-only days are closed: Easter Saturday, King's Birthday, 2027 substitutes", () => {
    for (const iso of ["2026-04-04T01:00:00Z", "2026-06-08T01:00:00Z", "2027-12-27T01:00:00Z", "2027-12-28T01:00:00Z"])
      expect({ iso, open: at(iso).open }).toEqual({ iso, open: false });
  });

  test("DST starts Sun 4 Oct 2026: Friday opens 9 am AEST, Monday opens 9 am AEDT", () => {
    expect(at("2026-10-01T23:00:00Z")).toMatchObject({ open: true, sydney: { date: "2026-10-02", weekday: "Fri", time: "09:00" } });
    expect(at("2026-10-01T22:59:00Z").open).toBe(false);
    // Mon 5 Oct is NSW Labour Day, so Sunday night → Tue 6 Oct 09:00 AEDT.
    expect(at("2026-10-04T12:00:00Z")).toMatchObject({ open: false, nextOpenAt: "2026-10-05T22:00:00.000Z" });
    expect(at("2026-10-05T22:00:00Z")).toMatchObject({ open: true, closesAt: "2026-10-06T09:00:00.000Z", sydney: { time: "09:00" } });
  });

  test("DST ends Sun 4 Apr 2027: Saturday 5 pm AEDT close, Monday 9 am AEST open", () => {
    expect(at("2027-04-03T05:59:00Z")).toMatchObject({ open: true, closesAt: "2027-04-03T06:00:00.000Z" }); // Sat 16:59 AEDT
    expect(at("2027-04-03T06:00:00Z")).toMatchObject({ open: false, nextOpenAt: "2027-04-04T23:00:00.000Z" }); // Mon 5 Apr 09:00 AEST
  });

  test("wall-clock conversion is DST-aware", () => {
    expect(sydneyWallToUtc(2026, 7, 1, 9 * 60).toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(sydneyWallToUtc(2027, 1, 15, 9 * 60).toISOString()).toBe("2027-01-14T22:00:00.000Z");
  });
});

// ── Websites ──────────────────────────────────────────────────────────────────────────────────
describe("websites", () => {
  const html = (robots?: string) => `<html><head>${robots ? `<meta name="robots" content="${robots}">` : ""}<title>x</title></head><body></body></html>`;
  const fakeFetch = (routes: Record<string, { status: number; body?: string; headers?: Record<string, string>; delay?: number }>) =>
    (async (url: string, init?: RequestInit) => {
      const r = routes[url];
      if (!r) throw new Error("ECONNREFUSED");
      if (r.delay) await new Promise((resolve, reject) => { const t = setTimeout(resolve, r.delay); init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }); });
      return new Response(r.body ?? html(), { status: r.status, headers: { "content-type": "text/html; charset=utf-8", ...r.headers } });
    }) as unknown as typeof fetch;

  test("the public list covers every required site", () => {
    const urls = publicTargets().map((t) => t.url);
    for (const u of ["https://muventures.com.au", "https://bianca.muventures.com.au", "https://bianca-preview.muventures.com.au", "https://mardenrowe.muventures.com.au", "https://aldergate.muventures.com.au", "https://muv-demo-dental.vercel.app", "https://mu-receptionist.vercel.app"]) expect(urls).toContain(u);
  });

  test("noindex from header or meta", () => {
    expect(detectNoindex("noindex, nofollow", "")).toBe(true);
    expect(detectNoindex(null, html("noindex"))).toBe(true);
    expect(detectNoindex(null, `<meta content="noindex" name='googlebot'>`)).toBe(true);
    expect(detectNoindex(null, html("index, follow"))).toBe(false);
  });

  test("status, noindex expectation, errors and timeouts", async () => {
    const f = fakeFetch({
      "https://a.test": { status: 200 },
      "https://preview.test": { status: 200 },
      "https://down.test": { status: 503 },
      "https://slow.test": { status: 200, delay: 500 },
    });
    const deps = { fetch: f, now: Date.now, timeoutMs: 100 };
    expect(await checkSite({ id: "a", name: "A", url: "https://a.test", kind: "marketing", expectNoindex: false }, deps)).toMatchObject({ ok: true, status: 200, noindex: false, tone: "ok" });
    expect(await checkSite({ id: "p", name: "P", url: "https://preview.test", kind: "client", expectNoindex: true }, deps)).toMatchObject({ ok: true, tone: "warn", note: "Should be noindex but is indexable" });
    expect(await checkSite({ id: "d", name: "D", url: "https://down.test", kind: "demo", expectNoindex: null }, deps)).toMatchObject({ ok: false, status: 503, tone: "bad" });
    expect(await checkSite({ id: "s", name: "S", url: "https://slow.test", kind: "demo", expectNoindex: null }, deps)).toMatchObject({ ok: false, status: null, tone: "bad", note: "No response within 0.1 s" });
    expect(await checkSite({ id: "x", name: "X", url: "https://nowhere.test", kind: "demo", expectNoindex: null }, deps)).toMatchObject({ ok: false, tone: "bad" });
  });

  test("results cache for 5 minutes; only listening local ports are checked", async () => {
    let calls = 0;
    let clock = Date.parse("2026-09-27T00:00:00Z");
    const f = (async (url: string) => { calls++; return new Response(html(), { status: 200, headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch;
    const checker = createSiteChecker({
      fetch: f, now: () => clock,
      targets: [{ id: "a", name: "A", url: "https://a.test", kind: "marketing", expectNoindex: null }],
      ports: [{ port: 3401, name: "Marketing (local)" }, { port: 3402, name: "Other" }],
      listening: async (port) => port === 3401,
    });
    const first = await checker.check();
    expect(first.local.map((l) => l.url)).toEqual(["http://127.0.0.1:3401/"]);
    expect(first.localNotRunning).toEqual([{ port: 3402, name: "Other" }]);
    expect(calls).toBe(2);
    clock += 4 * 60_000;
    await checker.check();
    expect(calls).toBe(2);
    clock += 2 * 60_000;
    await checker.check();
    expect(calls).toBe(4);
  });
});

// ── Route guard ───────────────────────────────────────────────────────────────────────────────
describe("route guard", () => {
  const req = (over: { remote?: string; host?: string; method?: string; headers?: Record<string, string> } = {}) =>
    ({ socket: { remoteAddress: over.remote ?? "127.0.0.1" }, method: over.method ?? "GET", headers: { host: over.host ?? "127.0.0.1:8081", ...over.headers } }) as any;
  test("local GET passes; remote, tailnet host, cross-site, other origins and writes are refused", () => {
    expect(refuse(req())).toBeNull();
    expect(refuse(req({ host: "localhost:8081", headers: { origin: "http://localhost:8081" } }))).toBeNull();
    expect(refuse(req({ remote: "100.64.0.2" }))?.status).toBe(403);
    // Stage B1: a tailnet Host with no verified login is nobody (401); relay headers never pass as local.
    expect(refuse(req({ host: "pc.tailnet.ts.net" }))?.status).toBe(401);
    expect(refuse(req({ host: "localhost:8081", headers: { "x-forwarded-for": "100.64.0.7" } }))?.status).toBe(401);
    expect(refuse(req({ host: "localhost:8081", headers: { via: "1.1 proxy" } }))?.status).toBe(401);
    // Both verified founders read the shared workspace (V7), over HTTPS from their own origin.
    const mehroz = () => ({ personId: "mehroz" as const, via: "tailnet-person" as const, displayName: "Mehroz" });
    expect(refuse(req({ host: "pc.tailnet.ts.net", headers: { origin: "https://pc.tailnet.ts.net" } }), mehroz)).toBeNull();
    expect(refuse(req({ headers: { "sec-fetch-site": "cross-site" } }))?.status).toBe(403);
    expect(refuse(req({ headers: { origin: "http://evil.test" } }))?.status).toBe(403);
    expect(refuse(req({ method: "POST" }))?.status).toBe(405);
  });
});

test("maskPhone", () => {
  expect(maskPhone("+61 485 011 208")).toBe("••• 208");
  expect(maskPhone("••• 208")).toBe("••• 208");
  expect(maskPhone("12")).toBeNull();
  expect(maskPhone(null)).toBeNull();
});

test("pipeline projection shows sales stages in order and missing numbers as null", () => {
  const out = projectPipeline({ summary: { counts: { contacted: 2, won: 1 }, total: 10, closed: 1 }, statusCounts: null, overview: null });
  expect(out.stages.slice(0, 3)).toEqual([{ stage: "contacted", count: 2 }, { stage: "replied", count: 0 }, { stage: "meeting", count: 0 }]);
  expect(out.demosBooked).toBeNull();
  expect(out.followUps).toEqual({ overdue: null, dueToday: null });
});

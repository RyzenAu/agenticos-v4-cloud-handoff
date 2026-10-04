import { expect, test } from "bun:test";
import { buildReceptionistSnapshot } from "./aggregate";
import { inputs, NOW } from "./aggregate.test";
import { createAgencyFeed, projectAgencyFeed } from "./agency-feed";

const TOKEN = "feed-token-DO-NOT-LEAK-8241";
const FEED_URL = "https://mu-receptionist.example.test/api/agency/feed";
const keys = (name: string) => (name === "AGENCY_FEED_URL" ? FEED_URL : name === "AGENCY_FEED_TOKEN" ? TOKEN : "");

/** A contract-shaped v1 body, with every forbidden field stuffed with a sentinel. */
const fixture = () => ({
  version: 1,
  generatedAt: "2026-09-26T02:00:00Z",
  windowDays: 30,
  organizations: [
    {
      id: "org_1",
      name: "Demo Dental",
      slug: "demo",
      niche: "dental",
      isDemoTenant: true,
      inboundNumberMasked: "+61 485 011 1208",
    },
  ],
  totals: {
    calls: 42,
    completed: 38,
    failed: -4, // invalid on purpose: must become null, never a zero
    avgDurationSeconds: 91.5,
    totalMinutes: 64,
    byOutcome: { booked: 9, took_message: 20, "": 3, bogus: "many" },
    bySentiment: { positive: 12 },
    qaGraded: 30,
    qaFlagged: 3,
    qaCriticalOpen: 1,
    triagePending: 2,
    triageDone: 5,
    oldestPendingTriageAt: "2026-09-25T02:00:00Z",
  },
  calls: [
    {
      id: "call_1",
      organizationId: "org_1",
      providerCallId: "retell_1",
      callType: "phone",
      status: "ended",
      outcome: "booked",
      sentiment: "positive",
      callerMasked: "+61 412 345 208", // contract says masked; we re-mask anyway
      startedAt: "2026-09-26T01:00:00Z",
      endedAt: "2026-09-26T01:03:00Z",
      durationSeconds: 183,
      disconnectionReason: "user_hangup",
      summary: "Asked about opening hours. ".repeat(20),
      qa: { flagCount: 2, topBand: "critical", reviewStatus: "open", flagCodes: ["FALSE_BOOKING", "SMS_PROMISE", "SMS_PROMISE"] },
      // forbidden by the contract — none of this may ever leave the server
      transcriptText: "SECRET_TRANSCRIPT_8241",
      transcriptJson: "SECRET_TRANSCRIPT_8241",
      analysisJson: "SECRET_ANALYSIS_8241",
      recordingUrl: "SECRET_RECORDING_8241",
      messageText: "SECRET_MESSAGE_8241",
      draftSms: "SECRET_SMS_8241",
      approvedBody: "SECRET_BODY_8241",
      contactEmail: "SECRET_EMAIL_8241",
      decision: "SECRET_DECISION_8241",
      jevAnswers: "SECRET_JEV_8241",
      facts: "SECRET_FACTS_8241",
    },
    { id: null, transcriptText: "SECRET_TRANSCRIPT_8241" }, // entry without an id: dropped
  ],
  followUps: [
    {
      id: "triage_1",
      organizationId: "org_1",
      callRecordId: "call_1",
      receivedAt: "2026-09-26T01:00:00Z",
      contactFirstName: "Mary Jane",
      callerMasked: "••• 208",
      intent: "Book a check-up",
      urgency: "high",
      callbackNeeded: true,
      alertPriority: "high",
      status: "pending",
      messageText: "SECRET_MESSAGE_8241",
      contactEmail: "SECRET_EMAIL_8241",
    },
  ],
  transcriptText: "SECRET_TRANSCRIPT_8241",
  contactEmail: "SECRET_EMAIL_8241",
});

const response = (data: unknown, status = 200) =>
  new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("feed is fetched with the bearer token and projects the contract shape", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const feed = createAgencyFeed({
    providerKey: keys,
    fetch: (async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      return response(fixture());
    }) as typeof fetch,
  });
  const state = await feed();
  expect(state.ok).toBe(true);
  if (!state.ok) throw Error("feed");
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe(`${FEED_URL}?view=full`);
  expect(seen[0].init.method).toBe("GET");
  expect(seen[0].init.redirect).toBe("error");
  expect(seen[0].init.signal).toBeDefined();
  expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  expect(state.generatedAt).toBe("2026-09-26T02:00:00.000Z");
  expect(state.windowDays).toBe(30);
  expect(state.totals).toMatchObject({ calls: 42, completed: 38, failed: null, qaGraded: 30, qaFlagged: 3, qaCriticalOpen: 1, triagePending: 2, triageDone: 5 });
  expect(state.totals.byOutcome).toEqual([
    { name: "booked", count: 9 },
    { name: "took_message", count: 20 },
  ]);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({
    id: "call_1",
    providerCallId: "retell_1",
    callerMasked: "••• 208",
    durationSeconds: 183,
    outcome: "booked",
  });
  expect(state.calls[0].summary!.length).toBe(200);
  expect(state.calls[0].qa).toEqual({
    flagCount: 2,
    topBand: "critical",
    reviewStatus: "open",
    flagCodes: ["FALSE_BOOKING", "SMS_PROMISE"],
  });
  expect(state.followUps).toHaveLength(1);
  expect(state.followUps[0]).toMatchObject({
    contactFirstName: "Mary",
    callerMasked: "••• 208",
    callbackNeeded: true,
    status: "pending",
  });
});

test("privacy: forbidden fields, full phones and the token never survive projection", async () => {
  const feed = createAgencyFeed({
    providerKey: keys,
    fetch: (async () => response(fixture())) as typeof fetch,
  });
  const state = await feed();
  const json = JSON.stringify(state);
  for (const secret of [
    "SECRET_TRANSCRIPT_8241",
    "SECRET_ANALYSIS_8241",
    "SECRET_RECORDING_8241",
    "SECRET_MESSAGE_8241",
    "SECRET_SMS_8241",
    "SECRET_BODY_8241",
    "SECRET_EMAIL_8241",
    "SECRET_DECISION_8241",
    "SECRET_JEV_8241",
    "SECRET_FACTS_8241",
  ])
    expect(json).not.toContain(secret);
  expect(json).not.toContain("412 345 208");
  expect(json).not.toContain("485 011 1208");
  expect(json).not.toContain(TOKEN);
});

test("privacy: the token never appears in anything the browser receives", async () => {
  const feed = createAgencyFeed({
    providerKey: keys,
    fetch: (async () => response(fixture())) as typeof fetch,
  });
  const state = await feed();
  // The full page model that POSTs to the browser: token, feed secrets and error bodies absent.
  const snapshot = buildReceptionistSnapshot({ ...inputs(), agencyFeed: state }, NOW);
  const json = JSON.stringify(snapshot);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain("SECRET_TRANSCRIPT_8241");
  expect(json).not.toContain("SECRET_EMAIL_8241");
});

test("unavailable without env: a reason, no fetch, and never zeros", async () => {
  let called = 0;
  const feed = createAgencyFeed({
    providerKey: () => "",
    fetch: (async () => {
      called++;
      return response(fixture());
    }) as typeof fetch,
  });
  const state = await feed();
  expect(called).toBe(0);
  expect(state).toEqual({ ok: false, reason: "Agency feed not configured" });
  const snapshot = buildReceptionistSnapshot({ ...inputs(), agencyFeed: state }, NOW);
  expect(snapshot.feed.ok).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain("qaGraded");
  const health = snapshot.health.find((h) => h.id === "feed");
  expect(health).toMatchObject({ tone: "warn", headline: "Feed unavailable" });
  expect(health?.detail).toBe("Agency feed not configured");
});

test("401 is an unavailable state with a reason that never echoes the body", async () => {
  const feed = createAgencyFeed({
    providerKey: keys,
    fetch: (async () => response(`{"error":"bad token ${TOKEN} sensitive-fixture"}`, 401)) as typeof fetch,
  });
  const state = await feed();
  expect(state.ok).toBe(false);
  if (state.ok) throw Error("feed");
  expect(state.reason).toContain("401");
  expect(JSON.stringify(state)).not.toContain(TOKEN);
  expect(JSON.stringify(state)).not.toContain("sensitive-fixture");
});

test("malformed JSON and wrong shapes are unavailable, not empty data", async () => {
  for (const body of ["{not json", JSON.stringify({}), JSON.stringify({ version: 2, generatedAt: "2026-09-26T02:00:00Z", totals: {}, calls: [], followUps: [] })]) {
    const feed = createAgencyFeed({
      providerKey: keys,
      fetch: (async () => response(body)) as typeof fetch,
    });
    const state = await feed();
    expect(state.ok).toBe(false);
    if (state.ok) throw Error("feed");
    expect(state.reason).toMatch(/Agency feed (response invalid|version unsupported)/);
    expect(JSON.stringify(state)).not.toMatch(/"calls"|"totals"/);
  }
});

test("network failure and non-2xx are unavailable with fixed reasons", async () => {
  for (const [request, needle] of [
    [(async () => { throw new Error(`boom ${TOKEN}`); }) as typeof fetch, /unreachable \(request failed\)/],
    [(async () => response({}, 503)) as typeof fetch, /HTTP 503/],
    [(async () => response({}, 500)) as typeof fetch, /HTTP 500/],
  ] as const) {
    const feed = createAgencyFeed({ providerKey: keys, fetch: request });
    const state = await feed();
    expect(state.ok).toBe(false);
    if (state.ok) throw Error("feed");
    expect(state.reason).toMatch(needle);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain("boom");
  }
});

test("results are cached for 60 seconds and force refetches", async () => {
  let called = 0,
    now = NOW;
  const feed = createAgencyFeed({
    providerKey: keys,
    now: () => now,
    fetch: (async () => {
      called++;
      return response(fixture());
    }) as typeof fetch,
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  expect(a).toBe(b);
  expect(called).toBe(1);
  await feed();
  expect(called).toBe(1);
  now += 59_000;
  await feed();
  expect(called).toBe(1);
  now += 2_000;
  await feed();
  expect(called).toBe(2);
  await feed(true);
  expect(called).toBe(3);
});

test("merge: QA totals, follow-ups and feed health land in the page model", async () => {
  const feed = createAgencyFeed({
    providerKey: keys,
    fetch: (async () => response(fixture())) as typeof fetch,
  });
  const state = await feed();
  const snapshot = buildReceptionistSnapshot({ ...inputs(), agencyFeed: state }, NOW);
  expect(snapshot.feed.ok).toBe(true);
  if (!snapshot.feed.ok) throw Error("feed");
  expect(snapshot.feed.totals.qaCriticalOpen).toBe(1);
  expect(snapshot.feed.followUps[0].contactFirstName).toBe("Mary");
  const health = snapshot.health.find((h) => h.id === "feed");
  expect(health?.tone).toBe("ok");
  expect(health?.headline).toContain("Feed connected");
  expect(health?.headline).toContain("26 Sep");
  expect(health?.asOf).toBe("2026-09-26T02:00:00.000Z");
  // Feed health is information, not the answering path: an unavailable feed never blocks selling.
  const down = buildReceptionistSnapshot(inputs(), NOW);
  expect(down.health.find((h) => h.id === "feed")?.tone).toBe("warn");
  expect(down.verdict.decision).toBe(snapshot.verdict.decision);
});

test("projection is total: junk entries and bad counters degrade to nulls, never crash", () => {
  const state = projectAgencyFeed({
    version: 1,
    generatedAt: "2026-09-26T02:00:00Z",
    windowDays: "thirty",
    totals: { calls: "many", qaGraded: 3 },
    calls: [{ id: "c1", durationSeconds: -5, startedAt: "nonsense", callerMasked: 61412345678 }, null, 7],
    followUps: [{ id: "t1", callbackNeeded: "yes" }, {}],
  });
  expect(state.ok).toBe(true);
  if (!state.ok) throw Error("feed");
  expect(state.windowDays).toBeNull();
  expect(state.totals.calls).toBeNull();
  expect(state.totals.qaGraded).toBe(3);
  expect(state.calls[0]).toMatchObject({ durationSeconds: null, startedAt: null, callerMasked: "••• 678", qa: null });
  expect(state.followUps[0]).toMatchObject({ callbackNeeded: false, contactFirstName: null });
  expect(state.followUps).toHaveLength(1);
});

// ── v1 additions, 27 Sep 2026: clients[] / deployment (dashboard.ts's only feed dependency) ──────

const metadataFixture = () => ({
  ...fixture(),
  view: "metadata",
  calls: [],
  followUps: [],
  clients: [
    {
      organizationId: "org_1",
      slug: "demo-dental",
      isDemoTenant: true,
      bookings: { byStatus: { CONFIRMED: 5, CANCELLED: -1 }, total: 6, madeOnCalls: 5, sandbox: 6, upcoming: 2 },
      handoffs: {
        transfersByStatus: { RESERVED: 1, CONNECTED: 0 },
        alertsByReason: { NEW_BOOKING: 5 },
        alertsByStatus: { PENDING: 1, SENT: 4 },
      },
      minutesThisMonth: { monthStart: "2026-09-01T00:00:00Z", calls: 40, callMinutes: 88, billableMinutesCurrentPeriod: 88 },
      readiness: {
        agentMapped: true, inboundNumberSet: true, calendarRequested: "GOOGLE", calendarInUse: "SANDBOX",
        calendarReason: "missing-credential", liveCalendar: false, demoDiaryConfirmed: true,
        bookingOutcome: "test_booking_only", alertMailboxSet: true, transferEnabled: false, smsEnabled: false,
        retentionDays: 90, retellRetentionAligned: "unverified",
      },
      // forbidden shape check: an extra field must never spread through
      transcriptText: "SECRET_CLIENT_8241",
    },
    { organizationId: null }, // dropped: no id
  ],
  deployment: {
    retellWebhookSecretSet: true, alertEmailChannelLive: false, cronSecretValid: true,
    trustProxyHeaders: true, transferExecutionEnabled: false,
  },
});

test("view=metadata is appended to the feed URL and nothing else", async () => {
  const seen: string[] = [];
  const feed = createAgencyFeed({
    providerKey: keys,
    view: "metadata",
    fetch: (async (url: any) => { seen.push(String(url)); return response(metadataFixture()); }) as typeof fetch,
  });
  await feed();
  expect(seen).toEqual([`${FEED_URL}?view=metadata`]);
});

test("a full-view read asks for view=full explicitly (the feed's default is now metadata)", async () => {
  // MU-Receptionist f/rx-open-items-20260929: no view, an empty or an unknown view returns the
  // METADATA view. A reader that omitted the parameter would silently get empty calls/followUps.
  for (const view of [undefined, "full" as const]) {
    const seen: string[] = [];
    const feed = createAgencyFeed({
      providerKey: keys,
      ...(view ? { view } : {}),
      fetch: (async (url: any) => { seen.push(String(url)); return response(fixture()); }) as typeof fetch,
    });
    const state = await feed();
    expect(seen).toEqual([`${FEED_URL}?view=full`]);
    expect(state.ok && state.view).toBe("full");
    expect(state.ok && state.calls.length).toBeGreaterThan(0);
  }
});

test("a view already in the configured URL is replaced by the requested one, never duplicated", async () => {
  const seen: string[] = [];
  const feed = createAgencyFeed({
    providerKey: (name: string) => (name === "AGENCY_FEED_URL" ? `${FEED_URL}?view=metadata` : keys(name)),
    view: "full",
    fetch: (async (url: any) => { seen.push(String(url)); return response(fixture()); }) as typeof fetch,
  });
  await feed();
  expect(seen).toEqual([`${FEED_URL}?view=full`]);
});

test("v1-additions clients/deployment project cleanly, with junk entries degrading not crashing", () => {
  const state = projectAgencyFeed(metadataFixture());
  expect(state.ok).toBe(true);
  if (!state.ok) throw Error("feed");
  expect(state.view).toBe("metadata");
  expect(state.calls).toEqual([]);
  expect(state.followUps).toEqual([]);
  expect(state.clients).toHaveLength(1);
  const client = state.clients[0];
  expect(client.organizationId).toBe("org_1");
  expect(client.slug).toBe("demo-dental");
  expect(client.bookings).toEqual({ byStatus: { CONFIRMED: 5 }, total: 6, madeOnCalls: 5, sandbox: 6, upcoming: 2 });
  expect(client.handoffs.alertsByStatus).toEqual({ PENDING: 1, SENT: 4 });
  expect(client.minutesThisMonth).toMatchObject({ callMinutes: 88, billableMinutesCurrentPeriod: 88 });
  expect(client.readiness).toMatchObject({
    agentMapped: true, inboundNumberSet: true, calendarInUse: "SANDBOX", bookingOutcome: "test_booking_only",
    smsEnabled: false, retellRetentionAligned: "unverified",
  });
  expect(JSON.stringify(state)).not.toContain("SECRET_CLIENT_8241");
  expect(state.deployment).toEqual({
    retellWebhookSecretSet: true, alertEmailChannelLive: false, cronSecretValid: true,
    trustProxyHeaders: true, transferExecutionEnabled: false,
  });
});

test("a pre-v1-additions feed (no clients/deployment key) projects to empty clients and null deployment", () => {
  const state = projectAgencyFeed(fixture());
  expect(state.ok).toBe(true);
  if (!state.ok) throw Error("feed");
  expect(state.view).toBe("full");
  expect(state.clients).toEqual([]);
  expect(state.deployment).toBeNull();
});

test("an unrecognised bookingOutcome value is dropped, never invented", () => {
  const state = projectAgencyFeed({
    ...metadataFixture(),
    clients: [{ organizationId: "org_1", readiness: { bookingOutcome: "made_up_value" } }],
  });
  expect(state.ok).toBe(true);
  if (!state.ok) throw Error("feed");
  expect(state.clients[0].readiness.bookingOutcome).toBeNull();
});

test("plugin wiring: the snapshot feed asks for view=full, the dashboard feed for view=metadata (the app's default is metadata)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./plugin.ts", import.meta.url), "utf8");
  expect(src).toMatch(/const agencyFeed = createAgencyFeed\(\{[^}]*view: "full"/);
  expect(src).toMatch(/const agencyFeedMetadata = createAgencyFeed\(\{[^}]*view: "metadata"/);
});

test("usage.currentPeriod.billingBlocked is projected as a block, never dropped or zeroed", () => {
  const base = { organizationId: "org_1", slug: "s", isDemoTenant: false, readiness: {} };
  const usage = (currentPeriod: unknown) => ({ receipts: 1, pending: 0, billableMinutes: 10, smsSegments: 0, currentPeriod });
  const state = projectAgencyFeed({
    ...(fixture() as object),
    clients: [
      { ...base, usage: usage({ billableMinutes: 12, billingBlocked: { reason: "TAX_MODE_MISMATCH", message: "Billing blocked: tax mode mismatch." } }) },
      { ...base, organizationId: "org_2", usage: usage({ billableMinutes: 12, billingBlocked: null }) },
      { ...base, organizationId: "org_3", usage: usage({ billableMinutes: 12, billingBlocked: { reason: 5 } }) },
    ],
  });
  if (!state.ok) throw Error("feed");
  const [a, b, c] = state.clients.map((x) => x.usage?.periodBillingBlocked ?? null);
  expect(a).toEqual({ reason: "TAX_MODE_MISMATCH", message: "Billing blocked: tax mode mismatch." });
  expect(b).toBeNull();
  expect(c).toMatchObject({ reason: "UNKNOWN" }); // malformed block still blocks
});

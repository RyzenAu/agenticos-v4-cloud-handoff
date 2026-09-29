import type { AgentFacts, NumberFacts } from "./retell";
import type { TwilioFacts } from "./twilio";
import type { EvalFacts } from "./evals";
import { catalogueOffer, economics } from "./commercial";
import { buildReadiness, plural, qualifying, sydneyShort, type FollowUps, type Signoffs } from "./readiness";
import { isCriticalBand, isOpenReview, qaConsequenceParts } from "./qa-codes";
import { isCriticalFlag, sellGateChecks } from "./sell-gate";
import type { ChecklistStepStatus } from "./checklist";
import type {
  AgencyFeedState,
  CallRow,
  CallWindow,
  CallsBlock,
  CommercialBlock,
  FlagCode,
  LineSource,
  HealthItem,
  Incident,
  ReceptionistSnapshot,
  SellCheck,
  Source,
  Verdict,
} from "./types";
export type SnapshotInputs = {
  agentId: string;
  number: string;
  /** Where agentId/number were resolved from (plugin.ts resolveLine); absent means "options". */
  lineSource?: LineSource;
  agent: Source<AgentFacts>;
  numberFacts: Source<NumberFacts>;
  calls: Source<{ rows: CallRow[] }>;
  twilio: Source<TwilioFacts>;
  evals: Source<EvalFacts>;
  /** MU-Receptionist's production feed (QA flags, outcomes, triage); { ok:false, reason } when unreadable. */
  agencyFeed: AgencyFeedState;
  /** When that feed read completed and when one last succeeded (ms; agency-feed.ts reader status). */
  agencyFeedRead?: { readAt: number | null; lastOkAt: number | null };
  legal: "present" | "missing" | "unknown";
  leads: CommercialBlock["leads"];
  signoffs: Signoffs;
  /** Flagged calls the owner has marked followed up (by call id). */
  followedUp?: FollowUps;
  /**
   * Go-live checklist statuses. Absent (the plugin never sets it): derived from the agency feed by
   * checklist.ts, where steps the feed can't observe stay "unknown" — so the checklist, and with it
   * "Safe to sell", can't complete on silence.
   */
  checklist?: ChecklistStepStatus[];
  fx: ReceptionistSnapshot["fx"];
};
/** "+614xxxxxxxx" (AU mobile, E.164) -> "+61 4xx xxx xxx"; anything else is shown as given. */
export function formatAuNumber(n: string): string {
  const m = /^\+61(4\d{2})(\d{3})(\d{3})$/.exec(n);
  return m ? `+61 ${m[1]} ${m[2]} ${m[3]}` : n;
}
const NOT_REACHING = "Calls aren't reaching MU-Receptionist: no call records, QA or handoff alerts";
/**
 * Webhook health from the agent's ACTUAL webhook_url and an unsigned probe of it: a healthy
 * MU-Receptionist is reachable and rejects the unsigned request ("reachable and protected").
 */
export function webhookHealth(agent: Source<AgentFacts>): HealthItem {
  const base = { id: "webhook" as const, label: "Webhook" };
  if (!agent.ok) return { ...base, tone: "neutral", headline: "Webhook unknown", detail: NOT_REACHING };
  if (!agent.webhook)
    return {
      ...base,
      tone: "bad",
      headline: "Webhook not connected",
      detail: NOT_REACHING,
      next: "Point the Retell agent webhook at MU-Receptionist /api/retell/webhook (deploy it first)",
    };
  const host = agent.webhookHost ?? "webhook";
  switch (agent.webhookProbe) {
    case "protected":
      return { ...base, tone: "ok", headline: "Webhook connected", detail: `${host} · reachable and protected (unsigned probe rejected)` };
    case "open":
      return {
        ...base,
        tone: "bad",
        headline: "Webhook accepts unsigned requests",
        detail: `${host} answered 2xx to an unsigned probe`,
        next: "Set RETELL_WEBHOOK_SECRET on MU-Receptionist so unsigned posts are rejected",
      };
    case "unconfigured":
      return {
        ...base,
        tone: "bad",
        headline: "Webhook signing not configured",
        detail: `${host} refuses every call (503): no signing secret`,
        next: "Set RETELL_WEBHOOK_SECRET on the MU-Receptionist deployment",
      };
    case "unreachable":
      return {
        ...base,
        tone: "bad",
        headline: "Webhook unreachable",
        detail: `${host} did not answer the probe`,
        next: "Check the MU-Receptionist deployment and the agent's webhook URL",
      };
    default:
      // Configured but never probed: unknown, never green (UI-truth L4).
      return {
        ...base,
        tone: "neutral",
        headline: "Webhook unverified",
        detail: `${host} is set on the agent · not probed, delivery unknown`,
        next: "Refresh to probe the webhook",
      };
  }
}
/** Flags that mean a caller may be relying on something that won't happen. */
const INCIDENT_FLAGS: FlagCode[] = ["FALSE_BOOKING", "SMS_PROMISE", "URGENT_NO_000", "CLINICAL_ADVICE", "DANGER_LANGUAGE", "LEGAL_URGENT", "URGENT_NO_HUMAN_ROUTE"];
const CONSEQUENCE: Partial<Record<FlagCode, string>> = {
  FALSE_BOOKING: "may expect a booking that wasn't made",
  SMS_PROMISE: "may expect a text that won't come",
  URGENT_NO_000: "raised an urgent symptom and wasn't given 000 advice",
  CLINICAL_ADVICE: "may have heard medication advice",
  DANGER_LANGUAGE: "used danger language requiring critical human review",
  LEGAL_URGENT: "raised a legal urgency requiring prompt human review",
  URGENT_NO_HUMAN_ROUTE: "raised a legal urgency without being offered a human route",
};
export function consequenceOf(flags: FlagCode[], qaCodes: readonly string[] = []): string {
  const parts = [...INCIDENT_FLAGS.filter((f) => flags.includes(f)).map((f) => CONSEQUENCE[f]!), ...qaConsequenceParts(qaCodes)]
    .filter((p, n, all) => all.indexOf(p) === n);
  if (!parts.length) return qaCodes.length ? "Production QA flagged this call for review." : "Caller was flagged.";
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Caller ${joined}.`;
}

/** Recorded retests that clear a followed-up call: owner-attributed, clean, after the call. */
export const RETEST_TARGET = 5;
const SAME_CALL_MS = 2 * 60_000;
export const sydneyDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
/** "26 Sep, 3:04 pm" in Sydney — for "last generated at" facts in the health strip. */
export const sydneyStamp = (iso: string) => {
  const d = new Date(iso);
  return `${sydneyShort(iso)}, ${new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(d)
    .replace(/\s/g, " ")}`;
};
const median = (ns: (number | null)[]) => {
  const n = ns.filter((n): n is number => n !== null).sort((a, b) => a - b);
  return n.length ? (n[Math.floor((n.length - 1) / 2)] + n[Math.floor(n.length / 2)]) / 2 : null;
};
function window(rows: CallRow[], label: CallWindow["label"], fx: number | null): CallWindow {
  const durations = rows
    .flatMap((c) => (c.durationSec === null ? [] : [c.durationSec]))
    .sort((a, b) => a - b);
  const answered = rows.filter(
    (c) => (c.durationSec ?? 0) > 0 && !["error", "not_connected"].includes(c.status),
  );
  const minutes = answered.reduce((s, c) => s + c.durationSec! / 60, 0);
  const analysed = rows.filter((c) => c.successful !== null);
  const usdCents = rows.reduce((s, c) => s + (c.usdCents ?? 0), 0);
  const aud = fx === null ? null : (usdCents / 100) * fx;
  const reasons = new Map<string, number>();
  for (const c of rows)
    if (c.disconnectReason)
      reasons.set(c.disconnectReason, (reasons.get(c.disconnectReason) ?? 0) + 1);
  return {
    label,
    count: rows.length,
    answered: answered.length,
    avgDurationSec: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    p90DurationSec: durations.length ? durations[Math.ceil(durations.length * 0.9) - 1] : null,
    latencyP50Ms: median(rows.map((c) => c.latencyP50Ms)),
    latencyP90Ms: median(rows.map((c) => c.latencyP90Ms)),
    successRate: analysed.length
      ? analysed.filter((c) => c.successful).length / analysed.length
      : null,
    usdCents,
    aud,
    audPerMinute: aud !== null && minutes > 0 ? aud / minutes : null,
    minutes,
    disconnectReasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    flaggedCalls: rows.filter((c) => c.flags.length).length,
  };
}
// Explicit projection is intentional: an extra provider field can never spread into the public API.
function publicCall(c: CallRow): CallRow {
  return {
    id: c.id,
    kind: c.kind,
    startedAt: c.startedAt,
    durationSec: c.durationSec,
    from: c.kind === "web" || !c.from ? null : `••• ${c.from.replace(/\D/g, "").slice(-3)}`,
    status: c.status,
    disconnectReason: c.disconnectReason,
    latencyP50Ms: c.latencyP50Ms,
    latencyP90Ms: c.latencyP90Ms,
    usdCents: c.usdCents,
    summary: c.summary,
    summarySource: c.summarySource,
    sentiment: c.sentiment,
    successful: c.successful,
    flags: [...c.flags],
    checked: c.checked,
    retellUrl: c.retellUrl,
  };
}
export function buildReceptionistSnapshot(
  i: SnapshotInputs,
  now: number | Date,
): ReceptionistSnapshot {
  const ms = Number(now),
    today = sydneyDay(ms),
    fx = i.fx?.usdToAud ?? null;
  const rows = i.calls.ok
    ? i.calls.rows
        .map(publicCall)
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    : [];
  const onDay = (c: CallRow) => (c.startedAt ? sydneyDay(Date.parse(c.startedAt)) : "");
  const todayRows = rows.filter((c) => onDay(c) === today);
  let calls: CallsBlock = i.calls.ok
    ? {
        ok: true,
        windows: [
          window(todayRows, "Today", fx),
          window(
            rows.filter(
              (c) =>
                c.startedAt &&
                Date.parse(c.startedAt) >= ms - 7 * 86400_000 &&
                Date.parse(c.startedAt) <= ms,
            ),
            "7 days",
            fx,
          ),
          window(rows, "All time", fx),
        ],
        recent: rows.slice(0, 25),
        flagTotals: {},
        latencyTrend: [],
      }
    : { ok: false, reason: i.calls.reason };
  if (calls.ok) {
    for (const c of rows)
      for (const f of c.flags) calls.flagTotals[f] = (calls.flagTotals[f] ?? 0) + 1;
    for (const day of [...new Set(rows.map(onDay).filter(Boolean))].sort().slice(-14)) {
      const daily = rows.filter((c) => onDay(c) === day),
        p50 = median(daily.map((c) => c.latencyP50Ms)),
        p90 = median(daily.map((c) => c.latencyP90Ms));
      if (p50 !== null && p90 !== null)
        calls.latencyTrend.push({ day, p50Ms: p50, p90Ms: p90, calls: daily.length });
    }
  }
  const retellUrl = `https://dashboard.retellai.com/agents/${encodeURIComponent(i.agentId)}`;
  const formattedNumber = formatAuNumber(i.number);
  const health: HealthItem[] = [
    {
      id: "agent",
      label: "Agent",
      // Unpublished is not down: Retell routes the number to draft versions too (26 Sep: v0 draft
      // answered a real call). It's a sell-blocker, shown as warn, never as an outage.
      tone: !i.agent.ok ? "warn" : i.agent.published ? "ok" : "warn",
      headline: i.agent.ok
        ? `${i.agent.model} · ${i.agent.voice} · ${i.agent.language}`
        : i.agent.reason,
      detail: i.agent.ok
        ? i.agent.published
          ? `Published v${i.agent.version ?? "?"}`
          : `Draft v${i.agent.version ?? "?"} · not published`
        : "Status unknown",
      href: retellUrl,
      ...(i.agent.ok ? { asOf: i.agent.modified } : {}),
      ...(!i.agent.ok
        ? { next: "Check the Retell agent" }
        : !i.agent.published
          ? { next: "Publish a version before selling" }
          : {}),
    },
    {
      id: "number",
      label: "Number",
      tone: !i.numberFacts.ok ? "warn" : i.numberFacts.attached ? "ok" : "bad",
      headline: i.numberFacts.ok
        ? i.numberFacts.attached
          ? `${formattedNumber} → v${i.numberFacts.version ?? "?"}`
          : "Number not attached to agent"
        : i.numberFacts.reason,
      detail: "Retell inbound routing",
      ...(!i.numberFacts.ok || !i.numberFacts.attached
        ? { next: "Connect the number to the agent" }
        : {}),
    },
    {
      id: "twilio",
      label: "Twilio",
      tone: !i.twilio.ok
        ? "warn"
        : !i.twilio.connected
          ? "bad"
          : i.twilio.balanceUsd !== null && i.twilio.balanceUsd < 5
            ? "warn"
            : "ok",
      headline: i.twilio.ok
        ? i.twilio.connected
          ? "Trunk → sip.retellai.com · number attached"
          : "Trunk routing incomplete"
        : i.twilio.reason,
      detail:
        i.twilio.ok && i.twilio.balanceUsd !== null
          ? `Balance US$${i.twilio.balanceUsd.toFixed(2)}${i.twilio.balanceUsd < 5 ? " · low balance" : ""}`
          : "Balance unavailable",
      ...(i.twilio.ok && i.twilio.trunkSid
        ? {
            href: `https://console.twilio.com/us1/develop/sip-trunking/trunks/${encodeURIComponent(i.twilio.trunkSid)}`,
          }
        : {}),
      ...(!i.twilio.ok || !i.twilio.connected ? { next: "Check Twilio routing" } : {}),
    },
    webhookHealth(i.agent),
    {
      id: "evals",
      label: "Evals",
      tone: i.evals.ok ? (i.evals.passed === i.evals.total ? "ok" : "bad") : "warn",
      headline: i.evals.ok
        ? `${i.evals.passed}/${i.evals.total} passed · ${i.evals.reports} reports`
        : i.evals.reason,
      detail: "MU-Receptionist scenario checks",
      ...(i.evals.ok ? { asOf: i.evals.date } : {}),
      ...(!i.evals.ok || i.evals.passed !== i.evals.total
        ? { next: "Run `npm run evals` in MU-Receptionist" }
        : {}),
    },
    {
      // The production feed is information, not the answering path: an unavailable feed is
      // warn (with a reason), never bad — it must not flip the sell verdict by itself.
      id: "feed",
      label: "Agency feed",
      tone: i.agencyFeed.ok ? "ok" : "warn",
      headline: i.agencyFeed.ok
        ? `Feed connected · generated ${sydneyStamp(i.agencyFeed.generatedAt)}`
        : "Feed unavailable",
      detail: i.agencyFeed.ok
        ? "Production calls, QA flags and triage"
        : i.agencyFeed.reason,
      ...(i.agencyFeed.ok ? { asOf: i.agencyFeed.generatedAt } : {}),
      ...(!i.agencyFeed.ok
        ? { next: "Check AGENCY_FEED_URL and AGENCY_FEED_TOKEN in ~/.config/agentic-os.env" }
        : {}),
    },
  ];
  const offer = catalogueOffer();
  const econ = economics(rows, fx, offer),
    twilioMonth = i.twilio.ok ? i.twilio.month : i.twilio;
  const readiness = buildReadiness({
    calls: i.calls,
    agent: i.agent,
    sms: i.numberFacts.ok ? i.numberFacts.sms : null,
    legal: i.legal,
    signoffs: i.signoffs,
    economics: econ,
    twilioMonth,
    line: formattedNumber,
  });
  // ── Verdict: sell / don't sell, decided before any plumbing detail ──────────────────────────
  const down = health.find((h) => ["agent", "number", "twilio"].includes(h.id) && h.tone === "bad");
  const reachable = i.agent.ok && i.numberFacts.ok && i.twilio.ok;
  const answering = reachable && !down;

  const followedUp = i.followedUp ?? {};
  const retellCallUrl = (id: string) => `https://dashboard.retellai.com/call-history?history=${encodeURIComponent(id)}`;
  const recentFlagged = rows.filter(
    (c) =>
      qualifying(c) &&
      !!c.startedAt &&
      ms - Date.parse(c.startedAt) <= 14 * 86400_000 &&
      c.flags.some((f) => INCIDENT_FLAGS.includes(f)),
  );
  // One entry per call: local flags first, then every open production-QA flag merged in by the
  // Retell call id the feed exposes (else the same masked caller within 2 minutes). UI-truth H4.
  const byCall = new Map<string, Incident>();
  for (const c of recentFlagged) {
    const f = followedUp[c.id];
    byCall.set(c.id, {
      callId: c.id,
      startedAt: c.startedAt,
      from: c.from,
      flags: c.flags.filter((x) => INCIDENT_FLAGS.includes(x)),
      consequence: consequenceOf(c.flags),
      retellUrl: c.retellUrl,
      sources: ["retell"],
      ...(f ? { followedUp: { by: f.by, at: f.at } } : {}),
    });
  }
  const feed = i.agencyFeed;
  const clientName = (orgId: string | null): string | null => {
    if (!feed.ok || !orgId) return null;
    const client = feed.clients.find((c) => c.organizationId === orgId);
    if (!client) return null;
    return feed.organizations.find((o) => o.id === orgId)?.name ?? client.slug ?? orgId;
  };
  const qaOpen = new Set<string>();
  if (feed.ok)
    for (const fc of feed.calls) {
      const qa = fc.qa;
      if (!qa || !(qa.flagCodes.length || (qa.flagCount ?? 0) > 0) || !isOpenReview(qa.reviewStatus)) continue;
      const local =
        (fc.providerCallId ? rows.find((c) => c.id === fc.providerCallId) : undefined) ??
        rows.find(
          (c) =>
            !!fc.callerMasked && c.from === fc.callerMasked && !!c.startedAt && !!fc.startedAt &&
            Math.abs(Date.parse(c.startedAt) - Date.parse(fc.startedAt)) <= SAME_CALL_MS,
        );
      const key = local?.id ?? fc.providerCallId ?? `feed:${fc.id}`;
      const entry: Incident = byCall.get(key) ?? {
        callId: key,
        startedAt: local?.startedAt ?? fc.startedAt,
        from: local?.from ?? fc.callerMasked,
        flags: [],
        consequence: "",
        retellUrl: local?.retellUrl ?? (fc.providerCallId ? retellCallUrl(fc.providerCallId) : ""),
        sources: [],
      };
      const sources = entry.sources ?? [];
      entry.qaCodes = [...new Set([...(entry.qaCodes ?? []), ...qa.flagCodes])];
      entry.qaReview = qa.reviewStatus;
      entry.qaCritical = (entry.qaCritical ?? false) || isCriticalBand(qa.topBand);
      entry.client = clientName(fc.organizationId);
      entry.sources = sources.includes("production QA") ? sources : [...sources, "production QA"];
      entry.consequence = consequenceOf(entry.flags, entry.qaCodes);
      byCall.set(key, entry);
      qaOpen.add(key);
    }
  // Review R2 `qaFlags`: every open QA flag across every organisation, present in the metadata view
  // too (where calls[] is empty). Merged by the provider call id, so a call is still one entry.
  if (feed.ok && feed.qaFlags)
    for (const f of feed.qaFlags) {
      const local = rows.find((c) => c.id === f.callId);
      const key = local?.id ?? f.callId;
      const existing = byCall.get(key);
      const entry: Incident = existing ?? {
        callId: key,
        startedAt: local?.startedAt ?? f.at,
        from: local?.from ?? null,
        flags: [],
        consequence: "",
        retellUrl: local?.retellUrl ?? retellCallUrl(f.callId),
        sources: [],
      };
      const sources = entry.sources ?? [];
      entry.qaCodes = [...new Set([...(entry.qaCodes ?? []), ...f.codes])];
      entry.qaReview = entry.qaReview ?? "PENDING";
      entry.qaCritical = (entry.qaCritical ?? false) || isCriticalFlag(f);
      if (entry.client === undefined || entry.client === null) entry.client = clientName(f.orgId);
      entry.sources = sources.includes("production QA") ? sources : [...sources, "production QA"];
      entry.consequence = consequenceOf(entry.flags, entry.qaCodes);
      byCall.set(key, entry);
      qaOpen.add(key);
    }
  const newestFirst = (a: Incident, b: Incident) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  // Open: local flags not followed up, or a production-QA review still open (a local follow-up
  // can't close MU-Receptionist's review).
  const incidents: Incident[] = [...byCall.values()].filter((x) => !x.followedUp || qaOpen.has(x.callId)).sort(newestFirst);
  // "Mark followed up" records the follow-up; the call still blocks selling until RETEST_TARGET
  // owner-attributed, clean, qualifying calls were made after it (UI-truth H5).
  // The raw rows: owner attribution (ownerTestBy) is not part of the public call projection.
  const rawRows = i.calls.ok ? i.calls.rows : [];
  const retested = (x: Incident) =>
    rawRows.filter(
      (c) =>
        qualifying(c) && !!c.ownerTestBy?.trim() && !!c.startedAt && !!x.startedAt &&
        Date.parse(c.startedAt) > Date.parse(x.startedAt) &&
        !c.flags.some((f) => INCIDENT_FLAGS.includes(f)),
    ).length >= RETEST_TARGET;
  const notRetested = [...byCall.values()].filter((x) => x.followedUp && !retested(x));
  const awaitingRetest = notRetested.filter((x) => !incidents.includes(x)).sort(newestFirst);

  const passed = readiness.blockers.filter((b) => b.state === "pass").length;
  const failing = readiness.blockers.filter((b) => b.state === "fail");
  const realToday = todayRows.filter((c) => c.kind === "phone");
  // "Flagged" means one thing on this page (audit RX-12): an open flagged call to follow up (the
  // incidents list). Today's count is the subset of those incidents from today's real calls.
  const todayIds = new Set(realToday.map((c) => c.id));
  const flaggedToday = incidents.filter((x) => todayIds.has(x.callId)).length;

  const agentFact = !i.agent.ok
    ? `Retell unreachable: ${i.agent.reason}`
    : down
      ? `Not answering: ${down.label.toLowerCase()} ${down.headline.toLowerCase()}`
      : i.agent.published
        ? `Answering on published ${i.agent.version != null ? `v${i.agent.version}` : "agent"}`
        : `Answering on unpublished draft${i.agent.version != null ? ` v${i.agent.version}` : ""}`;
  const callsFact = !calls.ok
    ? null
    : realToday.length
      ? `${plural(realToday.length, "real call")} today · ${flaggedToday ? `${flaggedToday} flagged` : "none flagged"}`
      : "No real calls today";
  const gatesFact = `${passed} of 5 gates passed${failing.length ? ` · ${failing.length} failing` : ""}`;
  const incidentFact = incidents.length
    ? incidents.some((x) => x.flags.includes("FALSE_BOOKING") || x.flags.includes("SMS_PROMISE"))
      ? `${plural(incidents.length, "caller")} may be expecting a booking or text`
      : `${plural(incidents.length, "flagged call")} to follow up`
    : null;
  const facts = [agentFact, callsFact, gatesFact, incidentFact].filter((f): f is string => !!f).slice(0, 4);

  const webhookBad = health.find((h) => h.id === "webhook")?.tone === "bad";
  const firstOpen =
    failing[0] ??
    readiness.blockers.find((b) => b.state === "not-tested") ??
    readiness.blockers.find((b) => b.state === "unknown") ??
    readiness.blockers.find((b) => b.state === "open");
  const next = incidents.length
    ? incidents.length === 1
      ? `Follow up the flagged ${incidents[0].startedAt ? sydneyShort(incidents[0].startedAt) : ""} call`.replace("  ", " ")
      : `Follow up ${incidents.length} flagged calls`
    : down?.next
      ? down.next
      : webhookBad
        ? "Connect the webhook so calls reach MU-Receptionist"
        : firstOpen
          ? firstOpen.next
          : i.agent.ok && !i.agent.published
            ? "Publish a version before selling"
            : "";

  const unknown = !i.agent.ok;
  // The answering path only; evals and the feed have their own checks below.
  const badHealth = health.filter((h) => ["agent", "number", "twilio", "webhook"].includes(h.id) && h.tone === "bad");
  const webhook = health.find((h) => h.id === "webhook")!;
  const checks: SellCheck[] = [
    {
      // A webhook that was never probed is unknown, and unknown is not a pass (L4).
      id: "answering",
      label: "Answering on a published agent, webhook verified",
      ok: !unknown && answering && !badHealth.length && webhook.tone === "ok" && i.agent.ok && i.agent.published,
      detail: badHealth.length ? badHealth.map((h) => h.headline).join("; ") : webhook.tone !== "ok" ? `${agentFact} · ${webhook.headline}` : agentFact,
    },
    {
      // A failed calls read is unknown, never "none open" (merge review U3).
      id: "flagged-calls",
      label: "No flagged calls open",
      ok: i.calls.ok && !incidents.length,
      ...(!i.calls.ok && !incidents.length ? { unknown: true } : {}),
      detail: incidents.length
        ? `${plural(incidents.length, "flagged call")} to follow up${i.calls.ok ? "" : " · Retell calls couldn't be read, so there may be more"}`
        : i.calls.ok
          ? "None open"
          : `Unknown · couldn't read calls (${i.calls.reason})`,
    },
    ...sellGateChecks({ feed: i.agencyFeed, evals: i.evals, blockers: readiness.blockers, awaitingRetest: notRetested.length, checklist: i.checklist, calls: i.calls }),
  ];
  // Informational lines (the owner-console checklist) are shown but never decide the verdict.
  const safe = !unknown && checks.every((c) => c.ok || c.informational);
  const firstFailing = checks.find((c) => !c.ok && !c.informational);
  const nextStep =
    next ||
    (firstFailing?.id === "retests"
      ? `Make ${RETEST_TARGET} owner retest calls after the followed-up call`
      : firstFailing?.id === "go-live-verdict"
        ? "Record passing go-live tests in MU-Receptionist (its goLive verdict must read safe)"
        : firstFailing?.id === "feed-qa"
          ? "Review the open critical QA flags in MU-Receptionist"
          : firstFailing?.id === "checklist"
            ? "Work through the go-live checklist"
            : firstFailing?.id === "evals"
              ? "Run `npm run evals` in MU-Receptionist"
              : "");
  const verdict: Verdict = {
    decision: unknown ? "Status unknown" : safe ? "Safe to sell" : "Not safe to sell",
    tone: unknown ? "neutral" : safe ? "ok" : incidents.length || failing.length || down || notRetested.length ? "bad" : "warn",
    facts,
    next: nextStep,
    checks,
  };
  const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
  let sentence = [verdict.decision, ...facts.slice(0, 2)].join(" · ") + (nextStep ? ` — next: ${lower(nextStep)}.` : ".");
  if (sentence.length > 160) sentence = [verdict.decision, ...facts.slice(0, 2)].join(" · ") + ".";
  if (sentence.length > 160) sentence = `${verdict.decision}.`;
  return {
    generatedAt: new Date(ms).toISOString(),
    sentence,
    tone: verdict.tone,
    verdict,
    incidents,
    awaitingRetest,
    agent: { id: i.agentId, name: i.agent.ok ? i.agent.name : null, number: i.number, retellUrl, lineSource: i.lineSource ?? "options" },
    health,
    calls,
    feed: i.agencyFeed,
    ...(i.agencyFeedRead
      ? { feedRead: { at: i.agencyFeedRead.readAt === null ? null : new Date(i.agencyFeedRead.readAt).toISOString(), lastOkAt: i.agencyFeedRead.lastOkAt === null ? null : new Date(i.agencyFeedRead.lastOkAt).toISOString() } }
      : {}),
    readiness,
    commercial: { leads: i.leads, pilots: [], offer, economics: econ },
    fx: i.fx ? { usdToAud: i.fx.usdToAud, asOf: i.fx.asOf, source: i.fx.source } : null,
    spend: {
      retellMonthUsdCents: calls.ok
        ? rows
            .filter((c) => onDay(c).slice(0, 7) === today.slice(0, 7))
            .reduce((s, c) => s + (c.usdCents ?? 0), 0)
        : null,
      twilioMonthUsd: twilioMonth,
    },
  };
}

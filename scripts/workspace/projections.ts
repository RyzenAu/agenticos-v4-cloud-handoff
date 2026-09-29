// Workspace projections: raw responses from the existing APIs → the small, metadata-only shapes
// the Workspace page shows. Every output object is built field by field (never spread), so a
// transcript, a call summary, an email body or snippet, a full phone number or a sender address
// in the input can't reach the page. scripts/workspace/workspace.test.ts proves it with sentinels.
import type { BoardLead } from "../../src/lib/leads";
import { selectCallQueue, sydneyDay } from "../../src/lib/call-queue";

type Any = Record<string, any>;
const str = (v: unknown, max = 160): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const EMAIL = /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i;

/** "+61 400 123 208" / "••• 208" → "••• 208". Anything without 3 digits → null. */
export function maskPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 3 ? `••• ${digits.slice(-3)}` : null;
}

/** Masks any phone-like run inside a free-text line (health headlines can name the agent's number). */
export const scrubPhones = (v: string | null): string | null =>
  v === null ? null : v.replace(/(?:\+\d|\b0)[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? maskPhone(m) ?? "•••" : m));

/** Flag/QA codes only: SHOUTY_SNAKE identifiers. Free text is dropped. */
const code = (v: unknown): string | null => (typeof v === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(v) ? v : null);
const codes = (v: unknown): string[] => arr(v).map(code).filter((c): c is string => !!c);

/** Life-safety / urgency codes: the receptionist's DANGER_LANGUAGE, LEGAL_URGENT, URGENT_* and the
 *  production QA engine's LIFE_SAFETY / URGENT_CALL / EMERGENCY style codes. */
export const URGENT_CODE = /DANGER|LIFE_?SAFETY|URGENT|EMERGENCY/;

// ── Receptionist ────────────────────────────────────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "bad" | "neutral";
const tone = (v: unknown): Tone => (v === "ok" || v === "warn" || v === "bad" ? v : "neutral");

export type CallWindowSummary = { count: number | null; answered: number | null; flagged: number | null; minutes: number | null; audPerMinute: number | null };
export type UrgentAlert = { id: string; source: "call" | "production QA"; codes: string[]; startedAt: string | null; from: string | null };

export type ReceptionistPanel = {
  generatedAt: string | null;
  verdict: { decision: string; tone: Tone; facts: string[]; next: string | null };
  gates: { id: string; title: string; state: string; note: string | null }[];
  gatesPassed: number;
  cleanStreak: { count: number; target: number } | null;
  ownerRetestCalls: { count: number; target: number } | null;
  calls: { ok: true; today: CallWindowSummary; week: CallWindowSummary } | { ok: false; reason: string };
  incidents: { callId: string; startedAt: string | null; from: string | null; flags: string[] }[];
  feed:
    | { ok: true; generatedAt: string | null; qaFlagged: number | null; qaCriticalOpen: number | null; triagePending: number | null; flaggedCalls: { id: string; startedAt: string | null; from: string | null; codes: string[]; band: string | null; review: string | null }[] }
    | { ok: false; reason: string };
  health: { id: string; label: string; tone: Tone; headline: string | null; asOf: string | null }[];
  cost: { audPerMinute: number | null; measuredCalls: number | null; measuredMinutes: number | null; caveat: string | null };
  urgent: UrgentAlert[];
};

const SAME_CALL_MS = 2 * 60_000;
/**
 * One alert per call (audit A-L1): a production-QA flag on a call that is already a local
 * incident merges into it instead of counting twice. Matched on the Retell call id the feed
 * exposes (providerCallId); when the feed has none, on the same masked caller within 2 minutes.
 */
function urgentAlerts(
  incidents: { callId: string; startedAt: string | null; from: string | null; flags: string[] }[],
  flagged: { id: string; startedAt: string | null; from: string | null; codes: string[] }[],
  providerIds: (string | null)[],
): UrgentAlert[] {
  // An urgent call carries ALL its codes (urgent first), not only the urgent ones: a transfer
  // promised and never attempted on an urgent call must not be hidden (UI-truth H4).
  const urgentFirst = (cs: string[]) => [...cs.filter((f) => URGENT_CODE.test(f)), ...cs.filter((f) => !URGENT_CODE.test(f))];
  const calls: UrgentAlert[] = incidents
    .filter((i) => i.flags.some((f) => URGENT_CODE.test(f)))
    .map((i) => ({ id: `call:${i.callId}`, source: "call" as const, codes: urgentFirst(i.flags), startedAt: i.startedAt, from: i.from }));
  const byCallId = new Map(calls.map((a) => [a.id.slice("call:".length), a]));
  const near = (a: UrgentAlert, from: string | null, at: string | null) =>
    !!from && a.from === from && !!a.startedAt && !!at && Math.abs(Date.parse(a.startedAt) - Date.parse(at)) <= SAME_CALL_MS;
  const feed: UrgentAlert[] = [];
  flagged.forEach((c, index) => {
    const providerId = providerIds[index];
    const same = providerId ? byCallId.get(providerId) : calls.find((a) => near(a, c.from, c.startedAt));
    if (same) { same.codes = urgentFirst([...new Set([...same.codes, ...c.codes])]); return; }
    if (!c.codes.some((f) => URGENT_CODE.test(f))) return;
    feed.push({ id: `feed:${c.id}`, source: "production QA" as const, codes: urgentFirst(c.codes), startedAt: c.startedAt, from: c.from });
  });
  return [...calls, ...feed];
}

function windowSummary(w: Any | undefined): CallWindowSummary {
  return { count: num(w?.count), answered: num(w?.answered), flagged: num(w?.flaggedCalls), minutes: num(w?.minutes), audPerMinute: num(w?.audPerMinute) };
}

export function projectReceptionist(s: Any): ReceptionistPanel {
  const readiness = s?.readiness ?? {};
  const gates = arr(readiness.blockers).map((b: Any) => ({ id: str(b?.id, 40) ?? "gate", title: str(b?.title, 120) ?? "Gate", state: str(b?.state, 20) ?? "open", note: str(b?.stateNote, 160) }));
  // One row per call: local flags plus every production-QA code the snapshot merged into it (H4).
  const incidents = arr(s?.incidents).slice(0, 20).map((i: Any) => ({ callId: str(i?.callId, 80) ?? "call", startedAt: iso(i?.startedAt), from: maskPhone(i?.from), flags: [...new Set([...codes(i?.flags), ...codes(i?.qaCodes)])] }));
  const feedOk = s?.feed?.ok === true;
  const feedFlagged = feedOk
    ? arr(s.feed.calls)
        .filter((c: Any) => c?.qa && (codes(c.qa.flagCodes).length || (num(c.qa.flagCount) ?? 0) > 0))
        .slice(0, 10)
    : [];
  const flaggedCalls = feedFlagged.map((c: Any) => ({ id: str(c?.id, 80) ?? "call", startedAt: iso(c?.startedAt), from: maskPhone(c?.callerMasked), codes: codes(c.qa.flagCodes), band: code(c.qa.topBand), review: code(c.qa.reviewStatus) }));
  const urgent = urgentAlerts(incidents, flaggedCalls, feedFlagged.map((c: Any) => str(c?.providerCallId, 120)));
  const econ = s?.commercial?.economics ?? {};
  const pair = (v: Any | null | undefined) => (v && num(v.count) !== null && num(v.target) !== null ? { count: v.count as number, target: v.target as number } : null);
  return {
    generatedAt: iso(s?.generatedAt),
    verdict: { decision: str(s?.verdict?.decision, 60) ?? "Status unknown", tone: tone(s?.verdict?.tone), facts: arr(s?.verdict?.facts).map((f) => scrubPhones(str(f, 120))).filter((f): f is string => !!f).slice(0, 4), next: str(s?.verdict?.next, 160) },
    gates,
    gatesPassed: gates.filter((g) => g.state === "pass").length,
    cleanStreak: pair(readiness.cleanStreak),
    ownerRetestCalls: pair(readiness.ownerRetestCalls),
    calls: s?.calls?.ok === true ? { ok: true, today: windowSummary(s.calls.windows?.[0]), week: windowSummary(s.calls.windows?.[1]) } : { ok: false, reason: str(s?.calls?.reason, 160) ?? "Calls unavailable" },
    incidents,
    feed: feedOk
      ? { ok: true, generatedAt: iso(s.feed.generatedAt), qaFlagged: num(s.feed.totals?.qaFlagged), qaCriticalOpen: num(s.feed.totals?.qaCriticalOpen), triagePending: num(s.feed.totals?.triagePending), flaggedCalls }
      : { ok: false, reason: str(s?.feed?.reason, 160) ?? "Production feed unavailable" },
    health: arr(s?.health).map((h: Any) => ({ id: str(h?.id, 20) ?? "item", label: str(h?.label, 40) ?? "Item", tone: tone(h?.tone), headline: scrubPhones(str(h?.headline, 120)), asOf: iso(h?.asOf) })),
    cost: { audPerMinute: num(econ.retellAudPerMinute), measuredCalls: num(econ.measuredCalls), measuredMinutes: num(econ.measuredMinutes), caveat: str(econ.caveat, 160) },
    urgent,
  };
}

// ── Email (inbox triage) ────────────────────────────────────────────────────────────────────────

const RANK: Record<string, number> = { ignore: 0, fyi: 1, today: 2, urgent: 3 };
export type EmailItem = { sender: string; subject: string; receivedAt: string | null; importance: string; category: string };
export type EmailPanel =
  | { connected: false; reason: string }
  | {
      connected: true;
      sources: { id: string; lastSync: string | null }[];
      window: { hours: number; total: number | null; urgent: number | null; today: number | null; fyi: number | null; ignore: number | null };
      /** When the triage log last recorded an email (not when this panel was read). */
      lastTriagedAt: string | null;
      /** The connected-mailbox list behind `sources`: when it was checked, a re-check running, its last failure. */
      mailboxes: { checkedAt: string | null; refreshing: boolean; error: string | null } | null;
      needsReplyCount: number;
      needsReply: EmailItem[];
    };

/** An email waiting on the owner: a client or lead reply, or one Jev reads as needing a reply. */
export function needsReply(r: Any): boolean {
  if (r?.importance === "ignore" || r?.category === "newsletter" || r?.category === "spam") return false;
  if (r?.category === "client" || r?.category === "lead-reply") return true;
  return (num(r?.jev?.needsReply) ?? 0) >= 0.5;
}

/** The thread a triage row belongs to: account + thread id (message id when the thread is unknown). */
export const threadKey = (r: Any): string => {
  const thread = str(r?.threadId, 200);
  return thread ? `${str(r?.account, 200) ?? ""}:${thread}` : `message:${str(r?.messageId, 200) ?? JSON.stringify(r?.receivedAt ?? null)}`;
};

/**
 * Emails waiting on the owner, ONE PER THREAD (UI-truth H1): a thread with three unanswered
 * messages is one email to answer. The thread's most important message represents it; the
 * result is ordered most important first, then oldest first.
 */
export function needsReplyThreads(rows: Any[]): Any[] {
  const ranked = rows.filter(needsReply).sort((a: Any, b: Any) => (RANK[b.importance] ?? 0) - (RANK[a.importance] ?? 0) || String(b.receivedAt).localeCompare(String(a.receivedAt)));
  const seen = new Set<string>();
  const threads = ranked.filter((r) => {
    const key = threadKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return threads.sort((a: Any, b: Any) => (RANK[b.importance] ?? 0) - (RANK[a.importance] ?? 0) || String(a.receivedAt).localeCompare(String(b.receivedAt)));
}

function sender(r: Any): string {
  const name = str(r?.senderName, 60);
  if (name && !EMAIL.test(name)) return name;
  return str(r?.senderDomain, 60) ?? "Unknown sender";
}

export function projectEmail(input: { triage: Any | null; accounts: Any | null; native: Any | null }): EmailPanel {
  const sources = [
    ...arr(input.accounts?.accounts).filter((a: Any) => a?.connected === true && ["google", "outlook"].includes(a?.id)).map((a: Any) => ({ id: String(a.id), lastSync: null })),
    ...arr(input.native?.providers).filter((p: Any) => p?.enabled === true && p?.available === true && ["gmail", "outlook"].includes(p?.id)).map((p: Any) => ({ id: String(p.id), lastSync: iso(p?.lastSync) })),
  ];
  if (!sources.length) return { connected: false, reason: "No mailbox is connected. Connect Gmail or Outlook on /inbox to see email here." };
  const t = input.triage ?? {};
  const rows = needsReplyThreads(arr(t.rows));
  return {
    connected: true,
    sources,
    window: { hours: num(t.digest?.hours) ?? 24, total: num(t.digest?.total), urgent: num(t.digest?.urgent), today: num(t.digest?.today), fyi: num(t.digest?.fyi), ignore: num(t.digest?.ignore) },
    lastTriagedAt: iso(t.counts?.lastLoggedAt),
    mailboxes: input.native?.discovery
      ? { checkedAt: iso(input.native.discovery.checkedAt), refreshing: input.native.discovery.refreshing === true, error: str(input.native.discovery.error, 160) }
      : null,
    needsReplyCount: rows.length,
    needsReply: rows.slice(0, 5).map((r: Any) => ({ sender: sender(r), subject: str(r?.subject, 120) ?? "(no subject)", receivedAt: iso(r?.receivedAt), importance: str(r?.importance, 10) ?? "fyi", category: str(r?.category, 20) ?? "unknown" })),
  };
}

// ── Call queue ──────────────────────────────────────────────────────────────────────────────────

export type QueueItem = { id: number; name: string; vertical: string | null; area: string | null; status: string; score: number | null; nextAt: string | null; nextAction: string | null; callback: boolean; overdue: boolean; phone: string | null };
/** crmLeads: how many leads the CRM holds at all (0 = empty or absent CRM: "0 to call" would be a guess). */
export type CallQueuePanel = { total: number; items: QueueItem[]; crmLeads?: number };

/** The /leads page's own queue (selectCallQueue: due today or overdue, callbacks first), top `n`. */
export function projectCallQueue(leads: BoardLead[], now: number, n = 8): CallQueuePanel {
  const queue = selectCallQueue(leads, now);
  const today = sydneyDay(now);
  return {
    total: queue.length,
    crmLeads: leads.length,
    items: queue.slice(0, n).map((l) => ({
      id: l.id,
      name: str(l.name, 80) ?? `Lead ${l.id}`,
      vertical: str(l.vertical, 20),
      area: str(l.area, 60),
      status: str(l.status, 20) ?? "new",
      score: num(l.score),
      nextAt: iso(l.nextAt),
      nextAction: str(l.deal?.nextAction, 120),
      callback: l.status === "call_back",
      overdue: !!l.nextAt && sydneyDay(l.nextAt) < today,
      phone: maskPhone(l.phone),
    })),
  };
}

// ── Leads & pipeline ────────────────────────────────────────────────────────────────────────────

export type PipelinePanel = {
  /** Open leads per sales stage (closed, excluded and merged leads left out when the source says which). */
  stages: { stage: string; count: number }[];
  /** Every record in the CRM, closed, excluded and merged ones included. Never label this "open". */
  total: number | null;
  /** Open leads: not closed or lost, not excluded, not merged into another record. Null when unknown. */
  open: number | null;
  /** Excluded (not merged) and merged-duplicate records, when the source reports them. */
  excluded: number | null;
  merged: number | null;
  /** Closed or lost (not excluded, not merged). */
  lost: number | null;
  closed: number | null;
  demosBooked: number | null;
  upcomingMeetings: { leadId: number; name: string; at: string }[];
  followUps: { overdue: number | null; dueToday: number | null };
  proposals: { count: number | null; valueCents: number | null };
  newLeads7d: number | null;
  /** Why newLeads7d is unknown, when it is. */
  newLeads7dNote: string | null;
  stuck: number | null;
  /** Last night's lead hunt (UI-truth M5): shown on Today when it failed, never hidden. Null when unknown. */
  hunt: { status: "ok" | "partial" | "failed" | "never"; problem: string | null; failingSince: string | null; ranAt: string | null; overdue: boolean } | null;
};

const HUNT_STATUS = ["ok", "partial", "failed", "never"] as const;
export function projectHunt(h: Any | null): PipelinePanel["hunt"] {
  if (!h || !HUNT_STATUS.includes(h.status)) return null;
  return { status: h.status, problem: scrubPhones(str(h.problem, 160)), failingSince: iso(h.failingSince), ranAt: iso(h.ranAt), overdue: h.overdue === true };
}

/** The sales stages after discovery, in pipeline order (lead-pipeline.ts STAGES from "contacted"). */
export const SALES_STAGES = ["contacted", "replied", "meeting", "proposal", "won", "building", "QA", "launched", "care plan"];

export function projectPipeline(input: { summary: Any | null; statusCounts: Any | null; overview: Any | null; hunt?: Any | null }): PipelinePanel {
  // openCounts (UI-truth H3) counts only open leads; an older server without it falls back to all.
  const counts = input.summary?.openCounts ?? input.summary?.counts ?? {};
  const o = input.overview ?? {};
  return {
    stages: SALES_STAGES.map((stage) => ({ stage, count: num(counts[stage]) ?? 0 })),
    total: num(input.summary?.total),
    open: num(input.summary?.open),
    excluded: num(input.summary?.excluded),
    merged: num(input.summary?.merged),
    lost: num(input.summary?.lost),
    closed: num(input.summary?.closed),
    demosBooked: input.statusCounts ? num(input.statusCounts.meeting) ?? 0 : null,
    upcomingMeetings: arr(o.upcoming)
      .filter((u: Any) => u?.kind === "meeting")
      .slice(0, 5)
      .map((u: Any) => ({ leadId: num(u.leadId) ?? 0, name: str(u.name, 80) ?? "Lead", at: iso(u.at) ?? "" })),
    followUps: { overdue: num(o.tiles?.followUps?.overdue), dueToday: num(o.tiles?.followUps?.dueToday) },
    proposals: { count: num(o.tiles?.proposals?.count), valueCents: num(o.tiles?.proposals?.valueCents) },
    newLeads7d: num(o.tiles?.newLeads?.count),
    newLeads7dNote: str(o.tiles?.newLeads?.note, 160),
    stuck: num(o.tiles?.stuck?.count),
    hunt: projectHunt(input.hunt ?? null),
  };
}

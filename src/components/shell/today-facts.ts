// Today's facts, each counted once and kept in one place (pure, so bun can test it).
//
// Where each fact lives on Today:
//   needs you             the "Waiting on you" tile: the server's ONE count (scripts/workspace/needs-you.ts),
//                         identical to the sidebar badge and the Jarvis HUD — decisions + email threads to
//                         answer + agent approvals, with the breakdown as its hint
//   approvals waiting     "Next actions" (the list), deduped by approval id
//   overdue calls         the "Calls to make" tile only, deduped by lead id
//   overdue follow-ups    the Pipeline section only (the pipeline's own count)
//   a source that failed  the tile or section that shows that source, with its recovery; the
//                         Inspector keeps the error detail (one entry per source key)
//   everything else that needs him (urgent flags, a site down, urgent email, enquiries past the
//                         reply window, warned sites, unreadable live gates) is the exception list,
//                         deduped by id
import type { Approval, CallQueuePanel, EmailPanel, NeedsYouPanel, PanelResult, PipelinePanel, ReceptionistPanel, SitesPanel, TodayPanel } from "@/components/workspace/api";
import { needsYouBadge, needsYouBreakdown } from "../../../scripts/workspace/needs-you";
import type { EnquiryPanel } from "@/lib/speed-to-lead";
import { panelSignalState, type Exception, type SignalState, type SignalTone } from "./page-parts";

export const PANEL_LABEL = { needsYou: "Needs you", today: "Approvals", callQueue: "Calls to make", receptionist: "Receptionist", websites: "Websites", email: "Email", pipeline: "Pipeline", enquiries: "Enquiries" } as const;
export type TodayKey = keyof typeof PANEL_LABEL;
/** Where each Today source reads from (shown on its tile with the last success). */
export const PANEL_SOURCE: Record<TodayKey, string> = {
  needsYou: "Workspace: approvals, email and agent asks",
  today: "Workspace: approvals",
  callQueue: "CRM call queue",
  receptionist: "Receptionist status (/__receptionist)",
  websites: "Site uptime checks",
  email: "Connected mailboxes",
  pipeline: "CRM pipeline",
  enquiries: "Website enquiry watcher",
};
export const TODAY_KEYS = Object.keys(PANEL_LABEL) as TodayKey[];

/** One panel query as Today sees it: the server result, or the request itself failing. */
export type SourceQuery<T> = { data?: PanelResult<T>; isError?: boolean; errorUpdatedAt?: number };
export type TodaySources = {
  needsYou?: SourceQuery<NeedsYouPanel>;
  today?: SourceQuery<TodayPanel>;
  callQueue?: SourceQuery<CallQueuePanel>;
  receptionist?: SourceQuery<ReceptionistPanel>;
  websites?: SourceQuery<SitesPanel>;
  email?: SourceQuery<EmailPanel>;
  pipeline?: SourceQuery<PipelinePanel>;
  enquiries?: SourceQuery<EnquiryPanel>;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** First item per stable key, order kept. Pure. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function valueOf<T>(q: SourceQuery<T> | undefined): T | null {
  return q?.data && q.data.ok ? q.data.data : null;
}

/** Failed = the server said the source failed, or the request itself errored. */
export function sourceFailed(q: SourceQuery<unknown> | undefined): boolean {
  return Boolean(q && ((q.data && !q.data.ok) || (!q.data && q.isError)));
}

/**
 * A tile's state from its source, strongest first: failed > unknown > stale > zero > ok.
 * `undefined` while nothing has answered yet (the tile shows its loading or empty form).
 */
export function tileState(q: SourceQuery<unknown> | undefined, now: number, opts: { zero?: boolean; unknown?: boolean } = {}): SignalState | undefined {
  const base = q?.data ? panelSignalState(q.data, now) : q?.isError ? "failed" : undefined;
  if (!base || base === "failed") return base;
  if (opts.unknown) return "unknown";
  // The latest refresh itself failed (server down or not answering): the figures are the last read,
  // not current, even while that read is under 15 minutes old (Track 8).
  if (base === "stale" || q?.isError) return "stale";
  return opts.zero ? "zero" : "ok";
}

/** When the tile's source last answered (or last failed), for the tile's "Updated …" line. */
export function sourceUpdatedAt(q: SourceQuery<unknown> | undefined): string | number | null {
  if (q?.data) return q.data.updatedAt;
  return q?.isError && q.errorUpdatedAt ? q.errorUpdatedAt : null;
}

export type TodayFacts = {
  /** Pending approvals, one per approval id. */
  approvals: Approval[];
  /** Overdue calls in the queue, one per lead id. */
  overdueCallIds: number[];
  /** The queue lists only its top items: the overdue count is then a lower bound. */
  overdueCallsAtLeast: boolean;
  /** Things that need him, one per id. Never a source failure or an overdue call (those have homes). */
  exceptions: Exception[];
  /** Sources that failed, in panel order. */
  failed: TodayKey[];
};

export function todayFacts(src: TodaySources): TodayFacts {
  const today = valueOf(src.today);
  const calls = valueOf(src.callQueue);
  const rx = valueOf(src.receptionist);
  const sites = valueOf(src.websites);
  const email = valueOf(src.email);
  const enquiries = valueOf(src.enquiries);

  const approvals = uniqueBy(today?.approvals ?? [], (a) => a.id);
  const queue = calls ? uniqueBy(calls.items, (i) => i.id) : [];
  const overdueCallIds = queue.filter((i) => i.overdue).map((i) => i.id);
  // The panel lists only the queue's top items; when it holds more, the overdue count is a floor.
  const overdueCallsAtLeast = Boolean(calls && calls.total > calls.items.length);

  const exceptions: Exception[] = [];
  const urgent = rx ? uniqueBy(rx.urgent, (u) => u.id) : [];
  if (urgent.length) exceptions.push({ id: "urgent", tone: "danger", text: `${plural(urgent.length, "urgent flag")} on receptionist calls`, to: "/receptionist", action: "Review" });
  // Every flagged call (any Retell or production-QA code, one per call), not only urgent ones (UI-truth H4).
  else if (rx && rx.incidents.length) exceptions.push({ id: "urgent", tone: "warn", text: `${plural(uniqueBy(rx.incidents, (i) => i.callId).length, "flagged receptionist call")} to follow up`, to: "/receptionist", action: "Review" });
  const siteList = sites ? uniqueBy(sites.sites, (s) => s.id) : [];
  // An offline check is one "couldn't check" line, not every site "down" (REVIEW-T1 R2, B10).
  if (sitesCheckOffline(siteList)) exceptions.push({ id: "sites-offline", tone: "warn", text: `The site check couldn't reach any of the ${siteList.length} sites, so their status is unknown (this PC may be offline)`, to: "/websites" });
  else for (const s of siteList.filter((x) => x.tone === "bad")) exceptions.push({ id: `site-${s.id}`, tone: "danger", text: `${s.name} is down${s.status ? ` (HTTP ${s.status})` : ""}`, to: "/websites" });
  if (rx && rx.verdict.tone === "bad") exceptions.push({ id: "rx-verdict", tone: "warn", text: `Receptionist: ${rx.verdict.decision}`, to: "/receptionist" });
  if (email?.connected && (email.window.urgent ?? 0) > 0)
    exceptions.push({ id: "email-urgent", tone: "warn", text: `${plural(email.window.urgent!, "urgent email")} in the last ${email.window.hours} h`, to: "/inbox" });
  const enquiriesOverdue = enquiries?.overdueCount ?? 0;
  if (enquiriesOverdue > 0)
    exceptions.push({ id: "enquiries-overdue", tone: "danger", text: `${plural(enquiriesOverdue, "website enquiry", "website enquiries")} past the reply window`, to: "/business" });
  const warned = siteList.filter((s) => s.tone === "warn");
  if (warned.length) exceptions.push({ id: "sites-warn", tone: "warn", text: `${plural(warned.length, "site")} answering with a warning`, to: "/websites" });
  // The nightly lead hunt (UI-truth M5): a failing or overdue hunt is never hidden.
  const hunt = valueOf(src.pipeline)?.hunt;
  if (hunt && (hunt.status === "failed" || hunt.status === "partial" || hunt.overdue)) {
    const since = hunt.failingSince ? new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" }).format(new Date(hunt.failingSince)) : null;
    const what = hunt.status === "failed" ? "failing" : hunt.status === "partial" ? "partly failing" : "hasn't run in 36 h";
    exceptions.push({ id: "lead-hunt", tone: hunt.status === "failed" ? "danger" : "warn", text: `Lead hunt ${what}${since && hunt.status !== "ok" ? ` since ${since}` : ""}${hunt.problem ? `: ${hunt.problem}` : ""}`, to: "/leads" });
  }
  if (today?.derivedError) exceptions.push({ id: "derived", tone: "warn", text: `Live receptionist gates couldn't be read: ${today.derivedError}`, to: "/receptionist" });

  return {
    approvals,
    overdueCallIds,
    overdueCallsAtLeast,
    exceptions: uniqueBy(exceptions, (e) => e.id),
    failed: TODAY_KEYS.filter((k) => sourceFailed(src[k])),
  };
}

export type TileRecovery = { kind: "retry"; label: string } | { kind: "link"; label: string; to: string };
export type TileFact = {
  key: TodayKey;
  label: string;
  to: string;
  state: SignalState | undefined;
  value: string | number | null;
  tone?: SignalTone;
  hint?: string;
  updatedAt: string | number | null;
  /** Shown beside the tile when it isn't ok (SignalTile hides it for ok/zero). */
  recovery?: TileRecovery;
};

const ago = (iso: string, now: number) => {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

/**
 * The email tile's hint: what the number is, when the triage log last recorded an email (the
 * tile's "Updated" is when the panel was read, not when mail was triaged), and whether the figures
 * are being refreshed, stale, or come from a mailbox list whose re-check failed.
 */
export function emailHint(result: PanelResult<EmailPanel>, email: Extract<EmailPanel, { connected: true }>, now: number): string {
  const parts: string[] = [];
  if (result.ok && result.stale) parts.push("Last good read; refresh failed");
  else if (result.ok && result.refreshing) parts.push("Refreshing");
  parts.push(`Threads · ${email.window.total ?? "—"} emails in ${email.window.hours} h`);
  parts.push(email.lastTriagedAt ? `last email triaged ${ago(email.lastTriagedAt, now)}` : "nothing triaged yet");
  if (email.mailboxes?.error) parts.push("mailbox re-check failed");
  return parts.join(" · ");
}

/**
 * The uptime check couldn't reach ANY site: no HTTP answer from any of them (REVIEW-T1 R2, B10). That's the
 * check (or this PC's network) being offline, not every site being down, so the status is unknown. Pure.
 */
export function sitesCheckOffline(sites: readonly { ok: boolean; status: number | null }[]): boolean {
  return sites.length >= 2 && sites.every((s) => !s.ok && s.status === null);
}

function failedHint(q: SourceQuery<unknown> | undefined) {
  if (q?.data && !q.data.ok) return q.data.timedOut ? "Timed out. Error in the Inspector" : "Source failed. Error in the Inspector";
  return q?.isError ? "Request failed. Error in the Inspector" : undefined;
}

/** The five Today tiles. Every one carries its state and last update, so failed, unknown and stale never read as zero or success. */
export function todayTiles(src: TodaySources, facts: TodayFacts, now: number): TileFact[] {
  const calls = valueOf(src.callQueue);
  const rx = valueOf(src.receptionist);
  const sites = valueOf(src.websites);
  const email = valueOf(src.email);
  const retry: TileRecovery = { kind: "retry", label: "Retry" };

  const needsYou = valueOf(src.needsYou);
  const overdue = facts.overdueCallIds.length;
  const siteList = sites ? uniqueBy(sites.sites, (s) => s.id) : [];
  const up = siteList.filter((s) => s.ok).length;
  const down = siteList.filter((s) => s.tone === "bad").length;
  // Slow or answering the wrong content: up, but not all-green (the Needs attention list says the
  // same). Before Track 8 the tile read a green "7 of 7" beside "7 sites answering with a warning".
  const warned = siteList.filter((s) => s.tone === "warn").length;
  // Nothing checked ("0 of 0") or no site answered at all: Unknown, never a Live count (REVIEW-T1 R2).
  const sitesOffline = sitesCheckOffline(siteList);
  const sitesUnknown = Boolean(sites) && (siteList.length === 0 || sitesOffline);
  const inboxUnknown = Boolean(email && !email.connected);

  return [
    {
      // The same number as the sidebar badge and the Jarvis HUD (UI-truth H1). A part that couldn't
      // be read makes it a lower bound ("12+") and the tile says which part is unknown.
      key: "needsYou",
      label: "Waiting on you",
      to: "/work",
      state: tileState(src.needsYou, now, { zero: needsYou ? needsYou.complete && needsYou.total === 0 : false }),
      value: needsYou ? needsYouBadge(needsYou) : null,
      tone: needsYou ? (needsYou.total ? "warn" : needsYou.complete ? "success" : undefined) : undefined,
      hint: needsYou ? needsYouBreakdown(needsYou) : failedHint(src.needsYou),
      updatedAt: sourceUpdatedAt(src.needsYou),
      recovery: retry,
    },
    {
      key: "callQueue",
      label: "Calls to make",
      to: "/leads",
      // An empty CRM can't say "0 to call" (REVIEW-T1 B9).
      state: calls && calls.crmLeads === 0 ? "unknown" : tileState(src.callQueue, now, { zero: calls ? calls.total === 0 : false }),
      value: calls && calls.crmLeads !== 0 ? calls.total : null,
      tone: calls && overdue ? "warn" : undefined,
      hint: calls && calls.crmLeads === 0 ? "No leads in the CRM yet" : calls ? (overdue ? `${overdue}${facts.overdueCallsAtLeast ? "+" : ""} overdue` : "Due today or overdue") : failedHint(src.callQueue),
      updatedAt: sourceUpdatedAt(src.callQueue),
      recovery: retry,
    },
    {
      key: "receptionist",
      label: "Receptionist",
      to: "/receptionist",
      // "Status unknown" is unknown, not live (REVIEW-T1 B8).
      state: rx && /unknown/i.test(rx.verdict.decision ?? "") ? "unknown" : tileState(src.receptionist, now),
      value: rx && !/unknown/i.test(rx.verdict.decision ?? "") ? rx.verdict.decision : null,
      tone: rx ? (rx.verdict.tone === "bad" ? "danger" : rx.verdict.tone === "warn" ? "warn" : rx.verdict.tone === "ok" ? "success" : undefined) : undefined,
      hint: rx ? (typeof rx.gatesPassed === "number" && Array.isArray(rx.gates) && rx.gates.length ? `${rx.gatesPassed} of ${rx.gates.length} go-live gates` : "Go-live gates not reported") : failedHint(src.receptionist),
      updatedAt: sourceUpdatedAt(src.receptionist),
      recovery: retry,
    },
    {
      key: "websites",
      label: "Sites up",
      to: "/websites",
      state: tileState(src.websites, now, { unknown: sitesUnknown }),
      value: sites && !sitesUnknown ? `${up} of ${siteList.length}` : null,
      tone: sites && !sitesUnknown ? (down ? "danger" : warned ? "warn" : "success") : undefined,
      hint: sitesOffline
        ? `No site answered: the check couldn't reach the network, so ${siteList.length} sites are unchecked`
        : sites && !siteList.length
          ? "No sites checked yet"
          : sites ? ([down ? `${down} down` : "", warned ? `${warned} with a warning` : ""].filter(Boolean).join(" · ") || undefined) : failedHint(src.websites),
      updatedAt: sites?.checkedAt ?? sourceUpdatedAt(src.websites),
      recovery: retry,
    },
    {
      key: "email",
      label: "Emails to answer",
      to: "/inbox",
      state: tileState(src.email, now, { unknown: inboxUnknown, zero: email?.connected ? email.needsReplyCount === 0 : false }),
      value: email?.connected ? email.needsReplyCount : null,
      hint: email ? (email.connected ? emailHint(src.email!.data!, email, now) : "Inbox not connected") : failedHint(src.email),
      updatedAt: sourceUpdatedAt(src.email),
      recovery: inboxUnknown ? { kind: "link", label: "Connect the inbox", to: "/inbox" } : retry,
    },
  ];
}

/** The focus card's sentence, from the tiles' own numbers (never a number the tiles don't have). */
export function focusLine(
  tiles: Partial<Record<TodayKey, { value: string | number | null; state?: string }>>,
  exceptions: number,
  loading: boolean,
): { headline: string; detail: string } {
  if (loading) return { headline: "Checking what needs you…", detail: "Reading approvals, calls, sites, the receptionist and email." };
  const parts: string[] = [];
  const waiting = tiles.needsYou?.value;
  const known = (s?: string) => s !== "failed" && s !== "unknown" && s !== "setup-required";
  if (waiting !== null && waiting !== undefined && waiting !== 0 && waiting !== "0" && known(tiles.needsYou?.state)) parts.push(`${waiting} waiting on you`);
  const calls = tiles.callQueue?.value;
  if (typeof calls === "number" && calls > 0 && known(tiles.callQueue?.state)) parts.push(`${calls} ${calls === 1 ? "call" : "calls"} to make`);
  if (exceptions > 0) parts.push(`${exceptions} ${exceptions === 1 ? "thing" : "things"} to look at`);
  const unread = (Object.values(tiles).filter((t) => t && t.state === "failed").length);
  const detail = unread
    ? `${unread} ${unread === 1 ? "source" : "sources"} couldn't be read, so this may not be everything. Each shows a retry below.`
    : "Everything below opens the page where you act.";
  if (!parts.length) return { headline: unread ? "Nothing waiting in the sources that answered." : "You're clear for now.", detail };
  const headline = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return { headline: `${headline.charAt(0).toUpperCase()}${headline.slice(1)}.`, detail };
}


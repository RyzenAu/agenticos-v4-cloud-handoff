// The dashboard's exception list = the agency feed's exceptions PLUS the sell-status incidents
// (flagged real calls) and open go-live blockers from /__receptionist, deduplicated by call.
// Metadata only: flags, consequence, time and a masked caller; never transcript text.
//
// Truth rule: the list may say "none" only when BOTH sources were read. A flagged call or an open
// blocker can never be hidden behind a feed-side "0 open exceptions".
import { ageText, PROVIDER_STALE_MS, type DashBlock, type DashboardViewModel, type ExceptionItem } from "../../../../scripts/receptionist/dashboard";
import { qaLabel } from "../../../../scripts/receptionist/qa-codes";
import { FLAG_LABEL, type Blocker, type Incident, type ReceptionistSnapshot, type SellCheck } from "../../../../scripts/receptionist/types";
import { fmtDateTime } from "../../../lib/format";

export type SellSource = { data: ReceptionistSnapshot | undefined; error: Error | null; isLoading: boolean };
export type MergedExceptions = {
  items: ExceptionItem[];
  summary: DashBlock<{ count: number; critical: number }>;
  /** True when both sources were read; only then may the list say there are none. */
  complete: boolean;
  /** Which parts couldn't be read (shown next to a partial count). */
  missing: string[];
};

const maskCaller = (from: string | null) => {
  const digits = from?.replace(/\D/g, "") ?? "";
  return digits ? `••• ${digits.slice(-3)}` : "caller unavailable";
};
const when = (at: string | null) =>
  at ? fmtDateTime(new Date(at)) : "time unavailable";

/**
 * Every label on a call: local flags and production-QA codes, one list, each label once. A Retell
 * flag and the matching QA code share a label ("False booking"), so it is shown once (RX-10).
 */
export function incidentLabels(incident: Incident): string[] {
  return [...new Set([...incident.flags.map((f) => FLAG_LABEL[f] ?? f), ...(incident.qaCodes ?? []).map(qaLabel)])];
}

/** The QA codes whose label a local flag doesn't already show (the badges' dedupe, RX-10). */
export function extraQaCodes(incident: Incident): string[] {
  const shown = new Set(incident.flags.map((f) => FLAG_LABEL[f] ?? f));
  const seen = new Set<string>();
  return (incident.qaCodes ?? []).filter((code) => {
    const label = qaLabel(code);
    if (shown.has(label) || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

/** "not attributed to a client" for a production-QA call the feed ties to no client row. */
export function attributionNote(incident: Incident): string | null {
  if (!incident.sources?.includes("production QA")) return null;
  return incident.client ? `client: ${incident.client}` : "not attributed to a client";
}

export function incidentException(incident: Incident): ExceptionItem {
  const flags = incidentLabels(incident).join(", ");
  const attribution = attributionNote(incident);
  const qa = incident.qaCodes?.length ? ` Production QA review: ${incident.qaReview ?? "status not reported"}; resolve it in MU-Receptionist.` : "";
  const followed = incident.followedUp ? ` Followed up by ${incident.followedUp.by}; still open until reviewed and retested.` : "";
  return {
    id: incident.callId,
    severity: "critical",
    title: `Flagged call ${when(incident.startedAt)} · ${maskCaller(incident.from)}${attribution ? ` (${attribution})` : ""}: ${flags || "flagged"}`,
    detail: `${incident.consequence}${qa}${followed} Follow the caller up, then mark it followed up.${incident.retellUrl ? ` Retell: ${incident.retellUrl}` : ""}`,
    clientSlug: null,
  };
}

/** A followed-up call whose recorded retests haven't passed: it still blocks selling. */
export function retestException(incident: Incident): ExceptionItem {
  return {
    id: incident.callId,
    severity: "warn",
    title: `Followed up, awaiting retest: ${when(incident.startedAt)} · ${maskCaller(incident.from)}: ${incidentLabels(incident).join(", ") || "flagged"}`,
    detail: `Followed up${incident.followedUp ? ` by ${incident.followedUp.by}` : ""}. Not safe to sell until the recorded owner retest calls after it pass.`,
    clientSlug: null,
  };
}

/** A failing "Safe to sell" condition not already listed as a flagged call or a gate. */
export function sellCheckException(check: SellCheck): ExceptionItem | null {
  // Informational lines (the owner-console checklist) aren't sell conditions, so never an exception.
  if (check.ok || check.informational || check.id === "flagged-calls" || check.id === "gates" || check.id === "retests") return null;
  return { id: `sell:${check.id}`, severity: check.id === "feed-qa" ? "critical" : "warn", title: `Sell condition not met: ${check.label}`, detail: check.detail, clientSlug: null };
}

export function blockerException(blocker: Blocker): ExceptionItem | null {
  if (blocker.state === "pass") return null;
  const state = ({ fail: "failed", "not-tested": "not tested", open: "awaiting owner sign-off", "evidence-missing": "evidence missing", unknown: "unknown (calls unread)" } as Record<Blocker["state"], string>)[blocker.state] ?? blocker.state;
  return {
    id: `gate:${blocker.id}`,
    severity: blocker.state === "fail" ? "critical" : "warn",
    title: `Go-live gate ${state}: ${blocker.title}`,
    detail: `Next: ${blocker.next}${blocker.evidence.length ? ` Evidence: ${blocker.evidence.slice(0, 3).join("; ")}` : ""}`,
    clientSlug: null,
  };
}

const RANK = { critical: 2, warn: 1 } as const;

export function mergeSellExceptions(feed: { items: ExceptionItem[]; summary: DashBlock<{ count: number; critical: number }> }, sell: SellSource): MergedExceptions {
  const snapshot = sell.data;
  const extra = snapshot
    ? [
        ...snapshot.incidents.map(incidentException),
        ...(snapshot.awaitingRetest ?? []).map(retestException),
        ...snapshot.readiness.blockers.map(blockerException).filter((x): x is ExceptionItem => x !== null),
        ...(snapshot.verdict.checks ?? []).map(sellCheckException).filter((x): x is ExceptionItem => x !== null),
      ]
    : [];
  // The feed's aggregate "N critical QA flags open" row stands in for calls the sell status lists
  // one by one: when the sell status read the feed, the per-call rows replace it (never both).
  const perCall = snapshot?.feed?.ok === true;
  const feedItems = feed.summary.ok ? feed.items.filter((i) => !(perCall && i.id.startsWith("feed:qa-"))) : [];
  const byId = new Map<string, ExceptionItem>();
  // Sell-status incidents first, so the call-level record keeps its flags; a feed row for the same
  // call id only raises the severity, never adds a second row.
  for (const item of [...extra, ...feedItems]) {
    const prev = byId.get(item.id);
    if (!prev) byId.set(item.id, item);
    else if (RANK[item.severity] > RANK[prev.severity]) byId.set(item.id, { ...prev, severity: item.severity });
  }
  const items = [...byId.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const missing = [
    ...(feed.summary.ok ? [] : ["agency feed"]),
    ...(snapshot ? [] : [sell.isLoading ? "sell status (loading)" : "sell status"]),
  ];
  const complete = missing.length === 0;
  // RX-7: with the feed unread the count is PARTIAL (the sell status's own read), never "stale":
  // a feed that was never read has no age. Its time is the sell status's read.
  const feedMeta = { asOf: feed.summary.asOf, stale: feed.summary.stale, staleAfterMs: feed.summary.staleAfterMs, source: `${feed.summary.source} + /__receptionist (sell status)` };
  const meta = feed.summary.ok || !snapshot
    ? feedMeta
    : { asOf: snapshot.generatedAt, stale: false, staleAfterMs: PROVIDER_STALE_MS, source: "/__receptionist (sell status) only; agency feed not read" };
  const counts = { count: items.length, critical: items.filter((i) => i.severity === "critical").length };
  // Complete, or at least one exception known: a count (a partial one is flagged by `missing`).
  // Nothing known and a source unread: failed, never "0".
  const summary: MergedExceptions["summary"] =
    complete || items.length
      ? { ok: true, ...counts, ...meta }
      : { ok: false, reason: feed.summary.ok ? (sell.error?.message ?? "Sell status not read yet") : feed.summary.reason, ...feedMeta };
  return { items, summary, complete, missing };
}

/** "read 3 min ago" / "never read" for a feed read time. */
const readText = (at: string | null | undefined, now: number) => {
  const age = ageText(at ?? null, now);
  return age ? `read ${age}` : "not read yet";
};

/**
 * Do the page's two agency-feed reads agree (RX-1)? The sell status reads the full view, the
 * dashboard the metadata view; each keeps its own read time. They agree when both worked, or both
 * failed for the same reason. Null when either side hasn't loaded.
 */
export function feedReadAgreement(
  dashboard: DashboardViewModel["feedRead"] | undefined,
  snapshot: ReceptionistSnapshot | undefined,
  now = Date.now(),
): { agree: boolean; lines: string[] } | null {
  if (!dashboard || !snapshot) return null;
  const sellFeed = snapshot.feed;
  const sellAt = snapshot.feedRead?.at ?? snapshot.generatedAt;
  const agree = sellFeed.ok === dashboard.ok && (sellFeed.ok || sellFeed.reason === dashboard.reason);
  const state = (ok: boolean, reason: string | null) => (ok ? "connected" : `unavailable (${reason ?? "reason not reported"})`);
  return {
    agree,
    lines: [
      `Sell status: feed ${state(sellFeed.ok, sellFeed.ok ? null : sellFeed.reason)}, ${readText(sellAt, now)}`,
      `Dashboard: feed ${state(dashboard.ok, dashboard.reason)}, ${readText(dashboard.at, now)}`,
    ],
  };
}

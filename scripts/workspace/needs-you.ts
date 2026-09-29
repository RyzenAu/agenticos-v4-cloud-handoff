// One "needs you" count (UI-truth H1). The sidebar's Today badge, Today's "Waiting on you" tile and
// the Jarvis HUD all show THIS number, computed here on the server from the same sources Today
// already reads, so they can never disagree:
//
//   decisions        owner decisions: approvals.json + live receptionist sign-offs, one per approval id
//   email            emails to answer from the inbox triage log (Today's "Emails to answer" tile),
//                    one per mail thread
//   agentApprovals   agent runs paused for the owner's answer (/__operator/jarvis/status)
//
// A part that couldn't be read is unknown, never zero: the total is then the sum of the parts that
// answered and `complete` is false, so every surface shows it as a lower bound ("12+").
import type { PanelResult } from "./aggregate";
import type { EmailPanel } from "./projections";

export type NeedsYouState = "ok" | "stale" | "failed" | "setup-required" | "partial";
export type NeedsYouPart = {
  label: string;
  /** Null when the part is unknown (failed, not connected). */
  count: number | null;
  state: NeedsYouState;
  /** Where the number comes from, for the tooltip / Inspector. */
  source: string;
  /** When the underlying data was last read successfully. */
  updatedAt: string | null;
  note?: string;
};
export type NeedsYouPanel = {
  total: number;
  /** Every part answered with a CURRENT count. False (a part unknown, partial or stale): `total` is a floor. */
  complete: boolean;
  parts: { decisions: NeedsYouPart; email: NeedsYouPart; agentApprovals: NeedsYouPart };
  definition: string;
};

/** How many of the waiting decisions the Home page's "Needs you" list shows (and Jarvis reads out): the rest are in Work. */
export const NEEDS_YOU_LIST_SHOWN = 3;

export const NEEDS_YOU_DEFINITION =
  "Owner decisions (one per approval) + emails to answer (one per thread, inbox triage) + agent runs waiting for your answer.";

type TodayLike = { approvals: { id: string }[]; derivedError: string | null };
type AgentApprovals = { ok: true; count: number; at: string | null } | { ok: false; error: string };

const stalePart = (r: PanelResult<unknown>) => (r.ok && r.stale ? true : false);

export function decisionsPart(today: PanelResult<TodayLike>): NeedsYouPart {
  const base = { label: "Owner decisions", source: "approvals.json + receptionist readiness" };
  if (!today.ok) return { ...base, count: null, state: "failed", updatedAt: null, note: today.error };
  const ids = new Set(today.data.approvals.map((a) => a.id));
  // File items still count when the live receptionist gates couldn't be read, but the count is then partial.
  const state: NeedsYouState = today.data.derivedError ? "partial" : stalePart(today) ? "stale" : "ok";
  return { ...base, count: ids.size, state, updatedAt: today.updatedAt, note: today.data.derivedError ?? undefined };
}

export function emailPart(email: PanelResult<EmailPanel>): NeedsYouPart {
  const base = { label: "Emails to answer", source: "inbox triage (last 24 h), one per thread" };
  if (!email.ok) return { ...base, count: null, state: "failed", updatedAt: null, note: email.error };
  if (!email.data.connected) return { ...base, count: null, state: "setup-required", updatedAt: email.updatedAt, note: email.data.reason };
  return { ...base, count: email.data.needsReplyCount, state: stalePart(email) ? "stale" : "ok", updatedAt: email.updatedAt };
}

export function agentApprovalsPart(agent: AgentApprovals): NeedsYouPart {
  const base = { label: "Agent approvals", source: "agent task store (jarvis status)" };
  if (!agent.ok) return { ...base, count: null, state: "failed", updatedAt: null, note: agent.error };
  return { ...base, count: agent.count, state: "ok", updatedAt: agent.at };
}

export function needsYouFrom(input: { today: PanelResult<TodayLike>; email: PanelResult<EmailPanel>; agent: AgentApprovals }): NeedsYouPanel {
  const parts = { decisions: decisionsPart(input.today), email: emailPart(input.email), agentApprovals: agentApprovalsPart(input.agent) };
  const all = Object.values(parts);
  return {
    total: all.reduce((n, p) => n + (p.count ?? 0), 0),
    // A stale part is last known, not current, so the total can't be exact: it's shown as a floor.
    complete: all.every((p) => p.count !== null && p.state === "ok"),
    parts,
    definition: NEEDS_YOU_DEFINITION,
  };
}

/** "12", "12+" (lower bound), "99+"; null when nothing at all is known. */
export function needsYouBadge(panel: Pick<NeedsYouPanel, "total" | "complete" | "parts"> | null | undefined): string | null {
  if (!panel) return null;
  const known = Object.values(panel.parts).some((p) => p.count !== null);
  if (!known) return null;
  if (panel.total > 99) return "99+";
  return `${panel.total}${panel.complete ? "" : "+"}`;
}

export type SidebarBadge = { text: string; label: string; unknown: boolean } | null;

/**
 * The sidebar's Today badge (review should-fix: zero and unknown both showed no badge).
 *   loading          nothing yet (the first read is on its way)
 *   read failed      "?"  "Needs-you count unknown: couldn't be read"
 *   nothing known    "?"  every part unknown
 *   "0+"             "?"  the parts that answered are zero, the rest unknown
 *   complete zero    no badge: nothing needs you
 *   otherwise        the count ("12", "12+", "99+")
 */
export function sidebarBadge(input: { loading: boolean; failed: boolean; panel: NeedsYouPanel | null }): SidebarBadge {
  if (input.loading) return null;
  if (input.failed || !input.panel) return { text: "?", label: "Needs-you count unknown: it couldn't be read", unknown: true };
  const count = needsYouBadge(input.panel);
  const detail = needsYouBreakdown(input.panel);
  if (count === null || count === "0+") return { text: "?", label: `Needs-you count unknown: ${detail}`, unknown: true };
  if (count === "0") return null;
  return { text: count, label: `${count} need you: ${detail}`, unknown: false };
}

/** "3 decisions · 2 emails · agent approvals unknown" — every part named, unknown said as unknown. */
export function needsYouBreakdown(panel: Pick<NeedsYouPanel, "parts">): string {
  const one = (p: NeedsYouPart, singular: string, plural: string) =>
    p.count === null
      ? `${plural} ${p.state === "setup-required" ? "not connected" : "unknown"}`
      : `${p.count}${p.state === "partial" ? "+" : ""} ${p.count === 1 && p.state !== "partial" ? singular : plural}${p.state === "stale" ? " (stale)" : ""}`;
  return [
    one(panel.parts.decisions, "decision", "decisions"),
    one(panel.parts.email, "email", "emails"),
    one(panel.parts.agentApprovals, "agent approval", "agent approvals"),
  ].join(" · ");
}

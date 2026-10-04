// Receptionist -> Leads / staff handoffs for the shared Command scene. Pure (no DOM, no fetch); bun-tested.
//
// What this OS can honestly say today. The only trusted receptionist source is MU-Receptionist's agency feed, read server-side
// and shaped by scripts/receptionist/dashboard.ts. Its default (metadata) view carries COUNTS per client and no per-call rows:
// staff alerts by status, call transfers by status, callback requests pending. So a handoff here is an aggregate ("3 staff
// alerts pending"), it says so in `basis`, and its id is stable per kind so a refresh or retry is the same handoff.
//
// What it cannot say, and so never does:
//  - a call became a saved CRM lead: the CRM (scripts/leads) holds outbound prospects and has no field that links a
//    receptionist call to a lead, so nothing can confirm it. `LEAD_LINK_GAP` says this in the scene.
//  - a booking, an SMS or a staff notification happened for a given call: only counts exist, and "sent" counts are cumulative.
//  - anything when the read failed, has no timestamp, or is old: that is one "Not confirmed" row, never a stale "queued".
//
// `fromSourceEvent` is the seam for a future per-event source (a call with a saved-lead id, or an acked staff alert). It
// confirms a handoff only when the event carries the named evidence, and downgrades to unknown otherwise.
import type { Handoff, HandoffState } from "./handoff";
import type { DashboardViewModel } from "../../../scripts/receptionist/dashboard";

export const RX_SOURCE_LABEL = "Agency feed";
/** A count older than this is not shown as work in flight, whatever the block's own staleness window says. */
export const RX_HANDOFF_FRESH_MS = 30 * 60_000;

/** The one thing the scene says about the gap, always visible next to the receptionist handoffs. */
export const LEAD_LINK_GAP = {
  state: "Setup required",
  text: "Call to saved lead: not connected. The CRM has no field linking a receptionist call to a lead, and the feed sends counts, not calls.",
} as const;

type Block = { ok: boolean; asOf: string | null; stale?: boolean; staleAfterMs?: number; partial?: boolean; reason?: string };
export type DashboardHandoffInput = {
  handoffs: Block & { pending?: number | null; failed?: number | null };
  transfers: Block & { failed?: number | null };
  callbacks: Block & { pending?: number | null };
};

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Fresh enough to draw as in-flight: has an asOf, inside both the block's window and RX_HANDOFF_FRESH_MS. */
export function blockFresh(b: Block, now: number): boolean {
  const t = b.asOf ? Date.parse(b.asOf) : NaN;
  if (!Number.isFinite(t) || t > now + 60_000) return false;
  return now - t <= Math.min(RX_HANDOFF_FRESH_MS, b.staleAfterMs ?? RX_HANDOFF_FRESH_MS);
}

const unknown = (why: string, at: number): Handoff => ({
  id: "rx:staff-handoffs:unknown",
  from: "receptionist",
  to: "staff",
  state: "unknown",
  label: "Staff handoff state unknown",
  at,
  basis: why,
  source: "receptionist-feed",
});

/**
 * The receptionist's staff handoffs from the dashboard view model. `null` (not read yet or the read failed) and every
 * unusable block collapse into one "Not confirmed" row that says why; a fresh block with real counts gives one row per kind.
 * Nothing is emitted for zero counts, and no row is ever "done" or "confirmed" from a count.
 */
export function receptionistHandoffs(vm: DashboardHandoffInput | null | undefined, now: number): Handoff[] {
  if (!vm) return [unknown("The receptionist dashboard hasn't been read, or the read failed.", now)];
  const blocks: Array<[string, Block]> = [["staff alerts", vm.handoffs], ["transfers", vm.transfers], ["callbacks", vm.callbacks]];
  const bad = blocks.find(([, b]) => !b || !b.ok);
  if (bad) return [unknown(`The feed's ${bad[0]} block couldn't be read${bad[1]?.reason ? `: ${String(bad[1].reason).slice(0, 80)}` : "."}`, now)];
  const old = blocks.find(([, b]) => !blockFresh(b, now));
  if (old) return [unknown(`The feed's ${old[0]} count is old or has no read time, so it isn't shown as in flight.`, now)];

  const out: Handoff[] = [];
  const row = (id: string, state: HandoffState, label: string, b: Block, note: string) =>
    out.push({ id, from: "receptionist", to: "staff", state, label, at: Date.parse(b.asOf!), basis: `${note}${b.partial ? " At least this many: a client didn't report." : ""}`, source: "receptionist-feed" });

  const failedAlerts = count(vm.handoffs.failed), pendingAlerts = count(vm.handoffs.pending);
  const failedTransfers = count(vm.transfers.failed), callbacks = count(vm.callbacks.pending);
  if (failedAlerts) row("rx:staff-alerts:failed", "failed", plural(failedAlerts, "staff alert failed to send", "staff alerts failed to send"), vm.handoffs, "Count from the agency feed, not a single call.");
  if (failedTransfers) row("rx:transfers:failed", "failed", plural(failedTransfers, "call transfer failed", "call transfers failed"), vm.transfers, "Count from the agency feed, not a single call.");
  if (pendingAlerts) row("rx:staff-alerts:pending", "queued", plural(pendingAlerts, "staff alert waiting to send", "staff alerts waiting to send"), vm.handoffs, "Count from the agency feed. Not sent yet, so nobody has been told.");
  if (callbacks) row("rx:callbacks:pending", "queued", plural(callbacks, "callback waiting for staff", "callbacks waiting for staff"), vm.callbacks, "Count from the agency feed. No one has called back yet as far as the feed says.");
  // A counter the feed didn't send (null) is unknown, not zero: say so instead of staying quiet.
  if ([failedAlerts, pendingAlerts, failedTransfers, callbacks].some((n) => n === null)) out.push(unknown("The feed didn't send every handoff counter, so a zero can't be told from missing.", now));
  return out;
}

/** What a future per-event source must supply. Confirmation is evidence, never a bare claim. */
export type SourceEvent = {
  eventId: string;
  kind: "lead-saved" | "staff-alert" | "call-transfer";
  state: "queued" | "confirmed" | "failed";
  observedAt: string;
  /** Required for "confirmed": lead-saved needs the saved lead's id, staff-alert an acknowledgement, call-transfer a connected status. */
  evidence?: { leadId?: string; alertAck?: boolean; transferConnected?: boolean };
  /** Source system name, e.g. "crm", "agency-feed". */
  system: string;
  /** Masked one-liner with no name, number or transcript text. */
  label?: string;
};

const evidenceFor = (e: SourceEvent) =>
  e.kind === "lead-saved" ? !!e.evidence?.leadId : e.kind === "staff-alert" ? e.evidence?.alertAck === true : e.evidence?.transferConnected === true;

/** A per-event source's event as a handoff. "confirmed" without its evidence is "unknown"; a bad time or id is dropped (null). */
export function fromSourceEvent(e: SourceEvent, now: number): Handoff | null {
  const at = Date.parse(e.observedAt);
  if (!e.eventId || !Number.isFinite(at) || at > now + 60_000) return null;
  const to = e.kind === "lead-saved" ? "leads" : "staff";
  const said = e.label?.replace(/\s+/g, " ").trim().slice(0, 60);
  const words = e.kind === "lead-saved" ? "lead" : e.kind === "staff-alert" ? "staff alert" : "call transfer";
  const state: HandoffState = e.state === "failed" ? "failed" : e.state === "queued" ? "queued" : evidenceFor(e) ? "done" : "unknown";
  const label = said || (state === "done" ? `Saved ${words}` : `${words[0].toUpperCase()}${words.slice(1)}`);
  return {
    id: `rx:${e.system}:${e.eventId}`.slice(0, 80),
    from: "receptionist",
    to,
    state,
    label,
    at,
    basis: state === "unknown" ? `The ${e.system} reported it confirmed but sent no proof, so it isn't shown as done.` : `Reported by ${e.system} for this one event.`,
    source: "event",
  };
}

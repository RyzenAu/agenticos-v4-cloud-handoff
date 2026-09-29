import { InfoTip, Section } from "@/components/ds";
import type { DashboardViewModel } from "@/lib/receptionist-dashboard";
import { CLIENT_UNREPORTED_HINT, NOT_ATTRIBUTED_HINT, type Attribution } from "../../../../scripts/receptionist/dashboard";
import { BlockState, DashTile } from "./shared";

/**
 * Why a summed total is unknown (RX-2), and whether a retry could help: it can't when a client didn't
 * report the block ("client-unreported"). With every client reporting, an unknown count is a status
 * record the feed didn't send.
 */
const why = (a: Attribution) => ({
  unknownHint: a === "not-attributed" ? NOT_ATTRIBUTED_HINT : a === "client-unreported" ? CLIENT_UNREPORTED_HINT : "Not reported by the feed for every client",
  unknownNeedsSetup: a === "client-unreported",
});

/** Calls/outcomes, bookings, transfers and callbacks — one section, one agreed source (the feed). */
export function CallsAndBookings({ data }: { data: DashboardViewModel }) {
  return (
    <Section title="Calls, bookings &amp; transfers" actions={<InfoTip label="About this section">Safe metadata only — counts and ids, never transcript text or caller content.</InfoTip>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Calls &amp; outcomes</h3>
          <BlockState block={data.callsOutcomes} render={(t) => (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <DashTile label="Calls" block={data.callsOutcomes} value={t.calls} />
              <DashTile label="Completed" block={data.callsOutcomes} value={t.completed} />
              <DashTile label="Failed" block={data.callsOutcomes} value={t.failed} tone={t.failed ? "warn" : undefined} />
            </div>
          )} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Bookings</h3>
          <BlockState block={data.bookings} render={(b) => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <DashTile label="Confirmed" block={data.bookings} value={b.confirmed} lowerBound={b.partial} {...why(b.attribution)} />
              <DashTile label="Cancelled" block={data.bookings} value={b.cancelled} lowerBound={b.partial} {...why(b.attribution)} />
              <DashTile label="Failed" block={data.bookings} value={b.failed} lowerBound={b.partial} tone={b.failed ? "warn" : undefined} {...why(b.attribution)} />
              <DashTile label="Upcoming" block={data.bookings} value={b.upcoming} lowerBound={b.partial} {...why(b.attribution)} />
            </div>
          )} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Transfers</h3>
          <BlockState block={data.transfers} render={(t) => (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <DashTile label="Attempted" block={data.transfers} value={t.attempted} lowerBound={t.partial} {...why(t.attribution)} />
              <DashTile label="Confirmed" block={data.transfers} value={t.confirmed} tone={t.attempted !== null && t.confirmed !== null && t.attempted > t.confirmed ? "warn" : undefined} hint={!t.partial && t.attempted !== null && t.confirmed !== null && t.attempted > t.confirmed ? `${t.attempted - t.confirmed} not confirmed` : undefined} lowerBound={t.partial} {...why(t.attribution)} />
              <DashTile label="Failed" block={data.transfers} value={t.failed} lowerBound={t.partial} tone={t.failed ? "warn" : undefined} {...why(t.attribution)} />
            </div>
          )} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Callbacks / handoffs</h3>
          <BlockState block={data.callbacks} render={(c) => (
            <div className="grid grid-cols-2 gap-2">
              <DashTile label="Pending" block={data.callbacks} value={c.pending} unknownHint="The feed did not report triage counts" />
              <DashTile label="Done" block={data.callbacks} value={c.done} unknownHint="The feed did not report triage counts" />
            </div>
          )} />
          {/* Every staff-alert reason the feed reports, known or not (F11): an unrecognised one is a
              row with its code, never hidden. Same feed read as the tiles above, so no second notice. */}
          {data.handoffs.ok && data.handoffs.byReason.length ? (
            <ul className="mt-2 space-y-1" aria-label="Staff alerts by reason" data-alert-reasons>
              {data.handoffs.byReason.map((r) => (
                <li key={r.reason} className="flex items-baseline justify-between gap-3 rounded-lg bg-inset px-3 py-1.5 text-sm" data-known={r.known || undefined}>
                  <span className={r.known ? "text-foreground" : "text-warn"}>{r.label}</span>
                  <span className="ds-num shrink-0">{data.handoffs.ok && data.handoffs.byReasonPartial ? `≥ ${r.count}` : r.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

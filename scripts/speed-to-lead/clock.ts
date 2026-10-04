// Speed-to-lead: the response-time clock. Business-hours aware, reusing the existing calling
// window (Mon–Fri 9–8, Sat 9–5, never Sunday or an NSW/national public holiday — see
// scripts/workspace/calling-window.ts and scripts/leads/outreach.ts, which own the actual rules
// and the holiday calendar) rather than inventing a second definition of "business hours".
//
// An enquiry that lands inside the window starts its clock immediately. One that lands outside it
// (a Sunday, 11pm, Boxing Day) still gets an immediate Telegram alert (see notify.ts / run.ts) —
// the owner rule is that the alert is never delayed — but the SLA clock itself starts at the next
// business hour, and "due" is counted in business minutes so a quiet overnight stretch can't
// quietly burn the reply window.
import { callingWindowStatus } from "../workspace/calling-window";

export type ClockResult = {
  /** ISO instant the SLA clock actually starts ticking. */
  startedAt: string;
  /** ISO instant the clock is due (startedAt + slaMinutes of business time). */
  dueAt: string;
  /** True when the enquiry arrived outside the calling window (so the clock's start was deferred). */
  outsideHoursAtArrival: boolean;
};

const DEFAULT_SLA_MINUTES = 60;
/** Safety valve for addBusinessMinutes' walk — comfortably more steps than a slow month needs. */
const MAX_STEPS = 2000;

/**
 * Adds `minutes` of business time to `from`, skipping every closed stretch (nights, weekends,
 * public holidays) using the existing calling-window rules. Pure and deterministic for a given
 * `from`, so it's safe to unit test with synthetic timestamps — never a live clock or network call.
 */
export function addBusinessMinutes(from: Date, minutes: number): Date {
  let cursor = new Date(from.getTime());
  let remaining = minutes;
  for (let step = 0; remaining > 0 && step < MAX_STEPS; step++) {
    const status = callingWindowStatus(cursor);
    if (status.open) {
      const closesAt = status.closesAt ? Date.parse(status.closesAt) : null;
      const availableMinutes =
        closesAt === null ? remaining : (closesAt - cursor.getTime()) / 60_000;
      const take = Math.min(remaining, Math.max(availableMinutes, 0));
      cursor = new Date(cursor.getTime() + take * 60_000);
      remaining -= take;
      // The window closed exactly as we arrived (take === 0): fall through to the closed branch
      // next iteration by nudging forward a tick so callingWindowStatus sees "closed".
      if (take === 0) cursor = new Date(cursor.getTime() + 60_000);
    } else {
      if (!status.nextOpenAt) break; // no window within calling-window's own 14-day lookahead
      cursor = new Date(status.nextOpenAt);
    }
  }
  return cursor;
}

/**
 * Starts the SLA clock for a freshly detected enquiry. `receivedAt` is the enquiry's own
 * metadata timestamp (the email's received-at, not "now" — a watcher run picking up an enquiry
 * a few minutes late must not push the clock later than it should be).
 */
export function startClock(receivedAt: Date, slaMinutes = DEFAULT_SLA_MINUTES): ClockResult {
  const arrival = callingWindowStatus(receivedAt);
  const startedAt = arrival.open
    ? receivedAt
    : arrival.nextOpenAt
      ? new Date(arrival.nextOpenAt)
      : receivedAt;
  const dueAt = addBusinessMinutes(startedAt, slaMinutes);
  return {
    startedAt: startedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    outsideHoursAtArrival: !arrival.open,
  };
}

export function isOverdue(dueAtIso: string, now: Date = new Date()): boolean {
  return now.getTime() > Date.parse(dueAtIso);
}

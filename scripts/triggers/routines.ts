// Routines: scheduled triggers with an explicit offline policy. There is no cron in memory. Every tick asks
// "which slots fell in (cursor, now]?"; the cursor and every slot's outcome are in triggers.sqlite, so a
// host that was down at 07:30 knows on its next tick that 07:30 was missed, and applies the routine's own
// policy instead of silently doing nothing or running at some surprising moment:
//   skip      record the missed window; run nothing
//   run-once  run ONE job for the latest missed window (earlier ones are coalesced into it)
//   review    create ONE job held for the owner's review (trigger.review); it runs only if approved
// A slot is "late" when the tick finds it more than `graceMs` after its time (default 10 minutes).
import { nextSlot, slotsBetween, validSchedule } from "./schedule";
import type { TriggerEngine } from "./engine";
import type { RoutineSchedule } from "./types";

export const ROUTINE_SOURCE = "routine.schedule";
const iso = (ms: number) => new Date(ms).toISOString();

export async function tickRoutines(engine: TriggerEngine, now: number, graceMs = 10 * 60_000): Promise<{ ran: number; skipped: number; review: number }> {
  const out = { ran: 0, skipped: 0, review: 0 };
  const { store } = engine;
  for (const trig of store.list({ kind: "routine" })) {
    if (!validSchedule(trig.schedule)) continue;
    const schedule: RoutineSchedule = trig.schedule;
    const cursor = store.cursor(trig.id) ?? trig.createdAt;
    // A paused or disabled routine never catches up on what it didn't run while off.
    if (trig.state !== "active") {
      store.setCursor(trig.id, now);
      continue;
    }
    const slots = slotsBetween(schedule, cursor, now).filter((slot) => !store.hasRun(trig.id, iso(slot)));
    const late = slots.filter((slot) => now - slot > graceMs);
    const onTime = slots.filter((slot) => now - slot <= graceMs);
    const fire = async (slot: number, fields: Record<string, unknown>, hold: boolean) =>
      engine.ingest(trig, { source: ROUTINE_SOURCE, eventId: `${trig.id}:${iso(slot)}`, actor: "system", fields: { slot: iso(slot), ...fields } }, { hold });
    const jobOf = (r: Awaited<ReturnType<typeof fire>>) => (r.status === "job" || r.status === "duplicate" ? r.jobId : null);

    for (const slot of onTime) {
      const r = await fire(slot, { late: false, missed: 0 }, false);
      store.recordRun(trig.id, iso(slot), "ran", jobOf(r), 0);
      out.ran++;
    }
    if (late.length) {
      const policy = trig.offlinePolicy ?? "skip";
      const latest = late[late.length - 1];
      for (const slot of late.slice(0, policy === "skip" ? late.length : -1)) {
        store.recordRun(trig.id, iso(slot), policy === "skip" ? "skipped-offline" : "coalesced", null, late.length);
        out.skipped++;
      }
      if (policy === "run-once") {
        const r = await fire(latest, { late: true, missed: late.length - 1 }, false);
        store.recordRun(trig.id, iso(latest), "ran-on-return", jobOf(r), late.length - 1);
        out.ran++;
      } else if (policy === "review") {
        const r = await fire(latest, { late: true, missed: late.length - 1 }, true);
        store.recordRun(trig.id, iso(latest), "review-requested", jobOf(r), late.length - 1);
        out.review++;
      }
    }
    store.setCursor(trig.id, now);
  }
  return out;
}

/** The next scheduled time for display (ISO), or null. */
export function nextRunOf(schedule: RoutineSchedule | undefined, now: number): string | null {
  if (!validSchedule(schedule)) return null;
  const slot = nextSlot(schedule, now);
  return slot === null ? null : iso(slot);
}

// Meeting-mode notes → the lead engine CRM, through its own public functions (the same path as
// the `log` and `coach` CLI commands the call-outcome skill uses). Idempotent: the activity is
// keyed by `meeting:<notes id>` (crm.ts activity_events), and a coaching row is only added when
// that activity doesn't already have one, so replaying the same notes never duplicates anything.
import type { Database } from "bun:sqlite";
import { eventLogged, findLead, logActivity, recordCoaching, type Lead } from "../leads/crm";
import type { MeetingNotes } from "./coach";

export type CrmResult = { applied: boolean; duplicate: boolean; lead: { id: number; name: string } | null; detail: string };

/** A lead from an explicit reference, else from the business name the coach heard. */
export function matchLead(db: Database, ref: string | number | null | undefined, guess?: string): { lead: Lead | null; detail: string } {
  if (ref !== null && ref !== undefined && String(ref).trim()) {
    try {
      const lead = findLead(db, ref);
      return lead ? { lead, detail: `lead ${lead.id} as named` } : { lead: null, detail: `no lead matches "${ref}"` };
    } catch (error) {
      return { lead: null, detail: (error as Error).message };
    }
  }
  const name = (guess ?? "").trim();
  if (name.length < 4) return { lead: null, detail: "no business name to match" };
  try {
    const lead = findLead(db, name);
    return lead ? { lead, detail: `matched "${name}" to lead ${lead.id}` } : { lead: null, detail: `no lead called "${name}"` };
  } catch (error) {
    return { lead: null, detail: (error as Error).message };
  }
}

function activityFor(db: Database, eventId: string): number | null {
  const row = db.query("SELECT activity_id FROM activity_events WHERE event_id = ?").get(eventId) as { activity_id: number } | null;
  return row?.activity_id ?? null;
}

export function applyNotes(db: Database, notes: MeetingNotes, lead: Lead): CrmResult {
  const eventId = `meeting:${notes.id}`;
  const duplicate = eventLogged(db, eventId);
  const nextAt = notes.crm.next ? new Date(`${notes.crm.next}T09:00:00+10:00`).toISOString() : null;
  const kind = notes.source === "granola" ? "meeting" : "call";
  const tag = { meeting: "meeting mode", debrief: "debrief", granola: "Granola" }[notes.source];
  logActivity(db, lead, {
    kind, outcome: notes.crm.outcome, note: `[${tag}] ${notes.crm.note}`.slice(0, 300), by: notes.by, nextAt, eventId,
  });
  const activityId = activityFor(db, eventId);
  const hasCoaching = activityId !== null && !!db.query("SELECT 1 FROM coaching WHERE activity_id = ?").get(activityId);
  if (!hasCoaching && Object.keys(notes.coaching.categories).length) {
    const top = notes.coaching.fixes[0];
    recordCoaching(db, lead, {
      activityId, by: notes.by, categories: notes.coaching.categories, objectionTag: notes.coaching.objectionTag,
      worked: notes.coaching.wentWell.join("; ").slice(0, 300),
      improve: top ? `${top.issue} → "${top.betterLine}"`.slice(0, 300) : "",
      nextStep: notes.summary.nextSteps.map((s) => `${s.what}${s.when ? ` (${s.when})` : ""}`).join("; ").slice(0, 300) || "none secured",
    });
  }
  return {
    applied: true, duplicate, lead: { id: lead.id, name: lead.name },
    detail: duplicate ? `already logged to #${lead.id}; nothing duplicated` : `logged to #${lead.id} ${lead.name}`,
  };
}

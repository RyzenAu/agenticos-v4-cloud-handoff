// Follow-up desk: due/overdue next actions with the promise that was made and a suggested
// channel. `draft` is text only — built with the same `outreach.ts` rules `draft`/`emailDraft`
// already use — and this module never sends anything itself.
import type { Database } from "bun:sqlite";
import { activities, dayReport, sydneyDate } from "./crm";
import { callOpener, DEFAULT_SENDER, emailDraft, type Sender } from "./outreach";

export type FollowUpDraft = { channel: "email"; to: string; subject: string; body: string } | { channel: "call"; opener: string };

export type FollowUp = {
  leadId: number;
  name: string;
  vertical: string;
  status: string;
  owner: string;
  dueAt: string;
  overdue: boolean;
  promised: string;
  draft: FollowUpDraft;
};

/** Due/overdue next actions for `who` (or everyone, if null). Reuses `dayReport`'s
 *  follow-ups-due query so this and `today` never disagree about what's due. */
export function followUpQueue(db: Database, who: string | null, sender: Sender = DEFAULT_SENDER, now = new Date()): FollowUp[] {
  const due = dayReport(db, who, now).followUpsDue;
  const today = sydneyDate(now);
  return due.map((lead) => {
    const history = activities(db, lead.id);
    const last = history[0];
    const promised = last?.note?.trim() ? last.note.trim().slice(0, 300) : "insufficient data: no note on the last activity";
    const overdue = !!lead.nextAt && sydneyDate(lead.nextAt) < today;
    const canEmail = lead.emailOk && lead.emails.length > 0;
    const preferEmail = last?.kind === "email" && canEmail; // continue the channel the last touch used, if it's still usable
    const pitch = lead.pitch === "receptionist" || lead.pitch === "both" || lead.pitch === "redesign" || lead.pitch === "audit_pending" ? lead.pitch : "website";
    let draft: FollowUpDraft;
    if (preferEmail || (!lead.phone && canEmail)) {
      const d = emailDraft({ name: lead.name, vertical: lead.vertical, reasons: lead.reasons, pitch }, sender);
      draft = { channel: "email", to: lead.emails[0], subject: d.subject, body: d.body };
    } else if (lead.phone) {
      draft = { channel: "call", opener: callOpener(lead, sender) };
    } else {
      draft = { channel: "call", opener: "insufficient data: no usable phone or email on file" };
    }
    return {
      leadId: lead.id, name: lead.name || "(name expired: refresh)", vertical: lead.vertical, status: lead.status,
      owner: lead.owner, dueAt: lead.nextAt ?? "", overdue, promised, draft,
    };
  });
}

export function renderFollowUp(f: FollowUp): string {
  const head = `#${f.leadId} ${f.name} · ${f.vertical} · ${f.status}${f.overdue ? " · OVERDUE" : ""} · due ${f.dueAt.slice(0, 10)}${f.owner ? ` · owner ${f.owner}` : ""}`;
  const draftLine = f.draft.channel === "email" ? `Draft email → ${f.draft.to}: ${f.draft.subject}\n${f.draft.body}` : `Draft call: ${f.draft.opener}`;
  return [head, `Promised: ${f.promised}`, draftLine].join("\n");
}

// Review/referral ask: due 14 days after a won client's "Deployed" kickoff milestone is marked
// done, and stays due until "Review/referral asked" is marked done. Draft only -- this never sends
// anything, the same promise followups.ts already keeps for regular follow-ups.
import type { Database } from "bun:sqlite";
import { getKickoff, listLeads, sydneyDate, type Lead } from "./crm";
import { DEFAULT_SENDER, type Sender } from "./outreach";

export const REVIEW_ASK_DAYS = 14;

export type ReviewAskDraft = { channel: "email"; to: string; subject: string; body: string } | { channel: "call"; opener: string };

export type ReviewAsk = {
  leadId: number;
  name: string;
  deployedAt: string;
  daysSinceDeployed: number;
  draft: ReviewAskDraft;
};

function reviewAskEmail(lead: Lead, sender: Sender): { subject: string; body: string } {
  return {
    subject: `Quick favour, ${lead.name}?`,
    body: [
      `Hi,`,
      ``,
      `Your site's been live a couple of weeks now — hope it's working well for you.`,
      `If you've got two minutes, a Google review would help a lot, and if you know anyone else who could use a hand with their site, we'd love an introduction.`,
      ``,
      `Either way, thanks for trusting us with it.`,
      ``,
      `${sender.name}`,
      `${sender.business} · ${sender.website}`,
    ].join("\n"),
  };
}

function reviewAskCallOpener(lead: Lead, sender: Sender): string {
  return `Hi, it's ${sender.name} from ${sender.business} — just checking in now that ${lead.name}'s site has been live a couple of weeks. Everything working the way you'd hoped? [if yes] Would you mind a quick Google review, and is there anyone else you know who could use the same?`;
}

/** Won leads whose "Deployed" milestone has been done for >= 14 days and whose "Review/referral
 *  asked" milestone is still pending -- the drawer/CLI follow-up desk's second queue, alongside
 *  the regular next-action one in followups.ts. Read-only: it only decides what's due; nothing here
 *  updates the milestone (that stays `milestone <lead> "Review/referral asked" --state done`, run
 *  by hand once the ask has actually gone out). */
export function reviewAskQueue(db: Database, sender: Sender = DEFAULT_SENDER, now = new Date(), minDays = REVIEW_ASK_DAYS): ReviewAsk[] {
  const won = listLeads(db, { status: "won", limit: 500 });
  const today = sydneyDate(now);
  const out: ReviewAsk[] = [];
  for (const lead of won) {
    const kickoff = getKickoff(db, lead.id);
    if (!kickoff) continue;
    const deployed = kickoff.milestones.find((m) => m.name.toLowerCase() === "deployed");
    const asked = kickoff.milestones.find((m) => m.name.toLowerCase() === "review/referral asked");
    if (!deployed || deployed.state !== "done" || !deployed.completedAt) continue;
    if (asked && asked.state === "done") continue;
    const days = Math.floor((new Date(`${today}T00:00:00+10:00`).getTime() - new Date(`${deployed.completedAt}T00:00:00+10:00`).getTime()) / 86_400_000);
    if (days < minDays) continue;
    const canEmail = lead.emailOk && lead.emails.length > 0;
    const draft: ReviewAskDraft = canEmail
      ? { channel: "email", to: lead.emails[0], ...reviewAskEmail(lead, sender) }
      : { channel: "call", opener: reviewAskCallOpener(lead, sender) };
    out.push({ leadId: lead.id, name: lead.name || "(name expired: refresh)", deployedAt: deployed.completedAt, daysSinceDeployed: days, draft });
  }
  return out.sort((a, b) => b.daysSinceDeployed - a.daysSinceDeployed);
}

export function renderReviewAsk(r: ReviewAsk): string {
  const head = `#${r.leadId} ${r.name} · deployed ${r.deployedAt} (${r.daysSinceDeployed}d ago) · REVIEW/REFERRAL ASK DUE`;
  const draftLine = r.draft.channel === "email" ? `Draft email → ${r.draft.to}: ${r.draft.subject}\n${r.draft.body}` : `Draft call: ${r.draft.opener}`;
  return [head, draftLine, `Once sent: milestone ${r.leadId} "Review/referral asked" --state done`].join("\n");
}

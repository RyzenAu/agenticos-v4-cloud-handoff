// Text rendering for call coaching. The score itself is judged elsewhere (the `call-outcome`
// Hermes skill, reading the founder's own debrief against the 100-point rubric in
// crm.ts's COACH_MAX) — this module only formats what's already been recorded.
import type { CoachCategory, CoachingSummary, CoachNote } from "./crm";
import { COACH_MAX } from "./crm";

const LABEL: Record<CoachCategory, string> = {
  opener: "Opener", discovery: "Discovery", value: "Value & fit", objection: "Objection handling",
  nextStep: "Next step", delivery: "Delivery",
};

export function renderCoachNote(note: CoachNote): string {
  const cats = Object.entries(note.categories)
    .map(([c, pts]) => `${LABEL[c as CoachCategory]} ${pts}/${COACH_MAX[c as CoachCategory]}`)
    .join(", ");
  const notObserved = (Object.keys(LABEL) as CoachCategory[]).filter((c) => !(c in note.categories));
  return [
    `Coaching #${note.leadId} · score ${note.score}/100${note.objectionTag ? ` · objection: ${note.objectionTag}` : ""}`,
    cats ? `Scored: ${cats}` : "Scored: nothing (debrief didn't cover the call structure)",
    notObserved.length ? `Not observed: ${notObserved.map((c) => LABEL[c]).join(", ")}` : "",
    `What worked: ${note.worked || "insufficient data"}`,
    `To improve: ${note.improve || "insufficient data"}`,
    `Next step: ${note.nextStep || "none secured"}`,
    "(from the founder's own debrief — no audio or transcript is stored.)",
  ].filter(Boolean).join("\n");
}

export function renderCoachingSummary(s: CoachingSummary): string {
  if (!s.count) return `No coaching notes in the last ${s.days} day${s.days === 1 ? "" : "s"}${s.who ? ` for ${s.who}` : ""}.`;
  const byCategory = (Object.entries(s.averageByCategory) as [CoachCategory, number][])
    .map(([c, avg]) => `${LABEL[c]} ${avg}/${COACH_MAX[c]}`)
    .join(", ");
  return [
    `Coaching, last ${s.days} day${s.days === 1 ? "" : "s"}${s.who ? ` (${s.who})` : ""}: ${s.count} call${s.count === 1 ? "" : "s"} scored, average ${s.averageScore}/100.`,
    byCategory ? `By category: ${byCategory}` : "",
    s.topObjection ? `Most common objection: ${s.topObjection.tag} (${s.topObjection.count}×)` : "No objection tagged.",
    s.repeatedImprovement
      ? `Recurring improvement: "${s.repeatedImprovement.text}" (${s.repeatedImprovement.count}×)`
      : "No repeated improvement theme yet.",
  ].filter(Boolean).join("\n");
}

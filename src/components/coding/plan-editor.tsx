// Edit a drafted plan before Start: the objective, the words of each done-when line, extra checks and non-goals.
// A done-when line can be reworded but not removed (taking a check away would weaken the final check), and what the
// gate runs (its test or evidence) is not editable here. Saving makes a new revision; the old Start no longer works.
import { useState } from "react";
import { Button } from "@/components/ds";

export type PlanPatch = { objective?: string; doneWhen?: { id?: string; text: string }[]; nonGoals?: string[] };
type Plan = { objective: string; doneWhen: readonly { id: string; text: string; evidence: string }[]; nonGoals: readonly string[] };

/** What changed against the plan on screen, as the patch the server takes; null when nothing did. Pure (the tests use it). */
export function planPatchFrom(plan: Plan, edit: { objective: string; lines: Record<string, string>; added: string; nonGoals: string }): PlanPatch | null {
  const patch: PlanPatch = {};
  const objective = edit.objective.replace(/\s+/g, " ").trim();
  if (objective && objective !== plan.objective.replace(/\s+/g, " ").trim()) patch.objective = objective;
  const changed = plan.doneWhen.filter((d) => (edit.lines[d.id] ?? d.text).replace(/\s+/g, " ").trim() !== d.text.replace(/\s+/g, " ").trim());
  const extra = edit.added.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (changed.length || extra.length) patch.doneWhen = [...changed.map((d) => ({ id: d.id, text: edit.lines[d.id].trim() })), ...extra.map((text) => ({ text }))];
  const goals = edit.nonGoals.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (goals.join("\n") !== plan.nonGoals.join("\n")) patch.nonGoals = goals;
  return Object.keys(patch).length ? patch : null;
}

export function PlanEditor({ plan, busy, onSave }: { plan: Plan; busy: boolean; onSave: (patch: PlanPatch) => void }) {
  const [objective, setObjective] = useState(plan.objective);
  const [lines, setLines] = useState<Record<string, string>>(() => Object.fromEntries(plan.doneWhen.map((d) => [d.id, d.text])));
  const [added, setAdded] = useState("");
  const [nonGoals, setNonGoals] = useState(plan.nonGoals.join("\n"));
  const patch = planPatchFrom(plan, { objective, lines, added, nonGoals });
  const field = "w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <form className="flex flex-col gap-3" aria-label="Edit the plan" onSubmit={(e) => { e.preventDefault(); if (patch) onSave(patch); }}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">What should change</span>
        <textarea className={field} rows={3} value={objective} disabled={busy} onChange={(e) => setObjective(e.target.value)} />
      </label>
      <fieldset className="flex flex-col gap-2" disabled={busy}>
        <legend className="text-sm font-medium">Done when</legend>
        {plan.doneWhen.map((d) => (
          <label key={d.id} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>{d.evidence === "reviewer-confirms" ? "The reviewer confirms" : `Checked by ${d.evidence}`}</span>
            <input className={field} value={lines[d.id] ?? d.text} onChange={(e) => setLines((l) => ({ ...l, [d.id]: e.target.value }))} />
          </label>
        ))}
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>Add checks for the reviewer to confirm (one per line)</span>
          <textarea className={field} rows={2} value={added} onChange={(e) => setAdded(e.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">A check can be reworded or added to, never removed here. Rewording is your call: keep each line as strict as the work needs.</p>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Not included (one per line)</span>
        <textarea className={field} rows={2} value={nonGoals} disabled={busy} onChange={(e) => setNonGoals(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className="rounded-full" disabled={busy || !patch}>Save the changes</Button>
        <span className="text-xs text-muted-foreground">{patch ? "Saving makes a new version of the plan; you start that one." : "No changes yet."}</span>
      </div>
    </form>
  );
}

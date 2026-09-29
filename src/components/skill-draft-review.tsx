import { useState } from "react";
import { Badge, Button, EmptyState } from "@/components/ds";
import { fmtDateTime } from "@/lib/format";

// Minimal review list for narrated-workflow skill drafts (scripts/meeting-mode/narrate-store.ts
// writes .operator-data/skill-drafts/<id>.json; nothing here reads that file directly — this is a
// presentational component, wired up wherever a route already fetches its own data, same pattern
// as DreamMorningReport). One draft can be approved (writes the SKILL.md), edited inline, or
// discarded — never anything automatic. Deleting a draft is a separate, deliberate action.

export type SkillDraftDecisionPoint = { step: string; requiresApproval: boolean; why: string };
export type SkillDraftRow = {
  id: string;
  name: string;
  title: string;
  summary: string;
  steps: string[];
  tools: string[];
  decisionPoints: SkillDraftDecisionPoint[];
  topic: string;
  status: "draft" | "approved" | "discarded";
  createdAt: string;
  installedTo?: string[];
};

export type SkillDraftEdit = { title: string; summary: string; steps: string[]; tools: string[] };

const time = (iso: string) => fmtDateTime(new Date(iso), { weekday: true, timeZone: "Australia/Sydney" });
const linesToList = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);

function DraftRow({ draft, onApprove, onEdit, onDiscard }: {
  draft: SkillDraftRow;
  onApprove: (id: string) => void;
  onEdit: (id: string, patch: SkillDraftEdit) => void;
  onDiscard: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [summary, setSummary] = useState(draft.summary);
  const [steps, setSteps] = useState(draft.steps.join("\n"));
  const [tools, setTools] = useState(draft.tools.join("\n"));
  const approvals = draft.decisionPoints.filter((d) => d.requiresApproval);
  const save = () => {
    onEdit(draft.id, { title: title.trim() || draft.title, summary: summary.trim(), steps: linesToList(steps), tools: linesToList(tools) });
    setEditing(false);
  };
  return (
    <details className="group rounded-xl border border-border bg-inset px-4 py-3" open={draft.status === "draft"}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{draft.title}</span>
        <Badge tone={draft.status === "approved" ? "accent" : draft.status === "discarded" ? "neutral" : "info"}>{draft.status}</Badge>
        {approvals.length > 0 && <Badge tone="warn">{approvals.length} step{approvals.length === 1 ? "" : "s"} need your yes</Badge>}
        <span className="text-xs text-muted-foreground">{time(draft.createdAt)}</span>
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-muted-foreground">
          From narrating "{draft.topic}". A draft only — nothing was installed until this is approved.
        </p>
        {editing ? (
          <div className="space-y-2">
            <input className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
            <textarea className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Summary" />
            <textarea className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs" rows={5} value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="One step per line" />
            <textarea className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs" rows={2} value={tools} onChange={(e) => setTools(e.target.value)} placeholder="One tool per line" />
            <div className="flex gap-2">
              <Button size="sm" onClick={save}>Save changes</Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-foreground">{draft.summary}</p>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-foreground">
              {draft.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {draft.tools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {draft.tools.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}
            {approvals.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {approvals.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium text-foreground">{d.step}</span> — {d.why}
                  </li>
                ))}
              </ul>
            )}
            {draft.status === "draft" && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" onClick={() => onApprove(draft.id)}>Approve — build it</Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => onDiscard(draft.id)}>Discard</Button>
              </div>
            )}
            {draft.status === "approved" && draft.installedTo?.length ? (
              <p className="text-xs text-muted-foreground">Installed to {draft.installedTo.join(", ")}.</p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

export function SkillDraftReview({ drafts, onApprove, onEdit, onDiscard }: {
  drafts: SkillDraftRow[];
  onApprove: (id: string) => void;
  onEdit: (id: string, patch: SkillDraftEdit) => void;
  onDiscard: (id: string) => void;
}) {
  if (!drafts.length) return <EmptyState title="No skill drafts yet" body={'Say "Jarvis, I\'m going to walk you through how I do X", then "that\'s it" when done.'} />;
  return (
    <div className="space-y-2" data-testid="skill-draft-review">
      {drafts.map((d) => (
        <DraftRow key={d.id} draft={d} onApprove={onApprove} onEdit={onEdit} onDiscard={onDiscard} />
      ))}
    </div>
  );
}

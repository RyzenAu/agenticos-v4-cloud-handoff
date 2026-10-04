// "Mark superseded": a paused job whose work landed another way (a successor job or a hand fix) is closed, with the
// reason on record, instead of sitting in Needs you. Offered only while the job is paused; where the files it was about
// already have newer commits on the base branch, the reason and commit are filled in for you to check. Closing is
// permanent (the history and working copies stay) and, like every coding action, needs you signed in.
import { useState } from "react";
import { Button, Notice } from "@/components/ds";
import type { JobView } from "@/lib/coding-client";

export const SUPERSEDABLE = ["needs_owner", "blocked_allowance", "interrupted", "awaiting_approval"] as const;

export function SupersedeControl({ view, busy, onSupersede }: { view: JobView; busy: boolean; onSupersede: (ref: string, reason: string) => Promise<void> }) {
  const job = view.job;
  const hint = view.supersedeHint ?? null;
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (job.supersededBy || !(SUPERSEDABLE as readonly string[]).includes(job.state)) return null;
  const refValue = ref ?? hint?.ref ?? "";
  const reasonValue = reason ?? hint?.reason ?? "";
  const ready = /^[A-Za-z0-9._/-]{1,100}$/.test(refValue.trim()) && reasonValue.trim().length >= 5;
  async function submit() {
    setError(null);
    try { await onSupersede(refValue.trim(), reasonValue.trim()); setOpen(false); }
    catch (e) { setError((e as Error).message); }
  }
  const form = (
    <form className="mt-3 flex max-w-xl flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }} aria-label="Mark this job superseded">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Replaced by (commit or branch)</span>
        <input className="ds-interactive min-h-11 rounded-xl border border-border bg-background px-3 text-sm" value={refValue} onChange={(e) => setRef(e.target.value)} placeholder="a1b2c3d or r4/coding-jobs" spellCheck={false} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Why</span>
        <textarea className="ds-interactive min-h-20 rounded-xl border border-border bg-background px-3 py-2 text-sm" value={reasonValue} onChange={(e) => setReason(e.target.value)} rows={3} />
      </label>
      <p className="text-xs text-muted-foreground">This closes the job for good. Its history, working copies and receipts are kept; Resume and Apply are refused. Nothing is merged or deleted.</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || busy}>Mark superseded</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Keep it open</Button>
      </div>
    </form>
  );
  return hint ? (
    <Notice tone="info" title="Newer work may already cover this" className="mb-6">
      <span data-testid="supersede-hint">{hint.reason}.</span>
      {!open && <div className="mt-3"><Button variant="outline" disabled={busy} onClick={() => setOpen(true)}>Mark superseded</Button></div>}
      {open && form}
    </Notice>
  ) : (
    <div className="mb-6">
      {!open ? <Button variant="ghost" className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left" disabled={busy} onClick={() => setOpen(true)}>This work landed another way? Mark superseded</Button> : <div className="rounded-2xl border border-border bg-card p-5">{form}</div>}
    </div>
  );
}

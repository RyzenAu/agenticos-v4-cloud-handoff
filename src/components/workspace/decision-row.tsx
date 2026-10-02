import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Notice, RouteText } from "@/components/ds";
import { Textarea } from "@/components/ui/textarea";
import { operatorRequest } from "@/lib/operator";
import { fmtProse } from "@/lib/format";
import { refreshPanels, type Approval } from "./api";
import type { DecisionAnswer, DecisionRecord } from "../../../scripts/workspace/decisions";

export function DecisionRow({ item, record }: { item: Approval; record?: DecisionRecord }) {
  const client = useQueryClient();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState<DecisionAnswer>(record?.answer ?? "approved");
  const [note, setNote] = useState(record?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(reopen = false) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await operatorRequest("/workspace/decision", { id: item.id, revision: record?.revision ?? item.revision, answer: reopen ? "reopen" : answer, note });
      setEditing(false);
      await refreshPanels(client, ["today", "needsYou"]);
    } catch (e) { setError(e instanceof Error ? e.message : "Your decision couldn't be saved. Try again."); }
    finally { setBusy(false); }
  }
  return <li className="min-w-0 space-y-3 px-4 py-4" data-decision={item.id} data-approval-open={editing || undefined}>
    <div className="space-y-1"><h3 className="text-base font-medium leading-snug">{fmtProse(item.title)}</h3><p className="text-sm text-muted-foreground"><RouteText>{fmtProse(item.detail)}</RouteText></p>{item.progress && <p className="text-sm text-warn"><RouteText>{fmtProse(item.progress)}</RouteText></p>}</div>
    {record && <p className="text-sm text-muted-foreground">{record.answer === "completed" ? "Completed" : record.answer === "approved" ? "Approved" : "Declined"}{record.note ? ` · ${record.note}` : ""}</p>}
    {editing ? <form className="space-y-3" aria-label={`Decision: ${item.title}`} onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="space-y-2"><label htmlFor={`${id}-answer`} className="block text-sm">Your decision</label><select id={`${id}-answer`} value={answer} onChange={e => setAnswer(e.target.value as DecisionAnswer)} disabled={busy} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="approved">Approve</option><option value="declined">Decline</option><option value="completed">Mark completed</option></select></div>
      <label htmlFor={`${id}-note`} className="block space-y-2"><span className="text-sm">Decision note (optional)</span><Textarea id={`${id}-note`} value={note} onChange={e => setNote(e.target.value)} maxLength={200} disabled={busy} rows={2} /></label>
      <p className="text-sm text-muted-foreground">This records your answer. Actions run through their own controls.</p>
      <div className="flex flex-wrap gap-2"><Button type="submit" variant="accent" disabled={busy}>{busy ? "Saving…" : "Save decision"}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
    </form> : <div className="flex flex-wrap gap-2">
      {(item.recordable || record) && <Button variant="accent" disabled={busy} onClick={() => setEditing(true)}>{record ? "Edit decision" : "Record decision"}</Button>}
      {record && <Button variant="outline" disabled={busy} onClick={() => void save(true)}>{busy ? "Reopening…" : "Reopen"}</Button>}
      <Button asChild variant="outline"><a href={item.href} {...(!item.href.startsWith("/") ? { target: "_blank", rel: "noreferrer" } : {})}>{item.recordable || record ? "Open details" : "Review evidence"}</a></Button>
    </div>}
    {error && <Notice tone="danger" title="Decision wasn't saved">{error}</Notice>}
  </li>;
}

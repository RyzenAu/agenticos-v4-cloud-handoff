import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Details, Notice, RouteText } from "@/components/ds";
import { Textarea } from "@/components/ui/textarea";
import { operatorRequest } from "@/lib/operator";
import { isNeedsConfirm } from "@/lib/needs-confirm";
import { useBrowserPending } from "@/components/shell/signed-in";
import { fmtProse } from "@/lib/format";
import { refreshPanels, type Approval } from "./api";
import type { DecisionAnswer, DecisionRecord } from "../../../scripts/workspace/decisions";

/** Setting names the owner shouldn't have to read in a decision. The stored record is not changed: the raw names sit in a folded "Technical names" line. */
const PLAIN_SETTING: Record<string, string> = {
  TRUST_PROXY_HEADERS: "the trusted-proxy setting",
};
const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
export function plainSettingNames(text: string): { plain: string; raw: string[] } {
  const raw: string[] = [];
  const plain = text.replace(SETTING_NAME, (name) => {
    if (!raw.includes(name)) raw.push(name);
    return PLAIN_SETTING[name] ?? `the ${name.toLowerCase().replace(/_/g, " ")} setting`;
  });
  return { plain, raw };
}

/** Said once above a list of decisions, only while this browser is unconfirmed (not under every row). */
export function PendingBrowserNote() {
  const pending = useBrowserPending();
  if (!pending) return null;
  return <p className="text-sm text-muted-foreground" data-testid="decisions-pending-note">Confirm this browser first: it can't record decisions until you do.</p>;
}

/** `bare`: inside the decision drawer, whose header already shows the title. */
export function DecisionRow({ item, record, bare = false }: { item: Approval; record?: DecisionRecord; bare?: boolean }) {
  const client = useQueryClient();
  // An unconfirmed browser cannot approve anything (the banner says so, and the server refuses): the button says why instead of failing.
  const pending = useBrowserPending();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState<DecisionAnswer>(record?.answer ?? "approved");
  const [note, setNote] = useState(record?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keyboard and screen-reader users: opening the form moves focus into it, closing it puts focus back on the button that opened it.
  const answerRef = useRef<HTMLSelectElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) answerRef.current?.focus();
    else if (wasEditing.current) openerRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  // Escape closes the form only while nothing has been changed: typed input is never thrown away by a stray key.
  const untouched = answer === (record?.answer ?? "approved") && note === (record?.note ?? "");
  async function save(reopen = false) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await operatorRequest("/workspace/decision", { id: item.id, revision: record?.revision ?? item.revision, answer: reopen ? "reopen" : answer, note });
      setEditing(false);
      await refreshPanels(client, ["today", "needsYou"]);
    } catch (e) {
      setError(isNeedsConfirm(e) ? "This browser isn't confirmed yet, so it can't record decisions. Confirm it first (System › Devices and people); what you typed is kept." : e instanceof Error ? e.message : "Your decision couldn't be saved. Try again.");
    }
    finally { setBusy(false); }
  }
  const names = { title: plainSettingNames(fmtProse(item.title)), detail: plainSettingNames(fmtProse(item.detail)) };
  const rawNames = [...new Set([...names.title.raw, ...names.detail.raw])];
  return <li className="min-w-0 space-y-3 px-4 py-4" data-decision={item.id} data-approval-open={editing || undefined}>
    <div className="space-y-1">{!bare && <h3 className="text-base font-medium leading-snug">{names.title.plain}</h3>}<p className="text-sm text-muted-foreground"><RouteText>{names.detail.plain}</RouteText></p>{item.progress && <p className="text-sm text-warn"><RouteText>{fmtProse(item.progress)}</RouteText></p>}</div>
    {record && <p className="text-sm text-muted-foreground">{record.answer === "completed" ? "Completed" : record.answer === "approved" ? "Approved" : "Declined"}{record.note ? ` · ${record.note}` : ""}</p>}
    {editing ? <form className="space-y-3" aria-label={`Decision: ${item.title}`} onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { if (e.key === "Escape" && untouched && !busy) { e.stopPropagation(); setEditing(false); } }}>
      <div className="space-y-2"><label htmlFor={`${id}-answer`} className="block text-sm">Your decision</label><select ref={answerRef} id={`${id}-answer`} value={answer} onChange={e => setAnswer(e.target.value as DecisionAnswer)} disabled={busy} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="approved">Approve</option><option value="declined">Decline</option><option value="completed">Mark completed</option></select></div>
      <label htmlFor={`${id}-note`} className="block space-y-2"><span className="text-sm">Decision note (optional)</span><Textarea id={`${id}-note`} value={note} onChange={e => setNote(e.target.value)} maxLength={200} disabled={busy} rows={2} /></label>
      <p className="text-sm text-muted-foreground">This records your answer. Actions run through their own controls.</p>
      <div className="flex flex-wrap gap-2"><Button type="submit" variant="accent" disabled={busy}>{busy ? "Saving…" : "Save decision"}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
    </form> : <div className="flex flex-wrap gap-2">
      {(item.recordable || record) && <Button ref={openerRef} variant="accent" disabled={busy || pending} title={pending ? "Confirm this browser first" : undefined} onClick={() => setEditing(true)}>{record ? "Edit decision" : "Record decision"}</Button>}
      {record && <Button variant="outline" disabled={busy || pending} onClick={() => void save(true)}>{busy ? "Reopening…" : "Reopen"}</Button>}
      <Button asChild variant="outline"><a href={item.href} {...(!item.href.startsWith("/") ? { target: "_blank", rel: "noreferrer" } : {})}>{item.recordable || record ? "Open details" : "Review evidence"}</a></Button>
    </div>}
    {error && <Notice tone="danger" title="Decision wasn't saved">{error}</Notice>}
    {rawNames.length > 0 && <Details summary="Technical names" items={rawNames.map((n) => ({ label: "Setting", value: n, mono: true }))} />}
  </li>;
}

import { useEffect, useId, useState } from "react";
import { Button, Notice } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { leadsApi, STATUSES, statusLabel, VERTICALS, VERTICAL_LABEL, type Lead, type Owner } from "@/lib/leads";

function localDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export type EditForm = { name: string; phone: string; emails: string; address: string; website: string; area: string; vertical: string; owner: string; status: string; followUp: string };
export const formFromLead = (lead: Lead): EditForm => ({ name: lead.name, phone: lead.phone, emails: lead.emails.join("\n"), address: lead.address, website: lead.website, area: lead.area, vertical: lead.vertical, owner: lead.owner, status: lead.status, followUp: localDate(lead.nextAt) });
/** The fields where `form` differs from `base`: the only thing a draft keeps. */
export function changedFields(base: EditForm, form: EditForm): Partial<EditForm> {
  const out: Partial<EditForm> = {};
  for (const key of Object.keys(base) as (keyof EditForm)[]) if (form[key] !== base[key]) out[key] = form[key];
  return out;
}
/**
 * Unfinished edits survive closing the drawer (Escape, the close button, a click outside) and a failed save, for this
 * page session. A draft holds ONLY the fields the person changed, and `base` is the record version they started from.
 * On reopening, those fields are laid over the freshly loaded record, so anything changed meanwhile (a call-back, a
 * status, the other founder's correction) is kept, and only the edited fields are sent. `base` is never rewritten
 * after the draft starts. A save or "Cancel editing" clears it. Nothing is written until Save lead.
 */
const leadEditDrafts = new Map<number, { base: string; changes: Partial<EditForm> }>();
export const hasLeadEditDraft = (id: number) => leadEditDrafts.has(id);
export const clearLeadEditDraft = (id: number) => { leadEditDrafts.delete(id); };
export const rememberLeadEditDraft = (id: number, base: string, changes: Partial<EditForm>) => { leadEditDrafts.set(id, { base, changes }); };

export function LeadEditor({ lead, by, onSaved, onCancel }: { lead: Lead; by: Owner; onSaved: (patch: Partial<Lead>) => void; onCancel: () => void }) {
  // Capture the revision once. Background reads never replace an unfinished edit.
  const [original] = useState(lead);
  const baseForm = useState(() => formFromLead(lead))[0];
  const [startedFrom] = useState(() => leadEditDrafts.get(lead.id) ?? null);
  const restored = !!startedFrom;
  // Fixed when the editor opens: the notice stays until the person saves or cancels.
  const changedSince = !!startedFrom && startedFrom.base !== (lead.editVersion ?? "");
  const [form, setForm] = useState<EditForm>(() => ({ ...baseForm, ...(startedFrom?.changes ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Choosing "Do not contact" is permanent (edit.ts refuses any later move away from it), so Save asks first.
  const [confirmDnc, setConfirmDnc] = useState(false);
  const id = useId();
  const set = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }));
  const patch: Partial<Lead> = {};
  for (const key of ["name", "phone", "address", "website", "area", "vertical", "owner", "status"] as const) if (form[key] !== original[key]) (patch as any)[key] = form[key];
  if (form.emails !== original.emails.join("\n")) patch.emails = form.emails.split(/\n/).map(s => s.trim()).filter(Boolean);
  if (form.followUp !== localDate(original.nextAt)) patch.nextAt = form.followUp ? new Date(form.followUp).toISOString() : null;
  useEffect(() => {
    const changes = changedFields(baseForm, form);
    if (Object.keys(changes).length) rememberLeadEditDraft(original.id, startedFrom?.base ?? original.editVersion ?? "", changes);
    else leadEditDrafts.delete(original.id);
  }, [form, baseForm, original.id, original.editVersion, startedFrom]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    if (patch.status === "do_not_contact" && original.status !== "do_not_contact" && !confirmDnc) { setConfirmDnc(true); return; }
    setConfirmDnc(false);
    setBusy(true); setError("");
    try {
      const result = await leadsApi.edit(original.id, { ...patch, version: original.editVersion ?? "", by });
      leadEditDrafts.delete(original.id);
      onSaved({ ...patch, status: result.lead.status, editVersion: result.lead.editVersion });
    } catch (e) { setError(e instanceof Error ? e.message : "Changes couldn't be saved. Try again."); }
    finally { setBusy(false); }
  }
  const field = (key: "name" | "phone" | "address" | "website" | "area", label: string, type = "text") => <label className="space-y-2" htmlFor={`${id}-${key}`}><span className="block text-sm text-muted-foreground">{label}</span><Input id={`${id}-${key}`} type={type} value={form[key]} onChange={e => set(key, e.target.value)} required={key === "name"} maxLength={key === "phone" ? 50 : 400} disabled={busy} /></label>;
  const select = (key: "owner" | "vertical" | "status", label: string, values: { value: string; label: string }[]) => <div className="space-y-2"><label className="block text-sm text-muted-foreground" htmlFor={`${id}-${key}`}>{label}</label><select id={`${id}-${key}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form[key]} onChange={e => set(key, e.target.value)} disabled={busy || key === "status" && original.status === "do_not_contact"}>{values.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
  return <form onSubmit={save} aria-label="Edit lead details" className="space-y-5 py-1">
    <fieldset disabled={busy} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      {field("name", "Business name")}{field("phone", "Phone", "tel")}
      {field("address", "Address")}{field("area", "Area")}
      {field("website", "Website", "url")}
      {select("vertical", "Industry", VERTICALS.map(value => ({ value, label: VERTICAL_LABEL[value] })))}
      {select("owner", "Assigned to", [{ value: "", label: "Unassigned" }, { value: "usman", label: "Usman" }, { value: "mehroz", label: "Mehroz" }])}
      {select("status", "Lead status", STATUSES.map(value => ({ value, label: statusLabel(value) })))}
      <label className="space-y-2" htmlFor={`${id}-followup`}><span className="block text-sm text-muted-foreground">Follow-up</span><Input id={`${id}-followup`} type="datetime-local" value={form.followUp} onChange={e => set("followUp", e.target.value)} /></label>
      <label className="space-y-2 sm:col-span-2" htmlFor={`${id}-emails`}><span className="block text-sm text-muted-foreground">Emails (one per line)</span><Textarea id={`${id}-emails`} value={form.emails} onChange={e => set("emails", e.target.value)} rows={3} /></label>
    </fieldset>
    {restored && <Notice tone="info" title="Your unsaved changes were restored">{changedSince ? "This lead changed after you started, so check each field against the current record before saving." : "Nothing was saved yet. Save lead to keep them, or Cancel editing to discard them."}</Notice>}
    {lead.placesLive && <p className="text-sm text-muted-foreground">Only changed fields are saved. Check replacements against the business's own details.</p>}
    {error && <Notice tone="danger" title="Changes weren't saved">{error}</Notice>}
    {confirmDnc && <div className="rounded-lg border border-danger/40 p-3" role="alertdialog" aria-label="Confirm do not contact">
      <p className="text-sm text-foreground" role="status">Do not contact is permanent: once saved, this lead's status cannot be changed away from it. Your other edits are saved with it.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDnc(false)}>Cancel</Button>
        <Button type="submit" size="sm" variant="outline" className="text-danger hover:text-danger" disabled={busy}>Confirm: do not contact</Button>
      </div>
    </div>}
    <div className="flex flex-wrap gap-2"><Button type="submit" variant="accent" disabled={busy || confirmDnc || !Object.keys(patch).length || !original.editVersion}>{busy ? "Saving…" : "Save lead"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { leadEditDrafts.delete(original.id); onCancel(); }}>Cancel editing</Button></div>
  </form>;
}

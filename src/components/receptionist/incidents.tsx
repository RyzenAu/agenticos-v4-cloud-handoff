import { useId, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button, Notice } from "@/components/ds";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useReceptionistActions, type Incident } from "@/lib/receptionist";
import { callTime, maskedCaller } from "./format";

/** Flagged callers, rendered inside the decision block (one alert, not two competing banners). */
export function Incidents({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) return null;
  return <div className="mt-4 border-t border-border pt-3">
    <p className="ds-label text-xs text-danger">Callers to follow up</p>
    <ul className="divide-y divide-border">{incidents.map(incident => <li key={incident.callId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="min-w-0 break-words text-xs text-foreground">{callTime(incident.startedAt)} · {maskedCaller(incident.from)} · {incident.consequence}</p>
      <div className="flex shrink-0 items-center gap-2">
        {incident.retellUrl && <Button variant="ghost" size="icon-sm" asChild><a href={incident.retellUrl} target="_blank" rel="noreferrer" aria-label="Open in Retell" title="Open in Retell"><ExternalLink aria-hidden="true" /></a></Button>}
        {/^call_[A-Za-z0-9]{6,64}$/.test(incident.callId) && !incident.followedUp && <FollowUpDialog incident={incident} />}
      </div>
    </li>)}</ul>
  </div>;
}

export function FollowUpDialog({ incident }: { incident: Incident }) {
  const actions = useReceptionistActions();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try { await actions.followUp(incident.callId, note); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Follow-up couldn't be saved."); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setNote(""); setError(null); } }}>
    <DialogTrigger asChild><Button variant="outline" size="sm" className="h-10 rounded-full px-4">Mark followed up</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
      <DialogHeader><DialogTitle>Mark caller followed up</DialogTitle><DialogDescription>Confirm you have followed up with {maskedCaller(incident.from)} about the call on {callTime(incident.startedAt)}.</DialogDescription></DialogHeader>
      <div className="space-y-2"><label htmlFor={noteId} className="text-xs text-muted-foreground">Note (optional)</label><Input id={noteId} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></div>
      {error && <Notice tone="danger" title="Follow-up couldn't be saved">{error}</Notice>}
      <DialogFooter><Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="accent" size="sm" onClick={confirm} disabled={busy}>{busy ? "Saving…" : "Mark followed up"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

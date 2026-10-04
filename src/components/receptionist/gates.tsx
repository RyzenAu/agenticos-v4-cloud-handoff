import { useId, useState, type ReactNode } from "react";
import { Circle, CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { Button, ChecklistRow, Disclosure, InfoTip, Notice, Section, fmtRelative, type ChecklistStatus } from "@/components/ds";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useReceptionistActions, type Blocker, type ReceptionistSnapshot } from "@/lib/receptionist";

const STATE_BADGE: Record<Blocker["state"], { label: string; tone: "success" | "danger" | "warn" | "neutral" }> = {
  pass: { label: "Pass", tone: "success" },
  // Calm by design (D1): a failing gate is warn, not danger. The overall verdict carries the alarm.
  fail: { label: "Fail", tone: "warn" },
  "not-tested": { label: "Not tested", tone: "neutral" },
  open: { label: "Awaiting owner sign-off", tone: "neutral" },
  "evidence-missing": { label: "Evidence missing", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
};

const STATE_ICON: Record<Blocker["state"], ReactNode> = {
  pass: <CircleCheck className="size-[18px] text-success" strokeWidth={1.75} />,
  fail: <CircleX className="size-[18px] text-warn" strokeWidth={1.75} />,
  "not-tested": <Circle className="size-[18px] text-muted-foreground" strokeWidth={1.75} />,
  open: <Circle className="size-[18px] text-muted-foreground" strokeWidth={1.75} />,
  "evidence-missing": <CircleDashed className="size-[18px] text-warn" strokeWidth={1.75} />,
  unknown: <CircleDashed className="size-[18px] text-muted-foreground" strokeWidth={1.75} />,
};

const STATE_TEXT: Record<"success" | "danger" | "warn" | "neutral", string> = {
  success: "text-success",
  danger: "text-danger",
  warn: "text-warn",
  neutral: "text-muted-foreground",
};

const FACT_STATUS: Record<"ok" | "warn" | "bad" | "neutral", { status: ChecklistStatus; word: string }> = {
  ok: { status: "met", word: "Met" },
  warn: { status: "not-met", word: "Needs attention" },
  bad: { status: "not-met", word: "Not met" },
  // Review F2: a neutral fact is one whose source couldn't be read ("SMS: Unknown"): Unknown, never Info.
  neutral: { status: "unknown", word: "Unknown" },
};

export const GATES_SECTION_ID = "rx-gates";

export function Gates({ data, automated }: { data: ReceptionistSnapshot["readiness"]; automated?: string }) {
  const passed = data.blockers.filter(b => b.state === "pass").length;
  const total = data.blockers.length;
  return <Section
    id={GATES_SECTION_ID}
    title="Go-live gates"
    className="scroll-mt-6"
    actions={<>
      <span className="ds-num text-sm text-muted-foreground">{passed} of {total} passed</span>
      <InfoTip label="About the gates">Each gate turns green only from evidence or an owner sign-off. Open a gate for its evidence and next step.</InfoTip>
    </>}
  >
    <ol className="divide-y divide-border rounded-2xl border border-border bg-card p-2 shadow-sm">{data.blockers.map(blocker => <li key={blocker.id} className="py-1"><GateRow blocker={blocker} /></li>)}</ol>
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>Automated tests: {automated || "Not available"}</span>
      <span>Owner retests: {data.ownerRetestCalls ? `${data.ownerRetestCalls.count}/${data.ownerRetestCalls.target}` : "not tracked"}</span>
      <InfoTip label="About the evidence" align="start">
        <span className="block">Automated test evidence: {automated || "Not available"}. Automated checks do not replace owner test calls.</span>
        <span className="mt-1 block">{ownerRetestLabel(data)}</span>
      </InfoTip>
    </div>
    {data.facts.length > 0 && <>
      <h3 className="mt-8 mb-2 text-sm font-medium text-foreground">Also needed to sell</h3>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-5 py-1 shadow-sm">{data.facts.map(fact =>
        <ChecklistRow key={fact.id} status={FACT_STATUS[fact.tone].status} statusText={FACT_STATUS[fact.tone].word} label={fact.label} detail={fact.detail} data-fact={fact.id} />
      )}</ul>
    </>}
  </Section>;
}

export function ownerRetestLabel(data: ReceptionistSnapshot["readiness"]) {
  return data.ownerRetestCalls
    ? `Owner retest calls: ${data.ownerRetestCalls.count} of ${data.ownerRetestCalls.target}`
    : "Owner retest calls: not yet tracked — count from Retell call history";
}

/** One gate: its state at a glance; evidence, next step and sign-off history one click away. */
export function GateRow({ blocker }: { blocker: Blocker }) {
  const badge = STATE_BADGE[blocker.state];
  return <div data-gate={blocker.id} data-state={blocker.state}>
    <Disclosure
      icon={STATE_ICON[blocker.state]}
      summary={<span className="font-medium">{blocker.title}</span>}
      meta={<span className={STATE_TEXT[badge.tone]}>{badge.label}</span>}
      aside={blocker.mode === "manual" ? <BlockerDialog blocker={blocker} /> : undefined}
    >
      <div className="space-y-2 pl-8 text-xs leading-relaxed text-muted-foreground">
        {blocker.stateNote && blocker.stateNote !== "Needs sign-off" && <p className="break-words">{blocker.stateNote}</p>}
        {blocker.evidence.length > 0 && <ul className="space-y-1">{blocker.evidence.slice(0, 3).map((line, i) => <li key={i} className="break-words">{line}</li>)}</ul>}
        {blocker.state !== "pass" && <p className="break-words text-foreground"><span className="font-medium">Next:</span> {blocker.next}</p>}
        {/* Only a standing sign-off says "Signed off"; a reopened gate says who reopened it (RX-4). */}
        {blocker.signedOff && blocker.done && <p className="break-words">Signed off by {blocker.signedOff.by} · {fmtRelative(blocker.signedOff.at)}</p>}
        {blocker.reopened && <p className="break-words">Reopened by {blocker.reopened.by} · {fmtRelative(blocker.reopened.at)}</p>}
      </div>
    </Disclosure>
    {/* Contrary evidence after a sign-off stays visible, never folded away. */}
    {blocker.warning && <p className="mx-3 mb-2 ml-11 rounded-xl bg-warn-soft px-3 py-2 text-xs text-foreground">{blocker.warning}</p>}
  </div>;
}

function BlockerDialog({ blocker }: { blocker: Blocker }) {
  const actions = useReceptionistActions();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = blocker.done ? "Reopen" : "Sign off";
  // Sol, round 2: no sign-off on a failing or untested gate — test it on a real call first.
  const disabled = !blocker.done && (blocker.state === "fail" || blocker.state === "not-tested" || blocker.state === "evidence-missing" || blocker.state === "unknown");
  async function confirm() {
    setBusy(true);
    setError(null);
    try { await actions.setBlocker(blocker.id, !blocker.done, note); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-off couldn't be saved."); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setNote(""); setError(null); } }}>
    <DialogTrigger asChild><Button variant="outline" size="sm" className="h-10 rounded-full px-4" disabled={disabled} title={disabled ? (blocker.state === "evidence-missing" ? blocker.next : blocker.state === "fail" ? "Fix the failing call first" : blocker.state === "unknown" ? "The Retell calls couldn't be read: refresh first" : "Make a real test call since the last prompt change first") : undefined}>{label}</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
      <DialogHeader><DialogTitle>{label}: {blocker.title}</DialogTitle><DialogDescription>{blocker.done ? "Reopen this blocker so it needs an owner sign-off again." : "Confirm you have reviewed the evidence and completed the next step."}</DialogDescription></DialogHeader>
      <div className="space-y-2"><label htmlFor={noteId} className="text-xs text-muted-foreground">Note (optional)</label><Input id={noteId} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></div>
      {error && <Notice tone="danger" title="Change couldn't be saved">{error}</Notice>}
      <DialogFooter><Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="accent" size="sm" onClick={confirm} disabled={busy}>{busy ? "Saving…" : `Confirm ${label.toLowerCase()}`}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

import { honestWebsiteText } from "@/lib/call-queue";
// Kanban board by pipeline stage. Dragging a card to a later sales stage (or "Lost") opens a
// confirm that writes one activity on the lead — the same record a founder would log by hand —
// and the stage then follows from that evidence. Every card also has a "Move to…" menu, so the
// board works fully from the keyboard. Delivery stages move with kickoff milestones, not here.
import { useMemo, useState } from "react";
import { ChevronDown, GripVertical, Loader2 } from "lucide-react";
import { Badge, Button, Notice, Segmented } from "@/components/ds";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { aud, leadsApi, STAGE_LABEL, STAGES, suburbOf, VERTICAL_LABEL, type BoardLead, type MoveTarget, type Owner, type Stage, type Vertical } from "@/lib/leads";

type Column = { key: string; label: string; stages: Stage[]; drop: MoveTarget | null; hint: string };
const COLUMNS: Column[] = [
  { key: "prospects", label: "Prospects", stages: ["found", "verified", "scored", "audited", "preview"], drop: null, hint: "Not contacted yet — best score first" },
  { key: "contacted", label: "Contacted", stages: ["contacted"], drop: "contacted", hint: "First call or email logged" },
  { key: "replied", label: "Replied", stages: ["replied"], drop: "replied", hint: "Showed interest" },
  { key: "meeting", label: "Meeting", stages: ["meeting"], drop: "meeting", hint: "Discovery meeting booked or held" },
  { key: "proposal", label: "Proposal", stages: ["proposal"], drop: "proposal", hint: "Proposal out, awaiting reply" },
  { key: "won", label: "Won", stages: ["won"], drop: "won", hint: "Deposit or signature recorded" },
  { key: "delivery", label: "Delivery", stages: ["building", "QA", "launched", "care plan"], drop: null, hint: "Moves with kickoff milestones" },
];
const LOST: Column = { key: "lost", label: "Lost", stages: [], drop: "lost", hint: "Closed: lost, not interested or do not contact" };
const TARGET_LABEL: Record<MoveTarget, string> = { contacted: "Contacted", replied: "Replied", meeting: "Meeting", proposal: "Proposal", won: "Won", lost: "Lost" };
const CAP = 25;
const PROSPECT_CAP = 12;

/** Where this lead may be moved: later sales stages only, plus Lost while it's still a sale. */
export function allowedTargets(lead: BoardLead): MoveTarget[] {
  if (lead.excluded || lead.deal.closed || lead.status === "do_not_contact") return [];
  const at = STAGES.indexOf(lead.deal.stage);
  if (at >= STAGES.indexOf("won")) return [];
  const forward = (["contacted", "replied", "meeting", "proposal", "won"] as const).filter((t) => STAGES.indexOf(t) > at);
  return [...forward, "lost"];
}

export function LeadsBoard({ leads, by, onOpen, onMoved }: { leads: BoardLead[]; by: Owner; onOpen: (id: number) => void; onMoved: () => void }) {
  const [dragging, setDragging] = useState<BoardLead | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [move, setMove] = useState<{ lead: BoardLead; to: MoveTarget } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // The pre-contact column is capped (12, then "Show all"), so it can start open: folded, a board of only prospects looked empty.
  const [showProspects, setShowProspects] = useState(true);

  const grouped = useMemo(() => {
    const map = new Map<string, BoardLead[]>();
    for (const c of [...COLUMNS, LOST]) map.set(c.key, []);
    for (const l of leads) {
      if (l.excluded) continue;
      if (l.deal.closed) { map.get("lost")!.push(l); continue; }
      const col = COLUMNS.find((c) => c.stages.includes(l.deal.stage));
      if (col) map.get(col.key)!.push(l);
    }
    for (const [key, list] of map) {
      list.sort(key === "prospects"
        ? (a, b) => b.score - a.score
        : (a, b) => Number(!!b.deal.stuck) - Number(!!a.deal.stuck) || (b.deal.daysInStage ?? 0) - (a.deal.daysInStage ?? 0));
    }
    return map;
  }, [leads]);

  const canDrop = (col: Column) => !!dragging && !!col.drop && allowedTargets(dragging).includes(col.drop);

  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">
        <span className="hidden md:inline">Drag a card to a later stage, or use its “Move” menu.</span>
        <span className="md:hidden">Use “Move” on a card to change its stage.</span> A move writes one activity on the lead; nothing is sent.
      </p>
      {/* A way to reach the far columns on a narrow screen. On a wide one the columns are the stages, so the same names as chips above them said everything twice. */}
      <nav aria-label="Jump to a stage" className="mb-3 flex gap-1.5 overflow-x-auto pb-1 md:hidden">
        {[...COLUMNS, LOST].map((c) => (
          <button key={c.key} type="button"
            onClick={() => { if (c.key === "prospects") setShowProspects(true); requestAnimationFrame(() => document.getElementById(`board-col-${c.key}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" })); }}
            className="ds-interactive inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground">
            {c.label} <span className="ds-num font-medium text-foreground">{grouped.get(c.key)?.length ?? 0}</span>
          </button>
        ))}
      </nav>
      <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" role="region" aria-label="Pipeline board" tabIndex={0}>
        <div className="flex snap-x items-start gap-3" style={{ minWidth: "max-content" }}>
          {[...COLUMNS, LOST].map((col) => {
            const items = grouped.get(col.key) ?? [];
            const value = items.reduce((s, l) => s + l.deal.economics.valueCents, 0);
            const droppable = canDrop(col);
            const limit = col.key === "prospects" ? PROSPECT_CAP : CAP;
            const cap = expanded[col.key] ? items.length : limit;
            return (
              col.key === "prospects" && !showProspects ? (
                <section key={col.key} id={`board-col-${col.key}`} aria-label={`${col.label}: ${items.length}, folded`} className="flex w-[148px] shrink-0 snap-start flex-col gap-2 rounded-xl border border-dashed border-border p-3">
                  <h3 className="text-sm font-semibold text-foreground">{col.label} <span className="ds-num font-normal text-muted-foreground">{items.length}</span></h3>
                  <p className="text-xs leading-snug text-muted-foreground">Not contacted yet. Work these from “Today”.</p>
                  <Button variant="outline" size="xs" onClick={() => setShowProspects(true)}>Show</Button>
                </section>
              ) : (
              <section key={col.key} id={`board-col-${col.key}`} aria-label={`${col.label}: ${items.length}`}
                className={cn(
                  "flex w-[272px] shrink-0 snap-start flex-col rounded-xl border bg-inset p-2 transition-colors",
                  col.key === "lost" && "w-[220px]",
                  droppable ? "border-brand/50" : "border-border",
                  droppable && over === col.key && "bg-brand-soft",
                  dragging && !droppable && "opacity-60",
                )}
                onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(col.key); } }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => { e.preventDefault(); setOver(null); if (dragging && col.drop && droppable) setMove({ lead: dragging, to: col.drop }); setDragging(null); }}
              >
                <header className="flex items-baseline justify-between gap-2 px-1 pb-2">
                  <h3 className="text-sm font-semibold text-foreground">{col.label} <span className="ds-num font-normal text-muted-foreground">{items.length}</span></h3>
                  {col.key !== "prospects" && col.key !== "lost" && value > 0 && <span className="ds-num text-xs text-muted-foreground" title="First-year value, ex GST">{aud(value, { compact: true })} ex GST</span>}
                </header>
                <p className="px-1 pb-2 text-xs leading-snug text-muted-foreground">{col.hint}</p>
                <ol className="flex flex-col gap-1.5">
                  {items.slice(0, cap).map((l) => (
                    <BoardCard key={l.id} lead={l} dim={col.key === "lost"} onOpen={() => onOpen(l.id)} onMove={(to) => setMove({ lead: l, to })}
                      onDragStart={() => setDragging(l)} onDragEnd={() => { setDragging(null); setOver(null); }} />
                  ))}
                </ol>
                {items.length > limit && (
                  <Button variant="ghost" size="xs" className="mt-1.5" onClick={() => setExpanded((x) => ({ ...x, [col.key]: !x[col.key] }))}>
                    {expanded[col.key] ? "Show fewer" : `Show all ${items.length}`}
                  </Button>
                )}
                {!items.length && <p className="rounded-lg border border-dashed border-border px-2 py-6 text-center text-xs text-muted-foreground">{col.drop ? "Drop a lead here" : "Nothing here yet"}</p>}
                {col.key === "prospects" && <Button variant="ghost" size="xs" className="mt-1" onClick={() => setShowProspects(false)}>Fold prospects</Button>}
              </section>
              )
            );
          })}
        </div>
      </div>
      <MoveDialog move={move} by={by} onClose={() => setMove(null)} onMoved={onMoved} />
    </>
  );
}

function BoardCard({ lead, dim, onOpen, onMove, onDragStart, onDragEnd }: { lead: BoardLead; dim?: boolean; onOpen: () => void; onMove: (to: MoveTarget) => void; onDragStart: () => void; onDragEnd: () => void }) {
  const d = lead.deal;
  const targets = allowedTargets(lead);
  return (
    <li
      draggable={targets.length > 0}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(lead.id)); onDragStart(); }}
      onDragEnd={onDragEnd}
      className={cn("group rounded-lg border bg-card p-2.5 shadow-sm", d.stuck ? "border-warn/50" : "border-border", dim && "opacity-70", targets.length && "cursor-grab active:cursor-grabbing")}
    >
      <div className="flex items-start gap-1.5">
        {targets.length > 0 && <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
        <button type="button" onClick={onOpen} className="ds-interactive min-w-0 flex-1 rounded text-left">
          <span className="block text-sm font-medium text-foreground [overflow-wrap:anywhere]">{lead.name || "(name not on file)"}</span>
          <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{suburbOf(lead.area)} · {VERTICAL_LABEL[lead.vertical as Vertical] ?? lead.vertical}</span>
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="ds-num text-xs font-medium text-foreground" title={`First-year value ex GST${d.economics.packageState?.state === "assumed" ? " · package not chosen (Essential assumed)" : ""}`}>{aud(d.economics.valueCents)}{d.economics.packageState?.state === "assumed" ? "*" : ""}</span>
        {d.stuck ? <Badge tone="warn" title={d.stuck.action}>Stuck {d.stuck.days} d</Badge>
          : d.daysInStage !== null && <span className="ds-num text-xs text-muted-foreground">· {d.daysInStage} d in {STAGE_LABEL[d.stage]}</span>}
        {d.issues.length > 0 && <Badge tone={d.issues.some((i) => i.severity === 3) ? "danger" : "neutral"} title={d.issues.map((i) => honestWebsiteText(i.finding)).join("\n")}>{d.issues.length} issue{d.issues.length === 1 ? "" : "s"}</Badge>}
        {targets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" className="ml-auto h-6 px-1.5 text-muted-foreground" aria-label={`Move ${lead.name || "lead"} to another stage`}>Move <ChevronDown /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel className="text-xs">Move {lead.name || "lead"} to</DropdownMenuLabel>
              {targets.filter((t) => t !== "lost").map((t) => <DropdownMenuItem key={t} onSelect={() => onMove(t)}>{TARGET_LABEL[t]}</DropdownMenuItem>)}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onMove("lost")} className="text-danger focus:text-danger">Lost</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

const WHAT_IS_LOGGED: Record<MoveTarget, string> = {
  contacted: "logs the call or email as a contact",
  replied: "logs a note with the outcome “interested”",
  meeting: "logs a note with the outcome “meeting”",
  proposal: "logs a note with the outcome “proposal” (nothing is sent to them)",
  won: "records the win and creates the internal kickoff checklist (nothing is sent or charged)",
  lost: "logs a note with the outcome “lost” and closes the lead",
};

function MoveDialog({ move, by, onClose, onMoved }: { move: { lead: BoardLead; to: MoveTarget } | null; by: Owner; onClose: () => void; onMoved: () => void }) {
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<"call" | "email">("call");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = move ? `${move.lead.id}-${move.to}` : "";
  const [lastKey, setLastKey] = useState("");
  if (key && key !== lastKey) {
    setLastKey(key); setNote(""); setError(""); setKind("call");
    setScope(move?.lead.deal.economics.offerLabel ?? "");
  }
  if (!move) return null;
  const name = move.lead.name || "this lead";

  async function confirm() {
    if (!move) return;
    setBusy(true); setError("");
    try {
      await leadsApi.move(move.lead.id, { to: move.to, by, note, kind: move.to === "contacted" ? kind : undefined, scope: move.to === "won" ? scope : undefined });
      onMoved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {name} to {TARGET_LABEL[move.to]}?</DialogTitle>
          <DialogDescription>
            From {STAGE_LABEL[move.lead.deal.stage]}. This {WHAT_IS_LOGGED[move.to]}, as {by === "usman" ? "Usman" : "Mehroz"}. Their follow-up date is kept.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {move.to === "contacted" && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">How?</span>
              <Segmented ariaLabel="Contact channel" value={kind} onChange={(v) => setKind(v)} options={[{ value: "call", label: "Call" }, { value: "email", label: "Email" }]} />
            </div>
          )}
          {move.to === "won" && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">What was won</span>
              <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Website rebuild + AI receptionist (Essential)" />
            </label>
          )}
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — e.g. what they said" className="h-20 text-sm" aria-label="Note" />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant={move.to === "lost" ? "destructive" : "accent"} size="sm" onClick={confirm} disabled={busy || (move.to === "won" && !scope.trim())}>
            {busy && <Loader2 className="animate-spin" />} Move and log
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

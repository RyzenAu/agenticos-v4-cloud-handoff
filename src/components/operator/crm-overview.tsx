// The morning overview at the top of /leads: one plain sentence, the numbers that matter this
// morning (each tile filters the pipeline below), what to do today and what's coming up. Reads
// /__operator/leads/overview (scripts/leads/deals.ts). Nothing here calls, emails or charges.
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlarmClock, Briefcase, ListTodo, CalendarClock, CircleDollarSign, FileText, Hammer, Hourglass, Loader2, Phone, Receipt, Settings2, Sparkles, TrendingUp } from "lucide-react";
import { Badge, Button, Disclosure, EmptyState, Notice, Skeleton, StatTile, Surface, Widget, WidgetEmpty, WidgetGrid, fmtRelative } from "@/components/ds";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { aud, leadsApi, STAGE_LABEL, STAGES, type CrmOverview, type DealRules, type Stage, type TodoItem } from "@/lib/leads";
import { fmtDay } from "@/lib/format";

export type Preset = "new7d" | "open" | "stuck" | "overdue" | "proposal" | "builds" | "clients";
export const PRESET_LABEL: Record<Preset, string> = {
  new7d: "New this week",
  open: "Open pipeline",
  stuck: "Stuck too long",
  overdue: "Overdue follow-ups",
  proposal: "Proposals awaiting reply",
  builds: "Active builds",
  clients: "Clients",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = (iso: string) => fmtDay(new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso), { weekday: true });

export function MorningOverview({
  overview, loading, error, active, onFilter, onOpen, extra, lead,
}: {
  overview?: CrmOverview;
  loading: boolean;
  error?: Error | null;
  active: Preset | null;
  onFilter: (p: Preset) => void;
  onOpen: (id: number) => void;
  extra?: { callsMeta?: Map<number, { scriptReady?: boolean; issue?: string }> };
  /** L1 (29 Sep 2026): the call queue leads the widget grid; the page does calls first. */
  lead?: ReactNode;
}) {
  const navigate = useNavigate();
  const [rulesOpen, setRulesOpen] = useState(false);
  if (error)
    return (
      <WidgetGrid className="mb-12">
        {lead}
        <Widget span={2} icon={AlarmClock} title="This morning" badge="Couldn't load">
          <Notice tone="danger" title="The morning overview couldn't load">{error.message}</Notice>
        </Widget>
      </WidgetGrid>
    );
  if (loading || !overview) {
    return (
      <WidgetGrid className="mb-12" aria-busy="true">
        {lead}
        <Skeleton className="col-span-full h-64 rounded-2xl md:col-span-2" />
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
      </WidgetGrid>
    );
  }
  const t = overview.tiles;
  const tile = (p: Preset) => ({ onClick: () => onFilter(p), active: active === p });
  const hasStuck = overview.stuck.length > 0;

  return (
    <section aria-label="This morning" className="mb-12">
      <WidgetGrid>
        {lead}
        <TodoList items={overview.todo} onOpen={onOpen} meta={extra?.callsMeta} callsOpen={overview.callWindow?.open ?? true} />
        {/* W-B (29 Sep 2026): the four numbers that decide this morning stay up front; the rest fold
            into "More numbers" (still every tile, still each one filters). Overdue is warn, not red. */}
        <div className="contents" role="group" aria-label="This morning's numbers — each one filters the pipeline">
          <StatTile className="h-full rounded-2xl" label="Added · 7 days" icon={Sparkles} value={t.newLeads.count ?? "—"} hint={t.newLeads.count === null ? (t.newLeads.note ?? "Unknown") : "Not yet contacted"} {...tile("new7d")} />
          <StatTile className="h-full rounded-2xl" label="Pipeline" icon={TrendingUp} value={aud(t.pipeline.weightedCents, { compact: true })} unit="weighted"
            hint={t.pipeline.count ? `${plural(t.pipeline.count, "deal")} · ${aud(t.pipeline.valueCents, { compact: true })} first-year, ex GST` : "Nothing past first contact yet"} {...tile("open")} />
          <StatTile className="h-full rounded-2xl" label="Stuck" icon={Hourglass} value={t.stuck.count} tone={t.stuck.count ? "warn" : "default"} hint="No follow-up booked" {...tile("stuck")} />
          <StatTile className="h-full rounded-2xl" label="Overdue" icon={AlarmClock} value={t.followUps.overdue} tone={t.followUps.overdue ? "warn" : "default"}
            hint={t.followUps.dueToday ? `${t.followUps.dueToday} more due today` : "Past their date"} {...tile("overdue")} />
        </div>
        <Upcoming overview={overview} onOpen={onOpen} span={hasStuck ? 2 : 4} />
        {hasStuck && <StuckList overview={overview} onOpen={onOpen} onAll={() => onFilter("stuck")} />}
      </WidgetGrid>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="-mx-3 min-w-0 flex-1">
          <Disclosure
            summary={<span className="font-medium">More numbers</span>}
            meta={`Proposals ${t.proposals.count ? aud(t.proposals.valueCents, { compact: true }) : 0} · builds ${t.builds.active} · owed ${aud(t.invoices.cents, { compact: true })}`}
            defaultOpen={active === "proposal" || active === "builds" || active === "clients"}
          >
            <WidgetGrid role="group" aria-label="More numbers — each one filters the pipeline">
              <StatTile className="h-full rounded-2xl" label="Proposals out" icon={FileText} value={t.proposals.count ? aud(t.proposals.valueCents, { compact: true }) : 0}
                hint={t.proposals.count ? `${plural(t.proposals.count, "proposal")} awaiting a reply · ex GST` : "No proposals awaiting a reply"} {...tile("proposal")} />
              <StatTile className="h-full rounded-2xl" label="Builds" icon={Hammer} value={t.builds.active} tone={t.builds.tasksDue ? "warn" : "default"}
                hint={t.builds.active ? `${plural(t.builds.active, "active build")} · ${plural(t.builds.tasksDue, "task")} due` : "No builds in progress"} {...tile("builds")} />
              <StatTile className="h-full rounded-2xl" label="Owed to us" icon={Receipt} value={aud(t.invoices.cents, { compact: true })}
                hint={`${t.invoices.label ?? plural(t.invoices.count, "entry", "entries")} · client record, not Stripe`} {...tile("clients")} />
              {t.netCash && (
                <StatTile className="h-full rounded-2xl" label="Net cash (NAB CSV), not margin" icon={CircleDollarSign}
                  value={t.netCash.netCents === null ? "Unknown" : `${aud(t.netCash.netCents, { compact: true })}${t.netCash.coverage === "partial" ? " (partial)" : ""}`}
                  tone={t.netCash.netCents === null || t.netCash.coverage !== "full" ? "default" : t.netCash.netCents >= 0 ? "success" : "danger"}
                  hint={t.netCash.netCents === null
                    ? `${t.netCash.statement}. No imported data covers this month: unknown, not zero.`
                    : `In ${aud(t.netCash.inCents ?? 0, { compact: true })} − out ${aud(t.netCash.outCents ?? 0, { compact: true })}, month to date (transfers and Stripe payouts excluded) · ${t.netCash.statement}${t.netCash.coverage === "partial" ? " · partly covered, may be incomplete" : ""}`}
                  onClick={() => void navigate({ to: "/finance" })} />
              )}
            </WidgetGrid>
          </Disclosure>
        </div>
        <Button variant="ghost" size="sm" className="self-start sm:mt-1" onClick={() => setRulesOpen(true)}><Settings2 /> Stage rules</Button>
      </div>

      <RulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
    </section>
  );
}

/** The overview's date for the page foot ("Tuesday 29 September"). */
export const overviewDay = (overview: CrmOverview) => fmtDay(new Date(`${overview.date}T00:00:00`), { weekday: "long" });

const KIND_BADGE: Record<TodoItem["kind"], { label: string; icon: typeof Phone }> = {
  call: { label: "Call", icon: Phone },
  "follow-up": { label: "Follow-up", icon: AlarmClock },
  "build task": { label: "Build task", icon: Hammer },
};

function TodoList({ items, onOpen, meta, callsOpen }: { items: TodoItem[]; onOpen: (id: number) => void; meta?: Map<number, { scriptReady?: boolean; issue?: string }>; callsOpen: boolean }) {
  const [more, setMore] = useState(false);
  // Phones get the first five; the rest is one tap away.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => { const m = window.matchMedia("(max-width: 640px)"); setNarrow(m.matches); const on = () => setNarrow(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  const first = narrow ? 5 : 10;
  const shown = more ? items : items.slice(0, first);
  const overdue = items.filter((i) => i.overdue).length;
  return (
    <Widget
      span={2}
      icon={ListTodo}
      title={callsOpen ? "Today" : "Next"}
      badge={`${overdue ? `${overdue} overdue · ` : ""}${items.length} total`}
      action={items.length > first ? <Button variant="ghost" size="sm" onClick={() => setMore((v) => !v)}>{more ? "Show fewer" : `Show all ${items.length}`}</Button> : undefined}
    >
      {!items.length ? (
        <WidgetEmpty title="Nothing due today" />
      ) : (
        <ol className="flex flex-col gap-1.5">
          {shown.map((item) => {
            const k = KIND_BADGE[item.kind];
            const m = meta?.get(item.leadId);
            return (
              <li key={`${item.kind}-${item.leadId}-${item.detail}`}>
                <Surface variant="inset" padding="sm" as="div" role="button" tabIndex={0}
                  className={cn("ds-interactive flex cursor-pointer items-start justify-between gap-3 rounded-xl hover:border-border-strong", item.overdue && "border-danger/40")}
                  onClick={() => onOpen(item.leadId)}
                  onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item.leadId); } }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {item.overdue ? <Badge tone="danger">Overdue{item.dueAt ? ` · ${dayLabel(item.dueAt)}` : ""}</Badge> : <Badge tone={item.kind === "call" ? "neutral" : "info"}><k.icon className="size-3" aria-hidden="true" />{k.label}</Badge>}
                      <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">{item.name || "(name not on file)"}</span>
                    </div>
                    <p data-lead-detail="" className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={`${item.detail}${m?.issue ? ` · ${m.issue}` : ""}`}>{item.detail}{m?.issue ? ` · ${m.issue}` : ""}</p>
                    {item.contactPref && <p className="mt-0.5 line-clamp-2 text-xs text-foreground [overflow-wrap:anywhere]" title={item.contactPref}>Prefers: {item.contactPref}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1" onClick={(e) => e.stopPropagation()}>
                    {item.phone && <a href={`tel:${item.phone.replace(/[^\d+]/g, "")}`} className="ds-num whitespace-nowrap text-xs text-foreground underline-offset-2 hover:underline">{item.phone}</a>}
                    {m?.scriptReady && <Badge tone="success">Script ready</Badge>}
                  </div>
                </Surface>
              </li>
            );
          })}
        </ol>
      )}
    </Widget>
  );
}

function Upcoming({ overview, onOpen, span = 2 }: { overview: CrmOverview; onOpen: (id: number) => void; span?: 2 | 4 }) {
  const items = overview.upcoming.slice(0, 8);
  return (
    <Widget span={span} icon={CalendarClock} title="Upcoming calls and meetings" badge="Next 14 days">
      {!items.length ? (
        <WidgetEmpty title="Nothing booked" />
      ) : (
        <ol className="flex flex-col divide-y divide-border rounded-xl border border-border bg-inset">
          {items.map((u) => (
            <li key={`${u.kind}-${u.leadId}-${u.at}`}>
              <button type="button" onClick={() => onOpen(u.leadId)} className="ds-interactive flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-raised">
                <span className="ds-num w-20 shrink-0 text-xs font-medium text-foreground">{dayLabel(u.at)}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{u.name || "(name not on file)"}</span>
                  <span className="block line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{u.kind === "milestone" ? `Milestone · ${u.detail}` : `${u.kind.charAt(0).toUpperCase()}${u.kind.slice(1)} · ${u.detail}`}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Widget>
  );
}

function StuckList({ overview, onOpen, onAll }: { overview: CrmOverview; onOpen: (id: number) => void; onAll: () => void }) {
  return (
    <Widget span={2} icon={Hourglass} title="Stuck too long" badge={overview.tiles.stuck.count} action={<Button variant="ghost" size="sm" onClick={onAll}>See all {overview.tiles.stuck.count}</Button>}>
      <ol className="flex flex-col divide-y divide-border rounded-xl border border-warn/40 bg-inset">
        {overview.stuck.slice(0, 5).map((s) => (
          <li key={s.leadId}>
            <button type="button" onClick={() => onOpen(s.leadId)} className="ds-interactive flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-surface-raised">
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{s.name || "(name not on file)"}</span>
                <span className="ds-num shrink-0 text-xs text-warn">{s.days} d in {STAGE_LABEL[s.stage]} · limit {s.thresholdDays}</span>
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.action}</span>
            </button>
          </li>
        ))}
      </ol>
    </Widget>
  );
}

// ── stage rules: probabilities and stuck thresholds, in one place ─────────────

function RulesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [rules, setRules] = useState<DealRules | null>(null);
  const [draft, setDraft] = useState<Record<string, { p: string; d: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(""); setSaved(null);
    leadsApi.rules().then((r) => {
      setRules(r);
      setDraft(Object.fromEntries(STAGES.map((s) => [s, { p: String(Math.round(r.probability[s] * 100)), d: r.stuckDays[s] ? String(r.stuckDays[s]) : "" }])));
    }, (e) => setError((e as Error).message));
  }, [open]);

  async function save() {
    if (!rules) return;
    setBusy(true); setError("");
    try {
      const probability: Partial<Record<Stage, number>> = {};
      const stuckDays: Partial<Record<Stage, number | null>> = {};
      for (const s of STAGES) {
        const p = Number(draft[s].p);
        if (draft[s].p.trim() === "" || !Number.isFinite(p) || p < 0 || p > 100) throw new Error(`${STAGE_LABEL[s]}: probability must be 0–100%.`);
        if (p / 100 !== rules.probability[s]) probability[s] = p / 100;
        const d = draft[s].d.trim();
        const cur = rules.stuckDays[s] ?? null;
        const next = d === "" ? null : Number(d);
        if (next !== null && (!Number.isInteger(next) || next < 1 || next > 180)) throw new Error(`${STAGE_LABEL[s]}: stuck after must be 1–180 days, or blank for never.`);
        if (next !== cur) stuckDays[s] = next;
      }
      const r = await leadsApi.saveRules({ probability, stuckDays });
      setRules(r);
      setSaved(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Stage rules</DialogTitle>
          <DialogDescription>How likely a deal at each stage is to close, and how many days it can sit there before it's flagged stuck. Blank means never stuck. Applies to both founders.</DialogDescription>
        </DialogHeader>
        {!rules ? (error ? <Notice tone="danger">{error}</Notice> : <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="ds-label py-1.5 font-medium text-muted-foreground">Stage</th>
                <th scope="col" className="ds-label py-1.5 font-medium text-muted-foreground">Probability %</th>
                <th scope="col" className="ds-label py-1.5 font-medium text-muted-foreground">Stuck after (days)</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((s) => (
                <tr key={s} className="border-t border-border">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-foreground">{STAGE_LABEL[s]}</th>
                  <td className="py-1.5 pr-3"><Input inputMode="numeric" aria-label={`${STAGE_LABEL[s]} probability percent`} className="h-7 w-20 text-xs" value={draft[s]?.p ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [s]: { ...d[s], p: e.target.value } }))} /></td>
                  <td className="py-1.5"><Input inputMode="numeric" aria-label={`${STAGE_LABEL[s]} stuck after days`} placeholder="never" className="h-7 w-20 text-xs" value={draft[s]?.d ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [s]: { ...d[s], d: e.target.value } }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rules && error && <Notice tone="danger">{error}</Notice>}
        {saved && !error && <p className="text-xs text-success">Saved {fmtRelative(saved)}. Weighted values and stuck flags use these from now on.</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="accent" size="sm" onClick={save} disabled={busy || !rules}>{busy ? <Loader2 className="animate-spin" /> : <Briefcase />} Save rules</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

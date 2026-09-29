// The Leads page: M&U's own CRM as one readable pipeline. Reads /__operator/leads/* (scripts/leads/
// api.ts) and /__lead-sites/* (scripts/lead-sites/plugin.ts). Nothing here sends an email, dials
// a number or messages anyone: phones are tel: links or copied text, drafts are text to copy, and
// a website preview only goes live after a founder confirms it in the drawer.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { Badge, Button, Disclosure, EmptyState, Notice, PageFoot, PageHeader, Section, Segmented, Skeleton } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { operatorRequest } from "@/lib/operator";
import { cn } from "@/lib/utils";
import {
  leadSitesStatus,
  leadsApi,
  pitchFilterOptions,
  STATUSES,
  statusLabel,
  statusTone,
  taggedReasons,
  useOwner,
  VERTICAL_LABEL,
  VERTICALS,
  type BoardLead,
  type Hunt,
  type Lead,
  type Vertical,
} from "@/lib/leads";
import { CallQueue, LeadCards } from "./call-queue";
import { LeadDrawer } from "./lead-drawer";
import { MorningOverview, overviewDay, PRESET_LABEL, type Preset } from "./crm-overview";
import { LeadsTable } from "./leads-table";
import { LeadsBoard } from "./leads-board";
import { openCrmPalette } from "./crm-palette";
import { fmtDateTime } from "@/lib/format";

type Filters = { q: string; vertical: string; pitch: string; status: string; verifiedOnly: boolean; showExcluded: boolean };
const NO_FILTERS: Filters = { q: "", vertical: "", pitch: "", status: "", verifiedOnly: false, showExcluded: false };
const OPEN_STAGES = ["new", "to_call", "no_answer", "voicemail", "call_back", "emailed"];
type View = "list" | "table" | "board";
const VIEW_KEY = "claude-os.leads-view.v1";
const OPEN_PIPELINE = new Set(["contacted", "replied", "meeting", "proposal"]);
const DELIVERY = new Set(["won", "building", "QA", "launched", "care plan"]);
const sydneyDay = (t: string | number) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });

/** The tile filters: each overview tile narrows the pipeline to the leads it counted. */
function matchesPreset(l: BoardLead, preset: Preset | null, now: number): boolean {
  if (!preset) return true;
  const d = l.deal;
  switch (preset) {
    case "new7d": return Date.parse(l.createdAt) >= now - 7 * 86_400_000;
    case "open": return !d.closed && OPEN_PIPELINE.has(d.stage);
    case "stuck": return !!d.stuck;
    case "overdue": return !d.closed && !!l.nextAt && sydneyDay(l.nextAt) < sydneyDay(now);
    case "proposal": return !d.closed && d.stage === "proposal";
    case "builds": return !d.closed && DELIVERY.has(d.stage) && d.stage !== "care plan";
    case "clients": return DELIVERY.has(d.stage);
  }
}

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("list");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "list" || saved === "table" || saved === "board") setView(saved);
    } catch { /* default stands */ }
  }, []);
  return [view, (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* not persisted */ } }];
}

export function LeadsCrm() {
  const qc = useQueryClient();
  // A 30 s clock, like Today: the queue and "overdue" marks move by the minute, and a 1 s tick
  // re-rendered every card on the page each second (audit F1-19).
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const [by, setBy] = useOwner();
  const [openId, setOpenId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [findOpen, setFindOpen] = useState(false);
  const [view, setView] = useView();
  const [preset, setPreset] = useState<Preset | null>(null);
  // The route's validated search (routes/leads.tsx): ?lead=abc is dropped there, never passed on raw (audit F1-17).
  const search = useSearch({ from: "/leads" });
  const navigate = useNavigate();
  useEffect(() => { if (search.lead) setOpenId(search.lead); }, [search.lead]);
  const closeDrawer = () => {
    setOpenId(null);
    if (search.lead) void navigate({ to: "/leads", search: {}, replace: true });
  };

  const summary = useQuery({ queryKey: ["leads-summary"], queryFn: leadsApi.summary, refetchInterval: 30_000 });
  const overview = useQuery({ queryKey: ["leads-overview"], queryFn: leadsApi.overview, refetchInterval: 60_000 });
  const calls = useQuery({ queryKey: ["leads-calls", 10], queryFn: () => leadsApi.calls(10), refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ["leads-list", "deals", filters.showExcluded], queryFn: () => leadsApi.board(filters.showExcluded) });
  const sites = useQuery({ queryKey: ["lead-sites"], queryFn: () => leadSitesStatus(), refetchInterval: 60_000, retry: false });

  const refreshAll = () => {
    for (const key of ["leads-summary", "leads-overview", "leads-calls", "leads-list", "leads-detail", "lead-sites"]) qc.invalidateQueries({ queryKey: [key] });
  };
  const callsMeta = useMemo(() => new Map((calls.data?.leads ?? []).map((l) => [l.id, { scriptReady: l.scriptReady, issue: l.topIssues?.[0]?.finding }])), [calls.data]);
  const pickPreset = (p: Preset) => {
    setPreset((cur) => (cur === p ? null : p));
    if (p !== "new7d" && view === "list") setView("table");
    requestAnimationFrame(() => document.getElementById("pipeline")?.scrollIntoView({ behavior: "auto", block: "start" }));
  };

  const previews = useMemo(() => new Map((sites.data?.previews ?? []).map((p) => [p.leadId, p])), [sites.data]);
  const leads = list.data?.leads ?? [];
  const shown = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    const now = Date.now();
    return leads.filter((l) =>
      matchesPreset(l, preset, now) &&
      (!q || `${l.name} ${l.area} ${l.phone} ${l.website}`.toLowerCase().includes(q)) &&
      (!filters.vertical || l.vertical === filters.vertical) &&
      (!filters.pitch || l.pitch === filters.pitch) &&
      (!filters.status || l.status === filters.status) &&
      (!filters.verifiedOnly || taggedReasons(l).some((r) => r.verified)),
    );
  }, [leads, filters, preset]);
  const active = Object.entries(filters).filter(([k, v]) => k !== "showExcluded" && v).length;

  const pipeline = summary.data?.pipeline ?? {};
  const openCount = OPEN_STAGES.reduce((a, s) => a + (pipeline[s] ?? 0), 0);
  const warm = (pipeline.interested ?? 0) + (pipeline.meeting ?? 0) + (pipeline.proposal ?? 0);
  const livePreviews = (sites.data?.previews ?? []).filter((p) => p.status === "live");
  const expired = livePreviews.filter((p) => p.expired);

  return (
    <div className="min-w-0 w-full [overflow-wrap:anywhere] [&_button:not([role=switch])]:min-h-10 [&_button:not([role=switch])]:min-w-10 [&_a]:min-h-10 [&_input]:min-h-10">
      <PageHeader
        title="Leads"
        // L1 (29 Sep 2026): one headline sentence (the morning answer); the counts are on Pipeline.
        description={overview.data?.sentence ?? "Calls to make first, then the pipeline."}
        actions={
          <>
            <Segmented
              ariaLabel="Logging as"
              value={by}
              onChange={(v) => setBy(v as typeof by)}
              options={[{ value: "usman", label: "Usman" }, { value: "mehroz", label: "Mehroz" }]}
            />
            <Button variant="outline" size="sm" onClick={openCrmPalette} aria-keyshortcuts="Control+K Meta+K" title="Search leads (Ctrl K)">
              <Search aria-hidden="true" /> <span className="sr-only sm:not-sr-only">Search</span> <kbd className="ml-1 hidden rounded border border-border px-1 font-mono text-2xs text-muted-foreground sm:inline">Ctrl K</kbd>
            </Button>
            <Button variant="accent" size="sm" onClick={() => setFindOpen(true)}>Find leads</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Refresh leads" title="Refresh leads" onClick={refreshAll}><RefreshCw /></Button>
          </>
        }
      />
      {summary.error && <Notice tone="danger" className="mb-6">{(summary.error as Error).message}</Notice>}
      <HuntNotice hunt={summary.data?.hunt} />
      {expired.length > 0 && (
        <Notice tone="warn" className="mb-6" title={`${expired.length} website preview${expired.length === 1 ? " has" : "s have"} passed the 30-day limit`}>
          {expired.map((p) => p.business).join(", ")} — open the lead and take the preview down.
        </Notice>
      )}

      <MorningOverview
        overview={overview.data}
        loading={overview.isLoading}
        error={overview.error as Error | null}
        active={preset}
        onFilter={pickPreset}
        onOpen={setOpenId}
        extra={{ callsMeta }}
        lead={<CallQueue previews={previews} leads={leads} now={now} loading={list.isLoading} error={list.error as Error | null} onOpen={setOpenId} />}
      />

      <Section
        id="pipeline"
        title="Pipeline"
        description={summary.data ? `${openCount} open · ${warm} warm · ${pipeline.won ?? 0} won` : undefined}
        actions={
          <Segmented ariaLabel="Pipeline view" value={view} onChange={setView}
            options={[{ value: "list", label: "List" }, { value: "table", label: "Table" }, { value: "board", label: "Board" }]} />
        }
      >
        {view === "list" && <div className="mb-3"><PipelineCounts pipeline={pipeline} onPick={(s) => setFilters((f) => ({ ...f, status: f.status === s ? "" : s }))} picked={filters.status} /></div>}
        <FilterBar filters={filters} setFilters={setFilters} active={active} />
        {preset && (
          <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Showing</span>
            <button type="button" onClick={() => setPreset(null)} className="ds-interactive inline-flex h-7 items-center gap-1.5 rounded-full border border-brand/60 bg-brand-soft px-2.5 text-foreground" aria-label={`Clear filter: ${PRESET_LABEL[preset]}`}>
              {PRESET_LABEL[preset]} <X className="size-3" aria-hidden="true" />
            </button>
            <span>from the overview</span>
          </div>
        )}
        {list.isLoading ? (
          <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
        ) : list.error ? (
          <Notice tone="danger">{(list.error as Error).message}</Notice>
        ) : !leads.length ? (
          <EmptyState title="No leads yet" body="The nightly hunt adds leads around western Sydney. Use Find leads to search now." />
        ) : !shown.length ? (
          <EmptyState variant="row" title="No leads match these filters" action={<Button size="sm" variant="outline" onClick={() => { setPreset(null); setFilters((f) => ({ ...NO_FILTERS, showExcluded: f.showExcluded })); }}>Clear filters</Button>} />
        ) : (
          <>
            {view === "table" ? <LeadsTable leads={shown} onOpen={setOpenId} />
              : view === "board" ? <LeadsBoard leads={shown} by={by} onOpen={setOpenId} onMoved={refreshAll} />
              : (
<PagedLeadCards previews={previews} leads={shown} now={now} onOpen={setOpenId} />
              )}
            <p className="mt-3 text-xs text-muted-foreground">
              {shown.length} of {leads.length} shown{filters.showExcluded ? " · excluded leads included" : " · excluded leads hidden"}
            </p>
          </>
        )}
      </Section>

      <PageFoot title={overview.data ? overviewDay(overview.data) : undefined}>Nothing here dials or emails on its own · Map data © OpenStreetMap contributors</PageFoot>

      <LeadDrawer id={openId} onClose={closeDrawer} by={by} preview={openId ? previews.get(openId) : undefined} onChanged={refreshAll} />
      <FindLeadsDialog open={findOpen} onOpenChange={setFindOpen} onFound={refreshAll} />
    </div>
  );
}

// ── pipeline pieces ────────────────────────────────────────────────────────

const LIST_PAGE = 10;

/** The list view in pages of 10 (W-B: 25 at once was a wall of cards): a full pipeline is hundreds
 *  of cards, and the owner works the top of it. Filters narrow it; "Show more" extends it by 20. The
 *  count line stays honest. */
function PagedLeadCards({ leads, ...rest }: React.ComponentProps<typeof LeadCards>) {
  const [limit, setLimit] = useState(LIST_PAGE);
  useEffect(() => setLimit(LIST_PAGE), [leads]);
  const left = leads.length - limit;
  return (
    <>
      <LeadCards leads={left > 0 ? leads.slice(0, limit) : leads} {...rest} />
      {left > 0 && (
        <div className="mt-3 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Showing <span className="ds-num">{limit}</span> of <span className="ds-num">{leads.length}</span> — filter or search to narrow
          </span>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setLimit((n) => n + LIST_PAGE * 2)}>
            Show {Math.min(left, LIST_PAGE * 2)} more
          </Button>
        </div>
      )}
    </>
  );
}

function PipelineCounts({ pipeline, picked, onPick }: { pipeline: Record<string, number>; picked: string; onPick: (s: string) => void }) {
  const entries = STATUSES.filter((s) => pipeline[s]).map((s) => [s, pipeline[s]] as const);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
      {entries.map(([s, n]) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          aria-pressed={picked === s}
          className={cn(
            "ds-interactive inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
            picked === s ? "border-brand/60 bg-brand-soft text-foreground" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {statusLabel(s)} <span className="ds-num font-medium text-foreground">{n}</span>
        </button>
      ))}
    </div>
  );
}

function FilterBar({ filters, setFilters, active }: { filters: Filters; setFilters: React.Dispatch<React.SetStateAction<Filters>>; active: number }) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  // W-B: search stays up front; the other filters fold (open by default when one is set).
  const more = [filters.vertical, filters.pitch, filters.status, filters.verifiedOnly, filters.showExcluded].filter(Boolean).length;
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filters.q} onChange={(e) => set("q", e.target.value)} placeholder="Search name, suburb, phone" className="h-10 rounded-full pl-9 text-sm" aria-label="Search leads" />
      </div>
      <div className="-mx-3">
      <Disclosure summary={<span className="font-medium">Filters</span>} meta={more ? `${more} on` : "Vertical, pitch, status, verified, excluded"} defaultOpen={more > 0}>
      <div className="flex flex-wrap items-center gap-2">
      <FilterSelect label="Vertical" all="All verticals" value={filters.vertical} onChange={(v) => set("vertical", v)} options={VERTICALS.map((v) => ({ value: v, label: VERTICAL_LABEL[v] }))} />
      <FilterSelect label="Pitch" all="All pitches" value={filters.pitch} onChange={(v) => set("pitch", v)} options={pitchFilterOptions()} />
      <FilterSelect label="Status" all="All statuses" value={filters.status} onChange={(v) => set("status", v)} options={STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))} />
      <div className="flex min-h-10 items-center gap-2 px-1">
        <Switch id="verified-only" checked={filters.verifiedOnly} onCheckedChange={(v) => set("verifiedOnly", v)} />
        <Label htmlFor="verified-only" className="flex min-h-10 items-center text-xs font-normal text-muted-foreground">Verified only</Label>
      </div>
      <div className="flex items-center gap-2 px-1">
        <Switch id="show-excluded" checked={filters.showExcluded} onCheckedChange={(v) => set("showExcluded", v)} />
        <Label htmlFor="show-excluded" className="text-xs font-normal text-muted-foreground">Show excluded</Label>
      </div>
      {active > 0 && (
        <Button variant="ghost" size="xs" onClick={() => setFilters((f) => ({ ...NO_FILTERS, showExcluded: f.showExcluded }))}><X /> Clear</Button>
      )}
      </div>
      </Disclosure>
      </div>
    </div>
  );
}

function FilterSelect({ label, all, value, onChange, options }: { label: string; all: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger className="h-8 w-[calc(50%-4px)] text-xs sm:w-40" aria-label={label}>
        <SelectValue placeholder={label}>{options.find((o) => o.value === value)?.label ?? all}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{all}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}


function HuntNotice({ hunt }: { hunt?: Hunt }) {
  if (!hunt) return null;
  const failing = hunt.status === "failed" || hunt.status === "partial";
  if (!failing && !(hunt.overdue && hunt.status !== "never")) return null;
  const when = hunt.ranAt ? fmtDateTime(new Date(hunt.ranAt), { weekday: true }) : "";
  if (!failing)
    return <Notice tone="warn" className="mb-6" title={`The nightly lead hunt hasn't run since ${when}`}>Check the lead-hunt job on the Automations page.</Notice>;
  return (
    <Notice tone={hunt.status === "failed" ? "danger" : "warn"} className="mb-6" title={`${hunt.status === "failed" ? "The last lead hunt failed" : "The last lead hunt partly failed"}${hunt.problem ? `: ${hunt.problem}` : ""}`}>
      {when}{hunt.area ? ` · ${hunt.area}` : ""} · {hunt.added} new lead{hunt.added === 1 ? "" : "s"}
      {hunt.ownerAction ? <> · <b>What to do:</b> {hunt.ownerAction}</> : null}
    </Notice>
  );
}

/** The server clamps Find leads to this many results (api.ts validateFindBody). */
const FIND_MAX = 30;

function FindLeadsDialog({ open, onOpenChange, onFound }: { open: boolean; onOpenChange: (o: boolean) => void; onFound: () => void }) {
  const [vertical, setVertical] = useState<Vertical>("dental");
  const [area, setArea] = useState("");
  const [max, setMax] = useState("20");
  const maxN = Number(max);
  const maxOk = /^\d+$/.test(max.trim()) && maxN >= 1 && maxN <= FIND_MAX;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!area.trim() || !maxOk) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await operatorRequest<{ added: Lead[]; searched: number; alreadyKnown: number }>("/leads/find", { vertical, area: area.trim(), max: maxN }, "POST");
      setNotice(`Found ${r.added.length} new lead${r.added.length === 1 ? "" : "s"} (${r.searched} searched, ${r.alreadyKnown} already known).`);
      onFound();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Find leads</DialogTitle>
          <DialogDescription>Searches OpenStreetMap (free) and checks each new result's own website. Works only from this PC.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Select value={vertical} onValueChange={(v) => setVertical(v as Vertical)}>
            <SelectTrigger aria-label="Vertical"><SelectValue /></SelectTrigger>
            <SelectContent>{VERTICALS.map((v) => <SelectItem key={v} value={v}>{VERTICAL_LABEL[v]}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Area, e.g. Parramatta NSW" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" />
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Most results (1–{FIND_MAX})
            <Input type="number" min={1} max={FIND_MAX} step={1} value={max} onChange={(e) => setMax(e.target.value)} aria-label={`Most results, 1 to ${FIND_MAX}`} aria-invalid={!maxOk} />
          </label>
          {!maxOk && <p className="text-xs text-danger" role="alert">Choose a whole number from 1 to {FIND_MAX}: the search stops at {FIND_MAX} results.</p>}
          <Button type="submit" variant="accent" disabled={busy || !area.trim() || !maxOk}>{busy ? <Loader2 className="animate-spin" /> : <Search />} Find leads</Button>
          {error && <Notice tone="danger">{error}</Notice>}
          {notice && <Notice tone="success">{notice}</Notice>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

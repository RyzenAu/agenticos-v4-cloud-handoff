// The Leads page: M&U's own CRM as one readable pipeline. Reads /__operator/leads/* (scripts/leads/
// api.ts) and /__lead-sites/* (scripts/lead-sites/plugin.ts). Nothing here sends an email, dials
// a number or messages anyone: phones are tel: links or copied text, drafts are text to copy, and
// a website preview only goes live after a founder confirms it in the drawer.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
import {
  Button,
  EmptyState,
  Notice,
  PageFoot,
  PageHeader,
  Section,
  Segmented,
  Skeleton,
} from "@/components/ds";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { operatorRequest } from "@/lib/operator";
import {
  leadSitesStatus,
  leadsApi,
  useOwner,
  VERTICAL_LABEL,
  VERTICALS,
  type BoardLead,
  type Hunt,
  type Lead,
  type Vertical,
} from "@/lib/leads";
import { CallQueue } from "./call-queue";
import { LeadRows } from "./lead-list";
import { LeadDrawer } from "./lead-drawer";
import { useLeadsRoute } from "./use-leads-route";
import { leadsListQuery } from "@/lib/leads-queries";
import { MorningOverview, overviewDay, PRESET_LABEL, type Preset } from "./crm-overview";
import { LeadsTable } from "./leads-table";
import { LeadsBoard } from "./leads-board";
import { fmtDateTime } from "@/lib/format";

import {
  DEFAULT_LEAD_FILTERS,
  selectLeadResults,
  websitePresence,
  type LeadFilters,
} from "@/lib/lead-search";
import { LeadFilterBar } from "./lead-filters";
import { selectCallQueue } from "@/lib/call-queue";
const EMPTY_LEADS: BoardLead[] = [];
type View = "list" | "table" | "board";
const VIEW_KEY = "claude-os.leads-view.v1";
const OPEN_PIPELINE = new Set(["contacted", "replied", "meeting", "proposal"]);
const DELIVERY = new Set(["won", "building", "QA", "launched", "care plan"]);
const sydneyDay = (t: string | number) =>
  new Date(t).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });

/** The tile filters: each overview tile narrows the pipeline to the leads it counted. */
function matchesPreset(l: BoardLead, preset: Preset | null, now: number): boolean {
  if (!preset) return true;
  const d = l.deal;
  switch (preset) {
    case "new7d":
      return Date.parse(l.createdAt) >= now - 7 * 86_400_000;
    case "open":
      return !d.closed && OPEN_PIPELINE.has(d.stage);
    case "stuck":
      return !!d.stuck;
    case "overdue":
      return !d.closed && !!l.nextAt && sydneyDay(l.nextAt) < sydneyDay(now);
    case "proposal":
      return !d.closed && d.stage === "proposal";
    case "builds":
      return !d.closed && DELIVERY.has(d.stage) && d.stage !== "care plan";
    case "clients":
      return DELIVERY.has(d.stage);
  }
}

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("list");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "list" || saved === "table" || saved === "board") setView(saved);
    } catch {
      /* default stands */
    }
  }, []);
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* not persisted */
      }
    },
  ];
}

export function LeadsCrm() {
  const qc = useQueryClient();
  // A 30 s clock, like Today: the queue and "overdue" marks move by the minute, and a 1 s tick
  // re-rendered every card on the page each second (audit F1-19).
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [by, setBy] = useOwner();
  const [filters, setFilters] = useState<LeadFilters>(DEFAULT_LEAD_FILTERS);
  const [findOpen, setFindOpen] = useState(false);
  const [view, setView] = useView();
  const [preset, setPreset] = useState<Preset | null>(null);
  // The open lead and the workspace tab live in the address (see useLeadsRoute); ?lead=abc is dropped by the route, never passed on raw (audit F1-17).
  const { openId, workspace, openLead: setOpenId, closeLead: closeDrawer, setWorkspace } = useLeadsRoute();

  const summary = useQuery({
    queryKey: ["leads-summary"],
    queryFn: leadsApi.summary,
    refetchInterval: 30_000,
  });
  const overview = useQuery({
    queryKey: ["leads-overview"],
    queryFn: leadsApi.overview,
    refetchInterval: 60_000,
  });
  const calls = useQuery({
    queryKey: ["leads-calls", 10],
    queryFn: () => leadsApi.calls(10),
    refetchInterval: 30_000,
  });
  const list = useQuery(leadsListQuery(filters.showExcluded));
  const sites = useQuery({
    queryKey: ["lead-sites"],
    queryFn: () => leadSitesStatus(),
    refetchInterval: 60_000,
    retry: false,
  });

  const refreshAll = () => {
    for (const key of [
      "leads-summary",
      "leads-overview",
      "leads-calls",
      "leads-list",
      "leads-detail",
      "lead-sites",
    ])
      qc.invalidateQueries({ queryKey: [key] });
  };
  const callsMeta = useMemo(
    () =>
      new Map(
        (calls.data?.leads ?? []).map((l) => [
          l.id,
          { scriptReady: l.scriptReady, issue: l.topIssues?.[0]?.finding },
        ]),
      ),
    [calls.data],
  );
  const pickPreset = (p: Preset) => {
    setWorkspace("leads");
    setPreset((cur) => (cur === p ? null : p));
    if (p !== "new7d" && view === "list") setView("table");
    requestAnimationFrame(() =>
      document.getElementById("pipeline")?.scrollIntoView({ behavior: "auto", block: "start" }),
    );
  };

  const previews = useMemo(
    () => new Map((sites.data?.previews ?? []).map((p) => [p.leadId, p])),
    [sites.data],
  );
  const leads = list.data?.leads ?? EMPTY_LEADS;
  const shown = useMemo(
    () => selectLeadResults(leads, filters, now).filter((lead) => matchesPreset(lead, preset, now)),
    [leads, filters, preset, now],
  );
  const dueCalls = useMemo(() => selectCallQueue(leads, now).length, [leads, now]);
  const noWebsiteCount = useMemo(
    () =>
      leads.filter((lead) => !lead.excluded && websitePresence(lead) === "verified_none").length,
    [leads],
  );
  const unknownWebsiteCount = useMemo(
    () => leads.filter((lead) => !lead.excluded && websitePresence(lead) === "unknown").length,
    [leads],
  );
  const focusWebsite = (website: LeadFilters["website"]) => {
    setPreset(null);
    setFilters({ ...DEFAULT_LEAD_FILTERS, website });
  };

  const livePreviews = (sites.data?.previews ?? []).filter((p) => p.status === "live");
  const expired = livePreviews.filter((p) => p.expired);

  return (
    <div className="min-w-0 w-full [overflow-wrap:anywhere] [&_button:not([role=switch])]:min-h-10 [&_button:not([role=switch])]:min-w-10 [&_a]:min-h-10 [&_input]:min-h-10">
      <PageHeader
        title="Leads"
        // L1 (29 Sep 2026): one headline sentence, the morning answer (what is due, what is overdue); it is what makes
        // the page pass the five-second test, so it stays with Dot's compact list.
        description={overview.data?.sentence ?? "Calls to make first, then the pipeline."}
        actions={
          <>
            <Segmented
              ariaLabel="Logging as"
              value={by}
              onChange={(v) => setBy(v as typeof by)}
              options={[
                { value: "usman", label: "Usman" },
                { value: "mehroz", label: "Mehroz" },
              ]}
            />
            <Button variant="accent" size="sm" onClick={() => setFindOpen(true)}>
              Find leads
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="max-[420px]:hidden"
              aria-label="Refresh leads"
              title="Refresh leads"
              onClick={refreshAll}
            >
              <RefreshCw />
            </Button>
          </>
        }
      />
      {summary.error && (
        <Notice tone="danger" className="mb-6">
          {(summary.error as Error).message}
        </Notice>
      )}
      <HuntNotice hunt={summary.data?.hunt} />
      {expired.length > 0 && (
        <Notice
          tone="warn"
          className="mb-6"
          title={`${expired.length} website preview${expired.length === 1 ? " has" : "s have"} passed the 30-day limit`}
        >
          {expired.map((p) => p.business).join(", ")} — open the lead and take the preview down.
        </Notice>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <Segmented
          ariaLabel="Leads workspace"
          value={workspace}
          onChange={(value) => setWorkspace(value as typeof workspace)}
          options={[
            { value: "leads", label: "Your leads" },
            { value: "today", label: `Today${dueCalls ? ` · ${dueCalls} call${dueCalls === 1 ? "" : "s"} due` : ""}` },
          ]}
        />
      </div>
      {workspace === "today" ? (
        <MorningOverview
          overview={overview.data}
          loading={overview.isLoading}
          error={overview.error as Error | null}
          active={preset}
          onFilter={pickPreset}
          onOpen={setOpenId}
          extra={{ callsMeta }}
          lead={
            <CallQueue
              previews={previews}
              leads={leads}
              now={now}
              loading={list.isLoading}
              error={list.error as Error | null}
              onOpen={setOpenId}
            />
          }
        />
      ) : (
        <>
          <Section
            id="pipeline"
            title="Prospects"
            actions={
              <Segmented
                ariaLabel="Pipeline view"
                value={view}
                onChange={setView}
                options={[
                  { value: "list", label: "List" },
                  { value: "table", label: "Table" },
                  { value: "board", label: "Board" },
                ]}
              />
            }
          >
            <LeadFilterBar
              filters={filters}
              setFilters={setFilters}
              leads={leads}
              shortcuts={
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Website opportunity shortcuts"
                >
                  <Button
                    variant={!filters.website ? "accent" : "outline"}
                    size="sm"
                    aria-pressed={!filters.website}
                    onClick={() => focusWebsite("")}
                  >
                    All leads
                  </Button>
                  <Button
                    variant={filters.website === "verified_none" ? "accent" : "outline"}
                    size="sm"
                    aria-pressed={filters.website === "verified_none"}
                    onClick={() => focusWebsite("verified_none")}
                  >
                    No website, verified <span className="ds-num opacity-70">{noWebsiteCount}</span>
                  </Button>
                  <Button
                    variant={filters.website === "unknown" ? "accent" : "outline"}
                    size="sm"
                    aria-pressed={filters.website === "unknown"}
                    onClick={() => focusWebsite("unknown")}
                  >
                    Needs website check{" "}
                    <span className="ds-num opacity-70">{unknownWebsiteCount}</span>
                  </Button>
                </div>
              }
            />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <p role="status" aria-live="polite" className="text-muted-foreground">
                {list.isLoading ? (
                  "Loading leads…"
                ) : (
                  <>
                    <span className="font-medium text-foreground ds-num">{shown.length}</span>{" "}
                    matching {shown.length === 1 ? "lead" : "leads"}{" "}
                    <span className="text-xs">of {leads.length} loaded</span>
                  </>
                )}
              </p>
              {filters.sort === "relevance" && filters.q.trim() && (
                <span className="text-xs text-muted-foreground">Best matches first</span>
              )}
            </div>
            {preset && (
              <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Showing</span>
                <button
                  type="button"
                  onClick={() => setPreset(null)}
                  className="ds-interactive inline-flex h-7 items-center gap-1.5 rounded-full border border-brand/60 bg-brand-soft px-2.5 text-foreground"
                  aria-label={`Clear filter: ${PRESET_LABEL[preset]}`}
                >
                  {PRESET_LABEL[preset]} <X className="size-3" aria-hidden="true" />
                </button>
                <span>from the overview</span>
              </div>
            )}
            {list.isLoading ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            ) : list.error ? (
              <Notice tone="danger">{(list.error as Error).message}</Notice>
            ) : !leads.length ? (
              <EmptyState
                title="No leads yet"
                body="The nightly hunt adds leads around western Sydney. Use Find leads to search now."
              />
            ) : !shown.length ? (
              <EmptyState
                variant="row"
                title="No leads match these filters"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPreset(null);
                      setFilters((f) => ({
                        ...DEFAULT_LEAD_FILTERS,
                        showExcluded: f.showExcluded,
                      }));
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
                {view === "table" ? (
                  <LeadsTable
                    leads={shown}
                    onOpen={setOpenId}
                    ordered
                    orderKey={JSON.stringify([filters, preset])}
                  />
                ) : view === "board" ? (
                  <LeadsBoard leads={shown} by={by} onOpen={setOpenId} onMoved={refreshAll} />
                ) : (
                  <PagedLeadRows
                    previews={previews}
                    leads={shown}
                    now={now}
                    onOpen={setOpenId}
                    resetKey={JSON.stringify([filters, preset])}
                  />
                )}
              </>
            )}
          </Section>
        </>
      )}

      <PageFoot
        title={workspace === "today" && overview.data ? overviewDay(overview.data) : undefined}
      >
        No automatic outreach · Map data © OpenStreetMap contributors
      </PageFoot>

      <LeadDrawer
        id={openId}
        onClose={closeDrawer}
        by={by}
        preview={openId ? previews.get(openId) : undefined}
        onChanged={refreshAll}
      />
      <FindLeadsDialog open={findOpen} onOpenChange={setFindOpen} onFound={refreshAll} />
    </div>
  );
}

// ── pipeline pieces ────────────────────────────────────────────────────────

const LIST_PAGE = 10;

/** Keep the compact list bounded to 10 initial rows: a full pipeline can contain hundreds
 *  of leads, and the owner works the top of it. Filters narrow it; "Show more" extends it by 20. The
 *  count line stays honest. */
function PagedLeadRows({
  leads,
  resetKey,
  ...rest
}: React.ComponentProps<typeof LeadRows> & { resetKey: string }) {
  const [limit, setLimit] = useState(LIST_PAGE);
  // Polling and the 30-second clock must not collapse a list the user has expanded.
  useEffect(() => setLimit(LIST_PAGE), [resetKey]);
  const left = leads.length - limit;
  return (
    <>
      <LeadRows leads={left > 0 ? leads.slice(0, limit) : leads} {...rest} />
      {left > 0 && (
        <div className="mt-3 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Showing <span className="ds-num">{limit}</span> of{" "}
            <span className="ds-num">{leads.length}</span> — filter or search to narrow
          </span>
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => setLimit((n) => n + LIST_PAGE * 2)}
          >
            Show {Math.min(left, LIST_PAGE * 2)} more
          </Button>
        </div>
      )}
    </>
  );
}

function HuntNotice({ hunt }: { hunt?: Hunt }) {
  if (!hunt) return null;
  const failing = hunt.status === "failed" || hunt.status === "partial";
  if (!failing && !(hunt.overdue && hunt.status !== "never")) return null;
  const when = hunt.ranAt ? fmtDateTime(new Date(hunt.ranAt), { weekday: true }) : "";
  if (!failing)
    return (
      <Notice tone="warn" className="mb-6" title={`The nightly lead hunt hasn't run since ${when}`}>
        Check the lead-hunt job on the Automations page.
      </Notice>
    );
  return (
    <Notice
      tone={hunt.status === "failed" ? "danger" : "warn"}
      className="mb-6"
      title={`${hunt.status === "failed" ? "The last lead hunt failed" : "The last lead hunt partly failed"}${hunt.problem ? `: ${hunt.problem}` : ""}`}
    >
      {when}
      {hunt.area ? ` · ${hunt.area}` : ""} · {hunt.added} new lead{hunt.added === 1 ? "" : "s"}
      {hunt.ownerAction ? (
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">What to do</summary>
          <p className="mt-1">{hunt.ownerAction}</p>
        </details>
      ) : null}
    </Notice>
  );
}

/** The server clamps Find leads to this many results (api.ts validateFindBody). */
const FIND_MAX = 30;

function FindLeadsDialog({
  open,
  onOpenChange,
  onFound,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onFound: () => void;
}) {
  const [vertical, setVertical] = useState<Vertical>("dental");
  const [area, setArea] = useState("");
  const [max, setMax] = useState("20");
  const [websitePresence, setWebsitePresence] = useState<"all" | "missing">("all");
  const inFlight = useRef(false);
  const maxN = Number(max);
  const maxOk = /^\d+$/.test(max.trim()) && maxN >= 1 && maxN <= FIND_MAX;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || !area.trim() || !maxOk) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await operatorRequest<{
        added: Lead[];
        searched: number;
        alreadyKnown: number;
        matched?: number;
        filteredOut?: number;
        limited?: number;
        unverifiable?: number;
        discovered?: number;
      }>(
        "/leads/find",
        { vertical, area: area.trim(), max: maxN, source: "osm", websitePresence },
        "POST",
      );
      setNotice(
        [
          `Added ${r.added.length} new lead${r.added.length === 1 ? "" : "s"} from ${area.trim()}.`,
          `${r.searched} source results · ${r.alreadyKnown} already saved${r.filteredOut ? ` · ${r.filteredOut} with a listed website skipped` : ""}.`,
          r.limited ? `${r.limited} more matching candidate${r.limited === 1 ? " was" : "s were"} outside this search limit.` : "",
          r.discovered
            ? `Found an existing website for ${r.discovered} candidate${r.discovered === 1 ? "" : "s"}.`
            : "",
          r.unverifiable
            ? `Website checks could not complete for ${r.unverifiable}; these remain unverified.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      onFound();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find leads</DialogTitle>
          <DialogDescription>
            Discover businesses through OpenStreetMap, then check their website information. Free
            source; no Google Places lookup. Run this from the computer hosting Agentic OS.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} aria-busy={busy}>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Industry
            <Select
              disabled={busy}
              value={vertical}
              onValueChange={(v) => setVertical(v as Vertical)}
            >
              <SelectTrigger aria-label="Vertical">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VERTICAL_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Suburb / location
            <Input
              placeholder="e.g. Parramatta NSW"
              maxLength={120}
              disabled={busy}
              value={area}
              onChange={(e) => setArea(e.target.value)}
              aria-label="Area"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Website opportunity
            <select
              disabled={busy}
              value={websitePresence}
              onChange={(e) => setWebsitePresence(e.target.value as "all" | "missing")}
              className="ds-interactive min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm font-normal text-foreground"
            >
              <option value="all">All businesses</option>
              <option value="missing">No website listed in OSM</option>
            </select>
          </label>
          <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
            A missing directory link is a candidate to check, not proof there’s no website.
            Discovery may find an existing site; confirmed absence is recorded separately.
          </p>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Maximum new candidates (1–{FIND_MAX})
            <Input
              disabled={busy}
              type="number"
              min={1}
              max={FIND_MAX}
              step={1}
              value={max}
              onChange={(e) => setMax(e.target.value)}
              aria-label={`Most results, 1 to ${FIND_MAX}`}
              aria-invalid={!maxOk}
            />
          </label>
          {!maxOk && (
            <p className="text-xs text-danger" role="alert">
              Choose a whole number from 1 to {FIND_MAX}: the search stops at {FIND_MAX} results.
            </p>
          )}
          <Button type="submit" variant="accent" disabled={busy || !area.trim() || !maxOk}>
            {busy ? <Loader2 className="animate-spin" /> : <Search />} Find leads
          </Button>
          {busy && (
            <p className="text-xs text-muted-foreground" role="status">
              Searching and checking websites… You can close this window; the current search will
              keep running.
            </p>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {notice && (
            <Notice tone="success">
              <span role="status">{notice}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => onOpenChange(false)}
              >
                View your leads
              </Button>
            </Notice>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

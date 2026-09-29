import { fmtDateTime } from "@/lib/format";
// The Leads page (M&U's own CRM). Reads scripts/leads/{crm,engine,outreach,places}.ts through
// /__operator/leads/* (see scripts/leads/api.ts). This page never sends an email, dials a number
// or messages anyone: phones are `tel:` links a founder taps themselves, and "Draft email" only
// shows text to copy.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { Busy, Empty, PageHeading, Panel } from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge, Notice } from "@/components/ds";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import "./leads-workspace.css";

// ── types (mirror scripts/leads/crm.ts) ─────────────────────────────────────

const STATUSES = [
  "new", "to_call", "no_answer", "voicemail", "call_back", "emailed", "interested",
  "meeting", "proposal", "won", "lost", "not_interested", "do_not_contact",
] as const;
type LeadStatus = (typeof STATUSES)[number];
const VERTICALS = ["dental", "real-estate", "legal"] as const;
type Vertical = (typeof VERTICALS)[number];
const OWNERS = ["usman", "mehroz"] as const;
type Owner = (typeof OWNERS)[number];

type Lead = {
  id: number;
  placeId: string;
  vertical: Vertical;
  area: string;
  name: string;
  phone: string;
  address: string;
  website: string;
  mapsUrl: string;
  rating: number | null;
  reviews: number | null;
  emails: string[];
  emailOk: boolean;
  score: number;
  pitch: string;
  reasons: string[];
  status: LeadStatus;
  owner: string;
  nextAt: string | null;
  lastContactAt: string | null;
  createdAt: string;
};
type Activity = { id: number; leadId: number; at: string; kind: string; outcome: string; note: string; by: string };
type DayReport = {
  date: string;
  who: string | null;
  target: number;
  calls: number;
  meetings: number;
  outcomes: Record<string, number>;
  followUpsDue: Lead[];
};
/** Last night's Hermes lead hunt (scripts/leads/hunt.ts). */
type Hunt = {
  status: "ok" | "partial" | "failed" | "never";
  ranAt: string | null;
  area: string | null;
  added: number;
  errors: string[];
  problem?: string;
  ownerAction?: string;
  failingSince?: string | null;
  overdue: boolean;
};
type Summary = {
  pipeline: Record<string, number>;
  placesUsage: { used: number; budget: number };
  hunt?: Hunt;
  callWindow: { open: boolean; why: string };
  today: { usman: DayReport; mehroz: DayReport };
};
type CallLead = Lead & { opener: string };

const BY_KEY = "claude-os.leads-by.v1";
const VERTICAL_LABEL: Record<Vertical, string> = { dental: "Dental", "real-estate": "Real estate", legal: "Legal" };
const STATUS_LABEL = (s: string) => s.replace(/_/g, " ");
const OUTCOMES: { key: LeadStatus; label: string; needsDate?: boolean }[] = [
  { key: "no_answer", label: "No answer" },
  { key: "voicemail", label: "Voicemail" },
  { key: "call_back", label: "Call back", needsDate: true },
  { key: "interested", label: "Interested" },
  { key: "not_interested", label: "Not interested" },
  { key: "do_not_contact", label: "Do not contact" },
];

function useOwner(): [Owner, (o: Owner) => void] {
  const [by, setBy] = useState<Owner>("usman");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BY_KEY);
      if (saved === "usman" || saved === "mehroz") setBy(saved);
    } catch { /* default stands */ }
  }, []);
  const update = (o: Owner) => {
    setBy(o);
    try { localStorage.setItem(BY_KEY, o); } catch { /* not persisted this session */ }
  };
  return [by, update];
}

export function LeadsWorkspace() {
  const qc = useQueryClient();
  const [by, setBy] = useOwner();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [findError, setFindError] = useState("");
  const [findBusy, setFindBusy] = useState(false);
  const [findNotice, setFindNotice] = useState("");

  const summary = useQuery<Summary>({
    queryKey: ["leads-summary"],
    queryFn: () => operatorRequest<Summary>("/leads/summary", undefined, "GET"),
    refetchInterval: 30_000,
  });
  const calls = useQuery<{ callWindow: Summary["callWindow"]; leads: CallLead[] }>({
    queryKey: ["leads-calls"],
    queryFn: () => operatorRequest("/leads/calls?n=15", undefined, "GET"),
    refetchInterval: 30_000,
  });
  const [filters, setFilters] = useState<{ status: string; vertical: string; minScore: string }>({ status: "", vertical: "", minScore: "" });
  const listQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.vertical) params.set("vertical", filters.vertical);
    if (filters.minScore) params.set("minScore", filters.minScore);
    return params.toString();
  }, [filters]);
  const list = useQuery<{ leads: Lead[] }>({
    queryKey: ["leads-list", listQuery],
    queryFn: () => operatorRequest<{ leads: Lead[] }>(`/leads/list${listQuery ? `?${listQuery}` : ""}`, undefined, "GET"),
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["leads-summary"] });
    qc.invalidateQueries({ queryKey: ["leads-calls"] });
    qc.invalidateQueries({ queryKey: ["leads-list"] });
  };

  const noLeadsAtAll = list.data && list.data.leads.length === 0 && !filters.status && !filters.vertical && !filters.minScore
    && summary.data && Object.values(summary.data.pipeline).reduce((a, b) => a + b, 0) === 0;

  async function logOutcome(lead: Lead, outcome: LeadStatus, note: string, next: string | null) {
    await operatorRequest("/leads/log", { lead: lead.id, outcome, kind: "call", by, note, next }, "POST");
    refreshAll();
  }

  async function submitFind(vertical: Vertical, area: string, max: number) {
    setFindBusy(true);
    setFindError("");
    setFindNotice("");
    try {
      const result = await operatorRequest<{ added: Lead[]; searched: number; alreadyKnown: number; budgetLeft: number }>(
        "/leads/find",
        { vertical, area, max },
        "POST",
      );
      setFindNotice(`Found ${result.added.length} new lead${result.added.length === 1 ? "" : "s"} (${result.searched} searched, ${result.alreadyKnown} already known). Places budget left: ${result.budgetLeft}.`);
      refreshAll();
    } catch (e) {
      setFindError((e as Error).message);
    } finally {
      setFindBusy(false);
    }
  }

  if (summary.isLoading) return <div className="op-page"><Busy /></div>;

  return (
    <div className="op-page">
      <PageHeading eyebrow="Workspace" title="Leads" description="M&U's own pipeline — dental, real estate and legal prospects. Nothing here sends an email, dials a number or messages anyone.">
        <Button variant="outline" size="sm" onClick={refreshAll}><RefreshCw size={14} /> Refresh</Button>
      </PageHeading>

      <div className="leads-stack">
      {summary.error && <Notice tone="danger">{(summary.error as Error).message}</Notice>}

      <HuntStatus hunt={summary.data?.hunt} />

      <TopStrip summary={summary.data} by={by} setBy={setBy} />

      {noLeadsAtAll ? (
        <Panel>
          <Empty icon={<Users size={25} />} title="No leads yet">
            {summary.data?.hunt && (summary.data.hunt.status === "failed" || summary.data.hunt.status === "partial")
              ? "The nightly hunt can't search right now — see the problem above. Finding leads by hand below will fail the same way."
              : 'The nightly hunt adds leads around Mount Druitt each night. To search now, use "Find leads" below.'}
          </Empty>
        </Panel>
      ) : null}

      <FindLeadsForm busy={findBusy} error={findError} notice={findNotice} onSubmit={submitFind} />

      <Panel>
        <div className="op-panel-title">
          <h2>Calls to make</h2>
          <small>{calls.data ? `${calls.data.leads.length} due` : ""}</small>
        </div>
        {calls.isLoading ? <Busy /> : !calls.data?.leads.length ? (
          <p className="text-sm text-muted-foreground">Nobody's due for a call right now.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {calls.data.leads.map((lead) => (
              <CallCard key={lead.id} lead={lead} onOutcome={logOutcome} onOpenDetail={() => setDetailId(lead.id)} />
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <div className="op-panel-title">
          <h2>All leads</h2>
          <small>{list.data ? `${list.data.leads.length} shown` : ""}</small>
        </div>
        <LeadFilters filters={filters} setFilters={setFilters} />
        {list.isLoading ? (
          <Busy />
        ) : !list.data?.leads.length ? (
          <p className="text-sm text-muted-foreground">No leads match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Vertical</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Area</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.leads.map((lead) => (
                  <TableRow key={lead.id} className="cursor-pointer" onClick={() => setDetailId(lead.id)}>
                    <TableCell className="font-medium">{lead.name || "(name not on file)"}</TableCell>
                    <TableCell>{VERTICAL_LABEL[lead.vertical]}</TableCell>
                    <TableCell>{lead.score}</TableCell>
                    <TableCell><Badge tone="neutral">{STATUS_LABEL(lead.status)}</Badge></TableCell>
                    <TableCell>{lead.phone ? <a href={`tel:${lead.phone}`} onClick={(e) => e.stopPropagation()} className="underline">{lead.phone}</a> : "—"}</TableCell>
                    <TableCell>{lead.area}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      </div>

      <LeadDetailDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={refreshAll} by={by} />
    </div>
  );
}

// ── last night's hunt ────────────────────────────────────────────────────

function huntTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return fmtDateTime(date, { weekday: true });
}

/** Says plainly when the nightly hunt failed, since when, and the one thing to do about it. */
function HuntStatus({ hunt }: { hunt?: Hunt }) {
  if (!hunt) return null;
  const failing = hunt.status === "failed" || hunt.status === "partial";
  if (!failing && !(hunt.overdue && hunt.status !== "never")) return null;
  if (!failing)
    return (
      <section className="leads-hunt is-overdue" role="status">
        <strong><Clock3 size={15} /> The nightly lead hunt hasn't run since {huntTime(hunt.ranAt)}</strong>
        <p>Check the lead-hunt job on the Automations page.</p>
      </section>
    );
  return (
    <section className={`leads-hunt is-${hunt.status}`} role="alert">
      <strong>
        <AlertTriangle size={15} />
        {hunt.status === "failed" ? "The last lead hunt failed" : "The last lead hunt partly failed"}
        {hunt.problem ? `: ${hunt.problem}` : ""}
      </strong>
      <p>
        {huntTime(hunt.ranAt)}
        {hunt.area ? ` · ${hunt.area}` : ""} · {hunt.added} new lead{hunt.added === 1 ? "" : "s"}
        {hunt.failingSince && hunt.failingSince !== hunt.ranAt ? ` · failing since ${huntTime(hunt.failingSince)}` : ""}
      </p>
      {hunt.ownerAction && (
        <p>
          <b>What to do:</b> {hunt.ownerAction}
        </p>
      )}
    </section>
  );
}

// ── top strip ────────────────────────────────────────────────────────────

function TopStrip({ summary, by, setBy }: { summary?: Summary; by: Owner; setBy: (o: Owner) => void }) {
  if (!summary) return null;
  const followUps = summary.today.usman.followUpsDue.length + summary.today.mehroz.followUpsDue.length;
  return (
    <Panel className="leads-strip">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <GoalTile who="usman" report={summary.today.usman} />
        <GoalTile who="mehroz" report={summary.today.mehroz} />
        <div className="rounded-lg bg-inset p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 size={14} /> Calling hours</div>
          <div className={`mt-1 text-lg font-semibold ${summary.callWindow.open ? "text-success" : "text-warn"}`}>
            {summary.callWindow.open ? "Open" : "Closed"}
          </div>
          <div className="text-xs text-muted-foreground">{summary.callWindow.why}</div>
          {followUps > 0 && <div className="mt-2 text-xs">{followUps} follow-up{followUps === 1 ? "" : "s"} due</div>}
        </div>
        <div className="rounded-lg bg-inset p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Search size={14} /> Places budget</div>
          <div className="mt-1 text-lg font-semibold">{summary.placesUsage.used} / {summary.placesUsage.budget}</div>
          <Progress className="mt-2" value={Math.min(100, (summary.placesUsage.used / summary.placesUsage.budget) * 100)} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
        <span className="text-sm text-muted-foreground">Logging calls as</span>
        <Select value={by} onValueChange={(v) => setBy(v as Owner)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="usman">Usman</SelectItem>
            <SelectItem value="mehroz">Mehroz</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap gap-2">
          {Object.entries(summary.pipeline).map(([status, n]) => (
            <Badge key={status} tone="neutral">{STATUS_LABEL(status)}: {n}</Badge>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function GoalTile({ who, report }: { who: Owner; report: DayReport }) {
  const pct = report.target > 0 ? Math.min(100, (report.calls / report.target) * 100) : 0;
  return (
    <div className="rounded-lg bg-inset p-4">
      <div className="text-sm text-muted-foreground capitalize">{who}'s calls today</div>
      <div className="mt-1 text-lg font-semibold">{report.calls}{report.target > 0 ? ` / ${report.target}` : ""}</div>
      {report.target > 0 && <Progress className="mt-2" value={pct} />}
    </div>
  );
}

// ── today's calls ────────────────────────────────────────────────────────

function CallCard({ lead, onOutcome, onOpenDetail }: { lead: CallLead; onOutcome: (lead: Lead, outcome: LeadStatus, note: string, next: string | null) => Promise<void>; onOpenDetail: () => void }) {
  const [note, setNote] = useState("");
  const [callBackDate, setCallBackDate] = useState("");
  const [busy, setBusy] = useState<LeadStatus | null>(null);

  async function act(outcome: LeadStatus) {
    if (outcome === "call_back" && !callBackDate) return;
    setBusy(outcome);
    try {
      await onOutcome(lead, outcome, note, outcome === "call_back" ? callBackDate : null);
      setNote("");
      setCallBackDate("");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg bg-inset p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={onOpenDetail}>{lead.name}</button>
          <div className="text-xs text-muted-foreground">{VERTICAL_LABEL[lead.vertical]} · score {lead.score} · {lead.area}</div>
        </div>
        {lead.phone && (
          <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-1 text-sm underline"><Phone size={14} /> {lead.phone}</a>
        )}
      </div>
      {lead.reasons.slice(0, 2).length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
          {lead.reasons.slice(0, 2).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <p className="mt-2 rounded bg-background p-2 text-sm italic">"{lead.opener}"</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {OUTCOMES.map((o) => (
          <span key={o.key} className="inline-flex items-center gap-1">
            {o.needsDate && (
              <input
                type="date"
                value={callBackDate}
                onChange={(e) => setCallBackDate(e.target.value)}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                aria-label="Call back date"
              />
            )}
            <Button
              type="button"
              size="sm"
              variant={o.key === "do_not_contact" ? "destructive" : "outline"}
              disabled={busy !== null || (o.needsDate && !callBackDate)}
              onClick={() => act(o.key)}
            >
              {busy === o.key ? <Loader2 size={13} className="animate-spin" /> : o.label}
            </Button>
          </span>
        ))}
      </div>
      <Textarea
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="mt-2 h-16 text-sm"
      />
    </div>
  );
}

// ── all-leads filters ────────────────────────────────────────────────────

function LeadFilters({ filters, setFilters }: { filters: { status: string; vertical: string; minScore: string }; setFilters: (f: any) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select value={filters.vertical || "all"} onValueChange={(v) => setFilters((f: any) => ({ ...f, vertical: v === "all" ? "" : v }))}>
        <SelectTrigger className="w-40"><SelectValue placeholder="Vertical" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All verticals</SelectItem>
          {VERTICALS.map((v) => <SelectItem key={v} value={v}>{VERTICAL_LABEL[v]}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={filters.status || "all"} onValueChange={(v) => setFilters((f: any) => ({ ...f, status: v === "all" ? "" : v }))}>
        <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL(s)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Input
        type="number"
        placeholder="Min score"
        className="w-28"
        value={filters.minScore}
        onChange={(e) => setFilters((f: any) => ({ ...f, minScore: e.target.value }))}
      />
    </div>
  );
}

// ── find leads ───────────────────────────────────────────────────────────

function FindLeadsForm({ busy, error, notice, onSubmit }: { busy: boolean; error: string; notice: string; onSubmit: (vertical: Vertical, area: string, max: number) => Promise<void> }) {
  const [vertical, setVertical] = useState<Vertical>("dental");
  const [area, setArea] = useState("");
  const [max, setMax] = useState(20);
  return (
    <Panel>
      <div className="op-panel-title"><h2>Find leads</h2></div>
      <p className="text-sm text-muted-foreground">
        Searches OpenStreetMap by default — free, no billing — and checks each new result's own
        website. Google Places is available as a fallback once its key works (paid, part of the
        monthly budget above). Only works from this PC.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (area.trim()) void onSubmit(vertical, area.trim(), max); }}
      >
        <Select value={vertical} onValueChange={(v) => setVertical(v as Vertical)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {VERTICALS.map((v) => <SelectItem key={v} value={v}>{VERTICAL_LABEL[v]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input placeholder="Area, e.g. Parramatta NSW" value={area} onChange={(e) => setArea(e.target.value)} className="w-56" />
        <Input type="number" min={1} max={30} value={max} onChange={(e) => setMax(Number(e.target.value) || 20)} className="w-24" aria-label="Max results" />
        <Button type="submit" disabled={busy || !area.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Find leads
        </Button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
    </Panel>
  );
}

// ── detail drawer ────────────────────────────────────────────────────────

function LeadDetailDrawer({ id, onClose, onChanged, by }: { id: number | null; onClose: () => void; onChanged: () => void; by: Owner }) {
  const detail = useQuery<{ lead: Lead; activities: Activity[] }>({
    queryKey: ["leads-detail", id],
    queryFn: () => operatorRequest<{ lead: Lead; activities: Activity[] }>(`/leads/detail?id=${id}`, undefined, "GET"),
    enabled: id !== null,
  });
  const [draft, setDraft] = useState<{ to: string[]; subject: string; body: string } | null>(null);
  const [draftError, setDraftError] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraft(null);
    setDraftError("");
    setCopied(false);
  }, [id]);

  async function loadDraft() {
    if (!id) return;
    setDraftBusy(true);
    setDraftError("");
    try {
      setDraft(await operatorRequest(`/leads/draft?id=${id}`, undefined, "GET"));
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDraftBusy(false);
    }
  }

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
      setCopied(true);
    } catch { /* clipboard unavailable; the text is still selectable */ }
  }

  const lead = detail.data?.lead;
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{lead?.name || "Lead"}</SheetTitle>
        </SheetHeader>
        {detail.isLoading ? <Busy /> : !lead ? null : (
          <div className="mt-4 flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge tone="neutral">{VERTICAL_LABEL[lead.vertical]}</Badge>
              <Badge tone="neutral">Score {lead.score}</Badge>
              <Badge tone="neutral">{STATUS_LABEL(lead.status)}</Badge>
            </div>
            {lead.reasons.length > 0 && (
              <div>
                <div className="font-medium">Why M&U could help</div>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {lead.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            <div className="flex flex-col gap-1">
              {lead.phone && <a href={`tel:${lead.phone}`} className="inline-flex items-center gap-2 underline"><Phone size={14} /> {lead.phone}</a>}
              {lead.website && <a href={lead.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 underline"><ExternalLink size={14} /> {lead.website}</a>}
              {lead.mapsUrl && <a href={lead.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 underline"><MapPin size={14} /> View on Google Maps</a>}
              {lead.emails.map((e) => <span key={e} className="inline-flex items-center gap-2"><Mail size={14} /> {e}</span>)}
            </div>
            <div>
              <div className="font-medium">Activity</div>
              {!detail.data?.activities.length ? (
                <p className="text-muted-foreground">No activity logged yet.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
                  {detail.data.activities.map((a) => (
                    <li key={a.id}>{fmtDateTime(new Date(a.at), { year: true })} · {a.kind}{a.outcome ? ` (${STATUS_LABEL(a.outcome)})` : ""} · {a.by || "—"}{a.note ? ` — ${a.note}` : ""}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">Draft email</div>
                <Button size="sm" variant="outline" onClick={loadDraft} disabled={draftBusy}>
                  {draftBusy ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />} Draft email
                </Button>
              </div>
              {draftError && <Notice tone="danger">{draftError}</Notice>}
              {draft && (
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground">Draft only — this is never sent automatically. To: {draft.to.join(", ")}</p>
                  <Textarea readOnly className="mt-1 h-56 font-mono text-xs" value={`Subject: ${draft.subject}\n\n${draft.body}`} />
                  <Button size="sm" variant="outline" className="mt-2" onClick={copyDraft}>
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

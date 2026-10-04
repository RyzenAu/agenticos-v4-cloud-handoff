// One lead, in a side drawer: contact (one-tap copy), their real site + thumbnail, the audit
// findings with [verified] markers, the "Generate website" preview flow (generate → look → deploy
// behind a confirm → take down), logging a call, the follow-up and the activity log. Nothing here
// contacts the lead; deploy/take-down run only on a founder's confirmed click and are logged.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, ClipboardList, Copy, ExternalLink, FileSearch, Globe, Loader2, Mail, MapPin, Phone, PhoneCall, Rocket, Search, Sheet as SheetIcon, Trash2, Wand2 } from "lucide-react";
import { Badge, Button, DetailSection, Notice, SaveStatus, Skeleton, Tabs, TabPanel, fmtRelative } from "@/components/ds";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { operatorRequest } from "@/lib/operator";
import { cn } from "@/lib/utils";
import { startMeeting } from "@/lib/meeting-mode";
import {
  deployReply,
  leadSitesPost,
  leadSitesPostRaw,
  leadSitesStatus,
  leadsApi,
  localPreviewHref,
  nextAction,
  OBJECTION_LABEL,
  pitchInfo,
  seoAuditFileHref,
  siteHost,
  siteHref,
  statusLabel,
  statusTone,
  suburbOf,
  taggedReasons,
  useCopy,
  VERTICAL_LABEL,
  type CallScript,
  type Lead,
  type LeadStatus,
  type Owner,
  type PhoneFinding,
  type Preview,
  type SeoAuditRecord,
  type Vertical,
} from "@/lib/leads";
import { CopyButton, PlacesAttribution, ReasonChip } from "./lead-bits";
import { SalesBackofficePanel } from "./sales-backoffice-panel";
import { LeadIssuesBlock } from "./lead-issues";
import { websiteStateLine } from "@/lib/call-queue";
import { ContactPrefBlock, DealBlock } from "./deal-block";
import { fmtDateTime, fmtDay } from "@/lib/format";
import { hasLeadEditDraft, LeadEditor } from "./lead-editor";
import { usePageContext } from "@/components/shell/page-context";
import { PublishApprovalCard } from "@/components/approvals/publish-approval-card";
import { usePublishFlow } from "@/lib/use-publish-flow";

const OUTCOMES: { key: LeadStatus; label: string; needsDate?: boolean }[] = [
  { key: "no_answer", label: "No answer" },
  { key: "voicemail", label: "Voicemail" },
  { key: "call_back", label: "Call back", needsDate: true },
  { key: "interested", label: "Interested" },
  { key: "not_interested", label: "Not interested" },
  { key: "do_not_contact", label: "Do not contact" },
];

/** A 4xx (bad or unknown id, refused request) won't change on a retry: show it at once (audit F1-17). */
export const retryUnlessClientError = (failures: number, error: unknown) => {
  const status = (error as { status?: number } | null)?.status;
  return !(typeof status === "number" && status >= 400 && status < 500) && failures < 3;
};

/** The package the founder CHOSE for this deal, or null. The estimate's assumed entry tier
 *  (economics.packageId with packageState "assumed") is never a choice (audit F1-02). */
export function chosenPackage(deal: { record: { packageId: string | null }; economics: { packageState: { state: string } | null } } | undefined): string | null {
  return deal?.economics.packageState?.state === "chosen" ? deal.record.packageId ?? null : null;
}

/** Today in Sydney as YYYY-MM-DD: the earliest a call back can be booked. */
export const sydneyToday = (now = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

const dateLong = (iso: string) => fmtDay(new Date(iso), { year: true });
const dateTime = (iso: string) => fmtDateTime(new Date(iso));

const Block = DetailSection;

type LeadDrawerProps = { id: number | null; onClose: () => void; by: Owner; preview?: Preview; onChanged: () => void };
type LeadTab = "overview" | "call" | "deal" | "research" | "history";
const LEAD_TABS = [{ id: "overview", label: "Overview" }, { id: "call", label: "Call" }, { id: "deal", label: "Deal" }, { id: "research", label: "Research" }, { id: "history", label: "History" }] as const;

export function LeadDrawer(props: LeadDrawerProps) {
  return <LeadDrawerSession key={props.id ?? "closed"} {...props} />;
}

function LeadDrawerSession({ id, onClose, by, preview, onChanged }: LeadDrawerProps) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(() => id !== null && hasLeadEditDraft(id));
  const [saved, setSaved] = useState(false);
  const detail = useQuery({ queryKey: ["leads-detail", id], queryFn: () => leadsApi.detail(id!), enabled: id !== null, retry: retryUnlessClientError, refetchOnMount: "always" }); // opening a lead always reads it again: an edit starts from the current record, not a 5 s old copy
  const lead = detail.data?.lead;
  // Page context for Jarvis: "open this lead's website" names the lead the drawer shows (the address itself is read from the CRM).
  usePageContext("leads:drawer", lead ? { selection: { kind: "lead", id: String(lead.id), label: lead.name || "this lead", to: "/leads", search: { lead: String(lead.id) } } } : null);
  const [copied, copy] = useCopy();
  const [tab, setTab] = useState<LeadTab>("overview");
  const [visited, setVisited] = useState<Partial<Record<LeadTab, boolean>>>({ overview: true });
  const body = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const selectTab = (next: LeadTab) => {
    setTab(next);
    setVisited((current) => ({ ...current, [next]: true }));
    if (body.current) body.current.scrollTop = 0;
  };

  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="ds-detail-sheet w-full p-0 sm:max-w-[720px]"
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
        {detail.isLoading || !lead ? (
          <div className="flex flex-col gap-3 p-6">
            <SheetHeader><SheetTitle>Lead</SheetTitle><SheetDescription className="sr-only">Loading the lead</SheetDescription></SheetHeader>
            {detail.error ? <Notice tone="danger">{(detail.error as Error).message}</Notice> : [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
        ) : (
          <>
            <SheetHeader className="ds-detail-header space-y-2 text-left">
              <SheetTitle className="pr-8 text-xl font-semibold leading-tight">{lead.name || "(name not on file)"}</SheetTitle>
              <SheetDescription>
                {VERTICAL_LABEL[lead.vertical as Vertical] ?? lead.vertical} · {suburbOf(lead.area)}
              </SheetDescription>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge tone={statusTone(lead.status)}>{statusLabel(lead.status)}</Badge>
                {/* The "website" state is only "not verified" when the absence is not verified: a verified absence says so. */}
                {lead.pitch === "website" && !lead.website && detail.data?.issues?.status === "no_website_verified"
                  ? <Badge tone="success">No website (verified)</Badge>
                  : <Badge tone={pitchInfo(lead.pitch).tone}>{pitchInfo(lead.pitch).label}</Badge>}
                <Badge tone="neutral"><span className="ds-num">Score {lead.score}</span></Badge>
                {lead.excluded && <Badge tone="danger">Excluded</Badge>}
                {detail.data?.deal?.stuck && <Badge tone="warn">Stuck {detail.data.deal.stuck.days} d</Badge>}
              </div>
            </SheetHeader>
            <div className="ds-detail-nav">
              <Tabs tabs={[...LEAD_TABS]} value={tab} onChange={selectTab} idBase={`lead-${lead.id}`} label="Lead sections" />
            </div>
            <div className="ds-detail-body" ref={body}>
              {!!detail.error && <Notice tone="warn" className="mt-4">Couldn’t refresh this lead. Showing the last loaded details.</Notice>}
              {lead.excluded && <Notice tone="warn" className="mt-4" title="Excluded from calls and previews">{lead.excludedReason || "Not a prospect."}</Notice>}
              {lead.status === "do_not_contact" && <Notice tone="warn" className="mt-4">This lead asked not to be contacted.</Notice>}
              <TabPanel idBase={`lead-${lead.id}`} id="overview" active={tab === "overview"}>
                <section className="ds-detail-next" aria-label="Next action">
                  <h3>Next step</h3>
                  <p className={nextAction(lead).overdue ? "text-danger" : undefined}>{nextAction(lead).text}{nextAction(lead).overdue ? " — overdue" : ""}</p>
                  {!lead.excluded && !["won", "lost", "not_interested", "do_not_contact"].includes(lead.status) && <Button variant="accent" onClick={() => selectTab("call")}><PhoneCall /> Prepare call</Button>}
                </section>
                <Block title="Contact" actions={!editing && <Button variant="outline" onClick={() => { setEditing(true); setSaved(false); }}>Edit lead</Button>}>
              {editing ? <LeadEditor key={lead.editVersion ?? "none"} lead={lead} by={by} onCancel={() => setEditing(false)} onSaved={patch => {
                client.setQueryData(["leads-detail", id], (data: any) => data ? { ...data, lead: { ...data.lead, ...patch } } : data);
                setEditing(false); setSaved(true);
                void client.invalidateQueries({ queryKey: ["lead-script", id] });
                void client.invalidateQueries({ queryKey: ["lead-seo-audit", id] });
                void client.invalidateQueries({ queryKey: ["workspace"] });
                void detail.refetch(); onChanged();
              }} /> : <>
              {saved && <SaveStatus phase="saved" saved="Lead saved." className="mb-3 text-sm" />}
              <ul className="flex flex-col gap-1 text-sm">
                {lead.phone ? (
                  <li className="lead-contact-row flex items-center justify-between gap-3">
                    <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-2 underline-offset-2 hover:underline"><Phone className="size-3.5 text-muted-foreground" /><span className="ds-num">{lead.phone}</span></a>
                    <CopyButton value={lead.phone} label="phone" icon={Copy} copied={copied === "phone"} onCopy={() => copy("phone", lead.phone)} />
                  </li>
                ) : <li className="text-muted-foreground">No phone on file.</li>}
                <PhoneFinder lead={lead} finding={detail.data?.phoneFinding ?? null} onFound={() => { void detail.refetch(); onChanged(); }} />
                {lead.emails.map((e) => (
                  <li key={e} className="lead-contact-row flex items-center justify-between gap-3">
                    <span className="inline-flex min-w-0 items-center gap-2"><Mail className="size-3.5 shrink-0 text-muted-foreground" /><span>{e}</span>{!lead.emailOk && <Badge tone="warn">Don't email</Badge>}</span>
                    <CopyButton value={e} label="email" icon={Copy} copied={copied === e} onCopy={() => copy(e, e)} />
                  </li>
                ))}
                {lead.mapsUrl && (
                  <li><a href={lead.mapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"><MapPin className="size-3.5" /> Open the map listing</a></li>
                )}
              </ul>
              {lead.placesLive && <PlacesAttribution live={lead.placesLive} />}
              </>}
            </Block>
                <Block title="At a glance">
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3">
                    <dt className="text-muted-foreground">Owner</dt><dd className="capitalize">{lead.owner || "Unassigned"}</dd>
                    {/* Provenance shows only when it was recorded: a column of "Not recorded" says nothing. */}
                    {lead.source && <><dt className="text-muted-foreground">Lead source</dt><dd>{lead.source === "osm" ? "OpenStreetMap" : lead.source === "google" ? "Google Places" : lead.source}</dd></>}
                    {lead.websiteSource && <><dt className="text-muted-foreground">Website source</dt><dd>{lead.websiteSource.replace(/_/g, " ")}</dd></>}
                    {lead.websiteCheckedAt && <><dt className="text-muted-foreground">Website checked</dt><dd>{dateTime(lead.websiteCheckedAt)}</dd></>}
                    {lead.address && <><dt className="text-muted-foreground">Address</dt><dd>{lead.address}</dd></>}
                    {lead.website && <><dt className="text-muted-foreground">Website</dt><dd><a href={siteHref(lead.website)} target="_blank" rel="noreferrer" className="underline underline-offset-4">{siteHost(lead.website)}</a></dd></>}
                    {lead.lastContactAt && <><dt className="text-muted-foreground">Last contact</dt><dd>{fmtRelative(lead.lastContactAt)}</dd></>}
                  </dl>
                </Block>
                {detail.data?.deal?.contactPref && <Block title="Contact notes"><p>{detail.data.deal.contactPref}</p><Button variant="ghost" className="mt-3" onClick={() => selectTab("call")}>Edit contact notes</Button></Block>}
              </TabPanel>
              <TabPanel idBase={`lead-${lead.id}`} id="call" active={tab === "call"}>
                {visited.call && <>
                  <CallBlock
              lead={lead}
              contactPref={detail.data?.deal?.contactPref ?? ""}
              onStartMeeting={() => {
                // AUDIT-F1 F1-04: the modal drawer blocked the meeting panel. Close it first; the panel's lead is prefilled.
                onClose();
                void startMeeting(String(lead.id));
              }}
            />
                  <LogCall lead={lead} by={by} onLogged={async () => { onChanged(); await detail.refetch().catch(() => undefined); }} />
                  <details className="ds-detail-secondary"><summary>Edit contact notes</summary><ContactPrefBlock leadId={lead.id} value={detail.data?.deal?.contactPref ?? ""} by={by} onSaved={() => { void detail.refetch(); onChanged(); }} /></details>
                </>}
              </TabPanel>
              <TabPanel idBase={`lead-${lead.id}`} id="deal" active={tab === "deal"}>
                {visited.deal && <>
                  {detail.data?.deal && <DealBlock leadId={lead.id} deal={detail.data.deal} by={by} onSaved={() => { void detail.refetch(); onChanged(); }} />}
                  <SalesBackofficePanel key={lead.id} id={lead.id} pipeline={detail.data?.pipeline} initialFiles={detail.data?.drafts} by={by} offer={detail.data?.deal?.economics.offer} packageId={chosenPackage(detail.data?.deal)} refresh={() => { void detail.refetch(); onChanged(); }} />

                </>}
              </TabPanel>
              <TabPanel idBase={`lead-${lead.id}`} id="research" active={tab === "research"}>
                {visited.research && <>
                  <RealSite lead={lead} thumbAt={preview?.thumb?.at ?? null} onChanged={onChanged} websiteStatus={detail.data?.issues?.status} />

            <LeadIssuesBlock issues={detail.data?.issues ?? null} />

            <Block title="Why M&U could help">
              {lead.reasons.length ? (
                <ul className="lead-reasons flex flex-col gap-3">
                  {taggedReasons(lead).map((r, i) => <li key={i}><ReasonChip {...r} /></li>)}
                </ul>
              ) : <p className="text-sm text-muted-foreground">No audit findings on file.</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                “Seen on their site” means we saw it on their own website; “directory signal” comes from a listing.
                {lead.websiteCheckedAt ? ` Website last checked ${dateLong(lead.websiteCheckedAt)}.` : ""}
              </p>
            </Block>

            {!lead.excluded && <SeoAuditBlock lead={lead} />}
                  <WebsitePreview lead={lead} preview={preview} by={by} onChanged={onChanged} onDone={() => detail.refetch()} />
                </>}
              </TabPanel>
              <TabPanel idBase={`lead-${lead.id}`} id="history" active={tab === "history"}>
                {visited.history && <><Block title="Activity">
              {!detail.data?.activities.length ? (
                <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
              ) : (
                <ol className="lead-activity flex flex-col">
                  {detail.data.activities.slice(0, 20).map((a) => (
                    <li key={a.id} className="flex gap-3 text-sm">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">
                          {dateTime(a.at)} · {statusLabel(a.kind)}{a.outcome ? ` · ${statusLabel(a.outcome)}` : ""}{a.by ? ` · ${a.by.charAt(0).toUpperCase()}${a.by.slice(1)}` : ""}
                        </div>
                        {a.note && <p className="mt-0.5 break-words text-foreground">{a.note}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Block></>}
              </TabPanel>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── phone provenance + "Find phone" (scripts/leads/phone-finder.ts) ────────

function PhoneFinder({ lead, finding, onFound }: { lead: Lead; finding: PhoneFinding | null; onFound: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  useEffect(() => { setError(""); setInfo(""); }, [lead.id]);
  const found = !!lead.phone && !!lead.phoneSource?.startsWith("found_");
  const canSearch = !lead.phone && !lead.excluded && lead.status !== "do_not_contact";

  async function run() {
    setBusy(true); setError(""); setInfo("");
    try {
      const r = await leadsApi.findPhone(lead.id);
      setInfo(r.outcome === "written" ? "Phone found and saved." : r.outcome === "suggested" ? `Not certain enough to save: ${r.reason}.` : `Nothing solid: ${r.reason}.`);
      onFound();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sources = finding?.sources.slice(0, 3) ?? [];
  return (
    <>
      {found && finding && (
        <li className="text-xs text-muted-foreground">
          {finding.summary.replace(/^found/, "Found")}
          {sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="ml-1.5 underline-offset-2 hover:underline">{s.label}</a>)}
        </li>
      )}
      {!lead.phone && lead.suggestedPhone && (
        <li className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="warn">Suggested — verify</Badge>
          <span className="ds-num">{lead.suggestedPhone}</span>
          {finding?.kind === "mobile" && <Badge tone="neutral">Mobile</Badge>}
          <span className="text-xs text-muted-foreground">
            {finding?.reason}{sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="ml-1.5 underline-offset-2 hover:underline">{s.label}</a>)}
          </span>
        </li>
      )}
      {canSearch && (
        <li>
          <Button size="xs" variant="outline" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Search />} {finding ? "Search again" : "Find phone"}
          </Button>
          {busy && <span className="ml-2 text-xs text-muted-foreground">Searching listings — up to a minute or two.</span>}
          {finding && !busy && !info && <span className="ml-2 text-xs text-muted-foreground">Last searched {fmtRelative(finding.checkedAt)}.</span>}
        </li>
      )}
      {info && <li className="text-xs text-muted-foreground">{info}</li>}
      {error && <li><Notice tone="danger">{error}</Notice></li>}
    </>
  );
}

// ── their real site ──────────────────────────────────────────────────────

export function RealSite({ lead, thumbAt, onChanged, websiteStatus }: { lead: Lead; thumbAt: string | null; onChanged: () => void; websiteStatus?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only a recorded screenshot is requested: asking for one that doesn't exist logged a 404 on
  // every drawer open (audit F1-18). A lead without a preview reads its stamp from the status.
  const thumbs = useQuery({
    queryKey: ["lead-thumb", lead.id], queryFn: () => leadSitesStatus([lead.id]),
    enabled: !!lead.website && !thumbAt, retry: false, staleTime: 60_000,
  });
  const known = thumbAt ?? thumbs.data?.thumbs?.[String(lead.id)] ?? null;
  const [stamp, setStamp] = useState<string | null>(known);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setStamp(known); setBroken(false); setError(""); }, [lead.id, known]);
  const tried = !!stamp;

  async function capture() {
    setBusy(true); setError("");
    try {
      const r = await leadSitesPost<{ thumb: { at: string | null } }>("/thumb", { lead: lead.id });
      setStamp(r.thumb.at ?? new Date().toISOString());
      setBroken(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!lead.website)
    return (
      <Block title="Their website">
        <p className="text-sm text-muted-foreground">
          {websiteStateLine(lead, websiteStatus)}.
        </p>
      </Block>
    );
  return (
    <Block
      title="Their website"
      actions={lead.excluded ? undefined : <Button variant="ghost" size="xs" onClick={capture} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Camera />} {stamp ? "Refresh" : "Capture"} screenshot</Button>}
    >
      <a href={siteHref(lead.website)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-foreground underline-offset-2 hover:underline">
        <Globe className="size-3.5 text-muted-foreground" /> {siteHost(lead.website)} <ExternalLink className="size-3 text-muted-foreground" />
      </a>
      {tried && !broken && (
        <a href={siteHref(lead.website)} target="_blank" rel="noreferrer" className="mt-2 block overflow-hidden rounded-lg border border-border bg-inset">
          <img
            src={`/__lead-sites/thumb?id=${lead.id}${stamp ? `&t=${encodeURIComponent(stamp)}` : ""}`}
            alt={`Screenshot of ${siteHost(lead.website)}`}
            className="aspect-[16/10] w-full object-cover object-top"
            loading="lazy"
            onError={() => setBroken(true)}
          />
        </a>
      )}
      {(!stamp || broken) && !busy && <p className="mt-1 text-xs text-muted-foreground">{lead.excluded ? "No screenshot (excluded leads aren't captured)." : "No screenshot yet — capture one to see their current site here."}</p>}
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
    </Block>
  );
}

// ── generate website ─────────────────────────────────────────────────────

function WebsitePreview({ lead, preview, by, onChanged, onDone }: { lead: Lead; preview?: Preview; by: Owner; onChanged: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<"" | "generate">("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const [confirmDown, setConfirmDown] = useState(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => { setError(""); setInfo(""); }, [lead.id]);

  const blocked = lead.excluded ? "Excluded leads never get a preview." : lead.status === "do_not_contact" ? "This lead asked not to be contacted." : lead.status === "won" ? "Won — build the real site from the client project." : "";

  // Deploy and take-down are outward, so on a server-role hub they go through a B2 approval (src/lib/publish-flow.ts): the first POST
  // answers 202 and nothing is published, the card below waits for the approval, and the hub then runs it once. On a PC hub the
  // first POST just does it (200), exactly as before.
  const deployFlow = usePublishFlow({
    resumeKey: `lead:${lead.id}:deploy`,
    send: async (approvalId) => deployReply(await leadSitesPostRaw("/deploy", approvalId ? { lead: lead.id, by, approvalId } : { lead: lead.id, by, confirm: preview?.domain })),
    onSettled: () => { onChanged(); onDone(); },
  });
  const takedownFlow = usePublishFlow({
    resumeKey: `lead:${lead.id}:takedown`,
    send: async (approvalId) => leadSitesPostRaw("/takedown", approvalId ? { lead: lead.id, by, approvalId } : { lead: lead.id, by }),
    onSettled: () => { onChanged(); onDone(); },
  });
  const inFlight = (k: string) => k === "asking" || k === "waiting" || k === "approved" || k === "running";
  const flowBusy = inFlight(deployFlow.state.kind) || inFlight(takedownFlow.state.kind);

  async function run(kind: "generate") {
    setBusy(kind); setError(""); setInfo("");
    try {
      const r = await leadSitesPost<{ preview: Preview; missing?: string[]; services?: number; listings?: { summary?: string } }>(`/${kind}`, { lead: lead.id, by });
      setInfo(`Drafted from ${r.services ?? 0} verified service${r.services === 1 ? "" : "s"}; placeholders for ${r.missing?.join(", ") || "nothing"}. Check it before deploying.${r.listings?.summary ? ` ${r.listings.summary}` : ""}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      onChanged();
      onDone();
    }
  }

  const live = preview?.status === "live";
  const drafted = preview && preview.status !== "taken_down" || false;
  return (
    <Block title="Website preview">
      {!preview || preview.status === "taken_down" ? (
        <p className="text-sm text-muted-foreground">
          {preview?.status === "taken_down" && preview.takenDownAt ? `The last preview was taken down ${dateLong(preview.takenDownAt)}. ` : ""}
          Turns the {VERTICAL_LABEL[lead.vertical as Vertical] ?? lead.vertical} flagship into a preview for {lead.name}, filled only from verified facts. It stays on this PC until you deploy it.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {live ? (
              preview.expired ? <Badge tone="danger">Expired — take it down</Badge> : <Badge tone="success">Live · {preview.daysLeft} day{preview.daysLeft === 1 ? "" : "s"} left</Badge>
            ) : preview.status === "failed" ? <Badge tone="danger">Deploy failed</Badge> : preview.status === "deploying" ? <Badge tone="info">Deploying</Badge> : <Badge tone="neutral">Drafted, not deployed</Badge>}
            <span className="text-sm text-muted-foreground">{preview.domain}</span>
          </div>
          {live && (
            <>
              <a href={preview.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium underline-offset-2 hover:underline">{preview.url} <ExternalLink className="size-3" /></a>
              <p className="text-xs text-muted-foreground">
                Deployed {preview.deployedAt ? dateLong(preview.deployedAt) : ""}{preview.deployedBy ? ` by ${preview.deployedBy}` : ""} · expires {preview.expiresAt ? dateLong(preview.expiresAt) : "—"}
              </p>
              {preview.verified && (
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={preview.verified.status === 200 ? "success" : "danger"}>HTTP {preview.verified.status || "—"}</Badge>
                  <Badge tone={preview.verified.banner ? "success" : "danger"}>{preview.verified.banner ? "Banner shown" : "Banner missing"}</Badge>
                  <Badge tone={preview.verified.noindexHeader ? "success" : "danger"}>{preview.verified.noindexHeader ? "Noindex header" : "Noindex missing"}</Badge>
                </div>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Drafted {fmtRelative(preview.generatedAt)} · {preview.serviceCount} verified service{preview.serviceCount === 1 ? "" : "s"}
            {preview.missing.length ? ` · placeholders for ${preview.missing.join(", ")}` : ""}
          </p>
          {preview.lastError && <Notice tone={live ? "warn" : "danger"}>{preview.lastError}</Notice>}
        </div>
      )}
      {blocked ? (
        <p className="mt-2 text-xs text-muted-foreground">{blocked}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant={drafted ? "outline" : "accent"} onClick={() => run("generate")} disabled={!!busy || flowBusy}>
            {busy === "generate" ? <Loader2 className="animate-spin" /> : <Wand2 />} {drafted ? "Regenerate" : "Generate website"}
          </Button>
          {drafted && (
            <Button asChild size="sm" variant="outline">
              <a href={localPreviewHref(preview!)} target="_blank" rel="noreferrer"><ExternalLink /> Open local preview</a>
            </Button>
          )}
          {drafted && !live && (
            <Button size="sm" variant="accent" onClick={() => { setChecked(false); setConfirmDeploy(true); }} disabled={!!busy || flowBusy}>
              {inFlight(deployFlow.state.kind) ? <Loader2 className="animate-spin" /> : <Rocket />} Deploy…
            </Button>
          )}
          {live && (
            <Button size="sm" variant="outline" onClick={() => { setChecked(false); setConfirmDeploy(true); }} disabled={!!busy || flowBusy}>
              {inFlight(deployFlow.state.kind) ? <Loader2 className="animate-spin" /> : <Rocket />} Redeploy…
            </Button>
          )}
          {(live || preview?.status === "failed") && (
            <Button size="sm" variant="outline" className="text-danger hover:text-danger" onClick={() => setConfirmDown(true)} disabled={!!busy || flowBusy}>
              {inFlight(takedownFlow.state.kind) ? <Loader2 className="animate-spin" /> : <Trash2 />} Take down…
            </Button>
          )}
        </div>
      )}
      {deployFlow.state.kind === "running" && <p className="mt-2 text-xs text-muted-foreground">Deploying to Vercel and checking the live page — this takes about a minute.</p>}
      {preview && (
        <>
          <PublishApprovalCard
            state={deployFlow.state}
            flow={deployFlow.flow}
            what={`${lead.name}'s website preview (hidden from search, lasts 30 days)`}
            where={`https://${preview.domain}`}
            doneText={(r) => { const p = (r as { preview?: Preview } | undefined)?.preview; return p?.url ? `Live at ${p.url} and checked.` : "Live and checked."; }}
            askAgain={() => { setChecked(false); setConfirmDeploy(true); }}
          />
          <PublishApprovalCard
            state={takedownFlow.state}
            flow={takedownFlow.flow}
            verb="Will remove"
            approveLabel="Approve and take down"
            what={`${lead.name}'s live preview (it will stop working)`}
            where={`https://${preview.domain}`}
            doneText={() => "Taken down. The local copy stays for reference."}
            askAgain={() => setConfirmDown(true)}
          />
        </>
      )}
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
      {info && <Notice tone="success" className="mt-2">{info}</Notice>}

      <AlertDialog open={confirmDeploy} onOpenChange={setConfirmDeploy}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Put this preview online?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <p>It goes live at <span className="font-mono text-foreground">{preview?.domain}</span> under {lead.name}'s name, as one founder-triggered preview. It will carry:</p>
                <ul className="list-disc pl-5">
                  <li>a banner on every screen: "Not the official {lead.name} website"</li>
                  <li>noindex headers, no tracking, and forms that can't send</li>
                  <li>a 30-day expiry, after which the page stops showing</li>
                </ul>
                <p>Nothing is sent to {lead.name}. The deploy is logged on this lead.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5" />
            <span>I've opened the local preview and checked every fact on it.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!checked} onClick={() => void deployFlow.flow.start()}>Deploy preview</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDown} onOpenChange={setConfirmDown}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take this preview down?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the Vercel project <span className="font-mono">{preview?.project}</span> and its subdomain {preview?.domain}. The local copy stays on this PC, and you can generate and deploy again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it live</AlertDialogCancel>
            <AlertDialogAction onClick={() => void takedownFlow.flow.start()}>Take down</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Block>
  );
}

// ── SEO audit (jev-seo) ──────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, "danger" | "warn" | "neutral"> = { critical: "danger", high: "danger", medium: "warn", low: "neutral" };

export function SeoAuditBlock({ lead }: { lead: Lead }) {
  const statusQuery = useQuery({ queryKey: ["lead-seo-audit", lead.id], queryFn: () => leadsApi.seoAuditStatus(lead.id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const audit: SeoAuditRecord | null = statusQuery.data?.audit ?? null;

  async function run() {
    setBusy(true);
    setError("");
    try {
      await leadsApi.runSeoAudit(lead.id);
      await statusQuery.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!lead.website) return null;
  return (
    <Block
      title="SEO audit"
      actions={
        <Button size="xs" variant={audit?.ok ? "outline" : "accent"} onClick={run} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <FileSearch />} {audit ? "Re-run audit" : "SEO audit"}
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        One founder-clicked, read-only crawl of {siteHost(lead.website)} — 52 rules plus Jev judgments, about 1¢ in Jev. Never sent to {lead.name}; results stay on this PC.
      </p>
      {busy && <p className="mt-2 text-xs text-muted-foreground">Crawling and scoring — this can take a few minutes.</p>}
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
      {audit && !audit.ok && !busy && <Notice tone="danger" className="mt-2">{audit.error || "The last audit failed."}</Notice>}
      {audit?.ok && (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral"><span className="ds-num">Score {audit.overall ?? "—"}{audit.grade ? ` (${audit.grade})` : ""}</span></Badge>
            {audit.costUsd != null && <Badge tone="neutral">${audit.costUsd.toFixed(4)} in Jev</Badge>}
            <span className="text-xs text-muted-foreground">Run {fmtRelative(audit.finishedAt)}</span>
          </div>
          {audit.topFindings.length > 0 && (
            <div>
              <h4 className="ds-label text-muted-foreground">Top findings</h4>
              <ul className="mt-1 flex flex-col gap-1.5">
                {audit.topFindings.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <Badge tone={SEVERITY_TONE[f.severity] ?? "neutral"} className="mt-0.5 shrink-0">{f.priority || f.severity}</Badge>
                    <span>{f.title}{f.evidence ? <span className="text-muted-foreground"> — {f.evidence}</span> : null}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Ranks work to do — scores don't predict search rankings. These findings also feed the call script's opener above.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {audit.files.pdf ? (
              <Button asChild size="xs" variant="outline">
                <a href={seoAuditFileHref(lead.id, "pdf")} target="_blank" rel="noreferrer"><ExternalLink /> Open PDF</a>
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">PDF not built on this machine yet.</span>
            )}
            {audit.files.xlsx && (
              <Button asChild size="xs" variant="outline">
                <a href={seoAuditFileHref(lead.id, "xlsx")} target="_blank" rel="noreferrer"><SheetIcon /> Open action list</a>
              </Button>
            )}
            {audit.files.md && (
              <Button asChild size="xs" variant="ghost">
                <a href={seoAuditFileHref(lead.id, "md")} target="_blank" rel="noreferrer">Full report (MD)</a>
              </Button>
            )}
          </div>
        </div>
      )}
    </Block>
  );
}

// ── call script + start call (meeting mode) ─────────────────────────────

function formatScript(s: CallScript): string {
  return [
    `Opener: ${s.opener}`,
    "",
    "Discovery:",
    ...s.discovery.map((q) => `- ${q}`),
    "",
    `Value pitch: ${s.valuePitch}`,
    "",
    "Objections:",
    ...(Object.keys(OBJECTION_LABEL) as (keyof CallScript["objections"])[]).map((k) => `- ${OBJECTION_LABEL[k]}: ${s.objections[k]}`),
    "",
    `Close: ${s.close}`,
    "",
    `Follow-up email — Subject: ${s.followupEmail.subject}`,
    s.followupEmail.body,
  ].join("\n");
}

export function CallBlock({ lead, contactPref, onStartMeeting }: { lead: Lead; contactPref: string; onStartMeeting?: () => void }) {
  const scriptQuery = useQuery({ queryKey: ["lead-script", lead.id], queryFn: () => leadsApi.script(lead.id) });
  const summary = useQuery({ queryKey: ["leads-summary"], queryFn: leadsApi.summary });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, copy] = useCopy();
  const script = scriptQuery.data?.script ?? null;
  const callWindow = summary.data?.callWindow;
  const canCall = !lead.excluded && lead.status !== "do_not_contact";

  async function generate() {
    setBusy(true);
    setError("");
    try {
      await leadsApi.generateScript(lead.id);
      await scriptQuery.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block
      title="Call"
      actions={
        <Button size="xs" variant="outline" disabled={!canCall} onClick={onStartMeeting ?? (() => void startMeeting(String(lead.id)))}>
          <PhoneCall /> Start call (meeting mode)
        </Button>
      }
    >
      {contactPref && (
        <p className="mb-2 rounded-md border border-border bg-inset px-2.5 py-2 text-sm text-foreground">
          <span className="ds-label mr-1.5 text-muted-foreground">How they like to be contacted</span>{contactPref}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {callWindow && canCall && <Badge tone={callWindow.open ? "success" : "warn"}>{callWindow.open ? "Calling hours open" : `Calling hours closed — ${callWindow.why}`}</Badge>}
        {canCall && <Badge tone="neutral">Check the DNC Register before calling</Badge>}
        <Badge tone="neutral">No invented claims — verified facts only</Badge>
      </div>
      {!canCall ? (
        <p className="mt-2 text-xs text-muted-foreground">{lead.excluded ? "Excluded leads never get a call script." : "This lead asked not to be contacted."}</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant={script ? "outline" : "accent"} onClick={generate} disabled={busy || scriptQuery.isLoading}>
              {busy ? <Loader2 className="animate-spin" /> : <ClipboardList />} {script ? "Regenerate script" : "Call script"}
            </Button>
            {script && (
              <Button size="sm" variant="ghost" onClick={() => copy("script", formatScript(script))}>
                {copied === "script" ? <Check /> : <Copy />} {copied === "script" ? "Copied" : "Copy script"}
              </Button>
            )}
          </div>
          {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
          {script && (
            <div className="lead-script mt-3 flex flex-col gap-5 text-sm">
              <p className="text-xs text-muted-foreground">
                Generated {fmtRelative(script.generatedAt)} via {script.model} for the "{pitchInfo(script.pitch).label}" pitch. {script.compliance.noInventedClaims}
              </p>
              <div>
                <h4 className="ds-label text-muted-foreground">Opener</h4>
                <p className="mt-1">{script.opener}</p>
              </div>
              <div>
                <h4 className="ds-label text-muted-foreground">Discovery questions</h4>
                <ul className="mt-1 list-disc pl-5">{script.discovery.map((q, i) => <li key={i}>{q}</li>)}</ul>
              </div>
              <div>
                <h4 className="ds-label text-muted-foreground">Value pitch</h4>
                <p className="mt-1 whitespace-pre-wrap">{script.valuePitch}</p>
              </div>
              <details className="ds-detail-secondary">
                <summary>Objection responses</summary>
                <ul className="mt-1 flex flex-col gap-1.5">
                  {(Object.keys(OBJECTION_LABEL) as (keyof CallScript["objections"])[]).map((k) => (
                    <li key={k}><span className="font-medium text-foreground">{OBJECTION_LABEL[k]}</span> — {script.objections[k]}</li>
                  ))}
                </ul>
              </details>
              <div>
                <h4 className="ds-label text-muted-foreground">Close</h4>
                <p className="mt-1">{script.close}</p>
              </div>
              <details className="ds-detail-secondary">
                <summary>Follow-up email draft</summary><p className="text-sm text-muted-foreground">Draft only. Nothing is sent.</p>
                <Textarea readOnly className="mt-1 h-40 text-sm" value={`Subject: ${script.followupEmail.subject}\n\n${script.followupEmail.body}`} aria-label="Follow-up email draft" />
              </details>
            </div>
          )}
        </>
      )}
    </Block>
  );
}

// ── log a call ───────────────────────────────────────────────────────────

export function LogCall({ lead, by, onLogged }: { lead: Lead; by: Owner; onLogged: () => void | Promise<unknown> }) {
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState<LeadStatus | null>(null);
  const [error, setError] = useState("");
  // "Do not contact" is permanent (the opt-out cannot be edited away), so it takes a second, deliberate click.
  const [confirmDnc, setConfirmDnc] = useState(false);
  const armedAt = useRef(0);
  // A double-click (two clicks before the first request has even left) logs ONE call: an in-flight guard, and a key per attempt that
  // /leads/log dedupes on. The key is kept until the call is logged, so a retry after a dropped answer cannot log it twice either.
  const inFlight = useRef(false);
  // `until`: after a success the key is kept for a few seconds, because a fast local hub answers between the two clicks of a double-click.
  const attemptKey = useRef<{ key: string; outcome: LeadStatus; until: number } | null>(null);
  const cancelDnc = useRef<HTMLButtonElement | null>(null);
  // Focus goes to Cancel, the safe choice, when the confirmation appears.
  useEffect(() => { if (confirmDnc) cancelDnc.current?.focus(); }, [confirmDnc]);
  useEffect(() => { setNote(""); setDate(""); setError(""); setConfirmDnc(false); attemptKey.current = null; }, [lead.id]);
  const next = nextAction(lead);

  const pastDate = !!date && date < sydneyToday();

  async function log(outcome: LeadStatus) {
    if (outcome === "call_back" && (!date || pastDate)) return;
    if (outcome === "do_not_contact") {
      // First click arms it. The confirmation is a different button in a different place, and clicks in the first
      // half second are ignored, so a double-click can never arm and confirm a permanent opt-out.
      if (!confirmDnc) { armedAt.current = Date.now(); setConfirmDnc(true); return; }
      if (Date.now() - armedAt.current < 500) return;
    }
    if (inFlight.current) return;
    // The same outcome just logged (a success within the last 5 s, a fast hub answering between the two clicks of a double-click) is not logged again.
    const recent = attemptKey.current;
    if (recent && recent.outcome === outcome && Number.isFinite(recent.until) && Date.now() < recent.until) return;
    inFlight.current = true;
    setConfirmDnc(false);
    setBusy(outcome); setError("");
    const held = attemptKey.current;
    if (!held || held.outcome !== outcome || Date.now() > held.until) attemptKey.current = { until: Infinity, key: `${lead.id}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, outcome };
    try {
      await operatorRequest("/leads/log", { lead: lead.id, outcome, kind: "call", by, note, next: outcome === "call_back" ? date : null, event: attemptKey.current!.key }, "POST");
      // For 5 s the same outcome is not sent again (above); a different outcome is a different call and gets its own key.
      if (attemptKey.current) attemptKey.current.until = Date.now() + 5000;
      setNote(""); setDate("");
      // The buttons stay disabled until the drawer has re-read the lead.
      await onLogged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <Block title="Log a call">
      <p className={cn("text-sm", next.overdue ? "font-medium text-danger" : "text-foreground")}>
        {next.text}{next.overdue ? " — overdue" : ""}
        {lead.lastContactAt && <span className="text-muted-foreground"> · last contact {fmtRelative(lead.lastContactAt)}</span>}
      </p>
      {!lead.excluded && !["won", "lost", "not_interested", "do_not_contact"].includes(lead.status) && (
        <>
          <p className="mt-3 text-xs text-muted-foreground">Log a call as {by === "usman" ? "Usman" : "Mehroz"}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <Button key={o.key} size="xs" variant="outline" className={o.key === "do_not_contact" ? "text-danger hover:text-danger" : undefined}
                disabled={busy !== null || (o.needsDate && (!date || pastDate)) || (o.key === "do_not_contact" && confirmDnc)} onClick={() => log(o.key)}>
                {busy === o.key ? <Loader2 className="animate-spin" /> : o.label}
              </Button>
            ))}
          </div>
          {confirmDnc && (
            <div className="mt-2 rounded-lg border border-danger/40 p-3" role="alertdialog" aria-label="Confirm do not contact">
              <p className="text-sm text-foreground" role="status">This marks {lead.name || "this lead"} as asking not to be contacted. It can't be undone from here.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button ref={cancelDnc} size="xs" variant="outline" onClick={() => setConfirmDnc(false)}>Cancel</Button>
                <Button size="xs" variant="outline" className="text-danger hover:text-danger" disabled={busy !== null} onClick={() => log("do_not_contact")}>Confirm: do not contact</Button>
              </div>
            </div>
          )}
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            Call back on
            <input type="date" value={date} min={sydneyToday()} onChange={(e) => setDate(e.target.value)} className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground" />
          </label>
          {pastDate && <p className="mt-1 text-xs text-danger" role="alert">A call back can't be booked in the past. Choose today or later.</p>}
          <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="mt-2 h-16 text-sm" />
          {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
        </>
      )}
    </Block>
  );
}

// ── email draft ──────────────────────────────────────────────────────────

function EmailDraft({ lead }: { lead: Lead }) {
  const [draft, setDraft] = useState<{ to: string[]; subject: string; body: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  useEffect(() => { setDraft(null); setError(""); }, [lead.id]);
  if (!lead.emails.length) return null;
  async function load() {
    setBusy(true); setError("");
    try {
      setDraft(await operatorRequest(`/leads/draft?id=${lead.id}`, undefined, "GET"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const text = draft ? `Subject: ${draft.subject}\n\n${draft.body}` : "";
  return (
    <Block title="Email draft" actions={<Button size="xs" variant="ghost" onClick={load} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Mail />} Draft</Button>}>
      <p className="text-xs text-muted-foreground">Text to copy — never sent from here.</p>
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
      {draft && (
        <>
          <Textarea readOnly className="mt-2 h-48 text-sm" value={text} aria-label="Email draft" />
          <Button size="xs" variant="outline" className="mt-2" onClick={() => copy("draft", text)}>{copied === "draft" ? <Check /> : <Copy />} {copied === "draft" ? "Copied" : "Copy"}</Button>
        </>
      )}
    </Block>
  );
}

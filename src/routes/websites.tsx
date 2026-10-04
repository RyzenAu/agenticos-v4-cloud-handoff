// Sales -> Website: M&U's own websites in one place. Client sites and flagships (live links, Vercel
// deploy times, repo commits), every generated lead preview as a before/after against the lead's
// real site, and the local templates and site-drafts — each with a local preview on its own origin
// (scripts/lead-sites/preview-server.ts). Data: /__websites (scripts/websites/plugin.ts) and
// /__lead-sites/status. Nothing here deploys or contacts anyone: Generate / Deploy / Take down stay
// in the lead drawer's founder-click flow, which this page opens.
import { docTitle } from "@/components/shell/destinations";
import showcaseCss from "@/components/operator/refero-showcase.css?url";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Camera,
  ChevronDown,
  ExternalLink,
  FolderGit2,
  Globe2,
  Laptop,
  Loader2,
  MessageSquareText,
  Film,
  RefreshCw,
  Rocket,
  Sparkles,
  Wand2,
} from "lucide-react";
import { ActionBar, Badge, Button, Disclosure, Notice, PageFoot, PageHeader, Segmented, Skeleton, Surface, Widget, WidgetGrid, WidgetList, fmtDate, fmtRelative, type Tone } from "@/components/ds";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { openJarvisText } from "@/components/shell/jarvis-slot";
import { PRESET_SKILLS } from "@/lib/site-maker";
import { LeadDrawer } from "@/components/operator/lead-drawer";
import { LocalSiteWorkspace, readHistory, validLocal } from "@/components/operator/local-site-workspace";
import { leadSitesStatus, localPreviewHref, useOwner, VERTICAL_LABEL, type Preview, type Vertical } from "@/lib/leads";
import {
  daysUntil,
  hostOf,
  inDays,
  queueScreenshots,
  screenshotErrorText,
  screenshotsToTake,
  thumbSrc,
  websitesOverview,
  type LocalDraft,
  type LocalTemplate,
  type OurSite,
  type PreviewExtras,
  type ThumbState,
} from "@/lib/websites";
import { cn } from "@/lib/utils";
import { useOpenOnHash } from "@/components/shell/use-open-on-hash";
import { MakeSite } from "@/components/websites/make-site";
import { fmtDateTime, fmtDay } from "@/lib/format";

const ReferoPreviews = lazy(() => import("@/components/operator/refero-previews").then((m) => ({ default: m.ReferoPreviews })));

export const Route = createFileRoute("/websites")({
  component: WebsitesPage,
  head: () => ({
    links: [{ rel: "stylesheet", href: showcaseCss }],
    meta: [
      { title: docTitle("/websites") },
      { name: "description", content: "M&U's client sites, flagships, lead previews and drafts, with local previews." },
    ],
  }),
});

const verticalLabel = (v: string | null) => (v ? VERTICAL_LABEL[v as Vertical] ?? v : "—");
const dayLong = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return fmtDay(new Date(y, m - 1, d), { weekday: true });
};
const stamp = (iso: string | null) =>
  iso ? fmtDateTime(new Date(iso)) : "—";

function WebsitesPage() {
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  if (connectUrl) return <LocalSiteWorkspace startUrl={connectUrl} onExit={() => setConnectUrl(null)} />;
  return (
    <div className="p-4 md:p-6">
      <WebsitesHub onConnect={setConnectUrl} />
    </div>
  );
}

function WebsitesHub({ onConnect }: { onConnect: (url: string) => void }) {
  const qc = useQueryClient();
  const [by, setBy] = useOwner();
  const [openLead, setOpenLead] = useState<number | null>(null);
  const [makeOpen, setMakeOpen] = useOpenOnHash("make-site");
  const [queueError, setQueueError] = useState("");
  const overview = useQuery({
    queryKey: ["websites-overview"],
    queryFn: websitesOverview,
    retry: false,
    // Poll quickly only while screenshots are being taken.
    refetchInterval: (q) => {
      const t = q.state.data?.thumbs;
      return t && (t.capturing || t.queued.length) ? 4000 : 60_000;
    },
  });
  const sites = useQuery({ queryKey: ["lead-sites"], queryFn: () => leadSitesStatus(), refetchInterval: 60_000, retry: false });
  const previews = sites.data?.previews ?? [];
  const byLead = new Map(previews.map((p) => [p.leadId, p]));
  const extras = new Map((overview.data?.previews ?? []).map((p) => [p.leadId, p]));
  const data = overview.data;

  // Viewing this page never queues screenshots: that was a write on every visit (audit F3-28). The
  // header says how many are missing or out of date, and the button takes them on request.
  const toTake = data ? screenshotsToTake(data).length : 0;
  const capture = async (opts: { keys?: string[]; force?: boolean } = {}) => {
    setQueueError("");
    try {
      await queueScreenshots(opts);
      await qc.invalidateQueries({ queryKey: ["websites-overview"] });
    } catch (e) {
      setQueueError(screenshotErrorText(e));
    }
  };
  const refreshAll = () => {
    for (const key of ["websites-overview", "lead-sites", "leads-detail", "leads-list"]) qc.invalidateQueries({ queryKey: [key] });
  };

  const clients = data?.sites.filter((s) => s.kind === "client") ?? [];
  const flagships = data?.sites.filter((s) => s.kind === "flagship") ?? [];
  const busyShots = data ? (data.thumbs.capturing ? 1 : 0) + data.thumbs.queued.length : 0;
  const server = data?.previewServer ?? sites.data?.previewServer;

  // L2 (29 Sep, owner: "fill the screen like the Inbox"): one headline, then one full-width widget grid
  // that leads with what the page DOES (open one of our sites, or make a new one), then the client
  // sites, flagships, lead previews, templates and drafts. Status and freshness sit in the page foot.
  const liveCount = previews.filter((p) => p.status === "live").length;
  return (
    <div className="w-full min-w-0">
      <PageHeader
        spacing="tight"
        title="Websites"
        description="Open one of our sites, or make the next one."
        primaryAction={
          <Button asChild variant="accent">
            <a href="#make-site" onClick={() => setMakeOpen(true)}><Sparkles /> Make a site</a>
          </Button>
        }
        actions={
          <>
            <Segmented ariaLabel="Acting as" value={by} onChange={(v) => setBy(v as typeof by)} options={[{ value: "usman", label: "Usman" }, { value: "mehroz", label: "Mehroz" }]} />
            <ConnectLocal onConnect={onConnect} />
            <Button variant="outline" size="sm" onClick={() => void capture(toTake > 0 ? {} : { force: true })} disabled={!data || busyShots > 0}>
              <Camera /> {toTake > 0 ? `Take ${toTake} missing screenshot${toTake === 1 ? "" : "s"}` : "Retake screenshots"}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={refreshAll}><RefreshCw /></Button>
          </>
        }
      />

      {overview.error && <Notice tone="danger" className="mb-6">{(overview.error as Error).message}</Notice>}
      {queueError && <Notice tone="warn" className="mb-6">{queueError}</Notice>}
      {data?.vercel.error && <Notice tone="warn" className="mb-6">{/isn't signed in/.test(data.vercel.error) ? `${data.vercel.error} Deploy times are not shown until it is.` : `Couldn't read deploy times from Vercel: ${data.vercel.error}`}</Notice>}

      {/* R11: the four "create and ask" tiles were a second row of cards above the sites themselves. They are one toolbar now; the sites come first. */}
      <ActionBar data-testid="websites-actions" label="Website actions" className="mb-6">
        <Button size="sm" variant="outline" className="rounded-full" onClick={openJarvisText}><MessageSquareText /> Ask Jarvis</Button>
        <Button asChild size="sm" variant="outline" className="rounded-full"><Link to="/motion" search={{ tab: "kit" } as never}><Film /> Motion kit</Link></Button>
        <Button asChild size="sm" variant="ghost" className="rounded-full"><Link to="/skills"><Wand2 /> Skills ({PRESET_SKILLS.length} on)</Link></Button>
      </ActionBar>

      <WidgetGrid aria-label="Websites" data-websites="grid">


        <GridHeading id="clients" title="Client sites" />
        {!data ? (
          <Skeleton className="col-span-full h-[380px] rounded-2xl" />
        ) : clients.length ? (
          clients.map((s) => (
            <div key={s.id} className="col-span-full min-w-0">
              <ClientCard site={s} vercel={data.vercel} />
            </div>
          ))
        ) : (
          <Widget icon={Globe2} span={4} title="No client sites yet" line="Client sites appear here once their project exists." />
        )}

        <GridHeading id="flagships" title="Flagships and lead previews" />
        {!data
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-[320px] rounded-2xl" />)
          : flagships.map((s) => <FlagshipCard key={s.id} site={s} template={data.templates.find((t) => t.vertical === s.vertical)} />)}
        <Widget
          icon={Rocket}
          title="Lead previews"
          badge={sites.isLoading ? undefined : sites.error ? "Couldn't read" : undefined}
          value={sites.isLoading || sites.error ? null : previews.length}
          line={sites.error ? (sites.error as Error).message : previews.length ? `${liveCount} live; open a lead to deploy, redeploy or take down.` : "Open a lead in Leads and choose Generate website."}
          action={<Button asChild size="sm" variant="outline" className="rounded-full"><a href="/leads">Open Leads</a></Button>}
        />
        {previews.length > 0 && (
          <div id="previews" className="col-span-full flex min-w-0 flex-col gap-4">
            {[...previews]
              .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
              .map((p) => <LeadPreviewCard key={p.leadId} preview={p} extras={extras.get(p.leadId)} onOpen={() => setOpenLead(p.leadId)} onCapture={(keys) => void capture({ keys, force: true })} />)}
          </div>
        )}

        <GridHeading id="local" title="Templates and drafts" />
        {!data ? (
          <Skeleton className="col-span-full h-[280px] rounded-2xl" />
        ) : (
          <>
            <WidgetList icon={Laptop} title="Lead templates" badge={data.templates.length || undefined} empty="No templates built yet.">
              {data.templates.map((t) => <TemplateRow key={t.vertical} template={t} />)}
            </WidgetList>
            <WidgetList icon={Laptop} title="Site drafts" badge={data.drafts.length || undefined} empty="No site drafts yet.">
              {data.drafts.map((d) => <DraftRow key={d.folder} draft={d} onOpenLead={setOpenLead} />)}
            </WidgetList>
          </>
        )}

        <div className="col-span-full min-w-0">
          <Disclosure
            id="make-site-disclosure"
            open={makeOpen}
            onOpenChange={setMakeOpen}
            icon={<Sparkles className="size-4" aria-hidden="true" />}
            summary="Make a site"
            meta="You get a coding draft to check first"
            triggerClassName="text-lg font-semibold"
          >
            <MakeSite sites={data?.sites ?? []} />
          </Disclosure>
        </div>

        <div className="col-span-full min-w-0">
          <Inspiration />
        </div>
      </WidgetGrid>

      <PageFoot>
        {server ? (server.listening ? `Local previews on port ${server.port}` : server.error ?? "Local previews are off") : "Local previews: unknown"}
        {data?.vercel.at ? ` · Vercel checked ${fmtRelative(data.vercel.at)}` : ""}
        {data?.vercel.refreshing ? " · checking Vercel" : ""}
        {busyShots > 0 ? ` · ${busyShots} screenshot${busyShots === 1 ? "" : "s"} to go` : toTake > 0 ? ` · ${toTake} screenshot${toTake === 1 ? "" : "s"} missing or out of date` : ""}
        {" · "}Templates rebuild from the flagships; drafts come from Jarvis's draft-a-website flow. Deploys and take-downs happen only from a lead's drawer, behind a confirm.
      </PageFoot>

      <LeadDrawer
        id={openLead}
        onClose={() => setOpenLead(null)}
        by={by}
        preview={openLead ? byLead.get(openLead) : undefined}
        onChanged={refreshAll}
      />
    </div>
  );
}

/** A full-width row title inside the grid, for a group of widgets. */
function GridHeading({ id, title }: { id: string; title: string }) {
  return (
    <h2 id={id} className="col-span-full mt-6 text-lg font-semibold text-foreground">
      {title}
    </h2>
  );
}

// ── screenshots ──────────────────────────────────────────────────────────

function Shot({ thumb, url, alt, className, bar = true }: { thumb: ThumbState | null | undefined; url: string; alt: string; className?: string; bar?: boolean }) {
  const src = thumbSrc(thumb ?? null);
  return (
    <div className={cn("flex flex-col overflow-hidden bg-inset", className)}>
      {bar && (
        <div className="flex min-h-7 shrink-0 items-center gap-2 border-b border-border px-3 py-1">
          <span className="size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
          <span className="min-w-0 font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{hostOf(url)}</span>
        </div>
      )}
      <div className="relative aspect-[16/10] w-full">
        {src ? (
          <img src={src} alt={alt} loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover object-top" />
        ) : (
          <ShotPending thumb={thumb} />
        )}
      </div>
    </div>
  );
}

function ShotPending({ thumb }: { thumb: ThumbState | null | undefined }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-muted-foreground">
      {thumb?.busy ? (
        <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Taking a screenshot</span>
      ) : thumb?.error ? (
        <span className="max-w-[36ch]">{thumb.error}</span>
      ) : (
        <span>No screenshot yet</span>
      )}
    </div>
  );
}

// ── client sites ─────────────────────────────────────────────────────────

function ClientCard({ site, vercel }: { site: OurSite; vercel: { error: string | null; refreshing: boolean } }) {
  const b = site.brief;
  const pct = b && b.checklist.total ? Math.round((b.checklist.done / b.checklist.total) * 100) : 0;
  return (
    <Surface padding="none" className="grid overflow-hidden lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <a href={site.url} target="_blank" rel="noreferrer" className="block border-b border-border lg:border-b-0 lg:border-r" aria-label={`Open ${site.name}`}>
        <Shot thumb={site.thumb} url={site.url} alt={`${site.name}, live`} />
      </a>
      <div className="flex min-w-0 flex-col gap-5 p-5 sm:p-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold leading-tight tracking-[-0.01em]">{site.name}</h3>
            {b?.status && <Badge tone="accent">{b.status}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{verticalLabel(site.vertical)} client</p>
          <a href={site.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
            {hostOf(site.url)} <ExternalLink className="size-3.5 text-muted-foreground" />
          </a>
          {site.alsoAt.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="ml-3 inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {hostOf(u)} <ExternalLink className="size-3" />
            </a>
          ))}
        </div>

        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border text-sm">
          <Milestone label="Preview due" day={b?.previewDue ?? null} />
          <Milestone label="Launch target" day={b?.launchTarget ?? null} />
          <div className="bg-card p-3">
            <dt className="text-sm text-muted-foreground">Last deployed</dt>
            <dd className="mt-1 font-medium">{site.deployedAt ? fmtDate(site.deployedAt) : "—"}</dd>
            <dd className="text-sm text-muted-foreground">{site.deployedAt ? fmtRelative(site.deployedAt) : vercel.error ? "" : vercel.refreshing ? "Checking Vercel" : "Not in Vercel's list"}</dd>
          </div>
        </dl>

        {b && b.checklist.total > 0 && (
          <div>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">Delivery</span>
              <span className="ds-num text-sm text-muted-foreground">{b.checklist.done} of {b.checklist.total} done</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Delivery checklist">
              <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
            {b.checklist.next && <p className="mt-2 text-sm text-foreground"><span className="text-muted-foreground">Next:</span> {b.checklist.next}</p>}
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="accent"><a href={site.url} target="_blank" rel="noreferrer"><ExternalLink /> Open live site</a></Button>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" title={site.repo.path}>
            <FolderGit2 className="size-3.5 shrink-0" /><span className="min-w-0 font-mono [overflow-wrap:anywhere]">{site.repo.path.split(/[\\/]/).pop()}</span>
            {b?.updated && <span className="shrink-0">· hub updated {fmtDate(b.updated)}</span>}
          </span>
        </div>
      </div>
    </Surface>
  );
}

function Milestone({ label, day }: { label: string; day: string | null }) {
  const n = day ? daysUntil(day) : null;
  return (
    <div className="bg-card p-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{day ? dayLong(day) : "—"}</dd>
      <dd className={cn("text-sm", n !== null && n < 0 ? "text-danger" : n !== null && n <= 2 ? "text-warn" : "text-muted-foreground")}>{n === null ? "Not set" : inDays(n)}</dd>
    </div>
  );
}

// ── flagships ────────────────────────────────────────────────────────────

function FlagshipCard({ site, template }: { site: OurSite; template?: LocalTemplate }) {
  const mismatch = site.linkedProject && site.linkedProject !== site.project;
  return (
    <Surface padding="none" as="article" className="flex flex-col overflow-hidden">
      <a href={site.url} target="_blank" rel="noreferrer" className="block border-b border-border" aria-label={`Open ${site.name}`}>
        <Shot thumb={site.thumb} url={site.url} alt={`${site.name}, live`} />
      </a>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-semibold leading-snug">{site.name}</h3>
            <p className="text-sm text-muted-foreground">{verticalLabel(site.vertical)} flagship</p>
          </div>
          <Badge tone="success">Live</Badge>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Deployed</dt>
          <dd>{site.deployedAt ? `${fmtRelative(site.deployedAt)}` : "—"} <span className="font-mono text-muted-foreground">{site.project}</span></dd>
          <dt className="text-muted-foreground">Last commit</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]" title={site.repo.commit?.subject}>
            {site.repo.commit ? <>{fmtDate(site.repo.commit.at)} · {site.repo.commit.subject}</> : "No git history"}
          </dd>
        </dl>
        {mismatch && <Notice tone="warn">The repo is linked to {site.linkedProject}, not {site.project}.</Notice>}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button asChild size="sm" variant="outline"><a href={site.url} target="_blank" rel="noreferrer"><ExternalLink /> Open live</a></Button>
          {template && (
            <Button asChild size="sm" variant="ghost" title={`Lead template built ${stamp(template.builtAt)}`}>
              <a href={template.localUrl} target="_blank" rel="noreferrer"><Laptop /> Template</a>
            </Button>
          )}
        </div>
      </div>
    </Surface>
  );
}

// ── lead previews: before / after ────────────────────────────────────────

function previewState(p: Preview): { tone: Tone; label: string } {
  if (p.status === "live") return p.expired ? { tone: "danger", label: "Expired — take it down" } : { tone: "success", label: "Live" };
  if (p.status === "deploying") return { tone: "info", label: "Deploying" };
  if (p.status === "failed") return { tone: "danger", label: "Deploy failed" };
  if (p.status === "taken_down") return { tone: "neutral", label: "Taken down" };
  return { tone: "neutral", label: "Generated, not deployed" };
}

function LeadPreviewCard({ preview: p, extras, onOpen, onCapture }: { preview: Preview; extras?: PreviewExtras; onOpen: () => void; onCapture: (keys: string[]) => void }) {
  const state = previewState(p);
  const live = p.status === "live";
  const local = localPreviewHref(p);
  const website = extras?.lead?.website;
  const action = p.status === "taken_down" ? "Regenerate in lead" : live ? "Manage in lead" : p.status === "failed" ? "Retry in lead" : "Review and deploy";
  return (
    <Surface padding="none" as="article" className="grid overflow-hidden lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="border-b border-border lg:border-b-0 lg:border-r">
        <Compare
          before={extras?.realThumb}
          after={extras?.previewThumb}
          business={p.business}
          beforeHost={website ? hostOf(website) : null}
          onCaptureBefore={() => onCapture([`real-${p.leadId}`])}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4 p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold leading-tight">{p.business}</h3>
            <Badge tone={state.tone}>{state.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {verticalLabel(p.vertical)}{extras?.lead?.area ? ` · ${extras.lead.area}` : ""}
          </p>
        </div>

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{live ? "Live at" : "Deploys to"}</dt>
          <dd className="min-w-0 font-mono text-sm leading-5 [overflow-wrap:anywhere]">{p.domain}</dd>
          <dt className="text-muted-foreground">Expiry</dt>
          <dd>
            {live && p.daysLeft !== null ? (
              <span className={cn(p.expired ? "text-danger" : p.daysLeft <= 5 ? "text-warn" : "")}>
                {p.expired ? `Expired ${fmtDate(p.expiresAt)}` : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`}
                <span className="text-muted-foreground"> · {fmtDate(p.expiresAt)}</span>
              </span>
            ) : <span className="text-muted-foreground">Starts at deploy (30 days)</span>}
          </dd>
          <dt className="text-muted-foreground">Generated</dt>
          <dd>{fmtRelative(p.generatedAt)}{p.deployedAt ? <span className="text-muted-foreground"> · deployed {fmtRelative(p.deployedAt)}{p.deployedBy ? ` by ${p.deployedBy}` : ""}</span> : null}</dd>
        </dl>

        {p.missing.length > 0 && p.status !== "taken_down" && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            Placeholders for {p.missing.join(" and ")}. Check every fact in the local preview before it goes live.
          </p>
        )}
        {p.lastError && <Notice tone={live ? "warn" : "danger"}>{p.lastError}</Notice>}

        <div className="mt-auto flex flex-wrap gap-2">
          <Button asChild size="sm" variant={live ? "outline" : "accent"}>
            <a href={local} target="_blank" rel="noreferrer"><Laptop /> Open local preview</a>
          </Button>
          {live && (
            <Button asChild size="sm" variant="accent"><a href={p.url} target="_blank" rel="noreferrer"><ExternalLink /> Open live</a></Button>
          )}
          <Button size="sm" variant="outline" onClick={onOpen}>{action} <ArrowRight /></Button>
          {website && (
            <Button asChild size="sm" variant="ghost"><a href={/^https?:/i.test(website) ? website : `https://${website}`} target="_blank" rel="noreferrer"><Globe2 /> Their site</a></Button>
          )}
        </div>
      </div>
    </Surface>
  );
}

/**
 * Their site and our preview in one frame: the left part shows their current site, the right part
 * ours, split by a divider you drag (or move with the arrow keys — it's a range input underneath).
 */
function Compare({ before, after, business, beforeHost, onCaptureBefore }: {
  before?: ThumbState | null;
  after?: ThumbState | null;
  business: string;
  beforeHost: string | null;
  onCaptureBefore: () => void;
}) {
  const [split, setSplit] = useState(50);
  const beforeSrc = thumbSrc(before ?? null);
  const afterSrc = thumbSrc(after ?? null);
  const both = !!beforeSrc && !!afterSrc;
  return (
    <div className="group/compare relative aspect-[16/10] w-full select-none overflow-hidden bg-inset">
      {afterSrc ? (
        <img src={afterSrc} alt={`Our preview for ${business}`} decoding="async" className="absolute inset-0 size-full object-cover object-top" draggable={false} />
      ) : <ShotPending thumb={after} />}
      {beforeSrc && (
        <img
          src={beforeSrc}
          alt={`${business}'s current website`}
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-cover object-top"
          style={{ clipPath: afterSrc ? `inset(0 ${100 - split}% 0 0)` : undefined }}
        />
      )}
      {both && (
        <>
          <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" style={{ left: `${split}%` }} aria-hidden="true">
            <span className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-black/55 text-white shadow-[0_4px_14px_rgb(0_0_0/0.35)] backdrop-blur-sm transition-transform duration-150 group-focus-within/compare:ring-2 group-focus-within/compare:ring-brand group-hover/compare:scale-105">
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4 2 8l4 4M10 4l4 4-4 4" /></svg>
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label={`Compare ${business}'s current site with our preview`}
            aria-valuetext={`${split}% their site`}
            className="absolute inset-0 size-full cursor-ew-resize opacity-0"
          />
        </>
      )}
      <span className="pointer-events-none absolute left-3 top-3 max-w-[45%] truncate rounded-md bg-black/60 px-2 py-1 text-[13px] font-medium text-white backdrop-blur-sm sm:max-w-[60%]">
        {beforeSrc ? "Their site today" : "Our preview"}
        {beforeSrc && beforeHost && <span className="hidden font-normal text-white/75 sm:inline"> · {beforeHost}</span>}
      </span>
      {both && <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/60 px-2 py-1 text-[13px] font-medium text-white backdrop-blur-sm">Our preview</span>}
      {!beforeSrc && afterSrc && beforeHost && (
        <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/65 px-3 py-2 text-sm text-white backdrop-blur-sm">
          <span>{before?.busy ? "Capturing their site…" : before?.error ? `Their site: ${before.error}` : "No screenshot of their site yet."}</span>
          {!before?.busy && (
            <button onClick={onCaptureBefore} className="inline-flex items-center gap-1.5 rounded-md border border-white/40 px-2 py-1 font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              <Camera className="size-3" /> Capture their site
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── templates and drafts ─────────────────────────────────────────────────

function LocalRow({ thumb, url, alt, title, badges, meta, actions }: { thumb: ThumbState | null; url: string; alt: string; title: string; badges: ReactNode; meta: ReactNode; actions: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0 sm:items-center">
      <a href={url} target="_blank" rel="noreferrer" className="block w-24 shrink-0 overflow-hidden rounded-md border border-border sm:w-36" aria-label={`Open ${title} locally`}>
        <Shot thumb={thumb} url={url} alt={alt} bar={false} />
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{title}</span>
            {badges}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{meta}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">{actions}</div>
      </div>
    </li>
  );
}

function TemplateRow({ template: t }: { template: LocalTemplate }) {
  return (
    <LocalRow
      thumb={t.thumb}
      url={t.localUrl}
      alt={`${verticalLabel(t.vertical)} template`}
      title={`${verticalLabel(t.vertical)} template`}
      badges={t.flagship ? <Badge tone="neutral">from {t.flagship}</Badge> : null}
      meta={<>Built {stamp(t.builtAt)}{t.kind === "next-export" ? " · Next export" : ""}</>}
      actions={<Button asChild size="xs" variant="outline"><a href={t.localUrl} target="_blank" rel="noreferrer"><Laptop /> Local preview</a></Button>}
    />
  );
}

function DraftRow({ draft: d, onOpenLead }: { draft: LocalDraft; onOpenLead: (id: number) => void }) {
  return (
    <LocalRow
      thumb={d.thumb}
      url={d.localUrl}
      alt={`Draft for ${d.name}`}
      title={d.name}
      badges={
        <>
          <Badge tone="neutral">{verticalLabel(d.vertical)}</Badge>
          {d.qaPass !== null && <Badge tone={d.qaPass ? "success" : "warn"}>{d.qaPass ? "QA passed" : "QA issues"}</Badge>}
        </>
      }
      meta={<>Built {stamp(d.builtAt)}{d.direction ? ` · ${d.direction}` : ""}</>}
      actions={
        <>
          <Button asChild size="xs" variant="outline"><a href={d.localUrl} target="_blank" rel="noreferrer"><Laptop /> Local preview</a></Button>
          {d.leadId !== null && <Button size="xs" variant="ghost" onClick={() => onOpenLead(d.leadId!)}>Open lead</Button>}
        </>
      }
    />
  );
}

// ── secondary: connect a local site, inspiration ─────────────────────────

function ConnectLocal({ onConnect }: { onConnect: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<{ url: string; title: string }[]>([]);
  useEffect(() => { if (open) setRecent(readHistory()); }, [open]);
  const go = (url: string) => {
    const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    if (!validLocal(withScheme)) return setError("Use a local address, like http://localhost:3000.");
    setOpen(false);
    onConnect(withScheme);
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setError(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"><Laptop /> Connect a local site</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form onSubmit={(e) => { e.preventDefault(); go(value.trim()); }}>
          <label htmlFor="connect-local" className="text-sm font-medium">Connect a site running on this PC</label>
          <p className="mt-1 text-sm text-muted-foreground">Preview it at desktop, tablet and mobile sizes, and hand source editing to an agent.</p>
          <div className="mt-3 flex gap-2">
            <input
              id="connect-local"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(""); }}
              placeholder="http://localhost:3000"
              spellCheck={false}
              autoComplete="off"
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" size="sm" variant="accent" disabled={!value.trim()}>Open</Button>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </form>
        {recent.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
            {recent.slice(0, 4).map((s) => (
              <li key={s.url}>
                <button onClick={() => go(s.url)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s.title}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">{hostOf(s.url)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Inspiration() {
  const [open, setOpen] = useState(false);
  return (
    <details className="group rounded-2xl border border-border bg-card" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="text-sm font-medium">Inspiration</span>
          <span className="ml-2 text-sm text-muted-foreground">Other studios' sites in motion, for when a design needs a reference</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      {open && (
        <div className="op-websites border-t border-border">
          <Suspense fallback={<Skeleton className="m-4 h-48 rounded-lg" />}>
            <ReferoPreviews />
          </Suspense>
        </div>
      )}
    </details>
  );
}

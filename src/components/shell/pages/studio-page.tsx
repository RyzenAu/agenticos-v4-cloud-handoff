// Studio: proposals, decks, videos, scripts and assets. Counts come from the local media ledger
// (/__design_ledger) and the generation queue (/__design_jobs); no prompt text or file paths are
// shown here. Making things happens in the drilldowns.
//
// L2 (29 Sep, owner: "fill the screen like the Inbox"): one headline, then a full-width widget grid
// that leads with what Studio DOES (make something: Design, Motion, the M&U kit, transitions), then
// the ledger counts as widgets. Sources and freshness sit in the one PageFoot line.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowUpRight, Bot, TriangleAlert } from "lucide-react";
import { ActionBar, Button, DataList, DataRow, DetailDrawer, Details, EmptyState, Notice, PageFoot, PageHeader, StatusLabel, Widget, WidgetGrid } from "@/components/ds";
import { useNow } from "@/components/workspace/panel-shell";
import { HONEST_LABEL, honestFromQuery, type HonestState } from "@/lib/honest-state";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { DrilldownList } from "../page-parts";

/** An "Open …" link styled as a button: the one action on a Studio widget. */
export function OpenLink({ to, search, children, primary = false }: { to: string; search?: Record<string, string>; children: ReactNode; primary?: boolean }) {
  return (
    <Button asChild variant={primary ? "accent" : "outline"} className="h-10 rounded-full px-4">
      <Link to={to as never} search={search as never}>
        {children}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </Button>
  );
}

/** The honest word for a widget badge; "Live" is the quiet default and isn't shown. */
function stateWord(state: HonestState | undefined): string | undefined {
  return state && state !== "live" ? HONEST_LABEL[state] : undefined;
}

export type LedgerSummary = {
  /** Assets whose file still exists (the ledger's `alive`); deleted files are never counted (STU-1). */
  total: number;
  /** Ledger entries whose file was deleted since capture. */
  missing: number;
  byAgent: Record<string, number>;
  newest: number | null;
  /** Whether agent media capture is installed; null when the ledger didn't say. */
  armed: boolean | null;
  /** The newest assets that still exist, for the list on the page. */
  recent: { id: string | null; name: string; agent: string; ts: number; kind: string; w: number | null; h: number | null; bytes: number | null; model: string | null }[];
};

/** Counts from the ledger's items (each re-stat'd by the server), not its raw `total`, which includes deleted files. */
export function summariseLedger(body: { items?: unknown; armed?: unknown }): LedgerSummary {
  const items: { ts?: unknown; alive?: unknown; agent?: unknown }[] = Array.isArray(body.items) ? body.items : [];
  const alive = items.filter((i) => i && i.alive !== false);
  const byAgent: Record<string, number> = {};
  for (const i of alive) if (typeof i.agent === "string") byAgent[i.agent] = (byAgent[i.agent] ?? 0) + 1;
  const newest = alive.reduce<number | null>((max, i) => (typeof i.ts === "number" && (max === null || i.ts > max) ? i.ts : max), null);
  const recent = (alive as { id?: unknown; path?: unknown; ts?: unknown; agent?: unknown; kind?: unknown; name?: unknown; w?: unknown; h?: unknown; bytes?: unknown; model?: unknown }[])
    .filter((i) => typeof i.ts === "number")
    .sort((a, b) => (b.ts as number) - (a.ts as number))
    .slice(0, 8)
    .map((i) => ({
      id: typeof i.id === "string" ? i.id : null,
      w: typeof i.w === "number" ? i.w : null,
      h: typeof i.h === "number" ? i.h : null,
      bytes: typeof i.bytes === "number" ? i.bytes : null,
      model: typeof i.model === "string" ? i.model : null,
      name: typeof i.name === "string" ? i.name : typeof i.path === "string" ? i.path.split(/[\/]/).pop() ?? "asset" : "asset",
      agent: typeof i.agent === "string" ? i.agent : "",
      ts: i.ts as number,
      kind: typeof i.kind === "string" ? i.kind : "image",
    }));
  return { total: alive.length, missing: items.length - alive.length, byAgent, newest, armed: typeof body.armed === "boolean" ? body.armed : null, recent };
}

async function readLedger(): Promise<LedgerSummary> {
  const res = await fetch("/__design_ledger", { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(typeof body?.error === "string" ? body.error : `Media ledger unavailable (HTTP ${res.status})`);
  return summariseLedger(body);
}

async function readJobs(): Promise<number> {
  const res = await fetch("/__design_jobs", { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error("Generation queue unavailable");
  return Array.isArray(body.jobs) ? body.jobs.length : 0;
}

const AGENT_LABEL: Record<string, string> = { studio: "Studio", claude: "Claude", hermes: "Hermes", codex: "Codex" };

export function StudioPage() {
  const now = useNow(60_000);
  const ledger = useQuery({ queryKey: ["studio", "ledger"], queryFn: readLedger, staleTime: 60_000, retry: false });
  const jobs = useQuery({ queryKey: ["studio", "jobs"], queryFn: readJobs, staleTime: 15_000, refetchInterval: 30_000, retry: false });
  // No item recorded at all can't be told apart from no ledger file: Unknown, not "Live 0" (REVIEW-T1 B1).
  const ledgerEmpty = !!ledger.data && ledger.data.total === 0 && ledger.data.newest === null;
  const ledgerState = ledgerEmpty ? ("unknown" as const) : honestFromQuery(ledger, now, { staleAfterMs: Infinity });
  const jobsState = honestFromQuery(jobs, now);
  // R12 rollout: an asset opens in the shared drawer (a preview and its facts); the open asset is in the URL (?asset=<id>).
  const navigate = useNavigate();
  const assetParam = (useSearch({ strict: false }) as { asset?: unknown }).asset;
  const openAsset = (id: string | null) => void navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, asset: id ?? undefined }) } as never);
  const asset = typeof assetParam === "string" ? ledger.data?.recent.find((a) => a.id === assetParam) : undefined;
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader
        spacing="tight"
        title="Studio"
        primaryAction={
          <Button asChild variant="accent">
            <Link to="/design">
              Make an image or video
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <ActionBar label="Studio actions" className="mb-6 gap-3">
        <OpenLink to="/leads">Draft a client proposal</OpenLink>
        <OpenLink to="/motion" search={{ tab: "kit" }}>M&U kit</OpenLink>
        <Button asChild variant="outline" className="h-10 rounded-full px-4" title="Two films; they need an owner watch-through before any external use">
          <a href="/mu-creative-20261001/index.html" target="_blank" rel="noreferrer">
            Promotional films
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      </ActionBar>
      {/* R11: the assets are the page. A list of the newest, a one-line queue note, and an empty state with its action. */}
      <section aria-label="Assets" data-studio="make">
        {(jobs.data ?? 0) > 0 && (
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <StatusLabel state="running" label={`${jobs.data} generating now`} size="sm" />
            <Link to={"/design" as never} className="underline underline-offset-4">Follow them in Design</Link>
          </p>
        )}
        {jobs.error && <Notice tone="warn" className="mb-3">The generation queue couldn't be read, so what is generating is unknown.</Notice>}
        {ledger.error ? (
          <Notice tone="warn" title="Couldn't read the media ledger" action={<Button variant="outline" size="sm" onClick={() => void ledger.refetch()}>Retry</Button>}>
            Assets are unknown, not zero.
          </Notice>
        ) : ledger.data && ledger.data.recent.length > 0 ? (
          <>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Recent assets</h2>
              <span className="text-sm text-muted-foreground">{ledger.data.total} in the ledger · newest <LedgerHint summary={ledger.data} now={now} /></span>
            </div>
            <DataList label="Recent assets">
              {ledger.data.recent.map((a) => (
                <DataRow
                  key={`${a.name}-${a.ts}`}
                  title={a.name}
                  meta={`${a.kind === "video" ? "Video" : "Image"} · ${a.agent ? `made by ${AGENT_LABEL[a.agent] ?? a.agent}` : "maker not recorded"} · ${fmtAgo(a.ts, now)}`}
                  selected={!!a.id && a.id === assetParam}
                  {...(a.id ? { onClick: () => openAsset(a.id) } : { href: "/design" })}
                />
              ))}
            </DataList>
            <p className="mt-3 text-sm"><Link to={"/design" as never} className="underline underline-offset-4">Open the full ledger in Design</Link></p>
          </>
        ) : ledger.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">Reading the media ledger…</p>
        ) : (
          <EmptyState
            variant="row"
            title="Nothing recorded in the media ledger yet"
            action={<OpenLink to="/design" primary>Make an image or video</OpenLink>}
          />
        )}
      </section>
      {ledger.data && (ledger.data.armed === false || Object.values(ledger.data.byAgent).some((n) => n > 0)) && (
        <details className="mt-6 border-t border-border py-2">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
            Who made the assets
          </summary>
          <WidgetGrid>
            <AgentTiles summary={ledger.data} state={ledgerState} now={now} />
          </WidgetGrid>
        </details>
      )}
      <DetailDrawer
        open={!!asset}
        onOpenChange={(o) => !o && openAsset(null)}
        title={asset?.name ?? ""}
        description={asset ? `${asset.kind === "video" ? "Video" : "Image"} · ${asset.agent ? `made by ${AGENT_LABEL[asset.agent] ?? asset.agent}` : "maker not recorded"} · ${fmtAgo(asset.ts, now)}` : undefined}
        actions={
          <Button asChild variant="accent">
            <Link to={"/design" as never}>Open in Design</Link>
          </Button>
        }
      >
        {asset?.id && (
          <div data-asset-drawer={asset.id}>
            {asset.kind === "video" ? (
              <video src={`/__design_file?id=${encodeURIComponent(asset.id)}`} controls className="w-full rounded-xl border border-border bg-inset" />
            ) : (
              <img src={`/__design_file?id=${encodeURIComponent(asset.id)}`} alt={asset.name} className="w-full rounded-xl border border-border bg-inset object-contain" />
            )}
            <div className="mt-4">
              <Details
                items={[
                  ...(asset.w && asset.h ? [{ label: "Size", value: `${asset.w} × ${asset.h}` }] : []),
                  ...(asset.bytes ? [{ label: "File", value: `${Math.max(1, Math.round(asset.bytes / 1024))} KB` }] : []),
                  ...(asset.model ? [{ label: "Model", value: asset.model, mono: true }] : []),
                  { label: "Made", value: fmtDateTime(asset.ts) },
                ]}
              />
            </div>
          </div>
        )}
      </DetailDrawer>
      <div className="mt-10">
        <DrilldownList id="studio" />
      </div>
      <PageFoot>
        Counts from the design media ledger and the generation queue; no prompt text or file paths are shown here.
        {ledger.data && (
          <>
            {" "}Newest asset: <LedgerHint summary={ledger.data} now={now} />.
          </>
        )}
      </PageFoot>
    </div>
  );
}

function LedgerHint({ summary, now }: { summary: LedgerSummary; now: number }) {
  const fresh = summary.newest ? (
    <span title={fmtDateTime(summary.newest)}>{fmtAgo(summary.newest, now)}</span>
  ) : (
    "No dated items"
  );
  if (!summary.missing) return <>{fresh}</>;
  return (
    <>
      {fresh} · {summary.missing} deleted since capture, not counted
    </>
  );
}

/**
 * "Made by …" tiles for agents with existing assets. Without agent capture a zero means "not
 * recorded", not "made nothing", so that is said instead of showing zeros (STU-1).
 */
export function AgentTiles({ summary, state = "live" }: { summary: LedgerSummary; state?: HonestState; now?: number }) {
  const agents = Object.entries(summary.byAgent)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <>
      {agents.map(([agent, count]) => (
        <Widget key={agent} icon={Bot} title={`Made by ${AGENT_LABEL[agent] ?? agent}`} badge={stateWord(state)} value={count} line="Images, video and documents" />
      ))}
      {summary.armed === false && (
        <Widget
          icon={TriangleAlert}
          title="Agent media capture"
          value="Not set up"
          tone="warn"
          line="Media Claude Code and Hermes make isn't recorded or counted yet. Ask Jarvis to set this up."
        />
      )}
    </>
  );
}

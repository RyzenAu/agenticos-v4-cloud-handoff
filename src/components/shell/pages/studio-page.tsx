// Studio: proposals, decks, videos, scripts and assets. Counts come from the local media ledger
// (/__design_ledger) and the generation queue (/__design_jobs); no prompt text or file paths are
// shown here. Making things happens in the drilldowns.
//
// L2 (29 Sep, owner: "fill the screen like the Inbox"): one headline, then a full-width widget grid
// that leads with what Studio DOES (make something: Design, Motion, the M&U kit, transitions), then
// the ledger counts as widgets. Sources and freshness sit in the one PageFoot line.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Boxes, ImagePlus, TriangleAlert } from "lucide-react";
import { Button, PageFoot, PageHeader, Widget, WidgetGrid } from "@/components/ds";
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
};

/** Counts from the ledger's items (each re-stat'd by the server), not its raw `total`, which includes deleted files. */
export function summariseLedger(body: { items?: unknown; armed?: unknown }): LedgerSummary {
  const items: { ts?: unknown; alive?: unknown; agent?: unknown }[] = Array.isArray(body.items) ? body.items : [];
  const alive = items.filter((i) => i && i.alive !== false);
  const byAgent: Record<string, number> = {};
  for (const i of alive) if (typeof i.agent === "string") byAgent[i.agent] = (byAgent[i.agent] ?? 0) + 1;
  const newest = alive.reduce<number | null>((max, i) => (typeof i.ts === "number" && (max === null || i.ts > max) ? i.ts : max), null);
  return { total: alive.length, missing: items.length - alive.length, byAgent, newest, armed: typeof body.armed === "boolean" ? body.armed : null };
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
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Studio" />
      <nav aria-label="Studio actions" className="mb-6 flex flex-wrap gap-3">
        <OpenLink to="/design" primary>
          Make an image or video
        </OpenLink>
        <OpenLink to="/leads">Draft a client proposal</OpenLink>
      </nav>
      <p className="mb-6 text-sm text-muted-foreground">
        <a href="/mu-creative-20261001/index.html" target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-4">Promotional films</a>
        {" "}Two films; they need an owner watch-through before any external use.
      </p>
      <WidgetGrid aria-label="Make something" data-studio="make">
        <Widget
          icon={ImagePlus}
          title="Image or video"
          badge={jobs.isLoading ? undefined : stateWord(jobsState)}
          value={jobs.isLoading ? null : jobs.error ? "Couldn't read" : (jobs.data ?? null)}
          tone={jobs.error ? "danger" : "default"}
          line={jobs.data ? "generating now; open Design to follow them" : jobs.error ? "Generation queue unavailable" : jobs.isLoading ? "Reading the queue…" : "generating now; the queue is empty"}
        />
        <Widget
          icon={Boxes}
          title="Assets"
          badge={ledger.isLoading ? undefined : stateWord(ledgerState)}
          value={ledger.isLoading ? null : ledger.error ? "Couldn't read" : ledger.data && !ledgerEmpty ? ledger.data.total : null}
          tone={ledger.error ? "danger" : "default"}
          line={
            ledger.data
              ? ledgerEmpty && !ledger.data.missing ? "Nothing recorded in the media ledger yet" : "in the media ledger: images, video and documents that still exist"
              : ledger.error ? "Ledger unavailable" : "Reading the ledger…"
          }
          action={<OpenLink to="/design">Open the ledger</OpenLink>}
        />
      </WidgetGrid>
      <details className="mt-6 border-t border-border py-2">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
          Brand kit & asset records
        </summary>
        <div className="my-3 flex flex-wrap gap-3">
          <OpenLink to="/motion" search={{ tab: "kit" }}>
            M&U kit
          </OpenLink>
          <OpenLink to="/transitions">Transition lab</OpenLink>
        </div>
        {ledger.data && (
          <WidgetGrid>
            <AgentTiles summary={ledger.data} state={ledgerState} now={now} />
          </WidgetGrid>
        )}
      </details>
      <div className="mt-10">
        <DrilldownList id="studio" />
      </div>
      <PageFoot>
        Counts from the design media ledger (/__design_ledger) and the generation queue (/__design_jobs); no prompt text or file paths are shown here.
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

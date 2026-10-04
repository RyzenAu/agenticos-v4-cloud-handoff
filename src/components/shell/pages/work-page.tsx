// Work: the owner's approvals, the call queue, the pipeline and the sites.
// L1 layout pass (29 Sep 2026, owner: "see how the widgets … fill out the screen"): one headline
// sentence, then a full-width widget grid that leads with the decisions waiting, then the four
// panels two-up, then the drilldowns. Same panel reads as before (no extra requests); nothing true
// is removed: the W-B answer card's facts are the four widgets, its footer is the page foot.
// Leads, Websites, the business brief, goals, projects and coding are drilldowns.
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button, PageFoot, PageHeader, Skeleton, WidgetGrid } from "@/components/ds";
import { useWorkspacePanel } from "@/components/workspace/api";
import { CallQueuePanel, PipelinePanel, WebsitesPanel } from "@/components/workspace/other-panels";
import { useNow } from "@/components/workspace/panel-shell";
import { TodayPanel } from "@/components/workspace/today-panel";
import { workSummary, type WorkSummary } from "@/lib/work-summary";
import { plural } from "@/lib/plural";
import { DrilldownList } from "../page-parts";

function useWorkSummary(): WorkSummary & { calls: number | null; open: number | null; sites: { down: number; total: number } | null; errors: number } {
  const today = useWorkspacePanel("today");
  const calls = useWorkspacePanel("callQueue");
  const pipeline = useWorkspacePanel("pipeline");
  const sites = useWorkspacePanel("websites");
  const v = workSummary({ today: today.data as never, calls: calls.data, pipeline: pipeline.data, sites: sites.data, loading: today.isLoading });
  const s = sites.data?.ok ? sites.data.data.sites : null;
  return {
    ...v,
    calls: calls.data?.ok ? calls.data.data.total : null,
    open: pipeline.data?.ok ? (pipeline.data.data.open ?? null) : null,
    sites: s ? { down: s.filter((x) => x.tone === "bad").length, total: s.length } : null,
    errors: today.data?.ok
      ? ((today.data.data as { approvalsErrors?: string[] }).approvalsErrors?.length ?? 0)
      : 0,
  };
}

/** The tile already shows the count, so "6 open leads" under "Open leads 6" says nothing: keep only what it adds (proposals out) or the "not read" note. */
export function openLeadsDetail(fact: string | undefined, open: number | null): string | undefined {
  if (!fact || open === null) return fact;
  const rest = fact.replace(/^\d+ open leads?\s*(?:·\s*)?/, "").trim();
  return rest || undefined;
}

const go = (label: ReactNode, to: string, accent = false) => (
  <Button variant={accent ? "accent" : "outline"} className="h-auto min-h-10 max-w-full whitespace-normal rounded-full px-5 py-2 text-center" asChild>
    <Link to={to as never}>
      {label}
      {accent && <ArrowRight aria-hidden="true" />}
    </Link>
  </Button>
);

/** The five-second answer as four widgets: decisions (first), calls, pipeline, sites. */
export function WorkAnswer({ v }: { v: ReturnType<typeof useWorkSummary> }) {
  return (
    <section
      className="mb-6 border-b border-border pb-6"
      aria-label="What waits on you"
      data-work-answer={v.tone}
    >
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          {
            label: "Decisions",
            to: "#ws-today",
            search: undefined as { view: "today" } | undefined,
            value: v.approvals,
            detail:
              v.approvals === null
                ? v.title
                : v.errors
                  ? `${plural(v.errors, "approval")} couldn't be read`
                  : undefined,
          },
          { label: "Calls to make", to: "/leads", search: { view: "today" }, value: v.calls, detail: v.facts[0] },
          { label: "Open leads", to: "/leads", search: undefined, value: v.open, detail: openLeadsDetail(v.facts[1], v.open) },
          { label: "Sites down", to: "/websites", search: undefined, value: v.sites?.down ?? null, detail: v.facts[2] },
        ].map((item) => (
          <div key={item.label}>
            <dt className="text-sm text-muted-foreground">
              {/* Every count opens the items it counts: the decisions list below, or the page that holds the rest. */}
              {item.to.startsWith("#") ? (
                <a href={item.to} className="underline-offset-4 hover:text-foreground hover:underline">{item.label}</a>
              ) : (
                <Link to={item.to as never} search={item.search as never} className="underline-offset-4 hover:text-foreground hover:underline">{item.label}</Link>
              )}
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{item.value ?? "—"}</dd>
            {item.detail && <p className="mt-1 text-[13px] text-muted-foreground">{item.detail}</p>}
          </div>
        ))}
      </dl>
      {(v.next === "calls" || v.next === "pipeline") && (
        <div className="mt-5 flex flex-wrap gap-3">{go("Calls & leads", "/leads", true)}</div>
      )}
    </section>
  );
}

/** A panel in the grid: spans two columns and stretches to its row's height. */
const Cell = ({ children }: { children: ReactNode }) => (
  <div className="col-span-full min-w-0 md:col-span-2 [&>*]:h-full">{children}</div>
);

export function WorkPage() {
  const now = useNow(30_000);
  const v = useWorkSummary();
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Work" description={v.approvals === null ? "What waits on you, the calls to make, the pipeline and the sites." : `${v.title}.`} />
      {now > 0 ? (
        <div className="mb-12 sh-arrive">
          <WorkAnswer v={v} />
          <WidgetGrid>
            <div className="col-span-full min-w-0">
              <TodayPanel now={now} />
            </div>
          </WidgetGrid>
          <details className="mt-6 border-t border-border py-2">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
              Calls, pipeline & site status
            </summary>
            <WidgetGrid className="mt-3">
              <Cell>
                <CallQueuePanel now={now} />
              </Cell>
              <Cell>
                <PipelinePanel now={now} />
              </Cell>
              <Cell>
                <WebsitesPanel now={now} />
              </Cell>
            </WidgetGrid>
          </details>
        </div>
      ) : (
        <div className="mb-12 space-y-6" role="status" aria-busy="true" aria-label="Loading work">
          <WidgetGrid>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-2xl" />
            ))}
          </WidgetGrid>
          <WidgetGrid>
            <Skeleton className="col-span-full h-64 rounded-2xl md:col-span-2" />
            <Skeleton className="col-span-full h-64 rounded-2xl md:col-span-2" />
          </WidgetGrid>
        </div>
      )}
      <DrilldownList id="work" />
      <PageFoot title="From the same reads as the cards: approvals, call queue, CRM pipeline and site checks.">Nothing here sends, merges or deploys on its own</PageFoot>
    </div>
  );
}

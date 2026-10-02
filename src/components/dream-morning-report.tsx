import { useState } from "react";
import { Badge, Button, Notice } from "@/components/ds";
import { fmtDateTime } from "@/lib/format";

// The overnight Dream's morning report + proposed improvements (scripts/run-dream.ts, claude
// engine), and the honest status of the last run from ~/.claude-os/dreams/last-run.json. A failed
// or skipped night is shown as failed/skipped, never as a quiet success.

type TopAction = { title: string; why?: string; command?: string };
type Proposal = {
  id: string;
  kind: "code" | "process";
  title: string;
  why: string;
  brief: string;
  acceptance?: string[];
  effort?: string;
  risk?: string;
};
type LastRun = {
  status?: "running" | "ok" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  engine?: string;
  model?: string;
  error?: string;
  reason?: string;
  claudeCalls?: number;
  tokens?: number;
  weeklyPercent?: number | null;
  checks?: { tests?: { ok?: boolean; summary?: string }; tsc?: { ok?: boolean; summary?: string }; skipped?: string };
  chores?: any;
};
export type DreamData = {
  date?: string;
  healthStatus?: string;
  fixHint?: string;
  report?: {
    summaryLine?: string;
    improved?: string[];
    broke?: string[];
    topActions?: TopAction[];
    salesCoaching?: string;
    clientDeadlines?: { client: string; item: string; due?: string }[];
  };
  proposals?: Proposal[];
  lastRun?: LastRun | null;
};

const time = (iso?: string) =>
  iso
    ? fmtDateTime(new Date(iso), { weekday: true, timeZone: "Australia/Sydney" })
    : "";

export function DreamRunStatus({ dream }: { dream: DreamData | null | undefined }) {
  const run = dream?.lastRun;
  const status = dream?.healthStatus;
  const banner =
    status === "failed" ? (
      <Notice tone="danger" title="Last night's Dream failed">
        {dream?.fixHint ?? "Check ~/.claude-os/dream-cron.log."} The cards below are from the previous successful run.
      </Notice>
    ) : status === "skipped" ? (
      <Notice tone="warn" title="Last night's Dream was skipped">
        {dream?.fixHint}
      </Notice>
    ) : status === "running" ? (
      <Notice tone="info" title="Dream is running">
        {dream?.fixHint}
      </Notice>
    ) : status === "stale" ? (
      <Notice tone="warn" title="No new Dream last night">
        {dream?.fixHint}
      </Notice>
    ) : null;
  if (!run && !banner) return null;
  const facts: string[] = [];
  if (run?.finishedAt) facts.push(`${run.status === "ok" ? "Finished" : "Ended"} ${time(run.finishedAt)}`);
  if (run?.model) facts.push(run.model);
  if (typeof run?.claudeCalls === "number") facts.push(`${run.claudeCalls} Claude call${run.claudeCalls === 1 ? "" : "s"}`);
  if (typeof run?.tokens === "number") facts.push(`${Math.round(run.tokens / 1000)}k tokens`);
  if (typeof run?.weeklyPercent === "number") facts.push(`Claude weekly ${run.weeklyPercent}%`);
  if (run?.checks?.tests?.summary) facts.push(`tests ${run.checks.tests.summary}`);
  if (run?.checks?.tsc?.summary) facts.push(`tsc ${run.checks.tsc.summary}`);
  const tone = run?.status === "ok" ? "success" : run?.status === "failed" ? "danger" : run?.status === "running" ? "info" : "warn";
  return (
    <div className="mb-4 space-y-3" data-testid="dream-run-status">
      {banner}
      {run && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={tone}>{run.status === "ok" ? "Last run OK" : `Last run ${run.status}`}</Badge>
          <span>{facts.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}

function List({ items, empty }: { items?: string[]; empty: string }) {
  if (!items?.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm text-foreground">
      {items.map((i, n) => (
        <li key={n} className="leading-snug">
          {i}
        </li>
      ))}
    </ul>
  );
}

function ProposalRow({ p }: { p: Proposal }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = [`# ${p.title}`, "", p.why, "", p.brief, ...(p.acceptance?.length ? ["", "Done when:", ...p.acceptance.map((a) => `- ${a}`)] : [])].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <details className="group rounded-xl border border-border bg-inset px-4 py-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{p.title}</span>
        <Badge tone={p.kind === "code" ? "info" : "accent"}>{p.kind}</Badge>
        {p.effort && <Badge>effort {p.effort}</Badge>}
        {p.risk && <Badge tone={p.risk === "high" ? "danger" : p.risk === "medium" ? "warn" : "neutral"}>risk {p.risk}</Badge>}
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-muted-foreground">{p.why}</p>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-foreground">
          {p.brief}
        </pre>
        {p.acceptance?.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {p.acceptance.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        ) : null}
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy brief"}
        </Button>
      </div>
    </details>
  );
}

export function DreamMorningReport({ dream }: { dream: DreamData | null | undefined }) {
  const r = dream?.report;
  const proposals = dream?.proposals ?? [];
  if (!r && !proposals.length) return null;
  return (
    <div className="mt-8 space-y-6" data-testid="dream-morning-report">
      {r && (
        <div>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-foreground">Morning report{dream?.date ? ` · ${dream.date}` : ""}</h3>
          </div>
          {r.summaryLine && <p className="mb-4 text-sm text-foreground">{r.summaryLine}</p>}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-border bg-inset p-4 lg:col-span-2">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Three highest-leverage actions today</div>
              {r.topActions?.length ? (
                <ol className="space-y-3 text-sm">
                  {r.topActions.map((a, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="ds-num w-4 shrink-0 font-semibold text-foreground">{i + 1}</span>
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{a.title}</div>
                        {a.why && <div className="text-muted-foreground">{a.why}</div>}
                        {a.command && <code className="mt-1 block break-all text-xs text-muted-foreground">{a.command}</code>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No actions tonight.</p>
              )}
            </div>
            <div className="rounded-xl border border-border bg-inset p-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Client deadlines</div>
              {r.clientDeadlines?.length ? (
                <ul className="space-y-2 text-sm">
                  {r.clientDeadlines.map((c, i) => (
                    <li key={i}>
                      <span className="font-medium text-foreground">{c.client}</span>
                      <span className="text-muted-foreground"> · {c.item}</span>
                      {c.due && <span className="ds-num text-foreground"> · {c.due}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None found.</p>
              )}
            </div>
            <div className="rounded-xl border border-border bg-inset p-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">What improved</div>
              <List items={r.improved} empty="Nothing measurable." />
            </div>
            <div className="rounded-xl border border-border bg-inset p-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">What broke</div>
              <List items={r.broke} empty="Nothing broke." />
            </div>
            <div className="rounded-xl border border-border bg-inset p-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Sales coaching</div>
              <p className="text-sm text-foreground">{r.salesCoaching || "No scored calls in the window."}</p>
            </div>
          </div>
        </div>
      )}
      {proposals.length > 0 && (
        <div>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-foreground">Proposed improvements</h3>
            <span className="text-xs text-muted-foreground">Briefs only. Nothing was changed, deployed or sent.</span>
          </div>
          <div className="space-y-2">
            {proposals.map((p) => (
              <ProposalRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

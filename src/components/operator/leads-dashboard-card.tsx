// Compact Leads card for Mission Control: the top five to call today and the pipeline counts.
// Reads /__operator/leads/{calls,summary}; phone numbers are tel: links or copied, never dialled.
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, Phone } from "lucide-react";
import { Badge, EmptyState, Skeleton, StatusDot, Surface } from "@/components/ds";
import { leadsApi, leadSitesStatus, pitchInfo, suburbOf, taggedReasons, useCopy, VERTICAL_LABEL, type Vertical } from "@/lib/leads";
import { CopyButton, ReasonChip } from "./lead-bits";

const STAGES: { key: string[]; label: string }[] = [
  { key: ["new", "to_call"], label: "New" },
  { key: ["no_answer", "voicemail", "call_back", "emailed"], label: "Contacted" },
  { key: ["interested", "meeting", "proposal"], label: "Warm" },
  { key: ["won"], label: "Won" },
];

export function LeadsDashboardCard() {
  const calls = useQuery({ queryKey: ["leads-calls", 5], queryFn: () => leadsApi.calls(5), refetchInterval: 60_000 });
  const summary = useQuery({ queryKey: ["leads-summary"], queryFn: leadsApi.summary, refetchInterval: 60_000 });
  const sites = useQuery({ queryKey: ["lead-sites"], queryFn: () => leadSitesStatus(), refetchInterval: 120_000, retry: false });
  const [copied, copy] = useCopy();
  const pipeline = summary.data?.pipeline ?? {};
  const live = (sites.data?.previews ?? []).filter((p) => p.status === "live");
  const expired = live.filter((p) => p.expired).length;

  return (
    <section className="mb-12" aria-labelledby="leads-card-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="leads-card-title" className="text-lg font-semibold leading-snug tracking-[-0.01em]">Leads to call today</h2>
          {summary.data && (
            <StatusDot className="mt-1" tone={summary.data.callWindow.open ? "success" : "warn"} label={summary.data.callWindow.open ? "Calling hours open" : `Calling hours closed · ${summary.data.callWindow.why}`} />
          )}
        </div>
        <Link to="/leads" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">Open leads <ArrowUpRight className="size-3.5" /></Link>
      </div>
      <Surface padding="none">
        <div className="grid grid-cols-2 border-b border-border sm:grid-cols-5">
          {STAGES.map((s) => (
            <div key={s.label} className="border-r border-border px-4 py-3 last:border-r-0 sm:[&:nth-child(4)]:border-r">
              <div className="ds-label text-muted-foreground">{s.label}</div>
              <div className="ds-num mt-0.5 text-xl font-semibold">{summary.data ? s.key.reduce((a, k) => a + (pipeline[k] ?? 0), 0) : "—"}</div>
            </div>
          ))}
          <div className="col-span-2 border-t border-border px-4 py-3 sm:col-span-1 sm:border-t-0">
            <div className="ds-label text-muted-foreground">Previews live</div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="ds-num text-xl font-semibold">{sites.data ? live.length : "—"}</span>
              {expired > 0 && <Badge tone="danger">{expired} expired</Badge>}
            </div>
          </div>
        </div>
        {calls.isLoading ? (
          <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
        ) : calls.error ? (
          <p className="p-4 text-sm text-muted-foreground">Couldn't read the call list: {(calls.error as Error).message}</p>
        ) : !calls.data?.leads.length ? (
          <div className="p-4"><EmptyState variant="row" title="Nobody's due for a call right now" /></div>
        ) : (
          <ol className="divide-y divide-border">
            {calls.data.leads.map((lead, i) => {
              const top = taggedReasons(lead).sort((a, b) => Number(b.verified) - Number(a.verified))[0];
              const pitch = pitchInfo(lead.pitch);
              return (
                <li key={lead.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <span className="ds-num hidden w-4 text-xs text-muted-foreground sm:block">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-foreground">{lead.name}</span>
                      <Badge tone={pitch.tone}>{pitch.label}</Badge>
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{VERTICAL_LABEL[lead.vertical as Vertical] ?? lead.vertical} · {suburbOf(lead.area)} · score <span className="ds-num">{lead.score}</span></span>
                      {top && <ReasonChip {...top} />}
                    </div>
                  </div>
                  {lead.phone && (
                    <div className="flex shrink-0 items-center gap-1">
                      <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="ds-num inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface-raised"><Phone className="size-3.5" /> {lead.phone}</a>
                      <CopyButton value={lead.phone} label="phone" icon={Copy} copied={copied === `d${lead.id}`} onCopy={() => copy(`d${lead.id}`, lead.phone)} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Surface>
    </section>
  );
}

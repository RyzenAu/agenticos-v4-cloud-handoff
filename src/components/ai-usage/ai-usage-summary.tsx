// Compact AI usage & spend card for Mission Control and Business → Finance. Same data as /usage
// (the /__ai_usage snapshot, read once via useAiUsage()'s cached query — no extra provider
// calls or polling are added by rendering this in more places), so every surface shows one set
// of numbers.
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { BrandMark, Notice, Skeleton, StatusDot, Surface, type Tone } from "@/components/ds";
import { fmtAud, fmtResetIn, pressureTone, useAiUsage } from "@/lib/ai-usage";
import type { ApiKeyRow } from "../../../scripts/ai-usage/types";
import { cn } from "@/lib/utils";

const KEY_STATUS_TONE: Record<ApiKeyRow["status"], Tone> = { ok: "success", warn: "warn", danger: "danger", unavailable: "neutral", info: "info" };
const KEY_STATUS_LABEL: Record<ApiKeyRow["status"], string> = { ok: "OK", warn: "Near limit", danger: "At limit", unavailable: "Unavailable", info: "Info" };

export function AiUsageSummary({ title = "AI usage & spend" }: { title?: string }) {
  const { data, error, isLoading } = useAiUsage();
  // The Codex account with the highest peak usage — called out once instead of making the
  // reader scan every subscription card for it.
  const nearestCodex = data
    ? [...data.subscriptions].filter((s) => s.provider === "openai" && s.peakPercent !== null).sort((a, b) => (b.peakPercent ?? 0) - (a.peakPercent ?? 0))[0]
    : undefined;
  return (
    <section className="mb-12" aria-labelledby="ai-usage-summary-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 id="ai-usage-summary-title" className="text-lg font-semibold leading-snug tracking-[-0.01em]">
          {title}
        </h2>
        <Link to="/usage" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          Open AI usage <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      {isLoading && <Skeleton className="h-[180px] rounded-xl" />}
      {error && !data && <Notice tone="danger">Usage couldn't be read: {error instanceof Error ? error.message : "no answer"}.</Notice>}
      {data && (
        <Surface padding="md" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <div className="ds-label">{data.month.label} so far</div>
              <div className="ds-num mt-1 text-xl font-semibold">{fmtAud(data.totals.monthAud)}</div>
              <div className="text-xs text-muted-foreground">
                Fixed {fmtAud(data.totals.fixedAud)} + metered {fmtAud(data.totals.meteredAud)} · projected {fmtAud(data.totals.projectedAud)}
              </div>
            </div>
            {nearestCodex && (
              <div className="text-right">
                <div className="ds-label">Nearest to its cap</div>
                <div className="ds-num mt-1 text-sm font-semibold">
                  {nearestCodex.owner} · {Math.round(nearestCodex.peakPercent ?? 0)}%
                </div>
              </div>
            )}
            {data.totals.unknown.length > 0 && (
              <span className="max-w-[40ch] text-xs text-muted-foreground">Not in the total: {data.totals.unknown.length} item{data.totals.unknown.length === 1 ? "" : "s"} without a readable price</span>
            )}
          </div>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.subscriptions.map((s) => {
              const top = s.status.ok ? [...s.status.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] : null;
              const tone = pressureTone(s.peakPercent);
              return (
                <li key={s.id} className="rounded-lg border border-border bg-inset p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <BrandMark agent={s.provider === "anthropic" ? "claude-code" : "codex"} size={16} />
                      <span className="truncate text-sm font-medium">{s.owner}</span>
                      <span className="truncate text-xs text-muted-foreground">{s.plan.replace(/^ChatGPT /, "")}</span>
                    </span>
                    <span className="ds-num shrink-0 text-xs text-muted-foreground">{s.monthly ? `${fmtAud(s.monthly.aud)}/mo` : "—"}</span>
                  </div>
                  {top ? (
                    <>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(top.usedPercent)} aria-label={`${s.owner} ${top.label}`}>
                        <div className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(0.5, Math.min(100, top.usedPercent))}%` }} />
                      </div>
                      <div className="ds-num mt-1 text-xs text-muted-foreground">
                        {top.label} {Math.round(top.usedPercent)}% · {fmtResetIn(top.resetsAt)}
                      </div>
                    </>
                  ) : (
                    <div className="mt-2 text-xs text-muted-foreground">Usage unavailable{!s.status.ok ? `: ${s.status.reason}` : ""}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {data.apiKeys.length > 0 && (
            <div>
              <div className="ds-label mb-2">API keys</div>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {data.apiKeys.map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-inset px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusDot tone={KEY_STATUS_TONE[key.status]} label="" className="shrink-0" />
                      <span className="truncate text-xs font-medium">{key.provider}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="ds-num text-xs text-muted-foreground">{key.spend ? fmtAud(key.spend.aud) : key.usage || "—"}</span>
                      <span className="text-xs text-muted-foreground">{KEY_STATUS_LABEL[key.status]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Surface>
      )}
    </section>
  );
}

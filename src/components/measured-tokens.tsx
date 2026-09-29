// The Tokens · API-equivalent view on Mission Control: measured per-model figures only (L3 follow-up,
// 29 Sep 2026). It used to invent call counts, a cache-hit % and per-model token counts from each
// model's share of a guessed split; those are gone. What is shown is what Claude Code's transcripts
// carry (via the /usage snapshot); a figure with no source says "not measured".
import type { ComponentType } from "react";
import { Activity as ActivityIcon, DollarSign, Zap } from "lucide-react";
import { Button, EmptyState, fmtCompact, fmtCount } from "@/components/ds";
import { fmtAud, type AiUsageSnapshot } from "@/lib/ai-usage";
// ---------- Pieces ----------

function BigStat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  accent?: string;
  icon: ComponentType<{ className?: string; style?: React.CSSProperties }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="ds-label flex items-center gap-1.5">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="ds-num mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function SpendPie({
  models,
  highlight,
  totalLabel,
  onHover,
}: {
  models: { name: string; share: number }[];
  highlight: string;
  totalLabel: string;
  onHover?: (name: string | null) => void;
}) {
  const cx = 100,
    cy = 100,
    r = 82,
    ir = 52;
  let cumulative = 0;
  const slices = models.map((m) => {
    const start = cumulative;
    cumulative += m.share;
    const end = cumulative;
    const a0 = start * Math.PI * 2 - Math.PI / 2;
    const a1 = end * Math.PI * 2 - Math.PI / 2;
    const large = end - start > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0),
      y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1),
      y1 = cy + r * Math.sin(a1);
    const xi0 = cx + ir * Math.cos(a0),
      yi0 = cy + ir * Math.sin(a0);
    const xi1 = cx + ir * Math.cos(a1),
      yi1 = cy + ir * Math.sin(a1);
    const d = `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${ir},${ir} 0 ${large} 0 ${xi0},${yi0} Z`;
    // small outward translation for highlighted slice
    const mid = (a0 + a1) / 2;
    const dx = Math.cos(mid) * 4;
    const dy = Math.sin(mid) * 4;
    return { ...m, d, dx, dy, isHi: m.name === highlight };
  });
  const hi = slices.find((s) => s.isHi);
  return (
    <div className="relative w-[210px] h-[210px] mx-auto" onMouseLeave={() => onHover?.(null)}>
      <svg viewBox="0 0 200 200" className="w-full h-full overflow-visible">
        {slices.map((s, i) => (
          <path
            key={s.name}
            d={s.d}
            fill={`var(--chart-${(i % 5) + 1})`}
            opacity={s.isHi ? 1 : 0.35}
            stroke="var(--card)"
            strokeWidth="1"
            transform={s.isHi ? `translate(${s.dx} ${s.dy})` : undefined}
            onMouseEnter={() => onHover?.(s.name)}
            style={{
              transition: "opacity 0.25s, transform 0.25s",
              cursor: onHover ? "pointer" : "default",
            }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="ds-label">Total</div>
        <div className="ds-num text-base font-semibold">{totalLabel}</div>
        <div className="text-xs text-muted-foreground mt-1 text-center max-w-[120px] truncate">
          {highlight}
        </div>
        <div className="ds-num text-xs text-foreground">
          {Math.round((hi?.share ?? 0) * 100)}%
        </div>
      </div>
    </div>
  );
}


/**
 * The Tokens · API-equivalent view, from the usage snapshot's Claude transcript totals only: this
 * month, on this PC, per model. Every figure is a count the transcripts carry (requests, input,
 * output and cache-read tokens) or the A$ the same tokens cost at Anthropic list prices. A share or
 * an average is plain arithmetic on those counts. Providers the OS has no ledger for are not shown,
 * and the view says so; nothing is derived from a guessed split.
 */
export function MeasuredTokens({
  usage,
  expandedModel,
  setExpandedModel,
}: {
  usage: AiUsageSnapshot | undefined;
  expandedModel: string | null;
  setExpandedModel: (m: string | null) => void;
}) {
  if (!usage) return <EmptyState variant="row" title="Reading token totals…" body="Not measured yet: waiting for the AI usage & spend snapshot." />;
  const c = usage.claudeModels;
  if (!("rows" in c))
    return <EmptyState variant="row" title="Not measured" body={`Claude token totals unavailable: ${c.reason}`} />;
  if (c.rows.length === 0)
    return <EmptyState variant="row" title="No Claude usage recorded this month" body="Not measured: Claude Code's transcripts have no usage for this month on this PC." />;
  const rows = [...c.rows].sort((a, b) => (b.apiEquivalent?.aud ?? 0) - (a.apiEquivalent?.aud ?? 0));
  const total = c.totalApiEquivalent?.aud ?? 0;
  const share = (r: (typeof rows)[number]) => (r.apiEquivalent && total > 0 ? r.apiEquivalent.aud / total : null);
  const open = rows.find((r) => r.model === expandedModel) ?? null;
  const tok = (n: number) => fmtCompact(n);
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        Claude only, from Claude Code's transcripts this month. On a subscription these aren't billed: they are what the same tokens would cost at API list prices. Other providers aren't measured here.
      </p>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {rows.map((r) => {
          const s = share(r);
          const isOpen = expandedModel === r.model;
          return (
            <button
              key={r.model}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setExpandedModel(isOpen ? null : r.model)}
              className={`ds-interactive rounded-lg border bg-inset p-3 text-left hover:border-border-strong ${isOpen ? "border-brand/60" : "border-border"}`}
            >
              <div className="truncate text-xs font-semibold leading-tight" title={r.model}>{r.model}</div>
              <div className="truncate text-xs text-muted-foreground">{fmtCount(r.requests)} requests</div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="ds-num text-sm font-semibold">{r.apiEquivalent ? fmtAud(r.apiEquivalent.aud, true) : "not priced"}</span>
                <span className="ds-num text-xs text-muted-foreground">{s === null ? "—" : `${Math.round(s * 100)}%`}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-brand" style={{ width: `${(s ?? 0) * 100}%` }} />
              </div>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="mt-3 rounded-xl border border-border bg-inset p-5" data-measured-model={open.model}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{open.model}</div>
              <div className="text-xs text-muted-foreground">
                This month · {open.apiEquivalent ? fmtAud(open.apiEquivalent.aud, true) : "not priced"} of {c.totalApiEquivalent ? fmtAud(c.totalApiEquivalent.aud, true) : "—"} API-equivalent (est.)
              </div>
            </div>
            <Button variant="ghost" size="xs" onClick={() => setExpandedModel(null)}>
              Close
            </Button>
          </div>
          <div className="grid grid-cols-1 items-center gap-5 lg:grid-cols-[200px_1fr]">
            <SpendPie
              models={rows.map((r) => ({ name: r.model, share: share(r) ?? 0 }))}
              highlight={open.model}
              totalLabel={c.totalApiEquivalent ? fmtAud(c.totalApiEquivalent.aud, true) : "—"}
              onHover={(name) => name && setExpandedModel(name)}
            />
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <BigStat label="Requests" value={fmtCount(open.requests)} icon={ActivityIcon} />
                <BigStat label="Cache read tokens" value={tok(open.cacheReadTokens)} icon={Zap} />
                <BigStat
                  label="API-equivalent / request"
                  value={open.apiEquivalent && open.requests > 0 ? fmtAud(open.apiEquivalent.aud / open.requests) : "—"}
                  icon={DollarSign}
                />
              </div>
              <div>
                <div className="mb-1.5 flex justify-between text-xs uppercase tracking-wider text-muted-foreground">
                  <span>Token flow</span>
                  <span className="normal-case tracking-normal tabular-nums">
                    <span className="text-foreground/80">{tok(open.inputTokens)} in</span>
                    <span className="mx-1.5">·</span>
                    <span className="text-foreground/80">{tok(open.outputTokens)} out</span>
                  </span>
                </div>
                <div className="flex h-2 overflow-hidden rounded-full bg-border">
                  <div className="h-full bg-brand" style={{ width: `${open.inputTokens + open.outputTokens > 0 ? (open.inputTokens / (open.inputTokens + open.outputTokens)) * 100 : 0}%` }} />
                  <div className="h-full bg-brand/35" style={{ width: `${open.inputTokens + open.outputTokens > 0 ? (open.outputTokens / (open.inputTokens + open.outputTokens)) * 100 : 0}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
                  <span>{open.requests > 0 ? `avg ${fmtCount(Math.round(open.inputTokens / open.requests))} in / request` : "—"}</span>
                  <span>{open.requests > 0 ? `avg ${fmtCount(Math.round(open.outputTokens / open.requests))} out / request` : "—"}</span>
                </div>
              </div>
              <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Priced at Anthropic list prices, cache writes at the rate each transcript records. Rates per model are on AI usage & spend → Claude tokens.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

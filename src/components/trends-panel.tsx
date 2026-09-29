import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { TrendingUp, TrendingDown, Minus, LineChart } from "lucide-react";
import { useLiveData } from "@/lib/use-live-data";
import { useCurrency } from "@/lib/currency";

// Each tile reads one numeric series out of the daily history snapshots
// (~/.claude-os/history.jsonl, embedded into live-data.json as `history`).
type Metric = {
  key: "value7d" | "messages7d" | "claudeWeeklyPct" | "skillRuns7d";
  label: string;
  color: string;
  fmt: (v: number) => string;
  /** Money metrics format through the display-currency hook instead of fmt. */
  money?: boolean;
};

const METRICS: Metric[] = [
  { key: "value7d", label: "Value extracted · 7d", color: "var(--chart-1)", money: true, fmt: (v) => `$${Math.round(v)}` },
  { key: "messages7d", label: "Messages · 7d", color: "var(--chart-1)", fmt: (v) => v.toLocaleString() },
  { key: "claudeWeeklyPct", label: "Weekly window", color: "var(--chart-1)", fmt: (v) => `${v}%` },
  { key: "skillRuns7d", label: "Skill runs · 7d", color: "var(--chart-1)", fmt: (v) => v.toLocaleString() },
];

interface HistoryRecord {
  date: string;
  value7d: number;
  messages7d: number;
  claudeWeeklyPct: number;
  skillRuns7d: number;
}

export function TrendsPanel() {
  const liveData = useLiveData();
  const history = useMemo<HistoryRecord[]>(
    () => (Array.isArray(liveData?.history) ? liveData.history : []),
    [liveData],
  );

  // Nothing to chart until at least one snapshot exists. The aggregator writes
  // the first row on its next run, so a fresh install simply hides the panel
  // rather than showing an empty frame.
  if (history.length === 0) return null;

  const days = history.length;

  return (
    <section className="relative mb-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold leading-snug tracking-[-0.01em]">Trends over time</h2>
        <div className="ds-num text-xs text-muted-foreground">
          {days === 1 ? "Tracking started today" : `${days} days tracked`}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {METRICS.map((m) => (
          <MetricTile key={m.key} metric={m} history={history} />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <LineChart className="h-3 w-3 shrink-0" />
        Daily snapshots from ~/.claude-os/history.jsonl. One row per day, aggregate numbers only —
        no session content stored.
      </div>
    </section>
  );
}

function MetricTile({ metric, history }: { metric: Metric; history: HistoryRecord[] }) {
  const { format: fmtMoney } = useCurrency();
  const fmt = (v: number) => (metric.money ? fmtMoney(v) : metric.fmt(v));
  const series = history.map((h) => ({
    date: h.date,
    value: typeof h[metric.key] === "number" ? (h[metric.key] as number) : 0,
  }));

  const current = series[series.length - 1]?.value ?? 0;
  const prev = series.length >= 2 ? series[series.length - 2].value : null;
  const delta = prev === null ? null : current - prev;

  const gradientId = `trend-grad-${metric.key}`;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="ds-label truncate">{metric.label}</div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="ds-num text-xl font-semibold tracking-tight text-foreground">
          {fmt(current)}
        </span>
        <DeltaBadge delta={delta} fmt={fmt} />
      </div>

      <div className="mt-3 h-12 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={metric.color} stopOpacity={0.18} />
                <stop offset="100%" stopColor={metric.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip
              cursor={{ stroke: "var(--border-strong)" }}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--popover-foreground)",
              }}
              labelStyle={{ color: "var(--muted-foreground)" }}
              formatter={(v: number) => [fmt(v), ""]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={metric.color}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={series.length === 1 ? { r: 3, fill: metric.color } : false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DeltaBadge({
  delta,
  fmt,
}: {
  delta: number | null;
  fmt: (v: number) => string;
}) {
  if (delta === null) {
    return <span className="text-xs text-muted-foreground">new</span>;
  }
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="h-2.5 w-2.5" />
        flat
      </span>
    );
  }
  const up = delta > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className="ds-num inline-flex items-center gap-0.5 text-xs text-muted-foreground">
      <Icon className="h-2.5 w-2.5" />
      {up ? "+" : "−"}
      {fmt(Math.abs(delta))}
    </span>
  );
}

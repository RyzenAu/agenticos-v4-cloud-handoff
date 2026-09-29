import type { ComponentType, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";

type Tone = "default" | "success" | "warn" | "danger";

const VALUE_TONE: Record<Tone, string> = {
  default: "text-foreground",
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
};

/**
 * One number and what it means. Label (caps, 12px) → value (24px, tabular)
 * → hint (13px, muted). Optional delta chip, icon and a REAL trend series.
 *
 * `value={null}` renders the honest empty form: an em dash plus the hint that
 * says why (e.g. "No bank connected") — never a zero that looks like data.
 * With `onClick` the whole tile becomes a button; `active` marks it expanded.
 */
export function StatTile({
  label,
  value,
  unit,
  hint,
  delta,
  icon: Icon,
  trend,
  tone = "default",
  onClick,
  active,
  footer,
  className,
}: {
  label: string;
  value: ReactNode | null;
  unit?: string;
  hint?: ReactNode;
  delta?: { value: string; direction: "up" | "down"; good?: boolean };
  icon?: ComponentType<{ className?: string }>;
  trend?: number[];
  tone?: Tone;
  onClick?: () => void;
  active?: boolean;
  footer?: ReactNode;
  className?: string;
}) {
  const Tag = onClick ? "button" : "div";
  const empty = value === null || value === undefined || value === "";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-expanded={onClick ? !!active : undefined}
      className={cn(
        "ds-interactive relative flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 text-left shadow-sm sm:p-6",
        onClick && "cursor-pointer hover:border-border-strong hover:bg-surface-raised",
        active && "border-brand/60",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="ds-label min-w-0 [overflow-wrap:anywhere]">{label}</span>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span
          className={cn(
            "ds-num text-xl font-semibold leading-none tracking-[-0.01em]",
            empty ? "text-muted-foreground" : VALUE_TONE[tone],
          )}
        >
          {empty ? "—" : value}
        </span>
        {unit && !empty && <span className="text-xs text-muted-foreground">{unit}</span>}
        {delta && !empty && (
          <span
            className={cn(
              "ds-num inline-flex items-center gap-0.5 text-xs font-medium",
              delta.good === undefined
                ? "text-muted-foreground"
                : delta.good
                  ? "text-success"
                  : "text-danger",
            )}
          >
            {delta.direction === "up" ? (
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
            )}
            {delta.value}
          </span>
        )}
      </div>
      {hint && <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      {trend && trend.length > 1 && !empty && (
        <Sparkline values={trend} className="mt-3 text-muted-foreground/80" />
      )}
      {footer && <div className="mt-auto pt-3">{footer}</div>}
    </Tag>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type RingTone = "brand" | "success" | "warn" | "danger" | "neutral";

const STROKE: Record<RingTone, string> = {
  brand: "stroke-brand",
  success: "stroke-success",
  warn: "stroke-warn",
  danger: "stroke-danger",
  neutral: "stroke-muted-foreground",
};

const SIZE = {
  sm: { px: 44, stroke: 4, value: "text-xs", unit: "text-xs" },
  md: { px: 72, stroke: 6, value: "text-base", unit: "text-xs" },
  lg: { px: 104, stroke: 8, value: "text-xl", unit: "text-xs" },
} as const;

/**
 * "N of M" as a ring: a quiet track and a rounded arc for the part that's done, with the count in
 * the middle. Progress, not a limit, so the arc is the accent (gold) by default; pass a state tone
 * only when the ring itself is the state. `max` 0 or a null `value` draws the empty, unknown ring
 * ("—"): never a fabricated zero. Text is never colour-only: the label names the count in words.
 */
export function ProgressRing({
  value,
  max,
  label,
  size = "md",
  tone = "brand",
  center,
  className,
}: {
  /** Done so far; null = unknown. */
  value: number | null;
  max: number;
  /** Accessible name, e.g. "1 of 7 requirements met". */
  label: string;
  size?: keyof typeof SIZE;
  tone?: RingTone;
  /** Replaces the default "1/7" centre. */
  center?: ReactNode;
  className?: string;
}) {
  const s = SIZE[size];
  const r = (s.px - s.stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = value !== null && max > 0;
  const ratio = known ? Math.min(1, Math.max(0, value / max)) : 0;
  // A sliver for 0 would read as a glitch; nothing drawn reads as "none yet".
  const offset = c * (1 - ratio);
  return (
    <div
      role="img"
      aria-label={label}
      data-ring-value={known ? value : "unknown"}
      data-ring-max={max}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: s.px, height: s.px }}
    >
      <svg width={s.px} height={s.px} viewBox={`0 0 ${s.px} ${s.px}`} className="-rotate-90" aria-hidden="true">
        <circle cx={s.px / 2} cy={s.px / 2} r={r} fill="none" strokeWidth={s.stroke} className="stroke-border" />
        {known && ratio > 0 && (
          <circle
            cx={s.px / 2}
            cy={s.px / 2}
            r={r}
            fill="none"
            strokeWidth={s.stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            className={cn(STROKE[tone], "transition-[stroke-dashoffset] duration-[var(--dur-slow)] ease-[var(--ease-out-quart)] motion-reduce:transition-none")}
          />
        )}
      </svg>
      <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
        {center ?? (
          <span className={cn("ds-num font-semibold leading-none text-foreground", s.value)}>
            {known ? value : "—"}
            <span className={cn("font-normal text-muted-foreground", s.unit)}>/{max}</span>
          </span>
        )}
      </span>
    </div>
  );
}

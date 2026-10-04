import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SummaryTone = "default" | "success" | "warn" | "danger" | "muted";

const VALUE: Record<SummaryTone, string> = {
  default: "text-foreground",
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-muted-foreground",
};

/**
 * One large fact at the top of a page, and the way into its detail: a short label (2–4 words), a
 * big value (36–44px), one short line under it, an optional ring. The whole tile is a button that
 * opens the section behind it. Colour only on the value when the value IS a state.
 */
export function SummaryTile({
  label,
  value,
  sub,
  subTone = "muted",
  valueTone = "default",
  visual,
  onClick,
  controls,
  className,
  ...data
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  subTone?: SummaryTone;
  valueTone?: SummaryTone;
  /** A ring or mark on the right. */
  visual?: ReactNode;
  onClick?: () => void;
  /** The id of the panel the tile opens. */
  controls?: string;
  className?: string;
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-controls={controls}
      className={cn(
        "ds-interactive group flex min-h-[9.5rem] min-w-0 flex-col justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-sm sm:p-6",
        "hover:border-border-strong hover:bg-surface-raised",
        className,
      )}
      {...data}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground sm:text-base">{label}</span>
        {visual && <span className="shrink-0">{visual}</span>}
      </span>
      <span className="min-w-0">
        <span className={cn("ds-num block text-3xl font-semibold leading-none tracking-[-0.02em] lg:text-[2.75rem]", VALUE[valueTone])}>{value}</span>
        {sub && <span className={cn("mt-2 block text-sm leading-snug sm:text-base", VALUE[subTone])}>{sub}</span>}
      </span>
    </button>
  );
}

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Disclosure } from "./disclosure";

export type AttentionSeverity = "urgent" | "critical" | "attention" | "waiting";

const SEVERITY: Record<AttentionSeverity, { dot: string; word: string; chip: string | null }> = {
  // Danger only for the truly urgent (e.g. urgent language with no 000 advice): dot + visible word.
  urgent: { dot: "bg-danger", word: "Urgent", chip: "bg-danger-soft text-danger" },
  // Critical (e.g. a critical production-QA review not yet done): amber dot and a visible word.
  critical: { dot: "bg-warn", word: "Critical", chip: "bg-warn-soft text-warn" },
  // Follow up: the dot, its word for screen readers (every card in the list needs a follow-up).
  attention: { dot: "bg-warn", word: "Follow up", chip: null },
  waiting: { dot: "bg-muted-foreground", word: "Waiting", chip: "bg-inset text-muted-foreground" },
};

/**
 * One thing that needs the owner, in one line: a severity dot, a short summary (2–6 words), the
 * when/who line and its actions. Everything else (the full consequence, other labels, sources,
 * review state) folds into "Details". Rounded, neutral card; only "Urgent" is red.
 */
export function AttentionCard({
  severity,
  severityText,
  title,
  meta,
  actions,
  details,
  detailsLabel = "Details",
  className,
  ...rest
}: {
  severity: AttentionSeverity;
  /** Overrides the severity word. */
  severityText?: ReactNode;
  /** One line a person would say ("Caller may expect a booking that wasn't made"). */
  title: ReactNode;
  /** Time · who, muted. */
  meta?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  detailsLabel?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLLIElement>, "title" | "children">) {
  const s = SEVERITY[severity];
  return (
    <li
      data-severity={severity}
      className={cn("rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm sm:px-5 sm:py-4", className)}
      {...rest}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-base font-medium leading-snug text-foreground">
            <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", s.dot)} />
            <span className="min-w-0 break-words">{title}</span>
            <span className={s.chip ? cn("rounded-full px-2.5 py-0.5 text-xs font-medium", s.chip) : "sr-only"}>{severityText ?? s.word}</span>
          </p>
          {meta && <p className="mt-1 pl-5 text-sm text-muted-foreground">{meta}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 pl-5 sm:pl-0">{actions}</div>}
      </div>
      {details && (
        <Disclosure summary={<span className="text-sm text-muted-foreground">{detailsLabel}</span>} className="-mx-3 mt-1" triggerClassName="min-h-10 py-2 pl-8">
          {details}
        </Disclosure>
      )}
    </li>
  );
}

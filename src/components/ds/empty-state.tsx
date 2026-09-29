import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Honest empty state. Says what is missing, why, and the one next step.
 *
 *  - `block`: fills a card/section when the whole thing is empty.
 *  - `row`:   one compact line when several things are empty at once — use
 *             this instead of a grid of empty cards (audit P2-10).
 *
 * Never show a zero, a fake chart or sample numbers in place of missing data.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  variant = "block",
  className,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  variant?: "block" | "row";
  className?: string;
  children?: ReactNode;
}) {
  if (variant === "row") {
    return (
      <div
        className={cn(
          "flex flex-col gap-3 rounded-2xl border border-dashed border-border-strong px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
          className,
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          {Icon && (
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{title}</div>
            {body && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{body}</div>}
            {children}
          </div>
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-2xl border border-dashed border-border-strong px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-inset text-muted-foreground">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="text-base font-medium text-foreground">{title}</div>
      {body && (
        <div className="mt-1.5 max-w-[52ch] text-sm text-muted-foreground">{body}</div>
      )}
      {children}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

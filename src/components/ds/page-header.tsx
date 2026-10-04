import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of every page. One h1, an optional one-line description, an optional
 * meta row (status, freshness, counts) and right-aligned actions.
 *
 * No kicker/eyebrow above the title — the title carries its own weight.
 * Stacks on mobile; actions wrap under the title.
 *
 * R11: `primaryAction` is the page's ONE obvious action (an accent Button); it always sits last, after any
 * quieter `actions`. A page with a primary action should not also put an accent button in `actions`.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  primaryAction,
  spacing = "default",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** R11: the page's one primary action, placed last. */
  primaryAction?: ReactNode;
  /** v1.1: space below the header. "tight" when a Toolbar/ActionBar sits right under it, "none" to control it yourself. */
  spacing?: "default" | "tight" | "none";
  className?: string;
}) {
  return (
    <header
      className={cn(
        "ds-page-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        spacing === "default" ? "mb-6" : spacing === "tight" ? "mb-4" : "mb-0",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="ds-page-title text-2xl leading-tight text-foreground text-balance">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
            {description}
          </p>
        )}
        {meta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      {(actions || primaryAction) && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {actions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}

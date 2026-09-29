import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of every page. One h1, an optional one-line description, an optional
 * meta row (status, freshness, counts) and right-aligned actions.
 *
 * No kicker/eyebrow above the title — the title carries its own weight.
 * Stacks on mobile; actions wrap under the title.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="ds-page-title text-2xl leading-tight text-foreground text-balance">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-[65ch] text-base text-muted-foreground">
            {description}
          </p>
        )}
        {meta && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>}
    </header>
  );
}

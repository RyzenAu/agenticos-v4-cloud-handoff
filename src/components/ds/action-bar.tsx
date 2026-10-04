import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * R11 shared system v1.1 (UI-PAGES request): a page's row of actions — quiet outline/ghost buttons first, the ONE primary
 * (accent) action last. Wraps on a phone, never scrolls sideways. Use under a PageHeader (spacing="tight") or at the top of a
 * section; inside a PageHeader use its own `actions`/`primaryAction` instead.
 *
 *   <ActionBar primary={<Button variant="accent">New site</Button>}>
 *     <Button variant="outline">Import</Button>
 *     <Button variant="ghost">Refresh</Button>
 *   </ActionBar>
 */
export function ActionBar({
  primary,
  children,
  align = "start",
  label,
  className,
  "data-testid": testId,
}: {
  primary?: ReactNode;
  children?: ReactNode;
  align?: "start" | "end" | "between";
  /** Accessible name for the group ("Website actions"). */
  label?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      {...(testId ? { "data-testid": testId } : {})}
      className={cn(
        "ds-action-bar mb-4 flex flex-wrap items-center gap-2",
        align === "end" && "justify-end",
        align === "between" && "justify-between",
        className,
      )}
    >
      {align === "between" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">{children}</div>
          {primary}
        </>
      ) : (
        <>
          {children}
          {primary}
        </>
      )}
    </div>
  );
}

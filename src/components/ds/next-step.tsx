import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one thing to do now: a single sentence and one gold pill. Place it under the summary tiles.
 * `action` is the button (use the accent Button, rounded-full); `lead` is a short prefix word.
 */
export function NextStep({ lead = "Next step", children, action, className }: { lead?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5", className)} data-next-step>
      <p className="flex min-w-0 items-center gap-3 text-base font-medium text-foreground sm:text-lg">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
          <ArrowRight className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="sr-only">{lead}: </span>
          {children}
        </span>
      </p>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

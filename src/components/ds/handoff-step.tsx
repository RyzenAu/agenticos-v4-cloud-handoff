import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusLabel, type StatusState } from "./status-label";

/**
 * R12 shared system: one hand-off between two parts of the business, as a readable step, never a log line:
 *
 *   Research → Design: homepage concept requested            [Running]
 *   Inferred from two jobs about the same CRM record
 *
 * `from`/`to` are department or agent names; `label` is what was asked; `status` is the RECEIVING side's state (shared vocabulary).
 * `basis` says what the step rests on when it isn't an explicit record. `action` is one quiet link (open the task).
 */
export function HandoffStep({
  from,
  to,
  label,
  status,
  basis,
  action,
  className,
  as: Tag = "div",
}: {
  from: ReactNode;
  to: ReactNode;
  label: ReactNode;
  status?: { state: StatusState; label?: string };
  basis?: ReactNode;
  action?: ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  return (
    <Tag className={cn("flex min-w-0 items-start gap-3 py-2.5", className)} data-handoff-step="">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground [overflow-wrap:anywhere]">
          <span className="font-medium">{from}</span>
          <ArrowRight aria-label="to" className="mx-1.5 inline size-3.5 -translate-y-px text-muted-foreground" />
          <span className="font-medium">{to}</span>
          <span className="text-muted-foreground">: </span>
          {label}
        </p>
        {(basis || action) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            {basis && <span>{basis}</span>}
            {action}
          </p>
        )}
      </div>
      {status && <StatusLabel state={status.state} label={status.label} size="sm" />}
    </Tag>
  );
}

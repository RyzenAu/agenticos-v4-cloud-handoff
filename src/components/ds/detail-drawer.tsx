import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * R11 shared system: the one side drawer for a record's detail (a job, a lead, a run). Right side from 640px up, full-width sheet on a
 * phone. Title + one status, the record's facts, then a sticky footer with the actions (primary on the right). Focus is trapped and
 * returned by Radix; Escape closes.
 *
 *   <DetailDrawer open={!!sel} onOpenChange={(o) => !o && setSel(null)} title={sel.title} status={<StatusLabel state="failed" />}
 *     actions={<><Button variant="outline">Retry</Button><Button variant="accent">Open</Button></>}>
 *     …facts… <Details items={receipts} />
 *   </DetailDrawer>
 */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  status,
  actions,
  children,
  size = "md",
  className,
  onEscapeKeyDown,
  onInteractOutside,
  onInput,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  size?: "md" | "lg";
  className?: string;
  /** R12 rollout (additive): an editor drawer can keep typed text on Escape or an outside click. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onInteractOutside?: (event: Event) => void;
  onInput?: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-none", size === "lg" ? "sm:w-[min(52rem,92vw)]" : "sm:w-[min(34rem,92vw)]", className)}
        {...(description ? {} : { "aria-describedby": undefined })}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        onInput={onInput}
      >
        <div className="border-b border-border pb-4 pl-5 pr-16 pt-5 sm:pl-6">
          <SheetTitle className="text-lg font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{title}</SheetTitle>
          {(status || description) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {status}
              {description && <SheetDescription className="text-sm text-muted-foreground">{description}</SheetDescription>}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {actions && <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-background px-5 py-3 sm:px-6">{actions}</div>}
      </SheetContent>
    </Sheet>
  );
}

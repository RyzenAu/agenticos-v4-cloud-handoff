// Calm, readable building blocks for the Skills, Skill drafts and Settings pages (W-E, 29 Sep 2026:
// "too small, not good on the eyes"), and the folded card the Finance pages use for their detail.
// CalmPage scopes a slightly larger type scale (calm.css), never :root: W-G owns the global scale.
// L3 (29 Sep 2026): Finance, AI usage, System and Models moved to the widget grid
// (ds/widget-grid.tsx, shell/widgets.tsx), so the signal card, the numbered next steps and the
// section heading that lived here went with them.
import { useEffect, useState, type ReactNode } from "react";
import { Disclosure } from "@/components/ds";
import { cn } from "@/lib/utils";
import "./calm.css";

/** Wrapper that gives a page the calm type scale (15 px body, 13 px meta) and roomier sections. */
export function CalmPage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("calm-page min-w-0", className)}>{children}</div>;
}

/**
 * A folded card: D1's Disclosure inside a calm rounded-2xl card. The summary is always visible; the
 * detail stays in the DOM (inert) while closed, so nothing true is removed, only folded.
 */
export function FoldCard({
  summary,
  meta,
  children,
  defaultOpen = false,
  icon,
  id,
  className,
}: {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
  id?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A link to #<id> (e.g. Finance's "Set prices" → /usage#prices) opens the fold it points at.
  useEffect(() => {
    try {
      if (id && window.location.hash === `#${id}`) setOpen(true);
    } catch {
      /* no window */
    }
  }, [id]);
  return (
    <div id={id} className={cn("calm-card mb-4 min-w-0 scroll-mt-24 p-0", className)} data-fold={id}>
      <Disclosure
        id={id ? `${id}-fold` : undefined}
        open={open}
        onOpenChange={setOpen}
        icon={icon}
        summary={
          <span className="block min-w-0">
            <span className="block text-base font-semibold text-foreground">{summary}</span>
            {/* On a phone the one-line summary sits under the title instead of squeezing it. */}
            {meta && <span className="mt-0.5 block text-sm text-muted-foreground sm:hidden">{meta}</span>}
          </span>
        }
        meta={meta ? <span className="hidden text-sm sm:inline">{meta}</span> : undefined}
        className="p-1.5 sm:p-2"
        triggerClassName="min-h-14 px-4 py-3 sm:px-5"
        panelClassName="px-4 pb-4 sm:px-5 sm:pb-5"
      >
        {children}
      </Disclosure>
    </div>
  );
}

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A row that opens to show its detail: the progressive-disclosure primitive. Collapsed by default.
 * The trigger is a real <button> (Enter/Space, aria-expanded, aria-controls); the panel stays in the
 * DOM while closed but is `inert` (out of the tab order and the accessibility tree), so nothing true
 * is removed from the page, only folded. Opening eases the height (grid 0fr→1fr); reduced motion
 * makes it instant.
 *
 * Put other controls BESIDE the Disclosure (`aside`), never inside the trigger: no nested buttons.
 */
export function Disclosure({
  summary,
  meta,
  aside,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  icon,
  className,
  triggerClassName,
  panelClassName,
  id,
}: {
  /** What the row is, in one line (always visible). */
  summary: ReactNode;
  /** A short state or count on the right of the trigger ("1 met", "Not tested"). */
  meta?: ReactNode;
  /** Controls next to the trigger (e.g. a "Sign off" button). */
  aside?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Leading status icon. */
  icon?: ReactNode;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  id?: string;
}) {
  const auto = useId();
  const base = id ?? `ds-disclosure-${auto.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [own, setOwn] = useState(defaultOpen);
  const open = openProp ?? own;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cn("min-w-0", className)} data-open={open || undefined}>
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          id={`${base}-trigger`}
          aria-expanded={open}
          aria-controls={`${base}-panel`}
          onClick={toggle}
          className={cn(
            "ds-interactive group flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left",
            "hover:bg-surface-raised",
            triggerClassName,
          )}
        >
          {icon && <span className="grid shrink-0 place-items-center" aria-hidden="true">{icon}</span>}
          <span className="min-w-0 flex-1 break-words text-sm text-foreground">{summary}</span>
          {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-[var(--dur-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
        {aside && <div className="flex shrink-0 items-center gap-2 self-center">{aside}</div>}
      </div>
      <div
        id={`${base}-panel`}
        inert={!open}
        aria-hidden={!open || undefined}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-[var(--dur-base)] ease-[var(--ease-out-quart)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className={cn("px-3 pb-3 pt-1", panelClassName)}>{children}</div>
        </div>
      </div>
    </div>
  );
}

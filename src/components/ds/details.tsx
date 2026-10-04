import type { ReactNode } from "react";
import { Disclosure } from "./disclosure";
import { cn } from "@/lib/utils";

export type DetailItem = { label: ReactNode; value: ReactNode; /** Ids, routes, hashes: monospace and breakable. */ mono?: boolean };

/**
 * R11 shared system: the folded "Details" for technical facts an ordinary workflow doesn't need — Jev decisions, model and route
 * receipts, request ids, raw config names. Collapsed by default; nothing is deleted, only folded (the panel stays in the DOM, inert).
 *
 *   <Details items={[{ label: "Route", value: "codex:gpt-6", mono: true }, { label: "Request", value: id, mono: true }]} />
 *   <Details summary="Why Jev chose this">{reasoning}</Details>
 *
 * Put at most one Details block per card or row, at the end. Never nest a Details inside another.
 */
export function Details({
  summary = "Details",
  meta,
  items,
  children,
  defaultOpen,
  className,
  id,
}: {
  summary?: ReactNode;
  /** A short count or hint on the right of the trigger ("3 receipts"). */
  meta?: ReactNode;
  items?: DetailItem[];
  children?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <Disclosure
      id={id}
      summary={<span className="text-muted-foreground">{summary}</span>}
      meta={meta}
      defaultOpen={defaultOpen}
      className={cn("ds-details -mx-3", className)}
      triggerClassName="min-h-9 py-1.5 text-xs"
      panelClassName="pt-0"
    >
      {items && items.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[minmax(7rem,max-content)_1fr]">
          {items.map((it, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{it.label}</dt>
              <dd className={cn("min-w-0 text-foreground [overflow-wrap:anywhere]", it.mono && "font-mono text-[12px]")}>{it.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children && <div className={cn("text-xs text-muted-foreground", items?.length ? "mt-2" : undefined)}>{children}</div>}
    </Disclosure>
  );
}

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * R12 shared system: a row of WORK (a task, a decision, a result) in one hairline list: title, one meta line ("Research · Running 4 min"),
 * the status on the right, then a chevron when the row opens something. Opens in-app with the router (`to` + `search`, so drafts and
 * page state survive), with `onClick` (a drawer), or with `href` (a hub-served page in a new tab). Long titles wrap; nothing truncates
 * a client name.
 *
 *   <WorkList label="Active work">
 *     <WorkRow title={t.title} meta="Research · Started 4 min ago" status={<StatusLabel state="running" size="sm" />} to="/departments/$dept" params={{ dept: "research" }} search={{ task: t.id }} />
 *   </WorkList>
 */
export function WorkList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ul aria-label={label} className={cn("ds-work-list flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card", className)}>
      {children}
    </ul>
  );
}

export function WorkRow({
  title,
  meta,
  status,
  trailing,
  to,
  params,
  search,
  href,
  onClick,
  selected,
  children,
  className,
  ...data
}: {
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  /** A quiet control after the row (never another accent button). */
  trailing?: ReactNode;
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  children?: ReactNode;
  className?: string;
  [key: `data-${string}`]: string | undefined;
}) {
  const opens = !!(to || href || onClick);
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{title}</span>
        {meta && <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{meta}</span>}
        {children}
      </span>
      {status && <span className="shrink-0">{status}</span>}
      {opens && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );
  const cls = "ds-interactive flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised focus-visible:bg-surface-raised";
  return (
    <li className={cn("flex items-center", selected && "bg-surface-raised", className)} aria-current={selected || undefined} {...data}>
      {to ? (
        <Link to={to as never} params={params as never} search={search as never} className={cls}>{body}</Link>
      ) : href ? (
        <a href={href} target="_blank" rel="noreferrer" className={cls}>{body}</a>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cls}>{body}</button>
      ) : (
        <div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-3">{body}</div>
      )}
      {trailing && <div className="shrink-0 pr-4">{trailing}</div>}
    </li>
  );
}

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Hide this column below a width (it still shows in the phone card if `phone` isn't false). */
  hideBelow?: "md" | "lg" | "xl";
  /** CSS width for the column (e.g. "8rem", "40%"). */
  width?: string;
  /** Show in the stacked phone card (default true). The first column is the card title. */
  phone?: boolean;
};

const HIDE: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = { md: "hidden md:table-cell", lg: "hidden lg:table-cell", xl: "hidden xl:table-cell" };

/**
 * R11 shared system: a calm table. Real <table> from 640px up (sticky-free, quiet header, hairline rows, hover lift), and a stacked
 * list of rows on a phone (first column is the title, the rest become "label value" lines). Click/Enter on a row calls `onRowClick`
 * (open a DetailDrawer from it). Give `empty` an EmptyState with a next action.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  selectedKey,
  empty,
  caption,
  className,
  "data-testid": testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Accessible name of a clickable row ("Open job: …"). */
  rowLabel?: (row: T) => string;
  selectedKey?: string | null;
  empty?: ReactNode;
  /** Screen-reader caption. */
  caption?: string;
  className?: string;
  "data-testid"?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const key = (e: KeyboardEvent, row: T) => {
    if (!onRowClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick(row);
    }
  };
  const interactive = onRowClick ? "cursor-pointer hover:bg-surface-raised focus-visible:bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" : "";
  const [first, ...rest] = columns;
  return (
    <div className={cn("ds-table", className)} {...(testId ? { "data-testid": testId } : {})}>
      <div className="hidden overflow-hidden rounded-2xl border border-border bg-card sm:block">
        <table className="w-full table-fixed border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <colgroup>{columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}</colgroup>
          <thead>
            <tr className="border-b border-border">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn("px-4 py-3 text-xs font-medium text-muted-foreground", c.align === "right" ? "text-right" : "text-left", c.hideBelow && HIDE[c.hideBelow])}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const k = rowKey(row);
              return (
                <tr
                  key={k}
                  data-row={k}
                  aria-selected={selectedKey != null ? selectedKey === k : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={(e) => key(e, row)}
                  className={cn("border-b border-border last:border-b-0 transition-colors", interactive, selectedKey === k && "bg-surface-raised")}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-4 py-3 align-middle", c.align === "right" ? "text-right ds-num" : "text-left", c.hideBelow && HIDE[c.hideBelow])}>
                      <div className="min-w-0 [overflow-wrap:anywhere]">{c.cell(row)}</div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card sm:hidden">
        {rows.map((row) => {
          const k = rowKey(row);
          return (
            <li
              key={k}
              data-row={k}
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? "button" : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={(e) => key(e, row)}
              className={cn("flex flex-col gap-1.5 px-4 py-3", interactive)}
            >
              <div className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{first.cell(row)}</div>
              {rest.filter((c) => c.phone !== false).map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{c.header}</span>
                  <span className="min-w-0 text-right text-foreground [overflow-wrap:anywhere]">{c.cell(row)}</span>
                </div>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A plain list of rows (no columns): title, one line of meta, a status on the right, an optional trailing action. Hairline separated,
 * in ONE container — never a card per row inside a card.
 */
export function DataList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul aria-label={label} className={cn("ds-list flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card", className)}>
      {children}
    </ul>
  );
}

export function DataRow({
  title,
  meta,
  status,
  trailing,
  onClick,
  href,
  selected,
  className,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  /** A plain link row (use the router's Link via `children` when you need client navigation). */
  href?: string;
  /** v1.1: this row is the one open in the DetailDrawer (raised, aria-current). */
  selected?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{title}</div>
        {meta && <div className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{meta}</div>}
        {children}
      </div>
      {status && <div className="shrink-0">{status}</div>}
    </>
  );
  const rowCls = "flex min-h-14 items-center gap-3 px-4 py-3";
  return (
    <li className={cn("flex items-center", selected && "bg-surface-raised", className)} aria-current={selected || undefined} data-selected={selected || undefined}>
      {href ? (
        <a href={href} className={cn(rowCls, "ds-interactive min-w-0 flex-1 hover:bg-surface-raised")}>{body}</a>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cn(rowCls, "ds-interactive min-w-0 flex-1 text-left hover:bg-surface-raised")}>{body}</button>
      ) : (
        <div className={cn(rowCls, "min-w-0 flex-1")}>{body}</div>
      )}
      {trailing && <div className="shrink-0 pr-4">{trailing}</div>}
    </li>
  );
}

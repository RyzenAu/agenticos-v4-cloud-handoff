import { Children, useId, type ComponentType, type ElementType, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The L-wave page layout (owner, 29 Sep 2026): every page is a grid of equal-height widgets that
 * fills the width, like the original /inbox. Rules live in docs/DESIGN-SYSTEM.md → "Widget grid".
 *
 *   <WidgetGrid>                          4 across ≥1280px, 2 across ≥768px, 1 (or 2) at phone width
 *     <Widget icon={Phone} title="Calls" value={3} line="2 need a call back" action={<Button/>} />
 *     <WidgetList icon={Inbox} title="To answer" span={2} action={…}>{rows}</WidgetList>
 *   </WidgetGrid>
 *   <PageFoot>Updated 2 min ago · Source: Gmail, Retell</PageFoot>
 *
 * A widget is: an icon plus a short title, ONE big value or ONE piece of content, one short line,
 * and one action. Freshness and sources never sit in a widget; they go in the one PageFoot line.
 */

export type WidgetSpan = 1 | 2 | 3 | 4;
export type WidgetTone = "default" | "success" | "warn" | "danger" | "muted";

// Spans collapse with the grid: a 2+ widget fills the row on a phone and on a 2-column tablet.
const SPAN: Record<WidgetSpan, string> = {
  1: "",
  2: "col-span-full md:col-span-2",
  3: "col-span-full xl:col-span-3",
  4: "col-span-full",
};

const TONE: Record<WidgetTone, string> = {
  default: "text-foreground",
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-muted-foreground",
};

/**
 * The responsive grid. Fills the width of the page frame; rows stretch so the widgets in a row
 * are the same height. `mobile={2}` puts small value widgets two-up at phone width.
 */
export function WidgetGrid({
  children,
  mobile = 1,
  as: Tag = "div",
  className,
  ...rest
}: {
  children: ReactNode;
  mobile?: 1 | 2;
  as?: ElementType;
  className?: string;
} & { [key: `data-${string}`]: string | undefined; "aria-label"?: string; "aria-busy"?: boolean | "true" | "false"; role?: string; id?: string }) {
  return (
    <Tag
      data-widget-grid=""
      className={cn(
        "grid w-full items-stretch gap-4 md:grid-cols-2 lg:gap-6 xl:grid-cols-4",
        mobile === 2 ? "grid-cols-2" : "grid-cols-1",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

type WidgetBase = {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  /** A short state word or count beside the title ("Not connected", 3). Never a sentence. */
  badge?: ReactNode;
  /** The one action: a Button or Link. */
  action?: ReactNode;
  span?: WidgetSpan;
  /** h2 by default: a page is h1 + a grid of widgets. */
  headingLevel?: 2 | 3;
  id?: string;
  className?: string;
} & { [key: `data-${string}`]: string | undefined };

function WidgetShell({
  icon: Icon,
  title,
  badge,
  action,
  span = 1,
  headingLevel = 2,
  id,
  className,
  children,
  ...data
}: WidgetBase & { children: ReactNode }) {
  const auto = useId();
  const titleId = `${id ?? auto}-title`;
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-widget=""
      data-span={span}
      className={cn(
        "flex h-full min-w-0 flex-col rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6",
        SPAN[span],
        className,
      )}
      {...data}
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground">
            <Icon className="size-4" />
          </span>
        )}
        <H id={titleId} className="min-w-0 flex-1 text-base font-medium leading-snug text-foreground [overflow-wrap:anywhere]">
          {title}
        </H>
        {badge != null && badge !== "" && (
          <span data-widget-count="" className="ds-num shrink-0 text-sm text-muted-foreground">{badge}</span>
        )}
      </div>
      {children}
      {action && <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">{action}</div>}
    </section>
  );
}

/**
 * One widget. Give it `value` (a big number or word) and a `line`, or `children` for one piece
 * of content. `value={null}` is the honest empty form: an em dash, never a fabricated 0.
 */
export function Widget({
  value,
  line,
  tone = "default",
  lineTone = "muted",
  children,
  ...base
}: WidgetBase & {
  value?: ReactNode | null;
  line?: ReactNode;
  tone?: WidgetTone;
  lineTone?: WidgetTone;
  children?: ReactNode;
}) {
  const hasValue = value !== undefined;
  const empty = value === null || value === "";
  return (
    <WidgetShell {...base}>
      {hasValue && (
        <p
          data-widget-value={empty ? "unknown" : ""}
          className={cn(
            "ds-num mt-5 text-3xl font-semibold leading-none tracking-[-0.02em]",
            empty ? TONE.muted : TONE[tone],
          )}
        >
          {empty ? "—" : value}
        </p>
      )}
      {children != null && <div className="mt-4 min-w-0">{children}</div>}
      {line && <p className={cn("mt-3 text-sm leading-snug", TONE[lineTone])}>{line}</p>}
    </WidgetShell>
  );
}

/**
 * A spanning list widget (a feed, a queue, a table's worth of rows). Children are list items,
 * ideally WidgetRow; with none, `empty` says so plainly. Spans 2 columns unless told otherwise.
 */
export function WidgetList({
  children,
  empty = "Nothing here right now.",
  span = 2,
  ...base
}: WidgetBase & { children?: ReactNode; empty?: ReactNode }) {
  const count = Children.toArray(children).length;
  return (
    <WidgetShell span={span} {...base}>
      {count > 0 ? (
        <ul role="list" className="mt-4 divide-y divide-border">
          {children}
        </ul>
      ) : (
        // A string is one line of text (<p>); a node (WidgetEmpty is a <div> holding <p>s) needs a <div>:
        // a block inside a <p> is invalid HTML and logs a hydration error (audit P3-1, 29 Sep 2026).
        typeof empty === "string" ? (
          <p data-widget-empty="" className="mt-5 text-sm text-muted-foreground">
            {empty}
          </p>
        ) : (
          <div className="mt-5 text-sm text-muted-foreground">{empty}</div>
        )
      )}
    </WidgetShell>
  );
}

/** One row of a WidgetList: a title, one short meta line, and an optional control on the right. */
export function WidgetRow({
  title,
  meta,
  aside,
  lead,
  className,
  ...data
}: {
  title: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  lead?: ReactNode;
  className?: string;
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <li className={cn("flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0", className)} {...data}>
      {lead && <span className="shrink-0">{lead}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere] sm:text-base">{title}</span>
        {meta && <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere] sm:text-sm">{meta}</span>}
      </span>
      {aside && <span className="flex shrink-0 items-center gap-2">{aside}</span>}
    </li>
  );
}

/** An honest empty state inside a widget: plain words, no dashed box inside the card. */
export function WidgetEmpty({ title, body, className }: { title: ReactNode; body?: ReactNode; className?: string }) {
  return (
    <div data-widget-empty="" className={cn("min-w-0", className)}>
      <p className="text-base font-medium text-foreground">{title}</p>
      {body && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>}
    </div>
  );
}

/** The one small line at the foot of a page for freshness and sources. */
export function PageFoot({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <footer data-page-foot="" title={title} className={cn("mt-10 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground", className)}>
      {children}
    </footer>
  );
}

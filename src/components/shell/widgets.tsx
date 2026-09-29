// L3 widget-grid helpers (29 Sep 2026): the pieces the Finance, AI usage, System, Models, Goals and
// Mission Control pages share on top of L1's WidgetGrid / Widget / WidgetList (ds/widget-grid.tsx).
// The primitive itself is not touched; what is here is only what those pages needed beyond it:
//   SignalWidget   a Widget that keeps every honest state of SignalTile / CalmSignal: unknown, failed,
//                  setup-required and stale say so in words and never show a number or a success tone
//   WidgetDeck     a grid of summary widgets whose "Open" reveals the full detail (a table, a graph, a
//                  form) as a full-width panel under the grid: nothing is removed, only tucked behind
//                  one click, and the choice is remembered per browser
//   MeterBar       a slim limit bar (gold normal, copper from 70%, red from 90%)
//   WidgetLink / WidgetButton   the one action of a widget, in the shared pill shape
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, X } from "lucide-react";
import { Button, Skeleton, Widget, WidgetGrid, type WidgetSpan, type WidgetTone } from "@/components/ds";
import { fmtDay } from "@/lib/format";
import { tileHonestState } from "@/lib/honest-state";
import { cn } from "@/lib/utils";
import type { SignalRecovery, SignalState, SignalTone } from "./page-parts";

type Icon = ComponentType<{ className?: string }>;

/** The shared shape of a widget's one action. */
export const WIDGET_ACTION = "h-10 rounded-full px-5";

export function WidgetLink({
  to,
  search,
  hash,
  children,
  accent = false,
  arrow = false,
  label,
}: {
  to: string;
  search?: Record<string, string>;
  hash?: string;
  children: ReactNode;
  accent?: boolean;
  arrow?: boolean;
  label?: string;
}) {
  return (
    <Button variant={accent ? "accent" : "outline"} className={WIDGET_ACTION} asChild>
      <Link to={to as never} search={search as never} hash={hash} aria-label={label}>
        {children}
        {arrow && <ArrowRight aria-hidden="true" />}
      </Link>
    </Button>
  );
}

export function WidgetButton({
  children,
  onClick,
  accent = false,
  disabled,
  expanded,
  controls,
  label,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  accent?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  label?: string;
  type?: "button" | "submit";
}) {
  return (
    <Button
      type={type}
      variant={accent ? "accent" : "outline"}
      className={WIDGET_ACTION}
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

/** "just now", "12 min ago", "3 h ago", or a date: for the one PageFoot line. Null when there is no time. */
export function agoText(at: string | number | null | undefined, now: number): string | null {
  if (at === null || at === undefined || at === "" || !now) return null;
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const age = Math.max(0, now - t);
  return age < 60_000 ? "just now" : age < 3_600_000 ? `${Math.floor(age / 60_000)} min ago` : age < 86_400_000 ? `${Math.floor(age / 3_600_000)} h ago` : fmtDay(t, { year: "auto" });
}

/** Gold while normal, copper from 70%, red from 90%: the same reading as the plan-limit meters. */
export function pressureOf(pct: number | null | undefined): "normal" | "warn" | "danger" {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "normal";
  return pct >= 90 ? "danger" : pct >= 70 ? "warn" : "normal";
}

export function MeterBar({ label, percent, right }: { label: ReactNode; percent: number; right?: ReactNode }) {
  const pct = Math.max(0, Math.min(100, percent));
  const level = pressureOf(pct);
  const text = typeof label === "string" ? label : undefined;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="ds-num text-muted-foreground">{right ?? `${Math.round(pct)}%`}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-border"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={text ? `${text}: ${Math.round(pct)}% used` : `${Math.round(pct)}% used`}
      >
        <div className={cn("h-full rounded-full", level === "danger" ? "bg-danger" : level === "warn" ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, 0.5)}%` }} />
      </div>
    </div>
  );
}

const STATE_WORD: Partial<Record<SignalState, string>> = { unknown: "Unknown", failed: "Couldn't read", "setup-required": "Setup required" };

/**
 * A Widget for one measured figure. Rules kept from SignalTile: `value === null` shows an em dash;
 * unknown / failed / setup-required show their word, never a number; a failed, unknown, stale or
 * estimated reading never carries a success tone. Freshness and source are not on the widget: they
 * belong in the page's one PageFoot line. A stale or estimated figure says so as a short badge.
 */
export function SignalWidget({
  icon,
  title,
  value,
  line,
  tone,
  state,
  updatedAt,
  lastSuccess,
  now,
  staleAfterMs,
  recovery,
  action,
  link,
  loading,
  span,
  badge,
  className,
  children,
  ...data
}: {
  icon?: Icon;
  title: string;
  value: ReactNode | null;
  line?: ReactNode;
  tone?: SignalTone;
  state?: SignalState;
  updatedAt?: string | number | null;
  lastSuccess?: string | number | null;
  now?: number;
  staleAfterMs?: number;
  recovery?: SignalRecovery;
  /** The one action; wins over `recovery` and `link`. */
  action?: ReactNode;
  link?: { to: string; label: string; search?: Record<string, string>; hash?: string };
  loading?: boolean;
  span?: WidgetSpan;
  badge?: ReactNode;
  className?: string;
  children?: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
  const word = state === "setup-required" ? (typeof value === "number" || value === null || value === undefined || value === "" ? STATE_WORD[state] : undefined) : state ? STATE_WORD[state] : undefined;
  const empty = !word && (value === null || value === undefined || value === "");
  const freshAt = lastSuccess !== undefined ? lastSuccess : updatedAt;
  const honest = tileHonestState(state, { empty, at: freshAt, now, staleAfterMs });
  const shownTone: WidgetTone | undefined = word
    ? state === "failed"
      ? "danger"
      : "muted"
    : empty
      ? undefined
      : (honest === "stale" || honest === "simulated" || honest === "unknown") && tone === "success"
        ? "default"
        : (tone as WidgetTone | undefined);
  const showRecovery = !!recovery && !loading && !(state === "ok" || state === "zero" || state === "live" || state === "simulated" || state === undefined);
  const chip = honest === "stale" ? "Stale" : honest === "simulated" ? "Estimate" : undefined;
  const shown: ReactNode | null = loading
    ? (
        <span role="status" className="block h-9 w-28 animate-pulse rounded-lg bg-inset motion-reduce:animate-none" aria-label={`${title} loading`} />
      )
    : word
      ? <span className="text-xl">{word}</span>
      : empty
        ? null
        : typeof value === "string" && value.length > 10
          ? <span className="text-xl">{value}</span>
          : value;
  const act =
    action ??
    (showRecovery ? (
      recovery!.to ? (
        <WidgetLink to={recovery!.to}>{recovery!.label}</WidgetLink>
      ) : (
        <WidgetButton onClick={recovery!.onClick}>{recovery!.label}</WidgetButton>
      )
    ) : link ? (
      <WidgetLink to={link.to} search={link.search} hash={link.hash}>
        {link.label}
      </WidgetLink>
    ) : undefined);
  return (
    <Widget
      icon={icon}
      title={title}
      badge={badge ?? chip}
      value={shown}
      tone={shownTone}
      line={loading ? undefined : line}
      action={act}
      span={span}
      className={className}
      data-state={loading ? "loading" : (state ?? (empty ? "unknown" : undefined))}
      {...data}
    >
      {children}
    </Widget>
  );
}

// ---------------------------------------------------------------------------------------------
// DeckSection and WidgetDeck

export type DeckItem = {
  /** Also the id of the detail panel (so #hash links open it). */
  id: string;
  icon?: Icon;
  title: string;
  /** A short state word or count beside the title. */
  badge?: ReactNode;
  value?: ReactNode | null;
  tone?: WidgetTone;
  line?: ReactNode;
  lineTone?: WidgetTone;
  /** The detail. A function mounts only while the panel is open (3D graphs, long tables). */
  detail: ReactNode | (() => ReactNode);
  /** Keep the detail in the page (hidden) while closed, so it is still there for search and tests. */
  keepMounted?: boolean;
  defaultOpen?: boolean;
  /** Remembered in this browser under `calm-open:<key>` (the key Mission Control already used). */
  persistKey?: string;
  /** A short verb for the button: "Open" (default), "Review", "Edit". */
  openLabel?: string;
  span?: WidgetSpan;
};

function readStored(key: string | undefined): boolean | null {
  if (!key) return null;
  try {
    const v = window.localStorage.getItem(`calm-open:${key}`);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

/** Open the panel `id` on this page (what a #id link does, without leaving the page). */
export function openPanel(id: string) {
  try {
    window.history.replaceState(window.history.state, "", `#${id}`);
    window.dispatchEvent(new Event("hashchange"));
  } catch {
    /* no window */
  }
}

/**
 * One summary widget and, once opened, its detail as a full-width panel straight after it. Inside a
 * dense grid (`grid-flow-dense`, which WidgetDeck sets) the panel drops under the widget's row and
 * the widgets after it fill that row, so the page reads as widgets with panels opening beneath them.
 * Its state: an untouched section follows `defaultOpen`; a stored choice (persistKey) and a `#id`
 * link (on load, or set on this page) win over it.
 */
export function DeckSection({ id, icon: Icon, title, badge, value, tone, line, lineTone, detail, keepMounted, defaultOpen = false, persistKey, openLabel = "Open", span }: DeckItem) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? defaultOpen;
  const scroll = useRef(false);
  // Stored choices and a #hash apply after hydration, so the server and first client render agree.
  useEffect(() => {
    const stored = readStored(persistKey);
    if (stored !== null) setChoice(stored);
    const onHash = () => {
      try {
        if (window.location.hash.slice(1) !== id) return;
      } catch {
        return;
      }
      scroll.current = true;
      setChoice(true);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [id, persistKey]);
  useEffect(() => {
    if (!scroll.current || !open) return;
    scroll.current = false;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" }));
  });
  const toggle = (next: boolean) => {
    setChoice(next);
    if (next) scroll.current = true;
    if (persistKey)
      try {
        window.localStorage.setItem(`calm-open:${persistKey}`, next ? "1" : "0");
      } catch {
        /* the choice lasts this visit */
      }
  };
  const verb = open ? "Close" : openLabel;
  return (
    <>
      <Widget
        icon={Icon}
        title={title}
        badge={badge}
        value={value}
        tone={tone}
        line={line}
        lineTone={lineTone}
        span={span}
        data-deck-item={id}
        action={
          <WidgetButton expanded={open} controls={open ? id : undefined} label={`${verb} ${title}`} onClick={() => toggle(!open)}>
            {verb}
          </WidgetButton>
        }
      />
      {open || keepMounted ? (
        <section
          id={id}
          hidden={!open}
          aria-labelledby={`${id}-panel-title`}
          data-deck-panel={id}
          className="col-span-full min-w-0 scroll-mt-24 rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6"
        >
          <div className="mb-5 flex min-w-0 items-center gap-3">
            {Icon && (
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground">
                <Icon className="size-4" />
              </span>
            )}
            <h3 id={`${id}-panel-title`} className="min-w-0 flex-1 truncate text-lg font-medium text-foreground">
              {title}
            </h3>
            <Button type="button" variant="ghost" className="h-10 rounded-full px-4" onClick={() => toggle(false)} aria-label={`Close ${title}`}>
              <X aria-hidden="true" /> Close
            </Button>
          </div>
          {typeof detail === "function" ? detail() : detail}
        </section>
      ) : null}
    </>
  );
}

/** A dense widget grid: `DeckSection`s (and any other widgets, as `lead` or children) with panels opening under them. */
export function DeckGrid({ children, mobile = 1, className }: { children: ReactNode; mobile?: 1 | 2; className?: string }) {
  return (
    <WidgetGrid mobile={mobile} className={cn("grid-flow-dense", className)} data-widget-deck="">
      {children}
    </WidgetGrid>
  );
}

/** A deck from a list: every item a DeckSection in one dense grid. `lead` widgets sit first. */
export function WidgetDeck({ items, mobile = 1, className, lead }: { items: DeckItem[]; mobile?: 1 | 2; className?: string; lead?: ReactNode }) {
  return (
    <DeckGrid mobile={mobile} className={className}>
      {lead}
      {items.map((item) => (
        <DeckSection key={item.id} {...item} />
      ))}
    </DeckGrid>
  );
}
// Calm page pieces for the W-A pages (Today, Mission Control, Business brief, Goals), built on the
// ds calm primitives (ProgressRing, Disclosure from D1). What's here is only what ds doesn't have:
//   CalmCard      the rounded-2xl card with generous padding
//   CalmSection   a whole page section folded into one big, calm row (icon, title, one-line
//                 summary); its body mounts only once opened, so heavy sections (3D graphs, long
//                 tables) cost nothing until asked for, and the choice is remembered per browser
//   Pill, CalmFigure  a soft state word and a big glanceable figure
// Candidates for @/components/ds once the W-wave lands (noted for consolidation).
import { createContext, useEffect, useState, type ComponentProps, type ElementType, type ReactNode } from "react";
import { Disclosure, ProgressRing } from "@/components/ds";
import { cn } from "@/lib/utils";
import "./calm.css";

export type CalmTone = "neutral" | "brand" | "success" | "warn" | "danger";

/** The calm card: rounded-2xl, generous padding. */
export function CalmCard({ as: Tag = "section", className, children, tone, ...rest }: { as?: ElementType; className?: string; children: ReactNode; tone?: CalmTone } & Record<string, unknown>) {
  return (
    <Tag className={cn("calm-card", className)} data-tone={tone} {...rest}>
      {children}
    </Tag>
  );
}

/** True inside a CalmSection, so a section's own heading can step aside for the row that names it. */
export const InCalmSection = createContext(false);

function readOpen(key: string | undefined): boolean | null {
  if (!key) return null;
  try {
    const v = window.localStorage.getItem(`calm-open:${key}`);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

/**
 * A page section folded into one calm row: a named region (its title), with the ds Disclosure
 * providing the button, aria-expanded and the eased open. (A heading can't sit inside the button.)
 */
export function CalmSection({
  title,
  summary,
  meta,
  icon: Icon,
  defaultOpen = false,
  persistKey,
  children,
  headingLevel = 2,
  className,
  tone,
}: {
  title: ReactNode;
  summary?: ReactNode;
  meta?: ReactNode;
  icon?: ElementType;
  defaultOpen?: boolean;
  persistKey?: string;
  children: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
  tone?: CalmTone;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [seen, setSeen] = useState(defaultOpen);
  // The stored choice applies after hydration, so the server and first client render agree.
  useEffect(() => {
    const stored = readOpen(persistKey);
    if (stored !== null) {
      setOpen(stored);
      if (stored) setSeen(true);
    }
  }, [persistKey]);
  const change = (next: boolean) => {
    setOpen(next);
    if (next) setSeen(true);
    if (persistKey)
      try {
        window.localStorage.setItem(`calm-open:${persistKey}`, next ? "1" : "0");
      } catch {
        /* storage unavailable: the choice lasts this visit */
      }
  };
  return (
    <section className={cn("calm-section", className)} data-open={open || undefined} data-tone={tone} data-level={headingLevel} aria-label={typeof title === "string" ? title : undefined}>
      <Disclosure
        open={open}
        onOpenChange={change}
        triggerClassName="calm-section-trigger"
        panelClassName="calm-section-panel"
        icon={
          Icon ? (
            <span className="calm-section-icon">
              <Icon className="h-5 w-5" />
            </span>
          ) : undefined
        }
        summary={
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="calm-section-title">{title}</span>
            {summary && <span className="calm-section-summary">{summary}</span>}
          </span>
        }
        meta={meta ? <span className="calm-section-meta">{meta}</span> : undefined}
      >
        <InCalmSection.Provider value={true}>{seen ? children : null}</InCalmSection.Provider>
      </Disclosure>
    </section>
  );
}

/** A soft pill: a word with a state colour (colour never carries the meaning alone). */
export function Pill({ tone = "neutral", children, title }: { tone?: CalmTone; children: ReactNode; title?: string }) {
  return (
    <span className="calm-pill" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/** A big glanceable figure: label, value, one line under it. `value === null` shows "—". */
export function CalmFigure({ label, value, hint, tone }: { label: ReactNode; value: ReactNode | null; hint?: ReactNode; tone?: CalmTone }) {
  return (
    <div className="calm-figure" data-tone={tone}>
      <span className="calm-figure-label">{label}</span>
      <span className="calm-figure-value ds-num" data-empty={value === null || undefined}>
        {value === null ? "—" : value}
      </span>
      {hint && <span className="calm-figure-hint">{hint}</span>}
    </div>
  );
}

/** A ds ProgressRing with a caption under it (the ring's own label stays its accessible name). */
export function CaptionedRing({ caption, ...ring }: ComponentProps<typeof ProgressRing> & { caption: ReactNode }) {
  return (
    <figure className="calm-ring">
      <ProgressRing {...ring} />
      <figcaption className="calm-ring-caption">{caption}</figcaption>
    </figure>
  );
}

import type { HTMLAttributes, ReactNode } from "react";
import { CircleCheck, CircleHelp, ShieldAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export type VerdictTone = "ok" | "warn" | "bad" | "neutral";

const TONE: Record<VerdictTone, { mark: string; Icon: typeof ShieldAlert }> = {
  ok: { mark: "bg-success-soft text-success", Icon: CircleCheck },
  warn: { mark: "bg-warn-soft text-warn", Icon: TriangleAlert },
  // The page's single danger mark lives here: the overall verdict.
  bad: { mark: "bg-danger-soft text-danger", Icon: ShieldAlert },
  neutral: { mark: "bg-inset text-muted-foreground", Icon: CircleHelp },
};

/**
 * The answer at the top of a page. A round tone mark (the only strong colour) beside a large
 * headline that states the verdict in words, one sentence why, a few neutral fact pills, a ring for
 * progress, ONE primary action with at most two secondary, then disclosures for the detail behind
 * it. The card stays neutral: no tinted background, no side stripe.
 */
export function VerdictCard({
  tone,
  title,
  titleId,
  why,
  facts,
  ring,
  ringCompact,
  primary,
  secondary,
  children,
  footer,
  className,
  ...rest
}: {
  tone: VerdictTone;
  /** The verdict in words ("Not safe to sell"). */
  title: ReactNode;
  titleId?: string;
  /** One plain sentence: why. */
  why?: ReactNode;
  /** Short neutral facts behind the verdict (2–4). */
  facts?: ReactNode[];
  ring?: ReactNode;
  /** A small ring for phones, shown beside the headline (the large ring shows from sm up). */
  ringCompact?: ReactNode;
  primary?: ReactNode;
  /** At most two. */
  secondary?: ReactNode;
  /** Disclosures (requirements, evidence) under the answer. */
  children?: ReactNode;
  /** Source and freshness. */
  footer?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "children">) {
  const t = TONE[tone];
  return (
    <section
      aria-labelledby={titleId}
      data-tone={tone}
      className={cn("rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-7", className)}
      {...rest}
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3.5">
            <span aria-hidden="true" className={cn("grid size-11 shrink-0 place-items-center rounded-full", t.mark)}>
              <t.Icon className="size-5" strokeWidth={1.75} />
            </span>
            <h2 id={titleId} className="min-w-0 text-balance text-xl font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-2xl">
              {title}
            </h2>
            {ringCompact && <div className="ml-auto shrink-0 sm:hidden">{ringCompact}</div>}
          </div>
          {why && <p className="mt-3 max-w-[62ch] text-base leading-relaxed text-foreground/90">{why}</p>}
          {facts && facts.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm leading-relaxed text-muted-foreground" aria-label="Facts behind the verdict">
              {facts.map((fact, i) => (
                <li key={i}>{fact}</li>
              ))}
            </ul>
          )}
          {(primary || secondary) && (
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {primary}
              {secondary}
            </div>
          )}
        </div>
        {ring && <div className={cn("shrink-0 items-center gap-3 sm:flex sm:flex-col sm:gap-2 sm:pt-1", ringCompact ? "hidden" : "flex")}>{ring}</div>}
      </div>
      {children && <div className="-mx-2 mt-6 border-t border-border pt-2 sm:-mx-3">{children}</div>}
      {footer && <div className="mt-3 text-xs leading-relaxed text-muted-foreground">{footer}</div>}
    </section>
  );
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled block of a page. Sections are separated by space (mb-14), not by
 * rules or boxes; the content inside decides whether it needs a Card.
 */
export function Section({
  title,
  description,
  actions,
  children,
  id,
  className,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("mb-14", className)}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Heading
            id={headingId}
            className="text-lg font-semibold leading-snug tracking-[-0.01em] text-foreground"
          >
            {title}
          </Heading>
          {description && (
            <p className="mt-1.5 max-w-[70ch] text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

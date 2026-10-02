import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The shared section rhythm for drawers and focused work surfaces. */
export function DetailSection({ title, children, actions, className }: { title: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cn("ds-detail-section", className)} aria-labelledby={id}>
      <div className="ds-detail-section-head">
        <h3 id={id}>{title}</h3>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

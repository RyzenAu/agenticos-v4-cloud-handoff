import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder for a whole page or a list, in the shape of the final layout
 * (docs/DESIGN-SYSTEM.md §5: skeletons for layout-sized loads, never a lone spinner).
 *
 *  - `page`: PageHeader (title + one line) above `rows` list rows.
 *  - `list`: just the rows, for a section whose header is already on screen.
 *
 * Announced once to assistive tech through `label`; the shapes themselves are hidden.
 */
export function PageSkeleton({
  variant = "page",
  rows = 4,
  label = "Loading",
  className,
}: {
  variant?: "page" | "list";
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn("min-w-0", className)}>
      <div aria-hidden="true">
        {variant === "page" && (
          <div className="mb-8">
            <Skeleton className="h-8 w-44 rounded-lg" />
            <Skeleton className="mt-3 h-4 w-full max-w-[26rem]" />
          </div>
        )}
        <div className="flex flex-col gap-3">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-2xl" />
          ))}
        </div>
      </div>
      <span className="sr-only">{label}…</span>
    </div>
  );
}

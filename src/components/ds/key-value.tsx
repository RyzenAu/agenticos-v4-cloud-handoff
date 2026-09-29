import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Label/value pairs. Labels muted and left, values right-aligned and
 * tabular. `mono` for IDs, paths, model slugs and timestamps.
 */
export function KeyValueList({
  items,
  className,
  dense,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean; key?: string }[];
  className?: string;
  dense?: boolean;
}) {
  return (
    <dl className={cn("divide-y divide-border", className)}>
      {items.map((item, i) => (
        <div
          key={item.key ?? i}
          className={cn("flex items-baseline justify-between gap-4", dense ? "py-2" : "py-3")}
        >
          <dt className="min-w-0 text-xs text-muted-foreground">{item.label}</dt>
          <dd
            className={cn(
              "ds-num min-w-0 text-right text-sm text-foreground [overflow-wrap:anywhere]",
              item.mono && "font-mono text-xs",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

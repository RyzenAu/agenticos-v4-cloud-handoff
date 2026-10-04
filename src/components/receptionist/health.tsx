import { ExternalLink } from "lucide-react";
import { StatusDot, Surface } from "@/components/ds";
import type { HealthItem } from "@/lib/receptionist";
import { tone } from "./format";

export function HealthStrip({ items }: { items: HealthItem[] }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{items.map(item => {
    const needsAction = item.tone === "warn" || item.tone === "bad";
    const label = <span className="ds-label text-xs">{item.label}</span>;
    return <Surface key={item.id} padding="sm" className="min-w-0">
      <StatusDot tone={tone(item.tone)} label={item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">{label}<ExternalLink className="size-3" aria-hidden="true" /></a> : label} />
      <p className="mt-2 line-clamp-2 break-words text-sm font-medium" title={item.headline}>{item.headline}</p>
      {needsAction && <>
        <p className="mt-1 break-words text-xs text-muted-foreground">{item.detail}</p>
        {item.next && <p className="mt-2 break-words text-xs text-foreground"><span className={item.tone === "bad" ? "text-danger" : "text-warn"}>Next</span>: {item.next}</p>}
      </>}
    </Surface>;
  })}</div>;
}

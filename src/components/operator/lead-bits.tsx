// Small pieces shared by the Leads page, the lead drawer and the dashboard card.
import type { Phone } from "lucide-react";
import { Check } from "lucide-react";
import { Button } from "@/components/ds";
import { cn } from "@/lib/utils";

/** An audit finding, marked [verified] (seen on their own site) or [score-only] (a directory signal). */
export function ReasonChip({ text, verified }: { text: string; verified: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs leading-snug",
        verified ? "border-success/30 bg-success-soft text-foreground" : "border-border bg-inset text-muted-foreground",
      )}
      title={verified ? "Seen on the business's own site" : "Directory or score-only signal — not seen on their site"}
    >
      <span className="min-w-0 truncate">{text}</span>
      <span className={cn("shrink-0 font-mono text-xs", verified ? "text-success" : "text-muted-foreground")}>{verified ? "seen on their site" : "directory signal"}</span>
    </span>
  );
}

/** Google Places attribution, required wherever Places data shows without a Google map. The
 *  values themselves are fetched live and never stored (scripts/leads/places-live.ts). */
export function PlacesAttribution({ live }: { live: { attribution: string; fetchedAt: string | null; hours: string[]; error?: string } }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="places-attribution">
      {live.error
        ? <span>Live place details unavailable: {live.error}</span>
        : live.hours.length > 0 && <span>Hours: {live.hours.join(" · ")}</span>}
      <span>Place details from <span className="font-medium text-foreground">{live.attribution}</span>{live.error ? "" : ", loaded live and not stored"}</span>
    </div>
  );
}

/** One-tap copy for a phone number or email; shows a tick for a moment after copying. */
export function CopyButton({ value, label, icon: Icon, copied, onCopy }: { value: string; label: string; icon: typeof Phone; copied: boolean; onCopy: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? `${label} copied` : `Copy ${label}: ${value}`}
      title={copied ? "Copied" : `Copy ${value}`}
      onClick={(e) => { e.stopPropagation(); onCopy(); }}
    >
      {copied ? <Check className="text-success" /> : <Icon />}
    </Button>
  );
}


import { cn } from "@/lib/utils";

/**
 * Phone form of a navigation control (under 640px): a native select, so every option is visible and
 * reachable without sideways scrolling. The pill row takes over from 640px up; both drive the same state.
 */
export function PhoneSelect({ label, value, options, onChange, className }: { label: string; value: string; options: Array<{ value: string; text: string }>; onChange: (v: string) => void; className?: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("ds-interactive h-11 w-full rounded-full border border-border bg-inset px-4 text-sm font-medium text-foreground sm:hidden", className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.text}
        </option>
      ))}
    </select>
  );
}

/** A plain-text name for an option whose label is an element (icon + word): its id, tidied. */
export function optionText(label: unknown, id: string): string {
  if (typeof label === "string") return label;
  return id.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

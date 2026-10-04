import { cn } from "@/lib/utils";
import { PhoneSelect } from "./phone-select";

/**
 * Segmented control for a small, mutually exclusive choice (period, view).
 * Sentence case, 12px. The selected segment is a raised surface, not the
 * accent — the accent is reserved for the primary action.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const phoneSelect = options.length > 3;
  return (
    <>
    {phoneSelect && <PhoneSelect label={ariaLabel} value={value} onChange={(v) => onChange(v as T)} options={options.map((o) => ({ value: o.value, text: o.label }))} className={className} />}
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-inset p-1",
        phoneSelect ? "hidden sm:inline-flex" : "inline-flex",
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = options[(i + step + options.length) % options.length];
              onChange(next.value);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() =>
                (group?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus(),
              );
            }}
            className={cn(
              "ds-interactive h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-xs font-medium",
              selected
                ? "bg-surface-raised text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
    </>
  );
}

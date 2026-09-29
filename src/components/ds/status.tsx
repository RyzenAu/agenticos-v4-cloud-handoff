import type { ReactNode } from "react";
import { Badge as UiBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "accent" | "success" | "warn" | "danger" | "info";

/**
 * Small state chip. Soft wash + matching ink, 12px medium, sentence case, fully round.
 * Use for state ("Live", "Not connected", "Demo"), never for decoration.
 *
 * L10 (29 Sep 2026): only a real state is a pill (success, warn, danger, info). A neutral or accent
 * label is a tag, category or count, so it renders as plain muted text in the row, not a chip.
 */
export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const plain = tone === "neutral" || tone === "accent";
  return (
    <UiBadge
      variant={plain ? "plain" : tone}
      title={title}
      data-badge={plain ? "plain" : "state"}
      className={cn(
        plain ? "shrink-0 gap-1 whitespace-nowrap rounded-none py-0 text-2xs leading-none" : "h-6 shrink-0 gap-1 whitespace-nowrap rounded-full px-2.5 py-0 text-2xs leading-none",
        className,
      )}
    >
      {children}
    </UiBadge>
  );
}

const DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-brand",
  success: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
};

/**
 * A 6px dot with a text label. The label is required — colour alone never
 * carries state. `pulse` only while something is actively running.
 */
export function StatusDot({
  tone = "neutral",
  label,
  pulse,
  className,
}: {
  tone?: Tone;
  label: ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
        {pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              DOT[tone],
            )}
          />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", DOT[tone])} />
      </span>
      {label}
    </span>
  );
}

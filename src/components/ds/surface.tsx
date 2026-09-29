import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "inset" | "interactive" | "dashed";
type Padding = "none" | "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  // The one card recipe: card surface, 1px border, radius-2xl, elev-1.
  default: "bg-card text-card-foreground border border-border shadow-sm",
  // A well inside a card (rows, code, secondary groups). Never a card in a card.
  inset: "bg-inset border border-border",
  // Clickable card: border lifts on hover, focus ring from the system.
  interactive:
    "ds-interactive bg-card text-card-foreground border border-border shadow-sm hover:border-border-strong hover:bg-surface-raised cursor-pointer text-left",
  // Placeholder for something the user can add.
  dashed: "border border-dashed border-border-strong bg-transparent",
};
const PADDING: Record<Padding, string> = {
  none: "",
  sm: "p-4",
  md: "p-5 sm:p-6",
  lg: "p-6 sm:p-8",
};

/**
 * Card surface. Named Surface so it doesn't collide with shadcn's Card, which
 * stays available for dialogs and forms. Use `as` for semantics
 * (section/article/button/li).
 */
type SurfaceProps = React.HTMLAttributes<HTMLElement> & {
  variant?: Variant;
  padding?: Padding;
  as?: React.ElementType;
  type?: "button" | "submit";
  disabled?: boolean;
};

export const Surface = React.forwardRef<HTMLElement, SurfaceProps>(function Surface(
  { variant = "default", padding = "md", as, className, ...props },
  ref,
) {
  const Tag: React.ElementType = as ?? "div";
  return (
    <Tag
      ref={ref}
      className={cn("rounded-2xl", VARIANT[variant], PADDING[padding], className)}
      {...props}
    />
  );
});

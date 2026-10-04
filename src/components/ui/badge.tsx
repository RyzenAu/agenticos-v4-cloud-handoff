import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Design-system tones: a soft wash + matching ink. State only, never decoration.
        neutral: "border-border bg-inset text-muted-foreground font-medium",
        // L10 (29 Sep 2026): a label that is not a state reads as plain text, not a chip.
        plain: "border-transparent bg-transparent px-0 text-muted-foreground font-normal",
        accent: "border-transparent bg-brand-soft text-brand font-medium",
        success: "border-transparent bg-success-soft text-success font-medium",
        warn: "border-transparent bg-warn-soft text-warn font-medium",
        danger: "border-transparent bg-danger-soft text-danger font-medium",
        info: "border-transparent bg-info-soft text-info font-medium",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  // A span, not a div: badges sit inside sentences (<p>), and a div there is invalid HTML
  // that React reports as a hydration error (seen on /usage, 27 Sep 2026).
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

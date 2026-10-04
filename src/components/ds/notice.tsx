import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "warn" | "danger";

const STYLE: Record<Tone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "bg-info-soft", icon: "text-info", Icon: Info },
  success: { box: "bg-success-soft", icon: "text-success", Icon: CheckCircle2 },
  warn: { box: "bg-warn-soft", icon: "text-warn", Icon: AlertTriangle },
  danger: { box: "bg-danger-soft", icon: "text-danger", Icon: XCircle },
};

/**
 * Inline status message: stale data, a failed sync, a completed step.
 * Tinted wash, tone icon, body text in the normal foreground (the wash
 * carries the tone; the text stays legible). No coloured side-stripes.
 * Errors name the problem and the recovery.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  const s = STYLE[tone];
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn(
        "flex flex-col gap-3 rounded-2xl px-5 py-4 text-sm text-foreground sm:flex-row sm:items-center",
        s.box,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <s.Icon className={cn("mt-1 h-4 w-4 shrink-0", s.icon)} aria-hidden="true" />
        <div className="min-w-0">
          {title && <div className="font-medium">{title}</div>}
          {children && <div className={cn("leading-relaxed", title && "mt-1 text-sm text-foreground/85")}>{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">{action}</div>}
    </div>
  );
}

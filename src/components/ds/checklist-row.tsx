import type { HTMLAttributes, ReactNode } from "react";
import { Circle, CircleCheck, CircleDashed, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChecklistStatus = "met" | "not-met" | "unknown" | "info";

const STATUS: Record<ChecklistStatus, { Icon: typeof Circle; icon: string; word: string }> = {
  // Met: the one success mark. Not met: an open neutral circle, calm (the verdict carries the alarm).
  met: { Icon: CircleCheck, icon: "text-success", word: "Met" },
  "not-met": { Icon: Circle, icon: "text-muted-foreground", word: "Not met" },
  // Unknown: its source wasn't read. Never "Met"; dashed so it reads as "not known", not "no".
  unknown: { Icon: CircleDashed, icon: "text-warn", word: "Unknown" },
  info: { Icon: Info, icon: "text-muted-foreground", word: "Info" },
};

/**
 * One condition in a checklist: a status icon, the condition in words, an optional detail line, and
 * the status as a word on the right (state is never colour-only). Renders an <li>; put it in a <ul>.
 */
export function ChecklistRow({
  status,
  label,
  detail,
  statusText,
  statusTitle,
  className,
  ...rest
}: {
  status: ChecklistStatus;
  label: ReactNode;
  detail?: ReactNode;
  /** Overrides the status word ("Met", "Not met", "Unknown", "Info"). */
  statusText?: ReactNode;
  statusTitle?: string;
  className?: string;
} & Omit<HTMLAttributes<HTMLLIElement>, "children">) {
  const s = STATUS[status];
  return (
    <li className={cn("flex min-w-0 items-start gap-3 py-2.5", className)} data-status={status} {...rest}>
      <s.Icon aria-hidden="true" className={cn("mt-0.5 size-[18px] shrink-0", s.icon)} strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm leading-snug text-foreground">{label}</p>
        {detail && <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{detail}</p>}
      </div>
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground" title={statusTitle}>
        {statusText ?? s.word}
      </span>
    </li>
  );
}

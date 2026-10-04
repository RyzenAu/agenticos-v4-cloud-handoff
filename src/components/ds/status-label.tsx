import type { ReactNode } from "react";
import { AlertTriangle, Ban, Check, CheckCheck, Circle, CircleDashed, Clock, Hand, Loader2, Pause, Send, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * R11 shared system: ONE status vocabulary for every page. Each state has a fixed word, icon and colour, so "not sent yet",
 * "waiting", "failed" and "verified" can never be mistaken for each other, even in greyscale (the icon carries it too).
 *
 *   draft / unsent  hollow, dashed: nothing has left the OS yet
 *   pending         clock, amber: asked for, waiting on someone or something
 *   running         spinner (still under reduced motion), info blue: work is happening now
 *   needs-you       hand, amber: blocked on the owner
 *   sent / done     check, neutral-green: finished, not independently checked
 *   verified        double check, green: finished AND checked
 *   failed          cross, red: the ONLY red state
 *   blocked         triangle, amber: can't continue without a fix
 *   stopped / paused / unknown / idle   quiet grey
 *
 * Use `label` to change the word (keep it short, sentence case); the state still decides the look.
 */
export type StatusState =
  | "draft"
  | "unsent"
  | "pending"
  | "running"
  | "needs-you"
  | "sent"
  | "done"
  | "verified"
  | "failed"
  | "blocked"
  | "stopped"
  | "paused"
  | "unknown"
  | "idle";

type Look = { word: string; icon: typeof Check; ink: string; wash: string; ring?: string; spin?: boolean };

export const STATUS_LOOK: Record<StatusState, Look> = {
  draft: { word: "Draft", icon: CircleDashed, ink: "text-muted-foreground", wash: "bg-transparent", ring: "border border-dashed border-border-strong" },
  unsent: { word: "Not sent", icon: CircleDashed, ink: "text-muted-foreground", wash: "bg-transparent", ring: "border border-dashed border-border-strong" },
  pending: { word: "Waiting", icon: Clock, ink: "text-warn", wash: "bg-warn-soft" },
  running: { word: "Running", icon: Loader2, ink: "text-info", wash: "bg-info-soft", spin: true },
  "needs-you": { word: "Needs you", icon: Hand, ink: "text-warn", wash: "bg-warn-soft" },
  sent: { word: "Sent", icon: Send, ink: "text-foreground", wash: "bg-surface-raised" },
  done: { word: "Done", icon: Check, ink: "text-success", wash: "bg-surface-raised" },
  verified: { word: "Verified", icon: CheckCheck, ink: "text-success", wash: "bg-success-soft" },
  failed: { word: "Failed", icon: XCircle, ink: "text-danger", wash: "bg-danger-soft" },
  blocked: { word: "Blocked", icon: AlertTriangle, ink: "text-warn", wash: "bg-warn-soft" },
  stopped: { word: "Stopped", icon: Ban, ink: "text-muted-foreground", wash: "bg-surface-raised" },
  paused: { word: "Paused", icon: Pause, ink: "text-muted-foreground", wash: "bg-surface-raised" },
  unknown: { word: "Unknown", icon: Circle, ink: "text-muted-foreground", wash: "bg-surface-raised" },
  idle: { word: "Idle", icon: Circle, ink: "text-muted-foreground", wash: "bg-transparent" },
};

export function StatusLabel({
  state,
  label,
  size = "md",
  bare = false,
  title,
  className,
  "data-testid": testId,
}: {
  state: StatusState;
  /** Override the word; the state still decides colour and icon. */
  label?: ReactNode;
  size?: "sm" | "md";
  /** Icon + word without the pill (inside dense table cells). */
  bare?: boolean;
  title?: string;
  className?: string;
  "data-testid"?: string;
}) {
  const look = STATUS_LOOK[state];
  const Icon = look.icon;
  return (
    <span
      data-status={state}
      title={title}
      {...(testId ? { "data-testid": testId } : {})}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium leading-none",
        size === "sm" ? "text-2xs" : "text-xs",
        bare ? look.ink : cn("rounded-full", size === "sm" ? "h-6 px-2" : "h-7 px-2.5", look.wash, look.ring, look.ink),
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn(size === "sm" ? "size-3" : "size-3.5", look.spin && "animate-spin [animation-duration:1.6s] motion-reduce:animate-none")} />
      <span>{label ?? look.word}</span>
    </span>
  );
}

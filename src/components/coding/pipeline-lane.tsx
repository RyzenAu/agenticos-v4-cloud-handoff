// The coding pipeline as a lane of six round steps (W-B, 29 Sep 2026). Full: a stepper with each step's
// state in words (horizontal from md up, vertical on phones so nothing scrolls sideways). Compact: six
// dots and the current step named, for job cards. State is never colour-only: every step carries a word.
import { Check, CircleDot, Hand, Pause, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PIPELINE, stepStatusWord, type PipelineStep, type StepStatus } from "@/lib/coding-pipeline";

const MARK: Record<StepStatus, { ring: string; icon: ReactNode | null }> = {
  done: { ring: "bg-success-soft text-success border-transparent", icon: <Check className="size-4" strokeWidth={2.25} aria-hidden="true" /> },
  current: { ring: "bg-brand-soft text-brand border-brand", icon: <CircleDot className="size-4 motion-safe:animate-pulse" aria-hidden="true" /> },
  you: { ring: "bg-warn-soft text-warn border-transparent", icon: <Hand className="size-4" aria-hidden="true" /> },
  blocked: { ring: "bg-warn-soft text-warn border-transparent", icon: <Pause className="size-4" aria-hidden="true" /> },
  failed: { ring: "bg-danger-soft text-danger border-transparent", icon: <X className="size-4" strokeWidth={2.25} aria-hidden="true" /> },
  todo: { ring: "bg-transparent text-muted-foreground border-dashed border-border-strong", icon: null },
  optional: { ring: "bg-inset text-muted-foreground border-border", icon: null },
};

function Mark({ status, n, size = "md" }: { status: StepStatus; n: number; size?: "sm" | "md" }) {
  const m = MARK[status];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full border ds-num font-semibold",
        size === "md" ? "size-9 text-sm" : "size-5 text-[11px]",
        m.ring,
      )}
    >
      {size === "md" ? (m.icon ?? n) : null}
    </span>
  );
}

/** The six steps with their states. `steps` omitted = the teaching version (every step "not yet"). */
export function PipelineLane({ steps, className, ariaLabel = "Coding pipeline" }: { steps?: readonly PipelineStep[]; className?: string; ariaLabel?: string }) {
  const rows: PipelineStep[] = steps ? [...steps] : PIPELINE.map((p) => ({ ...p, status: "todo" as const, detail: p.what }));
  return (
    <ol aria-label={ariaLabel} className={cn("grid grid-cols-1 gap-0 md:grid-cols-6 md:gap-3", className)} data-pipeline>
      {rows.map((s, i) => (
        <li key={s.id} data-step={s.id} data-status={s.status} className="relative flex min-w-0 gap-3 pb-5 md:flex-col md:gap-2.5 md:pb-0">
          {/* connector: down the left on phones, across the top from md up */}
          {i < rows.length - 1 && (
            <span aria-hidden="true" className={cn("absolute left-[17px] top-9 h-[calc(100%-2.25rem)] w-px md:left-9 md:right-[-0.75rem] md:top-[17px] md:h-px md:w-auto", s.status === "done" ? "bg-success/40" : "bg-border")} />
          )}
          <Mark status={s.status} n={i + 1} />
          <div className="min-w-0 pt-1 md:pt-0">
            <p className="text-sm font-medium leading-snug text-foreground">{s.label}</p>
            {steps && <p className="mt-0.5 text-xs font-medium text-muted-foreground">{stepStatusWord(s.status)}</p>}
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Six dots and the step that matters now, for a job card. */
export function PipelineDots({ steps }: { steps: readonly PipelineStep[] }) {
  const focus = steps.find((s) => s.status !== "done" && s.status !== "todo") ?? [...steps].reverse().find((s) => s.status === "done") ?? steps[0];
  const summary = steps.map((s) => `${s.label}: ${stepStatusWord(s.status)}`).join(", ");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <span role="img" aria-label={summary} className="inline-flex items-center gap-1">
        {steps.map((s, i) => (
          <span key={s.id} className="inline-flex items-center gap-1">
            <Mark status={s.status} n={i + 1} size="sm" />
            {i < steps.length - 1 && <span aria-hidden="true" className={cn("h-px w-2.5", s.status === "done" ? "bg-success/50" : "bg-border")} />}
          </span>
        ))}
      </span>
      <span className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{focus.label}</span> · {focus.detail}
      </span>
    </div>
  );
}

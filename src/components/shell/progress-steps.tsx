// Motion that explains progress (NEXUS-ADDENDUM item 4). A step list whose steps move ONLY when their
// confirming event arrives (src/lib/progress-steps.ts). A step already done when the list mounts is drawn
// done, without animation (history isn't news); a step that becomes done while you watch gets one brief
// gold fill (240 ms, interruptible, none under reduced motion). No events → a static list with states.
import { useEffect, useRef } from "react";
import { Check, CircleDashed, X } from "lucide-react";
import type { StepView } from "@/lib/progress-steps";
import { cn } from "@/lib/utils";
import { fmtTime } from "@/lib/format";

const WORD = { pending: "Waiting", active: "In progress", done: "Confirmed", failed: "Failed" } as const;

/**
 * `compact` (L2, 29 Sep): the step word only; what a waiting step needs moves to the hover title, so
 * the reading path carries no sentence-long small print.
 */
export function ProgressSteps({ steps, label, className, compact = false }: { steps: readonly StepView[]; label: string; className?: string; compact?: boolean }) {
  const seen = useRef<Map<string, string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current) for (const s of steps) if (s.state === "done" && seen.current.get(s.key) !== "done") fresh.add(s.key);
  useEffect(() => {
    seen.current = new Map(steps.map((s) => [s.key, s.state]));
  });
  return (
    <ol className={cn("ps-list", className)} aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.key} className="ps-step" data-state={s.state} data-fresh={fresh.has(s.key) || undefined} title={compact && s.state === "pending" ? `Needs: ${s.proof}` : undefined}>
          <span className="ps-dot" aria-hidden="true">
            {s.state === "done" ? <Check size={12} strokeWidth={2.5} /> : s.state === "failed" ? <X size={12} strokeWidth={2.5} /> : s.state === "active" ? <CircleDashed size={12} /> : <span className="ps-num">{i + 1}</span>}
          </span>
          <span className="min-w-0">
            <span className="ps-label">{s.label}</span>
            <span className="ps-meta">
              {WORD[s.state]}
              {s.at ? ` · ${fmtTime(new Date(s.at), { seconds: true })}` : ""}
              {compact ? "" : s.source ? ` · ${s.source}` : s.state === "pending" ? ` · needs: ${s.proof}` : ""}
            </span>
          </span>
          {i < steps.length - 1 && <span className="ps-rail" data-filled={s.state === "done" || undefined} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

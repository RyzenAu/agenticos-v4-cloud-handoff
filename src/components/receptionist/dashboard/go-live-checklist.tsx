import type { ReactNode } from "react";
import { Circle, CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { Badge, Disclosure, InfoTip, Section } from "@/components/ds";
import type { ChecklistStepStatus, DashboardViewModel } from "@/lib/receptionist-dashboard";
import { cn } from "@/lib/utils";
import { CHECKLIST_STATUS_LABEL, CHECKLIST_STATUS_TONE } from "./shared";

const ICON: Record<string, ReactNode> = {
  verified: <CircleCheck className="size-[18px] text-success" strokeWidth={1.75} />,
  "in-progress": <CircleDot className="size-[18px] text-warn" strokeWidth={1.75} />,
  "not-started": <Circle className="size-[18px] text-muted-foreground" strokeWidth={1.75} />,
  unknown: <CircleDashed className="size-[18px] text-muted-foreground" strokeWidth={1.75} />,
};
const WORD: Record<string, string> = { success: "text-success", warn: "text-warn", danger: "text-danger", neutral: "text-muted-foreground" };

function Row({ step }: { step: ChecklistStepStatus }) {
  return (
    <li className="py-0.5" data-step={step.id} data-status={step.status}>
      <Disclosure
        icon={ICON[step.status] ?? ICON.unknown}
        summary={<><span className="ds-num mr-2 text-xs text-muted-foreground">{step.step}</span>{" "}{step.title}</>}
        meta={
          <span className="inline-flex items-center gap-2">
            {step.ownerYesNeeded && <Badge tone="neutral" title="Needs the owner's explicit yes">Owner yes</Badge>}
            <span className={cn(WORD[CHECKLIST_STATUS_TONE[step.status]] ?? "text-muted-foreground")}>{CHECKLIST_STATUS_LABEL[step.status]}</span>
          </span>
        }
      >
        <div className="space-y-1.5 pl-8 text-xs leading-relaxed text-muted-foreground">
          {step.evidence.map((line, i) => <p key={i}>{line}</p>)}
          <p><span className="text-foreground">Rollback:</span> {step.rollback}</p>
        </div>
      </Disclosure>
    </li>
  );
}

/** Reads GO_LIVE_STEPS (scripts/receptionist/checklist.ts) as data — mirrors the checklist doc's
 *  step numbering and wording; nothing here is "done" unless the feed proved it. */
export function GoLiveChecklist({ data }: { data: DashboardViewModel }) {
  const verified = data.goLive.steps.filter((s) => s.status === "verified").length;
  return (
    <Section
      title="Go-live checklist"
      actions={<>
        <span className="ds-num text-sm text-muted-foreground">{verified}/{data.goLive.steps.length} verified</span>
        <InfoTip label="About the checklist">{`${verified} of ${data.goLive.steps.length} steps verified from feed evidence. Informational: owner console steps the feed can't see stay "Unknown". Whether it's safe to sell comes from MU-Receptionist's enforced go-live verdict, which records the per-client tests.`}</InfoTip>
      </>}
    >
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card p-2 shadow-sm">{data.goLive.steps.map((s) => <Row key={s.id} step={s} />)}</ul>
    </Section>
  );
}

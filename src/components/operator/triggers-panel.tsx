// Triggers and routines, listed on the Automations page (scripts/triggers). An app event or a schedule
// creates a deduplicated durable job; this panel shows each trigger's state, its last delivery, the jobs it
// created and the controls: pause, resume, disable and a manual retry of a failed delivery.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Pause, Play, RotateCw, Webhook } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { Button } from "@/components/ui/button";
import { Disclosure, Widget, WidgetGrid, type WidgetTone } from "@/components/ds";
import { Notice } from "./ui";
import { fmtDateTime } from "@/lib/format";

export type TriggerHealth = "active" | "paused" | "disabled" | "failing";
export type DeliveryStatus = "queued" | "running" | "awaiting-approval" | "succeeded" | "retrying" | "failed" | "unknown" | "rejected" | "ignored";
export type TriggerDelivery = {
  id: number;
  status: DeliveryStatus;
  reason: string | null;
  attempts: number;
  repeats: number;
  receivedAt: string;
  jobId: string | null;
  jobs: { attempt: number; jobId: string }[];
};
export type TriggerRow = {
  id: string;
  name: string;
  kind: "event" | "routine";
  source: string;
  action: string;
  mode: "draft" | "review";
  state: "active" | "paused" | "disabled";
  health: TriggerHealth;
  retryLimit: number;
  offlinePolicy?: "skip" | "run-once" | "review";
  schedule?: { kind: "daily"; at: string; tz: string } | { kind: "interval"; everyMinutes: number };
  stats: { delivered: number; duplicates: number; ignored: number; failed: number; pending: number };
  lastDelivery: TriggerDelivery | null;
  lastRun: { slot: string; outcome: string; jobId: string | null; at: string; missed: number } | null;
  nextRunAt: string | null;
};

export const HEALTH_WORD: Record<TriggerHealth, string> = { active: "Active", paused: "Paused", disabled: "Disabled", failing: "Failing" };
const HEALTH_TONE: Record<TriggerHealth, WidgetTone> = { active: "default", paused: "muted", disabled: "muted", failing: "danger" };

const DELIVERY_WORD: Record<DeliveryStatus, string> = {
  queued: "waiting to start",
  running: "running",
  "awaiting-approval": "waiting for your approval",
  succeeded: "done",
  retrying: "failed, will retry",
  failed: "failed, needs you",
  unknown: "outcome unknown, needs you",
  rejected: "not approved",
  ignored: "ignored",
};
const REASON_WORD: Record<string, string> = {
  "self-output": "caused by our own work",
  "agent-actor": "caused by an agent",
  "action-failed": "the action failed",
  interrupted: "interrupted by a restart",
  "outcome-unknown": "it may have happened",
  "approved-not-sent": "approved; nothing is sent in this build",
  "approval-rejected": "you turned it down",
  "approval-expired": "the approval expired",
};
const OFFLINE_WORD = { skip: "skips it", "run-once": "runs it once on return", review: "asks you first" } as const;
const OUTCOME_WORD: Record<string, string> = {
  ran: "ran on time",
  "skipped-offline": "skipped (PC was off)",
  "ran-on-return": "ran late, once, after the PC was off",
  coalesced: "merged into a later run",
  "review-requested": "asked for your review (PC was off)",
};

/** One plain line about the last delivery. Pure. */
export function deliveryLine(d: TriggerDelivery | null): string {
  if (!d) return "No events yet.";
  const reason = d.reason ? REASON_WORD[d.reason] ?? d.reason : "";
  return `Last event ${fmtDateTime(new Date(d.receivedAt))}: ${DELIVERY_WORD[d.status]}${reason ? ` (${reason})` : ""}.`;
}
/** What a routine does when the PC was off at its time, and when it last ran. Pure. */
export function routineLine(t: Pick<TriggerRow, "offlinePolicy" | "lastRun" | "nextRunAt">): string {
  const policy = t.offlinePolicy ? `If the PC is off at the time it ${OFFLINE_WORD[t.offlinePolicy]}.` : "";
  const last = t.lastRun ? ` Last: ${OUTCOME_WORD[t.lastRun.outcome] ?? t.lastRun.outcome}.` : "";
  return `${policy}${last}`.trim();
}
export function canRetry(d: TriggerDelivery | null): boolean {
  return d !== null && ["failed", "unknown", "retrying"].includes(d.status);
}
export function sourceText(t: Pick<TriggerRow, "kind" | "source" | "schedule">): string {
  if (t.kind === "routine" && t.schedule) return t.schedule.kind === "daily" ? `Every day at ${t.schedule.at} (${t.schedule.tz.split("/").pop()?.replace(/_/g, " ")})` : `Every ${t.schedule.everyMinutes} minutes`;
  return ({ "synthetic.enquiry": "A new enquiry (test source)", "receptionist.flag": "A receptionist QA flag (read-only)" } as Record<string, string>)[t.source] ?? t.source;
}

export function TriggersPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const query = useQuery<{ triggers: TriggerRow[] }>({
    queryKey: ["triggers"],
    queryFn: () => operatorRequest<{ triggers: TriggerRow[] }>("/triggers", undefined, "GET"),
    refetchInterval: 15_000,
    retry: 0,
  });

  async function act(path: string, body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    try {
      await operatorRequest(`/triggers/${path}`, body, "POST");
      await qc.invalidateQueries({ queryKey: ["triggers"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const triggers = query.data?.triggers ?? [];
  // Nothing to show until there is a trigger: a loading or failed read leaves the page exactly as it was.
  if (!triggers.length) return null;

  return (
    <section className="mt-10" aria-labelledby="triggers-title" data-testid="triggers-panel">
      <h2 id="triggers-title" className="mb-1 text-lg font-semibold text-foreground">
        Triggers and routines
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">An event or a schedule creates one job, once, with the same approvals as everything else. Nothing here sends a message.</p>
      {error && <Notice error>{error}</Notice>}
      <WidgetGrid aria-label="Triggers and routines">
        {triggers.map((t) => {
          const key = t.id;
          const working = busy === key;
          const Icon = t.kind === "routine" ? CalendarClock : Webhook;
          return (
            <Widget
              key={t.id}
              icon={Icon}
              title={t.name}
              badge={t.health === "active" ? undefined : HEALTH_WORD[t.health]}
              value={t.stats.delivered}
              line={t.stats.delivered === 1 ? "job created" : "jobs created"}
              tone={HEALTH_TONE[t.health]}
              data-trigger={t.id}
              data-state={t.health}
              action={
                <>
                  {t.state === "active" ? (
                    <Button variant="ghost" size="sm" className="h-9 rounded-full px-3" disabled={busy !== null} onClick={() => void act("pause", { id: t.id }, key)}>
                      {working ? <Loader2 size={15} className="animate-spin" /> : <Pause size={15} />} Pause
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={busy !== null} onClick={() => void act("resume", { id: t.id }, key)}>
                      {working ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {t.state === "disabled" ? "Enable" : "Resume"}
                    </Button>
                  )}
                  {t.state !== "disabled" && (
                    <Button variant="ghost" size="sm" className="h-9 rounded-full px-3" disabled={busy !== null} onClick={() => void act("disable", { id: t.id }, key)}>
                      Disable
                    </Button>
                  )}
                  {t.lastDelivery && canRetry(t.lastDelivery) && (
                    <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={busy !== null} onClick={() => void act("retry", { deliveryId: t.lastDelivery!.id }, key)}>
                      <RotateCw size={15} /> Retry
                    </Button>
                  )}
                </>
              }
            >
              <p className="text-sm leading-snug text-muted-foreground">
                {sourceText(t)}. {t.mode === "review" ? "Each job waits for your approval first." : "Drafts only; anything outgoing needs your approval."}
              </p>
              <p className="mt-2 text-sm text-foreground" data-testid="trigger-last">
                {t.kind === "routine" ? routineLine(t) || "Hasn't run yet." : deliveryLine(t.lastDelivery)}
                {t.kind === "routine" && t.nextRunAt ? ` Next: ${fmtDateTime(new Date(t.nextRunAt))}.` : ""}
              </p>
              <Disclosure className="mt-2 -mb-2" triggerClassName="-mx-3" summary={<span className="text-muted-foreground">Details</span>}>
                <dl className="grid grid-cols-1 gap-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Counts</dt>
                    <dd className="text-foreground">
                      {t.stats.delivered} jobs · {t.stats.duplicates} repeat deliveries merged · {t.stats.ignored} ignored as our own work · {t.stats.failed} failing · {t.stats.pending} open
                    </dd>
                  </div>
                  {t.lastDelivery && t.lastDelivery.jobs.length > 0 && (
                    <div>
                      <dt className="text-muted-foreground">Linked jobs</dt>
                      <dd className="text-foreground">
                        {t.lastDelivery.jobs.map((j) => (
                          <span key={j.jobId} className="mr-2 font-mono text-sm">
                            {`#${j.attempt} ${j.jobId.slice(0, 8)}`}
                          </span>
                        ))}
                        <Link to="/activity" className="underline">
                          See them in Activity
                        </Link>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-muted-foreground">Retries</dt>
                    <dd className="text-foreground">Up to {t.retryLimit} automatic attempts, then it shows as failing until you retry it.</dd>
                  </div>
                </dl>
              </Disclosure>
            </Widget>
          );
        })}
      </WidgetGrid>
    </section>
  );
}

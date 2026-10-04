import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Disclosure, EmptyState, Notice } from "@/components/ds";
import { crmErrorMessage, crmOperation } from "@/lib/crm-client";
import { fmtDateTime } from "@/lib/format";
import type { AutomationRule } from "../../../scripts/crm/automation";
const labels: Record<AutomationRule["id"], string> = {
  "enquiry.received": "New enquiry",
  "reply.received": "Reply received",
  "meeting.completed": "Meeting completed",
  "proposal.inactive": "Inactive proposal",
  "deal.won": "Deal won",
  "renewal.approaching": "Renewal approaching",
};
/** Uses the existing durable event adapter. An enabled rule is not proof that a source is connected. */
export function AutomationRules() {
  const query = useQuery({
    queryKey: ["crm", "automation-rules"],
    queryFn: () => crmOperation<AutomationRule[]>("crm.automations.list", {}),
  });
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  async function toggle(rule: AutomationRule) {
    if (busy) return;
    setBusy(rule.id);
    setError(null);
    try {
      await crmOperation("crm.automations.configure", { id: rule.id, enabled: !rule.enabled });
      await query.refetch();
    } catch (error) {
      setError(crmErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Disclosure
      summary="Event rules and connection requirements"
      className="mt-3 rounded-2xl border border-border"
      meta="Internal CRM actions"
    >
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading rules…
          </p>
        ) : query.isError ? (
          <Notice
            tone="warn"
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry
              </Button>
            }
          >
            Event rule status could not be loaded.
          </Notice>
        ) : !query.data?.data?.length ? (
          <EmptyState
            variant="row"
            title="Event adapter not connected"
            body={
              query.data?.text ||
              "Connect CRM events to the existing durable Jobs service before rules can run."
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {query.data.data.map((rule) => (
              <div key={rule.id} className="py-4 first:pt-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{labels[rule.id]}</h3>
                    <p className="mt-1 text-sm">{rule.action}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    aria-label={`${rule.enabled ? "Pause" : "Enable"} ${labels[rule.id]} rule`}
                    onClick={() => void toggle(rule)}
                  >
                    {busy === rule.id ? "Saving…" : rule.enabled ? "Pause" : "Enable"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {rule.enabled ? "Enabled" : "Paused"} · {rule.sourceRequirement}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {rule.lastRunAt
                    ? `Last run ${fmtDateTime(rule.lastRunAt)} · ${rule.lastOutcome || "Outcome not reported"}`
                    : "No run recorded"}
                </p>
                {rule.lastError && <p className="mt-2 text-sm text-warn">{rule.lastError}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Disclosure>
  );
}

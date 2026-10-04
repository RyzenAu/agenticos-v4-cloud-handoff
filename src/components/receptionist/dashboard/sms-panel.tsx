import { Badge, InfoTip, Section } from "@/components/ds";
import type { DashboardViewModel } from "@/lib/receptionist-dashboard";
import { BlockState } from "./shared";

/** SMS channel status. The agency feed contract carries only `readiness.smsEnabled` per client —
 *  delivery, consent and STOP counts are not yet part of it, so this panel says so plainly rather
 *  than showing invented zeros for numbers nobody has measured. */
export function SmsPanel({ data }: { data: DashboardViewModel }) {
  const rows = data.clients.ok ? data.clients.rows : [];
  return (
    <Section title="SMS" actions={<InfoTip label="About this section">Confirmation/reminder delivery, consent and STOP status.</InfoTip>}>
      <BlockState block={data.sms} render={(sms) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={sms.anyEnabled ? "success" : "neutral"}>{sms.anyEnabled ? "SMS live for at least one client" : "SMS off for every client"}</Badge>
          </div>
          <p className="max-w-[70ch] text-xs text-muted-foreground">{sms.reason}</p>
          {rows.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {rows.map((r) => (
                <li key={r.organizationId} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-foreground">{r.name ?? r.slug ?? r.organizationId}</span>
                  <Badge tone={r.sms.enabled ? "success" : "neutral"}>{r.sms.enabled ? "Enabled" : "Off"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )} />
    </Section>
  );
}

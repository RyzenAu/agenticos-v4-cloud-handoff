import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge, InfoTip, Section, Surface } from "@/components/ds";
import type { ClientRow, DashboardViewModel } from "@/lib/receptionist-dashboard";
import { cn } from "@/lib/utils";
import { aud, BlockState, CLIENTS_SECTION_ID } from "./shared";

const ONBOARDING_TONE: Record<ClientRow["onboardingStatus"], "neutral" | "warn" | "danger" | "success"> = {
  unassigned: "neutral",
  "not-connected": "danger",
  "sandbox-only": "warn",
  live: "success",
};
const ONBOARDING_LABEL: Record<ClientRow["onboardingStatus"], string> = {
  unassigned: "No package assigned",
  "not-connected": "Agent/number not connected",
  "sandbox-only": "Sandbox only",
  live: "Live",
};

/** "REAL_ESTATE" → "Real estate": the feed's niche enum, in words (F2 RX-11: never the raw enum). */
export function nicheLabel(niche: string | null): string {
  if (!niche?.trim()) return "—";
  const words = niche.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A count the feed may not have reported: "Unknown", never a fabricated 0 (RX-2). */
const n = (v: number | null) => (v === null ? "unknown" : String(v));

function ClientDetail({ row }: { row: ClientRow }) {
  return (
    <div className="grid gap-4 border-t border-border bg-inset px-4 py-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="ds-label text-2xs">Calendar</p>
        <p className="mt-1 text-foreground">{row.calendar.connected ? "Connected" : "Not live"} · {row.calendar.provider ?? "—"}</p>
        {row.calendar.reason && <p className="text-muted-foreground">{row.calendar.reason}</p>}
      </div>
      <div>
        <p className="ds-label text-2xs">Bookings</p>
        {row.bookings ? <>
          <p className="mt-1 text-foreground">{n(row.bookings.confirmed)} confirmed · {n(row.bookings.cancelled)} cancelled · {n(row.bookings.failed)} failed</p>
          <p className="text-muted-foreground">{row.bookings.madeOnCalls} made on calls · {row.bookings.sandbox} sandbox · {row.bookings.upcoming} upcoming</p>
        </> : <p className="mt-1 text-muted-foreground">Unknown: not reported by the feed</p>}
      </div>
      <div>
        <p className="ds-label text-2xs">Transfers &amp; handoffs</p>
        {row.transfers ? <p className="mt-1 text-foreground">{row.transfers.confirmed} / {row.transfers.attempted} transfers confirmed</p> : <p className="mt-1 text-muted-foreground">Transfers unknown: not reported by the feed</p>}
        {row.handoffs ? <p className="text-muted-foreground">{n(row.handoffs.pendingAlerts)} pending · {n(row.handoffs.failedAlerts)} failed alerts · {n(row.handoffs.callbackRequests)} callback requests</p> : <p className="text-muted-foreground">Alerts unknown: not reported by the feed</p>}
      </div>
      <div>
        <p className="ds-label text-2xs">Cost &amp; margin</p>
        <p className="mt-1 text-foreground">Est. cost {row.costs.estimatedMonthlyCents === null ? "unknown" : aud(row.costs.estimatedMonthlyCents)} · Est. margin {row.commercial.marginCents === null ? "unknown" : aud(row.commercial.marginCents)}</p>
        <p className="text-muted-foreground">{row.costs.reason ?? row.commercial.caveat}</p>
      </div>
    </div>
  );
}

function Minutes({ row }: { row: ClientRow }) {
  const { usedThisMonth: used, includedPerMonth: included, overageMinutes: overage } = row.minutes;
  if (used === null) return <span className="text-muted-foreground" title="The feed didn't report this month's minutes">Unknown{included !== null ? ` / ${included}` : ""}</span>;
  return (
    <>
      {used}{included !== null ? ` / ${included}` : ""}
      {overage !== null && overage > 0 && <span className="ml-1 text-warn" title="Billable minutes over the included allowance">+{overage}</span>}
    </>
  );
}

function ClientTableRow({ row }: { row: ClientRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border last:border-0">
        <td className="max-w-0 min-w-[10rem] truncate px-3 py-2.5 text-sm text-foreground">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left">
            <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
            <span className="truncate" title={row.name ?? row.slug ?? row.organizationId}>{row.name ?? row.slug ?? row.organizationId}</span>
            {row.isDemoTenant && <Badge tone="accent">Demo</Badge>}
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{nicheLabel(row.niche)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-foreground">{row.packageName ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2.5"><Badge tone={ONBOARDING_TONE[row.onboardingStatus]}>{ONBOARDING_LABEL[row.onboardingStatus]}</Badge></td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs ds-num text-foreground"><Minutes row={row} /></td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs ds-num text-foreground">{row.bookings?.confirmed ?? <span className="text-muted-foreground" title="The feed didn't report this client's bookings">Unknown</span>}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs ds-num text-foreground">{aud(row.commercial.mrrCents)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs ds-num text-foreground">{row.packageId && row.commercial.marginCents === null ? <span className="text-muted-foreground" title={row.commercial.caveat}>Unknown</span> : aud(row.commercial.marginCents)}</td>
      </tr>
      {open && <tr><td colSpan={8} className="p-0"><ClientDetail row={row} /></td></tr>}
    </>
  );
}

export function ClientsTable({ data }: { data: DashboardViewModel }) {
  const unassigned = data.clients.ok ? data.clients.rows.filter((r) => !r.packageId).length : 0;
  return (
    <div id={CLIENTS_SECTION_ID} className="scroll-mt-4">
      <Section title="Clients" actions={<InfoTip label="About this section">Niche, package, onboarding status, connected calendar — one row per organisation the feed serves.</InfoTip>}>
        {unassigned > 0 && (
          // Where "Assign each client a package" leads (RX-9): the assignment is M&U's own record.
          <p className="mb-3 flex items-center gap-1 text-sm text-warn">
            {unassigned} {unassigned === 1 ? "client has" : "clients have"} no package
            <InfoTip label="How to assign a package" align="start">
              Allowance, overage, cost, margin and support stay unknown until then. Assign each client Essential, Professional or Premium in <code className="text-2xs">.operator-data/receptionist-client-packages.json</code> (keyed by client slug).
            </InfoTip>
          </p>
        )}
        <BlockState block={data.clients} render={({ rows }) => rows.length === 0
          ? <p className="text-sm text-muted-foreground">No clients in the feed yet.</p>
          : (
            <Surface padding="none" className="overflow-x-auto">
              {/* overflow-wrap normal: words never break mid-word; the table scrolls sideways at 390 (RX-11). */}
              <table className="w-full min-w-[52rem] text-left [overflow-wrap:normal] [word-break:normal]">
                <thead>
                  <tr className="border-b border-border">
                    {["Client", "Niche", "Package", "Status", "Minutes", "Bookings", "MRR", "Est. margin"].map((h, i) => (
                      <th key={h} className={cn("ds-label whitespace-nowrap px-3 py-2 text-2xs", i >= 4 && "text-right")}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>{rows.map((row) => <ClientTableRow key={row.organizationId} row={row} />)}</tbody>
              </table>
            </Surface>
          )}
        />
      </Section>
    </div>
  );
}

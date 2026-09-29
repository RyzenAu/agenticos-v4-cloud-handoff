import { InfoTip, Section } from "@/components/ds";
import { catalogueLabels } from "@/lib/price-status";
import type { DashboardViewModel } from "@/lib/receptionist-dashboard";
import { CLIENT_UNREPORTED_HINT, NOT_ATTRIBUTED_HINT } from "../../../../scripts/receptionist/dashboard";
import type { SellSource } from "./sell-exceptions";
import { aud, BlockState, DashTile } from "./shared";
import { asOfText } from "./economics-by-basis";

/** Each tile names its own basis's source, date and scope: the three are never one figure. */
const basisHint = (b: { source: string; asOf: string | null; note: string }) => `${b.note} Source: ${b.source}, as of ${asOfText(b.asOf)}.`;

const NOT_REPORTED = "The feed didn't report this month's minutes";

/**
 * The measured Retell sample from the sell status (the same figure the cost-reconciliation gate
 * shows), so "measured" means one thing on the page (RX-12). Null when nothing was measured.
 */
export function measuredSample(sell: SellSource | undefined): { perMinuteAud: number; calls: number; minutes: number } | null {
  const e = sell?.data?.commercial.economics;
  if (!e || e.retellAudPerMinute === null) return null;
  return { perMinuteAud: e.retellAudPerMinute, calls: e.measuredCalls, minutes: e.measuredMinutes };
}

export function UsageAndEconomics({ data, sell }: { data: DashboardViewModel; sell?: SellSource }) {
  const sample = measuredSample(sell);
  // "Assign a package" is the recovery only when a client actually lacks one (RX-9).
  const packageCause = data.commercial.ok && data.commercial.unassignedClients > 0 ? ("unassigned-package" as const) : undefined;
  return (
    <Section title="Usage &amp; economics" actions={<InfoTip label="About this section">Minutes included/used/overage, provider cost on three separate bases (estimated, measured, reconciled), MRR/setup fees and support workload. Prices come only from the catalogue (receptionist-packages.ts); estimates from business-economics.ts.</InfoTip>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Minutes this month</h3>
          <BlockState block={data.usage} render={(u) => {
            const unattributed = u.attribution === "not-attributed";
            const unreported = u.attribution === "client-unreported";
            // Overage is unknown while a client has no package (no allowance): the recovery is to
            // assign one, not to retry (RX-3, RX-9). A client that didn't report: no retry either.
            const unassigned = !unattributed && u.unassignedClients > 0;
            return (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <DashTile label="Used" block={data.usage} value={u.usedTotal} display={u.usedTotal === null ? undefined : Math.round(u.usedTotal).toLocaleString("en-AU")} lowerBound={u.usedIsLowerBound} unknownHint={unattributed ? NOT_ATTRIBUTED_HINT : unreported ? CLIENT_UNREPORTED_HINT : NOT_REPORTED} unknownNeedsSetup={unreported} />
                <DashTile label="Included" block={data.usage} value={u.includedTotal} unknownNeedsSetup={!unattributed} unknownHint={unattributed ? NOT_ATTRIBUTED_HINT : "One or more clients have no package assigned: assign it in client-packages.json"} unknownCause={unassigned ? "unassigned-package" : undefined} />
                <DashTile label="Overage" block={data.usage} value={u.overageMinutesTotal} tone={(u.overageMinutesTotal ?? 0) > 0 ? "warn" : undefined} unknownNeedsSetup={!unattributed} unknownHint={unattributed ? NOT_ATTRIBUTED_HINT : unassigned ? "Unknown until every client has a package (no allowance to compare against)" : "A client with no package, or unreported usage, has no known overage"} unknownCause={unassigned ? "unassigned-package" : undefined} />
              </div>
            );
          }} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Provider cost / month</h3>
          <BlockState block={data.economics} render={(e) => (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <DashTile label="Estimated" block={data.economics} value={e.estimatedMonthlyCents} display={`${e.estimatedComplete ? "" : "≥ "}${aud(e.estimatedMonthlyCents)}`} hint={basisHint(e.estimated)} unknownHint={e.estimated.note || "No package assigned to estimate against"} unknownNeedsSetup unknownCause={packageCause} />
              {e.measuredMonthlyCents === null && sample ? (
                // One source for "measured" (RX-12): with no measured monthly cost, the sell status's
                // Retell sample, the same figure the cost-reconciliation gate shows.
                <DashTile label="Measured" block={data.economics} value={sample.perMinuteAud} display={`A$${sample.perMinuteAud.toFixed(2)}/min`} hint={`Retell rate measured on ${sample.calls} ${sample.calls === 1 ? "call" : "calls"} (${Math.round(sample.minutes)} min, sell status); no measured monthly cost yet. ${e.measured.note}`} />
              ) : (
                <DashTile label="Measured" block={data.economics} value={e.measuredMonthlyCents} display={`${e.measuredComplete ? "" : "≥ "}${aud(e.measuredMonthlyCents)}`} hint={basisHint(e.measured)} unknownHint={e.measured.note || "Not measured"} />
              )}
              {/* Nothing reconciled yet: a retry can't make an invoice exist (RX-9). */}
              <DashTile label="Reconciled" block={data.economics} value={e.reconciledMonthlyCents} display={`${e.reconciledComplete ? "" : "≥ "}${aud(e.reconciledMonthlyCents)}`} hint={basisHint(e.reconciled)} unknownHint={e.reconciled.note || "Nothing reconciled"} unknownCause="not-available" />
            </div>
          )} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Commercial</h3>
          <BlockState block={data.commercial} render={(c) => (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <DashTile label="MRR" block={data.commercial} value={c.mrrCents} display={aud(c.mrrCents)} hint={`${catalogueLabels().monthly}${c.unassignedClients ? ` · ${c.unassignedClients} unassigned` : ""}`} unknownHint="No client has a package assigned" unknownCause={packageCause} />
              <DashTile label="Setup fees" block={data.commercial} value={c.setupFeesCents} display={aud(c.setupFeesCents)} hint={catalogueLabels().setup} unknownHint="No client has a package assigned" unknownCause={packageCause} />
              <DashTile label="Unassigned clients" block={data.commercial} value={c.unassignedClients} tone={c.unassignedClients ? "warn" : undefined} />
            </div>
          )} />
        </div>
        <div>
          <h3 className="mb-3 text-base font-medium text-foreground">Support workload</h3>
          <BlockState block={data.supportWorkload} render={(s) => (
            <DashTile
              label="Assumed support minutes / month"
              block={data.supportWorkload}
              value={s.assumedMinutesTotal}
              lowerBound={s.assumedMinutesTotal !== null && s.clientsCounted < s.clientsTotal}
              hint={s.clientsCounted < s.clientsTotal ? `For ${s.clientsCounted} of ${s.clientsTotal} clients · ${s.caveat}` : s.caveat}
              unknownHint={s.caveat}
              unknownNeedsSetup
              unknownCause={packageCause}
            />
          )} />
        </div>
      </div>
    </Section>
  );
}

import { Badge, KeyValueList, Section, fmtCount, fmtDate, fmtPercent } from "@/components/ds";
import type { CommercialBlock } from "@/lib/receptionist";
import { getReceptionistPackage } from "@/lib/receptionist-packages";
import { priceStatusLines } from "@/lib/price-status";
import { aud } from "./format";

/** Every price below comes from the package catalogue (commercial.ts catalogueOffer); none is typed here. */
export function Commercial({ data }: { data: CommercialBlock }) {
  const economics = data.economics;
  const offer = data.offer;
  const base = economics.perTier.find((t) => t.packageId === economics.packageId) ?? economics.perTier[0];
  const status = priceStatusLines(getReceptionistPackage(offer.tiers[0]?.id ?? "receptionist-essential"));
  return <Section title="Commercial" description={`Package prices from ${offer.source}, ${status.gst}. ${status.monthly.text}. ${status.setup.text}. ${status.pilot.text}.`}>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">Receptionist leads</h3>
        {data.leads.ok ? <Leads leads={data.leads} /> : <p className="mt-2 text-xs text-muted-foreground">{data.leads.reason}</p>}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">Packages</h3>
        <ul className="mt-2 space-y-2">
          {offer.tiers.map((t) => <li key={t.id} className="text-sm text-foreground">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t.shortName}</span>
              <span className="ds-num">{aud(t.monthlyCents / 100, 0)}/mo</span>
              <Badge tone={t.status === "approved" ? "success" : "warn"}>{t.status === "approved" ? "Approved" : "Proposed"}</Badge>
              <span className="text-xs text-muted-foreground">{t.gst}</span>
            </span>
            <p className="text-xs text-muted-foreground">{fmtCount(t.includedMinutes)} min included · overage {aud(t.overagePerMinuteCents / 100)}/min · setup {aud(t.setupCents / 100, 0)} ({t.setupStatus === "approved" ? "approved" : "proposed, not approved"})</p>
          </li>)}
        </ul>
        <h3 className="mt-4 text-sm font-medium text-foreground">Pilots</h3>
        {data.pilots.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{offer.pilotTerms}.</p> : <ul className="mt-2 space-y-2">{data.pilots.map((pilot, i) => <li key={`${pilot.name}-${i}`} className="text-sm text-foreground">{pilot.name}<p className="text-xs text-muted-foreground">{fmtDate(pilot.startedAt)} – {fmtDate(pilot.endsAt)}</p></li>)}</ul>}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">Unit economics</h3>
        {economics.retellAudPerMinute === null || !base ? <p className="mt-2 text-xs text-muted-foreground">Not enough measured calls yet</p> : <KeyValueList dense className="mt-2" items={[
          { label: "Measured Retell cost", value: `${aud(economics.retellAudPerMinute, 3)}/min` },
          ...economics.perTier.map((t) => ({
            label: `${t.shortName} ${aud(t.monthlyAud, 0)}/mo (${t.status}, ${t.gst}) · cost at ${fmtCount(t.includedMinutes)} min`,
            value: <span className={t.marginAtIncludedAud === null ? "text-muted-foreground" : t.marginAtIncludedAud >= 0 ? "text-foreground" : "text-danger"}>{aud(t.costAtIncludedAud)} · margin {aud(t.marginAtIncludedAud)}{t.marginPct !== null && ` (${fmtPercent(t.marginPct / 100, 1)})`}</span>,
          })),
          { label: `Break-even (${base.shortName})`, value: base.breakEvenMinutes === null ? "—" : `${fmtCount(base.breakEvenMinutes)} min / month` },
        ]} />}
        <p className="mt-2 text-xs text-muted-foreground">{economics.caveat}</p>
      </div>
    </div>
  </Section>;
}

function Leads({ leads }: { leads: Extract<CommercialBlock["leads"], { ok: true }> }) {
  const nonZero = leads.byStage.filter(stage => stage.count > 0);
  const zero = leads.byStage.filter(stage => stage.count === 0);
  return <div className="mt-2">
    <p className="ds-num text-2xl font-semibold text-foreground">{fmtCount(leads.total)}</p>
    {nonZero.length > 0 && <ul className="mt-2 space-y-1">{nonZero.map(stage => <li key={stage.stage} className="flex items-baseline justify-between gap-2 text-xs"><span className="truncate text-muted-foreground" title={stage.label}>{stage.label}</span><span className="ds-num text-foreground">{fmtCount(stage.count)}</span></li>)}</ul>}
    {zero.length > 0 && <p className="mt-2 text-xs text-muted-foreground">0 {zero.map(s => s.label.toLowerCase()).join(", ")}</p>}
  </div>;
}

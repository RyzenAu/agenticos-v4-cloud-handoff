// Economics by basis: per-client, per-tier and portfolio figures from usage-economics.ts, each on
// ONE basis (estimated / measured / reconciled) with its source and as-of date. A cost that is
// missing lines is a floor ("≥"), so a margin built on it is a ceiling ("≤"). Unknown is "Unknown"
// with the reason, never A$0.00. Tables become stacked lists below md (no page overflow at 390 px).
import type { ReactNode } from "react";
import { Badge, InfoTip, Section, Surface } from "@/components/ds";
import type { DashboardViewModel } from "@/lib/receptionist-dashboard";
import type { ClientEconomics, Figure, MarginFigure, PortfolioLine, TierEconomics, UsageEconomics } from "../../../../scripts/receptionist/usage-economics";
import { aud, BlockState } from "./shared";
import { fmtProse } from "@/lib/format";

const BASIS_LABEL = { estimated: "Estimated", measured: "Measured", reconciled: "Reconciled" } as const;
const BASIS_HINT = {
  estimated: "List rates × usage",
  measured: "Provider-reported",
  reconciled: "Paid (NAB CSV)",
} as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * "28 Sep 2026, 3:04 pm" in Sydney time ("28 Sep 2026" for a bare date), or "date unknown". Month
 * names are fixed here: ICU versions differ ("Sep" vs "Sept"), and the same figure must read the same.
 */
export function asOfText(iso: string | null): string {
  if (!iso) return "date unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "date unknown";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${hour % 12 || 12}:${parts.minute} ${hour < 12 ? "am" : "pm"}`;
}
const pct = (bps: number | null) => (bps === null ? null : `${Math.round(bps / 100)}%`);

/** A cost on one basis: "A$12.34", "≥ A$12.34" when lines are missing, or "Unknown". */
export function costText(f: Figure): string {
  if (f.cents === null) return "Unknown";
  return `${f.complete ? "" : "≥ "}${aud(f.cents)}`;
}
/** A margin on one basis: "A$600.00 · 86%", "≤ A$600.00 · ≤ 86%" on a floor cost, or "Unknown". */
export function marginText(f: MarginFigure): string {
  if (f.cents === null || f.revenueCents === null) return "Unknown";
  const m = f.revenueCents - f.cents;
  const p = pct(f.marginBps);
  const le = f.complete ? "" : "≤ ";
  return `${le}${m < 0 ? "-" : ""}${aud(Math.abs(m))}${p ? ` · ${le}${p}` : ""}`;
}

function Provenance({ f }: { f: Figure }) {
  return (
    <span className="block text-2xs leading-4 text-muted-foreground">
      {fmtProse(f.source)} · as of {asOfText(f.asOf)}
    </span>
  );
}

/** One basis cell: the margin, the cost it was built from, the first note, and where it came from. */
export function BasisCell({ f, showCost = true }: { f: MarginFigure; showCost?: boolean }) {
  const unknown = f.cents === null || f.revenueCents === null;
  return (
    <div className="min-w-0" data-basis={f.basis} data-known={!unknown}>
      <span className={unknown ? "text-muted-foreground" : "ds-num font-medium text-foreground"}>{marginText(f)}</span>
      {showCost && f.cents !== null && <span className="block text-xs text-muted-foreground ds-num">cost {costText(f)}</span>}
      {f.notes[0] && <span className="block text-xs text-muted-foreground">{f.notes[0]}</span>}
      <Provenance f={f} />
    </div>
  );
}

function BasisHeader({ basis }: { basis: keyof typeof BASIS_LABEL }) {
  return (
    <>
      {BASIS_LABEL[basis]}
      <span className="block font-normal normal-case tracking-normal text-muted-foreground">{BASIS_HINT[basis]}</span>
    </>
  );
}

function Stacked({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="ds-label text-2xs">{label}</p>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

/** Per-tier margins on three bases. Reused on the Finance page, so it has no scroll container. */
export function TierBasisTable({ tiers, caption = "Margin per tier, by basis, this month, ex GST" }: { tiers: readonly TierEconomics[]; caption?: string }) {
  return (
    <Surface className="min-w-0 overflow-hidden p-0">
      <table className="hidden w-full text-sm md:table" data-testid="tier-basis-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left align-bottom text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">Tier</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Billable revenue</th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="estimated" /></th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="measured" /></th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="reconciled" /></th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.packageId} className="border-b border-border align-top last:border-0">
              <th scope="row" className="whitespace-nowrap px-4 py-3 text-left font-medium">
                {t.name}
                <span className="block text-xs font-normal text-muted-foreground">{t.clients} billed client{t.clients === 1 ? "" : "s"}</span>
              </th>
              <td className="whitespace-nowrap px-4 py-3 text-right ds-num">{t.revenue.cents === null ? <span className="text-muted-foreground">None</span> : aud(t.revenue.cents)}</td>
              <td className="px-4 py-3"><BasisCell f={t.estimated} /></td>
              <td className="px-4 py-3"><BasisCell f={t.measured} /></td>
              <td className="px-4 py-3"><BasisCell f={t.reconciled} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {tiers.map((t) => (
          <li key={t.packageId} className="grid min-w-0 gap-3 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-foreground">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.clients} billed · {t.revenue.cents === null ? "no revenue" : `${aud(t.revenue.cents)} billable`}</span>
            </div>
            <Stacked label="Estimated · list rates × usage"><BasisCell f={t.estimated} /></Stacked>
            <Stacked label="Measured · provider-reported"><BasisCell f={t.measured} /></Stacked>
            <Stacked label="Reconciled · paid (NAB CSV)"><BasisCell f={t.reconciled} /></Stacked>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function ClientName({ c }: { c: ClientEconomics }) {
  return (
    <>
      {c.slug ?? c.organizationId}
      {c.isDemoTenant && <Badge tone="accent" className="ml-1">Demo</Badge>}
      <span className="block text-xs font-normal text-muted-foreground">
        {c.packageName ?? "No package"} · {c.usage.calls === null ? "usage not reported" : `${c.usage.calls} calls · ${c.usage.billableMinutes} billable min`} · SMS {c.usage.smsSegments ?? "unknown"}
      </span>
    </>
  );
}

function ClientBasisTable({ clients }: { clients: readonly ClientEconomics[] }) {
  if (!clients.length) return <p className="text-sm text-muted-foreground">No clients in the feed yet.</p>;
  return (
    <Surface className="min-w-0 overflow-hidden p-0">
      <table className="hidden w-full text-sm md:table" data-testid="client-basis-table">
        <caption className="sr-only">Margin per client, by basis, this month, ex GST</caption>
        <thead>
          <tr className="border-b border-border text-left align-bottom text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">Client</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Billable revenue</th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="estimated" /></th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="measured" /></th>
            <th scope="col" className="px-4 py-2.5 font-medium"><BasisHeader basis="reconciled" /></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.organizationId} className="border-b border-border align-top last:border-0">
              <th scope="row" className="min-w-[10rem] px-4 py-3 text-left font-medium"><ClientName c={c} /></th>
              <td className="whitespace-nowrap px-4 py-3 text-right ds-num">{c.revenue.cents === null ? <span className="text-muted-foreground">{c.revenue.notes[0] ?? "None"}</span> : aud(c.revenue.cents)}</td>
              <td className="px-4 py-3"><BasisCell f={c.estimated} /></td>
              <td className="px-4 py-3"><BasisCell f={c.measured} /></td>
              <td className="px-4 py-3"><BasisCell f={c.reconciled} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border md:hidden" aria-label="Margin per client, by basis, this month, ex GST">
        {clients.map((c) => (
          <li key={c.organizationId} className="grid min-w-0 gap-3 px-4 py-3">
            <div className="font-medium text-foreground"><ClientName c={c} /></div>
            <Stacked label="Billable revenue">{c.revenue.cents === null ? c.revenue.notes[0] ?? "None" : aud(c.revenue.cents)}</Stacked>
            <Stacked label="Estimated · list rates × usage"><BasisCell f={c.estimated} /></Stacked>
            <Stacked label="Measured · provider-reported"><BasisCell f={c.measured} /></Stacked>
            <Stacked label="Reconciled · paid (NAB CSV)"><BasisCell f={c.reconciled} /></Stacked>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function PortfolioRow({ line, extra }: { line: PortfolioLine; extra?: ReactNode }) {
  const usd = line.usdCents === null ? "" : ` (US$${(line.usdCents / 100).toFixed(2)})`;
  return (
    <li className="grid min-w-0 gap-0.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
      <div className="min-w-0">
        <span className="text-sm text-foreground">{line.label}</span>
        {line.notes.map((n) => <span key={n} className="block text-xs text-muted-foreground">{n}</span>)}
        {extra}
        <Provenance f={line} />
      </div>
      <span className={line.cents === null ? "text-sm text-muted-foreground" : "ds-num text-sm font-medium text-foreground sm:text-right"}>{costText(line)}{line.cents === null ? "" : usd}</span>
    </li>
  );
}

function Portfolio({ econ }: { econ: UsageEconomics }) {
  const m = econ.portfolio.measured;
  const r = econ.portfolio.reconciled;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Surface className="min-w-0 px-4 py-3">
        <p className="ds-label text-2xs">Measured this month · provider-reported · not split by client unless shown</p>
        <ul className="divide-y divide-border">
          <PortfolioRow line={m.retell} extra={m.retell.attributedUsdCents !== null && (
            <span className="block text-xs text-muted-foreground ds-num">
              Matched to clients US${(m.retell.attributedUsdCents / 100).toFixed(2)} · not matched US${((m.retell.unattributedUsdCents ?? 0) / 100).toFixed(2)}
            </span>
          )} />
          <PortfolioRow line={m.twilio} />
          <PortfolioRow line={m.receptionistModels} />
          <PortfolioRow line={m.otherModels} />
          <li className="py-2.5 text-sm">
            <span className="text-foreground">SMS segments sent</span>{" "}
            <span className="ds-num font-medium">{m.smsSegments.count ?? "Unknown"}</span>
            <span className="block text-xs text-muted-foreground">{m.smsSegments.note}</span>
            <span className="block text-2xs text-muted-foreground">{fmtProse(m.smsSegments.source)} · as of {asOfText(m.smsSegments.asOf)}</span>
          </li>
        </ul>
      </Surface>
      <Surface className="min-w-0 px-4 py-3">
        <p className="ds-label text-2xs">Reconciled this month · paid, from the NAB CSV · {r.statement ?? "No NAB CSV imported"}</p>
        {r.notes.map((n) => <p key={n} className="mt-1 text-xs text-muted-foreground">{n}</p>)}
        {r.lines.length > 0 && <ul className="divide-y divide-border">{r.lines.map((l) => <PortfolioRow key={l.label} line={l} />)}</ul>}
      </Surface>
    </div>
  );
}

export function EconomicsByBasis({ data }: { data: DashboardViewModel }) {
  return (
    <Section
      title="Economics by basis"
      actions={<InfoTip label="About this section">Every figure is on one basis, with its source and date: estimated (list rates × actual usage), measured (what Retell, Twilio and the model router report) and reconciled (paid, from the NAB CSV). They are never added together. A ≥ cost is missing lines, so its ≤ margin is a ceiling. Ex GST.</InfoTip>}
    >
      <BlockState block={data.usageEconomics} render={(econ) => (
        <div className="grid min-w-0 gap-6">
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            Rates and exchange
            <InfoTip label="Catalogue, rates and exchange" align="start">
            Catalogue {econ.catalogue} · list rates checked {fmtProse(econ.ratesCheckedAt)} · USD converted at {econ.fx.source.split(" (")[0]} {fmtProse(econ.fx.date)} (US${econ.fx.usdPerAud.toFixed(4)} per A$1). {econ.fx.note}
            </InfoTip>
          </p>
          <div>
            <h3 className="mb-3 text-base font-medium text-foreground">Per tier</h3>
            <TierBasisTable tiers={econ.tiers} />
          </div>
          <div>
            <h3 className="mb-3 text-base font-medium text-foreground">Per client</h3>
            <ClientBasisTable clients={econ.clients} />
          </div>
          <div>
            <h3 className="mb-3 text-base font-medium text-foreground">Portfolio</h3>
            <Portfolio econ={econ} />
          </div>
        </div>
      )} />
    </Section>
  );
}

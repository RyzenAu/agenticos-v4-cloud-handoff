/**
 * Model checks for a deal, adapted from the spreadsheet-audit method in anthropics/financial-services
 * (plugins/.../audit-xls): tie-outs before anything else, inputs kept separate from calculations, every
 * constant traced to a dated source, edge cases that break a model, and a findings list ranked
 * critical / warning / info. Checks report; they never change a figure.
 */
import { ECONOMICS_AS_OF, receptionistConsistencyFixture } from "../business-economics";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../receptionist-packages";
import type { Deal } from "./deal";
import { calculateRxDeal, pricedPackage, rxInvoice } from "./receptionist";
import { buildQuote } from "./quote";
import { calculateWebsite } from "./website";

export type Severity = "critical" | "warning" | "info";
export type Finding = { id: string; severity: Severity; pass: boolean; area: string; check: string; detail: string };

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function auditDeal(deal: Deal, today: string): Finding[] {
  const f: Finding[] = [];
  const add = (id: string, severity: Severity, pass: boolean, area: string, check: string, detail: string) => f.push({ id, severity, pass, area, check, detail });

  // Known-example tie-out: the agreed billing regression must reproduce exactly on every run.
  const fixture = receptionistConsistencyFixture();
  add("regression-1200", "critical", fixture.expectedInvoice.totals.totalInclGstCents === 137_390, "Receptionist", "Professional at 1,200 billable minutes = A$1,373.90 incl. GST",
    `Engine total ${(fixture.expectedInvoice.totals.totalInclGstCents / 100).toFixed(2)}; expected 1,373.90 (A$1,099 + A$150 overage + A$124.90 GST, no setup line).`);
  const cataloguePrices = RECEPTIONIST_PACKAGES.map((p) => `${p.pricing.monthly.cents}/${p.pricing.includedMinutes}/${p.pricing.overagePerMinute.cents}`).join(" ");
  add("catalogue-approved", "critical", cataloguePrices === "69900/400/80 109900/1000/75 199900/1800/70" && RECEPTIONIST_PACKAGES.every((p) => p.pricing.status === "approved" && p.pricing.setupStatus === "proposed"),
    "Receptionist", "Catalogue matches the approved prices and setup stays unapproved", `Catalogue: ${cataloguePrices}.`);

  if (deal.include.website) {
    const shares = deal.website.stages.reduce((n, s) => n + s.shareBps, 0);
    add("stages-100", "critical", shares === 10000, "Website", "Payment stages add up to 100%", `Stages add up to ${shares / 100}%.`);
    add("fx-age", "warning", days(deal.website.fx.date, today) <= 30, "Website", "FX reference rate is recent", `RBA rate dated ${deal.website.fx.date} (${days(deal.website.fx.date, today)} days old).`);
    try {
      const w = calculateWebsite(deal.website); const o = w.oneOff;
      const stageTotal = o.stages.reduce((n, s) => n + s.inclGstCents, 0); const stageGst = o.stages.reduce((n, s) => n + s.gstCents, 0);
      add("stages-tie", "critical", stageTotal === o.totalInclGstCents && stageGst === o.gstCents, "Website", "Stage amounts tie to the project total and GST", `Stages ${stageTotal} c (GST ${stageGst} c) vs total ${o.totalInclGstCents} c (GST ${o.gstCents} c).`);
      const recomputed = o.revenueExGstCents - (o.labourCents + o.contingencyCents + o.thirdPartyCents + o.paymentCostCents);
      add("web-profit-tie", "critical", recomputed === o.grossProfitCents, "Website", "Revenue less cost lines equals gross profit", `Recomputed ${recomputed} c vs reported ${o.grossProfitCents} c.`);
      add("web-gst", "critical", o.totalInclGstCents === o.priceExGstCents + o.gstCents && ((deal.website.price.gst === "inclusive" && o.discountCents === 0) || o.gstCents === Math.round(o.priceExGstCents / 10)), "Website", "GST is 10% and incl. = ex + GST", `${o.priceExGstCents} + ${o.gstCents} = ${o.totalInclGstCents}.`);
      add("web-unknown", "warning", w.unknownCosts.length === 0, "Website", "No unknown costs", w.unknownCosts.length ? `${w.unknownCosts.length} cost(s) unknown and excluded, not zero: ${w.unknownCosts.join("; ")}.` : "All entered costs have amounts.");
      add("web-loss", "warning", o.grossProfitCents >= 0, "Website", "Build is not loss-making at the entered hours", o.pricing.breakEvenMinutes === null ? "No labour rate entered." : `Break-even at ${(o.pricing.breakEvenMinutes / 60).toFixed(1)} h; planned ${(o.minutes / 60).toFixed(1)} h + ${(o.contingencyMinutes / 60).toFixed(1)} h contingency.`);
      add("web-margin-sanity", "info", o.marginBps === null || o.marginBps < 9000, "Website", "Margin is believable (under 90%)", "A margin above 90% usually means hours were left out.");
      add("web-zero-hours", "warning", o.minutes > 0, "Website", "Effort hours are entered", o.minutes ? `${(o.minutes / 60).toFixed(1)} h planned.` : "Zero hours: the margin ignores founder time.");
      add("web-approval", "info", w.approval.unapproved.length === 0, "Website", "Terms match the owner-confirmed website offer", w.approval.unapproved.join(" ") || "Price, stages and care plan match.");
    } catch (e) { add("web-calc", "critical", false, "Website", "Website scenario calculates", (e as Error).message); }
  }

  if (deal.include.receptionist) {
    try {
      const r = calculateRxDeal(deal.rx); const pkg = pricedPackage(deal.rx);
      for (const c of r.columns) {
        const inv = rxInvoice(pkg, c.billableSeconds, c.smsSegments);
        add(`rx-invoice-${c.id}`, "critical", inv.exGstCents === c.revenueExGstCents && inv.lines.reduce((n, l) => n + l.inclGstCents, 0) === inv.inclGstCents,
          "Receptionist", `${c.label}: invoice lines tie to modelled revenue`, `Invoice ${inv.exGstCents} c ex GST vs model ${c.revenueExGstCents} c.`);
        const tie = c.revenueExGstCents - c.variableCostCents - c.supportCents - c.sharedPlatformCents;
        add(`rx-op-${c.id}`, "critical", tie === c.operatingCents, "Receptionist", `${c.label}: revenue less costs equals operating result`, `Recomputed ${tie} c vs ${c.operatingCents} c.`);
      }
      const full = r.columns.find((c) => c.id === "full")!;
      add("rx-full-loss", "warning", full.operatingCents >= 0, "Receptionist", "Profitable at full allowance", `Operating ${(full.operatingCents / 100).toFixed(2)} per month at ${full.billableSeconds / 60} min.`);
      add("rx-overage", "warning", r.breakEven.overage.profitable, "Receptionist", "Extra-minute price covers its marginal cost", `Price ${r.breakEven.overage.priceExGstCents} c vs about ${r.breakEven.overage.costPerMinuteCents.toFixed(1)} c cost per extra minute.`);
      add("rx-unknown", "warning", r.unknownCosts.length === 0, "Receptionist", "No unknown provider costs", `${r.unknownCosts.length} item(s) unknown and excluded, never zero.`);
      add("rx-rates-age", "warning", days(ECONOMICS_AS_OF, today) <= 30, "Receptionist", "Provider list rates re-read within 30 days", `Rates re-read ${ECONOMICS_AS_OF} (${days(ECONOMICS_AS_OF, today)} days ago). None is a measured or invoiced charge.`);
      add("rx-fx-age", "warning", days(deal.rx.fx.date, today) <= 30, "Receptionist", "FX reference rate is recent", `RBA rate dated ${deal.rx.fx.date}.`);
      const cat = getReceptionistPackage(deal.rx.packageId);
      add("rx-columns-order", "info", deal.rx.columns.full.billableSeconds === cat.pricing.includedMinutes * 60, "Receptionist", "Full-allowance column equals the included minutes", `${deal.rx.columns.full.billableSeconds / 60} min vs ${cat.pricing.includedMinutes} included.`);
      add("rx-approval", "info", r.unapproved.length === 0, "Receptionist", "Only approved receptionist terms are used", r.unapproved.map((u) => u.text).join(" ") || "Catalogue price, allowance and rate; setup quoted separately.");
    } catch (e) { add("rx-calc", "critical", false, "Receptionist", "Receptionist scenario calculates", (e as Error).message); }
  }

  let q: ReturnType<typeof buildQuote>;
  try { q = buildQuote(deal); } catch (e) {
    add("quote-build", "critical", false, "Quote", "Quote can be prepared", (e as Error).message);
    return sortFindings(f);
  }
  add("quote-missing", "info", q.missing.length === 0, "Quote", "Client details are complete", `Missing: ${q.missing.join(", ")}.`);
  add("quote-flagged", "info", true, "Quote", "Unapproved terms are marked in the quote", `${q.unapproved.length} item(s) flagged inline and in the review box; ${q.openDecisions.length} open owner decision(s).`);
  return sortFindings(f);
}
const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
function sortFindings(f: Finding[]) { return f.sort((a, b) => Number(a.pass) - Number(b.pass) || order[a.severity] - order[b.severity]); }

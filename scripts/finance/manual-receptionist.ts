// Receptionist package payments seen in the NAB CSV: which credits in a period are exactly an APPROVED
// monthly package price (the catalogue, src/lib/receptionist-packages.ts), ex GST or with the 10% GST added.
//
// What this is: a dated, sourced reconciliation hint built from the shared CSV ledger. What it is not:
//  - proof that a named client paid (the ledger keeps no payer text, and an amount can coincide),
//  - a live bank feed (the source is the last NAB CSV import, said in `source`),
//  - a price authority (it reads the catalogue; it never sets, rounds or invents a price).
// Only packages whose pricing.status is "approved" are matched. Setup fees are not matched while
// setupStatus is "proposed", and overage or SMS charges are usage, not fixed amounts, so they are never guessed.
// A period that no import covers is `null` (unknown, never zero); a partly covered one says so.
import { RECEPTIONIST_PACKAGES, CATALOGUE_VERSION, type ReceptionistPackage } from "../../src/lib/receptionist-packages";
import { SHARED_LEDGER, type ManualFinanceStore } from "./manual-store";
import { auDate, csvSourceLabel, ownAccountPairs, summary, type Coverage, type DateRange, type Period } from "./manual-summary";

const GST_PERCENT = 10;

export type PackageTarget = { packageId: string; shortName: string; exGstCents: number; incGstCents: number };
export type ExcludedPrice = { packageId: string; item: "monthly" | "setup"; reason: string };

/** The amounts a credit can match: approved monthly prices only, in whole cents, GST added exactly once. */
export function approvedMonthlyTargets(packages: readonly ReceptionistPackage[] = RECEPTIONIST_PACKAGES): { targets: PackageTarget[]; excluded: ExcludedPrice[] } {
  const targets: PackageTarget[] = [], excluded: ExcludedPrice[] = [];
  for (const p of packages) {
    if (p.pricing.status !== "approved") { excluded.push({ packageId: p.id, item: "monthly", reason: "Monthly price not approved in the catalogue." }); continue; }
    const m = p.pricing.monthly;
    if (m.currency !== "AUD" || (m.gst !== "exclusive" && m.gst !== "inclusive")) { excluded.push({ packageId: p.id, item: "monthly", reason: "Price has no clear GST basis." }); continue; }
    const gst = (cents: number) => (cents * GST_PERCENT) / 100;
    const ex = m.gst === "exclusive" ? m.cents : (m.cents * 100) / (100 + GST_PERCENT);
    const inc = m.gst === "inclusive" ? m.cents : m.cents + gst(m.cents);
    if (!Number.isInteger(ex) || !Number.isInteger(inc)) { excluded.push({ packageId: p.id, item: "monthly", reason: "GST does not divide into whole cents; not matched." }); continue; }
    targets.push({ packageId: p.id, shortName: p.shortName, exGstCents: ex, incGstCents: inc });
    if (p.pricing.setupStatus !== "approved") excluded.push({ packageId: p.id, item: "setup", reason: "Setup fee is only proposed; nothing is matched to it." });
  }
  return { targets, excluded };
}

export type ReceptionistPaymentCandidates = {
  kind: "receptionist-payment-candidates/v1";
  source: { name: "NAB CSV import"; statement: string; asOf: string | null; lastImportAt: string | null; live: false };
  catalogue: { version: string; basis: "approved monthly prices, GST 10%" };
  period: { label: string; from: string | null; to: string | null };
  coverage: Coverage;
  covered: DateRange[];
  note: string | null;
  /** null when no import covers the period: unknown, not zero. */
  candidates: null | {
    count: number;
    totalCents: number;
    byPackage: Array<{ packageId: string; shortName: string; exGst: number; incGst: number; count: number; cents: number }>;
  };
  excluded: ExcludedPrice[];
  /** Always said with the numbers: a hint to reconcile against invoices, never a receipt. */
  caveat: string;
};

const CAVEAT = "Credits whose amount equals an approved package price. This store keeps no payer name, so an amount can coincide with something else; check it against the invoice before treating it as a client payment.";

export function receptionistPaymentCandidates(period: Period, deps: { store: ManualFinanceStore; today?: string; packages?: readonly ReceptionistPackage[] }): ReceptionistPaymentCandidates {
  const s = summary(SHARED_LEDGER, period, { store: deps.store, today: deps.today });
  const { targets, excluded } = approvedMonthlyTargets(deps.packages);
  const head = {
    kind: "receptionist-payment-candidates/v1" as const,
    source: { name: "NAB CSV import" as const, statement: csvSourceLabel(s.asOf), asOf: s.asOf, lastImportAt: s.lastImportAt, live: false as const },
    catalogue: { version: CATALOGUE_VERSION, basis: "approved monthly prices, GST 10%" as const },
    period: { ...s.period }, coverage: s.periodCoverage, covered: s.periodCovered, note: s.coverageNote, excluded, caveat: CAVEAT,
  };
  if (s.periodCoverage === "none") return { ...head, candidates: null };

  const rows = deps.store.rows(SHARED_LEDGER);
  const paired = new Set([...ownAccountPairs(rows)].flat());
  const inRange = (d: string) => (s.period.from === null || d >= s.period.from) && (s.period.to === null || d <= s.period.to);
  const by = new Map<string, { exGst: number; incGst: number; count: number; cents: number; shortName: string; packageId: string }>();
  let count = 0, totalCents = 0;
  for (const r of rows) {
    // A posted credit only: not pending (not settled yet), not a transfer, refund or own-account move.
    if (r.status !== "posted" || r.amountCents <= 0 || r.kind !== "ordinary" || paired.has(r.id) || !inRange(r.date)) continue;
    const t = targets.find((x) => x.exGstCents === r.amountCents || x.incGstCents === r.amountCents);
    if (!t) continue;
    const e = by.get(t.packageId) ?? { packageId: t.packageId, shortName: t.shortName, exGst: 0, incGst: 0, count: 0, cents: 0 };
    if (t.incGstCents === r.amountCents) e.incGst++; else e.exGst++;
    e.count++; e.cents += r.amountCents; count++; totalCents += r.amountCents;
    by.set(t.packageId, e);
  }
  return { ...head, candidates: { count, totalCents, byPackage: [...by.values()].sort((a, b) => a.packageId.localeCompare(b.packageId)) } };
}

const aud = (cents: number) => `A$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One honest sentence for Jarvis or the page. Unknown stays unknown; a match is "possible", never "paid". */
export function receptionistCandidatesText(r: ReceptionistPaymentCandidates): string {
  const src = `${r.source.statement}${r.source.asOf ? ` (last row ${auDate(r.source.asOf)})` : ""}, not a live bank feed`;
  if (!r.candidates) return `I don't know: no NAB CSV import covers ${r.period.label}. ${src}.`;
  const partial = r.coverage === "partial" && r.note ? ` ${r.note}` : "";
  if (!r.candidates.count) return `No credit in ${r.period.label} matches an approved receptionist package price.${partial} ${src}.`;
  const parts = r.candidates.byPackage.map((p) => `${p.count} × ${p.shortName}`).join(", ");
  return `${r.candidates.count} credit${r.candidates.count === 1 ? "" : "s"} in ${r.period.label} (${aud(r.candidates.totalCents)}) match an approved package price: ${parts}. Possible client payments, not confirmed.${partial} ${src}.`;
}

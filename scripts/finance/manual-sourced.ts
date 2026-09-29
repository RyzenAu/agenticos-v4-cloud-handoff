// Sourced finance summaries: the ONLY form in which Finance data leaves Finance for Jarvis and
// memory (V4 §"Finance connection", V6 §8). Period totals with their source and as-of date; never
// a transaction row, a vendor-level line, an account alias, a balance or bank text. (Jarvis's
// on-demand /ask answers may name one vendor's total when asked; memory never holds vendor lines.)
//
// Finance storage (finance-manual.sqlite) stays authoritative: these are derived, dated copies
// that say where they came from, and "unknown" stays unknown (totals: null), never zero.
import { existsSync } from "node:fs";
import { SHARED_LEDGER, manualFinanceDbPath, sharedManualStore, type ManualFinanceStore } from "./manual-store";
import { auDate, csvSourceLabel, rangesText, summary, type Coverage, type DateRange, type ManualSummary, type Period } from "./manual-summary";

export type SourcedFinanceTotals = {
  cashInCents: number; cashOutCents: number; netOperatingCents: number;
  transfersInCents: number; transfersOutCents: number; refundsInCents: number;
  feesCents: number; toolsCents: number;
  businessOutCents: number; personalOutCents: number; unreviewedOutCents: number;
};
export type SourcedFinanceSummary = {
  kind: "finance-sourced-summary/v1";
  source: { name: "NAB CSV import"; store: "finance-manual.sqlite"; statement: string; asOf: string | null; lastImportAt: string | null; live: false };
  period: { label: string; from: string | null; to: string | null };
  coverage: Coverage;
  /** The parts of the period imports cover, and what that means ("no data" / "may be incomplete"). */
  covered: DateRange[];
  note: string | null;
  /** null when no imported data covers the period: unknown, not zero. */
  totals: SourcedFinanceTotals | null;
  pendingCount: number;
};

export function sourcedSummary(s: ManualSummary): SourcedFinanceSummary {
  return {
    kind: "finance-sourced-summary/v1",
    source: { name: "NAB CSV import", store: "finance-manual.sqlite", statement: csvSourceLabel(s.asOf), asOf: s.asOf, lastImportAt: s.lastImportAt, live: false },
    period: { ...s.period },
    coverage: s.periodCoverage,
    covered: s.periodCovered,
    note: s.coverageNote,
    totals: s.periodCoverage === "none" ? null : {
      cashInCents: s.cashInCents, cashOutCents: s.cashOutCents, netOperatingCents: s.netOperatingCents,
      transfersInCents: s.transfers.inCents, transfersOutCents: s.transfers.outCents, refundsInCents: s.refunds.inCents,
      feesCents: s.bankFeesCents + s.fxFees.totalCents, toolsCents: s.tools.totalCents,
      businessOutCents: s.byScope.business.outCents, personalOutCents: s.byScope.personal.outCents, unreviewedOutCents: s.byScope.unreviewed.outCents,
    },
    pendingCount: s.periodCoverage === "none" ? 0 : s.pending.count,
  };
}

/** Summaries for the given periods from the shared ledger, or null when nothing was ever imported. */
export function sourcedFinanceSummaries(deps: { root?: string; store?: ManualFinanceStore; today?: string; periods?: Period[] } = {}): SourcedFinanceSummary[] | null {
  let store = deps.store;
  if (!store) {
    const root = deps.root ?? process.cwd();
    // Never create the finance store just to say there is nothing in it.
    if (!existsSync(manualFinanceDbPath(root))) return null;
    store = sharedManualStore(root);
  }
  if (!store.count(SHARED_LEDGER)) return null;
  return (deps.periods ?? ["last-month", "this-month"]).map((p) => sourcedSummary(summary(SHARED_LEDGER, p, { store, today: deps.today })));
}

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Plain-text rendering for memory: sourced, dated, totals only. */
export function sourcedSummaryText(list: SourcedFinanceSummary[]): string {
  if (!list.length) return "";
  const src = list[0].source;
  const lines = [
    "# Finance summary (sourced)",
    `Source: ${src.name} (${src.store}). ${src.statement}${src.lastImportAt ? `; last import ${auDate(src.lastImportAt)}` : ""}. Not a live bank feed.`,
    "Period totals only: transactions, account details and balances stay in Finance and are not copied into memory. Cash flow, not profit; GST is not inferred. Ask Finance for anything more detailed.",
  ];
  for (const s of list) {
    // A custom range's label already is "<from> to <to>": don't say the dates twice (REVIEW-FINANCE R2).
    const range = s.period.from && s.period.to ? `${s.period.from} to ${s.period.to}` : "";
    const span = range && s.period.label !== range ? ` (${range})` : "";
    if (!s.totals) { lines.push(`- ${s.period.label}${span}: no data. No imported NAB data covers it, so its figures are unknown, not zero.`); continue; }
    const t = s.totals;
    const partial = s.coverage === "partial" ? `, partly covered (imported: ${rangesText(s.covered)}; figures may be incomplete)` : "";
    lines.push(`- ${s.period.label}${span}${partial}: cash in ${aud(t.cashInCents)}; cash out ${aud(t.cashOutCents)}; net operating ${aud(t.netOperatingCents)}; ` +
      `tools and subscriptions ${aud(t.toolsCents)}; bank and FX fees ${aud(t.feesCents)}; transfers ${aud(t.transfersOutCents)} out, ${aud(t.transfersInCents)} in; refunds ${aud(t.refundsInCents)} in` +
      `${t.unreviewedOutCents ? `; ${aud(t.unreviewedOutCents)} of spending not yet marked business or personal` : ""}${s.pendingCount ? `; ${s.pendingCount} pending not counted` : ""}.`);
  }
  return lines.join("\n");
}

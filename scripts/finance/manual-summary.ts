// WAVE2 finance contract: summary(ledger, period) → read-only aggregates of the imported NAB CSV
// rows, with the owner's corrections applied. Deterministic: integer cents, BigInt accumulation,
// no wall-clock dependence except the explicit `today` used for relative periods and the stale flag.
//
// This is CASH FLOW, not accounting profit: no GST is inferred, no accruals, no invoices.
// Transfers and refunds are reported separately and never counted as income or spending.
// Stripe payouts are transfers here: Stripe revenue (scripts/finance/stripe.ts) already counts that
// money, so counting the payout as NAB cash in too would count it twice.
//
// Unknown is never zero: `periodCoverage` says whether imported data covers the period at all
// ("none" → every figure is unknown, whatever the numbers say), partly ("partial") or fully.
import { homedir } from "node:os";
import { sharedManualStore, type EffectiveRow, type ManualFinanceStore, type Scope } from "./manual-store";
import { TOOL_CATEGORIES, isSettlementCredit, vendorRule, type VendorCategory } from "./manual-vendors";

export const STALE_AFTER_DAYS = 7;
export const STALE_PENDING_DAYS = 10;
/** A refund is matched to a charge from the same vendor and account at most this many days earlier. */
export const REFUND_MATCH_DAYS = 120;

export type Period =
  | "all" | "this-month" | "last-month" | "last-30-days" | "last-90-days"
  | { month: string } // "YYYY-MM"
  | { from: string; to: string }; // inclusive YYYY-MM-DD

export type Money = { inCents: number; outCents: number; count: number };
export type Coverage = "full" | "partial" | "none";
export type VendorLine = {
  vendorId: string; label: string; category: string; known: boolean; tool: boolean;
  inCents: number; outCents: number; refundCents: number; fxFeeCents: number; netCostCents: number; count: number; months: number; lastDate: string;
};
export type ManualSummary = {
  source: "nab-csv-manual";
  /** The ledger id (the shared business ledger on the Finance page). */
  owner: string;
  period: { from: string | null; to: string | null; label: string };
  /** Latest posting date across everything imported (not just this period). */
  asOf: string | null;
  /** "NAB CSV imported, as of 26 Sep 2026" / "No NAB CSV imported". Never a live-feed claim. */
  sourceLabel: string;
  live: false;
  stale: boolean;
  daysSinceAsOf: number | null;
  /** Posted dates the imported data spans, across all imports. */
  /** What the imports cover overall: extent plus the union of their date ranges (gaps show between ranges). */
  coverage: { from: string | null; to: string | null; ranges: DateRange[] };
  /** The covered parts of this period (union across accounts). */
  periodCovered: DateRange[];
  /** One sentence for partial/none coverage (page, Jarvis, memory), else null. */
  coverageNote: string | null;
  /** How much of this period the imported data covers. "none" → the figures are unknown, not zero. */
  periodCoverage: Coverage;
  basis: "cash-flow";
  accountingProfit: null;
  gst: "not-inferred";
  currency: "AUD";
  notes: string[];
  accounts: number;
  rowCount: number;
  lastImportAt: string | null;
  cashInCents: number;
  cashOutCents: number;
  netOperatingCents: number;
  netCashMovementCents: number;
  /** Includes Stripe payouts (see stripePayouts). */
  transfers: Money;
  /** Transfers matched between two of the owner's own accounts (both sides counted in `transfers`). */
  ownAccountTransfers: { pairs: number; cents: number };
  /** Stripe payouts landing in NAB: reported with transfers, never cash in (Stripe revenue counts them). */
  stripePayouts: { inCents: number; count: number };
  refunds: Money;
  /** Refunds tied to the original charge (by the owner, or matched by vendor, account, amount and date). */
  refundMatches: { matched: number; matchedCents: number; unmatched: number; unmatchedCents: number };
  bankFeesCents: number;
  fxFees: { totalCents: number; count: number; unattributedCents: number };
  tools: { totalCents: number; fxFeeCents: number; refundCents: number; vendors: VendorLine[] };
  pending: { count: number; inCents: number; outCents: number; stale: number };
  /** Operating cash in/out by business/personal scope (editable; unreviewed until the owner decides). */
  byScope: Record<Scope, Money>;
  /** Rows the owner may want to look at: unreviewed scope and refunds not tied to a charge. */
  review: { unreviewed: number; unmatchedRefunds: number; corrected: number };
  byCategory: Array<{ category: string; inCents: number; outCents: number; count: number }>;
  byVendor: VendorLine[];
  daily: Array<{ date: string; inCents: number; outCents: number }>;
};

// ---- exact money helpers ------------------------------------------------------------------
class Acc { v = 0n; add(n: number) { this.v += BigInt(n); } get n() { const x = Number(this.v); if (!Number.isSafeInteger(x)) throw new Error("MONEY_OVERFLOW"); return x; } }
const abs = (n: number) => (n < 0 ? -n : n);

// ---- dates -------------------------------------------------------------------------------
export function sydneyToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const isoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-26" → "26 Sep 2026", locale-independent (en-AU ICU builds differ on "Sep"/"Sept"). */
export function auDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}
/** The one wording for where Finance numbers come from. A CSV import is never called a live feed. */
export function csvSourceLabel(asOf: string | null): string {
  return asOf ? `NAB CSV imported, as of ${auDate(asOf)}` : "No NAB CSV imported";
}
export const LIVE_FEED_LABEL = "Live bank feed: not connected";

export function resolvePeriod(period: Period, today: string): { from: string | null; to: string | null; label: string } {
  if (!isoDate(today)) throw new Error("INVALID_TODAY");
  if (period === "all") return { from: null, to: null, label: "All imported data" };
  if (period === "this-month") return { from: `${today.slice(0, 7)}-01`, to: today, label: "This month" };
  if (period === "last-month") {
    const first = `${today.slice(0, 7)}-01`, prev = addDays(first, -1).slice(0, 7);
    return { from: `${prev}-01`, to: monthEnd(prev), label: "Last month" };
  }
  if (period === "last-30-days") return { from: addDays(today, -29), to: today, label: "Last 30 days" };
  if (period === "last-90-days") return { from: addDays(today, -89), to: today, label: "Last 90 days" };
  if (period && typeof period === "object" && "month" in period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period.month))
    return { from: `${period.month}-01`, to: monthEnd(period.month), label: period.month };
  if (period && typeof period === "object" && "from" in period && isoDate(period.from) && isoDate(period.to) && period.from <= period.to)
    return { from: period.from, to: period.to, label: `${period.from} to ${period.to}` };
  throw new Error("INVALID_PERIOD");
}

/** Parses a period from a query-string value ("all", "this-month", "2026-09", "2026-09-01..2026-09-27"). */
export function parsePeriodParam(value: string | null | undefined): Period {
  const v = (value ?? "").trim();
  if (!v) return "this-month";
  if (["all", "this-month", "last-month", "last-30-days", "last-90-days"].includes(v)) return v as Period;
  if (/^\d{4}-\d{2}$/.test(v)) return { month: v };
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (range) return { from: range[1], to: range[2] };
  throw new Error("INVALID_PERIOD");
}

/** Accepts plain stored rows too (tests, older callers): they get the default scope and no corrections. */
type RowIn = EffectiveRow | (Omit<EffectiveRow, "scope" | "refundOf" | "edited" | "base"> & Partial<Pick<EffectiveRow, "scope" | "refundOf" | "edited" | "base">>);
const effective = (r: RowIn): EffectiveRow => ({
  ...r, scope: r.scope ?? (r.known ? "business" : "unreviewed"), refundOf: r.refundOf ?? null, edited: r.edited ?? {},
  base: r.base ?? { kind: r.kind, category: r.category, vendorLabel: r.vendorLabel, scope: r.scope ?? (r.known ? "business" : "unreviewed") },
}) as EffectiveRow;

/**
 * Own-account transfer pairs: an incoming credit mirroring an outgoing transfer of the same amount
 * from ANOTHER of the owner's accounts within a day. Returns credit id → debit id.
 */
export function ownAccountPairs(rows: EffectiveRow[]): Map<string, string> {
  const paired = new Map<string, string>(), used = new Set<string>();
  // Outgoing transfers bucketed by amount: each credit looks only at same-amount candidates.
  const outs = new Map<number, EffectiveRow[]>();
  for (const r of rows) if (r.status === "posted" && r.kind === "transfer" && r.amountCents < 0) (outs.get(-r.amountCents) ?? outs.set(-r.amountCents, []).get(-r.amountCents)!).push(r);
  for (const credit of rows) {
    if (credit.status !== "posted" || credit.amountCents <= 0) continue;
    // A TRANSFER CREDIT the rules left as income, or one the owner (or the rules) marked as a transfer.
    if (!(credit.kind === "transfer" || (credit.kind === "ordinary" && !credit.edited.kind && /TRANSFER/.test(credit.typeLabel)))) continue;
    const mirror = (outs.get(credit.amountCents) ?? []).find((o) => !used.has(o.id) && o.accountAlias !== credit.accountAlias
      && Math.abs(Date.parse(o.date) - Date.parse(credit.date)) <= 86_400_000);
    if (mirror) { used.add(mirror.id); paired.set(credit.id, mirror.id); }
  }
  return paired;
}

const GENERIC_VENDORS = new Set(["other-spending", "other-income", "incoming-payments", "transfer-in", "transfer-out", "nab-fees"]);
/**
 * Refund → original charge. The owner's explicit link wins; otherwise the same vendor (not a generic
 * bucket) and account, a charge at least as large, on or before the refund and within
 * REFUND_MATCH_DAYS. Exact amount first, then the most recent charge. A charge absorbs refunds only
 * up to its own amount (partial refunds can share one charge).
 */
export function matchRefunds(rows: EffectiveRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const absorbed = new Map<string, number>();
  const room = (charge: EffectiveRow) => abs(charge.amountCents) - (absorbed.get(charge.id) ?? 0);
  const refunds = rows.filter((r) => r.status === "posted" && r.kind === "refund" && r.amountCents > 0).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const r of refunds) {
    if (!r.refundOf) continue;
    const charge = byId.get(r.refundOf);
    if (!charge || charge.amountCents >= 0) continue;
    out.set(r.id, charge.id);
    absorbed.set(charge.id, (absorbed.get(charge.id) ?? 0) + r.amountCents);
  }
  // Charges bucketed by vendor and account: each refund looks only at its own vendor's charges.
  const charges = new Map<string, EffectiveRow[]>();
  for (const c of rows) if (c.status === "posted" && c.amountCents < 0 && c.kind !== "transfer") { const k = `${c.vendorId}|${c.accountAlias}`; (charges.get(k) ?? charges.set(k, []).get(k)!).push(c); }
  for (const r of refunds) {
    if (out.has(r.id) || r.refundOf || GENERIC_VENDORS.has(r.vendorId)) continue;
    const earliest = addDays(r.date, -REFUND_MATCH_DAYS);
    const candidates = (charges.get(`${r.vendorId}|${r.accountAlias}`) ?? []).filter((c) => c.date <= r.date && c.date >= earliest && room(c) >= r.amountCents);
    const pick = candidates.filter((c) => -c.amountCents === r.amountCents).sort((a, b) => b.date.localeCompare(a.date))[0]
      ?? candidates.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))[0];
    if (pick) { out.set(r.id, pick.id); absorbed.set(pick.id, (absorbed.get(pick.id) ?? 0) + r.amountCents); }
  }
  return out;
}

// ---- coverage: the union of what each import actually covered, per account -------------------
export type CoverageSpan = { account: string; from: string; to: string };
export type DateRange = { from: string; to: string };
/** Sorted union; ranges that overlap or touch (next day) merge. */
export function mergeRanges(ranges: DateRange[]): DateRange[] {
  const out: DateRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out[out.length - 1];
    if (last && r.from <= addDays(last.to, 1)) { if (r.to > last.to) last.to = r.to; }
    else out.push({ ...r });
  }
  return out;
}
const clip = (ranges: DateRange[], from: string, to: string) =>
  ranges.filter((r) => r.to >= from && r.from <= to).map((r) => ({ from: r.from < from ? from : r.from, to: r.to > to ? to : r.to }));
/** "1 Sep 2026 – 26 Sep 2026 and 3 Oct 2026 – 9 Oct 2026". */
export function rangesText(ranges: DateRange[]): string {
  const parts = ranges.map((r) => (r.from === r.to ? auDate(r.from) : `${auDate(r.from)} – ${auDate(r.to)}`));
  return parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "full" only when EVERY account imported so far covers every day of the period; "none" when no
 * account covers any day of it (its figures are unknown, not zero); otherwise "partial". A gap
 * between two imports, or an account whose exports stopped, is never reported as a known $0.
 */
function coverageOf(range: { from: string | null; to: string | null }, spans: CoverageSpan[]) {
  const byAccount = new Map<string, DateRange[]>();
  for (const s of spans) (byAccount.get(s.account) ?? byAccount.set(s.account, []).get(s.account)!).push({ from: s.from, to: s.to });
  const merged = [...byAccount.values()].map(mergeRanges);
  const overall = mergeRanges(spans.map((s) => ({ from: s.from, to: s.to })));
  const extent = { from: overall[0]?.from ?? null, to: overall[overall.length - 1]?.to ?? null };
  if (!extent.from || !extent.to) return { overall, extent, covered: [] as DateRange[], coverage: "none" as Coverage };
  const from = range.from ?? extent.from, to = range.to ?? extent.to;
  const covered = clip(overall, from, to);
  if (!covered.length) return { overall, extent, covered, coverage: "none" as Coverage };
  const full = merged.every((ranges) => { const c = clip(ranges, from, to); return c.length === 1 && c[0].from === from && c[0].to === to; });
  return { overall, extent, covered, coverage: (full ? "full" : "partial") as Coverage };
}

/** Pure aggregate over already-loaded rows (corrections applied). */
export function summariseRows(input: RowIn[], owner: string, period: Period, options: { today?: string; lastImportAt?: string | null; spans?: CoverageSpan[] } = {}): ManualSummary {
  const rows = input.map(effective);
  const today = options.today ?? sydneyToday();
  const range = resolvePeriod(period, today);
  const inRange = (d: string) => (range.from === null || d >= range.from) && (range.to === null || d <= range.to);
  const posted = rows.filter((r) => r.status === "posted");
  const asOf = posted.reduce<string | null>((max, r) => (r.processedOn && (!max || r.processedOn > max) ? r.processedOn : max), null);
  // Without recorded import spans (a plain row list), each account counts as covered from its first to last row.
  const spans = options.spans ?? [...rows.reduce((m, r) => {
    const s = m.get(r.accountAlias);
    if (!s) m.set(r.accountAlias, { account: r.accountAlias, from: r.date, to: r.date });
    else { if (r.date < s.from) s.from = r.date; if (r.date > s.to) s.to = r.date; }
    return m;
  }, new Map<string, CoverageSpan>()).values()];
  const cov = coverageOf(range, spans);
  const daysSinceAsOf = asOf ? Math.round((Date.parse(today) - Date.parse(asOf)) / 86_400_000) : null;
  const pairs = ownAccountPairs(rows);
  const pairedDebits = new Set(pairs.values());
  const refundOf = matchRefunds(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kindOf = (r: EffectiveRow) => (pairs.has(r.id) || (r.kind === "ordinary" && !r.edited.kind && isSettlementCredit(r)) ? "transfer" : r.kind);

  const cashIn = new Acc(), cashOut = new Acc(), net = new Acc(), bankFees = new Acc(), fx = new Acc(), fxUnattributed = new Acc();
  const tIn = new Acc(), tOut = new Acc(), rIn = new Acc(), rOut = new Acc(), pIn = new Acc(), pOut = new Acc(), spIn = new Acc(), own = new Acc();
  const rMatched = new Acc(), rUnmatched = new Acc();
  let spCount = 0, tCount = 0, rCount = 0, fxCount = 0, pCount = 0, pStale = 0, ownPairs = 0, rMatchedN = 0, rUnmatchedN = 0, unreviewed = 0, corrected = 0;
  const scopes: Record<Scope, { in: Acc; out: Acc; count: number }> = { business: { in: new Acc(), out: new Acc(), count: 0 }, personal: { in: new Acc(), out: new Acc(), count: 0 }, unreviewed: { in: new Acc(), out: new Acc(), count: 0 } };
  const cats = new Map<string, { in: Acc; out: Acc; count: number }>();
  const vendors = new Map<string, { label: string; category: string; known: boolean; inn: Acc; out: Acc; refund: Acc; fx: Acc; count: number; months: Set<string>; last: string }>();
  const daily = new Map<string, { in: Acc; out: Acc }>();
  const vendor = (id: string, label: string, category: string, known: boolean) => {
    let v = vendors.get(id);
    if (!v) vendors.set(id, v = { label, category, known, inn: new Acc(), out: new Acc(), refund: new Acc(), fx: new Acc(), count: 0, months: new Set(), last: "" });
    return v;
  };
  const cat = (name: string) => { let c = cats.get(name); if (!c) cats.set(name, c = { in: new Acc(), out: new Acc(), count: 0 }); return c; };

  for (const r of rows) {
    if (!inRange(r.date)) continue;
    if (Object.keys(r.edited).length) corrected++;
    if (r.status === "pending") {
      pCount++;
      (r.amountCents > 0 ? pIn : pOut).add(abs(r.amountCents));
      if (Date.parse(today) - Date.parse(r.date) > STALE_PENDING_DAYS * 86_400_000) pStale++;
      continue;
    }
    net.add(r.amountCents);
    const kind = kindOf(r), amount = abs(r.amountCents), credit = r.amountCents > 0;
    if (kind === "transfer") {
      tCount++; (credit ? tIn : tOut).add(amount);
      if (pairs.has(r.id)) { ownPairs++; own.add(amount); }
      if (credit && isSettlementCredit(r) && !r.edited.kind) { spCount++; spIn.add(amount); }
      void pairedDebits;
      continue;
    }
    if (kind === "refund") {
      rCount++; (credit ? rIn : rOut).add(amount);
      if (!credit) continue;
      const original = refundOf.get(r.id);
      const charge = original ? byId.get(original) : undefined;
      if (charge) {
        rMatchedN++; rMatched.add(amount);
        const rule = vendorRule(charge.vendorId);
        vendor(charge.vendorId, charge.vendorLabel, charge.category, !!rule || charge.known).refund.add(amount);
      } else {
        rUnmatchedN++; rUnmatched.add(amount);
        if (r.known) vendor(r.vendorId, r.vendorLabel, r.category, true).refund.add(amount);
      }
      continue;
    }
    // Operating cash in/out (includes bank and FX fees as real cash costs).
    (credit ? cashIn : cashOut).add(amount);
    const s = scopes[r.scope] ?? scopes.unreviewed;
    (credit ? s.in : s.out).add(amount); s.count++;
    if (r.scope === "unreviewed") unreviewed++;
    const d = daily.get(r.date) ?? { in: new Acc(), out: new Acc() };
    (credit ? d.in : d.out).add(amount); daily.set(r.date, d);
    const c = cat(r.category); (credit ? c.in : c.out).add(amount); c.count++;
    if (kind === "bank-fee") bankFees.add(amount);
    if (kind === "fx-fee") {
      fx.add(amount); fxCount++;
      if (r.fxVendorId) {
        const rule = vendorRule(r.fxVendorId);
        vendor(r.fxVendorId, r.fxVendorLabel ?? r.fxVendorId, rule?.category ?? "", !!rule).fx.add(amount);
        continue;
      }
      fxUnattributed.add(amount);
    }
    if (!credit) {
      const v = vendor(r.vendorId, r.vendorLabel, r.category, r.known);
      v.out.add(amount); v.count++; v.months.add(r.date.slice(0, 7)); if (r.date > v.last) v.last = r.date;
    } else if (r.known) {
      const v = vendor(r.vendorId, r.vendorLabel, r.category, true);
      v.inn.add(amount); v.count++; v.months.add(r.date.slice(0, 7)); if (r.date > v.last) v.last = r.date;
    }
  }

  const byVendor: VendorLine[] = [...vendors].map(([vendorId, v]) => {
    const netCost = new Acc(); netCost.add(v.out.n); netCost.add(v.fx.n); netCost.add(-v.refund.n);
    return { vendorId, label: v.label, category: v.category, known: v.known, tool: TOOL_CATEGORIES.includes(v.category as VendorCategory),
      inCents: v.inn.n, outCents: v.out.n, refundCents: v.refund.n, fxFeeCents: v.fx.n, netCostCents: netCost.n, count: v.count, months: v.months.size, lastDate: v.last };
  }).sort((a, b) => b.netCostCents - a.netCostCents || a.label.localeCompare(b.label));
  const tools = byVendor.filter((v) => v.tool);
  const toolTotal = new Acc(), toolFx = new Acc(), toolRefund = new Acc();
  for (const t of tools) { toolTotal.add(t.netCostCents); toolFx.add(t.fxFeeCents); toolRefund.add(t.refundCents); }
  const netOperating = new Acc(); netOperating.add(cashIn.n); netOperating.add(-cashOut.n);

  const dates = [...daily.keys()].sort();
  const series: ManualSummary["daily"] = [];
  if (dates.length) {
    const start = range.from ?? dates[0], end = range.to ?? dates[dates.length - 1];
    const first = addDays(end, -89) > start ? addDays(end, -89) : start;
    for (let d = first; d <= end; d = addDays(d, 1)) { const x = daily.get(d); series.push({ date: d, inCents: x?.in.n ?? 0, outCents: x?.out.n ?? 0 }); }
  }
  const periodCoverage = cov.coverage;
  const wholePeriod = cov.covered.length === 1 && range.from !== null && cov.covered[0].from === range.from && cov.covered[0].to === range.to;
  // F2 FIN-3: a month exported from the 2nd (the 1st had no transactions, or wasn't in the chosen
  // range) is "partial" forever. The CSV doesn't say which, so it stays partial, but the note names
  // the missing edge days instead of calling the whole period "may be incomplete".
  const edgeDays: string[] = [];
  if (periodCoverage === "partial" && !wholePeriod && cov.covered.length === 1 && range.from !== null && range.to !== null) {
    for (let d = range.from; d < cov.covered[0].from && edgeDays.length <= 3; d = addDays(d, 1)) edgeDays.push(d);
    for (let d = addDays(cov.covered[0].to, 1); d <= range.to && edgeDays.length <= 3; d = addDays(d, 1)) edgeDays.push(d);
  }
  const edgeOnly = edgeDays.length > 0 && edgeDays.length <= 3;
  const coverageNote = periodCoverage === "none" ? "No imported NAB data covers this period: its figures are unknown, not zero."
    : periodCoverage === "partial" ? (wholePeriod ? "Not every account's imports cover all of this period, so its figures may be incomplete."
      : edgeOnly ? `Imported NAB data covers ${rangesText(cov.covered)}. ${naturalDays(edgeDays)} ${edgeDays.length === 1 ? "isn't" : "aren't"} in any export yet (no transactions, or outside the range exported), so figures cover the imported days only.`
      : `Imported NAB data only covers part of this period (${rangesText(cov.covered)}), so its figures may be incomplete.`) : null;
  const money = (x: { in: Acc; out: Acc; count: number }): Money => ({ inCents: x.in.n, outCents: x.out.n, count: x.count });

  return {
    source: "nab-csv-manual", owner, period: range, asOf, sourceLabel: csvSourceLabel(asOf), live: false,
    stale: asOf === null || (daysSinceAsOf !== null && daysSinceAsOf > STALE_AFTER_DAYS), daysSinceAsOf,
    coverage: { ...cov.extent, ranges: cov.overall }, periodCoverage, periodCovered: cov.covered, coverageNote,
    basis: "cash-flow", accountingProfit: null, gst: "not-inferred", currency: "AUD",
    notes: [
      "Cash flow from your own NAB CSV export, not accounting profit. Not a live bank feed.",
      "GST is not inferred. Transfers and refunds are shown separately and excluded from cash in/out.",
      "Stripe payouts are reported with transfers, not cash in: Stripe revenue already counts that money.",
      "Pending rows are excluded until NAB posts them.",
      ...(coverageNote ? [coverageNote] : []),
    ],
    accounts: new Set(rows.map((r) => r.accountAlias)).size, rowCount: rows.length, lastImportAt: options.lastImportAt ?? null,
    cashInCents: cashIn.n, cashOutCents: cashOut.n, netOperatingCents: netOperating.n, netCashMovementCents: net.n,
    transfers: { inCents: tIn.n, outCents: tOut.n, count: tCount },
    ownAccountTransfers: { pairs: ownPairs, cents: own.n },
    stripePayouts: { inCents: spIn.n, count: spCount },
    refunds: { inCents: rIn.n, outCents: rOut.n, count: rCount },
    refundMatches: { matched: rMatchedN, matchedCents: rMatched.n, unmatched: rUnmatchedN, unmatchedCents: rUnmatched.n },
    bankFeesCents: bankFees.n,
    fxFees: { totalCents: fx.n, count: fxCount, unattributedCents: fxUnattributed.n },
    tools: { totalCents: toolTotal.n, fxFeeCents: toolFx.n, refundCents: toolRefund.n, vendors: tools },
    pending: { count: pCount, inCents: pIn.n, outCents: pOut.n, stale: pStale },
    byScope: { business: money(scopes.business), personal: money(scopes.personal), unreviewed: money(scopes.unreviewed) },
    review: { unreviewed, unmatchedRefunds: rUnmatchedN, corrected },
    byCategory: [...cats].map(([category, c]) => ({ category, inCents: c.in.n, outCents: c.out.n, count: c.count }))
      .sort((a, b) => b.outCents + b.inCents - (a.outCents + a.inCents) || a.category.localeCompare(b.category)),
    byVendor, daily: series,
  };
}

/** Lazily opened shared store under the AgenticOS root (process.cwd()). Opening creates only finance-manual.sqlite. */
export function defaultManualStore(root = process.cwd()): ManualFinanceStore {
  if (root === homedir()) throw new Error("REFUSING_HOME_ROOT");
  return sharedManualStore(root);
}

/** WAVE2 contract entry point. */
export function summary(owner: string, period: Period = "this-month", deps: { store?: ManualFinanceStore; today?: string } = {}): ManualSummary {
  const store = deps.store ?? defaultManualStore();
  return summariseRows(store.rows(owner), owner, period, { today: deps.today, lastImportAt: store.lastImportAt(owner), spans: store.coverageSpans(owner) });
}

/** ["2026-08-01", "2026-08-31"] → "1 Aug 2026 and 31 Aug 2026". */
function naturalDays(days: string[]): string {
  const parts = days.map(auDate);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

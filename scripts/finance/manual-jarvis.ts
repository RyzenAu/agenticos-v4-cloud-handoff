// Jarvis hook for cost/margin questions, answered ONLY from deterministic calculations:
//  - measured cash figures from summary(owner, period) over the owner's imported NAB CSV, and
//  - modelled package margins from src/lib/business-economics.ts (estimate-only).
// No model call, no network, no raw rows: answers quote aggregates only. Not wired into the voice
// router here (the Jev track owns those files) — see "patch for lead" in the w2-finance report.
import { packageEconomicsMatrix } from "../../src/lib/business-economics";
import { MU_VENDOR_RULES } from "./manual-vendors";
import { rangesText, type ManualSummary, type Period } from "./manual-summary";
import { parseSpokenPeriod, resolveSpokenPeriod, summaryPeriodFor, type SpokenPeriod } from "./spoken-period";

export type ManualFinanceIntent =
  | { kind: "cash"; period: Period }
  | { kind: "tools"; period: Period }
  | { kind: "vendor"; vendorId: string; period: Period }
  | { kind: "fx-fees"; period: Period }
  | { kind: "margin"; period: Period };

/** The named period (spoken-period.ts), else this month. Periods that need a date resolve against `today`. */
function periodOf(t: string, today: string | undefined): Period {
  const p = parseSpokenPeriod(t);
  if (!p || p.kind === "this-month") return "this-month";
  if (p.kind === "last-month") return "last-month";
  if (p.kind === "all" || /\bso far\b/.test(t) && !/\bthis\b/.test(t)) return "all";
  if (p.kind === "last-days" && (p.days === 30 || p.days === 90)) return p.days === 30 ? "last-30-days" : "last-90-days";
  return today ? summaryPeriodFor(p, today) : "this-month";
}

/** Pure text match; safe on every voice turn. */
export function matchManualFinanceQuestion(text: string, today?: string): ManualFinanceIntent | null {
  const t = String(text ?? "").toLowerCase().replace(/[’']/g, "'").replace(/[?.!,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 300) return null;
  const period = periodOf(t, today);
  if (/\bmargins?\b|\bprofitab|\bgross contribution\b|\bare we making money\b/.test(t)) return { kind: "margin", period };
  if (/\b(fx|forex|foreign|international|intnl|currency conversion)\b.*\bfees?\b|\bfees?\b.*\b(fx|foreign|international)\b/.test(t)) return { kind: "fx-fees", period };
  const spendy = /\b(spend|spent|spending|cost|costs|costing|paid|pay|paying|bill|bills|charged)\b/.test(t);
  if (spendy) {
    for (const rule of MU_VENDOR_RULES) {
      if (rule.side !== "debit") continue;
      const names = [rule.id, rule.label.toLowerCase(), ...(rule.id === "elevenlabs" ? ["eleven labs"] : []), ...(rule.id === "openai" ? ["chatgpt", "open ai"] : []), ...(rule.id === "anthropic" ? ["claude"] : [])];
      if (names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t))) return { kind: "vendor", vendorId: rule.id, period };
    }
    if (/\b(tools?|subscriptions?|software|saas|stack|apis?)\b/.test(t)) return { kind: "tools", period };
  }
  if (/\bcash ?flow\b|\bcash (in|out)\b|\b(money|cash) (came|coming|come|went|going|go) (in|out)\b|\bhow much (came|went|come|go) (in|out)\b|\bnet cash\b/.test(t)) return { kind: "cash", period };
  return null;
}

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
const pct = (bps: number) => `${Math.round(bps / 100)}%`;

/** Every answer says where it came from: "NAB CSV imported, as of 26 Sep 2026." (+ how old, when stale). */
function freshness(s: ManualSummary): string {
  if (!s.asOf) return "";
  const partial = s.periodCoverage === "partial" && s.coverageNote ? `${s.coverageNote} ` : "";
  return (s.stale ? `${s.sourceLabel}, ${s.daysSinceAsOf} days ago, so newer spending isn't in it. ` : `${s.sourceLabel}. `) + partial;
}
/** The period isn't covered by any imported data: say unknown, never zero. */
function uncovered(s: ManualSummary, label: string): string | null {
  if (s.periodCoverage !== "none") return null;
  const span = s.coverage.ranges?.length ? ` Imported data covers ${rangesText(s.coverage.ranges)}.` : "";
  return `${freshness(s)}I have no data ${label.startsWith("in ") ? label : `for ${label}`}: no imported NAB data covers it, so it's unknown, not zero.${span} Import a CSV that includes it on the Finance page.`;
}

/** Deterministic spoken answer. Pass the summary for intent.period. */
export function answerManualFinanceQuestion(intent: ManualFinanceIntent, s: ManualSummary): string {
  const label = s.period.label.charAt(0).toLowerCase() + s.period.label.slice(1); // "Last month" → "last month"; "August" keeps its capital
  if (intent.kind === "margin") {
    const lines = packageEconomicsMatrix([5]).map((p) => {
      const base = p.scenarios.find((x) => x.scenarioId === "base") ?? p.scenarios[0];
      const r = base?.byClients[0]?.estimated;
      return r && r.operatingMarginBps !== null ? `${p.name} about ${pct(r.operatingMarginBps)}` : null;
    }).filter(Boolean);
    const modelled = `Modelled operating margins at five clients, base usage, are ${lines.join(", ")}. Those are estimates with some costs still unknown, not measured results.`;
    if (!s.rowCount) return `${modelled} I can't compare them with real spending yet: no NAB CSV has been imported.`;
    if (s.periodCoverage === "none") return `${modelled} I can't compare them with real spending ${label}: no imported NAB data covers it.`;
    return `${freshness(s)}${modelled} From your NAB CSV, ${label} tools and subscriptions cost ${aud(s.tools.totalCents)}, including ${aud(s.tools.fxFeeCents)} in NAB international fees, against ${aud(s.cashInCents)} cash in (Stripe payouts left out: Stripe revenue already counts them). That's cash flow, not accounting profit, and GST isn't inferred.`;
  }
  if (!s.rowCount) return "No NAB CSV has been imported yet. Export one from NAB Internet Banking and drop it on the Finance page.";
  const unknown = uncovered(s, label);
  if (unknown) return unknown;
  const lead = freshness(s);
  switch (intent.kind) {
    case "cash":
      return `${lead}${label[0].toUpperCase()}${label.slice(1)}: ${aud(s.cashInCents)} came in and ${aud(s.cashOutCents)} went out, so net operating cash is ${aud(s.netOperatingCents)}. Transfers (${aud(s.transfers.outCents)} out, ${aud(s.transfers.inCents)} in${s.stripePayouts.count ? `, including ${aud(s.stripePayouts.inCents)} of Stripe payouts that Stripe revenue already counts` : ""}) and refunds (${aud(s.refunds.inCents)} received) are kept separate${s.pending.count ? `, and ${s.pending.count} pending ${s.pending.count === 1 ? "row isn't" : "rows aren't"} counted yet` : ""}. This is cash flow, not profit.`;
    case "tools": {
      const top = s.tools.vendors.slice(0, 3).map((v) => `${v.label} ${aud(v.netCostCents)}`).join(", ");
      return `${lead}Tools and subscriptions ${label}: ${aud(s.tools.totalCents)} net, including ${aud(s.tools.fxFeeCents)} in NAB international fees${s.tools.refundCents ? ` and after ${aud(s.tools.refundCents)} in refunds` : ""}.${top ? ` Biggest: ${top}.` : ""}`;
    }
    case "vendor": {
      const v = s.byVendor.find((x) => x.vendorId === intent.vendorId);
      const name = MU_VENDOR_RULES.find((r) => r.id === intent.vendorId)?.label ?? intent.vendorId;
      if (!v) return `${lead}I don't see any ${name} charges ${label} in your imported NAB data.`;
      return `${lead}${name} ${label}: ${aud(v.outCents)} across ${v.count} ${v.count === 1 ? "charge" : "charges"}${v.fxFeeCents ? `, plus ${aud(v.fxFeeCents)} in NAB international fees` : ""}${v.refundCents ? `, less ${aud(v.refundCents)} refunded` : ""}. Net ${aud(v.netCostCents)}.`;
    }
    case "fx-fees":
      return `${lead}NAB international transaction fees ${label}: ${aud(s.fxFees.totalCents)} across ${s.fxFees.count} ${s.fxFees.count === 1 ? "fee" : "fees"}${s.fxFees.unattributedCents ? `, of which ${aud(s.fxFees.unattributedCents)} couldn't be tied to a vendor` : ""}.`;
  }
}

// ---- The older NAB voice questions ("how much came in this week", "what's my balance") -------
// scripts/jarvis-skills/finance.ts used to answer these from the retired legacy finance.sqlite (fail
// closed, so it said "switched off"). They are now answered from the same imported NAB CSV
// summaries, with the source and as-of date, and nothing is inferred that the CSV doesn't hold.
export type LegacyNabKind = "income-today" | "income-week" | "income-month" | "balance" | "paid-invoices" | "spend-week" | "spend-month" | "spend-category";

const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Deterministic answer from NAB CSV summaries. `summaryFor` reads the shared ledger for a period. */
export function answerNabVoiceQuestion(kind: LegacyNabKind, category: string | null, summaryFor: (p: Period) => ManualSummary, today: string, when?: SpokenPeriod): string {
  // AUDIT-F2 FIN-1: the period the question named wins ("last month" is last month, not this one),
  // and the answer says which period it covers.
  const named = when ? resolveSpokenPeriod(when, today) : null;
  const namedPeriod: Period | null = when ? summaryPeriodFor(when, today) : null;
  const withLabel = (s: ManualSummary): ManualSummary => (named ? { ...s, period: { ...s.period, label: named.label } } : s);
  if (kind === "spend-category") {
    if (!/^(software|tools?|subscriptions?|saas|apps?)$/.test((category ?? "").trim().toLowerCase()))
      return `I can break spending down by tools and subscriptions, or by a vendor like Retell or Twilio, but not by "${category}".`;
    const p = namedPeriod ?? "this-month";
    return answerManualFinanceQuestion({ kind: "tools", period: p }, withLabel(summaryFor(p)));
  }
  const period: Period = namedPeriod ?? (kind === "income-today" ? { from: today, to: today } : kind === "income-week" || kind === "spend-week" ? { from: shift(today, -6), to: today } : "this-month");
  const s = summaryFor(period);
  if (!s.rowCount) return "No NAB CSV has been imported yet. Export one from NAB Internet Banking and drop it on the Finance page.";
  const lead = freshness(s);
  if (kind === "balance") return `${lead}I don't keep bank balances: the NAB CSV import holds cash flow only, and there's no live bank feed. Check NAB for your current balance.`;
  if (kind === "paid-invoices") return `${lead}I can't match NAB payments to invoices from the CSV import yet. Ask "who owes me" for Stripe invoices.`;
  const label = named?.label ?? (kind === "income-today" ? "today" : kind === "income-week" || kind === "spend-week" ? "the last 7 days" : "this month");
  const unknown = uncovered(s, label);
  if (unknown) return unknown;
  if (kind.startsWith("income")) return `${lead}${aud(s.cashInCents)} came in ${label}, not counting transfers, refunds or Stripe payouts.`;
  return `${lead}${aud(s.cashOutCents)} went out ${label}, including bank and FX fees but not transfers.`;
}

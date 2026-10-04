// Finance: bank figures + Stripe invoices/payouts, answered instantly from what's stored locally —
// no LLM call, no live bank or Stripe request. Wraps scripts/finance/jarvis-intent.ts's matcher
// (the NAB questions) and scripts/finance/stripe-jarvis-intent.ts (Stripe) in one skill
// registration. "Who owes me" also appends finance/receivables.ts's local client-record note (e.g.
// Bianca Brown Realty's remaining 50%), clearly labelled as not from Stripe.
//
// Bank questions are answered from the authoritative NAB CSV import (finance-manual.sqlite, shared
// ledger) as sourced summaries: every answer says "NAB CSV imported, as of …", and unknown periods
// are said to be unknown. The retired legacy finance.sqlite NAB path is no longer consulted.
import { matchFinanceIntent, type FinanceIntentKind } from "../finance/jarvis-intent";
import { matchStripeIntent, answerStripeIntent, type StripeIntentKind } from "../finance/stripe-jarvis-intent";
import { createStripeSync } from "../finance/stripe";
import { localReceivablesLine } from "../finance/receivables";
import { answerNabVoiceQuestion } from "../finance/manual-jarvis";
import type { SpokenPeriod } from "../finance/spoken-period";
import { SHARED_LEDGER, manualFinanceDbPath, sharedManualStore, type ManualFinanceStore } from "../finance/manual-store";
import { summary, summariseRows, sydneyToday } from "../finance/manual-summary";
import { existsSync } from "node:fs";

export type FinanceRequest =
  | { skill: "finance"; source: "nab"; kind: Exclude<FinanceIntentKind, "spend-category">; period?: SpokenPeriod }
  | { skill: "finance"; source: "nab"; kind: "spend-category"; category: string; period?: SpokenPeriod }
  | { skill: "finance"; source: "stripe"; kind: StripeIntentKind };

/** Pure text match — tries the NAB patterns then the Stripe ones (their patterns don't
 *  overlap), so either question is caught by this one skill registration. */
export function financeIntent(utterance: string): FinanceRequest | null {
  const nab = matchFinanceIntent(utterance);
  if (nab) {
    const period = nab.period ? { period: nab.period } : {};
    return nab.kind === "spend-category" ? { skill: "finance", source: "nab", kind: "spend-category", category: nab.category, ...period } : { skill: "finance", source: "nab", kind: nab.kind, ...period };
  }
  const stripe = matchStripeIntent(utterance);
  if (stripe) return { skill: "finance", source: "stripe", kind: stripe.kind };
  return null;
}

export type FinanceDeps = {
  root: string;
  /** The NAB CSV store (tests inject one). Default: the shared store under root, if it exists. */
  manualStore?: ManualFinanceStore | null;
  today?: string;
  stripe?: ReturnType<typeof createStripeSync>;
  receivablesLine?: () => string;
};

export async function answerFinance(req: FinanceRequest, deps: FinanceDeps): Promise<string> {
  if (req.source === "nab") {
    const today = deps.today ?? sydneyToday();
    // Never create the finance store just to answer "nothing imported".
    const store = deps.manualStore !== undefined ? deps.manualStore : existsSync(manualFinanceDbPath(deps.root)) ? sharedManualStore(deps.root) : null;
    const summaryFor = (p: Parameters<typeof summary>[1]) => (store ? summary(SHARED_LEDGER, p, { store, today }) : summariseRows([], SHARED_LEDGER, p ?? "this-month", { today }));
    return answerNabVoiceQuestion(req.kind, req.kind === "spend-category" ? req.category : null, summaryFor, today, req.period);
  }
  const stripe = deps.stripe ?? createStripeSync(deps.root);
  const said = await answerStripeIntent({ kind: req.kind }, stripe);
  if (req.kind !== "outstanding-invoices") return said;
  const extra = (deps.receivablesLine ?? localReceivablesLine)();
  return extra ? `${said} ${extra}` : said;
}

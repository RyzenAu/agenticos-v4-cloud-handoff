// A small, standalone rules-based intent matcher for the NAB/Basiq finance questions Jarvis
// should be able to answer: "how much came in today/this week/this month", "what did I spend
// this week/month/on software", "what's my balance", "who's paid". This file is intentionally
// NOT wired into scripts/free-voice.ts, scripts/jev*.ts or scripts/jarvis-skills/* — those are
// owned by another engineer. See docs/FINANCE-JARVIS-HOOK.md for the exact lines to add there to
// call this module (scripts/jarvis-skills/finance.ts does exactly that).
import type { createFinanceSync } from "./sync";
import { resolveCategory } from "./categories";
import { parseSpokenPeriod, PERIOD_PHRASE, type SpokenPeriod } from "./spoken-period";

export type FinanceIntentKind = "income-today" | "income-week" | "income-month" | "balance" | "paid-invoices" | "spend-week" | "spend-month" | "spend-category";
/** `period`: the period the question named ("last month", "this financial year"…), if any (AUDIT-F2 FIN-1). */
export type FinanceIntent = ({ kind: Exclude<FinanceIntentKind, "spend-category"> } | { kind: "spend-category"; category: string }) & { period?: SpokenPeriod };

const PATTERNS: Array<{ kind: Exclude<FinanceIntentKind, "spend-category">; test: RegExp }> = [
  { kind: "income-today", test: /\b(how much|what).*(come in|came in|earned|revenue|income).*(today)\b|\bincome today\b|\btoday'?s (income|revenue|takings)\b/ },
  { kind: "income-week", test: /\b(how much|what).*(come in|came in|earned|revenue|income).*(this week|week)\b|\bincome (this )?week\b|\bweek'?s (income|revenue|takings)\b/ },
  { kind: "income-month", test: /\b(how much|what).*(come in|came in|earned|earn|made|make|revenue|income).*(this month|month)\b|\bincome (this )?month\b|\bmonth'?s (income|revenue|takings)\b|\bhow much (did|have) we (make|made|earn|earned)( this month)?\b/ },
  { kind: "balance", test: /\b(what'?s|what is|check|tell me) my (bank )?balance\b|\bbank balance\b|\bhow much (money )?(do i have|is in the bank|is in the account)\b/ },
  { kind: "paid-invoices", test: /\bwho('?s| is| has) paid\b|\bwhich invoices (are|have been) paid\b|\bany(one)? paid\b/ },
  { kind: "spend-week", test: /\b(how much|what).*(spend|spent|spending|cost|paid out).*(this week|week)\b|\bspend(ing)? (this )?week\b|\bweek'?s spend(ing)?\b/ },
  { kind: "spend-month", test: /\b(how much|what).*(spend|spent|spending|cost|paid out).*(this month|month)\b|\bspend(ing)? (this )?month\b|\bmonth'?s spend(ing)?\b/ },
];
/**
 * Review R7: the generic "how much … made / cost" forms answer bank cash only when the question
 * names a period ("…this financial year", "…in August") or a money/bank word. No bank-cash intent
 * takes a package, price, plan or rate question ("what does the Professional package cost"): those
 * belong to the catalogue answer, not bank spending.
 */
const GENERIC: Array<{ kind: "income-month" | "spend-month"; test: RegExp }> = [
  { kind: "income-month", test: /\b(how much|what)\b.*\b(come in|came in|earned|earn|made|make|revenue|income|takings)\b/ },
  { kind: "spend-month", test: /\b(how much|what)\b.*\b(spend|spent|spending|cost|paid out)\b/ },
];
const NOT_BANK_CASH = /\b(packages?|plans?|tiers?|pric(e|es|ing)|catalogue|essential|professional|premium|per (minute|min|call|month)|rates?|quote|margins?|dinner|lunch|breakfast)\b/;
const MONEY_WORD = /\b(money|cash|bank|nab|revenue|income|takings|earned|spend|spent|spending|paid out)\b/;

/** "what did I spend on software (this month)" — checked before the generic spend-week/month
 *  patterns above so a category is never swallowed by the plainer "this week"/"this month"
 *  match. The category word itself is only validated (against categories.ts) at answer time,
 *  not here — matching stays a pure, cheap text check. */
const SPEND_CATEGORY_RE = /\bspen[dt](?:ing)?\b.*?\bon (?:a |an |the )?([a-z][a-z ]{1,60}?)$/;

/** Pure text match — no side effects, safe to call from any voice/router pipeline. */
export function matchFinanceIntent(text: string): FinanceIntent | undefined {
  const t = text.trim().toLowerCase().replace(/[?.!,]+$/, "");
  if (!t) return undefined;
  const named = parseSpokenPeriod(t);
  // A period is attached only when it isn't the intent's own default (today / this week / this month).
  const periodFor = (kind: FinanceIntentKind) => {
    if (!named) return {};
    const own = kind === "income-today" ? "today" : kind.endsWith("-week") ? "this-week" : kind.endsWith("-month") || kind === "spend-category" ? "this-month" : null;
    return named.kind === own ? {} : { period: named };
  };
  if (NOT_BANK_CASH.test(t)) return undefined;
  const category = SPEND_CATEGORY_RE.exec(t);
  // "software last month" is the category "software" over last month, never a category of its own.
  const cat = category?.[1].replace(PERIOD_PHRASE, "").trim();
  if (cat && cat.length <= 24) return { kind: "spend-category", category: cat, ...periodFor("spend-category") };
  for (const pattern of PATTERNS) if (pattern.test.test(t)) return { kind: pattern.kind, ...periodFor(pattern.kind) };
  if (named || MONEY_WORD.test(t)) for (const pattern of GENERIC) if (pattern.test.test(t)) return { kind: pattern.kind, ...periodFor(pattern.kind) };
  return undefined;
}

const aud = (value: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 2 }).format(value);

/**
 * Turns a matched intent into a short spoken-style answer, in Australian English. Reads only
 * locally-stored figures (finance.summary() / .invoiceMatches() do not call Basiq), so this is
 * safe to call on every voice turn without rate-limit concerns.
 */
export async function answerFinanceIntent(intent: FinanceIntent, finance: ReturnType<typeof createFinanceSync>): Promise<string> {
  // Legacy NAB is fail-closed (legacy-admission.ts): say so plainly instead of "add a key".
  if (typeof finance.admission === "function" && !finance.admission("summary").admitted)
    return "Live NAB data is switched off until a reviewed authorisation is in place. Import a NAB CSV on the Finance page instead.";
  if (!finance.configured()) return "NAB isn't connected yet. Add a Basiq key and connect it from the dashboard first.";
  const status = await finance.status();
  if (!status.connected) return "NAB isn't connected yet. Open the dashboard and connect it there.";
  switch (intent.kind) {
    case "income-today": {
      const s = finance.summary();
      return s.incomeToday.count ? `${aud(s.incomeToday.amount)} has come in today, across ${s.incomeToday.count} ${s.incomeToday.count === 1 ? "payment" : "payments"}.` : "Nothing's come in yet today.";
    }
    case "income-week": {
      const s = finance.summary();
      return s.incomeWeek.count ? `${aud(s.incomeWeek.amount)} has come in this week, across ${s.incomeWeek.count} ${s.incomeWeek.count === 1 ? "payment" : "payments"}.` : "Nothing's come in this week yet.";
    }
    case "balance": {
      const s = finance.summary();
      return s.accounts ? `Your balance across ${s.accounts} ${s.accounts === 1 ? "account" : "accounts"} is ${aud(s.balance)}.` : "No NAB accounts are synced yet.";
    }
    case "paid-invoices": {
      const matches = finance.invoiceMatches().filter((m) => m.confidence >= 0.85);
      return matches.length ? `${matches.length} ${matches.length === 1 ? "invoice looks" : "invoices look"} paid: ${matches.map((m) => m.invoiceId).slice(0, 5).join(", ")}${matches.length > 5 ? ", and more" : ""}.` : "No invoices have matched a payment yet.";
    }
    case "income-month": {
      const s = finance.summary();
      return s.incomeMonth.count ? `${aud(s.incomeMonth.amount)} has come in this month, across ${s.incomeMonth.count} ${s.incomeMonth.count === 1 ? "payment" : "payments"}.` : "Nothing's come in this month yet.";
    }
    case "spend-week": {
      const s = finance.summary();
      return s.spendWeek.count ? `${aud(s.spendWeek.amount)} spent this week, across ${s.spendWeek.count} ${s.spendWeek.count === 1 ? "transaction" : "transactions"}.` : "No spending recorded this week yet.";
    }
    case "spend-month": {
      const s = finance.summary();
      return s.spendMonth > 0 ? `${aud(s.spendMonth)} spent this month.` : "No spending recorded this month yet.";
    }
    case "spend-category": {
      const resolved = resolveCategory(intent.category);
      if (!resolved) return `I can only break spend down by software right now, not "${intent.category}".`;
      const result = finance.categorySpend(intent.category);
      return result.count ? `${aud(result.amount)} on ${resolved} this month, across ${result.count} ${result.count === 1 ? "transaction" : "transactions"}.` : `No ${resolved} spend found in the last month.`;
    }
  }
}

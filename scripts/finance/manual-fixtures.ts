// SYNTHETIC NAB Internet Banking CSV exports for tests and the isolated preview. Every value here
// is invented: account numbers are all-zero placeholders, merchants/amounts are made up. This
// module never reads a real export.
import { NAB_CSV_HEADER } from "./manual-nab-csv";

export type SyntheticLine = {
  date: string; amount: string; account?: string; type: string; details: string;
  category?: string; merchant?: string; processedOn?: string | null; balance?: string | null;
};

export const SYNTHETIC_ACCOUNT = "00-000-0000";
export const SYNTHETIC_SAVINGS = "00-000-0001";

const cents = (s: string) => {
  const neg = s.startsWith("-"), [w, f = ""] = s.replace(/^[-+]/, "").split(".");
  return (neg ? -1 : 1) * (Number(w) * 100 + Number(f.padEnd(2, "0")));
};
const money = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Builds CSV text with NAB's exact header. Running balances are computed per account (oldest
 * first, each account opening at openingCents) unless given; `newestFirst` writes the rows in the
 * order NAB Internet Banking does.
 */
export function buildNabCsv(lines: SyntheticLine[], options: { openingCents?: number; eol?: string; bom?: boolean; newestFirst?: boolean } = {}): string {
  const balances = new Map<string, number>();
  const body = lines.map((l) => {
    const pending = l.processedOn === null;
    const account = l.account ?? SYNTHETIC_ACCOUNT;
    const balance = (balances.get(account) ?? options.openingCents ?? 500_000) + (pending ? 0 : cents(l.amount));
    if (!pending) balances.set(account, balance);
    const bal = l.balance !== undefined ? (l.balance ?? "") : pending ? "" : money(balance);
    return [l.date, l.amount, l.account ?? SYNTHETIC_ACCOUNT, "", l.type, l.details, bal, l.category ?? "", l.merchant ?? "", pending ? "" : (l.processedOn ?? l.date)]
      .map(quote).join(",");
  });
  const eol = options.eol ?? "\r\n";
  if (options.newestFirst) body.reverse();
  return `${options.bom ? "﻿" : ""}${[NAB_CSV_HEADER.join(","), ...body].join(eol)}${eol}`;
}

/** A synthetic September 2026 month for M&U: tools with FX fees, a transfer, a refund, fees, a pending row. */
export const SYNTHETIC_SEPTEMBER: SyntheticLine[] = [
  { date: "01 Sep 26", amount: "825.00", type: "TRANSFER CREDIT", details: "SYNTHETIC CLIENT DEPOSIT INV-0001", category: "Transfers in" },
  { date: "03 Sep 26", amount: "-31.25", type: "EFTPOS DEBIT", details: "V0000 01/09 VERCEL INC. COVINA USD 20.00", merchant: "Vercel", category: "Software" },
  { date: "03 Sep 26", amount: "-0.94", type: "FEES", details: "NAB INTNL TRAN FEE - VERCEL INC", category: "Fees" },
  { date: "05 Sep 26", amount: "-35.12", type: "EFTPOS DEBIT", details: "V0000 04/09 RETELL AI SAN FRANCISCO USD 24.65", merchant: "Retell AI", category: "Software" },
  { date: "05 Sep 26", amount: "-1.05", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "08 Sep 26", amount: "-21.43", type: "MISCELLANEOUS DEBIT", details: "V0000 07/09 TWILIO SENDGRID SAN FRANCISCO USD 15.04", merchant: "Twilio", category: "Software" },
  { date: "08 Sep 26", amount: "-0.64", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "10 Sep 26", amount: "-30.00", type: "EFTPOS DEBIT", details: "V0000 09/09 OPENAI *CHATGPT SUBSCR USD 20.00", merchant: "OpenAI", category: "Software" },
  { date: "10 Sep 26", amount: "-0.90", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "12 Sep 26", amount: "-150.00", type: "TRANSFER DEBIT", details: "TRANSFER TO OWN SAVINGS SYNTHETIC", category: "Transfers out" },
  { date: "12 Sep 26", amount: "150.00", account: SYNTHETIC_SAVINGS, type: "TRANSFER CREDIT", details: "TRANSFER FROM SYNTHETIC BUSINESS", category: "Transfers in" },
  { date: "14 Sep 26", amount: "12.40", type: "EFTPOS CREDIT", details: "V0000 13/09 RETELL AI REFUND", merchant: "Retell AI", category: "Refunds" },
  { date: "15 Sep 26", amount: "-10.00", type: "FEES", details: "MONTHLY ACCOUNT FEE", category: "Fees" },
  { date: "18 Sep 26", amount: "412.50", type: "MISCELLANEOUS CREDIT", details: "STRIPE PAYMENTS AUST SYNTH PAYOUT", category: "Income" },
  { date: "20 Sep 26", amount: "-45.99", type: "EFTPOS DEBIT", details: "V0000 19/09 OFFICEWORKS 0000 SYNTHVILLE", merchant: "Officeworks", category: "Office supplies" },
  { date: "22 Sep 26", amount: "-29.00", type: "EFTPOS DEBIT", details: "V0000 21/09 ANTHROPIC CLAUDE.AI USD 19.00", merchant: "Anthropic", category: "Software" },
  { date: "22 Sep 26", amount: "-0.87", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "23 Sep 26", amount: "-14.20", type: "EFTPOS DEBIT", details: "V0000 23/09 ELEVENLABS.IO USD 10.00", merchant: "ElevenLabs", category: "Software" },
  { date: "23 Sep 26", amount: "-0.43", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "25 Sep 26", amount: "-19.00", type: "EFTPOS DEBIT", details: "V0000 24/09 NEON TECH INC USD 13.00", merchant: "Neon", category: "Software" },
  { date: "25 Sep 26", amount: "-0.57", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "26 Sep 26", amount: "-55.00", type: "EFTPOS DEBIT", details: "V0000 25/09 HIGGSFIELD AI USD 36.00", merchant: "Higgsfield", category: "Software" },
  { date: "26 Sep 26", amount: "-1.65", type: "FEES", details: "NAB INTNL TRAN FEE", category: "Fees" },
  { date: "27 Sep 26", amount: "-21.43", type: "EFTPOS DEBIT", details: "TWILIO SENDGRID", merchant: "Twilio", category: "Software", processedOn: null },
];

export function syntheticSeptemberCsv(): string {
  return buildNabCsv(SYNTHETIC_SEPTEMBER);
}

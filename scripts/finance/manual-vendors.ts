// Vendor mapping for the owner-initiated NAB CSV import, as DATA. Each rule is matched once, at
// import time, against the transaction text; only the resulting vendor id/label/category is
// stored — the bank's description text itself is never persisted (see manual-nab-csv.ts).
//
// Add a vendor by appending a rule. Patterns are case-insensitive and tested against
// "<Transaction Details> <Merchant Name>" in upper case. Order matters: first match wins.

export type VendorCategory = "ai-models" | "voice-telephony" | "hosting-database" | "creative-tools" | "payments-income";

export type VendorRule = Readonly<{
  id: string;
  label: string;
  category: VendorCategory;
  /** Which side of the ledger this vendor is expected on. "credit" = money in (e.g. Stripe payouts). */
  side: "debit" | "credit";
  /** Billed in a foreign currency, so NAB international transaction fees are expected. */
  foreignBilled: boolean;
  /** Regex sources, joined with |. Kept as strings so the table can be serialised/reviewed. */
  patterns: readonly string[];
  /**
   * "transfer": a credit from this vendor settles money another source already counts as revenue
   * (a Stripe payout is the net of charges Stripe reports). The summary reports it with transfers,
   * never as cash in, so NAB cash in + Stripe revenue can't count the same money twice.
   */
  settlement?: "transfer";
}>;

const RULES: VendorRule[] = [
  { id: "retell", label: "Retell AI", category: "voice-telephony", side: "debit", foreignBilled: true, patterns: ["\\bRETELL"] },
  { id: "twilio", label: "Twilio", category: "voice-telephony", side: "debit", foreignBilled: true, patterns: ["\\bTWILIO"] },
  { id: "elevenlabs", label: "ElevenLabs", category: "voice-telephony", side: "debit", foreignBilled: true, patterns: ["ELEVEN\\s?LABS"] },
  { id: "vercel", label: "Vercel", category: "hosting-database", side: "debit", foreignBilled: true, patterns: ["\\bVERCEL"] },
  { id: "neon", label: "Neon", category: "hosting-database", side: "debit", foreignBilled: true, patterns: ["\\bNEON\\s?(TECH|DB|INC|DATABASE)\\b", "NEON\\.TECH"] },
  { id: "higgsfield", label: "Higgsfield", category: "creative-tools", side: "debit", foreignBilled: true, patterns: ["\\bHIGGSFIELD"] },
  { id: "openai", label: "OpenAI", category: "ai-models", side: "debit", foreignBilled: true, patterns: ["\\bOPENAI", "\\bCHATGPT"] },
  { id: "anthropic", label: "Anthropic", category: "ai-models", side: "debit", foreignBilled: true, patterns: ["\\bANTHROPIC", "CLAUDE\\.AI"] },
  { id: "stripe-payouts", label: "Stripe payouts", category: "payments-income", side: "credit", foreignBilled: false, patterns: ["\\bSTRIPE"], settlement: "transfer" },
];
export const MU_VENDOR_RULES: readonly VendorRule[] = Object.freeze(RULES.map((rule) => Object.freeze({ ...rule, patterns: Object.freeze([...rule.patterns]) })));
/** Categories that count as "subscriptions / tool costs" in the summary. */
export const TOOL_CATEGORIES: readonly VendorCategory[] = Object.freeze(["ai-models", "voice-telephony", "hosting-database", "creative-tools"]);

const compiled = MU_VENDOR_RULES.map((rule) => ({ rule, re: new RegExp(rule.patterns.join("|"), "i") }));

/** True for a posted credit that settles revenue counted elsewhere (Stripe payouts). Pure. */
export function isSettlementCredit(row: { known: boolean; vendorId: string; amountCents: number }): boolean {
  return row.known && row.amountCents > 0 && vendorRule(row.vendorId)?.settlement === "transfer";
}

/** First matching rule for this text and direction, or null. Pure. */
export function matchVendor(text: string, direction: "debit" | "credit"): VendorRule | null {
  for (const { rule, re } of compiled) {
    if (!re.test(text)) continue;
    // A Stripe *charge* (debit) is a fee, not a payout; a tool vendor credit is a refund. Both
    // still map to the vendor so the refund lands against the right tool.
    if (rule.side === "credit" && direction === "debit") continue;
    return rule;
  }
  return null;
}

export function vendorRule(id: string): VendorRule | undefined {
  return MU_VENDOR_RULES.find((rule) => rule.id === id);
}

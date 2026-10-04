// Categorises spend by matching known vendor names in the NAB transaction description. Basiq's
// own "class" field (see store.ts) is a transaction type, not a spend category, and the free
// retired NAB-CSV fallback (csv-import.ts, now removed) carried no category at all — so there is no real taxonomy to
// read. Rather than invent one, this only supports "software" today, matched against a
// maintained, editable list of SaaS/software vendors this business actually pays. Any other
// requested category returns { supported: false } and the caller must say so honestly (see
// jarvis-intent.ts's "spend-category" case) instead of guessing a number.
import type { StoredTransaction } from "./store";

/** Not exhaustive — extend as new recurring software vendors show up in bank statements. Matched
 *  case-insensitively as a substring of the transaction description. */
export const SOFTWARE_VENDORS = [
  "anthropic", "claude", "openai", "chatgpt", "vercel", "github", "google workspace", "google cloud",
  "microsoft", "adobe", "figma", "notion", "stripe", "amazon web services", "aws", "digitalocean",
  "cloudflare", "groq", "elevenlabs", "retell", "twilio", "zoom", "slack", "dropbox", "1password",
  "canva", "webflow", "netlify", "supabase", "mongodb", "openrouter", "deepseek", "gemini",
  "pinecone", "higgsfield", "crazy domains", "godaddy", "namecheap",
];

const CATEGORY_VENDORS: Record<string, string[]> = {
  software: SOFTWARE_VENDORS,
};

/** Casual ways of asking for the same "software" bucket. */
const ALIASES: Record<string, string> = {
  software: "software",
  subscriptions: "software",
  subscription: "software",
  saas: "software",
  tools: "software",
  apps: "software",
  "software subscriptions": "software",
};

export function resolveCategory(spoken: string): string | undefined {
  return ALIASES[spoken.trim().toLowerCase()];
}

export type CategorySpend = { supported: boolean; amount: number; count: number };

export function computeCategorySpend(transactions: StoredTransaction[], category: string): CategorySpend {
  const resolved = resolveCategory(category);
  if (!resolved) return { supported: false, amount: 0, count: 0 };
  const vendors = CATEGORY_VENDORS[resolved];
  let amount = 0, count = 0;
  for (const tx of transactions) {
    if (tx.direction !== "debit") continue;
    const description = tx.description.toLowerCase();
    if (vendors.some((vendor) => description.includes(vendor))) {
      amount += Math.abs(tx.amount);
      count++;
    }
  }
  return { supported: true, amount: Math.round(amount * 100) / 100, count };
}

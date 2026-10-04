// Shared shapes for the AI usage & spend snapshot (server: scripts/ai-usage/*, page: /usage).
// Every money figure is carried in AUD; the provider's own currency travels alongside it so the
// page can show where a converted number came from. `estimated` is set on anything the OS
// derived itself (local call counts, API-equivalent value) rather than read from the provider.

export type Freshness = {
  /** ISO time the provider (or local source) was last read successfully. */
  checkedAt: string | null;
  /** How the figure was obtained: "provider API", "local transcripts", "local call count"… */
  source: string;
  /** True when the figure is the OS's own estimate, not the provider's number. */
  estimated: boolean;
};

export type Unavailable = { ok: false; reason: string; checkedAt: string | null };

export type Money = {
  aud: number;
  /** Original amount and currency before conversion (AUD prices carry themselves). */
  original: { amount: number; currency: "AUD" | "USD" };
};

export type LimitWindow = {
  label: string; // "5-hour", "Weekly", "Weekly · Fable"
  usedPercent: number;
  resetsAt: string | null;
  windowSeconds?: number | null;
};

export type SubscriptionCard = {
  id: string; // "codex:openai-1", "claude:max"
  provider: "openai" | "anthropic";
  owner: string; // "M&U Ventures", "Usman", "Mehroz"
  plan: string; // plan named by the provider (e.g. "Pro (US$100 tier)")
  /** The plan slug the provider reports (JWT / usage API), e.g. "prolite". */
  planSlug: string | null;
  monthly: Money | null;
  priceNote: string;
  status: { ok: true; windows: LimitWindow[]; notes: string[]; freshness: Freshness } | Unavailable;
  /** Highest used % across windows, or null when unavailable. */
  peakPercent: number | null;
};

export type ApiKeyRow = {
  id: string; // stable, never the key itself
  provider: string; // "OpenRouter", "ElevenLabs"…
  keyName: string; // env var NAME only
  keyTail: string | null; // provider-issued label/tail when the provider returns one
  usage: string; // human summary: "14,750 characters this month"
  spend: Money | null; // this month; null = unknown
  spendEstimated: boolean;
  limit: string | null; // "US$19 key limit", "1,000 req/day (free)"
  status: "ok" | "warn" | "danger" | "unavailable" | "info";
  note: string;
  freshness: Freshness;
};

export type ClaudeModelRow = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** What these tokens would cost on the Anthropic API (est.), AUD; null = unpriced model. */
  apiEquivalent: Money | null;
};

export type FxRate = { usdToAud: number; source: string; asOf: string; stale: boolean };

export type PriceSetting = {
  id: string;
  label: string;
  /** null = not set (the price is unknown and left out of the totals). */
  amount: number | null;
  currency: "AUD" | "USD";
  /** Whether `amount` already includes Australian GST. */
  gstIncluded: boolean;
  source: string;
  /** True once the owner has edited it (the default is the published price). */
  edited: boolean;
};

export type AiUsageSnapshot = {
  generatedAt: string;
  month: { label: string; start: string; end: string; dayOfMonth: number; daysInMonth: number };
  fx: FxRate | null;
  totals: {
    fixedAud: number;
    meteredAud: number;
    monthAud: number;
    projectedAud: number;
    /** Items whose spend is unknown (not counted in the totals). */
    unknown: string[];
    /** True when any included figure is an estimate. */
    includesEstimates: boolean;
  };
  subscriptions: SubscriptionCard[];
  apiKeys: ApiKeyRow[];
  claudeModels: {
    rows: ClaudeModelRow[];
    totalApiEquivalent: Money | null;
    freshness: Freshness;
    scope: string;
  } | Unavailable;
  prices: PriceSetting[];
  sources: { name: string; freshness: Freshness; ok: boolean; reason?: string }[];
};

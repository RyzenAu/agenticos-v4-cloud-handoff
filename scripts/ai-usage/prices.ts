import { catalogue, type CatalogueModel } from "../model-router/catalogue";

// Published prices the usage page starts from. Every subscription price is editable on /usage
// (stored in .operator-data/ai-usage.json) because the owner's invoice is the real number; these
// are only the defaults, each with the source it came from.

export const GST_RATE = 0.1;

export type DefaultPrice = {
  id: string;
  label: string;
  /** null = no published price we can rely on; the owner must set it. */
  amount: number | null;
  currency: "AUD" | "USD";
  gstIncluded: boolean;
  source: string;
};

// Checked 24 Sep 2026.
// - Claude: Anthropic shows signed-in Australian customers an AUD price list with GST included.
//   Max 20x is A$340.00 (A$309.09 + A$30.91 GST), as recorded from the AU checkout on
//   11 Sep 2026 (automataai.com.au/blog/claude-pricing-australia-2026-every-plan-aud).
// - ChatGPT: OpenAI has no AUD price list; Australian consumer accounts are billed in USD and
//   OpenAI adds 10% GST. Plus US$20, Pro US$100 (launched 9 Apr 2026; the account token's plan
//   slug is "prolite"), Pro US$200 ("pro"), Go US$8 ("go").
export const DEFAULT_PRICES: DefaultPrice[] = [
  {
    id: "claude-max-20x",
    label: "Claude Max 20x",
    amount: 340,
    currency: "AUD",
    gstIncluded: true,
    source: "Anthropic AU checkout price A$309.09 + A$30.91 GST (recorded 11 Sep 2026)",
  },
  {
    id: "chatgpt-plus",
    label: "ChatGPT Plus",
    amount: 20,
    currency: "USD",
    gstIncluded: false,
    source: "OpenAI US$20/month; Australian accounts billed in USD + 10% GST",
  },
  {
    id: "chatgpt-pro-100",
    label: "ChatGPT Pro (US$100 tier)",
    amount: 100,
    currency: "USD",
    gstIncluded: false,
    source: "OpenAI Pro US$100/month (plan slug “prolite”); billed in USD + 10% GST",
  },
  {
    id: "chatgpt-pro-200",
    label: "ChatGPT Pro (US$200 tier)",
    amount: 200,
    currency: "USD",
    gstIncluded: false,
    source: "OpenAI Pro US$200/month (plan slug “pro”); billed in USD + 10% GST",
  },
  {
    id: "chatgpt-go",
    label: "ChatGPT Go",
    amount: 8,
    currency: "USD",
    gstIncluded: false,
    source: "OpenAI Go US$8/month; billed in USD + 10% GST",
  },
  {
    id: "elevenlabs-plan",
    label: "ElevenLabs plan",
    amount: null,
    currency: "USD",
    gstIncluded: false,
    source: "Not set: the configured key can't read the plan (no user_read permission)",
  },
  {
    // Not a monthly plan (UI-truth L5): the account auto tops up this amount whenever its API
    // balance falls below US$1. The id stays "higgsfield-plan" so a saved amount carries over.
    id: "higgsfield-plan",
    label: "Higgsfield auto top-up (each)",
    amount: null,
    currency: "USD",
    gstIncluded: false,
    source: "Not set: the amount of one auto top-up (Higgsfield has no plan or balance API)",
  },
];

/** The price setting a ChatGPT plan slug (from the token or the usage API) is billed at. */
export function chatgptPriceId(planSlug: string | null | undefined): string | null {
  switch ((planSlug ?? "").toLowerCase()) {
    case "plus":
      return "chatgpt-plus";
    case "prolite":
    case "pro_lite":
      return "chatgpt-pro-100";
    case "pro":
      return "chatgpt-pro-200";
    case "go":
      return "chatgpt-go";
    default:
      return null;
  }
}

export function chatgptPlanName(planSlug: string | null | undefined): string {
  switch ((planSlug ?? "").toLowerCase()) {
    case "plus":
      return "ChatGPT Plus";
    case "prolite":
    case "pro_lite":
      return "ChatGPT Pro (US$100 tier)";
    case "pro":
      return "ChatGPT Pro (US$200 tier)";
    case "go":
      return "ChatGPT Go";
    case "":
      return "ChatGPT (plan unknown)";
    default:
      return `ChatGPT ${planSlug}`;
  }
}

// ── Anthropic API list prices, US$ per million tokens ─────────────────────────────────────────
// Used to show what Claude Code transcript tokens would cost on the API (the Max plan covers them;
// this is value, never spend). Two sources, merged below:
//   1. The router catalogue (scripts/model-router/catalogue.json): input/output for every Claude
//      model the OS can route today come from its apiListUsdPerM, with priceAsOf.
//   2. HISTORICAL_CLAUDE_API_PRICES: models no longer routable (not in the catalogue) that still
//      appear in old session transcripts. Justified exception: the catalogue only holds routable ids.
// Cache rates are not in the catalogue: reads are 0.1× input except Fable 5.1 (US$0.25) and Opus 5.5
// (US$0.20); 5-minute cache writes 1.25× input, 1-hour writes 2× (Anthropic pricing, cached 24 Jun
// 2026). Current models have no long-context ([1m]) premium.
export type TokenPrice = { input: number; output: number; cacheRead: number; write5m: number; write1h: number };

const price = (input: number, output: number, cacheRead = input * 0.1): TokenPrice => ({
  input,
  output,
  cacheRead,
  write5m: input * 1.25,
  write1h: input * 2,
});

/**
 * HISTORICAL table: Claude models that are not routable (so not in the router catalogue) but still
 * appear in old Claude Code transcripts, priced at Anthropic's API list rates (cached 24 Jun 2026).
 * Only for costing past sessions. A model that becomes routable belongs in catalogue.json instead,
 * and the catalogue's price wins over this table.
 */
export const HISTORICAL_CLAUDE_API_PRICES: Record<string, TokenPrice> = {
  "claude-mythos-5-1": price(10, 50, 0.25),
  "claude-mythos-5": price(10, 50, 1),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-opus-4-5": price(5, 25),
  "claude-sonnet-4-6": price(3, 15),
  "claude-sonnet-4-5": price(3, 15),
};

/** Cache-read rates that are not 0.1× input (Anthropic pricing, cached 24 Jun 2026). */
const CACHE_READ_OVERRIDE: Record<string, number> = { "claude-fable-5-1": 0.25, "claude-opus-5-5": 0.2, "claude-fable-5": 1 };

/** The API list value (input/output US$ per M) the catalogue records for a Claude model, or null. */
function listPrice(m: CatalogueModel): [number, number] | null {
  if (m.cost.basis === "catalogue_price" && typeof m.cost.inputUsdPerM === "number" && typeof m.cost.outputUsdPerM === "number")
    return [m.cost.inputUsdPerM, m.cost.outputUsdPerM];
  return m.cost.apiListUsdPerM ?? null;
}

/** Claude models in the router catalogue (by the provider's own id), priced from the catalogue. */
export function catalogueClaudePrices(): Record<string, TokenPrice & { priceAsOf: string | null }> {
  const out: Record<string, TokenPrice & { priceAsOf: string | null }> = {};
  for (const m of catalogue().models) {
    if (m.provider !== "claude-sub") continue;
    const lp = listPrice(m);
    if (!lp) continue;
    out[m.providerModel] = { ...price(lp[0], lp[1], CACHE_READ_OVERRIDE[m.providerModel]), priceAsOf: m.cost.priceAsOf ?? null };
  }
  return out;
}

/** Every Claude price the usage page knows: the catalogue's, over the historical table. */
export const CLAUDE_API_PRICES: Record<string, TokenPrice> = {
  ...HISTORICAL_CLAUDE_API_PRICES,
  ...Object.fromEntries(
    Object.entries(catalogueClaudePrices())
      // Dated spellings resolve to their base id in claudePriceKey, so only base ids are keys.
      .filter(([id]) => !/-\d{8}$/.test(id))
      .map(([id, { priceAsOf: _asOf, ...p }]) => [id, p]),
  ),
};

/**
 * The per-token price a catalogue model is CHARGED at (catalogue_price basis only), with its date.
 * Accepts a catalogue id ("openrouter/mimo-v2.6-flash") or a provider id with its provider.
 * Null when the model is free, on a plan, credit-billed or has no recorded price: unknown stays unknown.
 */
export function catalogueTokenPrice(
  id: string,
  provider?: string,
): { inputUsdPerM: number; outputUsdPerM: number; priceAsOf: string } | null {
  const m = catalogue().models.find((x) => (provider ? x.provider === provider && x.providerModel === id : x.id === id));
  if (!m || m.route !== "metered" || m.cost.basis !== "catalogue_price") return null;
  const c = m.cost;
  if (typeof c.inputUsdPerM !== "number" || typeof c.outputUsdPerM !== "number" || !c.priceAsOf) return null;
  return { inputUsdPerM: c.inputUsdPerM, outputUsdPerM: c.outputUsdPerM, priceAsOf: c.priceAsOf };
}

/** "claude-opus-5[1m]" / "claude-haiku-4-5-20251001" → the price-table id, or null if unpriced. */
export function claudePriceKey(model: string): string | null {
  const base = model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .trim();
  if (CLAUDE_API_PRICES[base]) return base;
  // Claude Code's bare aliases resolve to the current model of each family.
  return CLAUDE_ALIASES[base] ?? null;
}

const CLAUDE_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
};

/** US$ the tokens would cost at API list prices; null when the model has no known price. */
export function claudeApiCostUsd(model: string, t: TokenCounts): number | null {
  const key = claudePriceKey(model);
  if (!key) return null;
  const p = CLAUDE_API_PRICES[key];
  return (
    (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.write5m * p.write5m + t.write1h * p.write1h) /
    1_000_000
  );
}

// ── Groq free tier (per model, per day) ───────────────────────────────────────────────────────
// Used only when Groq hasn't returned its own x-ratelimit headers yet. Source: Groq console
// limits page for the free plan, as recorded in the OS's notes (chat 1,000 req/day, Whisper
// 2,000 req/day, Orpheus TTS 100 req/day).
export const GROQ_FREE_DAILY_REQUESTS: Record<string, number> = {
  chat: 1000,
  transcription: 2000,
  speech: 100,
};

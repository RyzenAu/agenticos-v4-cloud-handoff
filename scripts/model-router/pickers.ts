// scripts/model-router/pickers.ts — model pickers and UI model lists, derived from the catalogue
// (Stage E2 group D). Browser-safe: catalogue.ts only imports JSON, so src/** can import this too.
//
// Every picker in the OS asks here instead of hard-coding provider ids. The rules:
//   - E2 moves ids into the catalogue; it never removes or narrows an option. Each picker keeps
//     the models, order and default it offered before E2, now named by CATALOGUE id below. Most of
//     those are owner-choosable entries: listed for the owner to pick, NOT routed by any router
//     task. Catalogue models added since (routable chat models of the same provider) are appended.
//   - only routable models (status verified or configured) are shown. A stale/excluded model is
//     hidden only when it was already unusable before E1 (groq/llama-3.3-70b-versatile: absent
//     from the key's model list).
//   - tier: a free route is "free"; a pre-E2 entry keeps its pre-E2 tier; a newer entry is ranked
//     by its catalogue output price, and an unknown price is "mid". A paid model is never "free".
//   - the cost label says who pays: a subscription is never free, a paid model is never free,
//     and a free tier whose billing is unverified says so.
// dataUse is carried as a fact for display only; owner override 28 Sep: nothing is hidden for it.
import {
  catalogue,
  catalogueModel,
  catalogueProvider,
  catalogueTask,
  modelByProviderId,
  type CatalogueModel,
  type DataUse,
  type Route,
} from "./catalogue";

/** "fast" is the Claude Code picker's own word for its quickest models (pre-E2 vocabulary). */
export type PickerTier = "frontier" | "top" | "mid" | "cheap" | "fast" | "free";

export type PickerEntry = {
  /** Catalogue id ("codex/gpt-6-sol"). */
  id: string;
  /** What the picker sends: the Hermes/CLI model name. */
  name: string;
  tier: PickerTier;
  route: Route;
  /** Who pays, in words ("Subscription (plan allowance)", "Metered · US$0.14/US$0.28 per M …"). */
  cost: string;
  /** Human name ("GPT-6 Sol"). */
  label: string;
  tools: boolean;
  dataUse: DataUse;
  /** The per-token price actually charged (catalogue_price models only); null = not metered by token or unknown. */
  price: { inputUsdPerM: number; outputUsdPerM: number; priceAsOf: string } | null;
};

export type PickerGroup = { provider: string; label: string; models: PickerEntry[] };

/**
 * Catalogue provider -> the provider name Hermes (and the existing /__hermes_models consumers)
 * use. Gemini keeps the pre-E2 "googlegemini" name the UI and key detection expect (Hermes'
 * own canonical id is "gemini"). claude-sub and cline-free are the named custom providers in
 * ~/.hermes/config.yaml; local models run on Hermes' "ollama" provider.
 */
export const HERMES_PROVIDER: Readonly<Record<string, string>> = {
  "openai-api": "openai",
  "anthropic-api": "anthropic",
  gemini: "googlegemini",
  openrouter: "openrouter",
  codex: "openai-codex",
  "xai-oauth": "xai-oauth",
  minimax: "minimax",
  sakana: "sakana",
  xai: "xai",
  mistral: "mistral",
  local: "ollama",
  groq: "groq",
  cohere: "cohere",
  "claude-sub": "claude-sub",
  cline: "cline-free",
};

type LegacyPick = readonly [catalogueId: string, tier: PickerTier];

/**
 * The pre-E2 /__hermes_models catalog, group by group and in order, as catalogue ids with their
 * pre-E2 tiers. Owner-choosable, not routed. Groups after `cohere` are catalogue additions.
 */
const HERMES_PICKS: ReadonlyArray<readonly [provider: string, picks: readonly LegacyPick[]]> = [
  ["openai-api", [
    ["openai-api/gpt-6-sol", "frontier"], ["openai-api/gpt-6-astra", "frontier"], ["openai-api/gpt-6-luna", "cheap"],
    ["openai-api/gpt-5.6-sol", "frontier"], ["openai-api/gpt-5.6-terra", "top"], ["openai-api/gpt-5.6-luna", "cheap"],
    ["openai-api/gpt-5.5", "top"], ["openai-api/gpt-5.5-pro", "top"], ["openai-api/gpt-5.3-codex", "mid"], ["openai-api/gpt-5.4-nano", "cheap"],
  ]],
  ["anthropic-api", [
    ["anthropic-api/claude-fable-5", "frontier"], ["anthropic-api/claude-opus-4.8", "top"],
    ["anthropic-api/claude-sonnet-4.6", "mid"], ["anthropic-api/claude-haiku-4.5", "cheap"],
  ]],
  ["gemini", [["gemini/3.1-pro", "top"], ["gemini/3.5-flash", "mid"], ["gemini/3.1-flash-lite", "cheap"]]],
  ["openrouter", [
    ["openrouter/claude-fable-5", "frontier"], ["openrouter/glm-5.2", "top"], ["openrouter/claude-opus-4.8", "top"],
    ["openrouter/claude-sonnet-5", "top"], ["openrouter/gpt-5.6-sol", "frontier"], ["openrouter/gpt-5.6-terra", "top"],
    ["openrouter/gpt-5.6-luna", "cheap"], ["openrouter/gpt-5.5", "top"], ["openrouter/deepseek-v4-pro", "top"],
    ["openrouter/grok-4.5", "top"], ["openrouter/grok-4.3", "mid"], ["openrouter/gemini-3.5-flash", "mid"],
    ["openrouter/minimax-m3", "mid"], ["openrouter/qwen3.7-plus", "mid"], ["openrouter/kimi-k3", "top"],
    ["openrouter/kimi-k2.6", "mid"], ["openrouter/deepseek-v4-flash", "cheap"], ["openrouter/glm-4.7-flash", "cheap"],
    ["openrouter-free/llama-3.3-70b-instruct", "free"],
  ]],
  ["codex", [
    ["codex/gpt-6-sol", "frontier"], ["codex/gpt-6-astra", "frontier"], ["codex/gpt-6-luna", "cheap"],
    ["codex/gpt-5.6-sol", "frontier"], ["codex/gpt-5.6-terra", "top"], ["codex/gpt-5.6-luna", "cheap"],
    ["codex/gpt-5.5", "top"], ["codex/gpt-5.5-pro", "top"], ["codex/gpt-5.3-codex", "mid"],
  ]],
  ["xai-oauth", [["xai-oauth/grok-4.5", "top"], ["xai-oauth/grok-4.3", "mid"], ["xai-oauth/grok-4", "mid"]]],
  ["minimax", [["minimax/minimax-m3", "top"]]],
  ["sakana", [["sakana/fugu-ultra", "top"], ["sakana/fugu", "mid"]]],
  ["xai", [["xai/grok-4.5", "top"], ["xai/grok-4.3", "mid"], ["xai/grok-4", "mid"]]],
  ["mistral", [["mistral/mistral-large-3", "top"], ["mistral/mistral-small-3", "cheap"]]],
  ["local", [["local/llama3.3", "free"], ["local/qwen3", "free"], ["local/deepseek-r1", "free"]]],
  // Stale since before E1 (Enterprise-only, absent from the key's list), so it stays hidden.
  ["groq", [["groq/llama-3.3-70b-versatile", "mid"]]],
  ["cohere", [["cohere/command-a", "top"]]],
  ["claude-sub", []],
  ["cline", []],
];

/** The pre-E2 /__claude_models "claude-code" group (order = pre-E2; the first was the flagship). */
const CLAUDE_CODE_PICKS: readonly LegacyPick[] = [
  ["claude/opus-5", "top"], ["claude/fable-5", "top"], ["claude/opus-4-8", "top"],
  ["claude/sonnet-5", "mid"], ["claude/haiku-4-5-20251001", "fast"],
];

/** The pre-E2 /__claude_models "openai · via codex" group. */
const CODEX_CLI_PICKS: readonly LegacyPick[] = [
  ["codex/gpt-6-sol", "top"], ["codex/gpt-6-astra", "top"], ["codex/gpt-6-luna", "mid"],
  ["codex/gpt-5.6-sol", "top"], ["codex/gpt-5.6-terra", "top"], ["codex/gpt-5.6-luna", "mid"],
  ["codex/gpt-5.5", "mid"], ["codex/gpt-5.3-codex", "fast"],
];

/** The pre-E2 Dream OpenRouter dropdown, with its pre-E2 labels. The first is the default. */
const DREAM_OPENROUTER_PICKS: ReadonlyArray<readonly [catalogueId: string, label: string]> = [
  ["openrouter/claude-fable-5", "Claude Fable 5 · frontier · default"],
  ["openrouter/claude-sonnet-4.6", "Claude Sonnet 4.6 · fast"],
  ["openrouter/gpt-5.5", "OpenAI GPT-5.5"],
  ["openrouter/gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["openrouter/llama-3.3-70b-instruct", "Llama 3.3 70B"],
  ["openrouter/deepseek-chat", "DeepSeek V3"],
];

/** Catalogue models that are not picks: a code fallback id and the owner-selected local slot. */
const NOT_A_PICK = new Set(["codex/gpt-5.6", "local/on-device"]);
/** A model a picker may list: not a code fallback, and not an owner-choice family ("*" providerModel). */
const isPickable = (m: CatalogueModel) => !NOT_A_PICK.has(m.id) && !m.providerModel.includes("*");

export function isRoutable(m: Pick<CatalogueModel, "status">): boolean {
  return m.status === "verified" || m.status === "configured";
}

/** A text-in, text-out chat model (not STT, TTS, image, video or a decision engine). */
export function isChatModel(m: CatalogueModel): boolean {
  return m.modality.in.includes("text") && m.modality.out.length === 1 && m.modality.out[0] === "text";
}

/** Routable chat models, in catalogue order, optionally for one catalogue provider. */
export function routableChatModels(provider?: string): CatalogueModel[] {
  return catalogue().models.filter((m) => isRoutable(m) && isChatModel(m) && (!provider || m.provider === provider));
}

/** The output price the tier is ranked by: the catalogue price, or a subscription's API list value. */
function rankPrice(m: CatalogueModel): number | null {
  if (m.cost.basis === "catalogue_price" && typeof m.cost.outputUsdPerM === "number") return m.cost.outputUsdPerM;
  if (m.cost.apiListUsdPerM) return m.cost.apiListUsdPerM[1];
  return null;
}

/** Tier from route and cost; a pre-E2 entry passes its pre-E2 tier, which is kept unless it would call a paid model free. */
export function pickerTier(m: CatalogueModel, legacy?: PickerTier): PickerTier {
  // validateCatalogue guarantees a free route has cost basis free, so only a free model is "free".
  if (m.route === "free" && m.cost.basis === "free") return "free";
  if (legacy && legacy !== "free") return legacy;
  const out = rankPrice(m);
  if (out === null) return "mid";
  if (out >= 20) return "frontier";
  if (out >= 8) return "top";
  if (out >= 1.5) return "mid";
  return "cheap";
}

const usd = (n: number) => `US$${n < 1 ? String(Number(n.toFixed(4))) : n.toFixed(2).replace(/\.00$/, "")}`;

/** Who pays for one call, in words. Never "free" for a paid route. */
export function pickerCostLabel(m: CatalogueModel): string {
  if (m.route === "free") return catalogueProvider(m.provider).freeVerified ? "Free" : "Free tier (billing unverified)";
  if (m.route === "subscription") return "Subscription (plan allowance)";
  const c = m.cost;
  if (c.basis === "catalogue_price" && typeof c.inputUsdPerM === "number" && typeof c.outputUsdPerM === "number")
    return `Metered · ${usd(c.inputUsdPerM)}/${usd(c.outputUsdPerM)} per M tokens (as of ${c.priceAsOf})`;
  if (c.basis === "credits") return "Metered · credits";
  return "Metered · price unknown";
}

const UPPER = new Set(["gpt", "oss", "glm", "tts", "it", "ai"]);
const BRAND: Record<string, string> = { deepseek: "DeepSeek", mimo: "MiMo", openai: "OpenAI" };

/** "claude-opus-5-5" -> "Claude Opus 5.5", "gpt-6-sol" -> "GPT-6 Sol", "deepseek/deepseek-v4-pro" -> "DeepSeek V4 Pro". */
export function displayName(providerModel: string): string {
  const base = (providerModel.split("/").pop() ?? providerModel).replace(/:free$/, "");
  const out: string[] = [];
  let prevNumeric = false;
  for (const w of base.split("-").filter(Boolean)) {
    const numeric = /^\d+(\.\d+)?$/.test(w);
    if (numeric && prevNumeric) out[out.length - 1] += `.${w}`;
    else if (numeric && out[out.length - 1] === "GPT") out[out.length - 1] += `-${w}`;
    else if (numeric) out.push(w);
    else if (/^\d+(\.\d+)?[bm]$/i.test(w) || /^a\d+b$/i.test(w)) out.push(w.toUpperCase());
    else if (UPPER.has(w.toLowerCase())) out.push(w.toUpperCase());
    else if (BRAND[w.toLowerCase()]) out.push(BRAND[w.toLowerCase()]);
    else out.push(w.charAt(0).toUpperCase() + w.slice(1));
    prevNumeric = numeric;
  }
  return out.join(" ");
}

/** The name Hermes takes for a catalogue model: the Cline bridge name, else the provider's own id. */
export function hermesModelName(m: CatalogueModel): string {
  return m.provider === "cline" ? m.id.slice("cline/".length) : m.providerModel;
}

/** The per-token price a call is charged at, from the catalogue (catalogue_price basis only). */
export function catalogueSpendPrice(m: CatalogueModel): PickerEntry["price"] {
  const c = m.cost;
  if (m.route !== "metered" || c.basis !== "catalogue_price") return null;
  if (typeof c.inputUsdPerM !== "number" || typeof c.outputUsdPerM !== "number" || !c.priceAsOf) return null;
  return { inputUsdPerM: c.inputUsdPerM, outputUsdPerM: c.outputUsdPerM, priceAsOf: c.priceAsOf };
}

function entry(m: CatalogueModel, name: string, legacyTier?: PickerTier): PickerEntry {
  return {
    price: catalogueSpendPrice(m),
    id: m.id,
    name,
    tier: pickerTier(m, legacyTier),
    route: m.route,
    cost: pickerCostLabel(m),
    label: displayName(m.providerModel),
    tools: m.tools,
    dataUse: m.dataUse,
  };
}

/** A picker's pre-E2 entries (routable ones), then the provider's other routable chat models. */
function pickerList(provider: string | null, picks: readonly LegacyPick[], nameOf: (m: CatalogueModel) => string): PickerEntry[] {
  const listed = picks.map(([id, tier]) => [catalogueModel(id), tier] as const);
  const out = listed.filter(([m]) => isRoutable(m)).map(([m, tier]) => entry(m, nameOf(m), tier));
  if (provider === null) return out;
  const seen = new Set(listed.map(([m]) => m.id));
  for (const m of routableChatModels(provider)) if (!seen.has(m.id) && isPickable(m)) out.push(entry(m, nameOf(m)));
  return out;
}

/** The Hermes model picker (/__hermes_models `catalog`), grouped by Hermes provider name, pre-E2 order first. */
export function hermesPickerCatalog(): PickerGroup[] {
  return HERMES_PICKS.map(([p, picks]) => ({
    provider: HERMES_PROVIDER[p],
    label: catalogueProvider(p).label,
    models: pickerList(p, picks, hermesModelName),
  })).filter((g) => g.models.length > 0);
}

/** Claude models on the Claude Code subscription (/__claude_models "claude-code" group). */
export function claudeCodePickerModels(): PickerEntry[] {
  return pickerList("claude-sub", CLAUDE_CODE_PICKS, (m) => m.providerModel);
}

/** GPT models on the ChatGPT/Codex plan (/__claude_models "openai · via codex" group). */
export function codexPickerModels(): PickerEntry[] {
  return pickerList("codex", CODEX_CLI_PICKS, (m) => m.providerModel);
}

/** The Dream OpenRouter dropdown: `{ id: OpenRouter id, label }`, pre-E2 list and labels; the first is the default. */
export function dreamOpenRouterOptions(): { id: string; label: string }[] {
  const out = DREAM_OPENROUTER_PICKS.map(([id, label]) => ({ id: catalogueModel(id).providerModel, label }));
  // The dream.nightly task's own OpenRouter models, if the catalogue adds any beyond the list.
  for (const m of taskModels("dream.nightly", "openrouter").filter(isPickable))
    if (!out.some((o) => o.id === m.providerModel)) out.push({ id: m.providerModel, label: `${displayName(m.providerModel)} · ${pickerCostLabel(m)}` });
  return out;
}

/**
 * Entries for model ids an external config lists (claude-code-router's OpenRouter models). Ids the
 * catalogue knows get its tier and cost label; any other id is kept as before (tier "top"), with
 * a cost label that says the catalogue has no facts for it.
 */
export function ccrPickerModels(providerModels: readonly string[]): Array<Pick<PickerEntry, "name" | "tier" | "cost"> & Partial<PickerEntry>> {
  return providerModels.map((raw) => {
    const id = String(raw);
    const m = modelByProviderId("openrouter", id);
    if (m) return entry(m, id, "top");
    return { name: id, tier: "top" as const, cost: "Via claude-code-router (OpenRouter); not in the catalogue, cost unknown" };
  });
}

/** A task's routable models in order: candidates, then selectable, then last resort. */
export function taskModels(task: string, provider?: string): CatalogueModel[] {
  const t = catalogueTask(task);
  if (!t) throw new Error(`Unknown router task ${task}`);
  const ids = [...new Set([...t.candidates, ...(t.selectable ?? []), ...(t.lastResort ?? [])])];
  return ids.map((id) => catalogueModel(id)).filter((m) => isRoutable(m) && (!provider || m.provider === provider));
}

export type HermesModelRef = { provider: string; name: string };

/** A catalogue model as Hermes names it: `{ provider: Hermes provider, name: Hermes model name }`. */
export function hermesRef(catalogueId: string): HermesModelRef {
  const m = catalogueModel(catalogueId);
  const provider = HERMES_PROVIDER[m.provider];
  if (!provider) throw new Error(`${catalogueId}: Hermes has no provider for ${m.provider}`);
  return { provider, name: hermesModelName(m) };
}

/** Human label for a model id seen in a log or config ("google/gemini-2.5-flash-lite" -> "Gemini 2.5 Flash Lite"), or null if not in the catalogue. */
export function catalogueLabel(providerModel: string | null | undefined, provider?: string): string | null {
  if (!providerModel) return null;
  const m = provider
    ? modelByProviderId(provider, providerModel)
    : catalogue().models.find((x) => x.providerModel === providerModel) ?? null;
  return m ? displayName(m.providerModel) : null;
}

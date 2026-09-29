// scripts/model-router/catalogue.ts — the ONE place model ids live (Stage E1, TARGET-ARCHITECTURE §3.5).
//
// catalogue.json is data; this file validates it (schema test: catalogue.test.ts) and answers
// lookups. Callers ask for a task's model ids instead of hard-coding them, so a stale or excluded
// id is dropped in one place. Every route is labelled honestly: a subscription is not free, and a
// paid model is never labelled free (validate() refuses the file if it is).
import raw from "./catalogue.json";

export type Route = "free" | "subscription" | "metered";
export type CostClass = "free" | "free-promotional" | "subscription" | "metered";
export type ModelStatus = "verified" | "configured" | "stale" | "excluded" | "not-configured";
export type DataUse = "no-training" | "may-train" | "provider-dependent";
export type DataClass = "synthetic" | "public" | "business-internal" | "private";
export type CostBasis =
  | "free"
  | "subscription_allowance"
  | "catalogue_price"
  | "provider_reported"
  | "credits"
  | "unknown";
export type Modality = "text" | "image" | "video" | "audio" | "decision";

export type CatalogueProvider = {
  id: string;
  label: string;
  kind: "api" | "bridge" | "gateway";
  route: Route;
  transport: string;
  /** Env NAMES only (never values). Empty = login-based (CLI/OAuth). */
  keyNames: string[];
  auth: string;
  /** true only when "no charge" is verified (free list membership / free plan headers). */
  freeVerified: boolean;
  dataUse: DataUse;
  limits: string;
  balance: string | null;
  sources: string[];
};

export type CatalogueModel = {
  id: string;
  provider: string;
  providerModel: string;
  route: Route;
  costClass: CostClass;
  /**
   * true only when "no charge" is VERIFIED for this model: Cline's free list, Groq's free plan, OpenRouter's exact
   * `:free` ids at $0. A free-route model without it (Gemini: billing on its projects unverified, and a key in a
   * billed project is charged) is never an AUTOMATIC fallback; it runs only when a task selects it.
   */
  verifiedFree: boolean;
  modality: { in: Modality[]; out: Modality[] };
  tools: boolean;
  status: ModelStatus;
  dataUse: DataUse;
  limits?: string;
  cost: {
    basis: CostBasis;
    inputUsdPerM?: number;
    outputUsdPerM?: number;
    /** API list price, shown as value only, never as spend (subscriptions). */
    apiListUsdPerM?: [number, number];
    /** What a paid tier would cost (free models), for reference only. */
    paidListUsdPerM?: [number, number];
    priceAsOf?: string;
  };
  note?: string;
  lastProbe: { at: string; method: string; result: string } | null;
};

export type CatalogueTask = {
  /** Ordered. The first is the rule-selected primary; later ones are the automatic fallback chain (may include paid). */
  candidates: string[];
  /** Metered/paid models the owner (or Jev, or config) may explicitly select for this task. */
  selectable?: string[];
  /** "configured": the first candidate may be metered (e.g. Jev). Otherwise metered only via selectable. */
  metered?: "configured";
  freeOnly?: boolean;
  sideEffects: boolean;
  needsTools?: boolean;
  /** Present when no other model is an eligible substitute (e.g. a film's narrator voice); shown on failure. */
  noFreeFallback?: string;
  /**
   * Fallbacks that existed in the code before the router (e.g. gemini.ts flash -> a second Gemini model,
   * pro -> free Gemini; free-voice's Gemini brain/TTS legs; vision's Gemini legs). Kept exactly as before even
   * when the model's billing is unverified; receipts record the cost as unknown. The router never adds new ones.
   */
  preExistingFallbacks?: string[];
  /**
   * (E2) Models tried only after every candidate, in order: a subscription or a paid model (e.g. Codex via
   * Hermes after the free Groq models). Never a free model (those belong in candidates). Receipts carry the
   * real route and fallbackFrom.
   */
  lastResort?: string[];
  /**
   * (E2) Documents that the candidates are the task's pre-router fallback order, paid or not (e.g. Claude ->
   * Codex -> Gemini for pointing). The router already lets any candidate be a fallback; this flag records
   * that the order itself pre-dates the router and must not be narrowed.
   */
  fallbackAnyRoute?: boolean;
  /**
   * (E2, REVIEW-E12 BL3) The site always tried its subscription model before the router: the cached
   * /usage window is recorded on the receipt but never makes the router skip the model.
   */
  alwaysTry?: boolean;
  onExhausted: string;
};

export type Catalogue = {
  schema: "mu.model-catalogue/v2";
  updatedAt: string;
  evidence: string;
  rules: Record<string, string>;
  providers: CatalogueProvider[];
  models: CatalogueModel[];
  tasks: Record<string, CatalogueTask>;
};

const ROUTES = new Set<Route>(["free", "subscription", "metered"]);
const STATUSES = new Set<ModelStatus>([
  "verified",
  "configured",
  "stale",
  "excluded",
  "not-configured",
]);
const DATA_USES = new Set<DataUse>(["no-training", "may-train", "provider-dependent"]);
const BASES = new Set<CostBasis>([
  "free",
  "subscription_allowance",
  "catalogue_price",
  "provider_reported",
  "credits",
  "unknown",
]);
const MODALITIES = new Set<Modality>(["text", "image", "video", "audio", "decision"]);
const ROUTE_FOR_CLASS: Record<CostClass, Route> = {
  free: "free",
  "free-promotional": "free",
  subscription: "subscription",
  metered: "metered",
};
const iso = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));
const nonEmpty = (s: unknown) => typeof s === "string" && s.trim().length > 0;

/** Every problem in the file (empty = valid). The honesty rules are part of the schema. */
export function validateCatalogue(c: unknown): string[] {
  const errors: string[] = [];
  const cat = c as Catalogue;
  if (!cat || typeof cat !== "object") return ["catalogue is not an object"];
  if (cat.schema !== "mu.model-catalogue/v2")
    errors.push(`schema must be mu.model-catalogue/v2 (got ${String(cat.schema)})`);
  if (!iso(cat.updatedAt)) errors.push("updatedAt must be an ISO date");
  if (
    !Array.isArray(cat.providers) ||
    !Array.isArray(cat.models) ||
    !cat.tasks ||
    typeof cat.tasks !== "object"
  )
    return [...errors, "providers, models and tasks are required"];
  const providers = new Map<string, CatalogueProvider>();
  for (const p of cat.providers) {
    if (!nonEmpty(p.id) || providers.has(p.id))
      errors.push(`provider id missing or duplicated: ${p.id}`);
    providers.set(p.id, p);
    if (!ROUTES.has(p.route)) errors.push(`provider ${p.id}: route ${p.route}`);
    if (!Array.isArray(p.keyNames) || p.keyNames.some((n) => !/^[A-Z][A-Z0-9_]*$/.test(n)))
      errors.push(`provider ${p.id}: keyNames must be env NAMES`);
    if (!DATA_USES.has(p.dataUse)) errors.push(`provider ${p.id}: dataUse ${p.dataUse}`);
    if (typeof p.freeVerified !== "boolean")
      errors.push(`provider ${p.id}: freeVerified must be boolean`);
    if (p.freeVerified && p.route !== "free")
      errors.push(`provider ${p.id}: freeVerified on a ${p.route} provider`);
  }
  const models = new Map<string, CatalogueModel>();
  for (const m of cat.models) {
    const where = `model ${m.id}`;
    if (!/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(m.id ?? "") || models.has(m.id))
      errors.push(`${where}: id must be provider/name and unique`);
    models.set(m.id, m);
    const p = providers.get(m.provider);
    if (!p) errors.push(`${where}: unknown provider ${m.provider}`);
    if (!nonEmpty(m.providerModel)) errors.push(`${where}: providerModel required`);
    if (!ROUTES.has(m.route)) errors.push(`${where}: route ${m.route}`);
    if (!(m.costClass in ROUTE_FOR_CLASS)) errors.push(`${where}: costClass ${m.costClass}`);
    else if (ROUTE_FOR_CLASS[m.costClass] !== m.route)
      errors.push(`${where}: costClass ${m.costClass} does not match route ${m.route}`);
    if (!STATUSES.has(m.status)) errors.push(`${where}: status ${m.status}`);
    if (!DATA_USES.has(m.dataUse)) errors.push(`${where}: dataUse ${m.dataUse}`);
    if (typeof m.tools !== "boolean") errors.push(`${where}: tools must be boolean`);
    if (typeof m.verifiedFree !== "boolean") errors.push(`${where}: verifiedFree must be boolean`);
    else if (m.verifiedFree && m.route !== "free")
      errors.push(`${where}: verifiedFree on a ${m.route} model`);
    else if (
      m.verifiedFree &&
      p &&
      !p.freeVerified &&
      !(m.provider === "openrouter" && /:free$/.test(m.providerModel))
    )
      errors.push(
        `${where}: verifiedFree needs a verified-free provider or an exact OpenRouter :free id`,
      );

    if (
      !m.modality ||
      !m.modality.in?.length ||
      !m.modality.out?.length ||
      [...m.modality.in, ...m.modality.out].some((x) => !MODALITIES.has(x))
    )
      errors.push(`${where}: modality`);
    if (!m.cost || !BASES.has(m.cost.basis)) errors.push(`${where}: cost.basis`);
    // Honesty: a paid route is never labelled free; a free route carries no charge basis.
    if (m.route !== "free" && m.cost?.basis === "free")
      errors.push(`${where}: a ${m.route} model is labelled free`);
    if (m.route === "free" && m.cost?.basis !== "free")
      errors.push(`${where}: a free model must have cost basis free`);
    if (m.route === "subscription" && m.cost?.basis !== "subscription_allowance")
      errors.push(`${where}: a subscription model's cost basis must be subscription_allowance`);
    if (
      m.route === "free" &&
      /:free$/.test(m.providerModel) === false &&
      m.provider === "openrouter"
    )
      errors.push(`${where}: an OpenRouter free model must use the exact :free id`);
    if (m.provider === "openrouter" && /:free$/.test(m.providerModel) && m.route !== "free")
      errors.push(`${where}: a :free id labelled ${m.route}`);
    if (p && p.route === "subscription" && m.route !== "subscription")
      errors.push(`${where}: subscription provider with a ${m.route} model`);
    if (
      m.cost?.basis === "catalogue_price" &&
      (typeof m.cost.inputUsdPerM !== "number" ||
        typeof m.cost.outputUsdPerM !== "number" ||
        !iso(m.cost.priceAsOf))
    )
      errors.push(`${where}: catalogue_price needs inputUsdPerM, outputUsdPerM and priceAsOf`);
    if (
      m.lastProbe !== null &&
      (!m.lastProbe || !iso(m.lastProbe.at) || !nonEmpty(m.lastProbe.method))
    )
      errors.push(`${where}: lastProbe must be null or {at, method, result}`);
  }
  for (const [name, t] of Object.entries(cat.tasks)) {
    const where = `task ${name}`;
    if (!Array.isArray(t.candidates) || !t.candidates.length) {
      errors.push(`${where}: candidates required`);
      continue;
    }
    if (typeof t.sideEffects !== "boolean") errors.push(`${where}: sideEffects must be boolean`);
    if (!nonEmpty(t.onExhausted)) errors.push(`${where}: onExhausted required`);
    if (t.lastResort !== undefined && !Array.isArray(t.lastResort)) errors.push(`${where}: lastResort must be a list`);
    for (const id of t.lastResort ?? []) {
      const m = models.get(id);
      if (m && m.route === "free") errors.push(`${where}: last resort ${id} is free; list it in candidates`);
      if (t.candidates.includes(id)) errors.push(`${where}: ${id} is both a candidate and a last resort`);
      if (t.freeOnly) errors.push(`${where}: free-only task has a last resort ${id}`);
    }
    for (const id of [...t.candidates, ...(t.selectable ?? []), ...(t.lastResort ?? [])]) {
      const m = models.get(id);
      if (!m) errors.push(`${where}: unknown model ${id}`);
      else if (m.status === "excluded" || m.status === "stale")
        errors.push(`${where}: routes to ${m.status} model ${id}`);
    }
    t.candidates.forEach((id, i) => {
      const m = models.get(id);
      if (!m) return;
      if (t.freeOnly && m.route !== "free")
        errors.push(`${where}: free-only task lists ${m.route} model ${id}`);
      // A metered model may sit in the fallback chain (owner, 28 Sep); as the FIRST candidate it must be configured.
      if (m.route === "metered" && i === 0 && t.metered !== "configured")
        errors.push(
          `${where}: metered model ${id} as the first candidate must be configured (metered: "configured") or in selectable`,
        );
    });
    for (const id of t.preExistingFallbacks ?? [])
      if (!t.candidates.includes(id))
        errors.push(`${where}: preExistingFallbacks ${id} must be in candidates`);
    for (const id of t.selectable ?? []) {
      const m = models.get(id);
      if (m && t.freeOnly)
        errors.push(`${where}: free-only task has a selectable ${m.route} model ${id}`);
    }
  }
  return errors;
}

let cached: Catalogue | null = null;

/** The validated catalogue. Throws (at startup, not mid-call) if the file breaks a rule. */
export function catalogue(): Catalogue {
  if (cached) return cached;
  const errors = validateCatalogue(raw);
  if (errors.length) throw new Error(`model catalogue invalid: ${errors.slice(0, 5).join("; ")}`);
  cached = raw as Catalogue;
  return cached;
}

export function catalogueModel(id: string): CatalogueModel {
  const m = catalogue().models.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown catalogue model ${id}`);
  return m;
}

export function catalogueProvider(id: string): CatalogueProvider {
  const p = catalogue().providers.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown catalogue provider ${id}`);
  return p;
}

export function catalogueTask(name: string): CatalogueTask | null {
  return catalogue().tasks[name] ?? null;
}

/** The provider's own id for a catalogue model (what goes in the request body). */
export function providerModelId(id: string): string {
  return catalogueModel(id).providerModel;
}

/** A catalogue model by the provider's own id (e.g. "openai/gpt-oss-120b" on groq). */
export function modelByProviderId(provider: string, providerModel: string): CatalogueModel | null {
  return (
    catalogue().models.find((m) => m.provider === provider && m.providerModel === providerModel) ??
    null
  );
}

/**
 * The routable provider ids for a task on one provider, in order. For call sites that still loop
 * over one provider's models themselves (screen-hands, free-voice): the ids come from here, and
 * stale or excluded models are dropped.
 */
export function taskChain(task: string, provider: string): string[] {
  const t = catalogueTask(task);
  if (!t) throw new Error(`Unknown router task ${task}`);
  return t.candidates
    .map((id) => catalogueModel(id))
    .filter(
      (m) => m.provider === provider && (m.status === "verified" || m.status === "configured"),
    )
    .map((m) => m.providerModel);
}

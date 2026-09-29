// Pure view model for System > Models: joins the router's catalogue, health and receipt totals
// (GET /__operator/model-router) with the provider balances and plan windows /usage already reads
// (GET /__ai_usage). No caps: exhaustion is shown as the provider's own balance, usage and failure.
import type { ModelRouterView } from "../../../scripts/model-router/api";
import type {
  CatalogueModel,
  CatalogueProvider,
  Route,
} from "../../../scripts/model-router/catalogue";
import type { ModelHealth } from "../../../scripts/model-router/health";
import type { ModelUsage } from "../../../scripts/model-router/receipts";
import type { AiUsageSnapshot, ApiKeyRow, SubscriptionCard } from "../../../scripts/ai-usage/types";
import { allowanceFromSnapshot } from "../../../scripts/model-router/allowance";
import { fmtDateTime, fmtTime } from "../../lib/format";

export type Tone = "neutral" | "success" | "warn" | "danger" | "info";

/** Honest route labels: a subscription is not free, and a free tier whose billing is unverified says so. */
export function routeLabel(
  route: Route,
  verified: { verifiedFree: boolean },
): { label: string; tone: Tone; title: string } {
  if (route === "free")
    return verified.verifiedFree
      ? {
          label: "Free",
          tone: "success",
          title: "No charge: verified free list, free plan or an exact $0 :free id.",
        }
      : {
          label: "Free tier, billing unverified",
          tone: "info",
          title:
            "Free tier on the provider's price list, but whether the key's project has billing linked is unverified: cost is recorded as unknown. The router never ADDS it as a new automatic fallback; fallbacks that pre-date the router (e.g. vision, voice and Gemini flash) are kept as they were.",
        };
  if (route === "subscription")
    return {
      label: "Subscription",
      tone: "neutral",
      title: "Draws a flat-fee plan's allowance. Not free: it uses the plan's limits.",
    };
  return {
    label: "Metered",
    tone: "warn",
    title: "Charged per token, character or credit against a funded key or prepaid balance.",
  };
}

const HEALTH: Record<ModelHealth["state"], { label: string; tone: Tone }> = {
  ok: { label: "Healthy", tone: "success" },
  limited: { label: "Limited", tone: "warn" },
  exhausted: { label: "Out of funds", tone: "danger" },
  down: { label: "Failing", tone: "danger" },
  unlisted: { label: "Not listed", tone: "danger" },
  unknown: { label: "Not checked", tone: "neutral" },
};

export function healthLabel(
  model: CatalogueModel,
  health: ModelHealth | undefined,
  now: number,
): { label: string; tone: Tone; detail: string | null } {
  if (model.status === "not-configured")
    return { label: "Not configured", tone: "neutral", detail: null };
  if (model.status === "stale")
    return { label: "Stale id", tone: "danger", detail: model.note ?? null };
  if (model.status === "excluded")
    return { label: "Excluded", tone: "neutral", detail: model.note ?? null };
  const h = health ?? {
    state: "unknown",
    until: null,
    lastProbe: null,
    lastFailure: null,
    detail: null,
  };
  const expired =
    (h.state === "limited" || h.state === "exhausted" || h.state === "down") &&
    h.until !== null &&
    Date.parse(h.until) <= now;
  const base = HEALTH[expired ? "ok" : h.state];
  const until =
    !expired && h.until
      ? ` until ${fmtDateTime(new Date(h.until), { weekday: true })}`
      : "";
  return { label: `${base.label}${until}`, tone: base.tone, detail: h.detail };
}

const USAGE_PROVIDER: Record<string, string> = {
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  elevenlabs: "ElevenLabs",
  groq: "Groq",
  gemini: "Google Gemini",
  typesafe: "TypeSafe (Jev)",
  higgsfield: "Higgsfield",
};
const SUB_PROVIDER: Record<string, SubscriptionCard["provider"]> = {
  "claude-sub": "anthropic",
  codex: "openai",
  hermes: "openai",
};

export type ProviderFacts = {
  provider: CatalogueProvider;
  route: ReturnType<typeof routeLabel>;
  /** Balance / key limit lines from /usage (verbatim provider figures). */
  balance: { text: string; tone: Tone; source: string; checkedAt: string | null }[];
  /** Plan windows from /usage (subscriptions). */
  windows: { text: string; usedPct: number | null; tone: Tone }[];
  lastProbe: { at: string; method: string; result: string } | null;
  /** Set when funds or limits are exhausted or the provider is failing: shown with balance, usage and failure. */
  alert: { title: string; failure: string | null } | null;
  models: ModelFacts[];
};

export type ModelFacts = {
  model: CatalogueModel;
  route: ReturnType<typeof routeLabel>;
  health: ReturnType<typeof healthLabel>;
  lastProbe: { at: string; method: string; result: string } | null;
  /** "health": a router probe; "catalogue": only the catalogue listing check (not a health check). */
  probeSource: "health" | "catalogue" | null;
  usage: ModelUsage | null;
  cost: string;
  failures: string | null;
  tasks: string[];
};

const money = (n: number) => `US$${n < 1 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const toneFor = (status: ApiKeyRow["status"]): Tone =>
  status === "danger"
    ? "danger"
    : status === "warn"
      ? "warn"
      : status === "unavailable"
        ? "neutral"
        : "info";

function costText(model: CatalogueModel, route: Route, usage: ModelUsage | null): string {
  if (route === "subscription") return "Plan allowance (no per-call cash)";
  if (route === "free" && usage?.calls && usage.costUsd > 0)
    return `${money(usage.costUsd)} reported by the provider`;
  if (route === "free") return model.verifiedFree ? "Free" : "Free tier, billing unverified";
  if (!usage || !usage.calls) return "No metered calls";
  const known = money(usage.costUsd);
  return usage.unknownCostCalls
    ? `${known} + ${usage.unknownCostCalls} call${usage.unknownCostCalls === 1 ? "" : "s"} unknown`
    : known;
}

function failureText(usage: ModelUsage | null, health: ModelHealth | undefined): string | null {
  const f =
    usage?.lastFailure ??
    (health?.lastFailure
      ? {
          at: health.lastFailure.at,
          errorCode: health.lastFailure.errorCode,
          httpStatus: health.lastFailure.httpStatus,
          outcome: "failed",
        }
      : null);
  if (!f) return null;
  const when = fmtDateTime(new Date(f.at));
  const count = usage?.failures ? `${usage.failures} failed · ` : "";
  return `${count}last ${String(f.errorCode ?? f.outcome).replace(/_/g, " ")}${f.httpStatus ? ` (HTTP ${f.httpStatus})` : ""}, ${when}`;
}

const EXHAUSTED = new Set(["insufficient_funds", "quota_exhausted", "rate_limited", "auth"]);

export function modelsFacts(
  view: ModelRouterView,
  usage: AiUsageSnapshot | null | undefined,
  now = Date.now(),
): ProviderFacts[] {
  const tasksFor = new Map<string, string[]>();
  for (const [task, t] of Object.entries(view.catalogue.tasks))
    for (const id of [...t.candidates, ...(t.selectable ?? [])])
      tasksFor.set(id, [...(tasksFor.get(id) ?? []), task]);

  return view.catalogue.providers.map((provider) => {
    const models = view.catalogue.models
      .filter((m) => m.provider === provider.id)
      .map((m): ModelFacts => {
        const h = view.health.models[m.id];
        const u = view.usage[m.id] ?? null;
        return {
          model: m,
          route: routeLabel(m.route, m),
          health: healthLabel(m, h, now),
          lastProbe: h?.lastProbe ?? m.lastProbe,
          probeSource: h?.lastProbe ? "health" : m.lastProbe ? "catalogue" : null,
          usage: u,
          cost: costText(m, m.route, u),
          failures: failureText(u, h),
          tasks: tasksFor.get(m.id) ?? [],
        };
      });

    const keyRows = (usage?.apiKeys ?? []).filter(
      (k) => k.provider === USAGE_PROVIDER[provider.id],
    );
    const balance = keyRows.map((k) => ({
      text: [k.limit, k.usage].filter((x) => x && x !== "—").join(" · ") || k.note,
      tone: toneFor(k.status),
      source: k.freshness.source,
      checkedAt: k.freshness.checkedAt,
    }));
    const subs = (usage?.subscriptions ?? []).filter(
      (s) => s.provider === SUB_PROVIDER[provider.id],
    );
    const windows = subs.flatMap((s): ProviderFacts["windows"] =>
      s.status.ok
        ? s.status.windows.map((w) => ({
            text: `${s.owner} · ${s.plan} · ${w.label} ${Math.round(w.usedPercent)}%${w.resetsAt ? ` (resets ${fmtDateTime(new Date(w.resetsAt), { weekday: true })})` : ""}`,
            usedPct: w.usedPercent,
            tone: (w.usedPercent >= 95
              ? "danger"
              : w.usedPercent >= 80
                ? "warn"
                : "neutral") as Tone,
          }))
        : [
            {
              text: `${s.owner} · ${s.plan}: ${s.status.reason}`,
              usedPct: null,
              tone: "neutral" as Tone,
            },
          ],
    );

    const ph = view.health.providers[provider.id];
    const exhaustedModels = models.filter((m) => {
      const h = view.health.models[m.model.id];
      return (
        h &&
        (h.state === "exhausted" || h.state === "limited") &&
        (!h.until || Date.parse(h.until) > now)
      );
    });
    const recentFailure = models
      .map((m) => m.usage?.lastFailure)
      .filter(
        (f): f is NonNullable<ModelUsage["lastFailure"]> =>
          !!f && !!f.errorCode && EXHAUSTED.has(f.errorCode) && now - Date.parse(f.at) < 86_400_000,
      )
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    let alert: ProviderFacts["alert"] = null;
    // A pooled plan (Codex) is exhausted only when every readable account is: use the same reading route() uses.
    const pool = usage ? allowanceFromSnapshot(usage, provider.id) : null;
    const planSpent = pool !== null && pool.usedPct !== null && pool.usedPct >= 95;
    if (balance.some((b) => b.tone === "danger") || planSpent)
      alert = {
        title: "Funds or plan limit exhausted",
        failure: recentFailure
          ? `${recentFailure.errorCode!.replace(/_/g, " ")}${recentFailure.httpStatus ? ` (HTTP ${recentFailure.httpStatus})` : ""}`
          : null,
      };
    else if (exhaustedModels.length || recentFailure)
      alert = {
        title: exhaustedModels.some((m) => view.health.models[m.model.id]?.state === "exhausted")
          ? "Out of funds"
          : "Limited",
        failure: recentFailure
          ? `${recentFailure.errorCode!.replace(/_/g, " ")}${recentFailure.httpStatus ? ` (HTTP ${recentFailure.httpStatus})` : ""} at ${fmtTime(new Date(recentFailure.at))}`
          : exhaustedModels.map((m) => `${m.model.id}: ${m.health.label}`).join("; "),
      };
    else if (ph?.failure) alert = { title: "Provider check failing", failure: ph.failure.detail };

    return {
      provider,
      route: routeLabel(provider.route, { verifiedFree: provider.freeVerified }),
      balance,
      windows,
      lastProbe: ph?.lastProbe ?? null,
      alert,
      models,
    };
  });
}

export function modelsSummary(facts: ProviderFacts[]) {
  const models = facts
    .flatMap((p) => p.models)
    .filter((m) => m.model.status === "verified" || m.model.status === "configured");
  const count = (r: Route) => models.filter((m) => m.model.route === r).length;
  return {
    free: models.filter((m) => m.model.route === "free" && m.model.verifiedFree).length,
    freeUnverified: models.filter((m) => m.model.route === "free" && !m.model.verifiedFree).length,
    subscription: count("subscription"),
    metered: count("metered"),
    attention:
      facts.filter((p) => p.alert).length + models.filter((m) => m.health.tone === "danger").length,
    failures: models.reduce((n, m) => n + (m.usage?.failures ?? 0), 0),
    calls: models.reduce((n, m) => n + (m.usage?.calls ?? 0), 0),
  };
}

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-AU");

/**
 * One plain line under "Needing attention": how many calls failed in the 30 days and where, so
 * "4 failed of 226 calls" is never a bare number: the share of calls, and the provider with most of
 * the failures. Counts are router receipts, so they are a floor.
 */
export function failureLine(facts: ProviderFacts[], summary: Pick<ReturnType<typeof modelsSummary>, "failures" | "calls">): string {
  if (!summary.calls) return "No calls recorded in the last 30 days.";
  if (!summary.failures) return `No failed calls in ${fmtNum(summary.calls)} (30 days).`;
  const pct = (summary.failures / summary.calls) * 100;
  const share = pct < 1 ? "under 1%" : `about ${Math.round(pct)}%`;
  const byProvider = facts
    .map((p) => ({ label: p.provider.label, failures: p.models.reduce((n, m) => n + (m.usage?.failures ?? 0), 0) }))
    .filter((p) => p.failures > 0)
    .sort((a, b) => b.failures - a.failures);
  const where = byProvider.length ? ` Most on ${byProvider[0].label}.` : "";
  return `${fmtNum(summary.failures)} of ${fmtNum(summary.calls)} calls failed in 30 days (${share}).${where}`;
}

/** The Models page's one headline sentence: how many routes, by kind; plain words while nothing is listed. */
export function modelsHeadline(summary: Pick<ReturnType<typeof modelsSummary>, "free" | "freeUnverified" | "subscription" | "metered">, hollow: boolean): string {
  if (hollow) return "Every model route the OS can use, and how each one is doing.";
  const total = summary.free + summary.freeUnverified + summary.subscription + summary.metered;
  const free = summary.free + summary.freeUnverified;
  return `${fmtNum(total)} model routes: ${fmtNum(free)} free, ${fmtNum(summary.subscription)} on a plan, ${fmtNum(summary.metered)} metered.`;
}

/**
 * A catalogue answer that lists no usable model at all (REVIEW-T1 R2, low item): the counts are "Unknown",
 * never a "Live" 0 / 0 / 0. A real, read zero in one route beside models in another stays a zero.
 */
export function catalogueHollow(summary: Pick<ReturnType<typeof modelsSummary>, "free" | "freeUnverified" | "subscription" | "metered">): boolean {
  return summary.free + summary.freeUnverified + summary.subscription + summary.metered === 0;
}

/**
 * Where a model's "last check" date comes from (audit F3-11): a health probe the router ran, or only
 * the catalogue's listing check. A listing is not a health check, so it is labelled "Listed …".
 */
export function lastCheckText(
  m: Pick<ModelFacts, "lastProbe" | "probeSource">,
  fmt: (iso: string) => string,
): { text: string; title: string | undefined } {
  if (!m.lastProbe) return { text: "—", title: "No check recorded" };
  const title = `${m.lastProbe.method}: ${m.lastProbe.result}`;
  return m.probeSource === "catalogue"
    ? { text: `Listed ${fmt(m.lastProbe.at)}`, title: `Catalogue listing, not a health check. ${title}` }
    : { text: fmt(m.lastProbe.at), title };
}

/** The page's filters (audit F3-10): the four signal tiles' groups, plus a text search. */
export type ModelsFilter = "all" | "free" | "subscription" | "metered" | "attention";

const matches = (p: ProviderFacts, m: ModelFacts, q: string) =>
  !q ||
  [m.model.id, m.model.providerModel, p.provider.label, p.provider.id, ...m.tasks].some((s) =>
    String(s ?? "").toLowerCase().includes(q),
  );

/** Providers and models that pass the filter and search, dropping providers left empty. Pure. */
export function filterModels(facts: ProviderFacts[], filter: ModelsFilter, query = ""): ProviderFacts[] {
  const q = query.trim().toLowerCase();
  if (filter === "all" && !q) return facts;
  return facts
    .map((p) => {
      const models = p.models.filter((m) => {
        if (!matches(p, m, q)) return false;
        if (filter === "free" || filter === "subscription" || filter === "metered") return m.model.route === filter;
        if (filter === "attention") return m.health.tone === "danger" || !!p.alert;
        return true;
      });
      return { ...p, models };
    })
    .filter((p) => p.models.length > 0 || (filter === "attention" && !!p.alert && !q));
}

/** A provider none of whose models ran in the 30-day window and that has nothing to flag: collapsed by default. */
export function providerIsQuiet(p: ProviderFacts): boolean {
  return !p.alert && p.models.length > 0 && p.models.every((m) => !m.usage?.calls && m.health.tone !== "danger");
}

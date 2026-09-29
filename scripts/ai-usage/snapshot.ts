// Builds the AI usage & spend snapshot served at /__ai_usage.
//
// Provider reads are cached for 15 minutes each (FX for 12 hours); rebuilding the snapshot from
// the cache is cheap, so a price edit shows immediately without calling any provider again.
// Owner-editable prices and account names live in .operator-data/ai-usage.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fmtDay, fmtMoney } from "../../src/lib/format";
import { localDay, type CallCounts } from "./call-counter";
import { codexOwner, monthInfo, projectMonth, toAud, usdToAud, type MonthInfo } from "./parsers";
import { DEFAULT_PRICES, GROQ_FREE_DAILY_REQUESTS, chatgptPlanName, chatgptPriceId, claudeApiCostUsd, claudePriceKey } from "./prices";
import {
  configuredKeyNames,
  fetchClaudePlan,
  fetchCodexUsage,
  fetchDeepseek,
  fetchElevenLabs,
  fetchFx,
  fetchOpenRouterKey,
  fetchPinecone,
  fetchRetell,
  fileKey,
  readCodexPool,
  type Result,
} from "./sources";
import type { TranscriptTotals } from "./transcripts";
import { meteredSpendByProvider, readAllReceipts, type RouterReceipt } from "../model-router/receipts";
import type { AiUsageSnapshot, ApiKeyRow, ClaudeModelRow, Freshness, FxRate, Money, PriceSetting, SubscriptionCard } from "./types";

export const PROVIDER_TTL_MS = 15 * 60 * 1000;
const FX_TTL_MS = 12 * 60 * 60 * 1000;

// ── Settings ───────────────────────────────────────────────────────────────────────────────────

export type UsageSettings = {
  version: 1;
  prices: Record<string, { amount: number | null; currency: "AUD" | "USD"; gstIncluded: boolean }>;
  /** Pool label ("openai-1") → owner name shown on the card. */
  owners: Record<string, string>;
  lastFx?: FxRate;
};

export const blankSettings = (): UsageSettings => ({ version: 1, prices: {}, owners: {} });

export function readSettings(file: string): UsageSettings {
  try {
    if (!existsSync(file)) return blankSettings();
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== 1) return blankSettings();
    return { ...blankSettings(), ...data };
  } catch {
    return blankSettings();
  }
}

export function writeSettings(file: string, settings: UsageSettings) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}

/** Validates a POSTed settings patch. Throws a readable error; returns the merged settings. */
export function applySettingsPatch(current: UsageSettings, patch: unknown): UsageSettings {
  const p = patch as any;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Send a JSON object.");
  // Only the settings that exist: {"budget":"lots"} used to answer 200 and change nothing (Audit F5 P2-3).
  const unknown = Object.keys(p).filter((key) => key !== "prices" && key !== "owners");
  if (unknown.length) throw new Error(`Unknown setting: ${unknown.slice(0, 3).join(", ")}. Only prices and owners can be changed.`);
  const next: UsageSettings = { ...current, prices: { ...current.prices }, owners: { ...current.owners } };
  if (p.prices !== undefined) {
    if (!p.prices || typeof p.prices !== "object") throw new Error("prices must be an object.");
    for (const [id, raw] of Object.entries(p.prices as Record<string, any>)) {
      if (!DEFAULT_PRICES.some((d) => d.id === id)) throw new Error(`Unknown price "${id}".`);
      if (raw === null) {
        delete next.prices[id]; // back to the published default
        continue;
      }
      const amount = raw?.amount === null ? null : Number(raw?.amount);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 100_000)) throw new Error("Enter a price between 0 and 100,000.");
      if (raw?.currency !== "AUD" && raw?.currency !== "USD") throw new Error("Currency must be AUD or USD.");
      next.prices[id] = { amount: amount === null ? null : Math.round(amount * 100) / 100, currency: raw.currency, gstIncluded: raw.gstIncluded === true };
    }
  }
  if (p.owners !== undefined) {
    if (!p.owners || typeof p.owners !== "object") throw new Error("owners must be an object.");
    for (const [label, name] of Object.entries(p.owners as Record<string, unknown>)) {
      if (!/^[\w.-]{1,40}$/.test(label)) throw new Error("Unknown account.");
      if (name === null || name === "") delete next.owners[label];
      else if (typeof name === "string" && name.trim().length <= 40) next.owners[label] = name.trim();
      else throw new Error("Names must be 40 characters or fewer.");
    }
  }
  return next;
}

const money = (p: Pick<PriceSetting, "amount" | "currency">) => (p.amount === null ? null : `${p.currency === "USD" ? "US$" : "A$"}${p.amount}`);

/** Higgsfield's billing in words: an auto top-up of a set amount, never a monthly plan. */
export function higgsfieldTopUpNote(p: Pick<PriceSetting, "amount" | "currency"> | undefined): string {
  const each = p ? money(p) : null;
  return each
    ? `Auto top-up: ${each} is charged each time the API balance falls below US$1, with no monthly plan and no hard cap. Top-ups this month aren't readable, so they're listed as unknown, not a fixed cost.`
    : "Billed by auto top-up (no monthly plan); set the amount of one top-up below.";
}

export function higgsfieldUnknownLabel(p: Pick<PriceSetting, "amount" | "currency">): string {
  const each = money(p);
  return `Higgsfield auto top-ups (${each ? `${each} each` : "amount not set"} whenever the balance is under US$1; count this month not readable)`;
}

export function priceSettings(settings: UsageSettings): PriceSetting[] {
  return DEFAULT_PRICES.map((d) => {
    const o = settings.prices[d.id];
    return {
      id: d.id,
      label: d.label,
      amount: o ? o.amount : d.amount,
      currency: o ? o.currency : d.currency,
      gstIncluded: o ? o.gstIncluded : d.gstIncluded,
      source: o ? "Set by you" : d.source,
      edited: Boolean(o),
    };
  });
}

// ── Provider cache ────────────────────────────────────────────────────────────────────────────

type Cached<T> = { at: number; value: T };

export function createProviderCache(now: () => number = Date.now) {
  const store = new Map<string, Cached<unknown>>();
  const inflight = new Map<string, Promise<unknown>>();
  return {
    async get<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ value: T; at: number }> {
      const hit = store.get(key) as Cached<T> | undefined;
      if (hit && now() - hit.at < ttl) return { value: hit.value, at: hit.at };
      let p = inflight.get(key) as Promise<T> | undefined;
      if (!p) {
        p = load().finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const value = await p;
      const at = now();
      store.set(key, { at, value });
      return { value, at };
    },
    peekAge(key: string): number | null {
      const hit = store.get(key);
      return hit ? now() - hit.at : null;
    },
  };
}
export type ProviderCache = ReturnType<typeof createProviderCache>;

// ── Snapshot ──────────────────────────────────────────────────────────────────────────────────

export type SnapshotDeps = {
  settingsFile: string;
  cache: ProviderCache;
  counts: () => CallCounts | null;
  transcripts: () => TranscriptTotals | null;
  transcriptsScanning: () => boolean;
  /** Key lookup the OS itself uses (process env first, then its config files). */
  providerKey: (name: string) => string;
  request?: typeof fetch;
  now?: () => Date;
  home?: string;
  hermesHome?: string;
  env?: Record<string, string | undefined>;
  designLedger?: string;
  /** Repo root: where the model-router receipts (and the legacy MiMo ledger) live. */
  root?: string;
  /** Test hook: this month's router receipts instead of reading them under `root`. */
  routerReceipts?: () => RouterReceipt[];
};

const iso = (ms: number) => new Date(ms).toISOString();
const fresh = (at: number | null, source: string, estimated = false): Freshness => ({ checkedAt: at ? iso(at) : null, source, estimated });
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-AU");
const usd = (n: number) => `US$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;

/**
 * What /usage shows beside a key's name (audit F3-27). OpenRouter's "label" for an unnamed key is
 * the key itself, masked as its first ~10 and last 3 characters ("sk-or-v1-abc...123"): more of a
 * secret than the page needs. A key-shaped label becomes "key ending 123" (at most 4 characters);
 * a name the owner gave the key is kept.
 */
export function safeKeyLabel(label: string | null | undefined): string | null {
  const v = String(label ?? "").trim();
  if (!v) return null;
  const masked = /^(.*?)(?:\.{2,}|…|\*{2,})([A-Za-z0-9_-]*)$/.exec(v);
  const keyShaped = /^(sk|pk|rk)[-_]/i.test(v) || /^[A-Za-z0-9_-]{20,}$/.test(v);
  if (masked || keyShaped) {
    const tail = (masked ? masked[2] : v).slice(-4);
    return tail ? `key ending ${tail}` : "key";
  }
  return v;
}

function hashKey(value: string): string {
  // Distinguishes key values without revealing them (FNV-1a, 8 hex).
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function claudePlanName(tier: string | null, sub: string | null): { name: string; priceId: string | null } {
  const t = `${tier ?? ""} ${sub ?? ""}`.toLowerCase();
  if (t.includes("20x")) return { name: "Claude Max 20x", priceId: "claude-max-20x" };
  if (t.includes("5x")) return { name: "Claude Max 5x", priceId: null };
  if (t.includes("pro")) return { name: "Claude Pro", priceId: null };
  if (t.includes("max")) return { name: "Claude Max", priceId: null };
  return { name: "Claude (plan unknown)", priceId: null };
}

function higgsfieldCredits(file: string, month: MonthInfo): { credits: number; images: number } | null {
  try {
    if (!existsSync(file)) return null;
    let credits = 0;
    let images = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"costCredits"')) continue;
      try {
        const e = JSON.parse(line);
        const ts = Number(e.ts);
        if (!Number.isFinite(ts) || ts < month.start.getTime() || ts >= month.end.getTime()) continue;
        if (typeof e.costCredits !== "number") continue;
        credits += e.costCredits;
        images++;
      } catch {
        /* skip a bad line */
      }
    }
    return { credits, images };
  } catch {
    return null;
  }
}

function sumCounts(counts: CallCounts | null, month: MonthInfo, provider: string) {
  const out: Record<string, { calls: number; errors: number }> = {};
  let today: Record<string, number> = {};
  if (!counts) return { byKind: out, today, since: null as string | null };
  const first = localDay(month.start);
  const todayKey = localDay(new Date());
  for (const [day, bucket] of Object.entries(counts.days)) {
    if (day < first) continue;
    for (const [key, row] of Object.entries(bucket)) {
      const [p, kind] = key.split(":");
      if (p !== provider) continue;
      const o = (out[kind] ??= { calls: 0, errors: 0 });
      o.calls += row.calls;
      o.errors += row.errors;
      if (day === todayKey) today[kind] = (today[kind] ?? 0) + row.calls;
    }
  }
  return { byKind: out, today, since: counts.since };
}

export async function buildSnapshot(deps: SnapshotDeps): Promise<AiUsageSnapshot> {
  const now = deps.now?.() ?? new Date();
  const month = monthInfo(now);
  const request = deps.request ?? fetch;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const settings = readSettings(deps.settingsFile);
  const prices = priceSettings(settings);
  const priceById = new Map(prices.map((p) => [p.id, p]));
  const sources: AiUsageSnapshot["sources"] = [];
  const unknown: string[] = [];
  let includesEstimates = false;

  // FX (12 h), falling back to the last good rate, marked stale.
  const fxRead = await deps.cache.get("fx", FX_TTL_MS, () => fetchFx(request));
  let fx: FxRate | null = null;
  if (fxRead.value.ok) {
    fx = fxRead.value.fx;
    if (!settings.lastFx || settings.lastFx.asOf !== fx.asOf) {
      try {
        writeSettings(deps.settingsFile, { ...readSettings(deps.settingsFile), lastFx: fx });
      } catch {
        /* the cached rate is a convenience */
      }
    }
    sources.push({ name: "USD→AUD rate", ok: true, freshness: fresh(fxRead.at, fx.source) });
  } else {
    if (settings.lastFx) fx = { ...settings.lastFx, stale: true };
    sources.push({ name: "USD→AUD rate", ok: false, reason: fxRead.value.reason + (fx ? ` — using the ${fx.asOf.slice(0, 10)} rate` : ""), freshness: fresh(null, "open.er-api.com") });
  }

  const moneyFor = (priceId: string | null): { money: Money | null; note: string } => {
    if (!priceId) return { money: null, note: "No published price for this plan — set it below" };
    const p = priceById.get(priceId);
    if (!p || p.amount === null) return { money: null, note: p?.source ?? "Price not set" };
    const money = toAud(p.amount, p.currency, p.gstIncluded, fx);
    if (!money) return { money: null, note: "No USD→AUD rate available" };
    const gst = p.gstIncluded ? "incl. GST" : "+ 10% GST";
    const orig = p.currency === "AUD" ? `A$${p.amount.toFixed(2)} ${gst}` : `US$${p.amount.toFixed(2)} ${gst} at ${fx?.usdToAud.toFixed(4)}`;
    return { money, note: `${orig} · ${p.source}` };
  };

  // ── Subscriptions ──────────────────────────────────────────────────────────────────────────
  const subscriptions: SubscriptionCard[] = [];

  const claude = await deps.cache.get("claude-plan", PROVIDER_TTL_MS, () => fetchClaudePlan(request, home));
  {
    const v = claude.value;
    const plan = claudePlanName(v.ok ? v.tier : null, v.ok ? v.subscriptionType : null);
    const planKnown = v.ok ? plan : { name: "Claude Max 20x", priceId: "claude-max-20x" };
    const { money, note } = moneyFor(planKnown.priceId);
    const card: SubscriptionCard = {
      id: "claude:max",
      provider: "anthropic",
      owner: "M&U Ventures",
      plan: planKnown.name,
      planSlug: v.ok ? v.tier : null,
      monthly: money,
      priceNote: note,
      status: v.ok
        ? { ok: true, windows: v.plan.windows, notes: v.plan.notes, freshness: fresh(claude.at, "Anthropic plan usage (same source as Claude Code's /usage)") }
        : { ok: false, reason: v.reason, checkedAt: iso(claude.at) },
      peakPercent: v.ok ? Math.max(...v.plan.windows.map((w) => w.usedPercent)) : null,
    };
    subscriptions.push(card);
    sources.push({ name: "Claude plan usage", ok: v.ok, reason: v.ok ? undefined : v.reason, freshness: fresh(claude.at, "api.anthropic.com/api/oauth/usage") });
  }

  const pool = readCodexPool(deps.hermesHome);
  if (!pool.ok) {
    sources.push({ name: "Codex accounts (Hermes pool)", ok: false, reason: pool.reason, freshness: fresh(null, "Hermes auth.json") });
    unknown.push("ChatGPT subscriptions (Hermes pool unreadable)");
  } else {
    const reads = await Promise.all(
      pool.entries.map((e) => deps.cache.get(`codex:${e.label}`, PROVIDER_TTL_MS, () => fetchCodexUsage(e, request)).then((r) => ({ e, r }))),
    );
    for (const { e, r } of reads) {
      const v = r.value;
      const slug = (v.ok ? v.usage.planSlug : null) ?? e.planSlug;
      const owner = codexOwner({ label: e.label, emailDomain: e.emailDomain, planSlug: slug }, settings.owners);
      const { money, note } = moneyFor(chatgptPriceId(slug));
      const notes = v.ok ? [...v.usage.notes] : [];
      if (v.ok && v.usage.limitReached) notes.unshift("Limit reached: Hermes rotates to the next account");
      if (v.ok && v.usage.windows.length === 1 && v.usage.windows[0].label === "Weekly") notes.push("This plan has a weekly limit only (no 5-hour window)");
      subscriptions.push({
        id: `codex:${e.label}`,
        provider: "openai",
        owner,
        plan: chatgptPlanName(slug),
        planSlug: slug,
        monthly: money,
        priceNote: note,
        status: v.ok
          ? { ok: true, windows: v.usage.windows, notes, freshness: fresh(r.at, `OpenAI Codex usage (same source as Codex /status) · Hermes pool “${e.label}”`) }
          : { ok: false, reason: v.reason, checkedAt: iso(r.at) },
        peakPercent: v.ok && v.usage.windows.length ? Math.max(...v.usage.windows.map((w) => w.usedPercent)) : null,
      });
      sources.push({ name: `Codex · ${owner}`, ok: v.ok, reason: v.ok ? undefined : v.reason, freshness: fresh(r.at, "chatgpt.com/backend-api/wham/usage") });
    }
  }

  // ── API keys ───────────────────────────────────────────────────────────────────────────────
  const apiKeys: ApiKeyRow[] = [];
  const names = new Set(configuredKeyNames(home));
  const add = (row: ApiKeyRow) => apiKeys.push(row);

  // OpenRouter: every distinct key value the OS can see, each with its own limit.
  {
    const candidates: { name: string; where: string; value: string }[] = [];
    const envOr = env.OPENROUTER_API_KEY?.trim() ?? "";
    if (envOr) candidates.push({ name: "OPENROUTER_API_KEY", where: "Windows environment (used by the OS and Hermes)", value: envOr });
    for (const name of ["OPENROUTER_API_KEY", "OPENROUTER_API_KEY_ALT"]) {
      const v = names.has(name) ? fileKey(name, home) : "";
      if (v) candidates.push({ name, where: "agentic-os.env", value: v });
    }
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.value)) continue;
      seen.add(c.value);
      const id = `openrouter:${hashKey(c.value)}`;
      const r = await deps.cache.get(id, PROVIDER_TTL_MS, () => fetchOpenRouterKey(c.value, request));
      const v = r.value;
      if (!v.ok) {
        add({ id, provider: "OpenRouter", keyName: c.name, keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: `${c.where}. ${v.reason}`, freshness: fresh(r.at, "openrouter.ai/api/v1/key") });
        unknown.push(`OpenRouter ${c.name}`);
        continue;
      }
      const i = v.info;
      const monthly = i.usageMonthly ?? 0;
      const spend = usdToAud(monthly, fx);
      if (!spend && monthly > 0) unknown.push(`OpenRouter ${c.name} (no FX rate)`);
      const limitText = i.limit === null ? "No key limit" : `US$${i.limit} key limit · US$${(i.limitRemaining ?? 0).toFixed(2)} left`;
      const zeroCap = i.limit !== null && (i.limitRemaining ?? 0) <= 0;
      const credits = v.accountCredits !== null ? ` Account credits US$${v.accountCredits.toFixed(2)}, used US$${(v.accountUsage ?? 0).toFixed(3)} all-time.` : "";
      add({
        id,
        provider: "OpenRouter",
        keyName: c.name,
        keyTail: safeKeyLabel(i.label),
        usage: `${usd(monthly)} this month · ${usd(i.usageTotal)} all-time${i.isFreeTier ? " · free tier" : ""}`,
        spend,
        spendEstimated: false,
        limit: limitText,
        status: zeroCap ? "danger" : i.limit !== null && i.limitRemaining !== null && i.limitRemaining < i.limit * 0.1 ? "warn" : "ok",
        note: `${c.where}.${zeroCap ? " The key's spending limit is $0: every paid call is refused." : ""}${credits}`,
        freshness: fresh(r.at, "OpenRouter /api/v1/key (provider figure)"),
      });
    }
    if (!candidates.length)
      add({ id: "openrouter:none", provider: "OpenRouter", keyName: "OPENROUTER_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "info", note: "No OpenRouter key configured", freshness: fresh(null, "—") });
  }

  // ElevenLabs: characters this month from the provider; the plan fee is a price setting.
  {
    const key = deps.providerKey("ELEVENLABS_API_KEY");
    if (key) {
      const r = await deps.cache.get("elevenlabs", PROVIDER_TTL_MS, () => fetchElevenLabs(key, month.start, now, request));
      const v = r.value;
      const plan = priceById.get("elevenlabs-plan");
      add(
        v.ok
          ? {
              id: "elevenlabs",
              provider: "ElevenLabs",
              keyName: "ELEVENLABS_API_KEY",
              keyTail: null,
              usage: `${fmtInt(v.total)} characters/credits this month (${Object.entries(v.byProduct).filter(([k]) => k !== "All").map(([k, n]) => `${k} ${fmtInt(n)}`).join(", ") || "all products"})`,
              spend: null,
              spendEstimated: false,
              limit: v.planReadable ? "See plan" : "Plan limit unreadable: key lacks user_read permission",
              status: v.planReadable ? "ok" : "info",
              note: plan?.amount !== null && plan?.amount !== undefined ? "Plan fee counted under fixed costs." : "Set the ElevenLabs plan fee below to include it in the monthly total.",
              freshness: fresh(r.at, "ElevenLabs /v1/usage/character-stats (provider figure)"),
            }
          : { id: "elevenlabs", provider: "ElevenLabs", keyName: "ELEVENLABS_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: v.reason, freshness: fresh(r.at, "ElevenLabs") },
      );
    }
  }

  // Retell (MU-Receptionist voice calls): real per-call cost from the provider.
  {
    const key = deps.providerKey("RETELL_API_KEY");
    if (key) {
      const r = await deps.cache.get("retell", PROVIDER_TTL_MS, () => fetchRetell(key, month.start, request));
      const v = r.value;
      if (v.ok) {
        const spend = usdToAud(v.costUsd, fx);
        if (!spend && v.costUsd > 0) unknown.push("Retell (no FX rate)");
        add({ id: "retell", provider: "Retell AI", keyName: "RETELL_API_KEY", keyTail: null, usage: `${v.calls} call${v.calls === 1 ? "" : "s"} · ${Math.round(v.seconds / 60)} min this month`, spend, spendEstimated: false, limit: "Pay as you go", status: "ok", note: "Per-call cost reported by Retell.", freshness: fresh(r.at, "Retell /v2/list-calls call_cost (provider figure)") });
      } else {
        add({ id: "retell", provider: "Retell AI", keyName: "RETELL_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: v.reason, freshness: fresh(r.at, "Retell") });
        unknown.push("Retell AI");
      }
    }
  }

  // DeepSeek (Hermes fallback): balance only; DeepSeek has no month-spend endpoint.
  {
    const key = deps.providerKey("DEEPSEEK_API_KEY");
    if (key) {
      const r = await deps.cache.get("deepseek", PROVIDER_TTL_MS, () => fetchDeepseek(key, request));
      const v = r.value;
      add(
        v.ok
          ? { id: "deepseek", provider: "DeepSeek", keyName: "DEEPSEEK_API_KEY", keyTail: null, usage: v.balances.map((b) => `${fmtMoney(b.total, { currency: b.currency })} prepaid balance left`).join(" · ") || "No balance reported", spend: null, spendEstimated: false, limit: v.available ? "Prepaid" : "Balance exhausted", status: v.available ? "ok" : "danger", note: "Prepaid: top-ups are the spend, and DeepSeek has no month-spend API.", freshness: fresh(r.at, "DeepSeek /user/balance (provider figure)") }
          : { id: "deepseek", provider: "DeepSeek", keyName: "DEEPSEEK_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: v.reason, freshness: fresh(r.at, "DeepSeek") },
      );
    }
  }

  // Groq: no billing API. Free tier → A$0; usage is this OS's own call count against the limits
  // Groq reports in its rate-limit headers.
  {
    const counts = deps.counts();
    const g = sumCounts(counts, month, "groq");
    if (deps.providerKey("GROQ_API_KEY")) {
      const parts = Object.keys(GROQ_FREE_DAILY_REQUESTS).map((kind) => {
        const h = counts?.headers[`groq:${kind}`];
        const today = g.today[kind] ?? 0;
        const limit = h?.limitRequests ?? GROQ_FREE_DAILY_REQUESTS[kind];
        const usedByGroq = h && h.limitRequests !== null && h.remainingRequests !== null && h.at.slice(0, 10) === now.toISOString().slice(0, 10) ? h.limitRequests - h.remainingRequests : null;
        return { kind, today, limit, usedByGroq };
      });
      const worst = Math.max(...parts.map((p) => (p.usedByGroq ?? p.today) / p.limit));
      includesEstimates = true;
      add({
        id: "groq",
        provider: "Groq",
        keyName: "GROQ_API_KEY",
        keyTail: null,
        usage: `Today: ${parts.map((p) => `${p.kind} ${p.usedByGroq ?? p.today}/${fmtInt(p.limit)}`).join(" · ")} · month ${fmtInt(Object.values(g.byKind).reduce((a, b) => a + b.calls, 0))} calls`,
        spend: toAud(0, "AUD", true, fx),
        spendEstimated: true,
        limit: "Free tier, per model per day",
        status: worst >= 0.9 ? "danger" : worst >= 0.7 ? "warn" : "ok",
        note: `Groq has no billing API. Calls counted by this OS since ${g.since ? fmtDay(g.since.slice(0, 10), { year: true }) : "today"}; limits from Groq's own rate-limit headers when seen. Hermes' Groq calls aren't counted.`,
        freshness: fresh(Date.now(), "local call count", true),
      });
    }
  }

  // Gemini: no billing API; counted locally.
  {
    const keysSet = ["GEMINI_API_KEY", "GEMINI_API_KEY_ALT"].filter((n) => names.has(n) || env[n]);
    if (keysSet.length) {
      const g = sumCounts(deps.counts(), month, "gemini");
      const total = Object.values(g.byKind).reduce((a, b) => a + b.calls, 0);
      includesEstimates = true;
      add({
        id: "gemini",
        provider: "Google Gemini",
        keyName: keysSet.join(", "),
        keyTail: null,
        usage: total ? `${fmtInt(total)} calls this month (${Object.entries(g.byKind).map(([k, v]) => `${k} ${v.calls}`).join(", ")})` : "No calls counted this month",
        spend: toAud(0, "AUD", true, fx),
        spendEstimated: true,
        limit: "Free tier (assumed: no billing account linked to these keys)",
        status: "ok",
        note: `Google has no per-key spend API. Counted by this OS since ${g.since ? fmtDay(g.since.slice(0, 10), { year: true }) : "today"}; Jarvis's voice falls back to Gemini only when Groq is down.`,
        freshness: fresh(Date.now(), "local call count", true),
      });
    }
  }

  // TypeSafe / Jev: no usage API.
  {
    const keysSet = ["TYPESAFE_API_KEY", "JEV_API_KEY"].filter((n) => names.has(n));
    if (keysSet.length) {
      const g = sumCounts(deps.counts(), month, "typesafe");
      const total = Object.values(g.byKind).reduce((a, b) => a + b.calls, 0);
      unknown.push("TypeSafe (Jev) — no billing API or published price");
      add({ id: "typesafe", provider: "TypeSafe (Jev)", keyName: keysSet.join(", "), keyTail: null, usage: `${fmtInt(total)} decisions counted this month`, spend: null, spendEstimated: true, limit: null, status: "info", note: `TypeSafe publishes no usage API or price list, so spend is unknown. Counted since ${g.since ? fmtDay(g.since.slice(0, 10), { year: true }) : "today"}.`, freshness: fresh(Date.now(), "local call count", true) });
    }
  }

  // Pinecone: index stats; Starter plan assumed free.
  {
    const key = deps.providerKey("PINECONE_API_KEY");
    if (key) {
      const r = await deps.cache.get("pinecone", PROVIDER_TTL_MS, () => fetchPinecone(key, deps.providerKey("PINECONE_INDEX_HOST"), request));
      const v = r.value;
      if (v.ok) includesEstimates = true;
      add(
        v.ok
          ? { id: "pinecone", provider: "Pinecone", keyName: "PINECONE_API_KEY", keyTail: null, usage: `${v.indexes} index${v.indexes === 1 ? "" : "es"}${v.vectors !== null ? ` · ${fmtInt(v.vectors)} vectors` : ""}`, spend: toAud(0, "AUD", true, fx), spendEstimated: true, limit: "Starter (free) plan assumed", status: "ok", note: "Pinecone's API key can't read billing; well inside Starter limits.", freshness: fresh(r.at, "Pinecone index stats") }
          : { id: "pinecone", provider: "Pinecone", keyName: "PINECONE_API_KEY", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: v.reason, freshness: fresh(r.at, "Pinecone") },
      );
    }
  }

  // Google Places: billing closed; the lead engine uses OpenStreetMap now.
  if (names.has("GOOGLE_PLACES_API_KEY")) {
    const g = sumCounts(deps.counts(), month, "google-places");
    const total = Object.values(g.byKind).reduce((a, b) => a + b.calls, 0);
    add({ id: "google-places", provider: "Google Places", keyName: "GOOGLE_PLACES_API_KEY", keyTail: null, usage: total ? `${total} calls counted this month` : "Not used: lead search runs on OpenStreetMap", spend: toAud(0, "AUD", true, fx), spendEstimated: true, limit: "Billing closed", status: "info", note: "Google Cloud billing is closed on this key, so it can't be charged.", freshness: fresh(Date.now(), "local call count", true) });
  }

  // Higgsfield: credits per generation are Higgsfield's own live quotes, recorded in the design ledger.
  {
    const h = higgsfieldCredits(deps.designLedger ?? join(home, ".claude-os", "design", "ledger.jsonl"), month);
    if (h) {
      const plan = priceById.get("higgsfield-plan");
      add({ id: "higgsfield", provider: "Higgsfield", keyName: "Signed in (OAuth, Design page)", keyTail: null, usage: `${fmtInt(h.credits)} credits · ${h.images} generation${h.images === 1 ? "" : "s"} this month`, spend: null, spendEstimated: false, limit: "Balance not readable (no Higgsfield balance API)", status: "info", note: `Credits are Higgsfield's live quotes at generation time. ${higgsfieldTopUpNote(plan)}`, freshness: fresh(Date.now(), "Design ledger (Higgsfield live quotes)") });
    }
  }

  // Model-router receipts: per-call metered spend recorded by the router (and the reconciled MiMo
  // ledger, which /usage used to miss because it read ~/.operator-data instead of the repo). The
  // dollars are already inside the provider's own row above (OpenRouter /key etc.), so these rows
  // are a breakdown, not additional spend. Calls that bypass the router aren't here: a floor.
  {
    const receipts = deps.routerReceipts ? deps.routerReceipts() : deps.root ? readAllReceipts(deps.root, { since: month.start.getTime() }) : [];
    const inMonth = receipts.filter((r) => { const t = Date.parse(r.startedAt); return t >= month.start.getTime() && t < month.end.getTime(); });
    const LABEL: Record<string, string> = { openrouter: "OpenRouter", typesafe: "TypeSafe (Jev)", elevenlabs: "ElevenLabs", deepseek: "DeepSeek", gemini: "Gemini", higgsfield: "Higgsfield" };
    for (const [provider, m] of Object.entries(meteredSpendByProvider(inMonth))) {
      const tasks = Object.entries(m.byTask).map(([t, n]) => `${t} ${n}`).join(", ");
      add({
        id: `router:${provider}`,
        provider: `${LABEL[provider] ?? provider} · router receipts`,
        keyName: "per-call receipts",
        keyTail: null,
        usage: `${fmtInt(m.calls)} metered call${m.calls === 1 ? "" : "s"} this month${tasks ? ` · ${tasks}` : ""}${m.unknownCostCalls ? ` · ${m.unknownCostCalls} with unknown cost` : ""}`,
        spend: usdToAud(m.costUsd, fx),
        spendEstimated: m.unknownCostCalls > 0,
        limit: "Included in the provider row above, not additional",
        status: "info",
        note: "From the model router's receipts (scripts/model-router), including the older MiMo ledger rows. A floor: calls that don't go through the router yet aren't counted here.",
        freshness: fresh(Date.now(), "Model-router receipts"),
      });
    }
  }

  // Twilio: no credentials in the OS yet.
  if (!deps.providerKey("TWILIO_ACCOUNT_SID") || !deps.providerKey("TWILIO_AUTH_TOKEN"))
    add({ id: "twilio", provider: "Twilio", keyName: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN", keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: "Not linked: Twilio credentials aren't in the OS config yet (they go in once a number is bought). Check the prepaid balance in the Twilio console.", freshness: fresh(null, "—") });

  for (const n of ["TOKENHARBOUR_API_KEY"]) {
    if (names.has(n))
      add({ id: n.toLowerCase(), provider: "TokenHarbour", keyName: n, keyTail: null, usage: "—", spend: null, spendEstimated: false, limit: null, status: "unavailable", note: "No public usage or billing API found for this provider.", freshness: fresh(null, "—") });
  }

  // ── Claude API-equivalent (value, not spend) ───────────────────────────────────────────────
  let claudeModels: AiUsageSnapshot["claudeModels"];
  const t = deps.transcripts();
  if (!t) {
    claudeModels = { ok: false, reason: deps.transcriptsScanning() ? "Reading this month's Claude Code transcripts (first scan takes ~15 s)…" : "Transcripts not scanned yet", checkedAt: null };
  } else {
    const rows: ClaudeModelRow[] = Object.entries(t.byModel)
      .map(([model, v]) => {
        const cost = claudeApiCostUsd(model, v.counts);
        return {
          model: claudePriceKey(model) && claudePriceKey(model) !== model ? `${model} → ${claudePriceKey(model)}` : model,
          requests: v.requests,
          inputTokens: v.counts.input,
          outputTokens: v.counts.output,
          cacheReadTokens: v.counts.cacheRead,
          cacheWrite5mTokens: v.counts.write5m,
          cacheWrite1hTokens: v.counts.write1h,
          apiEquivalent: cost === null ? null : usdToAud(cost, fx),
        };
      })
      .sort((a, b) => (b.apiEquivalent?.aud ?? -1) - (a.apiEquivalent?.aud ?? -1));
    const totalUsd = Object.entries(t.byModel).reduce((sum, [m, v]) => sum + (claudeApiCostUsd(m, v.counts) ?? 0), 0);
    claudeModels = {
      rows,
      totalApiEquivalent: usdToAud(Math.round(totalUsd * 100) / 100, fx),
      freshness: fresh(Date.parse(t.scannedAt), "Claude Code transcripts on this PC (usage fields only)", true),
      scope: `${t.files} transcript files touched this month on this PC${t.complete ? "" : " (some files couldn't be read)"}. Covered by the Max plan: this is what the same tokens would cost on the API, not a bill.`,
    };
  }

  // ── Totals ────────────────────────────────────────────────────────────────────────────────
  let fixedAud = 0;
  for (const s of subscriptions) {
    if (s.monthly) fixedAud += s.monthly.aud;
    else unknown.push(`${s.plan} (${s.owner}) price`);
  }
  // Higgsfield bills by auto top-up, not a monthly fee (UI-truth L5): how many top-ups ran this
  // month isn't readable, so it's named as unknown instead of counted as a fixed plan.
  {
    const top = priceById.get("higgsfield-plan");
    if (top && (top.amount !== null || apiKeys.some((k) => k.id === "higgsfield"))) unknown.push(higgsfieldUnknownLabel(top));
  }
  for (const id of ["elevenlabs-plan"]) {
    const p = priceById.get(id)!;
    if (p.amount === null) {
      if (apiKeys.some((k) => k.id === id.replace("-plan", ""))) unknown.push(p.label);
      continue;
    }
    const m = toAud(p.amount, p.currency, p.gstIncluded, fx);
    if (m) fixedAud += m.aud;
    else unknown.push(`${p.label} (no FX rate)`);
  }
  // Router-receipt rows are a breakdown of spend already in the provider rows: never added twice.
  const meteredAud = apiKeys.filter((k) => !k.id.startsWith("router:")).reduce((sum, k) => sum + (k.spend?.aud ?? 0), 0);
  fixedAud = Math.round(fixedAud * 100) / 100;
  const metered = Math.round(meteredAud * 100) / 100;

  return {
    generatedAt: now.toISOString(),
    month: { label: month.label, start: month.start.toISOString(), end: month.end.toISOString(), dayOfMonth: month.dayOfMonth, daysInMonth: month.daysInMonth },
    fx,
    totals: {
      fixedAud,
      meteredAud: metered,
      monthAud: Math.round((fixedAud + metered) * 100) / 100,
      projectedAud: projectMonth(fixedAud, metered, month),
      unknown,
      includesEstimates,
    },
    subscriptions,
    apiKeys,
    claudeModels,
    prices,
    sources,
  };
}

export type { Result };

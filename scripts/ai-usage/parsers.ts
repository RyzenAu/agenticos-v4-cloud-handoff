// Pure parsers and money maths for the AI usage snapshot. No I/O here, so every rule that turns a
// provider payload into a number on /usage is covered by scripts/ai-usage/parsers.test.ts.
import { GST_RATE, type TokenCounts } from "./prices";
import type { FxRate, LimitWindow, Money } from "./types";

const num = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const obj = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Money ──────────────────────────────────────────────────────────────────────────────────────

/** Converts a price to AUD. USD prices without GST get Australia's 10% added first. */
export function toAud(
  amount: number,
  currency: "AUD" | "USD",
  gstIncluded: boolean,
  fx: Pick<FxRate, "usdToAud"> | null,
): Money | null {
  if (!Number.isFinite(amount)) return null;
  const withGst = gstIncluded ? amount : amount * (1 + GST_RATE);
  if (currency === "AUD") return { aud: round2(withGst), original: { amount, currency } };
  if (!fx || !(fx.usdToAud > 0)) return null;
  return { aud: round2(withGst * fx.usdToAud), original: { amount, currency } };
}

/** Metered usage in USD (the provider's own figure, GST not added: API usage is B2B-billed). */
export function usdToAud(amount: number, fx: Pick<FxRate, "usdToAud"> | null): Money | null {
  if (!Number.isFinite(amount) || !fx || !(fx.usdToAud > 0)) return null;
  return { aud: round2(amount * fx.usdToAud), original: { amount, currency: "USD" } };
}

export function parseFx(payload: unknown, now = new Date()): FxRate | null {
  const data = obj(payload);
  if (!data || data.result !== "success") return null;
  const rate = num(obj(data.rates)?.AUD);
  if (rate === null || rate <= 0) return null;
  const updated = typeof data.time_last_update_utc === "string" ? new Date(data.time_last_update_utc) : now;
  return {
    usdToAud: rate,
    source: "open.er-api.com (USD→AUD, daily reference rate)",
    asOf: Number.isNaN(updated.getTime()) ? now.toISOString() : updated.toISOString(),
    stale: false,
  };
}

// ── Month maths ────────────────────────────────────────────────────────────────────────────────

export type MonthInfo = { label: string; start: Date; end: Date; dayOfMonth: number; daysInMonth: number; elapsedDays: number };

/** The calendar month containing `now`, in the machine's local time zone (Sydney on this PC). */
export function monthInfo(now = new Date()): MonthInfo {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const elapsedDays = Math.max(1, (now.getTime() - start.getTime()) / 86_400_000);
  return {
    label: start.toLocaleDateString("en-AU", { month: "long", year: "numeric" }),
    start,
    end,
    dayOfMonth: now.getDate(),
    daysInMonth,
    elapsedDays,
  };
}

/**
 * Month-end projection: fixed fees are billed once per month, so they count in full; metered
 * spend so far is extrapolated at its month-to-date daily rate. (The first day counts as a whole
 * day, so a morning's usage doesn't project to a fortune.)
 */
export function projectMonth(fixedAud: number, meteredAud: number, month: Pick<MonthInfo, "elapsedDays" | "daysInMonth">) {
  const rate = meteredAud / Math.max(1, month.elapsedDays);
  return round2(fixedAud + rate * month.daysInMonth);
}

// ── ChatGPT / Codex (GET chatgpt.com/backend-api/wham/usage, per account) ─────────────────────

export function windowLabel(seconds: number | null): string {
  if (!seconds) return "Window";
  if (seconds === 604_800) return "Weekly";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.round(seconds / 60)}-minute`;
}

export type CodexUsage = {
  planSlug: string | null;
  windows: LimitWindow[];
  limitReached: boolean;
  notes: string[];
};

export function parseCodexUsage(payload: unknown, now = Date.now()): CodexUsage | null {
  const data = obj(payload);
  const limit = obj(data?.rate_limit);
  if (!data || !limit) return null;
  const windows: LimitWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const w = obj(limit[key]);
    const used = num(w?.used_percent);
    if (!w || used === null) continue;
    const seconds = num(w.limit_window_seconds);
    const resetAt = num(w.reset_at);
    const resetAfter = num(w.reset_after_seconds);
    windows.push({
      label: windowLabel(seconds),
      usedPercent: used,
      resetsAt:
        resetAt !== null
          ? new Date(resetAt * 1000).toISOString()
          : resetAfter !== null
            ? new Date(now + resetAfter * 1000).toISOString()
            : null,
      windowSeconds: seconds,
    });
  }
  const notes: string[] = [];
  const credits = obj(data.credits);
  const balance = num(credits?.balance);
  if (credits?.has_credits && balance !== null && balance > 0)
    notes.push(`${balance.toFixed(2)} Codex credits on the account (used after the plan limit)`);
  if (credits?.overage_limit_reached) notes.push("Credit overage limit reached");
  const resets = num(obj(data.rate_limit_reset_credits)?.available_count);
  if (resets) notes.push(`${resets} banked limit reset${resets === 1 ? "" : "s"}`);
  return {
    planSlug: typeof data.plan_type === "string" ? data.plan_type : null,
    windows,
    limitReached: limit.limit_reached === true || limit.allowed === false,
    notes,
  };
}

/** Who a pooled Codex account belongs to. Overrides (by pool label) win; then the owner's rules. */
export function codexOwner(
  entry: { label: string; emailDomain: string | null; planSlug: string | null },
  overrides: Record<string, string> = {},
): string {
  const override = overrides[entry.label]?.trim();
  if (override) return override;
  if (entry.emailDomain === "muventures.com.au") return "M&U Ventures";
  if ((entry.planSlug ?? "").toLowerCase() === "plus") return "Usman";
  return "Mehroz";
}

// ── Claude subscription (GET api.anthropic.com/api/oauth/usage — what /usage shows) ────────────

export type ClaudePlanUsage = { windows: LimitWindow[]; notes: string[]; extraUsageEnabled: boolean };

export function parseClaudePlanUsage(payload: unknown): ClaudePlanUsage | null {
  const data = obj(payload);
  if (!data) return null;
  const windows: LimitWindow[] = [];
  const add = (label: string, raw: unknown) => {
    const w = obj(raw);
    const used = num(w?.utilization);
    if (!w || used === null) return;
    windows.push({ label, usedPercent: used, resetsAt: typeof w.resets_at === "string" ? w.resets_at : null });
  };
  add("Session (5-hour)", data.five_hour);
  add("Weekly · all models", data.seven_day);
  add("Weekly · Opus", data.seven_day_opus);
  add("Weekly · Sonnet", data.seven_day_sonnet);
  // Newer Claude Code builds list per-model weekly limits separately ("Weekly · Fable").
  if (Array.isArray(data.limits)) {
    for (const l of data.limits) {
      const row = obj(l);
      if (row?.kind !== "weekly_scoped") continue;
      const name = obj(obj(row.scope)?.model)?.display_name;
      const used = num(row.percent);
      if (typeof name !== "string" || used === null) continue;
      if (windows.some((w) => w.label === `Weekly · ${name}`)) continue;
      windows.push({ label: `Weekly · ${name}`, usedPercent: used, resetsAt: typeof row.resets_at === "string" ? row.resets_at : null });
    }
  }
  if (!windows.length) return null;
  const extra = obj(data.extra_usage);
  const notes: string[] = [];
  const extraUsageEnabled = extra?.is_enabled === true;
  notes.push(extraUsageEnabled ? "Extra usage (pay-as-you-go credits) is ON" : "Extra usage is off: no charges beyond the plan");
  return { windows, notes, extraUsageEnabled };
}

// ── OpenRouter (GET /api/v1/key) ───────────────────────────────────────────────────────────────

export type OpenRouterKey = {
  label: string | null;
  limit: number | null;
  limitRemaining: number | null;
  usageTotal: number;
  usageMonthly: number | null;
  isFreeTier: boolean;
};

export function parseOpenRouterKey(payload: unknown): OpenRouterKey | null {
  const data = obj(obj(payload)?.data);
  if (!data) return null;
  const usage = num(data.usage);
  if (usage === null) return null;
  return {
    label: typeof data.label === "string" ? data.label : null,
    limit: num(data.limit),
    limitRemaining: num(data.limit_remaining),
    usageTotal: usage,
    usageMonthly: num(data.usage_monthly),
    isFreeTier: data.is_free_tier === true,
  };
}

// ── ElevenLabs (GET /v1/usage/character-stats) ─────────────────────────────────────────────────

export function parseElevenCharacterStats(payload: unknown): { total: number; byProduct: Record<string, number> } | null {
  const usage = obj(obj(payload)?.usage);
  if (!usage) return null;
  const byProduct: Record<string, number> = {};
  for (const [name, series] of Object.entries(usage)) {
    if (!Array.isArray(series)) continue;
    byProduct[name] = series.reduce((sum: number, v) => sum + (num(v) ?? 0), 0);
  }
  const total = byProduct.All ?? Object.values(byProduct).reduce((a, b) => a + b, 0);
  return { total, byProduct };
}

// ── Retell (POST /v2/list-calls) — only the cost fields are read; transcripts are never kept ──

export function parseRetellCosts(payload: unknown, sinceMs: number): { calls: number; costUsd: number; seconds: number } | null {
  if (!Array.isArray(payload)) return null;
  let calls = 0;
  let cents = 0;
  let seconds = 0;
  for (const raw of payload) {
    const call = obj(raw);
    const start = num(call?.start_timestamp);
    if (!call || start === null || start < sinceMs) continue;
    const cost = obj(call.call_cost);
    calls++;
    cents += num(cost?.combined_cost) ?? 0; // Retell reports combined_cost in US cents
    seconds += num(cost?.total_duration_seconds) ?? 0;
  }
  return { calls, costUsd: cents / 100, seconds };
}

// ── DeepSeek (GET /user/balance) ───────────────────────────────────────────────────────────────

export function parseDeepseekBalance(payload: unknown): { available: boolean; balances: { currency: string; total: number }[] } | null {
  const data = obj(payload);
  if (!data || !Array.isArray(data.balance_infos)) return null;
  const balances = data.balance_infos
    .map((b: unknown) => ({ currency: String(obj(b)?.currency ?? ""), total: num(obj(b)?.total_balance) }))
    .filter((b: { total: number | null }) => b.total !== null) as { currency: string; total: number }[];
  return { available: data.is_available === true, balances };
}

// ── Claude Code transcripts: usage fields only ─────────────────────────────────────────────────
// A transcript line holds the whole message, including its text. These helpers never parse the
// line: they locate the `"usage":{…}` object by brace matching and read `model`, the message and
// request ids and the timestamp with anchored patterns. Escaped quotes inside message text
// (\"model\":…) can't match because the patterns require an unescaped quote.

export type TranscriptUsage = { key: string | null; model: string; timestampMs: number; counts: TokenCounts };

function balancedObjectAt(line: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return line.slice(open, i + 1);
    }
  }
  return null;
}

const lastMatch = (re: RegExp, text: string) => {
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  const g = new RegExp(re.source, "g");
  while ((m = g.exec(text))) last = m;
  return last;
};

export function extractTranscriptUsage(line: string): TranscriptUsage | null {
  if (!line.includes('"type":"assistant"')) return null;
  const at = line.lastIndexOf('"usage":{');
  if (at < 0) return null;
  const usageText = balancedObjectAt(line, at + '"usage":'.length);
  if (!usageText) return null;
  let usage: any;
  try {
    usage = JSON.parse(usageText);
  } catch {
    return null;
  }
  const model = lastMatch(/(?<!\\)"model":"([^"\\]+)"/, line)?.[1];
  const ts = lastMatch(/(?<!\\)"timestamp":"([0-9T:.\-+Z]+)"/, line)?.[1];
  if (!model || !ts || model === "<synthetic>") return null;
  const timestampMs = Date.parse(ts);
  if (!Number.isFinite(timestampMs)) return null;
  const msgId = line.match(/(?<!\\)"id":"(msg_[A-Za-z0-9_]+)"/)?.[1];
  const reqId = lastMatch(/(?<!\\)"requestId":"(req_[A-Za-z0-9_]+)"/, line)?.[1];
  const creation = obj(usage.cache_creation);
  const totalWrite = num(usage.cache_creation_input_tokens) ?? 0;
  const write1h = num(creation?.ephemeral_1h_input_tokens) ?? 0;
  const write5mRaw = num(creation?.ephemeral_5m_input_tokens);
  // Older transcripts only carry the total; Claude Code's default then was the 5-minute cache.
  const write5m = creation ? (write5mRaw ?? Math.max(0, totalWrite - write1h)) : totalWrite;
  return {
    key: msgId ? `${msgId}:${reqId ?? ""}` : null,
    model,
    timestampMs,
    counts: {
      input: num(usage.input_tokens) ?? 0,
      output: num(usage.output_tokens) ?? 0,
      cacheRead: num(usage.cache_read_input_tokens) ?? 0,
      write5m,
      write1h: creation ? write1h : 0,
    },
  };
}

// ── Local call counts (Groq / Gemini / ElevenLabs traffic from this OS) ───────────────────────

export type RateLimitHeaders = { limitRequests: number | null; remainingRequests: number | null; limitTokens: number | null; remainingTokens: number | null };

export function parseRateLimitHeaders(get: (name: string) => string | null): RateLimitHeaders | null {
  const pick = (name: string) => num(get(name));
  const out = {
    limitRequests: pick("x-ratelimit-limit-requests"),
    remainingRequests: pick("x-ratelimit-remaining-requests"),
    limitTokens: pick("x-ratelimit-limit-tokens"),
    remainingTokens: pick("x-ratelimit-remaining-tokens"),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Buckets an outgoing request URL into a provider + endpoint kind. Query strings are dropped. */
export function classifyAiRequest(url: string): { provider: string; kind: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;
  if (u.hostname === "api.groq.com") {
    if (path.endsWith("/chat/completions")) return { provider: "groq", kind: "chat" };
    if (path.endsWith("/audio/transcriptions")) return { provider: "groq", kind: "transcription" };
    if (path.endsWith("/audio/speech")) return { provider: "groq", kind: "speech" };
    return null;
  }
  if (u.hostname === "generativelanguage.googleapis.com") {
    const model = path.match(/\/models\/([A-Za-z0-9._-]+):/)?.[1];
    if (!model) return path.includes("/openai/chat/completions") ? { provider: "gemini", kind: "chat" } : null;
    return { provider: "gemini", kind: model };
  }
  if (u.hostname === "places.googleapis.com" || (u.hostname === "maps.googleapis.com" && path.includes("/place/")))
    return { provider: "google-places", kind: "places" };
  if (u.hostname === "api.typesafe.ai" && path.startsWith("/v1/")) return { provider: "typesafe", kind: "systemone" };
  return null;
}

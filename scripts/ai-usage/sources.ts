// Provider reads for the AI usage snapshot. Each returns either data or { ok: false, reason } —
// a failed source is shown as "unavailable" with its reason, never as a zero.
//
// Credentials: values are read here, in the server process, only to authenticate the one
// read-only request each provider needs. They are never returned, logged or written anywhere.
// Codex tokens come from Hermes' own credential pool and are used as-is: this module never
// refreshes them (refresh tokens rotate, and Hermes owns them).
import { realExecutable } from "../assistant-runtime";
import { runCapture } from "../nonblocking-exec";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseClaudePlanUsage,
  parseCodexUsage,
  parseDeepseekBalance,
  parseElevenCharacterStats,
  parseFx,
  parseOpenRouterKey,
  parseRetellCosts,
  type ClaudePlanUsage,
  type CodexUsage,
  type OpenRouterKey,
} from "./parsers";
import type { FxRate } from "./types";

export type Fail = { ok: false; reason: string };
export type Result<T> = ({ ok: true } & T) | Fail;
const fail = (reason: string): Fail => ({ ok: false, reason });

type Fetch = typeof fetch;
const TIMEOUT = 12_000;

async function getJson(request: Fetch, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error page */
  }
  return { status: response.status, body };
}

const providerMessage = (body: unknown): string => {
  const b = body as any;
  const text = b?.detail?.message ?? b?.error?.message ?? b?.message ?? b?.detail ?? b?.error;
  return typeof text === "string" ? text.slice(0, 160) : "";
};

function jwtClaims(token: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// ── Codex accounts from Hermes' credential pool ────────────────────────────────────────────────

export type CodexPoolEntry = {
  label: string; // "openai-1"
  planSlug: string | null; // from the token's claims
  emailDomain: string | null;
  tokenExpiresAt: string | null;
  /** Internal: used for the usage request only. Never leaves this module's callers' server code. */
  secret: { token: string; accountId: string | null };
};

export function hermesHome(): string {
  const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : "";
  if (local && existsSync(join(local, "auth.json"))) return local;
  return join(homedir(), ".hermes");
}

export function readCodexPool(home = hermesHome()): Result<{ entries: CodexPoolEntry[] }> {
  const file = join(home, "auth.json");
  if (!existsSync(file)) return fail("Hermes' auth.json was not found");
  let data: any;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fail("Hermes' auth.json could not be read");
  }
  const pool = data?.credential_pool?.["openai-codex"];
  if (!Array.isArray(pool) || !pool.length) return fail("Hermes has no pooled Codex accounts");
  const entries: CodexPoolEntry[] = [];
  for (const raw of pool) {
    const token = typeof raw?.access_token === "string" ? raw.access_token : "";
    const claims = token ? jwtClaims(token) : null;
    const auth = claims?.["https://api.openai.com/auth"] ?? {};
    const email = String(claims?.["https://api.openai.com/profile"]?.email ?? "");
    entries.push({
      label: String(raw?.label ?? raw?.id ?? `account-${entries.length + 1}`),
      planSlug: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
      emailDomain: email.includes("@") ? email.split("@")[1].toLowerCase() : null,
      tokenExpiresAt: typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toISOString() : null,
      secret: { token, accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null },
    });
  }
  return { ok: true, entries };
}

export async function fetchCodexUsage(entry: CodexPoolEntry, request: Fetch = fetch): Promise<Result<{ usage: CodexUsage }>> {
  if (!entry.secret.token) return fail("This pool entry has no access token");
  if (entry.tokenExpiresAt && Date.parse(entry.tokenExpiresAt) < Date.now())
    return fail("Its sign-in token has expired; Hermes refreshes it the next time it uses this account");
  try {
    const { status, body } = await getJson(request, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${entry.secret.token}`,
        Accept: "application/json",
        "User-Agent": "codex-cli",
        ...(entry.secret.accountId ? { "ChatGPT-Account-Id": entry.secret.accountId } : {}),
      },
    });
    if (status === 401 || status === 403)
      return fail(`OpenAI rejected the stored token (HTTP ${status}); Hermes refreshes it on its next turn with this account`);
    if (status !== 200) return fail(`OpenAI usage endpoint returned HTTP ${status}`);
    const usage = parseCodexUsage(body);
    return usage ? { ok: true, usage } : fail("OpenAI returned no rate-limit data");
  } catch (error) {
    return fail(`OpenAI usage endpoint unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

// ── Claude subscription ────────────────────────────────────────────────────────────────────────

type ClaudeCredential = { accessToken: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string };

/** `configDir` = a slot's own CLAUDE_CONFIG_DIR (a second account); null/omitted = the default ~/.claude. */
export function readClaudeCredential(home = homedir(), configDir: string | null = null): ClaudeCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir ?? join(home, ".claude"), ".credentials.json"), "utf8"));
    const inner = parsed?.claudeAiOauth ?? parsed;
    if (typeof inner?.accessToken !== "string" || !inner.accessToken.startsWith("sk-ant-oat01-")) return null;
    return inner as ClaudeCredential;
  } catch {
    return null;
  }
}

const CLAUDE_VERSION_FALLBACK = "2.1.278";

/**
 * Read a Claude Code version from the real executable (M1, review T8b): realExecutable follows the
 * npm `.cmd` shim to its claude.exe, so there is no cmd.exe in between, and on the timeout runCapture
 * stops the whole process tree (through cmd.exe only cmd.exe was killed). Never rejects: a missing
 * CLI, a failed start or a timeout answers the fallback. `args` is for tests.
 */
export async function readClaudeCodeVersion(
  binary: string | undefined = realExecutable("claude"),
  options: { timeoutMs?: number; args?: string[] } = {},
): Promise<string> {
  if (!binary) return CLAUDE_VERSION_FALLBACK;
  const r = await runCapture(binary, options.args ?? ["--version"], { timeout: options.timeoutMs ?? 2500 });
  if (r.error || r.status !== 0) return CLAUDE_VERSION_FALLBACK;
  return /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? CLAUDE_VERSION_FALLBACK;
}

let claudeVersion: Promise<string> | null = null;
/**
 * The installed Claude Code version for the usage request's User-Agent, read once per process as an
 * async child (T8b, review T8 S-6: execFileSync through a shell held the server for up to 2.5 s on the
 * first /__ai_usage read).
 */
function claudeCodeVersion(): Promise<string> {
  return (claudeVersion ??= readClaudeCodeVersion());
}

export async function fetchClaudePlan(request: Fetch = fetch, home = homedir(), configDir: string | null = null): Promise<Result<{ plan: ClaudePlanUsage; subscriptionType: string | null; tier: string | null }>> {
  const cred = readClaudeCredential(home, configDir);
  if (!cred) return fail(configDir ? "No Claude Code sign-in found in this account's own profile" : "No Claude Code sign-in found in ~/.claude/.credentials.json");
  if (cred.expiresAt && Date.now() > cred.expiresAt)
    return fail("Claude Code's sign-in token has expired; it refreshes the next time Claude Code runs");
  try {
    const { status, body } = await getJson(request, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${await claudeCodeVersion()}`,
        Accept: "application/json",
      },
    });
    if (status !== 200) return fail(`Anthropic usage endpoint returned HTTP ${status}`);
    const plan = parseClaudePlanUsage(body);
    if (!plan) return fail("Anthropic returned no plan windows");
    return { ok: true, plan, subscriptionType: cred.subscriptionType ?? null, tier: cred.rateLimitTier ?? null };
  } catch (error) {
    return fail(`Anthropic usage endpoint unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

// ── API keys ──────────────────────────────────────────────────────────────────────────────────

export async function fetchOpenRouterKey(key: string, request: Fetch = fetch): Promise<Result<{ info: OpenRouterKey; accountCredits: number | null; accountUsage: number | null }>> {
  try {
    const headers = { Authorization: `Bearer ${key}` };
    const [k, c] = await Promise.all([
      getJson(request, "https://openrouter.ai/api/v1/key", { headers }),
      getJson(request, "https://openrouter.ai/api/v1/credits", { headers }).catch(() => ({ status: 0, body: null })),
    ]);
    if (k.status !== 200) return fail(`OpenRouter returned HTTP ${k.status}${providerMessage(k.body) ? `: ${providerMessage(k.body)}` : ""}`);
    const info = parseOpenRouterKey(k.body);
    if (!info) return fail("OpenRouter returned no key usage");
    const credits = c.status === 200 ? (c.body as any)?.data : null;
    return {
      ok: true,
      info,
      accountCredits: typeof credits?.total_credits === "number" ? credits.total_credits : null,
      accountUsage: typeof credits?.total_usage === "number" ? credits.total_usage : null,
    };
  } catch (error) {
    return fail(`OpenRouter unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function fetchElevenLabs(key: string, since: Date, until: Date, request: Fetch = fetch): Promise<Result<{ total: number; byProduct: Record<string, number>; planReadable: boolean }>> {
  try {
    const headers = { "xi-api-key": key };
    const stats = await getJson(request, `https://api.elevenlabs.io/v1/usage/character-stats?start_unix=${since.getTime()}&end_unix=${until.getTime()}&breakdown_type=product_type`, { headers });
    if (stats.status !== 200) return fail(`ElevenLabs returned HTTP ${stats.status}${providerMessage(stats.body) ? `: ${providerMessage(stats.body)}` : ""}`);
    const parsed = parseElevenCharacterStats(stats.body);
    if (!parsed) return fail("ElevenLabs returned no usage series");
    const sub = await getJson(request, "https://api.elevenlabs.io/v1/user/subscription", { headers }).catch(() => ({ status: 0, body: null }));
    return { ok: true, total: parsed.total, byProduct: parsed.byProduct, planReadable: sub.status === 200 };
  } catch (error) {
    return fail(`ElevenLabs unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function fetchRetell(key: string, since: Date, request: Fetch = fetch): Promise<Result<{ calls: number; costUsd: number; seconds: number }>> {
  try {
    const { status, body } = await getJson(request, "https://api.retellai.com/v2/list-calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1000, sort_order: "descending", filter_criteria: { start_timestamp: { lower_threshold: since.getTime() } } }),
    });
    if (status !== 200) return fail(`Retell returned HTTP ${status}`);
    // Only call_cost and start_timestamp are read from each call; the rest is dropped here.
    const costs = parseRetellCosts(body, since.getTime());
    return costs ? { ok: true, ...costs } : fail("Retell returned no call list");
  } catch (error) {
    return fail(`Retell unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function fetchDeepseek(key: string, request: Fetch = fetch): Promise<Result<{ available: boolean; balances: { currency: string; total: number }[] }>> {
  try {
    const { status, body } = await getJson(request, "https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (status !== 200) return fail(`DeepSeek returned HTTP ${status}`);
    const parsed = parseDeepseekBalance(body);
    return parsed ? { ok: true, ...parsed } : fail("DeepSeek returned no balance");
  } catch (error) {
    return fail(`DeepSeek unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function fetchPinecone(key: string, host: string, request: Fetch = fetch): Promise<Result<{ indexes: number; vectors: number | null }>> {
  try {
    const headers = { "Api-Key": key, "X-Pinecone-API-Version": "2025-04" };
    const list = await getJson(request, "https://api.pinecone.io/indexes", { headers });
    if (list.status !== 200) return fail(`Pinecone returned HTTP ${list.status}`);
    const indexes = Array.isArray((list.body as any)?.indexes) ? (list.body as any).indexes.length : 0;
    let vectors: number | null = null;
    const cleanHost = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (/^[a-z0-9.-]+\.pinecone\.io$/i.test(cleanHost)) {
      const stats = await getJson(request, `https://${cleanHost}/describe_index_stats`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
      const total = (stats?.body as any)?.totalVectorCount;
      if (typeof total === "number") vectors = total;
    }
    return { ok: true, indexes, vectors };
  } catch (error) {
    return fail(`Pinecone unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

export async function fetchFx(request: Fetch = fetch): Promise<Result<{ fx: FxRate }>> {
  try {
    const { status, body } = await getJson(request, "https://open.er-api.com/v6/latest/USD");
    if (status !== 200) return fail(`Exchange-rate service returned HTTP ${status}`);
    const fx = parseFx(body);
    return fx ? { ok: true, fx } : fail("Exchange-rate service returned no AUD rate");
  } catch (error) {
    return fail(`Exchange-rate service unreachable (${error instanceof Error ? error.name : "error"})`);
  }
}

// ── Key names (never values) ───────────────────────────────────────────────────────────────────

/** Names of the variables set in ~/.config/agentic-os.env. Values are not returned. */
export function configuredKeyNames(home = homedir()): string[] {
  try {
    const text = readFileSync(join(home, ".config", "agentic-os.env"), "utf8");
    return [...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*\S/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/** A key's value from ~/.config/agentic-os.env only (not the process environment). */
export function fileKey(name: string, home = homedir()): string {
  try {
    const text = readFileSync(join(home, ".config", "agentic-os.env"), "utf8");
    const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)$`, "m"));
    if (!m) return "";
    let v = m[1].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    return v;
  } catch {
    return "";
  }
}

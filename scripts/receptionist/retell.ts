import { checkCall } from "./flags";
import type { CallRow, FlagCode, Source } from "./types";
export type ProviderOptions = { providerKey: (name: string) => string; fetch?: typeof fetch };
export type AgentFacts = {
  name: string | null;
  voice: string;
  language: string;
  model: string;
  published: boolean;
  /** Agent version and Retell LLM (prompt) version, when known. */
  version?: number | null;
  llmVersion?: number | null;
  webhook: boolean;
  /** Host of the agent's webhook_url (never the full URL in the UI), when one is set. */
  webhookHost?: string | null;
  /** Result of an UNSIGNED probe POST to webhook_url; undefined when not probed. */
  webhookProbe?: WebhookProbe;
  modified: string | undefined;
  prompt000: boolean;
  disclosure: boolean;
  recording: boolean;
  overseas: boolean;
  transfer: boolean;
  promptKnown: boolean;
};
/**
 * "protected": reachable and rejected the unsigned probe (401/403) — the healthy answer.
 * "open": accepted an unsigned request (2xx) — anyone could write call records.
 * "unconfigured": 503, the endpoint has no signing secret and refuses everything.
 * "unreachable": anything else (timeout, redirect, 404, 5xx, non-https URL).
 */
export type WebhookProbe = "protected" | "open" | "unconfigured" | "unreachable";
/**
 * Probe a Retell webhook endpoint with an unsigned, empty event. A correctly configured
 * MU-Receptionist answers 401 without touching its database, so this is safe to repeat.
 * Only https URLs are probed; no credential is ever sent.
 */
export async function probeWebhook(url: string, request: typeof fetch = fetch): Promise<WebhookProbe> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unreachable";
  }
  if (parsed.protocol !== "https:") return "unreachable";
  try {
    const r = await request(parsed.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "agenticos_health_probe" }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (r.status === 401 || r.status === 403) return "protected";
    if (r.status === 503) return "unconfigured";
    if (r.status >= 200 && r.status < 300) return "open";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
export type NumberFacts = { attached: boolean; version: number | null; sms: boolean };
export type RetellCall = CallRow & { analysisSummary: string | null };
export const finite = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
export const iso = (x: unknown) => {
  const n = finite(x);
  return n !== null && n <= 8.64e15 ? new Date(n).toISOString() : null;
};
/** Never expose an exception message or provider error body: either may contain credentials. */
export async function providerJson(
  label: string,
  url: string,
  init: RequestInit,
  request: typeof fetch,
): Promise<Source<{ data: any }>> {
  try {
    const r = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { ok: false, reason: `${label} returned HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return {
      ok: false,
      reason: `${label} unreachable (${e instanceof Error && e.name === "TimeoutError" ? "TimeoutError" : "request failed"})`,
    };
  }
}
export async function fetchRetell(
  options: ProviderOptions & {
    agentId: string;
    number: string;
    flagCache: Map<string, FlagCode[]>;
  },
) {
  const key = options.providerKey("RETELL_API_KEY");
  const fail = { ok: false as const, reason: "Retell not configured" };
  if (!key) return { agent: fail, number: fail, calls: fail };
  const get = (path: string, body?: object) =>
    providerJson(
      "Retell",
      `https://api.retellai.com${path}`,
      {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      options.fetch ?? fetch,
    );
  const agentWork = async (): Promise<Source<AgentFacts>> => {
    const a = await get(`/get-agent/${encodeURIComponent(options.agentId)}`);
    if (!a.ok) return a;
    if (!a.data || typeof a.data !== "object")
      return { ok: false, reason: "Retell agent response invalid" };
    const llm = a.data.response_engine?.llm_id
      ? await get(`/get-retell-llm/${encodeURIComponent(a.data.response_engine.llm_id)}`)
      : null;
    const hookUrl =
      typeof a.data.webhook_url === "string" && a.data.webhook_url.trim() ? a.data.webhook_url.trim() : null;
    const webhookProbe = hookUrl ? await probeWebhook(hookUrl, options.fetch ?? fetch) : undefined;
    let webhookHost: string | null = null;
    try {
      webhookHost = hookUrl ? new URL(hookUrl).host : null;
    } catch {
      webhookHost = null;
    }
    const p =
      llm?.ok && typeof llm.data?.general_prompt === "string" ? llm.data.general_prompt : null;
    return {
      ok: true,
      name: typeof a.data.agent_name === "string" ? a.data.agent_name : null,
      voice: String(a.data.voice_id ?? "unknown"),
      language: String(a.data.language ?? "unknown"),
      model: llm?.ok ? String(llm.data?.model ?? "unknown") : "unknown",
      published: a.data.is_published === true,
      webhook: hookUrl !== null,
      ...(hookUrl ? { webhookHost, webhookProbe } : {}),
      version: finite(a.data.version),
      llmVersion: llm?.ok ? finite(llm.data?.version) : null,
      // The prompt lives on the LLM, so "last changed" is whichever of agent/LLM changed last.
      modified:
        iso(
          Math.max(
            finite(a.data.last_modification_timestamp) ?? 0,
            (llm?.ok ? finite(llm.data?.last_modification_timestamp) : null) ?? 0,
          ) || null,
        ) ?? undefined,
      promptKnown: p !== null,
      prompt000: /\b(?:000|triple zero)\b/i.test(p ?? ""),
      disclosure: /\b(?:AI|artificial intelligence|virtual (?:assistant|receptionist))\b/i.test(
        p ?? "",
      ),
      recording: /recording|recorded/i.test(p ?? ""),
      overseas: /overseas|outside australia|\bAPP ?8\b/i.test(p ?? ""),
      transfer:
        llm?.ok &&
        Array.isArray(llm.data?.general_tools) &&
        llm.data.general_tools.some((t: any) => t.type === "transfer_call"),
    };
  };
  const numberWork = async (): Promise<Source<NumberFacts>> => {
    const r = await get("/list-phone-numbers");
    if (!r.ok) return r;
    if (!Array.isArray(r.data)) return { ok: false, reason: "Retell number response invalid" };
    const n = r.data.find((n: any) => n.phone_number === options.number);
    const a = n?.inbound_agents?.find((a: any) => a.agent_id === options.agentId);
    return {
      ok: true,
      attached: !!a,
      version: finite(a?.agent_version),
      sms: n?.custom_sms_enabled === true,
    };
  };
  const callsWork = async (): Promise<Source<{ rows: RetellCall[] }>> => {
    const rows: RetellCall[] = [];
    const seen = new Set<string>();
    let pagination_key: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await get("/v2/list-calls", {
        limit: 1000,
        sort_order: "descending",
        filter_criteria: { agent_id: [options.agentId] },
        ...(pagination_key ? { pagination_key } : {}),
      });
      if (!r.ok) return r;
      if (!Array.isArray(r.data)) return { ok: false, reason: "Retell calls response invalid" };
      for (const c of r.data) {
        if (!c || typeof c.call_id !== "string") continue;
        const checked = checkCall(c, options.flagCache);
        if (seen.has(c.call_id)) continue;
        seen.add(c.call_id);
        const phone = c.call_type === "phone_call";
        rows.push({
          id: c.call_id,
          kind: phone ? "phone" : "web",
          startedAt: iso(c.start_timestamp),
          durationSec: finite(c.duration_ms) === null ? null : c.duration_ms / 1000,
          from:
            phone && typeof c.from_number === "string"
              ? `••• ${c.from_number.replace(/\D/g, "").slice(-3)}`
              : null,
          status: String(c.call_status ?? "unknown"),
          disconnectReason:
            typeof c.disconnection_reason === "string" ? c.disconnection_reason : null,
          latencyP50Ms: finite(c.latency?.e2e?.p50),
          latencyP90Ms: finite(c.latency?.e2e?.p90),
          usdCents: finite(c.call_cost?.combined_cost),
          summary: null,
          summarySource: "none",
          analysisSummary:
            typeof c.call_analysis?.call_summary === "string" ? c.call_analysis.call_summary : null,
          sentiment: ["Positive", "Neutral", "Negative"].includes(c.call_analysis?.user_sentiment)
            ? c.call_analysis.user_sentiment
            : "Unknown",
          successful:
            typeof c.call_analysis?.call_successful === "boolean"
              ? c.call_analysis.call_successful
              : null,
          ...checked,
          retellUrl: `https://dashboard.retellai.com/call-history?history=${encodeURIComponent(c.call_id)}`,
        });
      }
      if (r.data.length < 1000) break;
      const last = r.data.at(-1)?.call_id;
      if (typeof last !== "string" || last === pagination_key) break;
      pagination_key = last;
    }
    return { ok: true, rows };
  };
  const [agent, number, calls] = await Promise.all([agentWork(), numberWork(), callsWork()]);
  return { agent, number, calls };
}

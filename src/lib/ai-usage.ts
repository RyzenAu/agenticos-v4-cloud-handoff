// Client side of /__ai_usage (scripts/ai-usage/plugin.ts): the AI usage & spend snapshot.
// Money arrives in AUD from the server (converted there, with the rate and its source), so it is
// formatted as AUD here rather than through useCurrency(), which assumes USD input.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiUsageSnapshot, Money } from "../../scripts/ai-usage/types";
import { fmtDateTime, fmtMoney } from "./format";

export type { AiUsageSnapshot, ApiKeyRow, SubscriptionCard, LimitWindow, Money, PriceSetting } from "../../scripts/ai-usage/types";

const KEY = ["ai-usage"] as const;

async function readSnapshot(): Promise<AiUsageSnapshot> {
  const res = await fetch("/__ai_usage", { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `Usage read failed (HTTP ${res.status})`);
  return body as AiUsageSnapshot;
}

export function useAiUsage() {
  return useQuery({
    queryKey: KEY,
    queryFn: readSnapshot,
    staleTime: 60_000,
    // While the first transcript scan runs, check back shortly; otherwise every 5 minutes (the
    // server only calls providers when their 15-minute cache has expired).
    refetchInterval: (q) => {
      const data = q.state.data as AiUsageSnapshot | undefined;
      return data && !("rows" in data.claudeModels) && /Reading/.test(data.claudeModels.reason) ? 8_000 : 5 * 60_000;
    },
  });
}

async function token(): Promise<string> {
  const r = await fetch("/__token");
  if (!r.ok) throw new Error("The local session token is unavailable.");
  const t = (await r.json())?.token;
  if (typeof t !== "string") throw new Error("The local session token is unavailable.");
  return t;
}

async function post(path: string, body: unknown): Promise<AiUsageSnapshot> {
  const res = await fetch(`/__ai_usage${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
    body: JSON.stringify(body ?? {}),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out || out.error) throw new Error(out?.error ?? `Request failed (HTTP ${res.status})`);
  return out as AiUsageSnapshot;
}

export function useAiUsageActions() {
  const client = useQueryClient();
  const set = (s: AiUsageSnapshot) => client.setQueryData(KEY, s);
  return {
    refresh: async () => set(await post("/refresh", {})),
    savePrice: async (id: string, value: { amount: number | null; currency: "AUD" | "USD"; gstIncluded: boolean } | null) =>
      set(await post("/settings", { prices: { [id]: value } })),
    saveOwner: async (label: string, name: string | null) => set(await post("/settings", { owners: { [label]: name } })),
  };
}


/** A$1,234.56 (always named as AUD in the page copy; the symbol alone is "$"). */
export function fmtAud(n: number | null | undefined, whole = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return fmtMoney(n, { whole });
}

export function fmtMoneyOrigin(m: Money | null): string {
  if (!m) return "";
  return m.original.currency === "USD" ? `US$${m.original.amount.toFixed(m.original.amount < 1 && m.original.amount > 0 ? 3 : 2)}` : "";
}

/** "resets in 2 d 5 h" / "resets in 43 min". */
export function fmtResetIn(iso: string | null, now = Date.now()): string {
  if (!iso) return "no reset reported";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "no reset reported";
  if (ms <= 0) return "resetting now";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `resets in ${d} d ${h} h`;
  if (h > 0) return `resets in ${h} h ${m} min`;
  return `resets in ${Math.max(1, m)} min`;
}

export function fmtResetAt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fmtDateTime(d, { weekday: true });
}

export const pressureTone = (pct: number | null): "success" | "warn" | "danger" | "neutral" =>
  pct === null ? "neutral" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : "success";

// R9 ops: the always-on hub computer's health from GET /__health (components.host, built by scripts/ops/host-health.ts from the facts
// deploy/windows/mu-health-check.ps1 writes every 5 minutes). Active alerts are shown on Home and System to any signed-in founder.
export type HostHealthCheck = { id: string; label: string; state: "ok" | "problem" | "info"; detail: string };
/** `plain` is what the pages show; detail/recovery (paths, commands) are for the Event Log, Telegram and /__health readers only. */
export type HostHealthAlert = { id: string; title: string; plain?: string; detail?: string; recovery?: string; since: string };
export type HostHealth = {
  status: string;
  detail: string;
  recovery?: string;
  checkedAt: string | null;
  host: string | null;
  reportUnreadable?: boolean;
  checks: HostHealthCheck[];
  alerts: HostHealthAlert[];
  telegram?: boolean;
};

/** /__health answers 503 when a component failed; the body is still the report. Anything else (401, offline, an older hub) gives null. */
export async function fetchHostHealth(fetchImpl: typeof fetch = fetch): Promise<HostHealth | null> {
  const res = await fetchImpl("/__health", { headers: { Accept: "application/json" } });
  if (res.status !== 200 && res.status !== 503) return null;
  const body = (await res.json().catch(() => null)) as { components?: { host?: HostHealth } } | null;
  const h = body?.components?.host;
  return h && Array.isArray(h.checks) && Array.isArray(h.alerts) ? h : null;
}

/** True when the report is old enough that the page should say so (the check runs every 5 minutes). */
export function hostReportStale(h: HostHealth, now: number, staleMinutes = 15): boolean {
  if (!h.checkedAt) return false;
  const t = Date.parse(h.checkedAt);
  return !Number.isFinite(t) || now - t > staleMinutes * 60_000;
}

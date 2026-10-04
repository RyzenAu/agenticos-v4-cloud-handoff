import { useEffect, useMemo, useState } from "react";
import { KeyRound, ShieldCheck, Wallet, Clock, Gauge, RefreshCw } from "lucide-react";
import { useLiveData, useRefreshLiveData } from "@/lib/use-live-data";
import claudeLogoPng from "@/assets/claude-logo.png";
import openaiLogoPng from "@/assets/logos/openai.png";
import openrouterLogoPng from "@/assets/logos/openrouter.png";
import antigravityLogoPng from "@/assets/logos/antigravity.png";
import codexLogoPng from "@/assets/logos/codex.png";
import { fmtTime } from "@/lib/format";

// Bars and dials encode PRESSURE, not the provider's brand (design system:
// brand colour lives only in the logo). Normal use is the accent; 70%+ warns;
// 90%+ is danger.
const ANTHROPIC_ORANGE = "var(--brand)";
const OPENAI_GREEN = "var(--brand)";
const OPENROUTER_BLUE = "var(--brand)";
const ANTIGRAVITY_PURPLE = "var(--brand)";
const pressure = (pct: number, base: string) =>
  pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warn)" : base;

// Product-level service names — match the actual agent the operator
// hits, not the brand/parent subscription. The tagline beneath each row
// still surfaces the subscription that powers it (e.g. "Claude Max
// 20x"), so the billing entity is visible but the headline is "what you
// use" not "what brand you signed up to".
// "ChatGPT" is the Codex lane's user-facing name — the panel has labelled the
// row that way since the plan-window rewrite; the union just never caught up.
type Service = "Claude Code" | "Codex" | "ChatGPT" | "OpenRouter" | "Antigravity";

interface UsageWindow {
  label: string; // "5h" | "Weekly" | "Monthly"
  used: number;
  cap: number;
  unit: "msgs" | "$" | "%";
  pct: number;
  resetIn: string;
}

interface ServiceUsage {
  service: Service;
  brand: string;
  slug: string;
  plan: string;
  authBadge: string;
  authIcon: typeof KeyRound;
  windows: UsageWindow[];
}

// Real reset windows aren't yet emitted by the aggregator (they'd require
// reading Anthropic/OpenAI's per-account quota state). We label these as
// "—" so we don't fake exact countdowns. When the aggregator starts
// surfacing real reset times we wire them in here.
function fiveHourReset(): string {
  return "—";
}
function weeklyReset(): string {
  return "—";
}
function monthlyReset(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const days = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 86400000));
  return `${days}d`;
}

function buildServices(liveData: any): ServiceUsage[] {
  const out: ServiceUsage[] = [];

  const cw = liveData?.usage?.claudeWindow as any;
  if (cw) {
    // Use multi-window data if available from the aggregator
    const multiWindows: UsageWindow[] = cw.windows
      ? cw.windows.map((w: any) => ({
          label: w.label,
          used: w.used,
          cap: w.cap,
          unit: "msgs" as const,
          pct: w.pct,
          resetIn: w.label.startsWith("5") ? fiveHourReset() : weeklyReset(),
        }))
      : [
          {
            label: "5h",
            used: cw.messagesUsed,
            cap: cw.messageCap,
            unit: "msgs" as const,
            pct: cw.pctUsed,
            resetIn: fiveHourReset(),
          },
        ];

    out.push({
      service: "Claude Code",
      brand: ANTHROPIC_ORANGE,
      slug: "anthropic",
      plan: cw.plan,
      authBadge: cw.authMode === "oauth" ? "OAuth" : "API key",
      authIcon: cw.authMode === "oauth" ? ShieldCheck : KeyRound,
      windows: multiWindows,
    });
  }

  const gw = liveData?.usage?.chatgptWindow as any;
  if (gw) {
    // ChatGPT (formerly labelled "Codex") — its real usage comes from OpenAI's
    // own rate-limit headers, cached by Codex into its session logs. When those
    // windows are present we show the true %; otherwise we fall back to the
    // "connected" row so the subscription still surfaces.
    const fmtReset = (resetsAt?: number): string => {
      if (!resetsAt) return "no reset";
      const ms = resetsAt * 1000 - Date.now();
      if (ms <= 0) return "as of last run";
      const d = Math.floor(ms / 86_400_000);
      if (d >= 1) return `~${d}d`;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return h >= 1 ? `~${h}h` : `~${m}m`;
    };
    const realWindows: UsageWindow[] =
      Array.isArray(gw.windows) && gw.windows.length > 0
        ? gw.windows.map((w: any) => {
            const pct = Math.round(Number(w.pct) || 0);
            return {
              label: w.label,
              used: pct,
              cap: 100,
              unit: "%" as const,
              pct,
              resetIn: fmtReset(w.resetsAt),
            };
          })
        : [
            {
              label: "3h",
              used: gw.messagesUsed,
              cap: gw.messageCap,
              unit: "msgs",
              pct: gw.pctUsed,
              resetIn: fiveHourReset(),
            },
          ];
    out.push({
      service: "ChatGPT",
      brand: OPENAI_GREEN,
      slug: "chatgpt",
      plan: gw.plan,
      authBadge: gw.hasOauth ? "OAuth" : gw.hasApiKey ? "API key" : "—",
      authIcon: gw.hasOauth ? ShieldCheck : KeyRound,
      windows: realWindows,
    });
  }

  const or = liveData?.usage?.openrouter as any;
  if (or) {
    const used = or.usage ?? 0;
    const limit = or.limit ?? 0;
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const remaining = Math.max(0, limit - used);
    out.push({
      service: "OpenRouter",
      brand: OPENROUTER_BLUE,
      slug: "openrouter",
      plan: "Pay-as-you-go",
      authBadge: "API key",
      authIcon: KeyRound,
      windows: [
        {
          label: `Credit · $${remaining.toFixed(2)} left of $${limit}`,
          used,
          cap: limit,
          unit: "$",
          pct,
          resetIn: "no reset",
        },
      ],
    });
  }

  // Antigravity — Google's Gemini-powered coding agent. Free, no
  // quota windows, no subscription. Surface a "free agent · no
  // limits" row so the operator sees ALL their coding agents in one
  // place rather than only the paid ones. Uses conversation count
  // from the aggregator to show actual activity.
  const ag = liveData?.detection?.apps?.antigravity as any;
  if (ag?.detected) {
    const convs = ag?.usage?.conversations ?? 0;
    const ago = ag?.usage?.lastActiveAgo ?? "—";
    out.push({
      service: "Antigravity",
      brand: ANTIGRAVITY_PURPLE,
      slug: "antigravity",
      plan: "Free · no quota",
      authBadge: "Google account",
      authIcon: ShieldCheck,
      windows: [
        {
          label: `${convs} conversation${convs === 1 ? "" : "s"} · last active ${ago}`,
          used: convs,
          // No cap. Use a generous synthetic cap so the bar reads
          // "unlimited headroom" rather than maxing out.
          cap: Math.max(100, convs * 4),
          unit: "msgs",
          pct: 0,
          resetIn: "unlimited",
        },
      ],
    });
  }

  return out;
}

function fmt(value: number, unit: "msgs" | "$" | "%") {
  if (unit === "$") return `$${value.toFixed(value < 10 ? 2 : 0)}`;
  if (unit === "%") return `${value}%`;
  return value.toLocaleString();
}

export function UsagePanel() {
  const liveData = useLiveData();
  const refreshLiveData = useRefreshLiveData();
  const services = useMemo(() => buildServices(liveData), [liveData]);
  const [syncTime, setSyncTime] = useState<string>("");

  useEffect(() => {
    setSyncTime(
      fmtTime(new Date(liveData?.generatedAt || Date.now())),
    );
  }, [liveData]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // In dev mode, call the aggregator via a fetch to the dev server's
      // custom endpoint. If that fails, just reload the page.
      // Fetch the per-run token from the loopback-only /__token endpoint,
      // then send it as X-Claude-OS-Token. The dev server rejects any
      // /__refresh_data POST without it, so a malicious browser tab or
      // extension can't trigger the aggregator (which scans ~/.claude/,
      // decodes JWTs, and runs `security dump-keychain`).
      let token: string | null = null;
      try {
        const t = await fetch("/__token");
        if (t.ok) token = (await t.json()).token ?? null;
      } catch {
        /* ignore — server may not expose it in prod builds */
      }
      const res = await fetch("/__refresh_data", {
        method: "POST",
        headers: token ? { "X-Claude-OS-Token": token } : {},
      }).catch(() => null);
      if (!res || !res.ok) {
        // Fallback: just reload the page (which will re-run seed:data)
        window.location.reload();
        return;
      }
      // Reload the data via React Query instead of reloading the page
      refreshLiveData();
    } catch {
      refreshLiveData();
    }
  };

  return (
    <section className="relative mb-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold leading-snug tracking-[-0.01em]">Plan limits &amp; windows</h2>
        <div className="flex items-center gap-3">
          <div className="ds-num text-xs text-muted-foreground" suppressHydrationWarning>
            {syncTime ? `Synced ${syncTime}` : "Sync"}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="ds-interactive inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {services.map((s) => (
          <ServiceRow key={s.service} service={s} />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Wallet className="h-3 w-3 shrink-0" />
        Caps & balances pulled from local logs and the OpenRouter key endpoint. No new credentials
        required.
      </div>
    </section>
  );
}

function ServiceRow({ service }: { service: ServiceUsage }) {
  const Icon = service.authIcon;
  // Use the most-pressing window for the dial.
  const primary = [...service.windows].sort((a, b) => b.pct - a.pct)[0];

  return (
    <div
      className="relative grid grid-cols-1 gap-6 p-5 md:grid-cols-[260px_1fr] md:p-6"
    >
      {/* LEFT — identity + dial */}
      <div className="flex items-center gap-4">
        <Dial pct={primary.pct} brand={pressure(primary.pct, service.brand)} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-inset">
              {(() => {
                const localLogos: Record<string, string> = {
                  anthropic: claudeLogoPng,
                  openai: openaiLogoPng,
                  // Simple Icons dropped the ChatGPT mark (its CDN answers 404).
                  chatgpt: openaiLogoPng,
                  codex: codexLogoPng,
                  openrouter: openrouterLogoPng,
                  antigravity: antigravityLogoPng,
                };
                const src = localLogos[service.slug] ?? `https://cdn.simpleicons.org/${service.slug}/FFFFFF`;
                return (
                  <img
                    src={src}
                    alt={service.service}
                    className="h-3.5 w-3.5 object-contain"
                    loading="lazy"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                );
              })()}
            </div>
            <div className="text-sm font-semibold tracking-tight truncate">{service.service}</div>
          </div>
          <div className="mt-1.5 truncate text-xs text-muted-foreground">{service.plan}</div>
          <div className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Icon className="h-2.5 w-2.5" />
            {service.authBadge}
          </div>
        </div>
      </div>

      {/* RIGHT — bars per window */}
      <div className="flex flex-col gap-3 justify-center">
        {service.windows.map((w) => (
          <WindowBar key={w.label} window={w} brand={pressure(w.pct, service.brand)} />
        ))}
      </div>
    </div>
  );
}

function WindowBar({ window: w, brand }: { window: UsageWindow; brand: string }) {
  const widthPct = Math.max(0.5, Math.min(100, w.pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="ds-label">{w.label}</span>
          <span className="ds-num text-xs font-semibold tracking-tight">
            {fmt(w.used, w.unit)}
            <span className="text-muted-foreground font-normal">
              {" / "}
              {fmt(w.cap, w.unit)}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="ds-num inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {w.resetIn}
          </span>
          <span className="ds-num w-9 text-right text-xs text-foreground">
            {w.pct}%
          </span>
        </div>
      </div>

      <div className="relative h-1.5 overflow-hidden rounded-full bg-border">
        {/* tick marks at 25/50/75 */}
        <div className="absolute inset-0 flex">
          <div className="flex-1 border-r border-foreground/[0.04]" />
          <div className="flex-1 border-r border-foreground/[0.04]" />
          <div className="flex-1 border-r border-foreground/[0.04]" />
          <div className="flex-1" />
        </div>
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${widthPct}%`, background: brand }}
        />
      </div>
    </div>
  );
}

function Dial({ pct, brand }: { pct: number; brand: string }) {
  const size = 76;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = c * (1 - clamped / 100);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="var(--border)"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke={brand}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 600ms var(--ease-out-quart)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <Gauge className="mb-0.5 h-3 w-3 text-muted-foreground" />
        <div className="ds-num text-sm font-semibold leading-none text-foreground">
          {clamped}%
        </div>
      </div>
    </div>
  );
}

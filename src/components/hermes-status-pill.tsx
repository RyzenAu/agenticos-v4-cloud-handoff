/*
 * HermesStatusPill — a small "● Hermes" indicator that lives in the top
 * bar on every route. Two roles:
 *   1. Signal that Hermes is alive in the system (so users know their
 *      operator dashboard and Hermes are actually wired together).
 *   2. Persistent quick-link to /agents/hermes from anywhere.
 *
 * Polls the live `/__hermes_status` endpoint (not live-data.json) so the
 * state is fresh within a few seconds — important because Hermes can
 * come online / go offline out-of-band (gateway restart, install, etc).
 *
 * Renders nothing when Hermes isn't installed. The bar stays clean for
 * users who haven't set it up.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BrandMark, StatusDot } from "@/components/ds";

interface HermesStatus {
  installed: boolean;
  version: string | null;
  configured: boolean;
  defaultModel: string | null;
  provider: string | null;
  needsSetup: boolean;
}

export function HermesStatusPill() {
  const { data: status } = useQuery<HermesStatus>({
    queryKey: ["hermes-status"],
    queryFn: async () => {
      const res = await fetch("/__hermes_status");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    // 4s polling — same cadence as the chat page. Keeps the pill fresh
    // without thrashing the filesystem.
    refetchInterval: 4000,
    staleTime: 0,
    // Failure is fine: we treat anything that throws as "not installed".
    retry: false,
  });

  if (!status?.installed) return null;

  // Two states: needs setup (warn dot) or configured + ready (success dot).
  const ready = status.configured && !status.needsSetup;
  const stateLabel = ready ? "online" : "setup";

  return (
    <Link
      to="/agents/hermes"
      className="ds-interactive inline-flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1 text-xs font-medium tracking-tight hover:border-border-strong hover:bg-surface-raised"
      title={
        ready
          ? `Hermes online · ${status.defaultModel ?? "no model"} via ${status.provider ?? "—"}`
          : "Hermes installed — needs setup"
      }
    >
      <BrandMark agent="hermes" size={14} />
      <StatusDot tone={ready ? "success" : "warn"} label="Hermes" />
      <span className="hidden text-muted-foreground sm:inline">{stateLabel}</span>
    </Link>
  );
}

export default HermesStatusPill;

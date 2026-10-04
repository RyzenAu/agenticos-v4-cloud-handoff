// R9 ops: the hub computer's alerts (supervisor gave up, hub or Hindsight down, backups, disk, sign-in records) on Home and System for any
// signed-in founder, and the plain per-service list on System. Nothing shows on a PC hub, where the host check doesn't run.
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { Notice, StatusDot, Widget } from "@/components/ds";
import { fmtDateTime } from "@/lib/format";
import { fetchHostHealth, hostReportStale, type HostHealth } from "@/lib/host-health";

export function useHostHealth() {
  return useQuery({ queryKey: ["system", "host-health"], queryFn: () => fetchHostHealth(), staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false });
}

/**
 * One notice per active alert; a stale or unreadable report gets one quiet line. Plain words only: the commands and paths that fix it
 * go to the Event Log and the owner's Telegram, never onto the page.
 */
export function HostAlertsNotice({ health, now = Date.now() }: { health: HostHealth | null | undefined; now?: number }) {
  if (!health) return null;
  if (health.reportUnreadable) {
    return (
      <div className="mb-6" data-host-alerts="unreadable">
        <Notice tone="warn" title="Hub computer: the health report can't be read">
          The next check, within 5 minutes, writes a new one.
        </Notice>
      </div>
    );
  }
  if (!health.checkedAt) return null;
  const stale = hostReportStale(health, now);
  if (!health.alerts.length && !stale) return null;
  return (
    <div className="mb-6 flex flex-col gap-3" data-host-alerts={health.alerts.length}>
      {health.alerts.map((a) => (
        <Notice key={a.id} tone="danger" title={`Hub computer: ${a.title}`}>
          {a.plain ?? ""} <span className="text-muted-foreground">Since {fmtDateTime(a.since)}. {health.telegram ? "The steps to fix it went to the owner's Telegram." : "The steps to fix it are in the hub computer's Event Log."}</span>
        </Notice>
      ))}
      {stale && (
        <Notice tone="warn" title="Hub computer: the health check hasn't run recently">
          What you see may be out of date.
        </Notice>
      )}
    </div>
  );
}

export function HostAlertsHealthNotice() {
  const q = useHostHealth();
  return <HostAlertsNotice health={q.data} />;
}

const DOT = { ok: "success", problem: "danger", info: "neutral" } as const;

/** System page: every service on the hub computer in one plain list. */
export function HostHealthList({ health }: { health: HostHealth | null | undefined }) {
  if (!health || !health.checkedAt) return null;
  const problems = health.checks.filter((c) => c.state === "problem").length;
  return (
    <Widget
      icon={Server}
      title={`Hub computer${health.host ? ` (${health.host})` : ""}`}
      badge={problems ? `${problems} not ok` : "All ok"}
      span={2}
      data-host-health={health.status}
    >
      <ul className="flex flex-col gap-2 text-sm">
        {health.checks.map((c) => (
          <li key={c.id} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <StatusDot tone={DOT[c.state]} label={c.label} className="shrink-0 sm:w-48" />
            <span className="text-muted-foreground">{c.detail}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Checked {fmtDateTime(health.checkedAt)} by the hub's 5-minute health check. Alerts also go to the Windows Event Log
        {health.telegram ? " and to the owner's Telegram" : ""}.
      </p>
    </Widget>
  );
}

export function HostHealthPanel() {
  const q = useHostHealth();
  return <HostHealthList health={q.data} />;
}

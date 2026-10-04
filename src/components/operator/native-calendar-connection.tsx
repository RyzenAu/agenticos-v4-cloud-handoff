// The one calendar status card. It picks the single truest state from /calendar/health (the
// same answer Business, the HUD and Jarvis use) and offers one primary action. Refreshing runs
// on the server every 15 minutes (scripts/calendar-health.ts); this card never needs to be open.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings2, Upload } from "lucide-react";
import calendarLogo from "@/assets/logos/googlecalendar.svg";
import { operatorRequest, useOperator } from "@/lib/operator";
import { syncedLabel, useCalendarHealth } from "@/lib/calendar-health";
import { Busy } from "./ui";
import { Button } from "@/components/ds";
import "./native-calendar-connection.css";

type NativeCalendar = {
  available: boolean;
  enabled: boolean;
  /** The owner chose the Codex route (it may still be unable to refresh). */
  configured?: boolean;
  account?: string;
  savedAccount?: string;
  error?: string;
  problem?: string;
  ownerAction?: string;
  syncing?: boolean;
  /** Codex hasn't answered its first check yet (the server stopped waiting after a few seconds). */
  checking?: boolean;
  /** false in a quiet preview copy, which never starts Codex; `note` says why. */
  checked?: boolean;
  note?: string;
  /** True when this copy may ask Codex (never on a quiet preview). */
  canCheck?: boolean;
  checkedAt?: string;
  coverage?: {
    timeMin: string;
    timeMax: string;
    syncedAt: string;
    eventCount: number;
    complete: boolean;
  };
};
export function useNativeCalendar() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return useQuery<NativeCalendar>({
    queryKey: ["native-calendar"],
    queryFn: () => operatorRequest("/calendar/native"),
    enabled: ready,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}
const CONNECTIONS = "/settings#connections";

export function NativeCalendarConnection({
  month,
  autoRefresh = false,
  accountSync,
  onImport,
}: {
  month?: Date | null;
  autoRefresh?: boolean;
  /** Direct (OAuth) calendar accounts connected in Settings → Connections, if any. */
  accountSync?: { count: number; busy: boolean; run: () => Promise<void> };
  onImport?: () => void;
}) {
  const query = useNativeCalendar();
  const health = useCalendarHealth();
  const qc = useQueryClient();
  const { refresh } = useOperator();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inFlight = useRef(false),
    lastAttempt = useRef(0);
  const anchor = month || new Date();
  const timeMin = new Date(anchor.getFullYear(), anchor.getMonth(), -6).toISOString();
  const timeMax = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 8).toISOString();
  const sync = useCallback(
    async (enable = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      lastAttempt.current = Date.now();
      setBusy(true);
      setError("");
      try {
        await operatorRequest("/calendar/native/sync", { enable, timeMin, timeMax });
        await refresh();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        await Promise.all([query.refetch(), qc.invalidateQueries({ queryKey: ["calendar-health"] })]);
        inFlight.current = false;
        setBusy(false);
      }
    },
    [timeMin, timeMax, refresh, query.refetch, qc],
  );
  const coverage = query.data?.coverage;
  // Freshness is the server's job (the 15-minute background sync). Loading or paging the calendar never
  // syncs by itself (T8c: that POST started Codex whenever the month on screen reached outside the saved
  // range, e.g. every first load late in a month); a month outside it says so and "Refresh now" loads it.
  const uncovered = !!autoRefresh && !!coverage && !(coverage.timeMin <= timeMin && coverage.timeMax >= timeMax);
  async function check() {
    setBusy(true);
    setError("");
    try {
      qc.setQueryData(["native-calendar"], await operatorRequest("/calendar/native/check", {}));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await operatorRequest("/calendar/native/disconnect", {});
      await Promise.all([query.refetch(), qc.invalidateQueries({ queryKey: ["calendar-health"] })]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const h = health.data;
  const native = query.data;
  const loading = health.isPending && !h;
  const working = busy || !!accountSync?.busy;
  const stateClass = h ? ` is-${h.state}` : "";
  // One title, one explanation, one owner action — chosen from the shared health answer.
  const title = loading
    ? "Checking your calendar…"
    : !h
      ? "Calendar status unavailable"
      : h.state === "live"
        ? `${h.sourceLabel || "Calendar"} connected`
        : h.headline;
  const detail = !h
    ? health.error?.message
    : h.state === "live"
      ? [native?.enabled && h.source === "codex" ? native.account : "", `${h.savedEvents} saved events`]
          .filter(Boolean)
          .join(" · ")
      : h.state === "none"
        ? native?.checking
          ? "Checking whether Codex has a Google Calendar connection…"
          : native?.checked === false
            ? native.note ?? "Codex's calendar connection wasn't checked."
            : native?.available
              ? "Codex already has a Google Calendar connection you can use (read-only)."
              : "Connect Google in Settings → Connections, or import an .ics export."
        : h.problem || "The calendar hasn't refreshed recently. It retries every 15 minutes.";
  const detailText = uncovered && h?.state === "live" && native?.enabled
    ? `${detail ? `${detail} · ` : ""}This month reaches outside the saved range; Refresh now loads it.`
    : detail;

  let primary: { label: string; icon: "refresh" | "settings"; run?: () => void; href?: string } | null =
    null;
  if (h?.state === "live") {
    if (h.source === "codex" && native?.enabled)
      primary = { label: "Refresh now", icon: "refresh", run: () => void sync() };
    else if (accountSync?.count)
      primary = { label: "Refresh now", icon: "refresh", run: () => void accountSync.run() };
  } else if (h && native?.available && native.account && native.account !== native.savedAccount) {
    // Codex has a calendar account ready: using it is the owner's choice, one click.
    primary = { label: "Use Google Calendar", icon: "refresh", run: () => void sync(true) };
  } else if (h && native?.enabled) {
    primary = { label: "Refresh now", icon: "refresh", run: () => void sync() };
  } else if (h && accountSync?.count) {
    primary = { label: "Sync now", icon: "refresh", run: () => void accountSync.run() };
  } else if (h && native?.checked === false && native.canCheck && !native.checking) {
    // Nothing has asked Codex yet (a page load never does, T8c): asking is this click.
    primary = { label: "Check Codex", icon: "refresh", run: () => void check() };
  } else if (h && !window.location.pathname.startsWith("/settings")) {
    // Already on Settings → Connections, the Google "Connect" button is right beside this card.
    primary = { label: "Open Connections", icon: "settings", href: CONNECTIONS };
  }

  return (
    <section
      className={`ar-native-calendar${stateClass}`}
      aria-label="Calendar connection"
      role="status"
    >
      <img src={calendarLogo} alt="" />
      <div className="ar-native-calendar-copy">
        <strong>{title}</strong>
        {detailText && <p>{detailText}</p>}
        {/* With nothing connected the button beside this card IS the instruction: the sentence under the title said the same again. */}
        {h && h.state !== "live" && h.ownerAction && !(h.state === "none" && primary) && (
          <p className="ar-native-calendar-action">
            <b>What to do:</b> {h.ownerAction}
          </p>
        )}
        {h && (
          <small>
            {h.syncedAt ? `Last synced ${syncedLabel(h.syncedAt)}` : "Never synced"}
            {h.state === "none"
              ? ""
              : ` · Refreshes every ${h.background.intervalMinutes} minutes in the background${h.background.lastRunAt ? ` (last try ${syncedLabel(h.background.lastRunAt).split(" · ")[1]})` : ""}.`}
          </small>
        )}
        {(error || query.error) && (
          <p className="ar-native-calendar-error" role="alert">
            {error || query.error?.message}
          </p>
        )}
      </div>
      <div className="ar-native-calendar-actions">
        {primary &&
          (primary.href ? (
            <Button variant="outline" size="sm" asChild>
              <a href={primary.href}>
                <Settings2 size={13} />
                {primary.label}
              </a>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={working || query.isFetching}
              onClick={primary.run}
            >
              {working ? <Busy /> : <RefreshCw size={13} />}
              {working ? "Refreshing…" : primary.label}
            </Button>
          ))}
        {h && h.state !== "live" && native?.configured && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={working || query.isFetching}
            onClick={() => {
              void query.refetch();
              void health.refetch();
            }}
          >
            Check again
          </Button>
        )}
        {h?.state === "none" && onImport && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={working}
            onClick={onImport}
          >
            <Upload size={13} /> Import .ics
          </Button>
        )}
        {native?.enabled && h?.state === "live" && h.source === "codex" && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={working}
            onClick={() => void disconnect()}
          >
            Stop syncing
          </Button>
        )}
      </div>
    </section>
  );
}

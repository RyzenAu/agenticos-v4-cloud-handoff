// The Jarvis HUD: a compact, read-only glance at mode, next commitment, calls vs target, one
// overdue item, work waiting on him, systems health and the last interjections — every value
// with its age. Two forms: a floating panel over the OS (header button or Alt+Shift+J, state in
// localStorage) and the /hud route for a small always-on-top window. When the OS stops answering,
// the last values stay on screen but are marked stale; nothing turns reassuringly green.
// There are no action buttons here: the HUD can't send, dial or change anything.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge, X } from "lucide-react";
import {
  agoLabel,
  clockLabel,
  healthTone,
  HUD_OFFLINE_AFTER_MS,
  HUD_POLL_MS,
  sourceAge,
  untilLabel,
  type EventsResponse,
  type JarvisEvent,
  type NextCall,
  type ProtocolRun,
  type Source,
  type StatusSnapshot,
} from "@/lib/jarvis-hud";
import "./jarvis-hud.css";
import { HudCore } from "./hud-core";
import { useWorkspacePanel } from "@/components/workspace/api";
import { pendingUntilHydrated, useHydrated } from "@/lib/use-hydrated";
import { needsYouBadge, needsYouBreakdown } from "../../../scripts/workspace/needs-you";
import { fmtDateTime } from "@/lib/format";

const STORAGE_KEY = "jarvis:hud";

type TimerRow = { id: string; kind: "timer" | "alarm" | "reminder"; dueAt: string; label: string };
type TimersResponse = { now: string; items: TimerRow[] };

/** "4:12", "1:05:00" for a countdown; alarms and reminders show their clock time instead. */
function countdown(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/__operator${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

/** Status + events, polled; remembers when the OS last answered so stale data is labelled. */
export function useJarvisHud(enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  const [card, setCard] = useState<NextCall | null>(null);
  const status = useQuery<StatusSnapshot>({
    queryKey: ["jarvis-status"],
    queryFn: () => getJson<StatusSnapshot>("/jarvis/status"),
    refetchInterval: HUD_POLL_MS,
    refetchIntervalInBackground: true,
    enabled,
    retry: false,
    staleTime: 0,
  });
  const events = useQuery<EventsResponse>({
    queryKey: ["jarvis-events"],
    queryFn: () => getJson<EventsResponse>("/jarvis/events?since=0"),
    refetchInterval: HUD_POLL_MS,
    refetchIntervalInBackground: true,
    enabled,
    retry: false,
    staleTime: 0,
  });
  // Timers, alarms and reminders (scripts/jarvis-skills), read-only; the countdown ticks locally.
  const timers = useQuery<TimersResponse>({
    queryKey: ["jarvis-timers"],
    queryFn: () => getJson<TimersResponse>("/jarvis/timers"),
    refetchInterval: HUD_POLL_MS,
    refetchIntervalInBackground: true,
    enabled,
    retry: false,
    staleTime: 0,
  });
  const { refetch: refetchStatus } = status;
  const { refetch: refetchEvents } = events;
  const { refetch: refetchTimers } = timers;
  useEffect(() => {
    if (!enabled) return;
    const changed = () => void refetchTimers();
    window.addEventListener("jarvis:timers", changed);
    return () => window.removeEventListener("jarvis:timers", changed);
  }, [enabled, refetchTimers]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    // A protocol just ran (voice companion): show its call card and refresh straight away.
    const protocol = (event: Event) => {
      const run = (event as CustomEvent<ProtocolRun>).detail;
      if (run?.card) setCard(run.card);
      else if (run?.name === "end-call-mode") setCard(null);
      void refetchStatus();
      void refetchEvents();
    };
    window.addEventListener("jarvis:protocol", protocol);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("jarvis:protocol", protocol);
    };
  }, [enabled, refetchStatus, refetchEvents]);
  // The ONE "needs you" count (UI-truth H1): the same number as the sidebar badge and Today.
  // Read only after hydration: the server renders "?" and so must the first client render (U1).
  const needsYouQuery = pendingUntilHydrated(useWorkspacePanel("needsYou"), useHydrated());
  const needsYou = needsYouQuery.data?.ok ? needsYouQuery.data.data : null;
  const lastOk = Math.min(status.dataUpdatedAt || 0, events.dataUpdatedAt || 0);
  const offline = !status.data || now - (status.dataUpdatedAt || 0) > HUD_OFFLINE_AFTER_MS || status.isError;
  return {
    status: status.data ?? null,
    needsYou,
    needsYouFailed: Boolean(needsYouQuery.isError || (needsYouQuery.data && !needsYouQuery.data.ok)),
    events: events.data ?? null,
    timers: timers.data?.items ?? [],
    offline,
    loading: status.isLoading,
    lastOk,
    now,
    card: card ?? (status.data?.mode?.callMode && status.data.nextCall.ok ? status.data.nextCall.data : null),
  };
}

function Fresh({ source, at, now, offline }: { source: Source<unknown>; at: string; now: number; offline: boolean }) {
  if (!source.ok) return <span className="jh-fresh is-stale">unavailable</span>;
  const age = sourceAge(source, at, now);
  const stale = source.stale || offline;
  return (
    <span data-fresh-age="" className={`jh-fresh${stale ? " is-stale" : ""}`} title={source.at ? `Source time ${fmtDateTime(new Date(source.at), { year: true })}` : undefined}>
      {stale ? "stale · " : ""}
      {agoLabel(age)}
    </span>
  );
}

function modeLabel(status: StatusSnapshot | null) {
  const mode = status?.mode;
  if (!mode) return { key: "unknown", text: "Mode unknown" };
  if (mode.callMode) return { key: "call", text: "Call mode" };
  if (mode.quiet.on) return { key: "quiet", text: mode.quiet.until ? `Quiet till ${clockLabel(mode.quiet.until)}` : "Quiet" };
  if (mode.quietHours) return { key: "quiet", text: "Quiet hours" };
  return { key: "normal", text: "Normal" };
}

const deliveryLabel = (event: JarvisEvent) =>
  event.spokenAt ? "Spoken" : event.delivery === "flash" ? "Flashed" : event.delivery === "speak" ? "To say" : "HUD";

export function JarvisHudBody({ data, onClose }: { data: ReturnType<typeof useJarvisHud>; onClose?: () => void }) {
  const { status, events, offline, now, card } = data;
  const mode = modeLabel(status);
  const tone = healthTone(status, offline);
  const at = status?.generatedAt ?? new Date(now).toISOString();
  const next = status?.next;
  const nextEvent = next?.ok ? next.data?.event : null;
  const calls = status?.calls;
  const recent = [...(events?.events ?? [])].sort((a, b) => b.seq - a.seq).slice(0, 3);
  const healthText =
    tone === "good" ? "Healthy" : tone === "bad" ? `${status!.health.data!.broken} broken` : tone === "warn" ? "Check stale" : "Unknown";

  return (
    <div className={`jh-body${offline ? " is-offline" : ""}`}>
      <header className="jh-head">
        <span className="jh-mark">Jarvis</span>
        <span className={`jh-mode is-${mode.key}`}>{mode.text}</span>
        <span className={`jh-dot is-${tone}`} role="img" aria-label={`Systems: ${healthText}`} title={`Systems: ${healthText}`} />
        {onClose && (
          <button type="button" className="jh-close" onClick={onClose} aria-label="Hide HUD">
            <X size={13} />
          </button>
        )}
      </header>

      <HudCore />

      {offline && (
        <p className="jh-banner" role="status">
          {data.lastOk ? `OS not answering · values frozen ${agoLabel(now - data.lastOk)}` : "Waiting for the OS…"}
        </p>
      )}

      <section className="jh-row" aria-label="Next commitment">
        <div className="jh-label">
          Next
          {next && <Fresh source={next} at={at} now={now} offline={offline} />}
        </div>
        {!next ? (
          <p className="jh-value is-muted">—</p>
        ) : !next.ok ? (
          <p className="jh-value is-muted">Calendar unavailable</p>
        ) : nextEvent ? (
          <p className="jh-value">
            <span className="jh-title">{nextEvent.title}</span>
            <span className="jh-meta">
              {clockLabel(nextEvent.start, now)}
              {untilLabel(nextEvent.start, now) && <em> · {untilLabel(nextEvent.start, now)}</em>}
            </span>
          </p>
        ) : (
          <p className="jh-value is-muted">{next.stale ? "Nothing as of last sync" : "Nothing else booked"}</p>
        )}
      </section>

      <section className="jh-row" aria-label="Calls against target">
        <div className="jh-label">
          Calls today
          {calls && <Fresh source={calls} at={at} now={now} offline={offline} />}
        </div>
        {calls?.ok && calls.data ? (
          <div className="jh-calls">
            {calls.data.founders.map((f) => {
              const pct = f.target ? Math.min(100, Math.round((f.calls / f.target) * 100)) : 0;
              return (
                <div className="jh-founder" key={f.who}>
                  <span className="jh-who">{f.who[0].toUpperCase() + f.who.slice(1)}</span>
                  <span className="jh-bar" aria-hidden>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="jh-num">
                    {f.calls}
                    <small>/{f.target || "—"}</small>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="jh-value is-muted">{calls ? "CRM unavailable" : "—"}</p>
        )}
        {calls?.headline && (
          // e.g. "Lead hunt failing since 27 Sept" (UI-truth M5): a failing source is said, never hidden.
          <p className="jh-alert" role="status" title={calls.ownerAction}>
            {calls.headline}
          </p>
        )}
      </section>

      <section className="jh-row" aria-label="Overdue">
        <div className="jh-label">Overdue</div>
        {calls?.ok && calls.data ? (
          calls.data.overdue ? (
            <p className="jh-value">
              <span className="jh-title">{calls.data.overdue.name}</span>
              <span className="jh-meta">
                follow-up{calls.data.overdue.dueAt ? ` · due ${clockLabel(calls.data.overdue.dueAt, now)}` : ""}
                {calls.data.followUpsDue > 1 && <em> · +{calls.data.followUpsDue - 1} more</em>}
              </span>
            </p>
          ) : (
            <p className="jh-value is-muted">No follow-ups due</p>
          )
        ) : (
          <p className="jh-value is-muted">Unknown</p>
        )}
      </section>

      {card && (
        <section className="jh-card" aria-label="Next call">
          <div className="jh-label">Next call · you dial</div>
          <p className="jh-title">{card.name}</p>
          <p className="jh-meta">
            {[card.vertical, card.area].filter(Boolean).join(" · ")}
            {card.phone && <span className="jh-phone">{card.phone}</span>}
          </p>
        </section>
      )}

      {data.timers.length > 0 && (
        <section className="jh-row" aria-label="Timers and reminders">
          <div className="jh-label">Timers</div>
          <ol className="jh-events">
            {data.timers.slice(0, 4).map((timer) => {
              const due = Date.parse(timer.dueAt);
              return (
                <li key={timer.id} className={timer.kind === "reminder" ? "is-normal" : "is-urgent"}>
                  <span className="jh-event-text">{timer.label}</span>
                  <span className="jh-meta">
                    {timer.kind} · {timer.kind === "timer" ? <span className="jh-num">{countdown(due - now)}</span> : clockLabel(timer.dueAt, now)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="jh-row jh-split" aria-label="Waiting and systems">
        <div>
          <div className="jh-label">Waiting on you</div>
          <p className="jh-value jh-num-lg" title={data.needsYou?.definition}>
            {needsYouBadge(data.needsYou) ?? <span className="is-muted">?</span>}
          </p>
          <p className="jh-meta">
            {data.needsYou ? needsYouBreakdown(data.needsYou) : data.needsYouFailed ? "Couldn't read the count" : "Checking…"}
          </p>
        </div>
        <div>
          <div className="jh-label">
            Systems
            {status && <Fresh source={status.health} at={at} now={now} offline={offline} />}
          </div>
          <p className={`jh-value jh-health is-${tone}`}>{healthText}</p>
        </div>
      </section>

      <section className="jh-row" aria-label="Recent interjections">
        <div className="jh-label">
          Interjections
          {status?.mode && (
            <span className="jh-fresh">
              {status.mode.budget.spoken}/{status.mode.budget.limit} spoken today
            </span>
          )}
        </div>
        {recent.length ? (
          <ol className="jh-events">
            {recent.map((event) => (
              <li key={event.id} className={`is-${event.priority}`}>
                <span className="jh-event-text">{event.text}</span>
                <span className="jh-meta">
                  {event.source} · {deliveryLabel(event)} · {agoLabel(now - Date.parse(event.createdAt))}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="jh-value is-muted">None yet</p>
        )}
      </section>

      <footer className="jh-foot">
        <span>Read-only</span>
        <span className="jh-num">{status ? `Updated ${agoLabel(now - Date.parse(status.generatedAt))}` : "—"}</span>
      </footer>
    </div>
  );
}

/** A short two-note chime for urgent alerts while talking is off (call or quiet mode). */
function chime() {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const ctx = new Context();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    [880, 1318.5].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(ctx.currentTime + index * 0.14);
      osc.stop(ctx.currentTime + 0.55);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    /* no audio: the flash still shows */
  }
}

/** The floating panel over the OS. Mount once (root layout); hidden unless toggled on. */
export function JarvisHudFloating() {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) === "open");
    } catch {
      /* private mode */
    }
  }, []);
  const toggle = useCallback((next?: boolean) => {
    setOpen((value) => {
      const result = next ?? !value;
      try {
        localStorage.setItem(STORAGE_KEY, result ? "open" : "closed");
      } catch {
        /* the toggle just won't persist */
      }
      return result;
    });
  }, []);
  const close = useCallback(() => {
    toggle(false);
    // Give focus back to the header/drawer button that opened the HUD, the way a dialog would.
    document.getElementById("jarvis-hud-toggle")?.focus();
  }, [toggle]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyJ") {
        event.preventDefault();
        toggle();
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        close();
      }
    };
    const onToggle = () => toggle();
    window.addEventListener("keydown", onKey);
    window.addEventListener("jarvis:hud-toggle", onToggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("jarvis:hud-toggle", onToggle);
    };
  }, [toggle, close, open]);
  // Polls even while hidden, so an urgent flash can open it.
  const data = useJarvisHud(true);
  const events = data.events?.events;
  useEffect(() => {
    if (!data.events) return;
    const newest = data.events.seq;
    if (seen.current === null) {
      seen.current = newest;
      return;
    }
    const fresh = (events ?? []).filter((event) => event.seq > (seen.current ?? 0));
    seen.current = newest;
    if (fresh.some((event) => event.delivery === "flash")) {
      chime();
      toggle(true);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 2400);
    }
  }, [data.events, events, toggle]);
  // Closing plays a short exit before unmounting (skipped for reduced motion).
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = open;
    if (!was || open || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setClosing(true);
    const timer = window.setTimeout(() => setClosing(false), 170);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !closing) return null;
  return (
    <aside className={`jh-float${flash ? " is-flash" : ""}${open ? "" : " is-closing"}`} aria-label="Jarvis HUD" role="dialog" aria-modal="false" aria-hidden={!open || undefined}>
      <JarvisHudBody data={data} onClose={close} />
    </aside>
  );
}

/** Header button for the floating HUD. Renders in both the header and the mobile drawer, so
 * only one instance should carry `id="jarvis-hud-toggle"` (the one Escape should return focus
 * to) — pass `id` explicitly at the call site that should own it. */
export function JarvisHudToggle({ id }: { id?: string } = {}) {
  return (
    <button
      type="button"
      id={id}
      className="op-header-ask jh-toggle"
      onClick={() => window.dispatchEvent(new CustomEvent("jarvis:hud-toggle"))}
      title="Jarvis HUD (Alt+Shift+J)"
      aria-label="Toggle the Jarvis HUD"
    >
      <Gauge size={14} /> <span className="hidden sm:inline">HUD</span>
    </button>
  );
}

/** The /hud page: the same body, filling a small always-on-top window. */
export function JarvisHudWindow() {
  const data = useJarvisHud(true);
  useEffect(() => {
    document.documentElement.classList.add("jh-window-root");
    return () => document.documentElement.classList.remove("jh-window-root");
  }, []);
  return (
    <main className="jh-window" aria-label="Jarvis HUD">
      <JarvisHudBody data={data} />
    </main>
  );
}

// The Inspector: one drawer for technical detail, so normal screens show only what to act on.
//
// Four tabs, all read from what the page already has — opening it makes no network request:
//   Decisions    entries pages, tracks and Jev publish (title, detail, confidence, source)
//   Agent steps  the live agent feed (src/lib/agent-feed.ts), every step of every handed-off task
//   Requests     this page's own /__* requests from resource timing, recorded from startup (slowest
//                first; cache hits say "cached", not a measured 0 ms)
//   Page         route, destination and the facts the page registered
//
// Publishing, without importing anything (for other tracks):
//   window.dispatchEvent(new CustomEvent("agentic:inspect", { detail: { title, detail?, confidence?, tone?, source?, key? } }))
//   window.dispatchEvent(new CustomEvent("jarvis:decision", { detail: { title, detail?, confidence?, source: "jev" } }))
// or inside React: const { publish, setFacts } = useInspector().
// Entries are deduplicated: one per `key` (or, without a key, per source + title + detail), so a
// page that republishes on every mount or refetch updates its entry instead of stacking copies.
//
// Keys: Alt+Shift+I toggles, Escape closes. The drawer is not modal; the page stays usable.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ScanSearch, X } from "lucide-react";
import { Badge, EmptyState, Segmented, fmtRelative } from "@/components/ds";
import { FEED_STATUS_LABEL, feedStatus, readFeed, subscribeFeed, type FeedStatus, type FeedTask } from "@/lib/agent-feed";
import { cn } from "@/lib/utils";
import { JobStepLog } from "@/components/jobs/job-step-log";
import { locate } from "./destinations";
import { fmtTime } from "@/lib/format";

export type InspectorEntry = {
  id: string;
  at: number;
  title: string;
  detail?: string;
  /** 0–1. Shown as a percentage and a bar; omitted when the source gives none. */
  confidence?: number;
  tone?: "neutral" | "warn" | "danger";
  source?: string;
  path: string;
  /** Stable identity for deduplication (see inspectorEntryKey). */
  key: string;
};

/** The identity an entry is deduplicated by: its explicit key, else source + title + detail. */
export function inspectorEntryKey(entry: { key?: string; title: string; detail?: string; source?: string }) {
  return entry.key ? `k:${entry.key}` : `t:${entry.source ?? ""} | ${entry.title} | ${entry.detail ?? ""}`;
}

/** Adds an entry newest-first, replacing any older entry with the same key. Pure. */
export function mergeInspectorEntry(old: readonly InspectorEntry[], item: InspectorEntry, max = MAX_ENTRIES): InspectorEntry[] {
  return [item, ...old.filter((e) => e.key !== item.key)].slice(0, max);
}

type Facts = Record<string, string>;

type InspectorApi = {
  open: boolean;
  setOpen: (open: boolean | ((v: boolean) => boolean)) => void;
  publish: (entry: Omit<InspectorEntry, "id" | "at" | "path" | "key"> & { at?: number; key?: string }) => void;
  /** Replace this key's facts (e.g. setFacts("receptionist", { "Snapshot": "3 min old" })). */
  setFacts: (key: string, facts: Facts | null) => void;
  entries: InspectorEntry[];
  facts: Record<string, Facts>;
};

const InspectorContext = createContext<InspectorApi | null>(null);
const MAX_ENTRIES = 60;
const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<InspectorEntry[]>([]);
  const [facts, setFactsState] = useState<Record<string, Facts>>({});
  const seq = useRef(0);
  const publish = useCallback<InspectorApi["publish"]>((entry) => {
    const title = text(entry.title, 140);
    if (!title) return;
    const detail = text(entry.detail, 600);
    const source = text(entry.source, 40);
    const item: InspectorEntry = {
      id: `i${++seq.current}`,
      at: entry.at ?? Date.now(),
      title,
      detail,
      confidence: clamp01(entry.confidence),
      tone: entry.tone,
      source,
      path: typeof location === "undefined" ? "" : location.pathname,
      key: inspectorEntryKey({ key: text(entry.key, 120), title, detail, source }),
    };
    setEntries((old) => mergeInspectorEntry(old, item));
  }, []);
  const setFacts = useCallback((key: string, value: Facts | null) => {
    setFactsState((old) => {
      const next = { ...old };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);
  useEffect(() => {
    const onEvent = (event: Event) => {
      const d = (event as CustomEvent).detail ?? {};
      publish({
        title: d.title,
        detail: d.detail,
        confidence: d.confidence,
        tone: d.tone === "warn" || d.tone === "danger" ? d.tone : "neutral",
        source: d.source ?? (event.type === "jarvis:decision" ? "jev" : undefined),
        key: typeof d.key === "string" ? d.key : undefined,
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyI") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("agentic:inspect", onEvent);
    window.addEventListener("jarvis:decision", onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("agentic:inspect", onEvent);
      window.removeEventListener("jarvis:decision", onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, [publish]);
  const api = useMemo(() => ({ open, setOpen, publish, setFacts, entries, facts }), [open, publish, setFacts, entries, facts]);
  return <InspectorContext.Provider value={api}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorApi {
  const api = useContext(InspectorContext);
  if (api) return api;
  // Outside the shell (the /hud window, tests): a harmless no-op.
  return { open: false, setOpen: () => {}, publish: () => {}, setFacts: () => {}, entries: [], facts: {} };
}

/** Register page facts for the Page tab while mounted. */
export function useInspectorFacts(key: string, facts: Facts | null) {
  const { setFacts } = useInspector();
  const serial = facts ? JSON.stringify(facts) : "";
  useEffect(() => {
    setFacts(key, serial ? (JSON.parse(serial) as Facts) : null);
    return () => setFacts(key, null);
  }, [key, serial, setFacts]);
}

export function InspectorToggle({ className }: { className?: string }) {
  const { open, setOpen, entries } = useInspector();
  const unseen = entries.filter((e) => e.tone === "danger" || e.tone === "warn").length;
  return (
    <button
      type="button"
      id="inspector-toggle"
      className={cn("op-header-ask sh-inspector-toggle", className)}
      aria-expanded={open}
      aria-controls="sh-inspector"
      aria-keyshortcuts="Alt+Shift+I"
      title="Inspector: logs, decisions and requests (Alt+Shift+I)"
      onClick={() => setOpen((v) => !v)}
    >
      <ScanSearch size={15} aria-hidden="true" />
      <span className="hidden lg:inline">Inspector</span>
      {unseen > 0 && <b className="sh-count" aria-label={`${unseen} warnings`}>{unseen > 9 ? "9+" : unseen}</b>}
    </button>
  );
}

type Tab = "decisions" | "steps" | "requests" | "page";

const STATUS_TONE: Record<FeedStatus, "accent" | "warn" | "success" | "danger"> = { running: "accent", "needs-you": "warn", done: "success", failed: "danger" };

/** One /__* request as the Requests tab shows it. `ms` is null when the response came from cache. */
export type RequestRow = { name: string; ms: number | null; cached: boolean; kb: number | null; status: number | null; start: number };

type TimingLike = Pick<PerformanceResourceTiming, "name" | "duration" | "startTime" | "transferSize" | "decodedBodySize"> & {
  responseStatus?: number;
  deliveryType?: string;
};

/**
 * Served from the browser's cache, so there is no network timing to report. The signal is that
 * nothing crossed the wire (transferSize 0) while a body was delivered, Chrome's deliveryType says
 * "cache", or the whole thing took under a millisecond. A revalidated 304 is not cached here: its
 * header bytes did cross the network and its duration is a real round trip.
 */
export function isCachedTiming(e: Pick<TimingLike, "transferSize" | "decodedBodySize" | "duration" | "deliveryType">) {
  if (e.transferSize !== 0) return false;
  return e.deliveryType === "cache" || e.decodedBodySize > 0 || e.duration < 1;
}

/** Keeps this origin's /__* requests (the local API), newest entries deduplicated, as rows. Pure. */
export function localRequestRows(entries: readonly TimingLike[], origin?: string): RequestRow[] {
  const seen = new Set<string>();
  const rows: RequestRow[] = [];
  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.name, origin);
    } catch {
      continue;
    }
    if (!url.pathname.startsWith("/__")) continue;
    if (origin && url.origin !== new URL(origin).origin) continue;
    const id = `${e.name}@${e.startTime}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const cached = isCachedTiming(e);
    rows.push({
      name: url.pathname,
      ms: cached ? null : Math.round(e.duration),
      cached,
      kb: e.transferSize ? Math.round(e.transferSize / 102.4) / 10 : null,
      status: typeof e.responseStatus === "number" && e.responseStatus > 0 ? e.responseStatus : null,
      start: Math.round(e.startTime),
    });
  }
  return rows;
}

/** Slowest measured first; cached rows (no timing) last. Pure. */
export function sortRequestRows(rows: readonly RequestRow[]): RequestRow[] {
  return [...rows].sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || a.start - b.start);
}

/** How the ms column reads: a measured number, "<1" rather than a fake 0, or "cached". */
export function requestTimingLabel(row: Pick<RequestRow, "ms" | "cached">) {
  if (row.cached || row.ms === null) return "cached";
  return row.ms < 1 ? "<1" : String(row.ms);
}

/**
 * Runs from the inline <head> script, before any module loads. In dev, Vite's module requests
 * alone fill the browser's default 250-entry resource-timing buffer, after which nothing else —
 * including every /__* request — is recorded, and the Requests tab was always empty.
 */
export const EARLY_REQUEST_TIMING_SCRIPT = ";try{performance.setResourceTimingBufferSize(10000)}catch(e){}";

// Belt and braces: an observer from startup keeps every /__* entry even if the buffer fills anyway
// (observers receive entries the full buffer drops).
const MAX_RECORDED = 2000;
const recorded: TimingLike[] = [];
let recorderStarted = false;
function startRequestRecorder() {
  if (recorderStarted || typeof window === "undefined" || typeof PerformanceObserver !== "function") return;
  recorderStarted = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (!e.name.includes("/__")) continue;
        recorded.push(e);
        if (recorded.length > MAX_RECORDED) recorded.splice(0, recorded.length - MAX_RECORDED);
      }
      for (const fn of listeners) fn();
    }).observe({ type: "resource", buffered: true });
  } catch {
    // No resource timing support: the tab falls back to getEntriesByType.
  }
}
const listeners = new Set<() => void>();
startRequestRecorder();

function useRequests(active: boolean) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  useEffect(() => {
    if (!active || typeof performance === "undefined") return;
    const read = () =>
      setRows(localRequestRows([...recorded, ...(performance.getEntriesByType("resource") as PerformanceResourceTiming[])], location.origin));
    read();
    listeners.add(read);
    return () => {
      listeners.delete(read);
    };
  }, [active]);
  return rows;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "bg-success" : value >= 0.6 ? "bg-warn" : "bg-danger";
  return (
    <span className="flex items-center gap-2" title={`Confidence ${pct}%`}>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-inset" aria-hidden="true">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="ds-num text-xs text-muted-foreground">{pct}%</span>
    </span>
  );
}

export function InspectorDrawer() {
  const { open, setOpen, entries, facts } = useInspector();
  const [tab, setTab] = useState<Tab>("decisions");
  const [tasks, setTasks] = useState<FeedTask[]>([]);
  const [now, setNow] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const location = useRouterState({ select: (s) => ({ path: s.location.pathname, search: s.location.searchStr }) });
  const requests = useRequests(open && tab === "requests");
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    setTasks(readFeed());
    const off = subscribeFeed(setTasks);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        document.getElementById("inspector-toggle")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.clearInterval(tick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  if (!open) return null;
  const here = locate(location.path, new URLSearchParams(location.search).get("view") ?? undefined);
  const sorted = sortRequestRows(requests);
  const cachedCount = requests.filter((r) => r.cached).length;
  const totalMs = requests.length ? Math.max(...requests.map((r) => r.start + (r.ms ?? 0))) - Math.min(...requests.map((r) => r.start)) : 0;
  return (
    <aside id="sh-inspector" className="sh-inspector" aria-labelledby="sh-inspector-title">
      <div className="sh-inspector-head">
        <h2 id="sh-inspector-title" ref={heading} tabIndex={-1} className="text-base font-semibold">
          Inspector
        </h2>
        <button
          type="button"
          className="op-icon-button"
          aria-label="Close inspector"
          onClick={() => {
            setOpen(false);
            document.getElementById("inspector-toggle")?.focus();
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <Segmented
        ariaLabel="Inspector view"
        value={tab}
        onChange={setTab}
        options={[
          { value: "decisions", label: "Decisions" },
          { value: "steps", label: "Agent steps" },
          { value: "requests", label: "Requests" },
          { value: "page", label: "Page" },
        ]}
        className="mx-4"
      />
      <div className="sh-inspector-body">
        {tab === "decisions" &&
          (entries.length ? (
            <ol className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-lg bg-inset px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className={cn("text-sm font-medium", e.tone === "danger" ? "text-danger" : e.tone === "warn" ? "text-warn" : "text-foreground")}>{e.title}</span>
                    {e.confidence !== undefined && <ConfidenceBar value={e.confidence} />}
                  </div>
                  {e.detail && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{e.detail}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {e.source ? `${e.source} · ` : ""}
                    {now ? fmtRelative(e.at, now) : ""} · <span className="font-mono">{e.path}</span>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              variant="row"
              title="No decisions recorded in this session"
              body="Jev's routing decisions, confidence and page warnings appear here as they happen."
            />
          ))}
        {tab === "steps" && (
          <section aria-label="Job history" className="mb-4">
            <h3 className="ds-label mb-2">Jobs</h3>
            <JobStepLog />
          </section>
        )}
        {tab === "steps" && tasks.length > 0 && <h3 className="ds-label mb-2">Agent handoffs</h3>}
        {tab === "steps" &&
          (tasks.length ? (
            <ol className="space-y-3">
              {tasks.map((t) => (
                <li key={t.id} className="rounded-lg bg-inset px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{t.title}</span>
                    <Badge tone={STATUS_TONE[feedStatus(t)]}>{FEED_STATUS_LABEL[feedStatus(t)]}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t.agent} · {t.steps.length} step{t.steps.length === 1 ? "" : "s"}
                  </p>
                  {t.steps.length > 0 && (
                    <ol className="mt-2 space-y-1 border-t border-border pt-2">
                      {t.steps.slice(-12).map((s, i) => (
                        <li key={`${s.at}-${i}`} className="grid grid-cols-[56px_1fr] gap-2 text-xs">
                          <span className="ds-num text-muted-foreground">{fmtTime(new Date(s.at), { seconds: true })}</span>
                          <span className={cn("min-w-0 [overflow-wrap:anywhere]", s.kind === "error" ? "text-danger" : "text-foreground")}>
                            {s.name ? <span className="font-mono text-muted-foreground">{s.name} </span> : null}
                            {s.text}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState variant="row" title="No agent work in this session" body="When Jarvis hands a task to Hermes, screen hands or a coding agent, each step is logged here." />
          ))}
        {tab === "requests" &&
          (sorted.length ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                <span className="ds-num">{requests.length}</span> local API requests since this tab loaded, spanning <span className="ds-num">{(totalMs / 1000).toFixed(1)} s</span>. Slowest first
                {cachedCount ? <>; <span className="ds-num">{cachedCount}</span> served from cache, with no network timing</> : null}.
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 font-medium">Endpoint</th>
                    <th className="py-1 text-right font-medium">ms</th>
                    <th className="py-1 text-right font-medium">KB</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 80).map((r, i) => (
                    <tr key={`${r.name}-${r.start}-${i}`} className="border-t border-border">
                      <td className="max-w-0 py-1.5 pr-2 font-mono" title={r.status && r.status >= 400 ? `${r.name} → ${r.status}` : r.name}>
                        {/* The name truncates; a failure status never does. */}
                        <span className="flex min-w-0 items-baseline gap-1">
                          <span className="truncate">{r.name}</span>
                          {r.status && r.status >= 400 ? <span className="shrink-0 text-danger">{r.status}</span> : null}
                        </span>
                      </td>
                      <td
                        className={cn("ds-num py-1.5 text-right", r.cached ? "text-muted-foreground" : r.ms !== null && r.ms > 1000 ? "text-warn" : "")}
                        title={r.cached ? "Served from the browser cache: no network timing" : undefined}
                      >
                        {requestTimingLabel(r)}
                      </td>
                      <td className="ds-num py-1.5 text-right text-muted-foreground">{r.kb ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <EmptyState variant="row" title="No local API requests recorded yet" body="Requests appear here as the page makes them." />
          ))}
        {tab === "page" && (
          <dl className="space-y-3 text-xs">
            <div>
              <dt className="ds-label">Route</dt>
              <dd className="mt-1 font-mono">{location.path + location.search}</dd>
            </div>
            <div>
              <dt className="ds-label">Destination</dt>
              <dd className="mt-1">
                {here ? `${here.destination.label}${here.drilldown ? ` › ${here.drilldown.label}` : ""}` : "Not in the main navigation"}
              </dd>
            </div>
            {Object.entries(facts).map(([key, value]) => (
              <div key={key}>
                <dt className="ds-label">{key}</dt>
                <dd className="mt-1 space-y-1">
                  {Object.entries(value).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="min-w-0 text-right [overflow-wrap:anywhere]">{v}</span>
                    </div>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </aside>
  );
}

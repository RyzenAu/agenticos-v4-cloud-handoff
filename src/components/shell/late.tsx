// Shell overlays that poll the server (Jarvis HUD, live agent panel, background jobs, the chat and
// voice dock, the accounts hub) start after the page's own data has arrived, not alongside it.
// Before this, ~15 shell requests left at the same moment as the page's, and over HTTP/1.1's six
// connections per host the page's data queued behind them (docs/PERF-20260927.md, "os-shell").
//
// "Settled" = no React Query fetch in flight for 250 ms after the first paint, capped at 4 s, and
// then one idle callback. It happens once per tab; later navigations never wait.
// A trigger event (e.g. "operator:voice") mounts the overlay at once; events that arrive before it
// has mounted are replayed right after, so the first click always works.
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useIsFetching } from "@tanstack/react-query";

let settled = false;
const waiters = new Set<() => void>();
const SETTLE_CAP_MS = 4000;
const QUIET_MS = 250;

function markSettled() {
  if (settled) return;
  settled = true;
  for (const w of waiters) w();
  waiters.clear();
}

/** Mount once in the shell: watches the page's queries and marks the tab settled. */
export function SettleWatcher() {
  const fetching = useIsFetching();
  useEffect(() => {
    if (settled) return;
    const cap = window.setTimeout(markSettled, SETTLE_CAP_MS);
    return () => window.clearTimeout(cap);
  }, []);
  useEffect(() => {
    if (settled || fetching > 0) return;
    const quiet = window.setTimeout(() => {
      const idle = typeof window.requestIdleCallback === "function";
      if (idle) window.requestIdleCallback(markSettled, { timeout: 600 });
      else markSettled();
    }, QUIET_MS);
    return () => window.clearTimeout(quiet);
  }, [fetching]);
  return null;
}

export function useSettled() {
  const [ready, setReady] = useState(settled);
  useEffect(() => {
    if (settled) return setReady(true);
    const w = () => setReady(true);
    waiters.add(w);
    return () => void waiters.delete(w);
  }, []);
  return ready;
}

function useLateGate(triggers: readonly string[], auto = true) {
  const settledNow = useSettled() && auto;
  const [forced, setForced] = useState(false);
  const queue = useRef<{ type: string; detail: unknown }[]>([]);
  const capturing = useRef(true);
  useEffect(() => {
    const capture = (event: Event) => {
      if (!capturing.current) return;
      queue.current.push({ type: event.type, detail: (event as CustomEvent).detail });
      setForced(true);
    };
    for (const type of triggers) window.addEventListener(type, capture);
    return () => {
      for (const type of triggers) window.removeEventListener(type, capture);
    };
    // triggers are static per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const replay = useRef(() => {
    capturing.current = false;
    for (const e of queue.current.splice(0)) window.dispatchEvent(new CustomEvent(e.type, { detail: e.detail }));
  }).current;
  return { show: settledNow || forced, replay };
}

function RunAfterMount({ run }: { run: () => void }) {
  // Rendered after the overlay inside the same boundary, so its effect runs once the overlay's
  // own listeners are attached.
  useEffect(run, [run]);
  return null;
}

/** Already-imported children that should only mount once the page has settled. */
export function Late({ triggers = [], placeholder = null, children }: { triggers?: readonly string[]; placeholder?: ReactNode; children: ReactNode }) {
  const { show, replay } = useLateGate(triggers);
  if (!show) return <>{placeholder}</>;
  return (
    <>
      {children}
      <RunAfterMount run={replay} />
    </>
  );
}

/** A lazily imported overlay that loads once the page has settled (or a trigger fires). */
export function lateOverlay<P extends object>(load: () => Promise<ComponentType<P>>, triggers: readonly string[], { auto = true } = {}) {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  return function LateOverlay(props: P) {
    const { show, replay } = useLateGate(triggers, auto);
    if (!show) return null;
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
        <RunAfterMount run={replay} />
      </Suspense>
    );
  };
}

/** Chat + voice dock (same triggers as src/lib/deferred-overlays.tsx). */
export const LateFloatingOracle = lateOverlay(
  () => import("@/components/floating-oracle").then((m) => m.FloatingOracle),
  ["operator:ask", "oracle:activate", "brain:open", "memory:source-preview", "argentic:chat-host", "operator:voice", "operator:voice-text", "operator:voice-wake", "jarvis:meeting"],
);

/** Connect-an-account modal, opened only by the `agentic:accounts` event, so it (and recharts)
 *  loads on that first click instead of on every page. */
export const LateAccountsHub = lateOverlay(
  () => import("@/components/operator/accounts-hub").then((m) => m.AccountsHub),
  ["agentic:accounts"],
  { auto: false },
);

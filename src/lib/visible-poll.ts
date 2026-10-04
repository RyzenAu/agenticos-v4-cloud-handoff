// One poll loop for a page that polls with setInterval (round 6).
//
//  - It never runs in a hidden tab. A hidden tab reads nothing; the moment the tab is visible again, it reads at once (so the data is
//    never older than the time the tab was hidden, and `staleSinceMs` says how long the last good read has been waiting).
//  - The next read is scheduled when the last one SETTLES, so a slow hub is never hit by overlapping reads.
//  - A failed read backs off (x2 each failure, capped) instead of hammering a hub that is down, and the failure is reported, not swallowed:
//    callers keep showing the last good data with its age and an honest "can't reach the hub" state until a read succeeds.
//  - The delay can depend on what the page knows (a running job: quick; nothing running: slow), re-evaluated after every read.
//
// Pure scheduling lives in createVisiblePoller (injectable timers and visibility) so tests run without a browser.
import { useEffect, useRef, useState } from "react";

export type PollState = { lastOkAt: number | null; failures: number; lastError: string | null };

export type PollerDeps = {
  /** One read. Resolve = good read; reject (or throw) = failed read. */
  load: () => Promise<unknown>;
  /** Milliseconds until the next read after a good one. */
  delayMs: () => number;
  hidden?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  onState?: (state: PollState) => void;
  /** Longest wait after repeated failures. */
  maxBackoffMs?: number;
  /** A read that has not settled in this long counts as a failed read, so one hung request (a sleeping PC, a dropped tailnet) can never stall the poll. Default 20 s. */
  loadTimeoutMs?: number;
};

/** Delay after `failures` consecutive failed reads: the normal delay doubled each time, capped. */
export function backoffMs(baseMs: number, failures: number, maxMs = 60_000): number {
  if (failures <= 0) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures, 6));
}

export function createVisiblePoller(deps: PollerDeps) {
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.hidden);
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let running = false;
  let stopped = true;
  let inFlight = false;
  const state: PollState = { lastOkAt: null, failures: 0, lastError: null };
  const emit = () => deps.onState?.({ ...state });

  const schedule = () => {
    if (stopped || timer !== null) return;
    if (hidden()) return; // resumes from nudge() on visibilitychange
    const wait = state.failures ? backoffMs(deps.delayMs(), state.failures, deps.maxBackoffMs) : deps.delayMs();
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, wait);
  };

  async function tick() {
    if (stopped || inFlight) return;
    if (hidden()) return;
    inFlight = true;
    try {
      const limit = deps.loadTimeoutMs ?? 20_000;
      let timer: unknown;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimer(() => reject(new Error(`no answer within ${Math.round(limit / 1000)} s`)), limit);
      });
      try {
        await Promise.race([deps.load(), timeout]);
      } finally {
        clearTimer(timer);
      }
      state.lastOkAt = now();
      state.failures = 0;
      state.lastError = null;
    } catch (e) {
      state.failures += 1;
      state.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      inFlight = false;
    }
    emit();
    schedule();
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    /** The tab became visible (or the caller wants a read now): read at once, replacing any pending wait. */
    nudge() {
      if (stopped) return;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      void tick();
    },
    state: () => ({ ...state }),
    /** For tests. */
    get pending() {
      return timer !== null;
    },
  };
}

/** The age of the last good read in ms, or null when there has been none. */
export function staleSinceMs(state: PollState, now = Date.now()): number | null {
  return state.lastOkAt === null ? null : now - state.lastOkAt;
}

/**
 * React wrapper. `load` should throw on failure. Returns the poll state so the page can say "last updated Ns ago" or "can't reach the hub".
 * `delayMs` is read fresh after every read (close over current state).
 */
export function useVisiblePoll(load: () => Promise<unknown>, delayMs: () => number, enabled = true): { state: PollState; nudge: () => void } {
  const [state, setState] = useState<PollState>({ lastOkAt: null, failures: 0, lastError: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const poller = createVisiblePoller({ load: () => loadRef.current(), delayMs: () => delayRef.current(), onState: setState });
    pollerRef.current = poller;
    poller.start();
    const onVisible = () => {
      if (!document.hidden) poller.nudge();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      poller.stop();
      pollerRef.current = null;
    };
  }, [enabled]);
  return { state, nudge: () => pollerRef.current?.nudge() };
}

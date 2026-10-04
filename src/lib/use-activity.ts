// React side of the live activity stream (programme S-stream). ONE subscription per browser (activity-stream.ts);
// these hooks are what Home, the Jarvis HUD, the job chip and Computers use.
//
//   useActivity(handler, topics?)       run a function for each event (and each snapshot) of those topics
//   useActivityStatus()                 { healthy, state, lastSignalAt } for "live" dots and offline detection
//   useStreamInvalidate(keys, topics)   refetch these react-query keys when one of those topics changes
//                                       (coalesced: a burst of events is one refetch)
//   streamRefetchInterval(safe, legacy) a react-query refetchInterval: the slow SAFETY poll while the stream is
//                                       healthy, the old rate when it isn't (so a dead stream costs nothing in
//                                       freshness)
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { activityHub, type ActivityMessage, type ActivityTopic } from "./activity-stream";

export type { ActivityMessage, ActivityTopic };

/** Hold the shared stream open while mounted. Server rendering and tests never open one. */
export function useActivityStream(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    return activityHub().acquire();
  }, [enabled]);
}

export function useActivity(handler: (message: ActivityMessage) => void, topics?: readonly ActivityTopic[], enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = topics?.join(",") ?? "*";
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const hub = activityHub();
    const release = hub.acquire();
    const off = hub.subscribe((m) => {
      if (m.kind === "event" && topics && !topics.includes(m.event.topic)) return;
      ref.current(m);
    });
    return () => {
      off();
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
}

const SERVER_STATUS = { healthy: false, state: "idle" as string, lastSignalAt: 0, everOpened: false, lostAt: 0 };
let cache = SERVER_STATUS;
function currentStatus() {
  const hub = activityHub();
  const s = hub.getStatus();
  const healthy = hub.healthy();
  if (cache.healthy !== healthy || cache.state !== s.state || cache.lastSignalAt !== s.lastSignalAt || cache.everOpened !== s.everOpened || cache.lostAt !== s.lostAt)
    cache = { healthy, state: s.state, lastSignalAt: s.lastSignalAt, everOpened: s.everOpened, lostAt: s.lostAt };
  return cache;
}
export function useActivityStatus() {
  return useSyncExternalStore(
    (cb) => (typeof window === "undefined" ? () => {} : activityHub().onStatus(cb)),
    currentStatus,
    () => SERVER_STATUS,
  );
}

/** Is the stream the reliable source right now? (Not a hook: for query options and timers.) */
export function streamHealthy(): boolean {
  return typeof window !== "undefined" && activityHub().healthy();
}

/** A react-query `refetchInterval`: slow safety poll while the stream is healthy, the legacy rate otherwise. */
export function streamRefetchInterval(safetyMs: number, legacyMs: number) {
  return () => (streamHealthy() ? safetyMs : legacyMs);
}

/** Refetch these queries when one of these topics changes. Coalesced to one refetch per `debounceMs`. */
export function useStreamInvalidate(queryKeys: readonly QueryKey[], topics: readonly ActivityTopic[], options: { enabled?: boolean; debounceMs?: number; match?: (m: ActivityMessage) => boolean } = {}) {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keys = useRef(queryKeys);
  keys.current = queryKeys;
  const match = useRef(options.match);
  match.current = options.match;
  const debounce = options.debounceMs ?? 200;
  useActivity(
    (m) => {
      if (m.kind === "event" && match.current && !match.current(m)) return;
      if (timer.current) return;
      const isSnapshot = m.kind === "snapshot";
      timer.current = setTimeout(() => {
        timer.current = undefined;
        for (const k of keys.current) {
          // A snapshot is the stream (re)connecting: refetch only what is not already fresh, so a page that has
          // just loaded its data does not load it twice.
          if (isSnapshot && Date.now() - (client.getQueryState(k)?.dataUpdatedAt ?? 0) < 5_000) continue;
          void client.invalidateQueries({ queryKey: k });
        }
      }, debounce);
    },
    topics,
    options.enabled ?? true,
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}

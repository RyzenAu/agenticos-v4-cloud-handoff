// "Last known" values for slow Hermes probes (W-C, 29 Sep 2026).
//
// The Hermes page waited on `hermes profile list` (8.7 s on this PC, behind a 5 s timeout, so it
// always came back empty), `hermes memory status` (4.5 s) and `hermes --version` (5.7 s). Each ran
// on the request path. A LastKnown value answers straight away with whatever it last saw (kept on
// disk, so a server restart still has an answer) and refreshes in the background, one run at a
// time. The page shows when the value was checked; nothing is invented while it is missing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LastKnownSnapshot<T> = {
  /** The last good value, or null when nothing has been seen yet. */
  value: T | null;
  /** When `value` was produced (ms since epoch), or null. */
  checkedAt: number | null;
  /** A background refresh is running now. */
  refreshing: boolean;
  /** Why the most recent refresh failed, if it did (the old value is kept). */
  error: string | null;
};

export type LastKnown<T> = {
  /** Answer now; start a background refresh when the value is missing or older than ttlMs. */
  read(): LastKnownSnapshot<T>;
  /** Refresh now (single flight) and resolve when it finishes. */
  refresh(): Promise<void>;
  /** Drop the in-memory value's age so the next read refreshes (the value itself is kept). */
  invalidate(): void;
};

export function createLastKnown<T>(options: {
  ttlMs: number;
  load: () => Promise<T>;
  /** JSON file that keeps the last value across restarts. */
  persistPath?: string;
  now?: () => number;
}): LastKnown<T> {
  const now = options.now ?? Date.now;
  let value: T | null = null;
  let checkedAt: number | null = null;
  let error: string | null = null;
  let inflight: Promise<void> | null = null;
  let hydrated = false;
  let forced = false;
  let failedAt = 0;

  const hydrate = () => {
    if (hydrated) return;
    hydrated = true;
    if (!options.persistPath) return;
    try {
      const saved = JSON.parse(readFileSync(options.persistPath, "utf-8")) as { value?: T; checkedAt?: number };
      if (saved && typeof saved.checkedAt === "number" && "value" in saved) {
        value = saved.value as T;
        checkedAt = saved.checkedAt;
      }
    } catch {
      /* nothing saved yet */
    }
  };

  const persist = () => {
    if (!options.persistPath) return;
    try {
      mkdirSync(dirname(options.persistPath), { recursive: true });
      const tmp = `${options.persistPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ value, checkedAt }), "utf-8");
      renameSync(tmp, options.persistPath);
    } catch {
      /* the in-memory value still works */
    }
  };

  const refresh = (): Promise<void> => {
    hydrate();
    if (inflight) return inflight;
    forced = false;
    const run = Promise.resolve()
      .then(options.load)
      .then(
        (next) => {
          value = next;
          checkedAt = now();
          error = null;
          persist();
        },
        (e: unknown) => {
          error = e instanceof Error ? e.message : String(e);
          failedAt = now();
        },
      )
      .finally(() => {
        inflight = null;
      });
    inflight = run;
    return run;
  };

  return {
    read() {
      hydrate();
      // After a failure, wait a little before trying again (a missing CLI must not respawn every poll).
      const backingOff = error !== null && now() - failedAt < Math.min(options.ttlMs, 30_000);
      if (!inflight && (forced || (!backingOff && (checkedAt === null || now() - checkedAt > options.ttlMs)))) void refresh();
      return { value, checkedAt, refreshing: inflight !== null, error };
    },
    refresh,
    invalidate() {
      forced = true;
    },
  };
}

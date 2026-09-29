// Non-blocking read of the model catalogue for the System page (GET /__operator/models?snapshot=1).
// The full catalogue spawns the Codex and Claude CLIs (up to ~10 s on a cold cache), so the page
// asks for a snapshot instead: whatever was last checked, with its time, and a background re-check
// when nothing is cached or the result is older than `ttlMs`. The answer never waits for a probe.

export type CatalogSnapshot<T extends { models: unknown[]; statuses: unknown[] }> = Omit<T, "models" | "statuses"> & {
  models: T["models"];
  statuses: T["statuses"];
  /** A probe is running now; the page shows "checking" and asks again shortly. */
  checking: boolean;
  /** When the result shown was produced (ISO), or null when nothing has been checked yet. */
  checkedAt: string | null;
  /** Set when the last probe failed; the previous result (if any) is still shown with its time. */
  error: string | null;
};

type Entry<T> = { at: number | null; value: T | null; pending: Promise<void> | null; error: string | null };

export function catalogSnapshots<T extends { models: unknown[]; statuses: unknown[] }>(ttlMs = 5 * 60_000, now: () => number = Date.now) {
  const entries = new Map<string, Entry<T>>();
  return (id: string, load: () => Promise<T>, refresh = false): CatalogSnapshot<T> => {
    let entry = entries.get(id);
    if (!entry) entries.set(id, (entry = { at: null, value: null, pending: null, error: null }));
    const current = entry;
    const due = refresh || current.at === null || now() - current.at >= ttlMs;
    if (due && !current.pending) {
      current.pending = Promise.resolve().then(load).then(
        (value) => {
          current.value = value;
          // The build's own time when it reports one: the catalogue serves an older build at once while
          // it re-checks, and stamping that "now" showed up to ~10 min old data as just checked (review
          // T8 S-5).
          const stamp = (value as unknown as { builtAt?: unknown }).builtAt;
          const built = typeof stamp === "string" ? Date.parse(stamp) : NaN;
          current.at = Number.isFinite(built) ? Math.min(built, now()) : now();
          current.error = null;
        },
        () => {
          // Raw runtime errors can carry private paths or account text; keep a fixed message.
          current.error = "The model check failed. Showing the last result, if any.";
          current.at = current.value ? current.at : null;
        },
      ).finally(() => {
        current.pending = null;
      });
    }
    const base = current.value ? structuredClone(current.value) : ({ models: [], statuses: [] } as unknown as T);
    return {
      ...base,
      checking: Boolean(current.pending),
      checkedAt: current.value && current.at !== null ? new Date(current.at).toISOString() : null,
      error: current.error,
    };
  };
}

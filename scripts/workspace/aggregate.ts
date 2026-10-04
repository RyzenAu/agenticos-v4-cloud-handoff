// Runs Workspace panels side by side, each under its own timeout. One slow or broken source
// never blocks the page: its panel comes back `{ ok: false, error }` and the rest still render.

/**
 * `updatedAt` is always when `data` was actually read. `stale` is set only when this is the last
 * good read served because a fresh read just failed or timed out (UI-truth M9): the page then
 * shows the data as stale, with the failure, never as a fresh success.
 */
export type PanelOk<T> = {
  ok: true;
  data: T;
  updatedAt: string;
  /** How long the read took when it was made (a reused read keeps its original time). */
  ms: number;
  stale?: { error: string; timedOut: boolean; failedAt: string };
  /** Served from the server's recent read (under FRESH_REUSE_MS old, source unchanged), not read again now. */
  reused?: boolean;
  /** Stale-while-revalidate: this is the last good read, served while a fresh read runs in the background. */
  refreshing?: boolean;
};
export type PanelFailed = { ok: false; error: string; timedOut: boolean; updatedAt: string; ms: number };
export type PanelResult<T> = PanelOk<T> | PanelFailed;

export type PanelSource<T> = (signal: AbortSignal) => Promise<T>;

export class SourceTimeout extends Error {}

/** A short, single-line error message: no stack, no query strings, at most 200 characters. */
export function panelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "Source failed";
  return (raw || "Source failed").replace(/\s+/g, " ").replace(/\?[^\s]*/g, "").slice(0, 200);
}

export async function runPanel<T>(
  source: PanelSource<T>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<PanelResult<T>> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Reject first so the race settles as a timeout, then abort the source's work.
      reject(new SourceTimeout(`Timed out after ${Math.round(timeoutMs / 100) / 10} s`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const data = await Promise.race([source(controller.signal), timeout]);
    return { ok: true, data, updatedAt: new Date(now()).toISOString(), ms: now() - started };
  } catch (error) {
    const message = timedOut ? `Timed out after ${Math.round(timeoutMs / 100) / 10} s` : panelError(error);
    return { ok: false, error: message, timedOut, updatedAt: new Date(now()).toISOString(), ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export type PanelDefs = Record<string, { source: PanelSource<unknown>; timeoutMs: number }>;

/** Every panel at once; resolves when the slowest finishes or times out. Never rejects. */
export async function runPanels<D extends PanelDefs>(defs: D, now: () => number = Date.now): Promise<{ [K in keyof D]: PanelResult<Awaited<ReturnType<D[K]["source"]>>> }> {
  const names = Object.keys(defs);
  const results = await Promise.all(names.map((name) => runPanel(defs[name].source, defs[name].timeoutMs, now)));
  return Object.fromEntries(names.map((name, i) => [name, results[i]])) as never;
}

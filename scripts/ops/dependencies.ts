/**
 * Startup health check and monitor for the hub's operational dependencies (round 6).
 *
 * SearXNG (search), Hindsight (memory), the paired companions and the model routes are each reported as `healthy` or `unavailable` in
 * GET /__health (`dependencies`), with a plain alert line and a recovery hint. Nothing here loops without bound and nothing is swallowed:
 *
 *  - At startup each dependency is probed up to `startupAttempts` times (1 s, 2 s, 4 s ... capped at 8 s between tries, each try limited to
 *    `probeTimeoutMs`). Then it is `healthy` or `unavailable`, and an unavailable one raises ONE alert line (console.error and the report).
 *  - Afterwards each is re-checked on a slow schedule: 2 minutes when healthy; when unavailable 15 s, 30 s, 1 min, 2 min, then every 5 minutes.
 *    Timers are unref'd and `stop()` clears them. A recovery raises one "recovered" line. Repeated failures raise no further lines (state, not spam).
 *  - A probe that throws is a failed probe with its error text kept as the detail, never a thrown error out of the monitor.
 *
 * Probes are cheap and read-only: a health GET, or a read of local state. They never send a search query to the upstream engines and never
 * read credentials. The one real query (end to end) is scripts/ops/check-search.ts, run on demand.
 */

export type DependencyId = "searxng" | "hindsight" | "companion" | "model_routes";
export type DependencyState = "healthy" | "unavailable";

export type ProbeResult = { ok: boolean; detail: string };
export type DependencyCheck = {
  id: DependencyId;
  label: string;
  /** What to do when it is unavailable. */
  recovery: string;
  probe: (signal: AbortSignal) => Promise<ProbeResult>;
};

export type DependencyReport = {
  id: DependencyId;
  label: string;
  state: DependencyState;
  detail: string;
  recovery: string;
  /** ISO time the current state began (null until the first probe settles). */
  since: string | null;
  lastCheckedAt: string | null;
  /** Consecutive failed probe rounds (0 while healthy). */
  failures: number;
  /** Tries used in the last round (1 when it answered at once). */
  attempts: number;
  /** Milliseconds until the next scheduled check, null when stopped. */
  nextCheckInMs: number | null;
  /** The alert line while unavailable, else null. */
  alert: string | null;
};

export type Alert = { level: "alert" | "recovered"; id: DependencyId; message: string };

export type MonitorOptions = {
  checks: DependencyCheck[];
  startupAttempts?: number;
  startupBaseDelayMs?: number;
  startupMaxDelayMs?: number;
  probeTimeoutMs?: number;
  healthyRecheckMs?: number;
  /** Re-check delays while unavailable, by consecutive failed round; the last value repeats. */
  unavailableRecheckMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  onAlert?: (alert: Alert) => void;
};

export const DEFAULT_UNAVAILABLE_RECHECK_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

type Entry = {
  check: DependencyCheck;
  report: DependencyReport;
  timer: unknown;
  dueAt: number | null;
  running: boolean;
};

export function createDependencyMonitor(options: MonitorOptions) {
  const startupAttempts = Math.max(1, Math.min(options.startupAttempts ?? 3, 6));
  const baseDelay = options.startupBaseDelayMs ?? 1_000;
  const maxDelay = options.startupMaxDelayMs ?? 8_000;
  const probeTimeout = options.probeTimeoutMs ?? 3_000;
  const healthyRecheck = options.healthyRecheckMs ?? 120_000;
  const unavailableRecheck = options.unavailableRecheckMs?.length ? options.unavailableRecheckMs : DEFAULT_UNAVAILABLE_RECHECK_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const onAlert =
    options.onAlert ??
    ((a: Alert) => {
      if (a.level === "alert") console.error(`[health] ${a.message}`);
      else console.log(`[health] ${a.message}`);
    });
  let stopped = false;

  const entries = new Map<DependencyId, Entry>(
    options.checks.map((check) => [
      check.id,
      {
        check,
        timer: null,
        dueAt: null,
        running: false,
        report: { id: check.id, label: check.label, state: "unavailable", detail: "Not checked yet.", recovery: check.recovery, since: null, lastCheckedAt: null, failures: 0, attempts: 0, nextCheckInMs: null, alert: null },
      },
    ]),
  );

  async function probeOnce(check: DependencyCheck): Promise<ProbeResult> {
    const signal = AbortSignal.timeout(probeTimeout);
    try {
      const timeout = new Promise<ProbeResult>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, detail: `no answer within ${Math.round(probeTimeout / 1000)} s` }), { once: true }));
      return await Promise.race([check.probe(signal), timeout]);
    } catch (e) {
      return { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  }

  /** One round: up to `tries` probes with doubling gaps. Always settles. */
  async function round(entry: Entry, tries: number) {
    let result: ProbeResult = { ok: false, detail: "not probed" };
    let used = 0;
    for (let i = 0; i < tries && !stopped; i++) {
      used++;
      result = await probeOnce(entry.check);
      if (result.ok) break;
      if (i < tries - 1) await sleep(Math.min(maxDelay, baseDelay * 2 ** i));
    }
    const r = entry.report;
    const previous = r.since === null ? null : r.state;
    const state: DependencyState = result.ok ? "healthy" : "unavailable";
    const at = new Date(now()).toISOString();
    if (previous !== state) r.since = at;
    r.state = state;
    r.detail = result.detail;
    r.lastCheckedAt = at;
    r.attempts = used;
    r.failures = result.ok ? 0 : r.failures + 1;
    if (state === "unavailable") {
      r.alert = `${r.label} is unavailable: ${result.detail}. ${r.recovery}`;
      if (previous !== "unavailable") onAlert({ level: "alert", id: r.id, message: r.alert });
    } else {
      r.alert = null;
      if (previous === "unavailable") onAlert({ level: "recovered", id: r.id, message: `${r.label} is back: ${result.detail}` });
    }
  }

  function schedule(entry: Entry) {
    if (stopped) return;
    if (entry.timer !== null) clearTimer(entry.timer);
    const r = entry.report;
    const wait = r.state === "healthy" ? healthyRecheck : unavailableRecheck[Math.min(Math.max(r.failures, 1) - 1, unavailableRecheck.length - 1)];
    entry.dueAt = now() + wait;
    entry.timer = setTimer(() => {
      entry.timer = null;
      entry.dueAt = null;
      void recheck(entry);
    }, wait);
  }

  async function recheck(entry: Entry) {
    if (stopped || entry.running) return;
    entry.running = true;
    try {
      await round(entry, 1); // a re-check is one probe: the schedule itself is the backoff
    } finally {
      entry.running = false;
    }
    schedule(entry);
  }

  return {
    /** Probe every dependency (bounded retries), then start the slow re-check schedule. Resolves when all have a first answer. */
    async startup() {
      stopped = false;
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          entry.running = true;
          try {
            await round(entry, startupAttempts);
          } finally {
            entry.running = false;
          }
          schedule(entry);
        }),
      );
      return this.snapshot();
    },
    /** Check one dependency now (e.g. after an environment change), without waiting for its schedule. */
    async checkNow(id: DependencyId) {
      const entry = entries.get(id);
      if (entry && !entry.running) await recheck(entry);
      return this.snapshot().find((d) => d.id === id) ?? null;
    },
    stop() {
      stopped = true;
      for (const e of entries.values()) {
        if (e.timer !== null) clearTimer(e.timer);
        e.timer = null;
        e.dueAt = null;
      }
    },
    snapshot(): DependencyReport[] {
      return [...entries.values()].map((e) => ({ ...e.report, nextCheckInMs: e.dueAt === null ? null : Math.max(0, e.dueAt - now()) }));
    },
  };
}

// ---- the real probes ---------------------------------------------------------------------------------------------------------------

export const SEARXNG_RECOVERY = "Start it with scripts\\windows\\searxng.ps1; after any Python or WSL change, run bun scripts/ops/check-search.ts. Lead discovery and research say 'search unavailable' meanwhile, never 'no results'.";

async function httpOk(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ProbeResult & { status: number | null }> {
  try {
    const res = await fetchImpl(url, { signal });
    return { ok: res.status >= 200 && res.status < 400, status: res.status, detail: res.ok ? "answered its health check" : `answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, detail: signal.aborted ? "did not answer in time" : "not reachable (connection refused)" };
  }
}

export type RealChecksInput = {
  fetchImpl?: typeof fetch;
  searxngUrl?: string;
  /** Resolved Hindsight base URL, "off" when switched off. */
  hindsightUrl: string;
  /** Companions paired and online (from the device registry). */
  companions: () => { online: number; total: number };
  /** Model-router health, read from its local file (no network, no key). */
  modelHealth: () => { states: string[] };
};

export function realChecks(input: RealChecksInput): DependencyCheck[] {
  const f = input.fetchImpl ?? fetch;
  const searx = (input.searxngUrl ?? "http://127.0.0.1:18888").replace(/\/$/, "");
  return [
    {
      id: "searxng",
      label: "Search (SearXNG)",
      recovery: SEARXNG_RECOVERY,
      probe: async (signal) => {
        const r = await httpOk(`${searx}/healthz`, f, signal);
        return { ok: r.ok, detail: r.ok ? "answering on its health route (engines are checked by bun scripts/ops/check-search.ts)" : r.detail };
      },
    },
    {
      id: "hindsight",
      label: "Memory (Hindsight)",
      recovery: "Start the Hindsight service and its Postgres (docs/HINDSIGHT-OPS.md). Memory saves wait in the queue; the vault still works.",
      probe: async (signal) => {
        if (/^off$/i.test(input.hindsightUrl)) return { ok: true, detail: "switched off by configuration; memory uses the vault and local index" };
        const r = await httpOk(`${input.hindsightUrl.replace(/\/$/, "")}/health`, f, signal);
        return { ok: r.ok, detail: r.detail };
      },
    },
    {
      id: "companion",
      label: "Companions",
      recovery: "Open Agentic OS companion on the PC (a sleeping or shut PC is simply offline). Jobs for it wait or end as unknown; none is run on another computer.",
      probe: async () => {
        const { online, total } = input.companions();
        if (total === 0) return { ok: true, detail: "none paired" };
        return online > 0 ? { ok: true, detail: `${online} of ${total} online` } : { ok: false, detail: `${total} paired, none online (asleep or offline; not a hub fault)` };
      },
    },
    {
      id: "model_routes",
      label: "Model routes",
      recovery: "Open System > Models to see which route is limited or down and why; connect or wait for another route. Chat and research use the next healthy route.",
      probe: async () => {
        const { states } = input.modelHealth();
        if (!states.length) return { ok: true, detail: "no failures recorded; routes not probed yet" };
        const usable = states.filter((s) => s === "ok" || s === "unknown").length;
        return usable > 0 ? { ok: true, detail: `${usable} of ${states.length} recorded routes usable` } : { ok: false, detail: `all ${states.length} recorded routes are limited, exhausted or down` };
      },
    },
  ];
}

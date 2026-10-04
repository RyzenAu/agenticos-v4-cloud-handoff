// /__health -- one honest answer to "is the hub OK?" (cloud programme, Agent A).
//
// Per component: status ok | degraded | failed, a plain detail line and, when not ok, a recovery hint.
// No secrets: no env values, no tokens, no URLs with credentials, no row contents. Paths are the data
// directory only. Every probe is bounded and can never throw out of collectHealth.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { activeRegistry } from "../devices/registry";
import { sessionStoreCondition } from "../devices/store";
import { jobsRuntime } from "../jobs/runtime";
import { backgroundJobsDisabled } from "../preview-guard";
import { DEFAULT_HINDSIGHT_URL, loopbackUrl } from "../memory/settings";
import { versionInfo, type VersionInfo } from "../version";
import { dataDirFor, dataDirOverride } from "./data-dir";
import { hubRole, pcOnlyReport, type HubRole } from "./hub-role";
import type { DependencyReport } from "../ops/dependencies";
import { hostComponent, type HostComponent } from "../ops/host-health";

export type ComponentStatus = "ok" | "degraded" | "failed";
export type Component = { status: ComponentStatus; detail: string; recovery?: string; [extra: string]: unknown };
export type StoreReport = { name: string; status: "ok" | "absent" | "failed"; tables?: number; detail?: string };

export type HealthReport = {
  ok: boolean;
  status: ComponentStatus;
  checkedAt: string;
  hubRole: HubRole;
  version: string;
  gitSha: string;
  dirty: boolean;
  startedAt: string;
  dataDir: { path: string; overridden: boolean; writable: boolean };
  components: {
    dataDir: Component;
    stores: Component & { stores: StoreReport[] };
    jobsWorker: Component;
    hindsight: Component;
    companions: Component & { online: number; total: number };
    /** R8 F: devices.json (browser sign-ins, companions, pairing codes). Unreadable = every sign-in, pairing and confirm write is refused. */
    sessionStore: Component;
    /** R9 ops: the always-on host (scheduled tasks, Hindsight, search, Hermes, backups, disks), from deploy/windows/mu-health-check.ps1. Never failed: the hub itself works. */
    host: HostComponent;
  };
  pcOnly: ReturnType<typeof pcOnlyReport>;
  /** Operational dependencies from the startup check and slow monitor (scripts/ops/dependencies.ts): healthy or unavailable, with an alert line. Empty when no monitor runs (a quiet copy). */
  dependencies: DependencyReport[];
  failed: Array<{ component: string; detail: string; recovery: string }>;
};

/** Stores the hub creates lazily; an absent one on a fresh install is normal, a present one must open. */
export const KNOWN_STORES = [
  "crm.sqlite",
  "jobs.sqlite",
  "approvals.sqlite",
  "finance.sqlite",
  "finance-manual.sqlite",
  "mail-archive.sqlite",
  "inbox-triage.sqlite",
  "coding/coding.sqlite",
];

export type HealthOptions = {
  root: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  version?: () => Promise<VersionInfo>;
  /** Test seams; the defaults read the live process. */
  jobs?: () => { owner: boolean };
  companions?: () => { online: number; total: number };
  hindsightTimeoutMs?: number;
  now?: () => Date;
  /** Live snapshot of the dependency monitor. */
  dependencies?: () => DependencyReport[];
  /** Test seam for the host component; the default reads <data dir>/ops. */
  host?: (dataDir: string, now: Date) => HostComponent;
};

const startedAt = new Date().toISOString();

/** Every `*.sqlite` under the data directory (two levels), so a new store is checked without editing a list. */
export function discoverStores(dir: string): string[] {
  const found = new Set<string>(KNOWN_STORES);
  const walk = (base: string, rel: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && /\.sqlite$/i.test(e.name)) found.add(rel ? `${rel}/${e.name}` : e.name);
      else if (e.isDirectory() && depth < 2 && !e.name.startsWith(".")) walk(join(base, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(dir, "", 0);
  return [...found].sort();
}

/** Open one store read-only and count its tables. Never writes, never reads a row. */
export function checkStore(dir: string, name: string): StoreReport {
  const path = join(dir, ...name.split("/"));
  if (!existsSync(path)) return { name, status: "absent" };
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
    return { name, status: "ok", tables: row.n };
  } catch (e) {
    return { name, status: "failed", detail: (e as Error).message.slice(0, 160) };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

function probeWritable(dir: string): { writable: boolean; detail: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.health-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { writable: true, detail: "Writable." };
  } catch (e) {
    return { writable: false, detail: `Not writable (${(e as NodeJS.ErrnoException).code ?? "error"}).` };
  }
}

async function hindsightComponent(env: Record<string, string | undefined>, fetchImpl: typeof fetch, timeoutMs: number): Promise<Component> {
  const raw = (env.HINDSIGHT_URL ?? "").trim() || DEFAULT_HINDSIGHT_URL;
  if (/^off$/i.test(raw)) return { status: "ok", detail: "Hindsight is switched off; memory uses the vault and local index only." };
  const base = loopbackUrl(raw);
  if (!base) return { status: "degraded", detail: "HINDSIGHT_URL is not a loopback address.", recovery: "Set HINDSIGHT_URL to http://127.0.0.1:<port> on this machine, or to off." };
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok
      ? { status: "ok", detail: "Hindsight answered its health check." }
      : { status: "degraded", detail: `Hindsight answered HTTP ${res.status}.`, recovery: "Check the Hindsight service and its Postgres (docs/HINDSIGHT-OPS.md). Memory saves wait in the queue meanwhile." };
  } catch {
    return { status: "degraded", detail: "Hindsight did not answer.", recovery: "Start the Hindsight service and its Postgres (docs/HINDSIGHT-OPS.md). Memory saves wait in the queue meanwhile; the vault still works." };
  }
}

export async function collectHealth(opts: HealthOptions): Promise<HealthReport> {
  const env = opts.env ?? process.env;
  const role = hubRole(env);
  const dir = dataDirFor(opts.root, env);
  const now = (opts.now ?? (() => new Date()))();

  const version = await (opts.version ?? versionInfo)().catch(() => ({ version: "unknown", gitSha: "unknown", dirty: false, buildTime: "" }) as VersionInfo);

  const w = probeWritable(dir);
  const dataDirC: Component = w.writable
    ? { status: "ok", detail: w.detail }
    : { status: "failed", detail: w.detail, recovery: "Fix ownership or free disk space on the data directory, then restart the service (deploy/README.md, Troubleshooting)." };

  const stores = discoverStores(dir).map((n) => checkStore(dir, n));
  const failedStores = stores.filter((s) => s.status === "failed");
  const opened = stores.filter((s) => s.status === "ok").length;
  const storesC: Component & { stores: StoreReport[] } = failedStores.length
    ? {
        status: "failed",
        detail: `${failedStores.length} store(s) will not open: ${failedStores.map((s) => s.name).join(", ")}.`,
        recovery: "Stop the service, restore the last good backup with scripts/cloud/backup-cli.ts restore --keep-sessions into a fresh data directory, then start it (deploy/README.md, Rollback).",
        stores,
      }
    : { status: "ok", detail: `${opened} store(s) open, ${stores.length - opened} not created yet.`, stores };

  let jobsC: Component;
  try {
    const j = opts.jobs ? opts.jobs() : jobsRuntime(opts.root);
    jobsC = j.owner
      ? { status: "ok", detail: "This process owns the jobs worker.", owner: true }
      : { status: "degraded", detail: "This process is read-only (AGENTIC_OS_NO_BACKGROUND is set); no worker is running.", recovery: "Run the one hub process without AGENTIC_OS_NO_BACKGROUND.", owner: false };
  } catch (e) {
    jobsC = backgroundJobsDisabled(env)
      ? { status: "degraded", detail: "This is a quiet read-only copy (AGENTIC_OS_NO_BACKGROUND is set) and the job stores are not created yet.", recovery: "Start the one hub process without AGENTIC_OS_NO_BACKGROUND; it creates them.", owner: false }
      : { status: "failed", detail: `The jobs runtime did not start: ${(e as Error).message.slice(0, 160)}`, recovery: "Check the jobs and approvals stores above; restore a backup if they will not open." };
  }

  const hindsight = await hindsightComponent(env, opts.fetchImpl ?? fetch, opts.hindsightTimeoutMs ?? 1500);

  let online = 0;
  let total = 0;
  try {
    const c = opts.companions
      ? opts.companions()
      : (() => {
          const reg = activeRegistry();
          const comps = reg.targets().filter((d) => d.kind === "companion");
          return { online: comps.filter((d) => reg.isOnline(d)).length, total: comps.length };
        })();
    ({ online, total } = c);
  } catch {
    /* an unreadable device list is reported as zero, not as a crash */
  }
  const companions: Component & { online: number; total: number } = {
    status: "ok",
    detail: total === 0 ? "No companion is paired." : `${online} of ${total} companion(s) online. A PC that is asleep is simply offline; the hub keeps working.`,
    online,
    total,
  };

  const sc = sessionStoreCondition(join(dir, "devices.json"));
  const sessionStore: Component =
    sc.state === "unreadable"
      ? {
          status: "failed",
          detail: sc.detail,
          recovery:
            "While they can't be read nobody is recognised as signed in, and pairing, sign-in and confirm are refused so the records are never replaced. To fix it: 1. Stop the hub. 2. In the hub's data folder, either put back the sign-in records file from the newest verified backup, or rename the damaged sign-in records file (add \"-damaged\" to its name) to start with no sign-ins, so everyone pairs again. 3. Start the hub.",
        }
      : { status: "ok", detail: sc.detail };

  let host: HostComponent;
  try {
    host = (opts.host ?? ((d: string, n: Date) => hostComponent(d, n, env)))(dir, now);
  } catch (e) {
    host = { status: "degraded", detail: `The host check report could not be read (${(e as Error).message.slice(0, 120)}).`, checkedAt: null, host: null, reportUnreadable: true, checks: [], alerts: [], telegram: false };
  }

  const components = { dataDir: dataDirC, stores: storesC, jobsWorker: jobsC, hindsight, companions, sessionStore, host };
  const failed = Object.entries(components)
    .filter(([, c]) => c.status !== "ok")
    .map(([component, c]) => ({ component, detail: c.detail, recovery: c.recovery ?? "" }));
  // An unavailable dependency is degraded (the hub itself works), listed with its alert and recovery so nothing is silent.
  const dependencies = opts.dependencies ? opts.dependencies() : [];
  // A sleeping or shut personal PC is offline, not a hub failure (components.companions says ok): it is listed in `dependencies` but never degrades the hub.
  for (const d of dependencies) if (d.state === "unavailable" && d.since !== null && d.id !== "companion") failed.push({ component: d.id, detail: d.alert ?? d.detail, recovery: d.recovery });
  const status: ComponentStatus = Object.values(components).some((c) => c.status === "failed") ? "failed" : failed.length ? "degraded" : "ok";

  return {
    ok: status === "ok",
    status,
    checkedAt: now.toISOString(),
    hubRole: role,
    version: version.version,
    gitSha: version.gitSha,
    dirty: version.dirty,
    startedAt,
    dataDir: { path: dir, overridden: dataDirOverride(env) !== null, writable: w.writable },
    components,
    pcOnly: pcOnlyReport(role),
    dependencies,
    failed,
  };
}

/** GET /__health. Status 200 for ok/degraded, 503 for failed, so a load balancer or systemd watchdog can act on it. */
export function healthEndpoint(opts: HealthOptions) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    void collectHealth(opts).then((report) => {
      res.statusCode = report.status === "failed" ? 503 : 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(report));
    });
  };
}

export function healthPlugin(opts: HealthOptions): Plugin {
  return {
    name: "mu-health",
    configureServer(server) {
      server.middlewares.use("/__health", healthEndpoint(opts));
    },
  };
}

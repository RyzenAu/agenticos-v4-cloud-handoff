/**
 * Dot's debugging tools on the hub (r12): read the hub's logs, redacted, and restart the hub or a named service.
 * Mounted by hub-ops.ts under /__gateway, behind the same three checks as every other gateway route.
 *
 *   GET  /diagnostics/logs?source=<hub|supervisor|gateway|release|health>&tail=<n>[&previous=1]   (ops.logs)
 *   POST /ops/restart { service: "hub" | "hermes" | "searxng" }  -> 202 { id, follow }               (ops.restart)
 *   GET  /ops/restart/<id>                                                                          (ops.restart)
 *
 * LOGS. A fixed allow-list of file NAMES inside the hub's log folder (MU_LOG_DIR, which the supervisor sets; C:\mu-hub\logs
 * otherwise). There is no path parameter: an unknown query parameter is refused. A name is never built from the request,
 * symlinks and anything that resolves outside the folder are skipped, and no .env file (hub.env included) can ever be read.
 * At most 500 lines and 256 KB; every line goes through the coding harness's secret redaction plus a NAME=value rule.
 *
 * RESTARTS. No command comes from the request: `service` picks one of three fixed actions.
 *   hub      the hub process exits (code 75) AFTER the 202 has gone out; the supervisor (deploy/windows/mu-hub-supervisor.ps1,
 *            the "\MU\MU Hub Supervisor" task) sees the dead process and starts it again, as it does after any crash. Refused
 *            unless MU_HUB_SUPERVISED=1 (the supervisor sets it), so an unsupervised hub is never left down.
 *   hermes   `hermes gateway stop`, then Start-ScheduledTask '\MU\' 'MU Hermes Gateway' (its boot launcher).
 *   searxng  `wsl -d <distro> -- pkill -f searx.webapp`, then Start-ScheduledTask '\MU\' 'MU SearXNG' (a no-op while that task's
 *            supervisor runs: it sees SearXNG stop answering and starts it again).
 * 3 per hour per identity, counted from a file in the gateway folder, so a hub restart does not reset the count.
 */
import { execFile } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { redactText } from "../coding/redact";

export const LOG_SOURCES = {
  hub: ["hub-stdout.log", "hub-stderr.log"],
  supervisor: ["mu-hub-supervisor.log"],
  gateway: ["mu-gateway-supervisor.log", "gateway-stdout.log", "gateway-stderr.log"],
  health: ["mu-health-check.log"],
  release: [] as string[], // the newest release-*.log or release-*.json, found by listing
} as const;
export type LogSource = keyof typeof LOG_SOURCES;
export const RESTART_SERVICES = ["hub", "hermes", "searxng"] as const;
export type RestartService = (typeof RESTART_SERVICES)[number];
export const MAX_TAIL_LINES = 500;
export const MAX_TAIL_BYTES = 256 * 1024;
export const RESTARTS_PER_HOUR = 3;
export const HUB_EXIT_CODE = 75;
const RELEASE_FILE = /^release-[A-Za-z0-9_-]{1,40}\.(?:log|json)$/;
const ENV_FILE = /(?:^|[.\\/])env(?:$|[.])|\.env/i;
const RESTART_ID = /^rs-[0-9a-z]{6,20}-[0-9a-f]{6}$/;
const TASK_PATH = "\\MU\\";
const TASKS: Record<Exclude<RestartService, "hub">, string> = { hermes: "MU Hermes Gateway", searxng: "MU SearXNG" };

export class DebugRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The coding harness's redaction, plus: any NAME=value (or NAME: value) whose NAME looks like a key, token, secret, password or auth. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH|COOKIE|CREDENTIAL)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
export function redactLogLine(line: string): string {
  return redactText(line, 4000).replace(SECRET_ASSIGNMENT, (_w, name: string, sep: string) => `${name}${sep}[redacted]`);
}

type Env = Record<string, string | undefined>;
type RunResult = { ok: boolean; detail: string };
export type ServiceRunner = (service: Exclude<RestartService, "hub">, env: Env) => Promise<RunResult>;
export type RestartRecord = { id: string; service: RestartService; identity: string; session: string; at: number; state: "requested" | "restarting" | "done" | "failed"; detail?: string; finishedAt?: number };

export type DebugOptions = {
  dir: string;
  env: () => Env;
  now?: () => number;
  /** When this process started (a hub restart is "back" once a process that started after the request answers). */
  startedAt?: number;
  /** Ends the hub process; the supervisor starts it again. Default process.exit. */
  exitHub?: (code: number) => void;
  hubExitDelayMs?: number;
  runService?: ServiceRunner;
};

const PROCESS_STARTED = Date.now() - Math.round(process.uptime() * 1000);

export function logDir(env: Env): string | null {
  const fromEnv = (env.MU_LOG_DIR ?? "").trim();
  if (fromEnv) return fromEnv;
  return process.platform === "win32" ? "C:\\mu-hub\\logs" : null;
}

/** The last `lines` lines of one allow-listed file, at most `bytes` read from its end. Null when missing or not a plain file inside `folder`. */
function tailFile(folder: string, name: string, lines: number, bytes: number): { name: string; size: number; truncated: boolean; lines: string[] } | null {
  if (name.includes("/") || name.includes("\\") || ENV_FILE.test(name)) return null;
  const full = join(folder, name);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;
  try {
    if (dirname(realpathSync(full)) !== realpathSync(folder)) return null;
  } catch {
    return null;
  }
  const start = Math.max(0, st.size - bytes);
  const buf = Buffer.alloc(st.size - start);
  const fd = openSync(full, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let all = buf.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  if (start > 0) all = all.slice(1); // the first line was cut in half
  if (all.length && all[all.length - 1] === "") all.pop();
  const kept = all.slice(-lines);
  return { name, size: st.size, truncated: start > 0 || all.length > kept.length, lines: kept.map(redactLogLine) };
}

export function createDebugOps(o: DebugOptions) {
  const now = o.now ?? Date.now;
  const startedAt = o.startedAt ?? PROCESS_STARTED;
  const file = join(o.dir, "ops-restarts.jsonl");
  const runService = o.runService ?? defaultRunner;

  function logs(params: URLSearchParams) {
    for (const key of params.keys()) if (!["source", "tail", "previous"].includes(key)) throw new DebugRefusal(400, `Unknown parameter "${key.slice(0, 20)}". Send source, tail and previous only; files are chosen by source, never by path.`);
    const source = params.get("source") ?? "";
    if (!Object.prototype.hasOwnProperty.call(LOG_SOURCES, source)) throw new DebugRefusal(400, `source must be one of ${Object.keys(LOG_SOURCES).join(", ")}.`);
    const tail = Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(Number(params.get("tail")) || 200)));
    const previous = params.get("previous") === "1";
    const folder = logDir(o.env());
    if (!folder) throw new DebugRefusal(503, "The hub's log folder is not known here (MU_LOG_DIR is not set).", { unsupported: true });
    if (!existsSync(folder)) return { source, tail, files: [], note: "The hub's log folder does not exist on this machine." };
    let names: string[];
    if (source === "release") {
      const found = readdirSync(folder).filter((n) => RELEASE_FILE.test(n) && !ENV_FILE.test(n));
      const newest = found
        .map((n) => {
          try {
            return { n, t: lstatSync(join(folder, n)).mtimeMs };
          } catch {
            return { n, t: 0 };
          }
        })
        .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1))[0];
      names = newest ? [newest.n] : [];
    } else names = (LOG_SOURCES[source as LogSource] as readonly string[]).map((n) => (previous ? `${n}.1` : n));
    const budget = Math.floor(MAX_TAIL_BYTES / Math.max(1, names.length));
    const files = names.map((n) => tailFile(folder, n, tail, budget)).filter((f): f is NonNullable<typeof f> => !!f);
    return { source, tail, previous, files, redacted: true, ...(files.length ? {} : { note: "No such log file on this hub yet." }) };
  }

  function records(): RestartRecord[] {
    if (!existsSync(file)) return [];
    const byId = new Map<string, RestartRecord>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as RestartRecord;
        if (typeof r.id === "string") byId.set(r.id, { ...byId.get(r.id), ...r });
      } catch {
        /* a torn line */
      }
    }
    return [...byId.values()];
  }
  function save(r: Partial<RestartRecord> & { id: string }) {
    mkdirSync(o.dir, { recursive: true });
    appendFileSync(file, JSON.stringify(r) + "\n", { flag: "a" });
  }

  /** Validates and records a restart request. The caller replies 202, THEN calls `fire` (after the reply has gone out). */
  function request(body: Record<string, unknown>, who: { identity: string; session: string }): RestartRecord {
    if (Object.keys(body).some((k) => k !== "service")) throw new DebugRefusal(400, 'Send exactly { "service": "hub" | "hermes" | "searxng" }.');
    const service = body.service;
    if (typeof service !== "string" || !(RESTART_SERVICES as readonly string[]).includes(service)) throw new DebugRefusal(400, `service must be one of ${RESTART_SERVICES.join(", ")}.`);
    const env = o.env();
    if (service === "hub" && env.MU_HUB_SUPERVISED !== "1") throw new DebugRefusal(409, "This hub is not run by the supervisor (MU_HUB_SUPERVISED is not set), so a restart would leave it down. Nothing was done.", { ownerAction: true });
    if (service !== "hub" && !o.runService && process.platform !== "win32") throw new DebugRefusal(503, `Restarting ${service} is only supported on the Windows hub.`, { unsupported: true });
    const t = now();
    const recent = records().filter((r) => r.identity === who.identity && r.at > t - 3_600_000).sort((a, b) => a.at - b.at);
    if (recent.length >= RESTARTS_PER_HOUR) {
      const retryAfter = Math.max(1, Math.ceil((recent[recent.length - RESTARTS_PER_HOUR].at + 3_600_000 - t) / 1000));
      throw new DebugRefusal(429, `At most ${RESTARTS_PER_HOUR} restarts an hour. Try again in ${Math.ceil(retryAfter / 60)} minutes.`, { retryAfter });
    }
    const record: RestartRecord = { id: `rs-${t.toString(36)}-${randomBytes(3).toString("hex")}`, service: service as RestartService, identity: who.identity, session: who.session, at: t, state: "requested" };
    save(record);
    return record;
  }

  /** Runs the restart. For the hub: exits after a short delay so the reply (already finished) reaches the gateway first. */
  function fire(record: RestartRecord) {
    if (record.service === "hub") {
      save({ id: record.id, state: "restarting" });
      console.log(`[gateway] Dot asked for a hub restart (${record.id}); exiting with code ${HUB_EXIT_CODE} so the supervisor starts the hub again.`);
      setTimeout(() => (o.exitHub ?? ((code: number) => process.exit(code)))(HUB_EXIT_CODE), o.hubExitDelayMs ?? 1500);
      return Promise.resolve();
    }
    save({ id: record.id, state: "restarting" });
    return runService(record.service, o.env())
      .catch((error: Error) => ({ ok: false, detail: String(error?.message ?? "error") }))
      .then((r) => save({ id: record.id, state: r.ok ? "done" : "failed", detail: redactLogLine(r.detail).slice(0, 300), finishedAt: now() }));
  }

  /** One request's state. A hub restart is done once THIS process started after it was asked for. */
  function status(id: string, identity: string): RestartRecord & { hubBack?: boolean } {
    if (!RESTART_ID.test(id)) throw new DebugRefusal(404, "No such restart request.");
    const r = records().find((x) => x.id === id);
    if (!r || r.identity !== identity) throw new DebugRefusal(404, "No such restart request.");
    if (r.service === "hub" && r.state !== "done" && startedAt > r.at) {
      const done = { ...r, state: "done" as const, finishedAt: startedAt, detail: "The hub is back: this answer comes from the restarted process." };
      save({ id: r.id, state: "done", finishedAt: startedAt, detail: done.detail });
      return { ...done, hubBack: true };
    }
    return r;
  }

  return { logs, request, fire, status, file };
}

// ── the fixed Windows actions (no input from the request reaches a command line) ──────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}`.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? "" });
    });
  });
}
const startTask = (name: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName '${name}'`]);

function hermesBinary(env: Env): string {
  for (const home of [(env.HERMES_HOME ?? "").trim(), env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "hermes") : ""]) {
    if (!home) continue;
    const exe = join(home, "bin", "hermes.exe");
    if (existsSync(exe)) return exe;
  }
  return "hermes";
}

export const defaultRunner: ServiceRunner = async (service, env) => {
  if (service === "hermes") {
    const stop = await run(hermesBinary(env), ["gateway", "stop"]);
    if (stop.code !== 0) return { ok: false, detail: `hermes gateway stop failed (exit ${stop.code}); the gateway was not started again. ${stop.out}` };
    await new Promise((r) => setTimeout(r, 3000));
    const start = await startTask(TASKS.hermes);
    return start.code === 0 ? { ok: true, detail: `Stopped, then started the ${TASKS.hermes} task.` } : { ok: false, detail: `Stopped, but starting the ${TASKS.hermes} task failed (exit ${start.code}).` };
  }
  const distro = /^[A-Za-z0-9._-]{1,40}$/.test(env.MU_SEARXNG_DISTRO ?? "") ? String(env.MU_SEARXNG_DISTRO) : "kali-linux";
  const kill = await run("wsl.exe", ["-d", distro, "--", "pkill", "-f", "searx.webapp"]);
  // pkill: 0 killed, 1 nothing was running. Anything else is a failure.
  if (kill.code !== 0 && kill.code !== 1) return { ok: false, detail: `Stopping SearXNG failed (exit ${kill.code}).` };
  const start = await startTask(TASKS.searxng);
  return start.code === 0 ? { ok: true, detail: `SearXNG ${kill.code === 0 ? "stopped" : "was not running"}; the ${TASKS.searxng} task brings it back (within about two minutes).` } : { ok: false, detail: `SearXNG stopped, but starting the ${TASKS.searxng} task failed (exit ${start.code}).` };
};

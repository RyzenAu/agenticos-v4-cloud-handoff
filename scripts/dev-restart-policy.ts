// Dev-server restart policy: coalesce and defer Vite's config-dependency restarts.
//
// vite.config.ts imports every server plugin under scripts/**, so Vite treats all ~420 of those
// files as config dependencies: saving ANY of them closes the HTTP server and rebuilds the whole
// dev server. With agents editing scripts/** that happened about once a minute. Each restart
//   - killed in-flight chat turns, Hermes runs and agent tasks (killAllRuns, nativeTasks.close),
//   - dropped the open tab's HMR socket, so the page fully reloaded, and
//   - threw away every transformed module, so that reload re-transformed ~480 modules cold.
// That is the "takes forever to load sometimes".
//
// This plugin keeps the restart (server code must still go live) but:
//   1. waits for a quiet window after the last edit, so a burst of saves is one restart;
//   2. defers while work is in flight on THIS server (a mutating /__* request such as a chat turn,
//      a Claude run recorded in ~/.claude-os/claude-live-runs.json, an active agent task), up to a cap;
//   3. warms the root layout and route tree right after (re)start so the reloaded tab is not cold.
// GET /__dev_restart reports what is pending and what it is waiting for.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { RELAY_HEADER } from "./identity/principal";

const ACTIVE_AGENT_STATUSES = new Set(["queued", "running", "needs_input"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/** GET /__dev_restart is for this PC only (audit A-L7): loopback socket, loopback Host (so neither
 * DNS rebinding nor Tailscale Serve reaches it), no tailnet identity, no cross-site page. */
export function devRestartStatusAllowed(req: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } }) {
  const headers = req.headers ?? {};
  if (!LOOPBACK.includes(req.socket?.remoteAddress ?? "")) return false;
  if (!LOCAL_HOST.test(String(headers.host ?? ""))) return false;
  // Any relay marker (Tailscale-*, X-Forwarded-*, Forwarded, Via, X-Real-IP), not only Tailscale's.
  if (Object.keys(headers).some((h) => RELAY_HEADER.test(h))) return false;
  if (headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}

export type RestartPolicyOptions = {
  root: string;
  /** Quiet window after the last change before restarting. */
  quietMs?: number;
  /** Longest a restart may wait for in-flight work before it goes ahead anyway. */
  maxDeferMs?: number;
  /** How often to re-check in-flight work while deferred. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seams. */
  liveRunsFile?: string;
  log?: (line: string) => void;
};

/** Reasons a restart right now would kill work on this server process. Empty = safe. */
export function inFlightWork(input: {
  root: string;
  openMutations: number;
  pid?: number;
  liveRunsFile?: string;
}): string[] {
  const reasons: string[] = [];
  if (input.openMutations > 0) reasons.push(`${input.openMutations} request${input.openMutations === 1 ? "" : "s"} in progress`);
  const pid = input.pid ?? process.pid;
  try {
    const file = input.liveRunsFile ?? join(homedir(), ".claude-os", "claude-live-runs.json");
    if (existsSync(file)) {
      const rows = JSON.parse(readFileSync(file, "utf8"));
      const ours = Array.isArray(rows) ? rows.filter((row) => row && row.pid === pid).length : 0;
      if (ours) reasons.push(`${ours} chat turn${ours === 1 ? "" : "s"} running`);
    }
  } catch {
    /* unreadable marker file: treat as no turns, never block forever */
  }
  try {
    const file = join(input.root, ".operator-data", "agent-jobs.json");
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      let active = 0;
      for (const job of Array.isArray(stored?.jobs) ? stored.jobs : [])
        for (const run of Array.isArray(job?.runs) ? job.runs : []) if (ACTIVE_AGENT_STATUSES.has(run?.status)) active++;
      if (active) reasons.push(`${active} agent task${active === 1 ? "" : "s"} active`);
    }
  } catch {
    /* same: never block on a file we cannot read */
  }
  // Track 3: coding jobs running in this process (scripts/coding/plugin.ts keeps one runtime per root on
  // this global key). A restart would interrupt them (recoverable, never replayed), so defer it too.
  try {
    const runtimes = (globalThis as Record<symbol, Map<string, { orch?: { active?: () => string[] } }> | undefined>)[Symbol.for("mu.coding.runtime.v1")];
    let coding = 0;
    for (const rt of runtimes?.values() ?? []) coding += rt.orch?.active?.().length ?? 0;
    if (coding) reasons.push(`${coding} coding job${coding === 1 ? "" : "s"} running`);
  } catch {
    /* never block on it */
  }
  return reasons;
}

export function devRestartPolicy(options: RestartPolicyOptions): Plugin {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const quietMs = Number(env.AGENTIC_OS_RESTART_QUIET_MS) || options.quietMs || 4_000;
  const maxDeferMs = Number(env.AGENTIC_OS_RESTART_MAX_DEFER_MS) || options.maxDeferMs || 10 * 60_000;
  const pollMs = options.pollMs ?? 2_000;
  const log = options.log ?? ((line: string) => console.warn(line));
  return {
    name: "agentic-os-dev-restart-policy",
    apply: "serve",
    config() {
      return {
        server: {
          // A quiet measurement/preview copy (AGENTIC_OS_NO_WATCH=1) never restarts or hot-reloads.
          ...(env.AGENTIC_OS_NO_WATCH === "1" ? { watch: null } : {}),
          // Transform the shell and route tree as soon as the server is up, so the tab that
          // reloads after a restart (or the first visit after boot) is not paying for it.
          warmup: {
            clientFiles: ["./src/routes/__root.tsx", "./src/router.tsx", "./src/routeTree.gen.ts"],
            ssrFiles: ["./src/routes/__root.tsx", "./src/router.tsx", "./src/routeTree.gen.ts", "./src/server.ts"],
          },
        },
      };
    },
    configureServer(server: ViteDevServer) {
      const open = new Set<ServerResponse>();
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url || "/").split("?")[0];
        if (path === "/__dev_restart" && (req.method || "GET") === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (!devRestartStatusAllowed(req)) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "Local access only" }));
            return;
          }
          res.end(JSON.stringify(status()));
          return;
        }
        if (path.startsWith("/__") && !READ_METHODS.has(req.method || "GET")) {
          open.add(res);
          res.once("close", () => open.delete(res));
        }
        next();
      });

      const original = server.restart.bind(server);
      let requestedAt = 0;
      let lastRequestAt = 0;
      let forceOptimize = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
      let loggedWait = "";
      const busy = () => inFlightWork({ root: options.root, openMutations: open.size, liveRunsFile: options.liveRunsFile });
      const status = () => ({
        pending: waiters.length > 0,
        waitingFor: waiters.length ? busy() : [],
        requestedAt: requestedAt || null,
        restartsAfter: requestedAt ? new Date(Math.min(lastRequestAt + quietMs, requestedAt + maxDeferMs)).toISOString() : null,
        quietMs,
        maxDeferMs,
      });
      const fire = () => {
        timer = undefined;
        const pending = waiters;
        const force = forceOptimize;
        waiters = [];
        requestedAt = 0;
        forceOptimize = false;
        loggedWait = "";
        original(force).then(
          () => pending.forEach((w) => w.resolve()),
          (error) => pending.forEach((w) => w.reject(error)),
        );
      };
      const check = () => {
        timer = undefined;
        const t = now();
        if (t - lastRequestAt < quietMs) {
          timer = setTimeout(check, quietMs - (t - lastRequestAt));
          return;
        }
        const reasons = busy();
        if (reasons.length && t - requestedAt < maxDeferMs) {
          const line = reasons.join(", ");
          if (line !== loggedWait) {
            log(`[restart-policy] server-code change pending; waiting (${line}). Restarts when idle, at most ${Math.round(maxDeferMs / 60_000)} min after the first change.`);
            loggedWait = line;
          }
          timer = setTimeout(check, pollMs);
          return;
        }
        if (reasons.length) log(`[restart-policy] restarting after ${Math.round((t - requestedAt) / 1000)} s despite: ${reasons.join(", ")}`);
        fire();
      };
      server.restart = (force?: boolean) => {
        const t = now();
        if (!requestedAt) requestedAt = t;
        lastRequestAt = t;
        forceOptimize ||= !!force;
        const done = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, quietMs);
        return done;
      };
      server.httpServer?.once("close", () => {
        if (timer) clearTimeout(timer);
      });
    },
  };
}

// The OS's own version/build identity: what ships in the browser dev server
// and what the packaged Tauri shell shows in its window title (see
// desktop/src-tauri/build.rs and desktop/src-tauri/src/lib.rs, which read the
// same package.json + git SHA at compile time via a small string scan rather
// than importing this module — Rust can't `import` TypeScript).
//
// Consumed by os-shell's System page via a tiny JSON endpoint. This module
// does not register that endpoint itself: `scripts/version.ts` is owned by
// the native track (see WAVE2-CONTRACT), but the route table lives in
// `vite.config.ts`, which this track does not edit. The lead wires it in
// with the one import + one `server.middlewares.use(...)` line recorded
// under "patch for lead" in the native track's report.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitHeadShortSha, runFileText } from "./nonblocking-exec";

export interface VersionInfo {
  /** package.json's own "version" field — the one number everyone means by "what version am I on". */
  version: string;
  /** Short git SHA of the checked-out commit ("unknown" outside a git checkout, e.g. a bare export). */
  gitSha: string;
  /** True when tracked files had uncommitted changes as this server started (the desktop title shows "-dirty"). */
  dirty: boolean;
  /**
   * ISO-8601 timestamp of when this value was first computed in the current process.
   * There is no separate production build step today (`bun run start` serves the Vite
   * dev server directly — see docs/DESKTOP-APP.md) so "build time" is approximated as
   * "when this server process started reporting a version", not a bundler timestamp.
   */
  buildTime: string;
}

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** `git status` for the dirty flag; injectable so a test can make it slow. */
export type GitStatus = (root: string) => Promise<string>;
const gitStatus: GitStatus = (root) => runFileText("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, timeout: 5000 });

/**
 * Computed once per process and shared — git/package.json don't change under a running server.
 * Nothing here blocks the server (T8b, review T8 S-6): the SHA is read from .git's own files, and
 * `git status` (the dirty flag, up to 5 s on a big tree) runs as an async child. The supervisor's
 * first /__version probe used to hold every other request for both git spawns.
 */
export function createVersionInfo(root: string, status: GitStatus = gitStatus): () => Promise<VersionInfo> {
  let pending: Promise<VersionInfo> | null = null;
  return () =>
    (pending ??= (async () => {
      const buildTime = new Date().toISOString();
      const dirty = await status(root).then(
        (out) => out.trim().length > 0,
        () => false,
      );
      return { version: readPackageVersion(root), gitSha: gitHeadShortSha(root) || readReleaseSha(root) || "unknown", dirty, buildTime };
    })());
}

const processVersion = createVersionInfo(REPO_ROOT);

/** This server's version (one shared promise per process). The server primes it at startup. */
export function versionInfo(): Promise<VersionInfo> {
  return processVersion();
}

/**
 * A release unpacked with `git archive` (deploy/bin/rollout.sh) has no .git folder; the rollout writes the
 * SHA it unpacked into RELEASE_SHA so /__version and /__health still say which commit is running.
 */
function readReleaseSha(root: string): string {
  try {
    const sha = readFileSync(join(root, "RELEASE_SHA"), "utf8").trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : "";
  } catch {
    return "";
  }
}

function readPackageVersion(root: string): string {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

type LoopbackRequest = { socket?: { remoteAddress?: string | null }; headers?: Record<string, unknown> };
type MiddlewareRes = { statusCode?: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void };

/**
 * A tiny GET JSON endpoint for os-shell's System page: `{ version, gitSha, buildTime }`.
 * Same shape and safety rules as the existing `GET /__token` handler in
 * `vite.config.ts` — loopback-only (the check is injected so this module doesn't
 * duplicate or drift from `isLoopback`'s anti-DNS-rebinding logic), no-store,
 * same-origin only (no CORS headers). Nothing here is a secret; the loopback
 * gate is just "don't hand build metadata to a random tab", same reasoning as
 * every other `/__*` route.
 *
 * Registration (not done in this module — see file header):
 * ```ts
 * import { versionEndpoint } from "./scripts/version";
 * // ...
 * server.middlewares.use("/__version", versionEndpoint(isLoopback));
 * ```
 */
export function versionEndpoint(isLoopback: (req: LoopbackRequest) => boolean, info: () => Promise<VersionInfo> = versionInfo) {
  return (req: LoopbackRequest & { method?: string }, res: MiddlewareRes, next: () => void) => {
    if (req.method !== "GET") return next();
    if (!isLoopback(req)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "loopback only" }));
      return;
    }
    void info().then((value) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    });
  };
}

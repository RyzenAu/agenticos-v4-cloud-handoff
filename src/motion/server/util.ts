/** Small Node helpers for the Motion Library server: paths, binaries, requests. */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { isAtThisPc } from "../../../scripts/identity/principal";
import { isServerFounderGrant } from "../../../scripts/identity/server-role";

/** M&U: C: is short on space, so on Windows projects live on D: when it exists. */
export const WINDOWS_STUDIO_HOME = "D:\\motion-studio-projects";

/** Where projects, assets and exports live (override with MOTION_STUDIO_HOME). */
export function studioHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hasDrive: (root: string) => boolean = existsSync,
): string {
  if (env.MOTION_STUDIO_HOME) return env.MOTION_STUDIO_HOME;
  if (platform === "win32" && hasDrive("D:\\")) return WINDOWS_STUDIO_HOME;
  return join(homedir(), "motion-studio-projects");
}
export const exportsDir = (env?: NodeJS.ProcessEnv) => join(studioHome(env), "exports");
export const assetsDir = (env?: NodeJS.ProcessEnv) => join(studioHome(env), "assets");

/** A regular asset file whose canonical path stays inside the asset directory. */
export function safeAssetPath(input: unknown, env?: NodeJS.ProcessEnv): string | null {
  if (typeof input !== "string" || !input || input.includes("\0")) return null;
  try {
    const root = realpathSync(assetsDir(env));
    const file = realpathSync(resolve(input));
    return file.startsWith(root + sep) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** ~/… form of a path, for showing people. */
export function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home + "/") || path.startsWith(home + "\\") || path === home
    ? "~" + path.slice(home.length)
    : path;
}

export function slugify(text: string, fallback = "motion"): string {
  const slug = (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** First free "<slug>", "<slug>-2", … inside base. */
export function uniqueChild(base: string, slug: string): string {
  if (!existsSync(join(base, slug))) return join(base, slug);
  for (let i = 2; i < 1000; i++)
    if (!existsSync(join(base, `${slug}-${i}`))) return join(base, `${slug}-${i}`);
  return join(base, `${slug}-${Date.now()}`);
}

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Find a CLI on PATH or in the usual per-user folders. */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = homedir();
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const dirs = [
    ...(env.PATH || env.Path || "").split(delimiter),
    // winget installs ffmpeg/ffprobe here, which a server started at login may not have on PATH.
    ...(process.platform === "win32" && env.LOCALAPPDATA
      ? [join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")]
      : []),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);
  for (const dir of dirs) for (const n of names) if (executable(join(dir, n))) return join(dir, n);
  return null;
}

// ── requests ─────────────────────────────────────────────────────────────
export function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Local, same-origin requests only (the same rule as the Website tab). */
export function isLocalRequest(req: IncomingMessage): boolean {
  // Stage B1: the same "at this PC" rule as the identity contract: loopback socket, a local Host and
  // no relay header (Tailscale-*, X-Forwarded-*, Forwarded, Via, X-Real-IP).
  // MU_HUB_ROLE=server: a founder the identity gate admitted to this local-owner route (scripts/identity/server-role.ts)
  // is let in too; his browser reaches the hub over HTTPS through Tailscale Serve. The cross-origin checks below
  // still apply, against his own https origin.
  const granted = isServerFounderGrant(req);
  if (!granted && !isAtThisPc(req)) return false;
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  if (
    origin &&
    !(granted && origin === `https://${host}`) &&
    origin !== `http://${host}` &&
    origin !== `http://${host.replace("127.0.0.1", "localhost")}` &&
    origin !== `http://${host.replace("localhost", "127.0.0.1")}`
  )
    return false;
  const site = req.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(String(site))) return false;
  return true;
}

export function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  limit: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      reject(Object.assign(new Error("JSON is required."), { status: 415 }));
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch {
        reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

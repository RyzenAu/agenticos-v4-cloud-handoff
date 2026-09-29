// Local previews at the root of their own origin: http://<name>.localhost:8091/.
//
// The lead previews and the flagship templates are static Next.js exports. Their HTML, and the Next
// runtime itself, load /_next/static/... chunks and RSC .txt payloads from the SITE ROOT, so serving
// them under a sub-path of the OS (/__lead-sites/local/<id>/) sent every one of those requests to the
// OS's own Vite server and the page came up unstyled. Giving each preview its own origin fixes that
// without rewriting anything. Chrome resolves *.localhost to loopback, and this server only listens
// on 127.0.0.1 and only answers Host headers of the form <name>.localhost:<port>.
//
//   <slug>.localhost          a lead preview, by its registry slug (scripts/lead-sites/registry.ts)
//   tpl--<vertical>.localhost a flagship template in <drafts>/_templates/<vertical>
//   draft--<folder>.localhost a site-draft in <drafts>/<folder> (the ones with a root index.html)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { readRegistry } from "./registry";

export const PREVIEW_PORT = 8091;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml",
  // Next's static-export router accepts text/plain for its RSC payloads (what Vercel serves too).
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};

export type PreviewSite = { kind: "lead" | "template" | "draft"; name: string; dir: string };

/** The local URL for a preview host name (a lead slug, `tpl--<vertical>` or `draft--<folder>`). */
export function localPreviewUrl(name: string, port = PREVIEW_PORT): string {
  return `http://${name}.localhost:${port}/`;
}

/**
 * Host header -> the preview folder it names, or null. Only `<name>.localhost:<port>` is accepted,
 * so a DNS-rebinding page on some other host name never reaches a preview.
 */
export function resolvePreviewHost(
  host: string | undefined,
  opts: { root: string; draftsRoot: string; port?: number },
): PreviewSite | null {
  const port = opts.port ?? PREVIEW_PORT;
  const m = /^([a-z0-9-]+)\.localhost(?::(\d+))?$/.exec(String(host ?? "").toLowerCase());
  if (!m || (m[2] ?? "80") !== String(port)) return null;
  const name = m[1];
  const prefixed = /^(tpl|draft)--(.+)$/.exec(name);
  if (prefixed) {
    const folder = prefixed[2];
    if (!NAME.test(folder)) return null;
    if (prefixed[1] === "tpl") {
      const dir = join(opts.draftsRoot, "_templates", folder);
      return existsSync(join(dir, "index.html")) ? { kind: "template", name, dir } : null;
    }
    const dir = join(opts.draftsRoot, folder);
    return existsSync(join(dir, "index.html")) ? { kind: "draft", name, dir } : null;
  }
  if (!NAME.test(name)) return null;
  const record = readRegistry(opts.root).find((p) => p.slug === name);
  return record && existsSync(record.dir) ? { kind: "lead", name, dir: record.dir } : null;
}

/** Inside `dir` (not the folder itself, not a sibling that shares its prefix)? */
export function isInside(dir: string, file: string): boolean {
  const base = normalize(resolve(dir));
  const target = normalize(resolve(file));
  return target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * URL path -> file on disk, the way a static host serves a Next export with clean URLs:
 * `/` -> index.html, `/foo` -> foo.html or foo/index.html, `/a.css` -> a.css. Returns null for
 * anything outside `dir` (encoded or not), dotfiles, or a missing file.
 */
export function resolvePreviewFile(dir: string, pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  if (!path.startsWith("/")) path = `/${path}`;
  const segments = path.split("/").filter(Boolean);
  // No dotfiles or dot-folders (.vercel, .env*): only the site's own files are served.
  if (segments.some((s) => s.startsWith("."))) return null;
  // Deploy config isn't part of the site (Vercel doesn't serve it either).
  if (segments.length === 1 && segments[0].toLowerCase() === "vercel.json") return null;
  const rel = segments.join("/");
  const candidates = !rel
    ? ["index.html"]
    : path.endsWith("/")
      ? [`${rel}/index.html`, `${rel}.html`]
      : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const candidate of candidates) {
    const file = join(dir, candidate);
    if (!isInside(dir, file)) return null;
    try {
      if (existsSync(file) && statSync(file).isFile()) return file;
    } catch {
      /* unreadable: try the next form */
    }
  }
  return null;
}

/** Headers a preview carries live (its vercel.json CSP and friends), so a local look is faithful. */
function previewHeaders(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(dir, "vercel.json");
  if (!existsSync(file)) return out;
  try {
    const config = JSON.parse(readFileSync(file, "utf8"));
    const allowed = new Set(["content-security-policy", "referrer-policy", "x-content-type-options", "permissions-policy"]);
    for (const block of Array.isArray(config?.headers) ? config.headers : []) {
      if (block?.source !== "/(.*)") continue;
      for (const h of Array.isArray(block.headers) ? block.headers : [])
        if (typeof h?.key === "string" && typeof h?.value === "string" && allowed.has(h.key.toLowerCase())) out[h.key] = h.value;
    }
  } catch {
    /* a broken vercel.json just means no extra headers */
  }
  return out;
}

export function previewHandler(opts: { root: string; draftsRoot: string; port?: number }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-cache");
    const plain = (status: number, text: string) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(text);
    };
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) return plain(403, "Local previews are only served to this PC.");
    if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Read-only.");
    const site = resolvePreviewHost(req.headers.host, opts);
    if (!site) return plain(404, "No local preview at this address. Generate one from the lead's drawer in Agentic OS.");
    const pathname = new URL(req.url || "/", "http://preview.localhost").pathname;
    const file = resolvePreviewFile(site.dir, pathname);
    for (const [k, v] of Object.entries(previewHeaders(site.dir))) res.setHeader(k, v);
    if (!file) {
      const notFound = join(site.dir, "404.html");
      if (existsSync(notFound) && !/\.[a-z0-9]+$/i.test(pathname)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", TYPES[".html"]);
        return res.end(req.method === "HEAD" ? undefined : readFileSync(notFound));
      }
      return plain(404, "Not found");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    return res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type State = { server: Server; handler: Handler; port: number; listening: boolean; error: string | null };
const G = globalThis as { __muPreviewServer?: State };

/**
 * Starts the loopback preview server once per process. A dev-server reload re-runs configureServer
 * without closing the old listener, so a second call only swaps in the fresh handler (new code,
 * new options) instead of stacking another server on the same port.
 */
export function startPreviewServer(opts: { root: string; draftsRoot: string; port?: number }): State {
  const port = opts.port ?? PREVIEW_PORT;
  const handler = previewHandler({ ...opts, port });
  const existing = G.__muPreviewServer;
  if (existing && existing.port === port) {
    existing.handler = handler;
    return existing;
  }
  const state: State = { server: null as unknown as Server, handler, port, listening: false, error: null };
  state.server = createServer((req, res) => {
    try {
      state.handler(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "Preview error");
    }
  });
  state.server.on("listening", () => { state.listening = true; state.error = null; });
  state.server.on("error", (error: NodeJS.ErrnoException) => {
    state.listening = false;
    state.error = error.code === "EADDRINUSE" ? `Port ${port} is already in use, so local previews can't open.` : error.message;
    console.warn(`[lead-sites] preview server: ${state.error}`);
  });
  state.server.listen(port, "127.0.0.1");
  state.server.unref?.();
  G.__muPreviewServer = state;
  return state;
}

export function previewServerState(): { port: number; listening: boolean; error: string | null } | null {
  const s = G.__muPreviewServer;
  return s ? { port: s.port, listening: s.listening, error: s.error } : null;
}

/** Every template and site-draft folder that can be previewed locally (lead previews come from the registry). */
export function listLocalSites(draftsRoot: string): { templates: string[]; drafts: string[] } {
  const safe = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name)).map((d) => d.name);
    } catch {
      return [];
    }
  };
  return {
    templates: safe(join(draftsRoot, "_templates")).filter((v) => existsSync(join(draftsRoot, "_templates", v, "index.html"))),
    drafts: safe(draftsRoot).filter((d) => existsSync(join(draftsRoot, d, "index.html"))),
  };
}

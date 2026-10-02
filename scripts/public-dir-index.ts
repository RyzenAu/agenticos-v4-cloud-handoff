// A directory under public/ that has an index.html is served at BOTH /dir/ and /dir.
//
// Why: the dev server's static handling only serves a file when the URL names it, and the router (trailingSlash
// "never") answers /dir/ with a 307 to /dir, which is not a route and 404s ("Page not found"). So
// /mu-creative-20261001/ redirected to a 404 and only /mu-creative-20261001/index.html worked. This runs before the router:
//   /dir   -> 307 to /dir/   (so the page's relative asset paths, assets/film.mp4, resolve under /dir/)
//   /dir/  -> that directory's index.html
// It never acts on a name that is also an app route (src/routes: /transitions is a route, and an old static
// public/transitions/ page must not shadow it on a refresh), on /__* APIs, or on dot-files and dot-folders.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/** The first path segment of every file route in `routesDir` (agents.claude-code.tsx -> "agents", memory_.vault.tsx -> "memory"). */
export function appRouteNames(routesDir: string): Set<string> | null {
  const names = new Set<string>();
  let files: string[] = [];
  try { files = readdirSync(routesDir); } catch { return null; } // unreadable: the caller must fail closed
  for (const file of files) {
    if (file.startsWith("-") || file.startsWith("__") || file.startsWith(".")) continue; // ignored by the router (-pages) or the root
    const first = file.replace(/\.(tsx?|jsx?)$/, "").split(".")[0].replace(/_$/, "");
    if (!first || first === "index" || first.startsWith("$")) continue;
    names.add(first.toLowerCase()); // the router and Windows compare names without case
  }
  return names;
}

export function publicDirIndex(publicRoot: string, routesDir: string) {
  const root = resolve(publicRoot);
  let cache: { at: number; names: Set<string> | null } | null = null;
  const routeNames = (): Set<string> | null => {
    let at = -1; try { at = statSync(routesDir).mtimeMs; } catch { /* unreadable */ }
    if (!cache || cache.at !== at) cache = { at, names: appRouteNames(routesDir) };
    return cache.names;
  };
  return function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const [rawPath, query = ""] = (req.url ?? "/").split("?", 2) as [string, string?];
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { return next(); }
    // Anything that could mean something other than a plain folder name is not ours: a second layer of encoding, a
    // backslash, a NUL, a colon (drive letters, ::$DATA streams), dot segments and dot-files.
    if (decoded.includes("%") || decoded.includes("\\") || decoded.includes("\0") || decoded.includes(":")) return next();
    const segments = decoded.split("/").filter(Boolean);
    if (!segments.length || segments.some((s) => s.startsWith("."))) return next();
    if (segments[0].startsWith("__") || segments[0].startsWith("@")) return next();
    const names = routeNames();
    if (!names) return next(); // the route list cannot be read: serve no directory index rather than risk shadowing an app route
    if (names.has(segments[0].toLowerCase())) return next(); // an app route wins over any static folder of the same name
    const dir = resolve(join(root, ...segments));
    if (dir === root || !dir.startsWith(root + sep)) return next();
    const index = join(dir, "index.html");
    try { if (!statSync(dir).isDirectory() || !existsSync(index)) return next(); } catch { return next(); }
    const clean = "/" + segments.map(encodeURIComponent).join("/"); // always exactly one leading slash
    if (!decoded.endsWith("/")) {
      res.statusCode = 307;
      res.setHeader("Location", `${clean}/${query ? `?${query}` : ""}`);
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.end(req.method === "HEAD" ? undefined : readFileSync(index));
  };
}

export function publicDirIndexPlugin(publicRoot: string, routesDir: string): Plugin {
  return { name: "mu-public-dir-index", configureServer(server) { server.middlewares.use(publicDirIndex(publicRoot, routesDir)); } };
}

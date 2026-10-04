import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * The /__* fallback (Audit F5, P2-2). About 190 API requests (a wrong method, an unknown sub-path)
 * used to fall through every handler to the app's server-side renderer and come back as the HTML
 * 404 page. This answers them as an API should, before the renderer sees them:
 *   - 405 with an `Allow` header when the path is a mounted route that takes other methods;
 *   - a JSON 404 otherwise.
 *
 * It is the LAST directly mounted middleware (see apiFallbackPlugin), so every route mounted
 * anywhere before it still answers first. Vite's and the dev tooling's own double-underscore
 * paths are passed straight on.
 */

/** Dev-tool paths that are not the app's API: Vite, the editor opener, the Lovable dev bridge. */
const PASS_THROUGH = ["/__vite", "/__open-in-editor", "/__lovable", "/__hmr_"];

const METHOD_NAMES = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isApiPath(path: string): boolean {
  if (!path.startsWith("/__")) return false;
  return !PASS_THROUGH.some((prefix) => path.startsWith(prefix));
}

/**
 * The methods each directly mounted route handles, read from the source that mounts them: every
 * `req.method` compared with a method name inside that route's handler. A route whose handler
 * never looks at the method is left out (it answers every method, so a fall-through there is an
 * unknown sub-path, not a wrong method).
 */
export function scanRouteMethods(source: string): Map<string, string[]> {
  const mount = /middlewares\.use\(\s*"(\/__[^"]+)"/g;
  const found: Array<{ path: string; at: number }> = [];
  for (const m of source.matchAll(mount)) found.push({ path: m[1], at: m.index ?? 0 });
  const methods = new Map<string, string[]>();
  for (let i = 0; i < found.length; i++) {
    const { path, at } = found[i];
    if (path.endsWith("/")) continue; // a prefix mount for /:id sub-paths
    const segment = source.slice(at, i + 1 < found.length ? found[i + 1].at : undefined);
    const seen = new Set<string>();
    for (const m of segment.matchAll(/req\.method\s*[!=]==?\s*"([A-Z]+)"/g)) seen.add(m[1]);
    for (const m of segment.matchAll(/"([A-Z]+)"\s*[!=]==?\s*req\.method\b/g)) seen.add(m[1]);
    for (const m of segment.matchAll(/\[([^\]]*)\]\.includes\(\s*req\.method/g))
      for (const name of m[1].matchAll(/"([A-Z]+)"/g)) seen.add(name[1]);
    const list = [...seen].filter((name) => METHOD_NAMES.has(name));
    if (!list.length) continue;
    methods.set(path, [...new Set([...(methods.get(path) ?? []), ...list])].sort());
  }
  return methods;
}

export type RouteMethods = Map<string, string[]>;

/** The fallback middleware itself. `routes` is read on the first fall-through, then kept. */
export function apiFallback(routes: () => RouteMethods) {
  let table: RouteMethods | null = null;
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (!isApiPath(path) || res.headersSent || res.writableEnded) return next();
    if (!table) {
      try {
        table = routes();
      } catch {
        table = new Map();
      }
    }
    const method = (req.method || "GET").toUpperCase();
    const listed = table.get(path.length > 1 ? path.replace(/\/+$/, "") : path);
    // HEAD is served wherever GET is (apiJsonDefault turns it into a body-less GET), and OPTIONS
    // is answered here, so both belong in Allow.
    const allow = listed ? [...new Set([...listed, ...(listed.includes("GET") ? ["HEAD"] : []), "OPTIONS"])] : undefined;
    // Whatever the caller sent is not going to be read.
    req.resume();
    res.setHeader("Cache-Control", "no-store");
    if (allow && method === "OPTIONS") {
      res.setHeader("Allow", allow.join(", "));
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (allow && !allow.includes(method)) {
      res.setHeader("Allow", allow.join(", "));
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, error: `${method} is not supported here. Use ${allow.join(" or ")}.`, allow }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "Unknown API route." }));
  };
}

/**
 * Many /__* handlers answer `res.end(JSON.stringify(...))` on an early path (403, 400) without
 * ever setting a Content-Type (Audit F5 P3). This labels such a response application/json at the
 * moment it is sent, only when nothing set a type and the body is a JSON object or array. File,
 * HTML, SSE and text answers set their own type and are left alone.
 */
export function apiJsonDefault() {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (!isApiPath(new URL(req.url || "/", "http://localhost").pathname)) return next();
    // HEAD wherever GET works (review S3): the routes only test for "GET", so a HEAD is handled
    // as a GET here and its body is dropped (Node already omits it for a HEAD response; this
    // makes sure under any runtime).
    const head = (req.method || "").toUpperCase() === "HEAD";
    if (head) req.method = "GET";
    const label = (chunk: unknown) => {
      if (res.headersSent || res.getHeader("content-type")) return;
      const head = typeof chunk === "string" ? chunk.slice(0, 64) : Buffer.isBuffer(chunk) ? chunk.subarray(0, 64).toString("utf8") : "";
      if (/^\s*[{[]/.test(head)) res.setHeader("Content-Type", "application/json");
    };
    const write = res.write.bind(res) as (...args: any[]) => boolean;
    const end = res.end.bind(res) as (...args: any[]) => ServerResponse;
    res.write = ((chunk: unknown, ...rest: any[]) => {
      label(chunk);
      if (head) {
        const done = rest.find((x) => typeof x === "function");
        if (done) queueMicrotask(() => done());
        return true;
      }
      return write(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: any[]) => {
      if (chunk !== undefined && typeof chunk !== "function") label(chunk);
      if (head) {
        const done = [chunk, ...rest].find((x) => typeof x === "function");
        return done ? end(done) : end();
      }
      return end(chunk, ...rest);
    }) as typeof res.end;
    next();
  };
}

/**
 * Two plugins. The JSON labeller is mounted first (`order: "pre"`). The fallback is mounted after
 * every other plugin's directly mounted routes (`order: "post"`, listed last), which is still
 * before Vite's own middlewares and the app's server-side renderer, both of which run after all
 * directly mounted ones.
 */
export function apiFallbackPlugin(options: { root: string; sources?: string[] }): Plugin[] {
  const sources = options.sources ?? ["vite.config.ts"];
  const labeller: Plugin = {
    name: "agentic-os-api-json-default",
    configureServer: {
      order: "pre",
      handler(server) {
        server.middlewares.use(apiJsonDefault());
      },
    },
  };
  return [labeller, {
    name: "agentic-os-api-fallback",
    configureServer: {
      order: "post",
      handler(server) {
        server.middlewares.use(
          apiFallback(() => {
            const merged: RouteMethods = new Map();
            for (const rel of sources) {
              for (const [path, list] of scanRouteMethods(readFileSync(join(options.root, rel), "utf8")))
                merged.set(path, [...new Set([...(merged.get(path) ?? []), ...list])].sort());
            }
            return merged;
          }),
        );
      },
    },
  }];
}

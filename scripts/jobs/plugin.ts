// Vite plugin: /__jobs and /__approvals (routes.ts), on Stage B1's identity layer:
//   - the caller is B1's ONE verified principal (`requestPrincipal`, the same one the identity gate resolved);
//   - a write carries the caller's OWN page token (`pageTokenMatches`): the internal token at this PC, a
//     per-person token for a remote founder. A remote founder never holds the internal token.
// B1's gate lists /__jobs and /__approvals as shared routes and refuses non-canonical targets before this
// runs; this plugin keeps its own raw-path check as well.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { publicJson, type ResolvePrincipal } from "../approvals/principal";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { backgroundJobsDisabled } from "../preview-guard";
import { jobsApprovalsRoute } from "./routes";
import { jobsRuntime } from "./runtime";

const MAX_BODY = 8 * 1024;

/** The only path shapes these routes serve: /__jobs or /__approvals, then plain segments (no dot segments, no empty segments, no escapes). */
export function canonicalPath(raw: string): boolean {
  return /^\/__(?:jobs|approvals)(?:\/[A-Za-z0-9-]+)*$/.test(raw);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export type JobsApprovalsOptions = {
  root: string;
  /** The per-run internal page token (vite.config.ts REFRESH_TOKEN). Each principal's own token derives from it. */
  token?: string | (() => string);
  /** Defaults to B1's requestPrincipal for this root. */
  resolvePrincipal?: ResolvePrincipal;
  deps?: Parameters<typeof jobsApprovalsRoute>[1];
};

export function jobsApprovalsMiddleware(options: JobsApprovalsOptions) {
  const resolve: ResolvePrincipal = options.resolvePrincipal ?? ((req) => requestPrincipal(req as never, { root: options.root }));
  const internalToken = () => (typeof options.token === "function" ? options.token() : options.token);
  const deps = options.deps ?? { jobs: () => jobsRuntime(options.root).jobs, approvals: () => jobsRuntime(options.root).approvals };
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // The RAW path decides, never a normalised one: "/x/../__jobs", "//__jobs", "/__jobs/./x", "%2e%2e",
    // backslashes and encoded slashes are refused here, not quietly rewritten into a route (B1's gate
    // rejects them too; neither side normalises its way around the other).
    const raw = String(req.url ?? "/").split("?")[0];
    const url = new URL(req.url ?? "/", "http://localhost");
    const ours = /^\/__(jobs|approvals)(\/|$)/;
    if (!ours.test(raw) && !ours.test(url.pathname)) return next();
    if (!canonicalPath(raw) || raw !== url.pathname)
      return void Object.assign(res, { statusCode: 400 }).end(JSON.stringify({ error: "Non-canonical path" }));
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // AUDIT-A1-1: no principal's session key or device id leaves in a list, a detail, an error or an event.
      res.end(JSON.stringify(body, publicJson));
    };
    const method = req.method ?? "GET";
    if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "Cross-site request blocked" });
    const host = String(req.headers.host ?? "");
    if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return send(403, { error: "Unknown origin" });
    const principal = resolve(req);
    if (!principal) return send(401, { error: "Sign in to see or act on jobs and approvals." });
    let body: unknown;
    if (method !== "GET") {
      // The caller's OWN page token (B1): the internal token only at this PC; a remote founder's own.
      const token = internalToken();
      if (token !== undefined && !pageTokenMatches(principal as never, req.headers["x-claude-os-token"], token))
        return send(403, { error: "Refresh this page and try again." });
      // The exact media type, not a substring ("text/plain; x=application/json" is not JSON).
      if (String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return send(415, { error: "Send JSON" });
      try {
        body = await readJson(req);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return send(status, { error: status === 413 ? "The request body is too large." : "Invalid JSON body" });
      }
    }
    const result = await jobsApprovalsRoute({ method, path: raw, url, body, principal }, deps);
    if (!result) return next();
    send(result.status, result.body);
  };
}

export function jobsApprovalsPlugin(options: Omit<JobsApprovalsOptions, "deps">): Plugin {
  return {
    name: "agentic-os-jobs-approvals",
    configureServer(server) {
      // The owning server opens both stores now, so restart recovery (pending stays pending, running →
      // unknown, nothing replayed) happens before any new job or approval. A quiet copy stays lazy/read-only.
      if (!backgroundJobsDisabled()) {
        try {
          jobsRuntime(options.root);
        } catch {
          /* unavailable: the routes answer 503 and the gates keep their own state */
        }
      }
      server.middlewares.use(jobsApprovalsMiddleware(options) as never);
    },
  };
}

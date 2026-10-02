// Generated lead-site previews for a founder who reached the hub remotely (Tailscale Serve).
//
// Locally a preview lives at the root of its own origin, http://<name>.localhost:8091/ (preview-server.ts),
// because a Next export loads /_next/..., /_img/... and every page link from the SITE ROOT. *.localhost is
// the viewer's own machine, so that URL means nothing from another PC, and a sub-path on the hub's origin
// (/something/<name>/...) cannot work either: the HTML, the Next runtime and its router all use root-absolute
// paths, and "/" on the hub's origin is the hub itself.
//
// So the remote preview gets its own ORIGIN, still served by the hub and still behind its identity:
//
//   https://<hub>.<tailnet>.ts.net:<MU_PREVIEW_ORIGIN_PORT, default 8445>/
//
// The owner adds one more Tailscale Serve mapping to the SAME hub listener (no new listener on this PC, no
// Funnel, preview port untouched):  tailscale serve --bg --https=8445 http://127.0.0.1:8081
// A request whose Host carries that port is a preview-origin request. This middleware sits in front of the
// identity gate (the gate would classify Next's own `/__next.*.txt` prefetch files as hub routes), so it does
// the gate's authentication itself, with the gate's own functions: the canonical-target check, then
// requestIdentity() (Tailscale-User-Login honoured only from the local tailscaled relay, mapped through
// people.json). It never calls next(): every request on that Host is answered here, so nothing of the hub
// (Vite, /__* routes, source files) is ever served on the preview origin.
//
// Which site? A `mu_pv` cookie, set by GET /_mu-preview/open/<name> (HttpOnly, Secure, SameSite=Lax) after the
// name is checked against the same rules as the loopback listener (a registered lead, an existing template,
// a draft with a root index). Files come from the same code as the loopback listener (servePreviewSite), in
// process: no second hop, no Host header to forge, 8091 never involved.
//
// Known limit: a preview that registered a service worker on this origin could answer
// /_mu-preview/open/<other> itself, so the Clear-Site-Data sent on a site switch would never arrive and the
// old site's local data would stay readable by the next. The Aldergate/dental/legal exports register none (and
// the origin only ever serves our own generated files), so this is documented rather than blocked: refusing
// worker files or forcing `worker-src 'none'` could break a template, and the hub never serves a preview
// that isn't one of our exports. A founder can clear it from the browser's site data for the preview port.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { nonCanonicalTarget, requestIdentity } from "../identity/gate";
import { isBrowserPrincipal, parseCookies, type IdentityContext } from "../identity/principal";
import { relayedByTailscaleServe } from "../identity/serve-peer";
import { tailnetSnapshotWait } from "../remote-access";
import { defaultDraftsRoot } from "../site-draft/orchestrator";
import { resolvePreviewName, servePreviewSite } from "./preview-server";

export const DEFAULT_PREVIEW_ORIGIN_PORT = 8445;
export const PREVIEW_COOKIE = "mu_pv";
export const PREVIEW_ENTRY = "/_mu-preview/open/";

/** The Serve port that carries previews: MU_PREVIEW_ORIGIN_PORT, else 8445. */
export function previewOriginPort(env: Record<string, string | undefined> = process.env): number {
  const n = Number(String(env.MU_PREVIEW_ORIGIN_PORT ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PREVIEW_ORIGIN_PORT;
}

/** Is this Host the hub's tailnet name on the preview port? (A port is required: the preview origin is a distinct origin.) */
export function isPreviewOriginHost(host: string | undefined, port: number): boolean {
  const m = /^([a-z0-9][a-z0-9.-]*\.ts\.net):(\d{1,5})$/i.exec(String(host ?? ""));
  return !!m && Number(m[2]) === port;
}

/** The URL a founder opens for a preview, given the Host header of the hub page they are on. Null when it isn't a tailnet name. */
export function remotePreviewUrl(hubHost: string | undefined, name: string, port = previewOriginPort()): string | null {
  const m = /^([a-z0-9][a-z0-9.-]*\.ts\.net)(?::\d{1,5})?$/i.exec(String(hubHost ?? ""));
  if (!m || !/^[a-z0-9-]+$/.test(name)) return null;
  return `https://${m[1].toLowerCase()}:${port}${PREVIEW_ENTRY}${name}`;
}

type Ctx = Partial<IdentityContext>;
export type PreviewOriginOptions = { root: string; draftsRoot: string; port?: number; identity?: Ctx };

const SIGN_IN = "Sign in first: open Agentic OS through your own Tailscale address, pair this device, then open the preview from there.";
const NO_SITE = "Open this preview from Agentic OS (Leads, then Preview). Nothing is selected here.";

function reply(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(text);
}

/** The gate's wait for a fresh tailnet snapshot (identity/gate.ts snapshotWait), so a just-joined node isn't refused. */
async function settleTailnet(req: IncomingMessage, ctx: Ctx) {
  if (ctx.tailnet) return;
  if (!String(req.headers["tailscale-user-login"] ?? "").trim()) return;
  try {
    if (!(ctx.servePeer ?? relayedByTailscaleServe)(req)) return;
    await tailnetSnapshotWait(req);
  } catch {
    /* fail closed: the identity decision below answers with what it has */
  }
}

/**
 * The preview origin's middleware. A request whose Host isn't the hub's tailnet name on the preview port goes
 * straight on (next()); every request that is gets an answer here.
 */
export function previewOriginHandler(options: PreviewOriginOptions) {
  const port = options.port ?? previewOriginPort();
  const ctx: Ctx = { root: options.root, ...(options.identity ?? {}) };
  const sites = { root: options.root, draftsRoot: options.draftsRoot };
  return async function previewOrigin(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    if (!isPreviewOriginHost(req.headers.host, port)) return next();
    try {
      const odd = nonCanonicalTarget(req.url || "");
      if (odd) return reply(res, 400, odd);
      await settleTailnet(req, ctx);
      const id = requestIdentity(req, ctx);
      if (!id.principal) return reply(res, 401, SIGN_IN);
      // Founders only: a companion token or a Telegram relay is not a person at a browser.
      if (!isBrowserPrincipal(id.principal)) return reply(res, 403, "Only a signed-in founder can open previews.");
      // A page that arrived over plain HTTP (a local process claiming this Host) is never the Serve path.
      if (!id.secure) return reply(res, 403, "Previews open through your Tailscale address only.");

      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("Vary", "Cookie");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Read-only.", { Allow: "GET, HEAD" });

      const path = (req.url || "/").split("?")[0];
      if (path.startsWith(PREVIEW_ENTRY)) {
        const name = path.slice(PREVIEW_ENTRY.length);
        const site = /^[a-z0-9-]+$/.test(name) ? resolvePreviewName(name, sites) : null;
        if (!site) return reply(res, 404, "No such preview. Generate it from the lead's drawer in Agentic OS first.");
        const before = parseCookies(req.headers.cookie)[PREVIEW_COOKIE];
        const headers: Record<string, string> = {
          Location: "/",
          "Set-Cookie": `${PREVIEW_COOKIE}=${site.name}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`,
        };
        // Previews share this origin's storage, so switching from one site to another wipes it: one preview's
        // local data (its saved list, say) is never readable by the next one.
        if (before && before !== site.name) headers["Clear-Site-Data"] = '"storage"';
        return reply(res, 302, "", headers);
      }

      const selected = parseCookies(req.headers.cookie)[PREVIEW_COOKIE];
      const site = selected && /^[a-z0-9-]+$/.test(selected) ? resolvePreviewName(selected, sites) : null;
      if (!site) return reply(res, 404, NO_SITE);
      return servePreviewSite(req, res, site);
    } catch (error) {
      if (!res.headersSent) reply(res, 500, "Preview error");
      else res.end();
      console.warn(`[lead-sites] preview origin: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * The Vite plugin. Mount it BEFORE the identity gate in vite.config.ts (after startupGatePlugin): see the
 * file header for why, and for what the middleware itself checks.
 */
export function previewOriginPlugin(options: { root: string; draftsRoot?: string; port?: number }): Plugin {
  return {
    name: "mu-lead-sites-preview-origin",
    configureServer(server) {
      server.middlewares.use(previewOriginHandler({ root: options.root, draftsRoot: options.draftsRoot ?? defaultDraftsRoot(), port: options.port }));
    },
  };
}

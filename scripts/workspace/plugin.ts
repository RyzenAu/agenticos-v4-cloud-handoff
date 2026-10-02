// /__workspace — the Workspace page's data (src/routes/workspace.tsx). GET only, read-only.
//
//   GET /__workspace                 every panel (partial results: a failed panel is { ok:false })
//   GET /__workspace/<panel>         one panel: today | call-queue | receptionist | websites | email | pipeline | enquiries | needs-you
//   GET /__workspace/groups          the saved three-workspace grouping (.operator-data/workspaces.json), or saved:null
//
// Guards match the other /__* routes: loopback socket only, a verified principal (the owner at this
// PC or a founder signed in through Tailscale; a DNS-rebound page or an unknown login is nobody),
// same-origin only, cross-site refused.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin } from "vite";
import { readOpenEnquiries, type EnquiryRecord } from "../speed-to-lead/store";
import { createWorkspace, loopbackJson, type PanelName } from "./sources";
import { parseWorkspacesFile, type SavedGroups } from "./three-workspaces";
import { requestPrincipal } from "../identity/gate";
import { authorise, isBrowserPrincipal, type Principal } from "../identity/principal";
import { decisionPath } from "./decisions";
import { dataDirFor } from "../cloud/data-dir";

const ROUTES: Record<string, PanelName> = {
  "/today": "today",
  "/call-queue": "callQueue",
  "/receptionist": "receptionist",
  "/websites": "websites",
  "/email": "email",
  "/pipeline": "pipeline",
  "/enquiries": "enquiries",
  "/needs-you": "needsYou",
};
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

type GuardReq = Pick<IncomingMessage, "headers" | "method"> & { socket: { remoteAddress?: string } };

/**
 * Refusal reason for a request, or null when it may read the workspace. Stage B1 (review M1/M3): the
 * caller is the one verified principal (scripts/identity), so Host: localhost plus a relay header
 * is nobody; and the workspace is shared business data (V7), so both verified founders read it.
 */
export function refuse(req: GuardReq, principalFor: (req: GuardReq) => Principal | null = (r) => requestPrincipal(r)): { status: number; error: string } | null {
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? "")) return { status: 403, error: "Loopback only" };
  const principal = principalFor(req);
  const access = authorise(isBrowserPrincipal(principal) ? principal : null, { kind: "business", area: "workspace" }, "read");
  if (!access.ok) return { status: access.status, error: access.reason };
  const host = String(req.headers.host ?? "");
  if (req.headers["sec-fetch-site"] === "cross-site") return { status: 403, error: "Cross-site request blocked" };
  const scheme = principal?.via === "loopback-owner" ? "http" : "https";
  if (req.headers.origin && req.headers.origin !== `${scheme}://${host}`) return { status: 403, error: "Unknown origin" };
  if ((req.method ?? "GET") !== "GET") return { status: 405, error: "Read-only" };
  return null;
}

export type { SavedGroups } from "./three-workspaces";

/** Reads .operator-data/workspaces.json (written only by consolidate-workspaces.ts --apply). */
export function savedGroupsReader(root: string): () => SavedGroups {
  const file = join(dataDirFor(root), "workspaces.json");
  return () => {
    if (!existsSync(file)) return { saved: null };
    try {
      const saved = parseWorkspacesFile(JSON.parse(readFileSync(file, "utf8")));
      return saved ? { saved } : { saved: null, error: "workspaces.json is not a saved grouping" };
    } catch {
      return { saved: null, error: "workspaces.json could not be read" };
    }
  };
}

export function workspaceMiddleware(workspace: ReturnType<typeof createWorkspace>, principalFor?: (req: GuardReq) => Principal | null, groups?: () => SavedGroups) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    const route = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    if (route !== "/" && route !== "/groups" && !ROUTES[route]) return next();
    const refused = refuse(req, principalFor);
    if (refused) return json(refused.status, { error: refused.error });
    if (route === "/groups") return json(200, groups ? groups() : { saved: null });
    // ?fresh=1 (Refresh / Retry) reads the source again instead of reusing a recent read.
    const fresh = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("fresh") === "1";
    const work = route === "/" ? workspace.all({ fresh }) : workspace.panel(ROUTES[route], { fresh });
    void work.then((body) => json(200, body), () => json(500, { error: "Workspace unavailable" }));
  };
}

/**
 * The CRM panels (pipeline, call queue) change when crm.sqlite or its WAL changes: size + mtime of
 * both, so a call logged on /leads invalidates the reused read. Other panels: null (time-based).
 */
export function crmChangeKey(root: string): (name: PanelName) => string | null {
  const files = [join(dataDirFor(root), "crm.sqlite"), join(dataDirFor(root), "crm.sqlite-wal")];
  return (name) => {
    if (name === "today" || name === "needsYou") return [join(root, "scripts/workspace/approvals.json"), decisionPath(root)].map(f => existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : "-").join("|");
    if (name !== "pipeline" && name !== "callQueue") return null;
    return files.map((f) => (existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : "-")).join("|");
  };
}

/** Open speed-to-lead enquiries from the CRM, opened read-only per request (never created here). */
export function enquiryReader(root: string): () => EnquiryRecord[] {
  const file = join(dataDirFor(root), "crm.sqlite");
  return () => {
    if (!existsSync(file)) return [];
    const { Database } = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(file, { readonly: true });
    try {
      return readOpenEnquiries(db);
    } finally {
      db.close();
    }
  };
}

export function workspacePlugin(options: { root: string }): Plugin {
  return {
    name: "agentic-os-workspace",
    configureServer(server) {
      // The panels read this server's own loopback APIs; the port is whatever it's listening on.
      const origin = () => {
        const address = server.httpServer?.address();
        const port = address && typeof address === "object" ? address.port : server.config.server.port ?? 8081;
        return `http://127.0.0.1:${port}`;
      };
      const workspace = createWorkspace({
        get: loopbackJson(origin),
        approvalsFile: join(options.root, "scripts/workspace/approvals.json"),
        decisionsFile: decisionPath(options.root),
        enquiries: enquiryReader(options.root),
        // No scheduler runs scripts/speed-to-lead/run.ts yet (owner yes pending, docs/SPEED-TO-LEAD.md).
        enquiryWatcherScheduled: false,
        changeKey: crmChangeKey(options.root),
      });
      server.middlewares.use("/__workspace", workspaceMiddleware(workspace, (req) => requestPrincipal(req, { root: options.root }), savedGroupsReader(options.root)));
    },
  };
}

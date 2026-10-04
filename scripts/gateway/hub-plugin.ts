/**
 * HUB routes for the Dot gateway, mounted at /__gateway (classified in scripts/identity/routes.ts).
 *
 * Dot's operating routes (CRM, files, tasks, jobs, memory, coding, bots, diagnostics) are in hub-ops.ts; this file mounts
 * them and keeps who-am-I, the test activity store and the FOUNDERS' two routes:
 *
 *   GET    /__gateway/admin/access                       Dot's identities, the capabilities in force and the kill switch
 *   POST   /__gateway/admin/identities/<id>/revoke       revoke one identity (immediate, for every gateway request)
 *     Founders only (a confirmed person, or the owner at the hub), with their own page token. Never the gateway principal:
 *     no policy rule names /__gateway/admin, and the handler refuses it by name as well.
 *
 *   GET    /__gateway/me                        who the hub thinks this request is (person, via, capabilities)
 *   GET    /__gateway/crm/activity[?eventId=]   the test activities (newest first), or the one with that eventId
 *   POST   /__gateway/crm/activity              crm.activity.add  { ref, eventId, kind, title }   idempotent on eventId
 *   DELETE /__gateway/crm/activity/<id>         undo: remove that activity
 *
 * WHY A TEST STORE: the contract (docs/programme-20261001/AGENTS-CRM-CONTRACTS.md section 4) puts `crm.activity.add` in
 * scripts/crm/ops.ts, which Dot owns and which is not on this branch yet. Until it lands, this route implements the SAME
 * input and receipt against a clearly-marked store (MU_DATA_DIR/gateway/crm-test-activities.json; every row says
 * `test: true`). It is not the CRM database and nothing else reads it. When scripts/crm/ops.ts exists, pass its
 * `crm.activity.add` as `ops.add` (and its undo as `ops.remove`) and the route, the capability and the audit stay as they are.
 *
 * Writes are checked three times: the gateway's allow-list, the hub gate's (scripts/gateway/hub.ts), and here (the
 * principal must hold crm.write, and present its page token). A founder may read the list and remove a row; only the
 * gateway principal adds one, and it is recorded as Dot, never as a founder.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { isAtHub, isBrowserPrincipal, isHumanSession, type Principal } from "../identity/principal";
import { AuditLog } from "./audit";
import { FILES, gatewayDir, RECORD_IDS_HEADER } from "./config";
import { gatewayCapabilities } from "./hub";
import { argsDigest } from "../approvals/canonical";
import { personNotifier } from "../approvals/notify";
import { registerTelegramCodeHandler } from "../approvals/telegram-codes";
import { jobsRuntime } from "../jobs/runtime";
import { createGatewayOps, releaseReceipts, type GatewayOpsOptions } from "./hub-ops";
import { provideGatewayServices } from "./hub-services";
import { createReleaseDesk, releaseCodeHandler, wmiReleaseRunner, type ReleaseApprovals, type ReleaseDesk } from "./release";
import { CAPABILITY_SUMMARY, type Capability } from "./policy";
import { ControlFile, effectiveCapabilities, expiryView, isKilled, listIdentities, renewAccess, writeJsonAtomic } from "./store";

export type CrmRef = { kind: "company" | "contact" | "deal" | "project" | "document" | "lead"; id: string };
export type ActivityInput = { ref: CrmRef; eventId: string; kind: string; title: string; by: { agent: string; session: string; delegatedBy?: string } };
export type ActivityRow = ActivityInput & { activityId: string; at: string; test: true; store: "gateway-test" };
export type ActivityReceipt = { ok: true; activityId: string; href: string; created: boolean };

/** The seam for Dot's real operations (scripts/crm/ops.ts) once they land. */
export type CrmOps = {
  add(input: ActivityInput): ActivityReceipt | Promise<ActivityReceipt>;
  remove(activityId: string): boolean | Promise<boolean>;
  find(eventId: string): ActivityRow | null | Promise<ActivityRow | null>;
  list(): ActivityRow[] | Promise<ActivityRow[]>;
};

const KINDS = ["company", "contact", "deal", "project", "document", "lead"];
const ACTIVITY_KINDS = ["note", "agent-result", "agent-blocked"];
const MAX_ROWS = 500;

/** The clearly-marked test store. One small JSON file, rewritten atomically. */
export function testActivityStore(dir: string): CrmOps {
  const file = join(dir, FILES.activities);
  const read = (): ActivityRow[] => {
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as ActivityRow[];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const write = (rows: ActivityRow[]) => {
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(file, rows.slice(-MAX_ROWS));
  };
  const href = (row: ActivityRow) => `/__gateway/crm/activity?eventId=${encodeURIComponent(row.eventId)}`;
  return {
    add(input) {
      const rows = read();
      // Idempotent on eventId: a retry is a no-op that returns the first receipt.
      const existing = rows.find((r) => r.eventId === input.eventId);
      if (existing) return { ok: true, activityId: existing.activityId, href: href(existing), created: false };
      const row: ActivityRow = { ...input, activityId: `gwact_${randomBytes(8).toString("hex")}`, at: new Date().toISOString(), test: true, store: "gateway-test" };
      write([...rows, row]);
      return { ok: true, activityId: row.activityId, href: href(row), created: true };
    },
    remove(activityId) {
      const rows = read();
      const kept = rows.filter((r) => r.activityId !== activityId);
      if (kept.length === rows.length) return false;
      write(kept);
      return true;
    },
    find: (eventId) => read().find((r) => r.eventId === eventId) ?? null,
    list: () => read().reverse().slice(0, 50),
  };
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

export function parseActivity(body: unknown): { ref: CrmRef; eventId: string; kind: string; title: string } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ref = (b.ref && typeof b.ref === "object" ? b.ref : {}) as Record<string, unknown>;
  const kind = text(ref.kind, 20);
  const id = text(ref.id, 80);
  if (!KINDS.includes(kind) || !/^[A-Za-z0-9:_-]{1,80}$/.test(id)) return { error: "ref must be { kind, id } for a CRM record." };
  const eventId = text(b.eventId, 120);
  if (!/^[A-Za-z0-9:._-]{4,120}$/.test(eventId)) return { error: "eventId must be a stable id (letters, digits, : . _ -)." };
  const activityKind = text(b.kind, 30);
  if (!ACTIVITY_KINDS.includes(activityKind)) return { error: `kind must be one of ${ACTIVITY_KINDS.join(", ")}.` };
  const title = text(b.title, 200);
  if (!title) return { error: "title is required (one line)." };
  return { ref: { kind: kind as CrmRef["kind"], id }, eventId, kind: activityKind, title };
}

export type GatewayRoutesOptions = {
  root: string;
  internalToken: () => string;
  dir?: string;
  ops?: CrmOps;
  principal?: (req: IncomingMessage) => Principal | null;
  /** Dot's operating routes (hub-ops.ts): the live services by default; tests pass their own. */
  operate?: Partial<Omit<GatewayOpsOptions, "root" | "internalToken" | "dir">>;
  /** Whether this hub accepts gateway requests at all (MU_GATEWAY_TRUST=1). Shown to founders in Devices and people. */
  trust?: () => boolean;
};

/** The handler for everything under /__gateway. `req.url` may be the full path or connect's mount-stripped one. */
export function createGatewayRoutes(options: GatewayRoutesOptions) {
  const dir = options.dir ?? gatewayDir(options.root);
  const ops = options.ops ?? testActivityStore(dir);
  const principalOf = options.principal ?? ((req: IncomingMessage) => requestPrincipal(req, { root: options.root }));
  const operate = createGatewayOps({ ...options.operate, root: options.root, internalToken: options.internalToken, dir });
  const control = new ControlFile(dir);
  const trust = options.trust ?? (() => process.env.MU_GATEWAY_TRUST === "1");
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 16 * 1024) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/^\/__gateway(?=\/|$)/, "").replace(/\/+$/, "") || "/";
      const method = req.method || "GET";
      const principal = principalOf(req);
      if (!principal || !isBrowserPrincipal(principal)) return send(res, 401, { error: "Sign in first." });
      const caps = gatewayCapabilities(principal);
      const isGateway = principal.via === "gateway";

      // ── founders: Dot's identities (System, Devices and people) ─────────────────────────────────────────────────
      if (path === "/admin" || path.startsWith("/admin/")) {
        // Never the gateway principal, whatever it holds; and a founder must be a confirmed person or the owner at the hub.
        const founder = !isGateway && (principal.personId === "usman" || principal.personId === "mehroz");
        if (!founder) return send(res, 403, { error: "Only a founder manages gateway access." });
        if (method === "GET" && path === "/admin/access") {
          const c = control.read();
          const now = Date.now();
          const { caps: inForce, grantedBy } = effectiveCapabilities(c, now);
          return send(res, 200, {
            trust: trust(),
            killSwitch: isKilled(dir),
            identities: listIdentities(dir, now),
            capabilities: inForce.map((name) => ({ name, what: CAPABILITY_SUMMARY[name as Capability] ?? "", grantedBy: grantedBy[name] ?? null, expiresAt: c.grants.find((g) => g.capability === name && g.expiresAt > now)?.expiresAt ?? null })),
            unusedCodes: c.codes.filter((r) => r.expiresAt > now).length,
            canRevoke: isHumanSession(principal) || isAtHub(principal),
            canRenew: isHumanSession(principal),
            expiry: expiryView(c, null, now),
            console: { enrol: "bun scripts/gateway/cli.ts enrol-code --by <founder>", revoke: "bun scripts/gateway/cli.ts revoke-identity <id>", grant: "bun scripts/gateway/cli.ts grant operate --by <founder>" },
          });
        }
        if (method === "POST" && path === "/admin/renew") {
          // A confirmed person only: not a bare tailnet sign-in, not a program, never the gateway.
          if (!isHumanSession(principal)) return send(res, 403, { error: "Confirm this browser first: renewing Dot's access needs a confirmed person." });
          if (!pageTokenMatches(principal, req.headers["x-claude-os-token"], options.internalToken())) return send(res, 403, { error: "Refresh this page and try again." });
          try {
            const out = renewAccess(dir, String(principal.personId), 30);
            new AuditLog(dir).write({ event: "identity-renewed", person: "dot", session: null, ip: "-", route: "/__gateway/admin/renew", status: 200, outcome: "allowed", delegatedBy: String(principal.personId) });
            return send(res, 200, { ok: true, ...out, identities: listIdentities(dir) });
          } catch (error) {
            return send(res, 409, { error: (error as Error).message });
          }
        }
        const rv = /^\/admin\/identities\/([a-f0-9]{8,32})\/revoke$/.exec(path);
        if (method === "POST" && rv) {
          if (!isHumanSession(principal) && !isAtHub(principal)) return send(res, 403, { error: "Confirm this browser first: revoking access needs a confirmed person, not a bare sign-in or a program." });
          if (!pageTokenMatches(principal, req.headers["x-claude-os-token"], options.internalToken())) return send(res, 403, { error: "Refresh this page and try again." });
          if (!listIdentities(dir).some((i) => i.id === rv[1])) return send(res, 404, { error: "No such gateway identity." });
          control.revokeIdentity(rv[1]);
          new AuditLog(dir).write({ event: "identity-revoked", person: "dot", session: null, identity: rv[1], ip: "-", route: "/__gateway/admin/identities/*/revoke", status: 200, outcome: "allowed", delegatedBy: String(principal.personId) });
          return send(res, 200, { ok: true, revoked: rv[1], identities: listIdentities(dir) });
        }
        return send(res, 404, { error: "Not found" });
      }

      // ── Dot's operating routes ──────────────────────────────────────────────────────────────────────────────────
      if (operate.mine(path)) return void (await operate.handle(req, res, { path, url, principal }));

      if (method === "GET" && path === "/me") return send(res, 200, { person: principal.personId, via: principal.via, actor: principal.actor, capabilities: caps, founder: !isGateway });
      if (method === "GET" && path === "/crm/activity") {
        const eventId = url.searchParams.get("eventId");
        if (eventId) return send(res, 200, { activity: await ops.find(eventId.slice(0, 120)), store: "gateway-test" });
        return send(res, 200, { activities: await ops.list(), store: "gateway-test" });
      }
      if (method === "GET") return send(res, 404, { error: "Not found" });

      // Every write: the caller's own page token (the gate hands the gateway principal its token only after verifying the assertion).
      if (!pageTokenMatches(principal, req.headers["x-claude-os-token"], options.internalToken())) return send(res, 403, { error: "Refresh this page and try again." });

      if (method === "POST" && path === "/crm/activity") {
        // Only Dot adds through this route, and only while it holds crm.write (the third check; the gate made the second).
        if (!isGateway) return send(res, 403, { error: "This route records the gateway collaborator's activities. Founders add activities in the CRM itself." });
        if (!caps.includes("crm.write")) return send(res, 403, { error: "That needs the crm.write capability." });
        if (!String(req.headers["content-type"] ?? "").includes("application/json")) return send(res, 415, { error: "JSON required" });
        const parsed = parseActivity(await readBody(req));
        if ("error" in parsed) return send(res, 400, { error: parsed.error });
        const session = String(principal.sessionId ?? "").replace(/^gw:/, "");
        const receipt = await ops.add({ ...parsed, by: { agent: String(principal.personId), session, ...(principal.delegatedBy ? { delegatedBy: principal.delegatedBy } : {}) } });
        return send(res, 200, receipt, { [RECORD_IDS_HEADER]: receipt.activityId });
      }
      const m = /^\/crm\/activity\/(gwact_[a-f0-9]{16}|[A-Za-z0-9:_-]{1,80})$/.exec(path);
      if (method === "DELETE" && m) {
        if (isGateway && !caps.includes("crm.write")) return send(res, 403, { error: "That needs the crm.write capability." });
        const removed = await ops.remove(m[1]);
        return send(res, removed ? 200 : 404, removed ? { ok: true, removed: m[1] } : { error: "No such activity." }, removed ? { [RECORD_IDS_HEADER]: m[1] } : {});
      }
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      return send(res, status ?? (error instanceof SyntaxError ? 400 : 500), { error: status === 413 ? "That request is too large." : error instanceof SyntaxError ? "That is not valid JSON." : "Something went wrong." });
    }
  };
}

/** The Vite plugin (after the identity gate). */
/**
 * The release desk for this hub, when the owner switched releases through the gateway on (MU_GATEWAY_RELEASES=1, plus
 * MU_RELEASE_RECEIPTS_DIR where the release script writes its receipts). The owner answers a release approval with his
 * Telegram code ("approve XXXX-XXXX"): that reply is routed here (action "deploy" is otherwise never asked: coding refuses
 * deploys outright), decided by the approvals service, and the desk then launches the release script, detached.
 */
export function liveReleaseDesk(root: string, env: Record<string, string | undefined> = process.env): ReleaseDesk | null {
  const receiptsDir = (env.MU_RELEASE_RECEIPTS_DIR ?? "").trim();
  if (env.MU_GATEWAY_RELEASES !== "1" || !receiptsDir) return null;
  const approvals = () => {
    try {
      return jobsRuntime(root).approvals as unknown as ReleaseApprovals;
    } catch {
      return null;
    }
  };
  const desk = createReleaseDesk({
    dir: gatewayDir(root, env),
    repo: root,
    enabled: () => true,
    approvals,
    argsDigest,
    runner: wmiReleaseRunner({ receiptsDir, script: join(root, "deploy", "windows", "release-ryzen.ps1") }),
    receipts: () => releaseReceipts(env).receipts,
    notifyOwner: (text) => personNotifier(root)("usman", text),
  });
  registerTelegramCodeHandler(releaseCodeHandler(desk, approvals));
  try {
    jobsRuntime(root).approvals.subscribe(() => void desk.reconcile().catch(() => undefined));
  } catch {
    /* a quiet copy: no approvals to follow */
  }
  return desk;
}

export function dotGatewayHubPlugin(options: { root: string; internalToken: () => string; operate?: GatewayRoutesOptions["operate"] }): Plugin {
  return {
    name: "agentic-os-dot-gateway",
    configureServer(server) {
      const desk = liveReleaseDesk(options.root);
      if (desk) provideGatewayServices(options.root, { release: desk });
      const handle = createGatewayRoutes(options);
      server.middlewares.use("/__gateway", (req, res) => void handle(req, res));
    },
  };
}

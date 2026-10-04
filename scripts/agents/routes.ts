import type { IncomingMessage, ServerResponse } from "node:http";
import { publicView } from "../approvals/principal";
import { SERVER_WORK_NEEDS_SESSION, serverWorkAllowed } from "../identity/operator-sites";
import { isAtHub, isBrowserPrincipal, isHumanSession, type Principal } from "../identity/principal";
import { ConversationsUnreadable } from "../conversations";
import { BotsFileUnreadable } from "./store";
import type { AgentsService } from "./service";
import { BOT_ID } from "./types";

/**
 * /__agents: the Agents workspace API (docs/programme-20261001/AGENTS-WORKSPACE-PLAN.md).
 *
 *   GET   /skills                       { skills: [{ name, description? }] }: the catalogue of abilities (read-only; a bot's own are on its `skills`/`abilities`)
 *   GET   /bots                         { bots: (Bot & { readiness })[] }
 *   GET   /bots/:id                     the bot + readiness + conversationId (+ conversationKey); the conversation ids only for a confirmed person (see Identity)
 *   PATCH /bots/:id                     { rev, ...fields } -> the updated bot with readiness; 400 per field, 404, 409 { error, current } on a stale rev (nothing written)
 *   GET   /bots/:id/tasks?limit&before&beforeId  { tasks, before, beforeId }: pass both back for an exact next page; computer jobs and coding jobs, one list, newest first
 *   GET   /bots/:id/files               { files }: saved results of the bot's computer and its coding jobs' outputs
 *   GET   /bots/:id/thread?after        { conversationId, conversationKey, entries, last }: this person's conversation with the bot
 *   POST  /bots                         { name, purpose, id?, instructions?, computer?, coding?, modelPreference?, memory? } -> 201 the new bot; 400 per field,
 *                                       409 { code: "id-taken" | "name-taken" }. Never creates a computer; several bots may share one
 *   POST  /bots/:id/duplicate           {} -> 201 "<name> copy": configuration only (no credentials, sessions, approvals, routine links, conversations, tasks, results)
 *   POST  /bots/:id/archive             { rev, archived, afterCurrentWork? } -> the bot; 409 stale rev { current }; 422 { code: "has-running-work", work } unless
 *                                       afterCurrentWork, 422 "last-active" for the only active bot. Hides the bot and refuses new requests; deletes nothing
 *   (GET /bots lists every bot with a `lifecycle` of active / archiving / archived; an archived bot's reads, tasks, files and thread stay open)
 *
 * Conversations (the thread, and the ensureThread write behind conversationId) need actor "human" (a confirmed session) or the owner at the hub; a bare
 * Tailscale login gets 403 on /thread and a bot with no conversationId on /bots/:id.
 *
 * Identity (scripts/identity/routes.ts classifies the mount as shared: any verified founder reads). Who is asking is the gate's verified
 * principal, never a body field, and the conversation is always THAT person's: there is no way to name another person's. PATCH changes what
 * the hub's bots do, so beyond the caller's own page token it is server-side work: on a headless server (MU_HUB_ROLE=server) it needs a
 * confirmed human founder session (a pending session, a bare Tailscale login or a program is refused), or the owner at the hub itself.
 * Changing, creating, duplicating and archiving a bot are all held to that rule in EVERY role, not only the server's: a confirmed human session or the owner at the hub.
 * A bare Tailscale login (no confirmed session) is refused, a gateway principal (Telegram, a program) is not a browser principal and gets 401, and the
 * person who did it is recorded on the bot.
 */

export type AgentsRoutesOptions = {
  service: AgentsService;
  /** The gate's verified principal for this request (scripts/identity/gate requestPrincipal), or null. */
  principal: (req: IncomingMessage) => Principal | null;
  /** The caller's OWN page token for a write (scripts/identity/gate pageTokenMatches). */
  tokenOk: (req: IncomingMessage, principal: Principal) => boolean;
  /** The hub role (scripts/cloud/hub-role hubRole). */
  role: () => string;
};

const LIMIT = 32 * 1024;
const MANAGE_NEEDS_SESSION = "Changing, making, copying or archiving a bot needs a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC.";
const THREAD_NEEDS_SESSION = "Conversations need a confirmed sign-in: open Agentic OS in your paired browser, or use it at the hub PC.";
const loopback = (a: string | undefined) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(a ?? "");

export function createAgentsRoutes(options: AgentsRoutesOptions) {
  const { service } = options;

  function send(res: ServerResponse, status: number, value: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(publicView(value)));
  }

  async function body(req: IncomingMessage): Promise<unknown> {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw Object.assign(new Error("JSON required"), { status: 415 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMIT) throw Object.assign(new Error("Too large"), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      throw Object.assign(new Error("Bad JSON"), { status: 400 });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) {
    try {
      if (!loopback(req.socket?.remoteAddress)) return send(res, 403, { error: "Local access only" });
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/^\/__agents(?=\/|$)/, "").replace(/\/+$/, "") || "/";
      const method = req.method || "GET";
      const origin = req.headers.origin;
      if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return send(res, 403, { error: "Unknown origin" });
      if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "Cross-site request blocked" });
      const principal = options.principal(req);
      if (!principal || !isBrowserPrincipal(principal as never)) return send(res, 401, { error: "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address." });
      const person = principal.personId;
      // Conversations are a person's: a confirmed session (actor human) or the owner at the hub. A bare Tailscale login (actor process) reads bots, not threads.
      const mayConverse = isHumanSession(principal) || isAtHub(principal);

      if (path === "/skills") {
        if (method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, service.skills());
      }
      const m = /^\/bots(?:\/([^/]+)(?:\/(tasks|files|thread|duplicate|archive))?)?$/.exec(path);
      // Fail closed: an /__agents path nothing here serves is a 404, never handed on to whatever is mounted after this.
      if (!m) return send(res, 404, { error: "Not found" });
      const [, id, sub] = m;
      if (id !== undefined && !BOT_ID.test(id)) return send(res, 404, { error: "There is no such bot." });

      /** Making, copying and archiving bots: the caller's own page token, and a confirmed person (or the owner at the hub), in every role. */
      const manage = (): string | null => {
        if (!options.tokenOk(req, principal)) return "Refresh this page and try again.";
        if (!mayConverse) return MANAGE_NEEDS_SESSION;
        if (options.role() === "server" && !isAtHub(principal) && !serverWorkAllowed(principal, "server")) return SERVER_WORK_NEEDS_SESSION;
        return null;
      };

      if (!id) {
        if (method === "POST") {
          const refusal = manage();
          if (refusal) return send(res, 403, { error: refusal });
          const r = await service.create(await body(req), person);
          return send(res, r.status, r.body);
        }
        if (method !== "GET") return send(res, 405, { error: "GET or POST only" });
        return send(res, 200, { bots: await service.list() });
      }
      if (!sub) {
        if (method === "GET") {
          const bot = await service.get(id, person, { thread: mayConverse });
          return bot ? send(res, 200, bot) : send(res, 404, { error: `There is no bot called "${id}".` });
        }
        if (method === "PATCH") {
          // The same rule as making, copying and archiving, in every role: the caller's own page token, and a confirmed person or the owner at the hub.
          const refusal = manage();
          if (refusal) return send(res, 403, { error: refusal });
          const r = await service.patch(id, await body(req), person);
          return send(res, r.status, r.body);
        }
        return send(res, 405, { error: "GET or PATCH only" });
      }
      if (sub === "duplicate" || sub === "archive") {
        if (method !== "POST") return send(res, 405, { error: "POST only" });
        const refusal = manage();
        if (refusal) return send(res, 403, { error: refusal });
        const r = sub === "duplicate" ? await service.duplicate(id, person) : await service.archive(id, await body(req), person);
        return send(res, r.status, r.body);
      }
      if (method !== "GET") return send(res, 405, { error: "GET only" });
      if (sub === "tasks") {
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const before = url.searchParams.get("before");
        if (before !== null && !/^\d{1,15}$/.test(before)) return send(res, 400, { error: "before must be a time in milliseconds (the `before` of the previous page)." });
        const beforeId = url.searchParams.get("beforeId");
        if (beforeId !== null && !/^[\w:.-]{1,80}$/.test(beforeId)) return send(res, 400, { error: "beforeId must be the `beforeId` of the previous page." });
        const r = await service.tasks(id, person, { limit: Number.isFinite(limit) ? limit : 30, ...(before !== null ? { before: Number(before) } : {}), ...(before !== null && beforeId !== null ? { beforeId } : {}) });
        return r ? send(res, 200, r) : send(res, 404, { error: `There is no bot called "${id}".` });
      }
      if (sub === "files") {
        const r = await service.files(id, person);
        return r ? send(res, 200, r) : send(res, 404, { error: `There is no bot called "${id}".` });
      }
      if (!mayConverse) return send(res, 403, { error: THREAD_NEEDS_SESSION });
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const r = service.thread(id, person, after);
      if (r && "forbidden" in r) return send(res, 403, { error: "That conversation belongs to someone else." });
      return r ? send(res, 200, r) : send(res, 404, { error: `There is no bot called "${id}".` });
    } catch (error: any) {
      if (error instanceof BotsFileUnreadable || error instanceof ConversationsUnreadable) return send(res, 503, { error: error.message });
      if (!error?.status) console.error("[agents] unexpected error:", String(error?.stack ?? error).slice(0, 600));
      return send(res, error?.status ?? 500, { error: error?.status ? String(error.message).slice(0, 300) : "Something went wrong." });
    }
  }

  return { handle };
}

export type AgentsRoutes = ReturnType<typeof createAgentsRoutes>;

// /__memory — the memory connector's HTTP surface. The host route supplies the caller as a
// verified Principal (`principalFor`, built from the OS request context: loopback owner or a
// Tailscale-vouched person). This module never infers identity from Host headers or bodies;
// no principal → 401.
//
//   GET  /__memory/status                    sync status: last sync, pending, errors, settings, Hindsight state
//   GET  /__memory/links                     is Hermes pointed at this memory (booleans only); last agent tool call
//   GET  /__memory/buckets                   { writes: on|off, mode, buckets: [{ bucket, current, superseded }] }
//                                            (topic labels over the one shared pool, never access boundaries)
//   GET  /__memory/items?kind=&bucket=&q=&superseded=1     browse (vault notes, vault facts, Hindsight memories)
//   GET  /__memory/item/<id>                 { row, history, forget kinds }
//   GET  /__memory/usage                     usage receipts per Hindsight call
//   GET  /__memory/approvals                 pending forget approvals (server-held)
//   POST /__memory/recall        { query }
//   POST /__memory/remember      { text, title?, bucket?, note?, onConflict?, reaffirm? }          → Hindsight-only mem-…
//   POST /__memory/vault/save    { text?, from_memory?, title?, bucket?, note?, onConflict?, expected_hash?, reaffirm? }
//   POST /__memory/correct       { id, text, title?, expected_version_hash? }
//   POST /__memory/forget        { kind: unindex|memory|full, target, heading?, approval_id? }
//   POST /__memory/approvals/grant { approval_id }
//   POST /__memory/reindex       { target }
//   POST /__memory/sync          {}
//   POST /__memory/facts-used    { refs }
//   POST /__memory/voice         { utterance, context? }   typed; a forget's "yes" needs the page token
//   POST /__memory/held/release  { approval_id? }            a held mass removal, through the approval path
//   POST /__memory/mcp           JSON-RPC: the agents' memory (Claude Code, Hermes): remember, save_to_vault,
//                                recall, forget (asks only). scripts/memory/mcp.ts
//
// Jarvis's spoken turns reach the SAME api instance through createMemoryService().voiceTurn
// (scripts/free-voice.ts → scripts/memory/voice-turn.ts); a forget there needs a server-recorded
// spoken yes.
//
// There is no bulk-delete, clear-bank or "forget everything" route.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { providerKey } from "../provider-config";
import { crossOrigin } from "../identity/gate";
import { spokenConfirmations, type SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { createMemoryApi, type MemoryApi } from "./api";
import { MEMORY_ENV_NAMES, resolveMemorySettings } from "./settings";
import { BUCKETS, isBucket, isPrincipal, type Principal } from "./types";

/**
 * The OS identity (Stage B `resolvePrincipal`: { personId, via, displayName? }) as the memory
 * connector's Principal. One shared pool (V7/V8): the person is provenance ("saved by", activity),
 * never an access boundary, so nothing here narrows what they can read or change.
 */
export function memoryPrincipalFrom(
  os: { personId: string; via: string; displayName?: string; actor?: string; sessionId?: string; deviceId?: string } | null,
): Principal | null {
  if (!os || typeof os.personId !== "string" || !os.personId.trim()) return null;
  const id = os.personId.trim().toLowerCase();
  const name = os.displayName?.trim() || id.charAt(0).toUpperCase() + id.slice(1);
  const via: Principal["via"] = os.via === "loopback-owner" ? "local" : os.via === "telegram-owner" ? "telegram" : "tailnet";
  const actor: "human" | "process" | undefined = os.actor === "human" || os.actor === "process" ? os.actor : undefined;
  // B1's own principal rides along (server-side only) for the approval service: via, actor, session key, device.
  const b1 = {
    personId: id,
    via: os.via,
    ...(actor ? { actor } : {}),
    ...(typeof os.sessionId === "string" ? { sessionId: os.sessionId } : {}),
    ...(typeof os.deviceId === "string" ? { deviceId: os.deviceId } : {}),
  };
  return { id, name, via, ...(actor ? { actor } : {}), os: b1 };
}
import { handleMemoryUtterance, type VoiceContext } from "./voice-intents";
import { createMemoryVoiceTurn, type MemoryVoiceTurn } from "./voice-turn";
import { createNotesReader } from "../jarvis-skills/notes";
import { writerDecision } from "./writer";
import { createLinks, type MemoryLinks } from "./links";
import { handleMcp } from "./mcp";
import { createMemoryApprovals, MEMORY_ACTIONS, type CodeNotifier } from "../approvals/adapters/memory";
import { registerTelegramCodeHandler } from "../approvals/telegram-codes";
import { normalisePersonId } from "../devices/types";
import { personNotifier } from "../approvals/notify";
import { jobsRuntime } from "../jobs/runtime";
import { backgroundJobsDisabled } from "../preview-guard";
import { readPeople } from "../remote-access";
import { localApprovals } from "./approvals";

/**
 * The environment the memory settings read: the process env first, then (for the memory names only)
 * the OS's own config files via providerKey: <app>/.env.local and ~/.config/agentic-os.env. So the
 * lead can switch memory on with one line, `MU_MEMORY_WRITES=on`, in ~/.config/agentic-os.env.
 */
export function memoryEnv(root: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of MEMORY_ENV_NAMES) if (!(out[name] ?? "").trim()) {
    const v = providerKey(root, name, { env: {} });
    if (v) out[name] = v;
  }
  return out;
}

/**
 * A preview or quiet copy (ARGENTIC_PREVIEW=1 / AGENTIC_OS_NO_BACKGROUND=1) never takes the switch
 * from the shared config file, and never writes the real vault: with no MU_WIKI_ROOT of its own it is
 * read-only whatever MU_MEMORY_WRITES says. Its own state dir would otherwise give the real vault's
 * notes new ids and duplicate them in the shared pool.
 */
export function copyEnv(root: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const copy = env.ARGENTIC_PREVIEW === "1" || env.AGENTIC_OS_NO_BACKGROUND === "1";
  if (!copy) return memoryEnv(root, env);
  return (env.MU_WIKI_ROOT ?? "").trim() ? { ...env } : { ...env, MU_MEMORY_WRITES: "off" };
}

/**
 * ONE memory API per server: /__memory (the Memory page) and Jarvis's voice turn share it, so a
 * pending approval, the outbox and the sync state are the same wherever a request comes from.
 * Nothing is created until first use.
 */
/**
 * A program's one-time approval code goes to the REQUESTER's own Telegram DM (people.json), through
 * `hermes send` (the gateway's own credentials; this code never reads a token). Nobody else is messaged.
 */
export function telegramCodeNotifier(root: string): CodeNotifier {
  return personNotifier(root);
}

let unregisterTelegram: (() => void) | null = null;

export function createMemoryService(options: {
  root: string;
  env?: Record<string, string | undefined>;
  spoken?: SpokenConfirmationLedger;
  port?: number | null;
  /** Tests: the approvals store and the Telegram sender. */
  approvals?: NonNullable<Parameters<typeof createMemoryApi>[0]>["approvals"];
  notify?: CodeNotifier;
}) {
  let api: MemoryApi | null = null;
  let port: number | null = options.port ?? null;
  const env = () => options.env ?? copyEnv(options.root);
  /** The one switch, then the single-writer rule (writer.ts): a copy that isn't the writer is read-only. */
  const settings = () => {
    const e = env();
    const s = resolveMemorySettings(e, options.root);
    if (!s.writes) return s;
    const decision = writerDecision({
      env: e,
      appRoot: options.root,
      port,
      vaultRoot: s.vaultRoot,
      stateDir: s.stateDir,
      hindsightUrl: s.hindsight.url,
      explicit: !!(e.MU_WIKI_ROOT ?? "").trim() && !!(e.MEMORY_STATE_DIR ?? "").trim(),
    });
    return decision.ok ? s : { ...s, mode: "read" as const, writes: false, writer: decision.reason };
  };
  const spoken = options.spoken ?? spokenConfirmations;
  /**
   * Forget approvals (Track 6) on B2's durable service. The main AgenticOS uses the process-wide one (the
   * store /__approvals serves, recovered once at start) and sends a program's code to Telegram. A fully
   * synthetic copy (its own vault and store) keeps its own approvals.sqlite and messages nobody.
   */
  const approvals = (stateDir: string) => () => {
    if (options.approvals) return typeof options.approvals === "function" ? options.approvals() : options.approvals;
    const e = env();
    const synthetic = !!(e.MU_WIKI_ROOT ?? "").trim() && !!(e.MEMORY_STATE_DIR ?? "").trim();
    if (!synthetic && !backgroundJobsDisabled(e as NodeJS.ProcessEnv)) {
      const notify = options.notify ?? telegramCodeNotifier(options.root);
      return createMemoryApprovals(jobsRuntime(options.root).approvals, { notify });
    }
    return localApprovals(stateDir, { spoken, ...(options.notify ? { notify: options.notify } : {}) });
  };
  const lazy = () =>
    (api ??= (() => {
      const s = settings();
      return createMemoryApi({ settings: s, env: env(), approvals: approvals(s.stateDir), spoken });
    })());
  // "approve K7PQ-M4XZ" from the requester's own Telegram DM: the approval service matched the code (a miss
  // is counted there, telegram-codes.ts); this service answers memory approvals and runs the forget.
  unregisterTelegram?.(); // one memory service per server: the newest answers
  unregisterTelegram = registerTelegramCodeHandler({
    actions: MEMORY_ACTIONS,
    answer: (approvalId, sender, yes, code) => {
      const p = memoryPrincipalFrom(sender);
      return p ? lazy().approvals.answerTelegram(approvalId, p, yes, code) : "Only your own Telegram DM can answer this. Nothing was done.";
    },
  });
  // The Jarvis notes file is searched (read-only) beside the screened memory: "what did I tell you about X", "read my notes".
  const voiceTurn: MemoryVoiceTurn = createMemoryVoiceTurn({ api: lazy, spoken, notes: createNotesReader() });
  /** GET /__memory/links: whether Hermes points at this memory, and the last agent tool call. */
  const links = createLinks({ port: () => port });
  return {
    api: lazy,
    voiceTurn,
    links,
    env,
    /** The port this server listens on (the writer rule needs it); set before the first request. */
    bindPort: (p: number | null) => void (port = p),
  };
}
export type MemoryService = ReturnType<typeof createMemoryService>;

const MAX_BODY = 16 * 1024;
/** Routes an agent process at this PC may POST without a page token (see `agent` in the middleware). */
const AGENT_ROUTES = new Set(["/mcp", "/remember", "/vault/save", "/recall"]);

export type Req = Pick<IncomingMessage, "headers" | "method" | "url"> & { socket: { remoteAddress?: string | null } } & AsyncIterable<Buffer | string>;
export type PrincipalFor = (req: Req) => Principal | null;

/** CSRF defence only (it can refuse, never grant): cross-site fetches and non-JSON posts. */
/**
 * Cross-origin defence (review B1). The server-wide identity gate (scripts/identity/gate.ts) already
 * refuses these before any /__* route runs; this repeats the same rule here so /__memory is never
 * reachable from another origin even if it is mounted without the gate. Another localhost port is
 * "same-site" to a browser, so same-site is refused as well as cross-site, and an Origin must be
 * this request's own.
 */
function refusal(req: Req): { status: number; error: string } | null {
  // Own origin over http (this PC) or https (Tailscale Serve): refused only if it is neither.
  const plain = crossOrigin(req as never, false);
  if (plain && crossOrigin(req as never, true)) return { status: 403, error: plain };
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) return { status: 415, error: "Send JSON" };
  return null;
}

async function readJson(req: Req): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Too large for a memory request"), { status: 413 });
    chunks.push(b);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
  return parsed as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bucketOf = (v: unknown) => (isBucket(v) ? v : undefined);

export function memoryMiddleware(options: {
  api: () => MemoryApi;
  principalFor: PrincipalFor;
  /**
   * The caller's OWN page token check (Stage B1 pageTokenMatches). When given, EVERY POST must pass it
   * (like every other mutating /__* route), and it is what the approval steps rely on.
   */
  tokenOk?: (req: Req) => boolean;
  /** Legacy: the internal page token, checked only on the approval steps. */
  grantToken?: () => string | null;
  /** How the agents are wired to this memory (GET /links); absent in copies that don't serve it. */
  links?: MemoryLinks;
}) {
  return (req: Req, res: ServerResponse, next: () => void) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://memory.local");
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    let principal: Principal | null = null;
    try {
      principal = options.principalFor(req);
    } catch {
      principal = null;
    }
    if (!principal || !isPrincipal(principal)) {
      res.setHeader("WWW-Authenticate", 'AgenticOS realm="memory"');
      return json(401, { error: "Sign in to AgenticOS (this PC or Tailscale) to use memory." });
    }
    const refused = refusal(req);
    if (refused) return json(refused.status, { error: refused.error });
    const who = principal;
    const expected = options.grantToken?.();
    const pageOk = options.tokenOk ? options.tokenOk(req) : options.grantToken ? !!expected && req.headers["x-claude-os-token"] === expected : true;
    // Agents at this PC (Claude Code, Hermes, the hindsight-ask skill's curl) have no page token: a
    // PROCESS caller at this PC with none of a browser's markers (no Origin, no Sec-Fetch-*, no session
    // cookie) may use the agent routes only: save, save to the vault, recall and the MCP endpoint.
    // Forget, correct, grant and release stay with a person on the Memory page (REVIEW-STAGE-D B3).
    const agent =
      who.actor === "process" &&
      who.via === "local" &&
      req.headers.origin === undefined &&
      req.headers["sec-fetch-site"] === undefined &&
      req.headers["sec-fetch-mode"] === undefined &&
      AGENT_ROUTES.has(route);
    if (method === "POST" && options.tokenOk && !pageOk && !agent) return json(403, { error: "Refresh this page and try again." });

    const run = async () => {
      const api = options.api();
      const q = url.searchParams;
      if (method === "GET") {
        // MCP over streamable HTTP: 405 on GET means "no server-sent stream here" (review S3).
        if (route === "/mcp") {
          res.setHeader("Allow", "POST");
          return json(405, { error: "POST JSON-RPC to this endpoint" });
        }
        if (route === "/status")
          return json(200, { principal: { name: who.name, via: who.via }, ...api.status(), pending_approvals: api.approvals.pending().length, code_lockouts: api.approvals.lockouts() });
        if (route === "/items") {
          // An unknown kind or bucket is a mistake, not "no filter" (Audit F5 P2-3).
          const kind = q.get("kind"), bucket = q.get("bucket");
          if (kind && !(["note", "fact", "memory"] as string[]).includes(kind)) return json(400, { error: "kind must be note, fact or memory." });
          if (bucket && !isBucket(bucket)) return json(400, { error: `bucket must be one of ${BUCKETS.join(", ")}.` });
        }
        if (route === "/items")
          return json(200, {
            items: api.list({
              kind: (["note", "fact", "memory"] as const).find((k) => k === q.get("kind")),
              bucket: bucketOf(q.get("bucket")),
              q: q.get("q") ?? undefined,
              includeSuperseded: q.get("superseded") === "1",
            }),
          });
        if (route.startsWith("/item/")) {
          const r = api.item(decodeURIComponent(route.slice("/item/".length)));
          return r ? json(200, r) : json(404, { error: "Not found" });
        }
        if (route === "/usage") return json(200, api.usage());
        if (route === "/buckets")
          return json(200, {
            writes: api.settings.writes ? "on" : "off",
            mode: api.settings.mode,
            buckets: BUCKETS.map((bucket) => {
              const rows = api.list({ bucket, includeSuperseded: true });
              return { bucket, current: rows.filter((r) => r.status === "current").length, superseded: rows.filter((r) => r.status === "superseded").length };
            }),
          });
        if (route === "/approvals") return json(200, { pending: api.approvals.pending() });
        if (route === "/links" && options.links) return json(200, options.links.view());
        return next();
      }
      if (method !== "POST") return json(405, { error: "GET or POST only" });
      if (route === "/mcp") {
        // Streamable-HTTP MCP with JSON responses only: no server-sent stream to open.
        if (method !== "POST") return json(405, { error: "POST JSON-RPC to this endpoint" });
        const rpc = await readJson(req);
        options.links?.recordRpc(rpc);
        const client = String(req.headers["user-agent"] ?? "an agent").replace(/[^A-Za-z0-9 ./_()-]/g, "").slice(0, 60) || "an agent";
        const out = await handleMcp(api, who, rpc, client);
        if (out === null) {
          res.statusCode = 202;
          return res.end();
        }
        return json(200, out);
      }
      const body = await readJson(req);
      const conflict = body.onConflict === "keep-both" ? ("keep-both" as const) : undefined;
      switch (route) {
        case "/recall":
          return json(200, await api.recall(who, str(body.query) ?? ""));
        case "/remember": {
          const r = await api.remember(who, { text: str(body.text) ?? "", title: str(body.title), bucket: bucketOf(body.bucket), note: str(body.note), onConflict: conflict, reaffirm: body.reaffirm === true, channel: "ui" });
          return json(r.ok ? 200 : r.code === "writes-disabled" ? 403 : 422, r);
        }
        case "/vault/save": {
          const r = await api.saveToVault(who, {
            text: str(body.text),
            from_memory: str(body.from_memory),
            title: str(body.title),
            bucket: bucketOf(body.bucket),
            note: str(body.note),
            onConflict: conflict,
            expected_hash: str(body.expected_hash),
            reaffirm: body.reaffirm === true,
            channel: "ui",
          });
          return json(r.ok ? 200 : r.code === "writes-disabled" ? 403 : r.code === "vault-conflict" ? 409 : 422, r);
        }
        case "/correct": {
          const r = await api.correct(who, str(body.id) ?? "", { text: str(body.text) ?? "", title: str(body.title), expected_version_hash: str(body.expected_version_hash), channel: "ui" });
          return json(r.ok ? 200 : r.code === "writes-disabled" ? 403 : r.code === "vault-conflict" ? 409 : 422, r);
        }
        case "/forget": {
          const kind = body.kind === "unindex" || body.kind === "memory" || body.kind === "full" ? body.kind : ("" as never);
          // Only a server-issued approval id is read; any client "confirm"/"approved" flag is ignored.
          const r = await api.forget(who, { kind, target: str(body.target) ?? "", heading: str(body.heading), approval_id: str(body.approval_id) ?? null });
          return json(
            r.ok ? 200 : r.code === "approval-required" ? 202 : r.code === "writes-disabled" ? 403 : r.code === "approval-denied" ? 403 : r.code === "vault-conflict" ? 409 : 422,
            r,
          );
        }
        case "/approvals/card": {
          // The Memory page rendered this approval's card: a confirm nonce for THIS browser session only
          // (B1's session key, never the page token). A program's request has no confirm nonce at all.
          if (!pageOk) return json(403, { ok: false, reason: "Approve on the Memory page." });
          const card = api.approvals.card(str(body.approval_id) ?? "", who);
          if (!card) {
            const a = api.approvals.get(str(body.approval_id) ?? "");
            return json(403, {
              ok: false,
              approve_with: a?.approve_with ?? null,
              reason:
                a?.approve_with === "voice-or-telegram"
                  ? "A program asked for this, so a click can't approve it: say yes to Jarvis (\"approve the pending forget\"), or answer the code sent to your Telegram DM."
                  : "Confirming needs your own signed-in browser session on the Memory page (and a pending approval).",
            });
          }
          return json(200, { ok: true, card_nonce: card.cardNonce, expires_at: new Date(card.expiresAt).toISOString() });
        }
        case "/approvals/grant": {
          // The card's button: the page token, a verified browser session, and the card's single-use nonce.
          // On approval the server runs exactly the approved forget (or release) and returns its result.
          if (!pageOk) return json(403, { ok: false, reason: "Approve on the Memory page." });
          const r = await api.approvals.grant(str(body.approval_id) ?? "", who, "ui", { cardNonce: str(body.card_nonce) ?? "" });
          if (!r.ok) return json(["evidence-required", "unverified-session", "no-card", "unverified", "wrong-session", "wrong-approver"].includes(r.code) ? 403 : 422, r);
          return json(200, { ok: true, approval: { id: r.approval.id, summary: r.approval.summary, expires_at: r.approval.expires_at, granted_via: r.approval.granted_via }, result: r.result });
        }
        case "/approvals/reject": {
          if (!pageOk) return json(403, { ok: false, reason: "Refuse it on the Memory page." });
          const r = api.approvals.reject(str(body.approval_id) ?? "", who);
          return json(r.ok ? 200 : r.code === "unverified" ? 403 : 422, r);
        }
        case "/reindex": {
          const r = await api.reindex(who, str(body.target) ?? "");
          return json(r.ok ? 200 : r.code === "writes-disabled" ? 403 : 422, r);
        }
        case "/sync": {
          const r = await api.sync({ force: true, waitMs: 60_000 });
          return json(200, { ok: true, notes: r.notes, docs: r.docs, renames: r.renames, status: r.status });
        }
        case "/facts-used":
          return json(200, api.factsUsed(Array.isArray(body.refs) ? (body.refs as string[]) : []));
        case "/voice": {
          // Typed turns (the Memory page's box, tests). A forget's "yes" here is a typed UI confirm, so
          // it needs the page token like the approval button; Jarvis's spoken path is voiceTurn.
          return json(
            200,
            // A typed yes never approves a forget (Track 6): the card's button or a spoken yes does.
            await handleMemoryUtterance(api, who, str(body.utterance) ?? "", (body.context ?? {}) as VoiceContext, { channel: "ui" }),
          );
        }
        case "/held/release": {
          if (!pageOk) return json(403, { ok: false, reason: "Approve on the Memory page." });
          const r = await api.releaseHeld(who, { approval_id: str(body.approval_id) ?? null, digest: str(body.digest) ?? null });
          return json(r.ok ? 200 : r.code === "approval-required" ? 202 : r.code === "writes-disabled" ? 403 : 422, r);
        }
        default:
          return next();
      }
    };
    run().catch((error: { status?: number; message?: string }) => json(error?.status ?? 500, { error: error?.status ? error.message : "Memory is unavailable" }));
  };
}

/**
 * Vite plugin. `principalFor` is REQUIRED: the host passes its verified request identity.
 * Background sync (scan + drain every minute) starts unless AGENTIC_OS_NO_BACKGROUND=1.
 */
export function memoryPlugin(options: {
  root: string;
  principalFor: PrincipalFor;
  grantToken?: () => string | null;
  /** Stage B1: the caller's own page token, required on every POST. */
  tokenOk?: (req: Req) => boolean;
  env?: Record<string, string | undefined>;
  syncEveryMs?: number;
  /** The shared service (also given to the voice turn). Created here when absent. */
  service?: MemoryService;
}): Plugin {
  const service = options.service ?? createMemoryService({ root: options.root, env: options.env });
  const lazy = service.api;
  return {
    name: "agentic-os-memory-connector",
    configureServer(server) {
      service.bindPort(Number(server.config?.server?.port) || null);
      server.middlewares.use("/__memory", memoryMiddleware({ api: lazy, principalFor: options.principalFor, grantToken: options.grantToken, tokenOk: options.tokenOk, links: service.links }) as never);
      if ((options.env ?? process.env).AGENTIC_OS_NO_BACKGROUND === "1") return;
      const tick = () => {
        try {
          void lazy()
            .sync()
            .catch(() => undefined);
        } catch {
          /* vault missing or misconfigured: status shows it on the next request */
        }
      };
      const first = setTimeout(tick, 5_000);
      const every = setInterval(tick, options.syncEveryMs ?? 60_000);
      first.unref?.();
      every.unref?.();
      server.httpServer?.once("close", () => (clearTimeout(first), clearInterval(every)));
    },
  };
}

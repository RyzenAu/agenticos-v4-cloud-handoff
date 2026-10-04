/**
 * HUB routes the Dot gateway's collaborator OPERATES the system through, under /__gateway (mounted by hub-plugin.ts).
 *
 * Why its own routes, and not the founders': the founders' handlers (/__crm, /__memory, /__operator/coding writes,
 * /__computers, /__operator/screen/command) decide by "a founder", "a confirmed human session" or "at this PC", and the
 * gateway principal is none of those on purpose. Opening each of those checks to a third kind of caller would weaken them.
 * These routes instead call the SAME underlying services (the CRM's typed operations, the Jev-led command service, the job
 * store, the memory API, the coding orchestrator, the computers service) as Dot, with Dot recorded as who did it.
 *
 * Every request is checked three times: the gateway's allow-list, the hub gate's (hub.ts, same table), and HERE: the
 * principal must be the gateway collaborator and hold the route's capability on the assertion the gate verified for THIS
 * request, and a write must carry Dot's own page token. Founders never act through these routes.
 *
 *   GET  /capabilities                         the matrix as this hub sees it
 *   POST /crm/read   { name, input }           a CRM read operation      (crm.read)
 *   POST /crm/ops    { name, input }           a CRM write operation     (crm.write)
 *   GET  /files/roots | /files/list?root=&path= | /files/read?root=&path=      (files.read)
 *   POST /files/write { root, path, content, encoding?, expectedSha256? }      (files.write)
 *   POST /tasks      { text, eventId? }        a Jarvis task, through Jev      (tasks.run)
 *   GET  /jobs | /jobs/<id>                    Dot's own jobs                  (tasks.run)
 *   POST /jobs/<id>/stop                       Stop one of Dot's own jobs      (tasks.run)
 *   POST /memory/recall { query, limit? }      (memory.read)      POST /memory/remember { text, title? }   (memory.write)
 *   POST /coding/draft { utterance, requestId, draftId?, answer? }             (coding.start)
 *   POST /coding/jobs/<id>/start { specDigest } | /resume | /tests/rerun { commandId } | /cancel   (coding.start, Dot's own jobs)
 *   GET  /bots | /bots/<name> | /bots/<name>/screenshot                        (bots.operate)
 *   POST /bots/<name>/jobs { steps, title? } | /takeover | /lease/renew | /return | /input { executor, args }   (bots.operate)
 *   POST /bots/<name>/terminal | GET /bots/<name>/terminal/<id>/events | POST .../input { data } | .../close    (bots.terminal)
 *   GET  /diagnostics | /diagnostics/releases | /diagnostics/actions | /diagnostics/jobs[/<id>]   (ops.read)
 *   GET  /finance/summary?period= | /finance/transactions?period=&limit= | /finance/receivables | /finance/stripe   (finance.read)
 *   POST /finance/categorise { txId, category?, kind?, refundOf? }             (finance.write; business rows only)
 *   GET  /mail/mailboxes | /mail/threads?mailbox=&q= | /mail/thread?mailbox=&threadId=   (mail.read; authorised mailboxes only)
 *   POST /mail/drafts { mailbox, messageId, ref, body, title? }                 (mail.draft; a CRM draft-reply record)
 *   POST /release { sha, bundle? } | GET /release[/<id>] | POST /release/<id>/cancel   (release.request; the owner approves)
 *   GET  /diagnostics/logs?source=&tail= (ops.logs) | POST /ops/restart { service } | GET /ops/restart/<id> (ops.restart)   (debug-ops.ts)
 *
 * No secret, token, cookie, account path or absolute path is returned by any of them.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { publicView, type Principal as ApprovalPrincipal } from "../approvals/principal";
import { pageTokenMatches } from "../identity/gate";
import type { Principal } from "../identity/principal";
import { gatewayActorRef, gatewayHolds, isGatewayActor, type GatewayActor } from "./actor";
import { gatewayDir, RECORD_IDS_HEADER } from "./config";
import { GATEWAY_CRM_FOUNDER_ONLY, GATEWAY_CRM_FOUNDER_ONLY_WHY, GATEWAY_CRM_READS, GATEWAY_CRM_WRITES } from "./crm-policy";
import { createGatewayFiles, FileRefusal, type GatewayFiles } from "./files";
import { loadOpenInvoices } from "../finance/invoice-matching";
import { sharedManualStore, type ManualFinanceStore } from "../finance/manual-store";
import { parsePeriodParam } from "../finance/manual-summary";
import { createStripeSync } from "../finance/stripe";
import { createGatewayFinance, FinanceRefusal, type GatewayFinance } from "./finance";
import { parseCrmRef } from "../../src/lib/crm-ref";
import { handleManualFinance } from "../finance/manual-plugin";
import { readCrmFinanceLinks } from "../crm/finance";
import { businessOnlyLedger, jobEventsFor, jobShape, sharedComputers } from "./ui-adapters";
import { createGatewayMail, MailRefusal, type GatewayMail } from "./mail";
import { ReleaseRefusal, type ReleaseDesk } from "./release";
import { ControlFile, expiryView, listIdentities } from "./store";
import { gatewayServices } from "./hub-services";
import { CAPABILITIES, CAPABILITY_SUMMARY, type Capability } from "./policy";
import { isKilled } from "./store";
import { createDebugOps, DebugRefusal, type DebugOptions } from "./debug-ops";
import { conversationStore, jarvisThreadId } from "../conversations";

// ── the seams (each has a live default; tests pass their own) ──────────────────────────────────────────────────────

type CrmReceipt = { ok: boolean; href?: string; text: string; data?: unknown; code?: string; fieldErrors?: Record<string, string> };
type CrmOps = { run(name: string, input: unknown, principal: never): CrmReceipt };
type JobLike = { id: string; kind: string; state: string; title: string; principal?: { personId?: string; via?: string }; [k: string]: unknown };
type JobsLike = { get(id: string): JobLike | null; list(filter: { personId?: string; limit?: number; state?: string; kind?: string }): unknown[]; cancel(id: string): Promise<{ ok: boolean; state: string | null }>; readOnly?: boolean };
type CommandEvent = { type: string; jobId?: string | null; [k: string]: unknown };
type CommandsLike = {
  run(input: { principal: never; body: { utterance: string; source: "typed"; eventId?: string } }, listener: (e: CommandEvent) => void): Promise<CommandEvent>;
  cancel(jobId: string, principal: never): Promise<{ ok: boolean; state: string | null; outcome?: string }>;
  /** Saves a typed request or its reply into the caller's OWN default Jarvis thread (scripts/jarvis-command/threads.ts); keyed, so a repeat writes nothing. */
  threadSay?(principal: never, input: { requestId: string; part: "user" | "reply" | "note"; role: "user" | "assistant"; text: string }): string | null;
};
/** Dot's own Jarvis thread as the /jarvis page reads it (scripts/conversations.ts `get`: messages with the job entries merged in). */
type JarvisThreadReader = { get(id: string): { id: string; title?: string; updatedAt?: string; messages?: Array<{ role: string; text: string; via?: string }> } | null };
type MemoryLike = {
  recall(p: never, query: string, opts?: { limit?: number }): Promise<{ ok: true; query: string; facts: Array<{ id: string; kind: string; title: string; text: string; date: string; origin: unknown; actor: string | null; source: { kind: string; path?: string; id?: string }; score: number }>; spoken: string; hindsight: unknown; off?: string; index_built?: boolean }>;
  remember(p: never, input: { text: string; title?: string; channel?: never; note?: string }): Promise<{ ok: boolean; message: string; code?: string; duplicate?: boolean; memory?: { id: string }; destination?: unknown }>;
  item?(id: string): { row: { bucket: string } } | null;
};
type CodingLike = {
  readOnly?: boolean;
  store: { getJob(id: string): { id: string; state: string; spec: { requestedBy: { personId: string } }; [k: string]: unknown } | null };
  orch: {
    confirmAndStart(jobId: string, by: never, via: "typed", digest: never): unknown;
    resume(jobId: string, options: { by: never }): unknown;
    rerunTest(jobId: string, commandId: never): Promise<unknown>;
    cancel(jobId: string): unknown;
  };
  registry(): { repos: Array<{ id: string; allowedPeople?: string[] }> };
};
type CodingRoute = (input: { method: string; path: string; url: URL; body: unknown; principal: never }, rt: never) => Promise<{ status: number; body?: unknown } | null>;
type ComputersLike = {
  list(): Array<Record<string, unknown>>;
  view(name: string): Record<string, unknown>;
  startJob(input: { computer: string; by: never; principal: never; agent?: string; title?: string; steps: unknown }): Promise<{ ok: true; jobId: string } | { ok: false; reason: string; status: number }>;
  cancelJob(jobId: string): Promise<unknown>;
  takeover(name: string, who: never): { state: unknown; view: Record<string, unknown> };
  viewerHeartbeat(name: string, who: never): { ok: boolean; view: Record<string, unknown> };
  returnToAgent(name: string, who: never): { resumed: unknown; view: Record<string, unknown> };
  input(name: string, who: never, event: { executor: string; args: Record<string, unknown> }): Promise<{ ok: true; result: unknown } | { ok: false; status: number; reason: string }>;
  snapshot(name: string): Promise<{ mime: string; data: Uint8Array } | null>;
  terminals: {
    start(computer: string, who: never, size?: { cols?: number; rows?: number }): Promise<Record<string, unknown>>;
    input(computer: string, id: string, who: never, data: string): { ok: true } | { ok: false; status: number; reason: string };
    events(computer: string, id: string, who: never, after: number, waitMs?: number): Promise<Record<string, unknown> & { ok: boolean; status?: number; reason?: string }>;
    close(computer: string, id: string, who: never): { ok: true } | { ok: false; status: number; reason: string };
  };
};

export type GatewayOpsOptions = {
  root: string;
  internalToken: () => string;
  dir?: string;
  env?: () => Record<string, string | undefined>;
  /** A quiet or preview copy: no writes of any kind (the same switch /__crm and the job stores honour). */
  readOnly?: () => boolean;
  crm?: () => CrmOps | Promise<CrmOps>;
  files?: GatewayFiles;
  jobs?: () => JobsLike | Promise<JobsLike>;
  commands?: () => CommandsLike | undefined;
  memory?: () => MemoryLike | undefined;
  coding?: () => Promise<{ rt: CodingLike; route: CodingRoute; verified(p: ApprovalPrincipal): unknown; isRefusal(e: unknown): e is { message: string; status: number } }>;
  computers?: () => ComputersLike | undefined;
  health?: () => Promise<unknown>;
  version?: () => Promise<{ version: string; gitSha: string; dirty: boolean; buildTime: string }>;
  /** How long POST /tasks waits for the command to finish before answering 202 with the job id. */
  taskWaitMs?: number;
  /** Business finance (scripts/gateway/finance.ts). Null: not available on this hub. */
  finance?: () => GatewayFinance | null;
  /** The manual ledger the Finance page's adapter reads (business rows only); defaults to the hub's shared ledger. */
  ledger?: () => ManualFinanceStore;
  /** Where Dot's own Jarvis thread is read from; defaults to the hub's conversation store. */
  jarvisThreads?: () => JarvisThreadReader;
  /** Authorised mailboxes (scripts/gateway/mail.ts). */
  mail?: () => GatewayMail | null;
  /** The release workflow (scripts/gateway/release.ts). Null: not available. */
  release?: () => ReleaseDesk | null;
  /** r12 debugging (scripts/gateway/debug-ops.ts): log reading and restarts. Tests pass their own runner and exit. */
  debug?: Partial<Omit<DebugOptions, "dir" | "env">>;
};

// ── the hub's own log of what Dot did (append-only, closed field list, no bodies) ─────────────────────────────────

export type HubAction = { at: string; action: string; capability: string; person: "dot"; session: string; delegatedBy?: string; target?: string; status: number; outcome: "done" | "refused" | "failed"; detail?: string };
const ACTION_FIELDS: ReadonlyArray<keyof HubAction> = ["at", "action", "capability", "person", "session", "delegatedBy", "target", "status", "outcome", "detail"];
const cleanText = (value: string, max: number) => value.replace(/[^\w .,:@/*()[\]#-]/g, "?").slice(0, max);

export class HubActionLog {
  constructor(readonly dir: string) {}
  fileFor(at: number) {
    return join(this.dir, `hub-actions-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
  }
  write(input: Omit<HubAction, "at" | "person">) {
    const at = Date.now();
    const entry: Record<string, unknown> = { at: new Date(at).toISOString(), person: "dot" };
    for (const key of ACTION_FIELDS) {
      const v = (input as Record<string, unknown>)[key];
      if (v === undefined || key === "at" || key === "person") continue;
      entry[key] = typeof v === "string" ? cleanText(v, 200) : v;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.fileFor(at), JSON.stringify(entry) + "\n", { flag: "a" });
    } catch (error) {
      console.error(`[gateway] hub action log write failed: ${(error as Error).name}`);
    }
  }
  tail(limit: number): HubAction[] {
    const out: HubAction[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => /^hub-actions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().slice(-7);
    } catch {
      return out;
    }
    for (const name of names)
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as HubAction);
        } catch {
          /* a torn last line */
        }
      }
    return out.slice(-limit);
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Memory buckets Dot's recall may return. Personal, deen and finance facts are the founders' own and are dropped. */
export const MEMORY_BUCKETS_FOR_GATEWAY: readonly string[] = ["business", "research", "general"];
const MAX_BODY = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_NAME = /^[a-z0-9-]{1,32}$/;
const TERMINAL_ID = /^[a-z0-9]{6,40}$/;

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (body: Record<string, unknown>, allowed: string[]) => Object.keys(body).every((k) => allowed.includes(k));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw new Refusal(415, "JSON required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Refusal(413, "That request is too large.");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Refusal(400, "That is not valid JSON.");
  }
  if (!plainObject(body)) throw new Refusal(400, "Send a JSON object.");
  return body;
}

/** A bot computer as Dot sees it: state and who holds it. No host, adapter or address detail. */
function botView(v: Record<string, unknown>, session: string) {
  const c = (v.controller ?? {}) as Record<string, unknown>;
  const screen = (v.screen ?? {}) as Record<string, unknown>;
  return {
    name: v.name,
    label: v.label,
    shared: true,
    state: v.state,
    usable: v.usable === true,
    desktop: v.desktop === true,
    browser: v.browser === true,
    capabilities: Array.isArray(v.capabilities) ? v.capabilities : null,
    controller: { kind: c.kind ?? null, who: c.who ?? null, jobId: c.jobId ?? null, expiresAt: c.expiresAt ?? null },
    heldByYou: c.kind === "person" && c.who === "dot" && !!session,
    assigned: v.assigned ?? null,
    paused: v.paused ?? null,
    lastJob: v.lastJob ?? null,
    screen: { state: screen.state ?? null, detail: typeof screen.detail === "string" ? screen.detail : undefined },
    watch: { screenshot: (v.viewer as { snapshot?: boolean } | undefined)?.snapshot === true, liveViewer: false },
  };
}

// ── the routes ────────────────────────────────────────────────────────────────────────────────────────────────────

export function createGatewayOps(options: GatewayOpsOptions) {
  const env = options.env ?? (() => process.env as Record<string, string | undefined>);
  const dir = options.dir ?? gatewayDir(options.root, env());
  const files = options.files ?? createGatewayFiles({ root: options.root, env: env() });
  const actions = new HubActionLog(dir);
  const readOnly = options.readOnly ?? (() => env().AGENTIC_OS_NO_BACKGROUND === "1");
  const crm = options.crm ?? (async () => (await import("../crm/runtime")).crmRuntime(options.root).operations as unknown as CrmOps);
  const jobs = options.jobs ?? (async () => (await import("../jobs/runtime")).jobsRuntime(options.root).jobs as unknown as JobsLike);
  const commands = options.commands ?? (() => gatewayServices(options.root).commands as unknown as CommandsLike | undefined);
  /** Stop one of Dot's own jobs: a bot job through the computers service (it waits for the run to settle), a command through its own service. */
  const stopOwnJob = async (store: JobsLike, job: JobLike, actor: never): Promise<{ ok: boolean; state: string | null }> => {
    const bots = job.kind === "control" ? computers() : undefined;
    return bots ? ((await bots.cancelJob(job.id)) as { ok: boolean; state: string | null }) : job.kind === "command" && commands() ? await commands()!.cancel(job.id, actor) : await store.cancel(job.id);
  };
  const computers = options.computers ?? (() => gatewayServices(options.root).computers as unknown as ComputersLike | undefined);
  const memory = options.memory ?? (() => undefined);
  const coding =
    options.coding ??
    (async () => {
      const [plugin, routes, orch] = await Promise.all([import("../coding/plugin"), import("../coding/routes"), import("../coding/orchestrator")]);
      const rt = await plugin.codingRuntime(options.root);
      return {
        rt: rt as unknown as CodingLike,
        route: routes.codingRoute as unknown as CodingRoute,
        verified: (p: ApprovalPrincipal) => orch.verifiedFromApprovalPrincipal(p),
        isRefusal: (e: unknown): e is { message: string; status: number } => e instanceof orch.OrchestratorError,
      };
    });

  /** Paths under /__gateway that this module answers (hub-plugin.ts asks before falling through to its own). */
  let stripeSync: ReturnType<typeof createStripeSync> | null = null;
  const finance =
    options.finance ??
    (() =>
      createGatewayFinance({
        store: () => sharedManualStore(options.root),
        invoices: () => loadOpenInvoices(options.root),
        // ONE Stripe reader for this process (it opens finance.sqlite lazily, once): no new database handle per request.
        stripe: () => (stripeSync ??= createStripeSync(options.root)),
        today: () => new Date().toISOString().slice(0, 10),
      }));
  const control = new ControlFile(dir);
  const mail = options.mail ?? (() => createGatewayMail({ archive: () => (gatewayServices(options.root).mail as never) ?? null, authorised: () => (control.read().mailboxes ?? []).map((m) => m.address) }));
  const release = options.release ?? (() => gatewayServices(options.root).release ?? null);
  const debug = createDebugOps({ ...options.debug, dir, env });

  /** Paths under /__gateway that this module answers (hub-plugin.ts asks before falling through to its own). */
  const mine = (path: string) => /^\/(?:capabilities|crm\/(?:read|ops)|files\/|finance\/|mail\/|release(?:\/|$)|ui\/|tasks$|jobs(?:\/|$)|memory\/|coding\/|bots(?:\/|$)|diagnostics(?:\/|$)|ops\/restart(?:\/|$))/.test(path);

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: { path: string; url: URL; principal: Principal }): Promise<void> {
    const { path, url } = ctx;
    /** The gateway collaborator (checked on the next lines; `ctx.principal` is the identity layer's founder-typed shape). */
    const principal = ctx.principal as unknown as GatewayActor;
    const method = (req.method || "GET").toUpperCase();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(JSON.stringify(publicView(body)));
    };
    // These routes ACT AS the gateway collaborator. A founder (or anything else) has its own routes and is refused here.
    if (!isGatewayActor(ctx.principal as unknown)) return send(403, { error: "These routes are the gateway collaborator's. Founders use the OS itself." });
    const session = String(principal.sessionId ?? "");
    const actor = principal as unknown as never;
    const who = { personId: "dot", session } as unknown as never;
    const write = method !== "GET" && method !== "HEAD";
    let action = "";
    let capability = "";
    let target: string | undefined;

    /** The third check: this request's verified assertion carries the capability. */
    const need = (cap: Capability, what: string) => {
      capability = cap;
      action = what;
      if (!gatewayHolds(principal, cap)) throw new Refusal(403, `That needs the ${cap} capability.`, { needs: cap });
    };
    const noWritesHere = () => {
      if (readOnly()) throw new Refusal(409, "This hub is a read-only copy, so nothing was changed.");
    };
    const done = (status: number, body: unknown, recordIds: Array<string | undefined | null> = []) => {
      const ids = recordIds.filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9:_-]{1,80}$/.test(s));
      if (write) actions.write({ action, capability, session: session.replace(/^gw:/, ""), ...(principal.delegatedBy ? { delegatedBy: principal.delegatedBy } : {}), ...(target ? { target } : {}), status, outcome: status < 400 ? "done" : "refused" });
      return send(status, body, write && ids.length ? { [RECORD_IDS_HEADER]: ids.join(",") } : {});
    };

    try {
      // Every write presents Dot's own page token (the gate hands it to a request only after verifying its assertion).
      if (write && !pageTokenMatches(ctx.principal, req.headers["x-claude-os-token"], options.internalToken())) throw new Refusal(403, "Refresh this page and try again.");
      if (isKilled(dir)) throw new Refusal(503, "The gateway is switched off.");

      // ── the capability matrix, live ─────────────────────────────────────────────────────────────────────────────
      if (method === "GET" && path === "/capabilities") return send(200, await matrix(ctx.principal));

      // ── CRM ─────────────────────────────────────────────────────────────────────────────────────────────────────
      if (method === "POST" && (path === "/crm/read" || path === "/crm/ops")) {
        const reading = path === "/crm/read";
        need(reading ? "crm.read" : "crm.write", reading ? "crm.read" : "crm.write");
        const body = await readJson(req);
        if (!onlyKeys(body, ["name", "input"]) || typeof body.name !== "string") throw new Refusal(400, "Send exactly { name, input }.");
        const name = body.name;
        action = name.slice(0, 60);
        const list = reading ? GATEWAY_CRM_READS : GATEWAY_CRM_WRITES;
        if (!list.includes(name)) {
          if (GATEWAY_CRM_FOUNDER_ONLY.includes(name)) throw new Refusal(403, `That CRM operation is a founder's (${GATEWAY_CRM_FOUNDER_ONLY_WHY[name] ?? "not open to the gateway"}).`, { ownerAction: true });
          const other = reading ? GATEWAY_CRM_WRITES : GATEWAY_CRM_READS;
          throw new Refusal(other.includes(name) ? 400 : 404, other.includes(name) ? `${name} is a ${reading ? "write: POST it to /__gateway/crm/ops" : "read: POST it to /__gateway/crm/read"}.` : "Unknown CRM operation.");
        }
        if (!reading) noWritesHere();
        let receipt: CrmReceipt;
        try {
          receipt = (await crm()).run(name, body.input ?? {}, actor);
        } catch (error) {
          // An un-upgraded CRM database (the owner runs the upgrade), or the store could not open.
          const code = (error as { code?: string })?.code;
          throw new Refusal(503, code === "needs-upgrade" ? "The CRM database on this hub needs the owner-run upgrade before it can be used." : "The CRM is not available on this hub right now.", { ownerAction: code === "needs-upgrade" });
        }
        const status = receipt.ok ? 200 : receipt.code === "validation" ? 422 : receipt.code === "unauthorised" || receipt.code === "restricted" ? 403 : receipt.code === "not-found" ? 404 : receipt.code === "conflict" || receipt.code === "version-conflict" || receipt.code === "idempotency-conflict" ? 409 : receipt.code === "unavailable" ? 503 : 400;
        const id = plainObject(receipt.data) && typeof receipt.data.id === "string" ? receipt.data.id : undefined;
        target = id;
        return done(status, receipt, [id]);
      }

      // ── files ───────────────────────────────────────────────────────────────────────────────────────────────────
      if (path.startsWith("/files/")) {
        try {
          if (method === "GET" && path === "/files/roots") {
            need("files.read", "files.roots");
            return send(200, files.roots());
          }
          if (method === "GET" && path === "/files/list") {
            need("files.read", "files.list");
            return send(200, files.list(url.searchParams.get("root"), url.searchParams.get("path") ?? ""));
          }
          if (method === "GET" && path === "/files/read") {
            need("files.read", "files.read");
            return send(200, files.read(url.searchParams.get("root"), url.searchParams.get("path")));
          }
          if (method === "POST" && path === "/files/write") {
            need("files.write", "files.write");
            noWritesHere();
            const body = await readJson(req);
            if (!onlyKeys(body, ["root", "path", "content", "encoding", "expectedSha256"])) throw new Refusal(400, "Send { root, path, content, encoding?, expectedSha256? }.");
            target = `${text(body.root, 24)}:${text(body.path, 160)}`;
            const written = files.write(body.root, body.path, { content: body.content, encoding: body.encoding, expectedSha256: body.expectedSha256 });
            return done(200, { ok: true, ...written }, [`file:${written.sha256.slice(0, 16)}`]);
          }
        } catch (error) {
          if (error instanceof FileRefusal) throw new Refusal(error.status, error.message);
          throw error;
        }
        throw new Refusal(404, "Not found.");
      }

      // ── Jarvis tasks, through the Jev-led command path ──────────────────────────────────────────────────────────
      if (method === "POST" && path === "/tasks") {
        need("tasks.run", "task.start");
        noWritesHere();
        const body = await readJson(req);
        if (!onlyKeys(body, ["text", "eventId"])) throw new Refusal(400, "Send { text, eventId? }.");
        const utterance = text(body.text, 600);
        if (!utterance) throw new Refusal(400, "Say what the task is: { text }.");
        const eventId = body.eventId === undefined ? undefined : text(body.eventId, 48);
        if (eventId !== undefined && !/^[A-Za-z0-9._-]{4,48}$/.test(eventId)) throw new Refusal(400, "eventId must be a stable id (letters, digits, . _ -; 4 to 48 characters).");
        const service = commands();
        if (!service) throw new Refusal(503, "The Jarvis command service is not running on this hub, so nothing was started.", { unsupported: true });
        // Dot's request, and later a plain answer, go into Dot's OWN Jarvis thread (never a founder's): /jarvis in Dot's browser reads it
        // back. Keyed by the request id, so a retried eventId writes nothing twice. A job's own lines are appended by the thread watcher.
        const requestId = eventId ?? `gw-${randomUUID()}`;
        // A thread write never decides the task: the strict typed store can refuse (a retried eventId with changed words, a full thread),
        // and the request still runs or is deduplicated by its eventId exactly as before.
        const say = (part: "user" | "reply", role: "user" | "assistant", words: string) => {
          try { service.threadSay?.(actor, { requestId, part, role, text: words }); } catch { /* not saved; the job record still has it */ }
        };
        say("user", "user", utterance);
        let jobId: string | null = null;
        const run = service.run({ principal: actor, body: { utterance, source: "typed", ...(eventId ? { eventId } : {}) } }, (e) => {
          if (typeof e.jobId === "string" && e.jobId) jobId = e.jobId;
        });
        // The reply is saved unless it is about real work the thread watcher follows: every command keeps its own "command" record (that is
        // the request, answered here), while a job it started (research, a bot, coding) gets its started/finished lines from the watcher.
        void run
          .then(async (d) => {
            const reply = d as CommandEvent & { said?: string };
            if (typeof reply.said !== "string" || !reply.said.trim()) return;
            const startedJob = (typeof reply.jobId === "string" && reply.jobId) || jobId;
            const job = startedJob ? (await jobs()).get(startedJob) : null;
            if (!job || job.kind === "command") say("reply", "assistant", reply.said);
          })
          .catch(() => undefined);
        // Answer when the command finishes, or after a short wait with the job id so Dot follows it at /__gateway/jobs/<id>.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const first = await Promise.race([run.then((d) => ({ d })), new Promise<{ d: null }>((r) => (timer = setTimeout(() => r({ d: null }), options.taskWaitMs ?? 20_000)))]).catch((error: Error) => {
          throw new Refusal(502, `The task did not start: ${cleanText(String(error?.message ?? "error"), 160)}`);
        });
        clearTimeout(timer);
        if (!first.d) {
          run.catch(() => undefined);
          target = jobId ?? undefined;
          return done(202, { ok: true, running: true, jobId, follow: jobId ? `/__gateway/jobs/${jobId}` : "/__gateway/jobs" }, [jobId]);
        }
        const d = first.d as CommandEvent & { ok?: boolean; said?: string; kind?: string; refused?: boolean; ask?: boolean; outcome?: string; navigate?: { path?: string } };
        jobId = typeof d.jobId === "string" && d.jobId ? d.jobId : jobId;
        target = jobId ?? undefined;
        return done(200, { ok: d.ok === true, running: false, jobId, said: d.said ?? "", kind: d.kind ?? null, ...(d.refused ? { refused: true } : {}), ...(d.ask ? { ask: true } : {}), ...(d.outcome ? { outcome: d.outcome } : {}), ...(d.navigate?.path ? { page: d.navigate.path } : {}), follow: jobId ? `/__gateway/jobs/${jobId}` : null }, [jobId]);
      }

      // ── Dot's own jobs ──────────────────────────────────────────────────────────────────────────────────────────
      if (path === "/jobs" && method === "GET") {
        need("tasks.run", "jobs.list");
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
        return send(200, { jobs: (await jobs()).list({ personId: "dot", limit }) });
      }
      let m = /^\/jobs\/([0-9a-f-]{36})(\/stop)?$/i.exec(path);
      if (m && UUID.test(m[1])) {
        const store = await jobs();
        const job = store.get(m[1]);
        // Someone else's job does not exist here: Dot reads and stops only what Dot started.
        if (!job || !isGatewayActor({ ...job.principal, actor: "process" })) throw new Refusal(404, "No such job of yours.");
        target = job.id;
        if (!m[2] && method === "GET") {
          need("tasks.run", "jobs.read");
          return send(200, { job });
        }
        if (m[2] && method === "POST") {
          need("tasks.run", "job.stop");
          noWritesHere();
          const result = await stopOwnJob(store, job, actor);
          return done(result.ok ? 202 : 409, { result, job: store.get(job.id) }, [job.id]);
        }
        throw new Refusal(405, "Method not allowed.");
      }

      // ── memory ──────────────────────────────────────────────────────────────────────────────────────────────────
      if (method === "POST" && (path === "/memory/recall" || path === "/memory/remember")) {
        const recalling = path === "/memory/recall";
        need(recalling ? "memory.read" : "memory.write", recalling ? "memory.recall" : "memory.remember");
        const api = memory();
        if (!api) throw new Refusal(503, "Shared memory is not running on this hub.", { unsupported: true });
        const body = await readJson(req);
        // The memory API's own caller: Dot, a program. Recorded on every memory it saves.
        const as = { id: "dot", name: "Dot", via: "system", actor: "process" } as unknown as never;
        if (recalling) {
          if (!onlyKeys(body, ["query", "limit"])) throw new Refusal(400, "Send { query, limit? }.");
          const query = text(body.query, 400);
          if (!query) throw new Refusal(400, "Say what to recall: { query }.");
          const r = await api.recall(as, query, { limit: Math.max(1, Math.min(20, Number(body.limit) || 8)) });
          // One shared pool holds the founders' personal, deen and finance facts too: Dot gets business, research and general only.
          let withheld = 0;
          const facts = r.facts.filter((f) => {
            let bucket: string | null = null;
            try {
              bucket = api.item?.(f.id)?.row.bucket ?? null;
            } catch {
              bucket = null;
            }
            const ok = bucket !== null && MEMORY_BUCKETS_FOR_GATEWAY.includes(bucket);
            if (!ok) withheld++;
            return ok;
          });
          return done(200, {
            ok: true,
            query: r.query,
            facts: facts.map((f) => ({ id: f.id, kind: f.kind, title: f.title, text: f.text, date: f.date, origin: f.origin, actor: f.actor, source: f.source.kind === "vault" ? { kind: "vault", note: f.source.path } : { kind: "memory", id: f.source.id }, score: f.score })),
            withheld,
            buckets: MEMORY_BUCKETS_FOR_GATEWAY,
            hindsight: r.hindsight,
            ...(r.off ? { off: r.off } : {}),
            ...(r.index_built === false ? { indexBuilt: false } : {}),
          });
        }
        if (!onlyKeys(body, ["text", "title"])) throw new Refusal(400, "Send { text, title? }.");
        noWritesHere();
        const fact = text(body.text, 4000);
        if (!fact) throw new Refusal(400, "Say what to remember: { text }.");
        const title = text(body.title, 90);
        const r = await api.remember(as, { text: fact, ...(title ? { title } : {}), channel: "agent" as never, note: `Saved by Dot through the gateway (${session.slice(0, 20)})` });
        target = r.memory?.id;
        // MU_MEMORY_WRITES off (or a hub that is not the memory writer): the API refuses and nothing is saved.
        return done(r.ok ? 200 : r.code === "writes-disabled" ? 409 : 422, r.ok ? { ok: true, id: r.memory?.id ?? null, duplicate: r.duplicate === true, message: r.message, destination: r.destination } : { ok: false, code: r.code ?? "refused", message: r.message }, [r.memory?.id]);
      }

      // ── coding jobs (Dot's own) ─────────────────────────────────────────────────────────────────────────────────
      if (path.startsWith("/coding/") && method === "POST") {
        need("coding.start", "coding");
        noWritesHere();
        const c = await coding().catch(() => {
          throw new Refusal(503, "The coding workspace is not available on this hub.", { unsupported: true });
        });
        if (c.rt.readOnly) throw new Refusal(409, "The coding workspace is read-only on this hub, so nothing was changed.");
        const body = await readJson(req);
        const by = c.verified(principal as unknown as ApprovalPrincipal) as never;
        try {
          if (path === "/coding/draft") {
            action = "coding.draft";
            if (!onlyKeys(body, ["utterance", "requestId", "draftId", "answer"])) throw new Refusal(400, "Send { utterance, requestId, draftId?, answer? }.");
            // The founders' own drafting step (shaper, validation, idempotency on requestId). A program never gets the Claude planner.
            const out = await c.route({ method: "POST", path: "/coding/shape", url, body: { ...body, channel: "typed" }, principal: actor }, c.rt as never);
            const result = (out?.body ?? {}) as { jobId?: string };
            target = result.jobId;
            return done(out?.status ?? 500, out?.body ?? { error: "The draft could not be made." }, [result.jobId]);
          }
          m = /^\/coding\/jobs\/([0-9a-f-]{36})\/(start|resume|tests\/rerun|cancel)$/i.exec(path);
          if (!m || !UUID.test(m[1])) throw new Refusal(404, "Not found.");
          const job = c.rt.store.getJob(m[1]);
          // Dot starts, resumes and stops its OWN coding jobs. A founder's job is not Dot's to drive.
          if (!job || job.spec.requestedBy.personId !== "dot") throw new Refusal(404, "No such coding job of yours.");
          target = job.id;
          action = `coding.${m[2].replace("/", ".")}`;
          let result: unknown;
          if (m[2] === "start") {
            if (!onlyKeys(body, ["specDigest"]) || typeof body.specDigest !== "string") throw new Refusal(400, "Send { specDigest } from the draft, so the plan that starts is the plan that was read.");
            result = c.rt.orch.confirmAndStart(job.id, by, "typed", body.specDigest.slice(0, 80) as never);
          } else if (m[2] === "resume") result = c.rt.orch.resume(job.id, { by });
          else if (m[2] === "tests/rerun") {
            const commandId = text(body.commandId, 80);
            if (!commandId) throw new Refusal(400, "Send { commandId }: one of the job's registered checks.");
            result = await c.rt.orch.rerunTest(job.id, commandId as never);
          } else result = c.rt.orch.cancel(job.id);
          return done(m[2] === "start" ? 202 : 200, { ok: true, job: c.rt.store.getJob(job.id) ?? result }, [job.id]);
        } catch (error) {
          if (error instanceof Refusal) throw error;
          if (c.isRefusal(error)) throw new Refusal(error.status, error.message);
          throw error;
        }
      }

      // ── shared bot computers ────────────────────────────────────────────────────────────────────────────────────
      if (path === "/bots" || path.startsWith("/bots/")) {
        const service = computers();
        if (path === "/bots" && method === "GET") {
          need("bots.operate", "bots.list");
          // The computers service only ever holds SHARED bot computers; a founder's PC and the hub's desktop are devices, not computers.
          const list = service ? service.list().filter((v) => v.kind === "cloud-computer" && v.owner === "shared") : [];
          return send(200, { bots: list.map((v) => botView(v, session)), ...(service ? (list.length ? {} : { note: "No shared bot computers exist on this hub." }) : { unsupported: true, note: "The computers service is not running on this hub." }) });
        }
        m = /^\/bots\/([a-z0-9-]{1,32})(?:\/(screenshot|jobs|takeover|lease\/renew|return|input|terminal(?:\/([a-z0-9]{6,40})\/(events|input|close))?))?$/.exec(path);
        if (!m || !BOT_NAME.test(m[1])) throw new Refusal(404, "Not found.");
        const [, name, sub, terminalId, terminalAction] = m;
        const terminal = !!sub && sub.startsWith("terminal");
        need(terminal ? "bots.terminal" : "bots.operate", `bots.${terminal ? `terminal${terminalAction ? `.${terminalAction}` : ".open"}` : (sub ?? "read").replace("/", ".")}`);
        if (!service) throw new Refusal(503, "The computers service is not running on this hub.", { unsupported: true });
        target = name;
        let view: Record<string, unknown>;
        try {
          view = service.view(name);
        } catch {
          throw new Refusal(404, `No shared bot computer called "${name}".`);
        }
        // Belt and braces: only a shared cloud computer is ever a "bot" here.
        if (view.kind !== "cloud-computer" || view.owner !== "shared") throw new Refusal(404, `No shared bot computer called "${name}".`);
        const guarded = async <T>(run: () => T | Promise<T>): Promise<T> => {
          try {
            return await run();
          } catch (error) {
            const status = (error as { status?: number })?.status;
            if (status && status >= 400 && status < 500) throw new Refusal(status, cleanText(String((error as Error).message), 240));
            throw error;
          }
        };
        if (!sub && method === "GET") return send(200, { bot: botView(view, session) });
        if (sub === "screenshot" && method === "GET") {
          const shot = await guarded(() => service.snapshot(name));
          if (!shot) throw new Refusal(409, `${name} has no picture right now (no screen or browser, or it is not running).`);
          return send(200, { mime: shot.mime, encoding: "base64", data: Buffer.from(shot.data).toString("base64"), takenAt: new Date().toISOString() });
        }
        if (method !== "POST") {
          if (terminal && terminalId && terminalAction === "events" && method === "GET") {
            if (!TERMINAL_ID.test(terminalId)) throw new Refusal(404, "Not found.");
            const r = await guarded(() => service.terminals.events(name, terminalId, who, Math.max(0, Number(url.searchParams.get("after")) || 0), Math.max(0, Math.min(20_000, Number(url.searchParams.get("wait")) || 0))));
            if (!r.ok) throw new Refusal(r.status ?? 409, String(r.reason ?? "The terminal is not available."));
            return send(200, r);
          }
          throw new Refusal(405, "Method not allowed.");
        }
        noWritesHere();
        const body = await readJson(req);
        if (sub === "jobs") {
          if (!onlyKeys(body, ["steps", "title"])) throw new Refusal(400, "Send { steps, title? }.");
          // The computers service validates the steps (typed executors and workflows only; send, pay, delete and publish are refused).
          const r = await guarded(() => service.startJob({ computer: name, by: "dot" as never, principal: gatewayActorRef() as never, agent: "dot", title: text(body.title, 120) || undefined, steps: body.steps }));
          if (!r.ok) throw new Refusal(r.status, r.reason);
          return done(202, { ok: true, jobId: r.jobId, follow: `/__gateway/jobs/${r.jobId}` }, [r.jobId]);
        }
        if (sub === "takeover") {
          const r = await guarded(() => service.takeover(name, who));
          return done(200, { ok: true, state: r.state, bot: botView(r.view, session) }, [name]);
        }
        if (sub === "lease/renew") {
          const r = await guarded(() => service.viewerHeartbeat(name, who));
          return done(r.ok ? 200 : 409, { ok: r.ok, bot: botView(r.view, session), ...(r.ok ? {} : { error: `You do not hold ${name}; take control first.` }) }, [name]);
        }
        if (sub === "return") {
          const r = await guarded(() => service.returnToAgent(name, who));
          return done(200, { ok: true, resumed: r.resumed, bot: botView(r.view, session) }, [name]);
        }
        if (sub === "input") {
          if (!onlyKeys(body, ["executor", "args"]) || typeof body.executor !== "string") throw new Refusal(400, "Send { executor, args }.");
          // Exactly what a founder holding the controls may send (scripts/computers/routes.ts HUMAN_INPUT): browser input, a page read, the computer's own files.
          const allowed = (await import("../computers/routes")).HUMAN_INPUT;
          const executor = text(body.executor, 64);
          if (!allowed.includes(executor)) throw new Refusal(400, `executor must be one of ${allowed.join(", ")}.`);
          const r = await guarded(() => service.input(name, who, { executor, args: plainObject(body.args) ? body.args : {} }));
          if (!r.ok) throw new Refusal(r.status, r.reason);
          return done(200, { ok: true, result: r.result }, [name]);
        }
        if (terminal) {
          if (!terminalId) {
            const r = await guarded(() => service.terminals.start(name, who, { cols: Number(body.cols) || undefined, rows: Number(body.rows) || undefined }));
            if (r.ok === false) throw new Refusal(Number(r.status) || 409, String(r.reason ?? "The terminal could not be opened."));
            return done(200, r, [name]);
          }
          if (!TERMINAL_ID.test(terminalId)) throw new Refusal(404, "Not found.");
          if (terminalAction === "input") {
            const data = typeof body.data === "string" ? body.data : "";
            if (!data || Buffer.byteLength(data) > 4096) throw new Refusal(400, "Send { data }: at most 4 KB a call.");
            const r = service.terminals.input(name, terminalId, who, data);
            if (!r.ok) throw new Refusal(r.status, r.reason);
            return done(200, { ok: true }, [name]);
          }
          if (terminalAction === "close") {
            const r = service.terminals.close(name, terminalId, who);
            if (!r.ok) throw new Refusal(r.status, r.reason);
            return done(200, { ok: true }, [name]);
          }
        }
        throw new Refusal(404, "Not found.");
      }

      // ── business finance ────────────────────────────────────────────────────────────────────────────────────────
      if (path.startsWith("/finance/")) {
        const period = () => parsePeriodParam(url.searchParams.get("period"));
        try {
          if (method === "GET" && path === "/finance/summary") {
            need("finance.read", "finance.summary");
            return send(200, financeOrThrow().summary(period()));
          }
          if (method === "GET" && path === "/finance/transactions") {
            need("finance.read", "finance.transactions");
            return send(200, financeOrThrow().transactions(period(), Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100))));
          }
          if (method === "GET" && path === "/finance/receivables") {
            need("finance.read", "finance.receivables");
            return send(200, financeOrThrow().receivables());
          }
          if (method === "GET" && path === "/finance/stripe") {
            need("finance.read", "finance.stripe");
            return send(200, financeOrThrow().stripe());
          }
          if (method === "POST" && path === "/finance/categorise") {
            need("finance.write", "finance.categorise");
            noWritesHere();
            const body = await readJson(req);
            if (!onlyKeys(body, ["txId", "category", "kind", "refundOf"])) throw new Refusal(400, "Send { txId, category?, kind?, refundOf? }. A row's scope (business or personal) is the founders' to set.");
            target = text(body.txId, 80);
            const row = financeOrThrow().categorise({ txId: body.txId, category: body.category, kind: body.kind, refundOf: body.refundOf });
            return done(200, { ok: true, row }, [`fin:${String(row.id).slice(0, 60)}`]);
          }
        } catch (error) {
          if (error instanceof FinanceRefusal) throw new Refusal(error.status, error.message);
          throw error;
        }
        throw new Refusal(404, "Not found.");
      }

      // ── authorised mailboxes ────────────────────────────────────────────────────────────────────────────────────
      if (path.startsWith("/mail/")) {
        const m = mail();
        if (!m) throw new Refusal(503, "Mail is not available on this hub.", { unsupported: true });
        try {
          if (method === "GET" && path === "/mail/mailboxes") {
            need("mail.read", "mail.mailboxes");
            return send(200, m.mailboxes());
          }
          if (method === "GET" && path === "/mail/threads") {
            need("mail.read", "mail.threads");
            return send(200, m.threads(url.searchParams.get("mailbox"), url.searchParams.get("q") ?? "", Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30))));
          }
          if (method === "GET" && path === "/mail/thread") {
            need("mail.read", "mail.thread");
            return send(200, m.thread(url.searchParams.get("mailbox"), url.searchParams.get("threadId")));
          }
          if (method === "POST" && path === "/mail/drafts") {
            need("mail.draft", "mail.draft");
            noWritesHere();
            const body = await readJson(req);
            if (!onlyKeys(body, ["mailbox", "messageId", "ref", "body", "title"])) throw new Refusal(400, "Send { mailbox, messageId, ref: { kind, id }, body, title? }.");
            const message = m.message(body.mailbox, body.messageId);
            const ref = plainObject(body.ref) ? body.ref : {};
            if (!["company", "deal", "contact", "project"].includes(String(ref.kind)) || typeof ref.id !== "string") throw new Refusal(400, "ref must name the CRM company, deal, contact or project the reply is about.");
            const draft = text(body.body, 10_000);
            if (!draft) throw new Refusal(400, "Write the reply: { body }.");
            const activity = m.draftActivity({ messageId: message.id, subject: message.subject, ref: { kind: String(ref.kind), id: ref.id }, body: draft, title: text(body.title, 300) || undefined });
            const receipt = (await crm()).run("crm.activity.add", activity, actor);
            const id = typeof (receipt as { activityId?: string }).activityId === "string" ? (receipt as { activityId?: string }).activityId : undefined;
            target = id;
            return done(receipt.ok ? 200 : receipt.code === "validation" ? 422 : receipt.code === "not-found" ? 404 : 403, { ...receipt, sent: false, note: "Saved as a reply draft in the CRM (communicationState drafted). Nothing was sent; a founder sends it." }, [id]);
          }
        } catch (error) {
          if (error instanceof MailRefusal) throw new Refusal(error.status, error.message);
          throw error;
        }
        throw new Refusal(404, "Not found.");
      }

      // ── the release workflow ────────────────────────────────────────────────────────────────────────────────────
      if (path === "/release" || path.startsWith("/release/")) {
        need("release.request", "release");
        const desk = release();
        if (!desk) throw new Refusal(503, "The release workflow is not available on this hub.", { unsupported: true });
        try {
          if (path === "/release" && method === "GET") return send(200, { releases: await desk.list() });
          if (path === "/release" && method === "POST") {
            action = "release.request";
            noWritesHere();
            const body = await readJson(req);
            if (!onlyKeys(body, ["sha", "bundle"])) throw new Refusal(400, "Send { sha, bundle? } (bundle: base64 of a git bundle holding the commit).");
            const record = await desk.request({ sha: body.sha, bundle: body.bundle, session: session.replace(/^gw:/, ""), identity: (ctx.principal as { gatewayIdentityId?: string }).gatewayIdentityId });
            target = record.id;
            return done(202, { ok: true, release: record, next: "The owner approves with his Telegram code or a spoken yes. Follow it at /__gateway/release/" + record.id }, [record.id]);
          }
          const rm = /^\/release\/(rel-[0-9a-zT]+-[0-9a-f]{6})(\/cancel)?$/.exec(path);
          if (rm && !rm[2] && method === "GET") {
            const record = await desk.get(rm[1]);
            if (!record) throw new Refusal(404, "No such release request.");
            return send(200, { release: record, log: desk.logTail(rm[1]) });
          }
          if (rm && rm[2] && method === "POST") {
            action = "release.cancel";
            target = rm[1];
            return done(200, { ok: true, release: await desk.cancel(rm[1]) }, [rm[1]]);
          }
        } catch (error) {
          if (error instanceof ReleaseRefusal) throw new Refusal(error.status, error.message, { code: error.code });
          throw error;
        }
        throw new Refusal(404, "Not found.");
      }

      // ── the OS pages' own requests, answered in their founder routes' shape for Dot (scripts/gateway/ui-adapters.ts) ──
      // ── /jarvis in Dot's browser: Dot's OWN thread and Stop (tasks.run). Sending is POST /tasks above. ─────────────
      if (path === "/ui/jarvis/thread" && method === "GET") {
        need("tasks.run", "ui.jarvis-thread");
        // One fixed id: Dot's default Jarvis thread. No id from the request is ever read, so no founder thread is reachable here.
        const id = jarvisThreadId("dot");
        const c = (options.jarvisThreads?.() ?? conversationStore(options.root)).get(id);
        const conversation = { id, title: "Jarvis", updatedAt: c?.updatedAt ?? new Date(0).toISOString(), messages: (c?.messages ?? []).slice(-200).map((x) => ({ role: x.role, text: x.text, ...(x.via ? { via: x.via } : {}) })) };
        // Both shapes the page reads: the thread head ({ conversationId, entries }) and the conversations list ({ conversations }).
        return send(200, { conversationId: id, entries: [], conversations: [conversation] });
      }
      if (path === "/ui/jarvis/stop" && method === "POST") {
        need("tasks.run", "ui.jarvis-stop");
        noWritesHere();
        const body = await readJson(req);
        const jobIdIn = typeof body.jobId === "string" ? body.jobId : "";
        if (!onlyKeys(body, ["jobId"]) || !UUID.test(jobIdIn)) throw new Refusal(400, "Send { jobId }.");
        const store = await jobs();
        const job = store.get(jobIdIn);
        // Only Dot's own job (the page's Stop reply shape: { outcome, state }).
        if (!job || !isGatewayActor({ ...job.principal, actor: "process" })) return send(404, { outcome: "no-job", state: null });
        target = job.id;
        const before = String((job as { state?: unknown }).state ?? "");
        if (["succeeded", "failed", "cancelled"].includes(before)) return done(409, { outcome: "already-ended", state: before }, [job.id]);
        const result = await stopOwnJob(store, job, actor);
        const state = (store.get(job.id) as { state?: string } | null)?.state ?? result.state ?? null;
        return done(result.ok ? 200 : 409, { outcome: state === "cancelled" ? "stopped" : "unconfirmed", state }, [job.id]);
      }

      if (path.startsWith("/ui/") && (method === "GET" || method === "HEAD")) {
        if (path === "/ui/crm/snapshot" || path === "/ui/crm/record") {
          need("crm.read", "ui.crm");
          const ops = await crm();
          if (path === "/ui/crm/snapshot") {
            const r = ops.run("crm.snapshot", {}, actor);
            return send(r.ok ? 200 : 503, r.ok ? r.data : { ok: false, error: r.text });
          }
          const ref = parseCrmRef(url.searchParams.get("ref") ?? "");
          if (!ref) throw new Refusal(400, "Choose a valid CRM record reference.");
          const r = ops.run("crm.record.get", { ref }, actor);
          return send(r.ok === false ? (r.code === "not-found" ? 404 : 400) : 200, r);
        }
        if (path === "/ui/crm/finance") {
          // A company's Stripe invoice links (the CRM company page's Finance panel): business finance, read through the CRM's
          // own snapshot under the gateway actor (so crm.read is checked by the CRM guard as well).
          need("finance.read", "ui.crm-finance");
          const companyId = url.searchParams.get("companyId") ?? "";
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(companyId)) throw new Refusal(400, "Choose a valid company ID.");
          const r = (await crm()).run("crm.snapshot", {}, actor);
          if (!r.ok) return send(r.code === "unauthorised" || r.code === "restricted" ? 403 : 503, { ok: false, error: r.text });
          const snap = r.data as { companies?: Array<{ id: string }>; documents?: Array<{ companyId?: string }> };
          if (!snap.companies?.some((c) => c.id === companyId)) return send(404, { ok: false, error: "Company not found." });
          return send(200, readCrmFinanceLinks(options.root, (snap.documents ?? []).filter((d) => d.companyId === companyId) as never));
        }
        const fm = /^\/ui\/finance\/(summary|status|transactions)$/.exec(path);
        if (fm) {
          need("finance.read", "ui.finance");
          const reply = handleManualFinance({ method: "GET", path: `/${fm[1]}`, query: url.searchParams, owner: "dot", tokenOk: true }, { store: () => businessOnlyLedger(options.ledger?.() ?? sharedManualStore(options.root)), today: () => new Date().toISOString().slice(0, 10) });
          return send(reply.status, reply.body);
        }
        const jm = /^\/ui\/jobs(?:\/(events|[0-9a-f-]{36}))?$/i.exec(path);
        if (jm) {
          need("ops.read", "ui.jobs");
          const store = (await jobs()) as JobsLike & { events?(after: number): { events: Array<{ jobId?: string; seq: number }>; last: number }; head?(): number };
          if (!jm[1]) {
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
            return send(200, { jobs: (store.list({ limit, kind: url.searchParams.get("kind") || undefined, state: url.searchParams.get("state") || undefined }) as Record<string, unknown>[]).map(jobShape) });
          }
          if (jm[1] === "events") {
            if (url.searchParams.get("tail") === "1") return send(200, { events: [], last: store.head?.() ?? 0 });
            const got = store.events?.(Number(url.searchParams.get("after") ?? 0) || 0) ?? { events: [], last: 0 };
            const mine = (id: string) => { const j = store.get(id); return !!j && isGatewayActor({ ...(j.principal as object), actor: "process" } as never); };
            return send(200, { events: jobEventsFor(got.events, mine), last: got.last });
          }
          const job = store.get(jm[1]) as Record<string, unknown> | null;
          return job ? send(200, { job: jobShape(job) }) : send(404, { error: "No such job" });
        }
        if (path === "/ui/computers") {
          need("bots.operate", "ui.computers");
          const service = computers();
          return send(200, service ? sharedComputers(service.list()) : { computers: [], targets: [] });
        }
        throw new Refusal(404, "Not found.");
      }

      // ── r12 debugging: logs and restarts (scripts/gateway/debug-ops.ts) ────────────────────────────────────────
      try {
        if (method === "GET" && path === "/diagnostics/logs") {
          need("ops.logs", "diagnostics.logs");
          return send(200, debug.logs(url.searchParams));
        }
        if (method === "POST" && path === "/ops/restart") {
          need("ops.restart", "ops.restart");
          noWritesHere();
          const record = debug.request(await readJson(req), { identity: String((ctx.principal as { gatewayIdentityId?: string }).gatewayIdentityId ?? session.replace(/^gw:/, "")), session: session.replace(/^gw:/, "") });
          action = `ops.restart.${record.service}`;
          target = record.id;
          // The reply goes out first; only then does the restart run (for the hub, this process ends a moment later).
          res.once("finish", () => void debug.fire(record));
          return done(202, { ok: true, id: record.id, service: record.service, state: record.state, follow: `/__gateway/ops/restart/${record.id}`, note: record.service === "hub" ? "The hub restarts in a moment. Poll the follow link: it answers again once the hub is back (usually under a minute)." : `Restarting ${record.service}.` }, [record.id]);
        }
        const rsm = /^\/ops\/restart\/([A-Za-z0-9-]{1,60})$/.exec(path);
        if (method === "GET" && rsm) {
          need("ops.restart", "ops.restart.status");
          const r = debug.status(rsm[1], String((ctx.principal as { gatewayIdentityId?: string }).gatewayIdentityId ?? session.replace(/^gw:/, "")));
          const health = r.state === "done" ? sanitiseHealth((await (options.health ?? (async () => (await import("../cloud/health")).collectHealth({ root: options.root })))().catch(() => null)) as Record<string, unknown> | null) : null;
          return send(200, { restart: { id: r.id, service: r.service, state: r.state, requestedAt: new Date(r.at).toISOString(), finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null, detail: r.detail ?? null }, ...(health ? { health } : {}) });
        }
      } catch (error) {
        if (error instanceof DebugRefusal) throw new Refusal(error.status, error.message, error.extra);
        throw error;
      }

      // ── diagnostics ─────────────────────────────────────────────────────────────────────────────────────────────
      if (method === "GET" && path === "/diagnostics") {
        need("ops.read", "diagnostics");
        const version = await (options.version ?? (async () => (await import("../version")).versionInfo()))().catch(() => null);
        const health = (await (options.health ?? (async () => (await import("../cloud/health")).collectHealth({ root: options.root })))().catch(() => null)) as Record<string, unknown> | null;
        return send(200, { version, health: sanitiseHealth(health), gateway: { killSwitch: isKilled(dir), readOnlyCopy: readOnly(), capabilities: principal.capabilities ?? [] }, more: { health: "/__health", version: "/__version", jobs: "/__gateway/diagnostics/jobs", releases: "/__gateway/diagnostics/releases", actions: "/__gateway/diagnostics/actions" } });
      }
      if (method === "GET" && path === "/diagnostics/releases") {
        need("ops.read", "diagnostics.releases");
        return send(200, releaseReceipts(env()));
      }
      // The shared job log for diagnostics. Founders' jobs carry their own words (titles) and Jarvis's replies (step notes), so
      // only their shape is shown: id, kind, state, timing. Dot's own jobs are shown in full. (Review B1, 4 Oct: /__jobs/** was
      // open to ops.read and leaked utterances; it is no longer forwarded.)
      const jm = /^\/diagnostics\/jobs(?:\/([0-9a-f-]{36}))?$/i.exec(path);
      if (method === "GET" && jm) {
        need("ops.read", jm[1] ? "diagnostics.job" : "diagnostics.jobs");
        const store = await jobs();
        const own = (j: { principal?: unknown }) => isGatewayActor({ ...(j.principal as object), actor: "process" } as never);
        const shape = (j: Record<string, unknown>) => (own(j as { principal?: unknown }) ? { ...j, yours: true } : { id: j.id, kind: j.kind, state: j.state, createdAt: j.createdAt, updatedAt: j.updatedAt, stepCount: typeof j.stepCount === "number" ? j.stepCount : Array.isArray(j.steps) ? j.steps.length : null, quarantined: j.quarantined === true, yours: false });
        if (jm[1]) {
          const job = store.get(jm[1]) as Record<string, unknown> | null;
          if (!job) throw new Refusal(404, "No such job.");
          return send(200, { job: shape(job) });
        }
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const kind = url.searchParams.get("kind") || undefined;
        const state = url.searchParams.get("state") || undefined;
        return send(200, { jobs: (store.list({ limit, kind, state }) as Record<string, unknown>[]).map(shape) });
      }
      if (method === "GET" && path === "/diagnostics/actions") {
        need("ops.read", "diagnostics.actions");
        return send(200, { actions: actions.tail(Math.max(1, Math.min(500, Number(url.searchParams.get("tail")) || 100))) });
      }
      throw new Refusal(404, "Not found.");
    } catch (error) {
      if (error instanceof Refusal) {
        if (write && capability) actions.write({ action: action || "unknown", capability, session: session.replace(/^gw:/, ""), ...(target ? { target } : {}), status: error.status, outcome: "refused", detail: error.message });
        return send(error.status, { error: error.message, ...error.extra });
      }
      console.error(`[gateway] hub route failed: ${(error as Error)?.name ?? "error"}`);
      if (write && capability) actions.write({ action: action || "unknown", capability, session: session.replace(/^gw:/, ""), status: 500, outcome: "failed" });
      return send(500, { error: "Something went wrong." });
    }
  }

  /** What each capability is on THIS hub right now: working, not granted, unsupported here, or waiting on the owner. */
  function financeOrThrow(): GatewayFinance {
    const f = finance();
    if (!f) throw new Refusal(503, "Business finance is not available on this hub.", { unsupported: true });
    return f;
  }

  async function matrix(principal: Principal) {
    const held = new Set(principal.capabilities ?? []);
    type Row = { capability: Capability; what: string; granted: boolean; state: "working" | "missing-authorisation" | "unsupported" | "owner-action"; detail: string };
    const row = (capability: Capability, support: { state: "working" | "unsupported" | "owner-action"; detail: string }): Row => {
      const granted = held.has(capability);
      return { capability, what: CAPABILITY_SUMMARY[capability], granted, state: support.state !== "working" ? support.state : granted ? "working" : "missing-authorisation", detail: support.state !== "working" ? support.detail : granted ? support.detail : `Not granted. A founder runs: bun scripts/gateway/cli.ts grant ${capability} --by <founder>` };
    };
    const ok = (detail: string) => ({ state: "working" as const, detail });
    const copy = readOnly();
    const noWrites = { state: "unsupported" as const, detail: "This hub is a read-only copy: nothing can be changed here." };

    let crmState: ReturnType<typeof ok> | { state: "unsupported" | "owner-action"; detail: string } = ok("The CRM's typed operations.");
    try {
      await crm();
    } catch (error) {
      crmState = (error as { code?: string })?.code === "needs-upgrade" ? { state: "owner-action", detail: "The CRM database needs the owner-run upgrade (scripts/crm/migrate.ts) first." } : { state: "unsupported", detail: "The CRM store could not be opened on this hub." };
    }
    const roots = files.roots();
    const ready = roots.roots.filter((r) => r.ready).map((r) => r.name);
    const service = commands();
    const mem = memory();
    const bots = computers();
    let botCount = 0;
    try {
      botCount = bots ? bots.list().length : 0;
    } catch {
      botCount = 0;
    }
    let repos = 0;
    let codingState: { state: "working" | "unsupported" | "owner-action"; detail: string };
    try {
      const c = await coding();
      repos = c.rt.registry().repos.filter((r) => (r.allowedPeople ?? []).includes("dot")).length;
      codingState = c.rt.readOnly ? noWrites : repos ? ok(`${repos} ${repos === 1 ? "repository" : "repositories"} list "dot". Jobs run on the hub's own signed-in CLIs; merges to a protected branch keep the owner's approval.`) : { state: "owner-action", detail: 'No repository lists "dot" in allowedPeople (the hub\'s coding/repos.json). The owner adds it; until then a draft is refused.' };
    } catch {
      codingState = { state: "unsupported", detail: "The coding workspace is not available on this hub." };
    }
    const receipts = releaseReceipts(env());
    const rows: Row[] = [
      row("view", ok("Read-only pages of the OS, coding job reads, /__health and /__version.")),
      row("crm.read", crmState),
      row("crm.write", crmState.state === "working" && copy ? noWrites : crmState),
      row("finance.read", finance() ? ok("Business rows of the ledger only (personal and unreviewed rows are never returned), receivables, invoice-match suggestions, the Stripe snapshot.") : { state: "unsupported", detail: "Business finance is not available on this hub." }),
      row("finance.write", !finance() ? { state: "unsupported", detail: "Business finance is not available on this hub." } : copy ? noWrites : ok("Categorise a business row (category, kind) or link a refund to its business charge. A row's scope, vendor rules, imports and notes are not available (see DOT-ACCESS.md).")),
      row("mail.read", !mail() ? { state: "unsupported", detail: "Mail is not available on this hub." } : (control.read().mailboxes ?? []).length ? ok(`Authorised mailboxes: ${(control.read().mailboxes ?? []).map((m) => m.address).join(", ")} (the hub's local archive).`) : { state: "owner-action", detail: "No mailbox is authorised. A founder runs: bun scripts/gateway/cli.ts authorise-mailbox <address> --by <founder>" }),
      row("mail.draft", !mail() ? { state: "unsupported", detail: "Mail is not available on this hub." } : copy ? noWrites : (control.read().mailboxes ?? []).length ? ok("Reply drafts are saved as CRM draft-reply records; a founder sends.") : { state: "owner-action", detail: "No mailbox is authorised." }),
      row("release.request", !release() ? { state: "owner-action", detail: "Releases through the gateway need MU_GATEWAY_RELEASES=1 and MU_RELEASE_RECEIPTS_DIR on the hub (owner action)." } : copy ? noWrites : ok("Ask with a commit and a bundle; the owner approves (Telegram code or spoken yes); the hub's release script runs with its backup, checks and rollback.")),
      row("files.read", ready.length ? ok(`Roots ready: ${ready.join(", ")}.`) : { state: "owner-action", detail: "No file root is set up on this hub." }),
      row("files.write", copy ? noWrites : ok(`Writable roots: ${roots.roots.filter((r) => r.ready && r.writable).map((r) => r.name).join(", ") || "none"}.${roots.roots.some((r) => r.name === "designs") ? "" : " The designs root needs MU_DESIGN_PROJECTS_DIR set on the hub (owner action)."}`)),
      row("tasks.run", copy ? noWrites : service ? ok("Tasks go through the Jev-led command path. Lanes open to the gateway: pages, CRM (with crm.read or crm.write). A founder's device, the hub's desktop, bot conversations, receptionist and leads are not reachable.") : { state: "unsupported", detail: "The Jarvis command service is not running on this hub." }),
      row("memory.read", mem ? ok(`Recall returns ${MEMORY_BUCKETS_FOR_GATEWAY.join(", ")} facts only. When the hub's memory is off the answer says so and nothing is read.`) : { state: "unsupported", detail: "Shared memory is not running on this hub." }),
      row("memory.write", !mem ? { state: "unsupported", detail: "Shared memory is not running on this hub." } : copy ? noWrites : ok("Saved as Dot's. Refused (writes-disabled) while MU_MEMORY_WRITES is not on, which is the owner's switch.")),
      row("coding.start", codingState),
      row("bots.operate", !bots ? { state: "unsupported", detail: "The computers service is not running on this hub." } : botCount ? ok(`${botCount} shared bot ${botCount === 1 ? "computer" : "computers"}. The live viewer is not available through the gateway; screenshots are.`) : { state: "unsupported", detail: "No shared bot computers exist on this hub." }),
      row("bots.terminal", !bots || !botCount ? { state: "unsupported", detail: "No shared bot computers exist on this hub." } : ok("A terminal while holding the computer's control lease. Granted separately from bots.operate.")),
      row("ops.logs", ok("Hub, supervisor, gateway, release and health logs from the hub's log folder: the last 500 lines at most, redacted.")),
      row("ops.restart", copy ? noWrites : ok("Restart the hub (through its supervisor), Hermes or SearXNG. 3 an hour.")),
      row("ops.read", ok(`${receipts.configured ? `${receipts.receipts.length} release ${receipts.receipts.length === 1 ? "receipt" : "receipts"} readable.` : "Release receipts need MU_RELEASE_RECEIPTS_DIR set on the hub (owner action); the job log and the action log are readable."}`)),
    ];
    const iid = (principal as { gatewayIdentityId?: string }).gatewayIdentityId;
    const identity = iid ? (listIdentities(dir).find((i) => i.id === iid) ?? null) : null;
    return {
      person: "dot",
      // The identity's and each grant's expiry, and renewSoon within 7 days of either: ask the owner to renew in good time.
      expiry: expiryView(control.read(), identity ? { id: identity.id, expiresAt: identity.expiresAt } : null),
      rows,
      never: ["sending email or messages, issuing a quote or invoice to a client, any outbound contact (the owner's approval)", "approving, deciding or releasing anything", "merging or pushing to a protected branch (the owner asks and approves)", "a founder's personal desktop or companion, and the hub's own desktop", "accounts, credentials, keys, .env files, the vaults' raw files, backups", "releasing to production (the release owner, at the hub's console)"],
      capabilities: CAPABILITIES,
    };
  }

  return { handle, mine, actions };
}

/** The health report without what Dot has no use for: no data folder path, component status and detail only. */
function sanitiseHealth(h: Record<string, unknown> | null) {
  if (!h) return null;
  const components: Record<string, { status: unknown; detail: unknown }> = {};
  for (const [name, c] of Object.entries((h.components ?? {}) as Record<string, Record<string, unknown>>)) components[name] = { status: c?.status ?? null, detail: typeof c?.detail === "string" ? c.detail.replace(/[A-Za-z]:\\[^\s"']+|\/(?:home|Users|mnt|var|srv)\/[^\s"']+/g, "<path>") : null };
  return { ok: h.ok === true, status: h.status ?? null, checkedAt: h.checkedAt ?? null, hubRole: h.hubRole ?? null, version: h.version ?? null, gitSha: h.gitSha ?? null, dirty: h.dirty === true, startedAt: h.startedAt ?? null, components, failed: Array.isArray(h.failed) ? (h.failed as Array<Record<string, unknown>>).map((f) => ({ component: f.component, detail: f.detail })) : [] };
}

/**
 * Release receipts (deploy/windows/release-ryzen.ps1 writes release-<stamp>.json into the hub's log folder). Read only when
 * the owner names that folder in MU_RELEASE_RECEIPTS_DIR. What comes back: the time, the old and new commit, the rollback tag
 * and whether the CRM was migrated. Never the backup or config-copy PATHS the receipt also holds.
 */
export function releaseReceipts(env: Record<string, string | undefined>): { configured: boolean; receipts: Array<{ file: string; time: string | null; oldHead: string | null; newHead: string | null; rollbackTag: string | null; crmMigrated: boolean }>; note?: string } {
  const folder = (env.MU_RELEASE_RECEIPTS_DIR ?? "").trim();
  if (!folder) return { configured: false, receipts: [], note: "MU_RELEASE_RECEIPTS_DIR is not set on this hub (owner action). Releases are made at the hub's console by the release owner." };
  if (!existsSync(folder)) return { configured: true, receipts: [], note: "The release receipts folder does not exist on this hub." };
  const str = (v: unknown, max = 80) => (typeof v === "string" ? v.replace(/[^\w ./:+-]/g, "?").slice(0, max) : null);
  const receipts = [];
  for (const name of readdirSync(folder).filter((n) => /^release-\d{8}T\d{6}\.json$/.test(n)).sort().slice(-20)) {
    try {
      const full = join(folder, name);
      if (statSync(full).size > 64 * 1024) continue;
      const r = JSON.parse(readFileSync(full, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
      receipts.push({ file: name, time: str(r.time, 40), oldHead: str(r.oldHead, 64), newHead: str(r.newHead, 64), rollbackTag: str(r.rollbackTag), crmMigrated: r.crmMigrated === true });
    } catch {
      /* an unreadable receipt is skipped */
    }
  }
  return { configured: true, receipts };
}

export type GatewayOps = ReturnType<typeof createGatewayOps>;

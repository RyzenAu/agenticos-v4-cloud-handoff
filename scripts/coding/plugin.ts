import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { publicJson, type Principal } from "../approvals/principal";
import { realExecutable } from "../assistant-runtime";
import { cliHomeGuard } from "../cli-home-guard";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { isBrowserPrincipal } from "../identity/principal";
import { jevDecide } from "../jev-client";
import { jobsRuntime } from "../jobs/runtime";
import type { MemoryService } from "../memory/plugin";
import { defaultReceiptSink } from "../model-router/defaults";
import { backgroundJobsDisabled } from "../preview-guard";
import { providerKey } from "../provider-config";
import { labelOf, loadAccounts, pickClaudeSlot, type AccountsConfig } from "./accounts";
import { claudeStatusService } from "./claude-status";
import { loadSharedContext } from "./shared-context";
import { latestSubscriptionCards } from "../model-router/allowance";
import { aiUsageSnapshot } from "../ai-usage/plugin";
import type { ClaudeAccountSlot } from "./contracts";
import { readApproval } from "./codex-isolation";
import { loadCodingPrefs } from "./role-choice";
import type { CodingJob, RepoRegistry, RepoRegistryEntry, UsageReceipt } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { agentPlanner } from "./planner";
import { defaultRegistryFile, loadRegistryLayered } from "./registry";
import { codingRoute, sseFrames, type CodingRuntime } from "./routes";
import { withGuidance } from "./guidance";
import { claudeRunner, primeClaudeCodingBinary } from "./runners/claude";
import { runCapture } from "../nonblocking-exec";
import { codexRunner } from "./runners/codex";
import { routerRunner } from "./runners/router";
import { contextDataRootFor } from "./runners/context-helper";
import { clineBridge } from "../cline-bridge";
import { clineBridgeName } from "../model-fleet/policy";
import type { RoutedChatDeps } from "../model-router/chat";
import { ProviderError } from "../model-router/router";
import { redactText } from "./redact";
import { claudeSlotFromWords, createShaper } from "./shaper";
import { createCodingVoice, type CodingVoice } from "./voice";
import { spokenConfirmations } from "../jarvis-execution/voice-confirmation";
import { CodingStore, LeaseHeld, type WorktreeSnapshot } from "./store";
import { worktreePathFor } from "./worktree";
import { dataDirFor } from "../cloud/data-dir";

/**
 * The coding harness in the server (task C4): ONE runtime per process (store, orchestrator, shaper),
 * mounted at `/__operator/coding/*` in front of the operator plugin, and shared with Jarvis's voice turn.
 *
 *  - Data: `.operator-data/coding/` (store, artefacts, repos.json, accounts.json); CODING_DATA_DIR
 *    overrides it for a preview or a test. A quiet second server (AGENTIC_OS_NO_BACKGROUND=1) opens the
 *    store READ-ONLY and never recovers, runs or writes.
 *  - Approvals: B2's one ApprovalService (jobs/runtime.ts).
 *  - Recovery: the store's writer recovery runs once at open (active work → interrupted, nothing replayed).
 */

export type CodingRuntimeFull = CodingRuntime & { dataDir: string; readOnly: boolean; close(): void };
const KEY = Symbol.for("mu.coding.runtime.v1");
const registryGlobal = globalThis as typeof globalThis & { [KEY]?: Map<string, CodingRuntimeFull> };

type CliVersions = { claude: string | null; codex: string | null };
type VersionProbe = { value: string | null; failed: boolean };

/** A CLI's version as an async child (T8b, review T8 S-6: spawnSync here held the server for up to 15 s per CLI). */
async function version(binary: string | undefined, cli: "claude" | "codex"): Promise<VersionProbe> {
  if (!binary) return { value: null, failed: false }; // not installed: a real answer
  // A copy runs even `--version` on its own home (REVIEW-T3: it wrote .claude.json into the synthetic home).
  const home = cliHomeGuard(cli, process.env);
  if (!home.ok) return { value: null, failed: false };
  const r = await runCapture(binary, ["--version"], { timeout: 15_000, env: home.env });
  if (r.error) return { value: null, failed: true }; // couldn't start, or timed out: ask again later
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`);
  return { value: m ? m[1] : null, failed: false };
}

/**
 * The Claude and Codex CLI versions, read once per process as async children (T8b), primed at server
 * start so the first /coding/* request doesn't wait for them. A failed read (a spawn error or a
 * timeout, review T8b-F1) is never cached: the versions show as "unknown" and are asked again, at
 * most once a minute. ready() never rejects.
 */
export function createCliVersions(options: { probe: () => Promise<[VersionProbe, VersionProbe]>; now?: () => number; retryMs?: number; maxAgeMs?: number }) {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 60_000;
  let versions: CliVersions | null = null;
  let done = false;
  // A CLI can be installed or updated while the server runs (30 Sep 2026: the bridge copy was added); re-read now and then.
  let doneAt = -Infinity;
  const maxAgeMs = options.maxAgeMs ?? 30 * 60_000;
  let failedAt = -Infinity;
  let pending: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (done && now() - doneAt > maxAgeMs && !pending) { done = false; void ready(); return Promise.resolve(); } // keep answering the last value meanwhile
    if (done) return Promise.resolve();
    if (pending) return pending;
    if (now() - failedAt < retryMs) return Promise.resolve(); // failed just now: answer "unknown", don't wait again
    pending = (async () => {
      try {
        const [claude, codex] = await options.probe();
        versions = { claude: claude.value, codex: codex.value };
        if (claude.failed || codex.failed) failedAt = now();
        else { done = true; doneAt = now(); }
      } catch {
        versions ??= { claude: null, codex: null };
        failedAt = now();
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return {
    ready,
    current(): CliVersions {
      void ready(); // cheap when fresh; starts a re-read when unknown or older than maxAgeMs
      return versions ?? { claude: null, codex: null };
    },
  };
}

// v3 (30 Sep 2026): the global survives dev-server restarts, so a stale choice of the older CLI stuck; re-read.
const CLI_VERSIONS_KEY = Symbol.for("mu.coding.cli-versions.v3");
const cliVersionsGlobal = globalThis as typeof globalThis & { [CLI_VERSIONS_KEY]?: ReturnType<typeof createCliVersions> };
/** The process-wide versions (shared by every coding runtime; survives a dev-server reload). */
export function codingCliVersions() {
  return (cliVersionsGlobal[CLI_VERSIONS_KEY] ??= createCliVersions({
    probe: async () => {
      const claudeBin = await primeClaudeCodingBinary();
      return Promise.all([version(claudeBin, "claude"), version(realExecutable("codex"), "codex")]);
    },
  }));
}

export function codingDataDir(root: string, env: NodeJS.ProcessEnv = process.env) {
  return env.CODING_DATA_DIR ? resolve(env.CODING_DATA_DIR) : join(dataDirFor(root), "coding");
}

/** One git read in a role worktree, as an async child. A git that can't start or hangs gives no evidence. */
async function gitRead(cwd: string, args: string[]): Promise<string> {
  const r = await runCapture("git", ["-c", "core.fsmonitor=false", ...args], { cwd, timeout: 15_000 });
  if (r.error) throw r.error; // as spawnSync did: no stdout, so this job's evidence is []
  return r.stdout;
}

/**
 * Evidence for the recovery event: each write role worktree's head and dirty count. Never commits.
 * Async git children (M1, review T8b: spawnSync here held the server while the store opened); the
 * roles are read side by side.
 */
export async function recoverySnapshot(entry: RepoRegistryEntry | undefined, job: CodingJob): Promise<WorktreeSnapshot[]> {
  if (!entry) return [];
  const id6 = job.id.replace(/-/g, "").slice(0, 6);
  return Promise.all(job.spec.roles.filter((r) => r.access === "write").map(async (r) => {
    const path = worktreePathFor(entry, id6, r.roleId);
    const [head, status] = await Promise.all([gitRead(path, ["rev-parse", "HEAD"]), gitRead(path, ["--no-optional-locks", "status", "--porcelain"])]);
    return { roleId: r.roleId, head: head.trim() as never, dirtyFiles: status.split("\n").filter(Boolean).length };
  }));
}

const PENDING_KEY = Symbol.for("mu.coding.runtime.pending.v1");
type Opening = { promise: Promise<CodingRuntimeFull>; cancelled: boolean };
const pendingGlobal = globalThis as typeof globalThis & { [PENDING_KEY]?: Map<string, Opening> };

/**
 * The process-wide coding runtime for this root (lazy; one open at a time). Opening the store (the
 * lease check and the restart recovery, with its git snapshot) runs as async children, so it never
 * stalls the server's event loop (M1, review T8b); the recovery itself is unchanged.
 */
export function codingRuntime(root: string, options: { memory?: MemoryService | null; env?: NodeJS.ProcessEnv } = {}): Promise<CodingRuntimeFull> {
  const all = (registryGlobal[KEY] ??= new Map());
  const existing = all.get(root);
  if (existing) return Promise.resolve(existing);
  const pending = (pendingGlobal[PENDING_KEY] ??= new Map());
  const inFlight = pending.get(root);
  if (inFlight) return inFlight.promise;
  const opening: Opening = { promise: null as never, cancelled: false };
  opening.promise = Promise.resolve().then(() => openCodingRuntime(root, options, opening)).finally(() => {
    if (pending.get(root) === opening) pending.delete(root);
  });
  pending.set(root, opening);
  return opening.promise;
}

async function openCodingRuntime(root: string, options: { memory?: MemoryService | null; env?: NodeJS.ProcessEnv }, opening: Opening): Promise<CodingRuntimeFull> {
  const all = (registryGlobal[KEY] ??= new Map());
  const env = options.env ?? process.env;
  const dataDir = codingDataDir(root, env);
  const readOnly = backgroundJobsDisabled(env);
  const defaultsFile = defaultRegistryFile(root, env);
  const warned = new Set<string>();
  function safeRegistry(): RepoRegistry {
    const layered = loadRegistryLayered(join(dataDir, "repos.json"), defaultsFile);
    for (const problem of [layered.liveError, layered.defaultsError]) {
      if (problem && !warned.has(problem)) { warned.add(problem); console.warn(`[coding] registry: ${problem.slice(0, 300)}`); }
    }
    return layered.registry;
  }
  let store: CodingStore;
  try {
    store = readOnly && existsSync(join(dataDir, "coding.sqlite")) ? CodingStore.open(dataDir, { readOnly: true }) : await CodingStore.openAsync(dataDir, {
      snapshot: (job) => recoverySnapshot(safeRegistry().repos.find((r) => r.id === job.spec.repo.repoId), job),
    });
  } catch (e) {
    if (e instanceof LeaseHeld) store = CodingStore.open(dataDir, { readOnly: true });
    else throw e;
  }
  // closeCodingRuntime ran while this was opening (server shutdown): don't publish it.
  if (opening.cancelled) {
    try { store.close(); } catch { /* closed */ }
    throw new Error("The coding workspace was closed while it was starting.");
  }
  const accounts = (): AccountsConfig => loadAccounts(join(dataDir, "accounts.json"));
  // The owner's paid/free preferences (.operator-data/coding-prefs.json). Missing or invalid = the safe default.
  const prefsFile = join(dataDirFor(root), "coding-prefs.json");
  let prefsWarned = "";
  const codingPrefs = () => {
    const r = loadCodingPrefs(prefsFile);
    if (r.problem && r.problem !== prefsWarned) { prefsWarned = r.problem; console.warn(`[coding] ${r.problem}`); }
    return r;
  };
  // Read async, once per process, and primed at server start (codingPlugin); codingRoute awaits
  // ready() so a route doesn't answer with "not read yet" nulls while the first read runs.
  const cliVersionsReady = () => codingCliVersions().ready();
  const cliVersions = () => codingCliVersions().current();
  const approvals = () => { try { return jobsRuntime(root).approvals; } catch { return null; } };
  const fleetSink = defaultReceiptSink(root);
  const memory = options.memory
    ? {
        writes: () => { try { return !!options.memory!.api().settings?.writes; } catch { return false; } },
        save: async (p: Parameters<NonNullable<Parameters<typeof createOrchestrator>[0]["memory"]>["save"]>[0], input: Parameters<NonNullable<Parameters<typeof createOrchestrator>[0]["memory"]>["save"]>[1]) => {
          const r = await options.memory!.api().saveToVault(p as never, input as never);
          return r.ok ? { ok: true, fact: { wiki_ref: r.fact.wiki_ref, source: { link: r.fact.source?.link } } } : { ok: false, code: (r as { code?: string }).code };
        },
      }
    : null;
  const liveRoot = resolve(root);
  const plannerReceipts = new Map<string, UsageReceipt>();
  // Each Claude login's real sign-in state, from `claude auth status` on its own profile (30 Sep 2026).
  // The primed (async) pick: a blocking --version at start-up could time out and poison the version cache.
  const claudeStatus = claudeStatusService({ accounts, binary: () => primeClaudeCodingBinary() });
  // After a restart no /usage reading exists until something asks; build one so the first pick sees real limits.
  const usageReady = async () => { if (!latestSubscriptionCards()) await aiUsageSnapshot().then(() => undefined, () => undefined); };
  let warm: ReturnType<typeof setInterval> | null = null;
  if (!readOnly) {
    void claudeStatus.refresh().catch(() => undefined);
    void usageReady();
    // Keep both fresh for voice drafts too (the usage service caches provider reads 15 min; this adds no extra calls).
    warm = setInterval(() => { void claudeStatus.refresh().catch(() => undefined); void usageReady(); }, 10 * 60_000);
    (warm as { unref?: () => void }).unref?.();
  }
  const claudeConnected = (slot: ClaudeAccountSlot) => {
    const s = claudeStatus.current().find((x) => x.slot === slot);
    return { connected: s?.connected ?? null, reason: s?.reason ?? null };
  };
  /** The account a NEW Claude role goes to: first connected account below its stop threshold (preferred first). */
  const claudeSlot = (preferred?: ClaudeAccountSlot) => {
    const config = accounts();
    const choice = pickClaudeSlot(config, claudeStatus.current(), latestSubscriptionCards(), 95, preferred);
    return choice.ok ? { slot: choice.slot.slot, label: choice.slot.label, reason: choice.reason, configDir: choice.slot.configDir } : { slot: null, label: labelOf(config, preferred ?? "claude:max"), reason: choice.reason, configDir: null };
  };
  const orch = createOrchestrator({
    store,
    registry: safeRegistry,
    accounts,
    runners: {
      // Each runner is wrapped so every role it starts carries the role's engineering guidance (guidance.ts).
      claude: withGuidance(claudeRunner()),
      codex: withGuidance(codexRunner()),
      router: withGuidance(routerRunner({ root, prefs: () => codingPrefs().prefs, owns: (jobId, roleId) => store.getJob(jobId)?.spec.roles.find((r) => r.roleId === roleId)?.owns ?? null, deps: { cline: clineInvoke(root) } })),
    },
    approvals,
    liveRoot,
    memory,
    fleetSink,
    claudeConnected,
    // The same brief for every account and model; the job records what went in (shared-context.ts).
    sharedContext: () => loadSharedContext(join(dataDir, "shared-context.json")),
    // The owner's configured fallback between accounts and models at a limit (coding-prefs.json "fallback"); off unless auto.
    fallback: () => codingPrefs().prefs.fallback ?? null,
    codexAvailable: () => readApproval() !== null,
    // Opt-in per-run context helper for Claude roles (coding-prefs.json "contextHelper": "context-mode"); off unless set.
    contextHelper: () => (codingPrefs().prefs.contextHelper ? { dataRoot: env.AGENTICOS_CONTEXT_MODE_DATA ?? contextDataRootFor(dataDir) } : null),
  });
  if (!readOnly) orch.attachApprovals();
  const jevKey = () => providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY") || "";
  const shaper = createShaper({
    registry: safeRegistry,
    accounts,
    cliVersions: () => ({ claude: cliVersions().claude ?? "unknown", codex: cliVersions().codex ?? "unknown" }),
    prefs: () => codingPrefs().prefs,
    // Nothing read yet (both null) = unknown, assumed available as before; a read that found one CLI absent says so.
    choice: () => {
      const v = cliVersions();
      const known = v.claude !== null || v.codex !== null;
      return { ...(known ? { claudeAvailable: v.claude !== null, codexAvailable: v.codex !== null } : {}), codexReady: readApproval() !== null };
    },
    claudeSlot: (preferred) => { const c = claudeSlot(preferred); return { slot: c.slot, label: c.label, reason: c.reason }; },
    // CODING_JEV=off: no hosted decision call (a throwaway test hub drafts by the shaper's own rules); unset = the product's normal path.
    jev: env.CODING_JEV === "off" ? null : async (call) => jevDecide({ surface: "voice.router", key: jevKey(), state: call.state, questions: call.questions, caller: "scripts/coding/shaper", root, timeoutMs: 2500 }),
    planner: env.CODING_PLANNER === "off" ? null : agentPlanner({ runner: withGuidance(claudeRunner()), cliVersion: () => cliVersions().claude ?? "unknown", person: () => "usman" as never, fleetSink, receipts: plannerReceipts, liveRoot, claudeSlot: (utterance) => { const c = claudeSlot(claudeSlotFromWords(utterance, accounts()) ?? undefined); return c.slot ? { slot: c.slot, configDir: c.configDir } : null; } }),
  });
  const runtime: CodingRuntimeFull = {
    store, orch, shaper, registry: safeRegistry, accounts, approvals, cliVersions, cliVersionsReady, focus: null, plannerReceipts, dataDir, readOnly, claudeStatus, usageReady,
    close() { if (warm) clearInterval(warm); orch.close(); try { store.close(); } catch { /* closed */ } all.delete(root); voiceGlobal[VOICE_KEY]?.delete(root); },
  };
  all.set(root, runtime);
  return runtime;
}

/** Cline's free models for routed roles (the same bridge Hermes uses; text only, every tool refused). */
export function clineInvoke(root: string): NonNullable<RoutedChatDeps["cline"]> {
  let bridge: ReturnType<typeof clineBridge> | null = null;
  return async (choice, messages, signal) => {
    bridge ??= clineBridge({ root });
    try {
      const out = await bridge.complete({ model: clineBridgeName(choice.model), messages: messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })) }, signal);
      return {
        value: String(out.choices?.[0]?.message?.content ?? ""),
        providerModel: out.fleet_receipt?.providerModel ?? null,
        usage: { inputTokens: out.usage?.prompt_tokens ?? null, outputTokens: out.usage?.completion_tokens ?? null },
        costUsd: out.fleet_receipt?.usage?.costUsd ?? null,
      };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      // Refused before any work (unknown/excluded model, not verified free, not installed): safe to fall back.
      throw new ProviderError(status === 503 || status === 403 || status === 400 ? "unavailable" : "unknown", redactText((e as Error).message, 200), { sent: status === 503 || status === 403 || status === 400 ? false : "unknown", httpStatus: status });
    }
  };
}

/** Tests and shutdown. */
export function closeCodingRuntime(root: string) {
  registryGlobal[KEY]?.get(root)?.close();
  // Still opening: it closes its store instead of publishing it.
  const opening = pendingGlobal[PENDING_KEY]?.get(root);
  if (opening) {
    opening.cancelled = true;
    pendingGlobal[PENDING_KEY]!.delete(root);
    opening.promise.catch(() => undefined);
  }
}

const MAX_BODY = 32 * 1024;

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

export type CodingMiddlewareOptions = {
  root: string;
  token?: string | (() => string);
  resolvePrincipal?: (req: IncomingMessage) => Principal | null;
  runtime?: () => CodingRuntime | Promise<CodingRuntime>;
};

/** `/__operator/coding/*`, mounted before the operator plugin (which would otherwise answer 404). */
export function codingMiddleware(options: CodingMiddlewareOptions) {
  const resolvePrincipal = options.resolvePrincipal ?? ((req: IncomingMessage) => requestPrincipal(req as never, { root: options.root }) as unknown as Principal | null);
  const internal = () => (typeof options.token === "function" ? options.token() : options.token);
  const runtime = options.runtime ?? (() => codingRuntime(options.root));
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = String(req.url ?? "/").split("?")[0];
    if (!/^\/__operator\/coding(?:\/|$)/.test(raw)) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body, publicJson));
    };
    // The raw path decides: no dot segments, encoded slashes or doubled slashes.
    if (!/^\/__operator\/coding(?:\/[A-Za-z0-9._-]+)*$/.test(raw) || /\/\.\.?(?:\/|$)/.test(raw)) return send(400, { error: "Non-canonical path" });
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) return send(403, { error: "Local access only" });
    if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "Cross-site request blocked" });
    const host = String(req.headers.host ?? "");
    if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return send(403, { error: "Unknown origin" });
    const principal = resolvePrincipal(req);
    if (!principal || !isBrowserPrincipal(principal as never)) return send(401, { error: "Sign in first: use Agentic OS at this PC, or open it through your own Tailscale address." });
    const method = req.method ?? "GET";
    let body: unknown = {};
    if (method !== "GET" && method !== "HEAD") {
      const token = internal();
      if (token !== undefined && !pageTokenMatches(principal as never, req.headers["x-claude-os-token"], token)) return send(403, { error: "Refresh this page and try again." });
      if (String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return send(415, { error: "Send JSON" });
      try { body = await readJson(req); } catch (e) { return send((e as { status?: number }).status ?? 400, { error: "Invalid JSON body" }); }
    }
    let rt: CodingRuntime;
    try { rt = await runtime(); } catch (e) { return send(503, { error: `The coding workspace isn't available: ${(e as Error).message}` }); }
    const url = new URL(req.url ?? "/", "http://localhost");
    const out = await codingRoute({ method, path: raw.replace(/^\/__operator/, ""), url, body, principal }, rt);
    if (!out) return next();
    if ("text" in out) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return void res.end(out.text);
    }
    if ("sse" in out) {
      // Server-sent events from the append-only store; the client resumes from Last-Event-ID / ?after.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      let after = Math.max(out.sse.after, Number(req.headers["last-event-id"] ?? 0) || 0);
      let closed = false;
      const pump = () => {
        if (closed) return;
        try {
          const events = rt.store.events(out.sse.jobId, after, 200);
          if (events.length) { after = events[events.length - 1].seq; res.write(sseFrames(events)); }
          else res.write(": keep-alive\n\n");
        } catch { closed = true; res.end(); }
      };
      pump();
      const timer = setInterval(pump, 1000);
      req.on("close", () => { closed = true; clearInterval(timer); });
      return;
    }
    send(out.status, out.body);
  };
}

export function codingPlugin(options: CodingMiddlewareOptions & { memory?: MemoryService | null }): Plugin {
  return {
    name: "agentic-os-coding",
    configureServer(server) {
      // Read the Claude/Codex CLI versions now, in the background (async children, never blocking),
      // so the first /coding/* request doesn't wait up to ~35 s for them (review T8b).
      void codingCliVersions().ready();
      // The owning server opens the store now so restart recovery starts before any request (a
      // request that arrives first waits for the same open). Async: it never holds the event loop.
      if (!backgroundJobsDisabled()) {
        codingRuntime(options.root, { memory: options.memory ?? null }).catch((e) => console.warn(`[coding] not started: ${(e as Error).message}`));
      }
      server.middlewares.use(codingMiddleware({ ...options, runtime: options.runtime ?? (() => codingRuntime(options.root, { memory: options.memory ?? null })) }) as never);
      server.httpServer?.once("close", () => closeCodingRuntime(options.root));
    },
  };
}

const VOICE_KEY = Symbol.for("mu.coding.voice.v1");
const voiceGlobal = globalThis as typeof globalThis & { [VOICE_KEY]?: Map<string, CodingVoice> };

/** Jarvis's coding rules for this root (free-voice.ts `coding` dependency). Lazy; one per process. */
/** The shared coding voice for this root if a turn has already built it, else null (never builds it). */
export function existingCodingVoice(root: string): CodingVoice | null {
  return (voiceGlobal[VOICE_KEY] as Map<string, CodingVoice> | undefined)?.get(root) ?? null;
}

export async function codingVoiceFor(root: string, options: { memory?: MemoryService | null } = {}): Promise<CodingVoice> {
  const all = (voiceGlobal[VOICE_KEY] ??= new Map());
  const existing = all.get(root);
  if (existing) return existing;
  const rt = await codingRuntime(root, options);
  const raced = all.get(root); // another turn built it while the store opened
  if (raced) return raced;
  const voice = createCodingVoice({
    store: rt.store,
    orch: rt.orch,
    shaper: rt.shaper,
    approvals: rt.approvals,
    spoken: spokenConfirmations,
    cliVersions: () => ({ claude: rt.cliVersions().claude ?? "unknown", codex: rt.cliVersions().codex ?? "unknown" }),
    setFocus: (jobId, tab) => { rt.focus = { jobId, tab, at: Date.now() }; },
    repoIds: () => rt.registry().repos.map((r) => r.id),
    accounts: rt.accounts,
  });
  all.set(root, voice);
  return voice;
}

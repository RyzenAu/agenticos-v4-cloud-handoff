// scripts/model-router/receipts.ts — the ONE receipt contract for model calls (TARGET-ARCHITECTURE §3.3
// Receipt, plus fallbackFrom per the V7 amendment to §3.5).
//
// Writers go through the ReceiptSink interface below. B2's Job/Receipt store (scripts/jobs/**)
// implements it at merge; until then JsonlReceiptSink is the fallback sink. Unknown stays null.
// The interface also carries the no-replay contract: history lookup and an atomic claim are
// REQUIRED, and runRouted() refuses to run on a sink that lacks them.
// Never stored: prompt, output, raw error text, emails, keys or file paths (the projection below
// copies named metadata fields only).
//
// This file also reconciles the two older cost records into the same shape, read-only:
//   - the MiMo JSONL ledger (scripts/llm/mimo.ts), which /usage never showed because the reader
//     looked under the home folder instead of the repo;
//   - the Cline-only fleet receipts.sqlite (scripts/model-fleet/receipt-sink.ts).
// readAllReceipts() returns router receipts plus those legacy rows, each marked with `legacy`.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  catalogue,
  catalogueModel,
  modelByProviderId,
  type CostBasis,
  type Route,
} from "./catalogue";

export type SelectedBy = "jev" | "rule" | "owner";
export type ReceiptOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "termination_unverified"
  | "refused_policy"
  | "exhausted_free"
  | "rate_limited"
  | "replay_refused";
export type ErrorCode =
  | "rate_limited"
  | "quota_exhausted"
  | "insufficient_funds"
  | "auth"
  | "not_found"
  | "unavailable"
  | "bad_request"
  | "timeout"
  | "cancelled"
  | "transport"
  | "policy"
  | "no_eligible_model"
  | "replay"
  | "unknown";

/** §3.3 Receipt, extended with fallbackFrom (V7) and the attempt chain. */
export type RouterReceipt = {
  schema: "mu.router-receipt/v1";
  requestId: string;
  attempt: number;
  parentRequestId: string | null;
  task: string;
  caller: string;
  provider: string;
  /** Catalogue model id that actually ran (or was refused). */
  model: string;
  /** Identity the provider reported, or null. */
  providerModel: string | null;
  route: Route;
  selectedBy: SelectedBy;
  reason: string;
  /** The catalogue id originally selected, when a different model ran instead. */
  fallbackFrom: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  characters: number | null;
  audioSeconds: number | null;
  costUsd: number | null;
  /** "refused_before_work": nothing was done (a sent:false refusal, or not a call at all), so it cost nothing. */
  costBasis: CostBasis | "free_tier_unverified" | "refused_before_work";
  priceAsOf: string | null;
  allowance: { plan: string; window: string; usedPct: number | null } | null;
  latencyMs: number;
  outcome: ReceiptOutcome;
  errorCode: ErrorCode | null;
  httpStatus: number | null;
  startedAt: string;
  endedAt: string;
  /** true when the request may have reached the provider (it answered, or the result is unknown);
   * false only when it certainly did no work (refused before sending, 402/429/4xx, or not a call at all).
   * Absent only on legacy rows, which are treated as sent. */
  sent?: boolean;
  /** Set only on rows reconstructed from an older ledger. */
  legacy?: "mimo-ledger" | "fleet-sqlite";
};

/**
 * Where receipts go, and the no-replay contract. B2's Job/Receipt store (jobs.sqlite) implements this
 * at merge. All four methods are REQUIRED; runRouted() fails closed on a sink missing any of them.
 *
 * - write(receipt): persist one attempt (or refusal/exhaustion) row. Metadata only.
 * - forRequest(requestId): every earlier row for this requestId, from durable storage (survives restarts).
 * - claim(requestId): ATOMICALLY take the requestId before any provider call. At most one caller may hold
 *   the claim at a time, across every process sharing the store (jobs.sqlite: a UNIQUE claim row written in
 *   one transaction; the JSONL sink: an exclusive-create lock file around claims.jsonl). Returns false when
 *   the id is already claimed: running now, done, or its outcome unknown.
 * - release(requestId): make the id claimable again. runRouted() calls it ONLY when every attempt under the
 *   claim was sent:false (the provider certainly did no work). A claim with a success or any possibly-sent
 *   attempt is held forever: that step is never run again.
 */
export interface ReceiptSink {
  write(receipt: RouterReceipt): void | Promise<void>;
  forRequest(requestId: string): RouterReceipt[] | Promise<RouterReceipt[]>;
  claim(requestId: string): boolean | Promise<boolean>;
  release(requestId: string): void | Promise<void>;
}

/** Outcomes that are not provider calls: never counted as calls, cost or failures. */
export const NOT_A_CALL = new Set<ReceiptOutcome>([
  "refused_policy",
  "exhausted_free",
  "replay_refused",
]);

const OUTCOMES = new Set<ReceiptOutcome>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "termination_unverified",
  "refused_policy",
  "exhausted_free",
  "rate_limited",
  "replay_refused",
]);
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
const text = (s: unknown, max: number) =>
  // eslint-disable-next-line no-control-regex -- strips control characters from stored text on purpose
  typeof s === "string" ? s.replace(/[\x00-\x1f]/g, " ").slice(0, max) : "";

/** Explicit projection: only these fields are ever persisted. */
export function projectReceipt(r: RouterReceipt): RouterReceipt {
  if (!r || typeof r.requestId !== "string" || !r.requestId)
    throw new Error("receipt requestId required");
  if (!OUTCOMES.has(r.outcome)) throw new Error("receipt outcome invalid");
  if (!["free", "subscription", "metered"].includes(r.route))
    throw new Error("receipt route invalid");
  const out: RouterReceipt = {
    schema: "mu.router-receipt/v1",
    requestId: text(r.requestId, 80),
    attempt: Number.isSafeInteger(r.attempt) && r.attempt > 0 ? r.attempt : 1,
    parentRequestId: r.parentRequestId ? text(r.parentRequestId, 80) : null,
    task: text(r.task, 60),
    caller: text(r.caller, 80),
    provider: text(r.provider, 40),
    model: text(r.model, 80),
    providerModel: r.providerModel ? text(r.providerModel, 120) : null,
    route: r.route,
    selectedBy: r.selectedBy === "jev" || r.selectedBy === "owner" ? r.selectedBy : "rule",
    reason: text(r.reason, 240),
    fallbackFrom: r.fallbackFrom ? text(r.fallbackFrom, 80) : null,
    inputTokens: count(r.inputTokens),
    outputTokens: count(r.outputTokens),
    characters: count(r.characters),
    audioSeconds: count(r.audioSeconds),
    costUsd: count(r.costUsd),
    costBasis: r.costBasis,
    priceAsOf: r.priceAsOf ? text(r.priceAsOf, 30) : null,
    allowance: r.allowance
      ? {
          plan: text(r.allowance.plan, 40),
          window: text(r.allowance.window, 40),
          usedPct: count(r.allowance.usedPct),
        }
      : null,
    latencyMs: count(r.latencyMs) ?? 0,
    outcome: r.outcome,
    errorCode: r.errorCode ?? null,
    httpStatus: Number.isSafeInteger(r.httpStatus) ? r.httpStatus : null,
    startedAt: text(r.startedAt, 30),
    endedAt: text(r.endedAt, 30),
  };
  if (typeof r.sent === "boolean") out.sent = r.sent;
  if (r.legacy) out.legacy = r.legacy;
  return out;
}

export const receiptsFile = (root: string) =>
  join(root, ".operator-data", "model-router", "receipts.jsonl");

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
type ClaimLine = {
  schema: "mu.router-claim/v1";
  requestId: string;
  state: "open" | "released";
  at: string;
};

/** Fallback sink until the Job/Receipt store lands: one JSON line per attempt; claims in claims.jsonl. */
export class JsonlReceiptSink implements ReceiptSink {
  private claimsFile: string;
  private lockFile: string;
  constructor(private file: string) {
    this.claimsFile = join(dirname(file), "claims.jsonl");
    this.lockFile = join(dirname(file), "claims.lock");
  }
  write(receipt: RouterReceipt) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(projectReceipt(receipt))}\n`);
  }
  forRequest(requestId: string): RouterReceipt[] {
    return readJsonl(this.file).filter((r) => r.requestId === requestId);
  }
  /** Cross-process mutex: exclusive create of claims.lock. A lock older than 10 s (crashed holder) is broken. */
  private locked<T>(work: () => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        closeSync(openSync(this.lockFile, "wx"));
        break;
      } catch {
        try {
          if (Date.now() - statSync(this.lockFile).mtimeMs > 10_000) unlinkSync(this.lockFile);
        } catch {
          /* the holder released it meanwhile */
        }
        if (Date.now() > deadline) throw new Error("Receipt claim store busy; not run.");
        sleepSync(5);
      }
    }
    try {
      return work();
    } finally {
      try {
        unlinkSync(this.lockFile);
      } catch {
        /* already gone */
      }
    }
  }
  private state(requestId: string): ClaimLine["state"] | null {
    if (!existsSync(this.claimsFile)) return null;
    let state: ClaimLine["state"] | null = null;
    for (const line of readFileSync(this.claimsFile, "utf8").split("\n")) {
      if (!line.includes(requestId)) continue;
      try {
        const c = JSON.parse(line) as ClaimLine;
        if (c.schema === "mu.router-claim/v1" && c.requestId === requestId) state = c.state;
      } catch {
        /* a torn line is skipped */
      }
    }
    return state;
  }
  claim(requestId: string): boolean {
    const id = text(requestId, 80);
    return this.locked(() => {
      if (this.state(id) === "open") return false;
      const line: ClaimLine = {
        schema: "mu.router-claim/v1",
        requestId: id,
        state: "open",
        at: new Date().toISOString(),
      };
      appendFileSync(this.claimsFile, `${JSON.stringify(line)}\n`);
      return true;
    });
  }
  release(requestId: string) {
    const id = text(requestId, 80);
    this.locked(() => {
      const line: ClaimLine = {
        schema: "mu.router-claim/v1",
        requestId: id,
        state: "released",
        at: new Date().toISOString(),
      };
      appendFileSync(this.claimsFile, `${JSON.stringify(line)}\n`);
    });
  }
}

/** In-memory sink for tests and short-lived tools (claims are per instance). */
export class MemoryReceiptSink implements ReceiptSink {
  receipts: RouterReceipt[] = [];
  claims = new Map<string, "open" | "released">();
  write(receipt: RouterReceipt) {
    this.receipts.push(projectReceipt(receipt));
  }
  forRequest(requestId: string) {
    return this.receipts.filter((r) => r.requestId === requestId);
  }
  claim(requestId: string) {
    if (this.claims.get(requestId) === "open") return false;
    this.claims.set(requestId, "open");
    return true;
  }
  release(requestId: string) {
    this.claims.set(requestId, "released");
  }
}

export function routerReceiptSink(root: string): ReceiptSink {
  return new JsonlReceiptSink(receiptsFile(root));
}

function readJsonl(file: string): RouterReceipt[] {
  if (!existsSync(file)) return [];
  const out: RouterReceipt[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.schema === "mu.router-receipt/v1") out.push(r);
    } catch {
      /* a torn line is skipped, never guessed */
    }
  }
  return out;
}

/** Catalogue price for a metered model's tokens; null when the price or the usage is unknown. */
export function catalogueCost(
  modelId: string,
  inputTokens: number | null,
  outputTokens: number | null,
): { usd: number | null; priceAsOf: string | null } {
  const m = catalogue().models.find((x) => x.id === modelId);
  if (!m || m.cost.basis !== "catalogue_price" || inputTokens === null || outputTokens === null)
    return { usd: null, priceAsOf: m?.cost.priceAsOf ?? null };
  const usd =
    (inputTokens * (m.cost.inputUsdPerM ?? 0) + outputTokens * (m.cost.outputUsdPerM ?? 0)) /
    1_000_000;
  return { usd, priceAsOf: m.cost.priceAsOf ?? null };
}

// --- legacy ledgers -----------------------------------------------------------------------------

/** The MiMo ledger lives under the REPO (scripts/llm/mimo.ts mimoLedgerDefault), not the home folder. */
export const mimoLedgerFile = (root: string) =>
  join(root, ".operator-data", "mimo", "ledger.jsonl");

export function legacyMimoReceipts(file: string): RouterReceipt[] {
  if (!existsSync(file)) return [];
  const out: RouterReceipt[] = [];
  let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    n++;
    try {
      const e = JSON.parse(line);
      const ts = Number(e.ts);
      if (!Number.isFinite(ts)) continue;
      const m = modelByProviderId("openrouter", String(e.model ?? ""));
      const at = new Date(ts).toISOString();
      out.push(
        projectReceipt({
          schema: "mu.router-receipt/v1",
          requestId: `mimo-ledger-${ts}-${n}`,
          attempt: 1,
          parentRequestId: null,
          task: "bulk.text",
          caller: `scripts/llm/mimo (${text(e.task, 40) || "unlabelled"})`,
          provider: "openrouter",
          model: m?.id ?? "openrouter/unknown",
          providerModel: typeof e.model === "string" ? e.model : null,
          route: "metered",
          selectedBy: "owner",
          reason: "MIMO_BULK=1 (legacy ledger row)",
          fallbackFrom: null,
          inputTokens: count(e.inputTokens),
          outputTokens: count(e.outputTokens),
          characters: null,
          audioSeconds: null,
          costUsd: count(e.costUsd),
          costBasis: "catalogue_price",
          priceAsOf: "2026-09-25",
          allowance: null,
          latencyMs: count(e.ms) ?? 0,
          outcome: "succeeded",
          errorCode: null,
          httpStatus: null,
          startedAt: at,
          endedAt: at,
          legacy: "mimo-ledger",
        }),
      );
    } catch {
      /* skip a bad line */
    }
  }
  return out;
}

const FLEET_MODEL: Record<string, string> = {
  "deepseek-v4.1-flash": "cline/deepseek-v4.1-flash",
  "gemini-3.8-flash": "cline/gemini-3.8-flash",
  "mimo-v2.6-flash": "cline/mimo-v2.6-flash",
  "muse-spark-1.3": "cline/muse-spark-1.3",
  "space-bunny-alpha": "cline/space-bunny-alpha",
};

export function legacyFleetReceipts(root: string): RouterReceipt[] {
  const file = join(root, ".operator-data", "model-fleet", "receipts.sqlite");
  if (!existsSync(file)) return [];
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const rows = db
      .query(
        "SELECT id, recordedAt, model, providerModel, outcome, elapsedMs, contextTrimmed, inputTokens, outputTokens, costUsd FROM receipts ORDER BY rowid",
      )
      .all() as Array<{
      id: string;
      recordedAt: number;
      model: string;
      providerModel: string | null;
      outcome: string;
      elapsedMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
    }>;
    return rows.map((r) => {
      const end = new Date(Number(r.recordedAt)).toISOString();
      const start = new Date(Number(r.recordedAt) - (Number(r.elapsedMs) || 0)).toISOString();
      const outcome: ReceiptOutcome = OUTCOMES.has(r.outcome as ReceiptOutcome)
        ? (r.outcome as ReceiptOutcome)
        : "failed";
      return projectReceipt({
        schema: "mu.router-receipt/v1",
        requestId: `fleet-${String(r.id)}`,
        attempt: 1,
        parentRequestId: null,
        task: "bulk.text",
        caller: "scripts/cline-bridge (/__cline)",
        provider: "cline",
        model: FLEET_MODEL[r.model] ?? `cline/${String(r.model)}`,
        providerModel: r.providerModel ?? null,
        route: "free",
        selectedBy: "rule",
        reason: "Cline bridge (legacy fleet receipt)",
        fallbackFrom: null,
        inputTokens: count(r.inputTokens),
        outputTokens: count(r.outputTokens),
        characters: null,
        audioSeconds: null,
        costUsd: count(r.costUsd),
        costBasis: "free",
        priceAsOf: null,
        allowance: null,
        latencyMs: Number(r.elapsedMs) || 0,
        outcome,
        errorCode:
          outcome === "succeeded"
            ? null
            : outcome === "timed_out"
              ? "timeout"
              : outcome === "cancelled"
                ? "cancelled"
                : "unknown",
        httpStatus: null,
        startedAt: start,
        endedAt: end,
        legacy: "fleet-sqlite",
      });
    });
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* read-only handle */
    }
  }
}

/**
 * The fleet sqlite row id the Cline bridge writes for a routed attempt (a UUID derived from the
 * router requestId + attempt), so the same call is never counted twice: its router receipt stands
 * and the fleet row is skipped here. Rows written before Stage E2 have random ids and still count.
 */
export function fleetReceiptId(requestId: string, attempt: number): string {
  const h = createHash("sha256").update(`${requestId}#${attempt}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Router receipts plus the reconciled legacy rows, oldest first. `since` is an epoch ms filter. */
export function readAllReceipts(
  root: string,
  options: { since?: number; home?: string } = {},
): RouterReceipt[] {
  const routed = readJsonl(receiptsFile(root));
  // A Cline call written both as a router receipt and a fleet row (E2) counts once.
  const covered = new Set(routed.filter((r) => r.provider === "cline").map((r) => `fleet-${fleetReceiptId(r.requestId, r.attempt)}`));
  const all = [
    ...routed,
    ...legacyMimoReceipts(mimoLedgerFile(root)),
    ...legacyFleetReceipts(root).filter((r) => !covered.has(r.requestId)),
  ];
  const since = options.since ?? 0;
  return all
    .filter((r) => Date.parse(r.startedAt) >= since)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export type ModelUsage = {
  model: string;
  calls: number;
  succeeded: number;
  failures: number;
  fallbacksInto: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of known costs; `unknownCostCalls` says how many calls had no known cost. */
  costUsd: number;
  unknownCostCalls: number;
  lastUsedAt: string | null;
  lastFailure: {
    at: string;
    errorCode: ErrorCode | null;
    httpStatus: number | null;
    outcome: ReceiptOutcome;
  } | null;
};

/** Per-model totals for the Models page and /usage. Unknown cost is counted, never added as 0. */
export function summariseReceipts(receipts: RouterReceipt[]): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {};
  for (const r of receipts) {
    if (NOT_A_CALL.has(r.outcome)) continue;
    const u = (out[r.model] ??= {
      model: r.model,
      calls: 0,
      succeeded: 0,
      failures: 0,
      fallbacksInto: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      unknownCostCalls: 0,
      lastUsedAt: null,
      lastFailure: null,
    });
    u.calls++;
    if (r.outcome === "succeeded") u.succeeded++;
    else {
      u.failures++;
      if (!u.lastFailure || r.endedAt > u.lastFailure.at)
        u.lastFailure = {
          at: r.endedAt,
          errorCode: r.errorCode,
          httpStatus: r.httpStatus,
          outcome: r.outcome,
        };
    }
    if (r.fallbackFrom) u.fallbacksInto++;
    u.inputTokens += r.inputTokens ?? 0;
    u.outputTokens += r.outputTokens ?? 0;
    if (r.costUsd === null) u.unknownCostCalls++;
    else u.costUsd += r.costUsd;
    if (!u.lastUsedAt || r.startedAt > u.lastUsedAt) u.lastUsedAt = r.startedAt;
  }
  return out;
}

/** Metered spend this period by provider, from receipts (a floor: calls outside the router aren't here). */
export function meteredSpendByProvider(
  receipts: RouterReceipt[],
): Record<
  string,
  { calls: number; costUsd: number; unknownCostCalls: number; byTask: Record<string, number> }
> {
  const out: Record<
    string,
    { calls: number; costUsd: number; unknownCostCalls: number; byTask: Record<string, number> }
  > = {};
  for (const r of receipts) {
    if (r.route !== "metered" || NOT_A_CALL.has(r.outcome)) continue;
    const p = (out[r.provider] ??= { calls: 0, costUsd: 0, unknownCostCalls: 0, byTask: {} });
    p.calls++;
    if (r.costUsd === null) p.unknownCostCalls++;
    else p.costUsd += r.costUsd;
    const label = r.caller.match(/\(([^)]+)\)$/)?.[1] ?? r.task;
    p.byTask[label] = (p.byTask[label] ?? 0) + 1;
  }
  return out;
}

/** Guard used by tests and the UI: the catalogue model a receipt names, or null. */
export function receiptModel(r: RouterReceipt) {
  try {
    return catalogueModel(r.model);
  } catch {
    return null;
  }
}

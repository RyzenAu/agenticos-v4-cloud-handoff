// scripts/model-router/router.ts — route(taskClass, constraints) and runRouted() (TARGET-ARCHITECTURE §3.5 + V7).
//
// Rules, in the order they bite:
//   1. The model selected for the task runs: the owner's/Jev's explicit choice, else the task's first
//      candidate (selectedBy "rule"). A metered PRIMARY runs only when explicitly selected (task
//      `selectable`) or configured as the task's primary (`metered: "configured"`, e.g. Jev).
//   2. If the selected model is unavailable or limited (health, missing key, window >= 95%, or the
//      call itself fails with a limit/outage), fall back AUTOMATICALLY along the task's candidate chain
//      and record fallbackFrom. Owner, 28 Sep: the chain may include paid models (OpenRouter DeepSeek,
//      MiMo) and Cline models, and data use is not a routing concern ("it's all my data").
//   3. Free-only workflows (freeOnly) consider free routes only; a subscription is not free.
//   4. No routing decision is made on whether a provider trains on or retains prompts.
//   5. No in-app caps (V7): exhaustion is a failure with the provider's reason, never a budget check.
//   6. Never replay a step that may already have succeeded. Each run first CLAIMS its requestId
//      atomically in the sink (one holder, across processes); a claimed id is refused. The claim is
//      released only when every attempt was sent:false (the provider certainly did no work). A
//      side-effecting task never falls back or retries once an attempt may have reached the provider
//      (5xx, transport error, timeout, cancel after send). A sink without history or claims is refused.
//   7. A "free tier" with unverified billing (Gemini) is never an AUTOMATIC fallback (cost truth).
//   7b. (E2) A task's declared `lastResort` models run only after every candidate, in order, each
//      receipted with its real route (e.g. Codex subscription after the free Groq models).
//   8. Every attempt, refusal and exhaustion writes a Receipt (with `sent`) through the ReceiptSink.
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerKey } from "../provider-config";
import {
  catalogue,
  catalogueModel,
  catalogueProvider,
  catalogueTask,
  type CatalogueModel,
  type CatalogueTask,
  type Modality,
  type Route,
} from "./catalogue";
import { currentAllowance, type Allowance } from "./allowance";
import { unavailableReason, type HealthStore } from "./health";
import {
  catalogueCost,
  NOT_A_CALL,
  type ErrorCode,
  type ReceiptOutcome,
  type ReceiptSink,
  type RouterReceipt,
  type SelectedBy,
} from "./receipts";

export type { Allowance } from "./allowance";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type RouteConstraints = {
  /** An explicit model choice (owner in the UI, Jev's delegate, or a configured opt-in like MIMO_BULK). */
  selected?: string;
  selectedBy?: SelectedBy;
  freeOnly?: boolean;
  needs?: { tools?: boolean; input?: Modality[] };
  /** Providers this caller can actually invoke; others are skipped (not an error in the catalogue). */
  providers?: string[];
  /** Catalogue ids already tried in this request. */
  exclude?: string[];
  health?: HealthStore;
  /** Key presence by NAME (never reads values into the router). Defaults to the OS config lookup. */
  hasKey?: (name: string) => boolean;
  /** Latest cached subscription window for a provider (no extra call is made to read it). Defaults to the
   * latest /usage snapshot published by the ai-usage service (allowance.ts); null = unknown, never blocks. */
  allowance?: (provider: string) => Allowance | null;
  now?: number;
};

export type RouteChoice = {
  provider: string;
  model: string;
  providerModel: string;
  route: Route;
  reason: string;
  selectedBy: SelectedBy;
  fallbackFrom: string | null;
  allowance: Allowance | null;
  skipped: { model: string; why: string }[];
  /** (E2) true when this is one of the task's declared last-resort models. */
  lastResort?: boolean;
};

export type RouteErrorCode = "unknown_task" | "refused_policy" | "exhausted_free";

export class RouteError extends Error {
  constructor(
    public code: RouteErrorCode,
    message: string,
    public skipped: { model: string; why: string }[] = [],
    public selected: string | null = null,
  ) {
    super(message);
  }
}

const SUBSCRIPTION_LIMIT_PCT = 95;

function defaultHasKey(name: string) {
  return !!providerKey(ROOT, name);
}

/**
 * May this model be an automatic fallback for this task? Always true for the primary. A free-tier model with
 * unverified billing is allowed only where the fallback pre-dates the router (task.preExistingFallbacks):
 * E1/E2 never remove or narrow a fallback that existed before, and never add a new cost-unverified one.
 */
export function fallbackAllowed(
  m: Pick<CatalogueModel, "id" | "route" | "verifiedFree">,
  task: Pick<CatalogueTask, "preExistingFallbacks">,
  asFallback: boolean,
): boolean {
  if (!asFallback || m.route !== "free" || m.verifiedFree) return true;
  return task.preExistingFallbacks?.includes(m.id) ?? false;
}

/** Why this model can't run now (null = it can). `asFallback` applies the paid->free-only rule. */
function ineligible(
  m: CatalogueModel,
  task: CatalogueTask,
  taskName: string,
  c: RouteConstraints,
  asFallback: boolean,
  isConfiguredPrimary: boolean,
): string | null {
  const now = c.now ?? Date.now();
  if (c.exclude?.includes(m.id)) return "failed earlier in this request";
  if (m.status === "stale" || m.status === "excluded" || m.status === "not-configured")
    return `${m.status} in the catalogue`;
  if (c.providers && !c.providers.includes(m.provider))
    return `this caller can't call ${m.provider}`;
  if (asFallback && task.noFreeFallback) return task.noFreeFallback;
  // Cost truth, not privacy: a "free tier" whose billing link is unverified could be billed while recorded as
  // free, so the router never ADDS it as an automatic fallback. Fallbacks that existed before the router
  // (task.preExistingFallbacks) are kept exactly as they were, with honest receipts (cost unknown).
  if (!fallbackAllowed(m, task, asFallback))
    return "free tier, billing unverified: not an automatic fallback";
  if ((task.freeOnly || c.freeOnly) && m.route !== "free")
    return `free-only workflow (${m.route} route)`;
  if (m.route === "metered" && !asFallback) {
    const chosen =
      c.selected === m.id && (task.selectable?.includes(m.id) || task.candidates.includes(m.id));
    if (!chosen && !isConfiguredPrimary) return "metered and not selected for this task";
  }
  if ((c.needs?.tools || task.needsTools) && !m.tools) return "needs tools";
  if (c.needs?.input?.some((x) => !m.modality.in.includes(x)))
    return `needs ${c.needs.input.join("+")} input`;
  const provider = catalogueProvider(m.provider);
  const hasKey = c.hasKey ?? defaultHasKey;
  if (provider.keyNames.length && !provider.keyNames.some((n) => hasKey(n)))
    return `not configured (${provider.keyNames.join(" / ")} missing)`;
  if (c.health) {
    const why = unavailableReason(c.health.model(m.id), now);
    if (why) return why;
  }
  // BL3 (REVIEW-E12): the >= 95% skip is an in-app threshold; tasks whose site always tried before
  // (alwaysTry) and tasks with no substitute (noFreeFallback) only RECORD the allowance, never skip on it.
  if (m.route === "subscription" && !task.alwaysTry && !task.noFreeFallback) {
    const a = (c.allowance ?? ((p: string) => currentAllowance(p, now)))(m.provider);
    if (a && a.usedPct !== null && a.usedPct >= SUBSCRIPTION_LIMIT_PCT) {
      const reset = a.resetsAt
        ? ` (resets ${new Date(a.resetsAt).toLocaleString("en-AU", { weekday: "short", hour: "2-digit", minute: "2-digit" })})`
        : "";
      return `${a.plan} ${a.window} at ${Math.round(a.usedPct)}%${reset}`;
    }
  }
  return null;
}

/**
 * Pick the model for a task. Returns the selected model when it can run, else the first eligible
 * free fallback (with fallbackFrom), else throws RouteError("exhausted_free") naming every reason.
 */
export function route(taskClass: string, constraints: RouteConstraints = {}): RouteChoice {
  const task = catalogueTask(taskClass);
  if (!task) throw new RouteError("unknown_task", `No router task called ${taskClass}.`);
  const c = constraints;
  if (
    c.selected &&
    !task.candidates.includes(c.selected) &&
    !(task.selectable ?? []).includes(c.selected)
  )
    throw new RouteError(
      "refused_policy",
      `${c.selected} is not a model for ${taskClass}.`,
      [],
      c.selected,
    );
  const primaryId = c.selected ?? task.candidates[0];
  const selectedBy: SelectedBy = c.selected ? (c.selectedBy ?? "owner") : "rule";
  const lastResorts = (task.lastResort ?? []).filter((id) => id !== primaryId && !task.candidates.includes(id));
  const order = [primaryId, ...task.candidates.filter((id) => id !== primaryId), ...lastResorts];
  const firstLastResort = order.length - lastResorts.length;
  const skipped: { model: string; why: string }[] = [];
  for (let i = 0; i < order.length; i++) {
    const m = catalogueModel(order[i]);
    const asFallback = i > 0;
    const isLastResort = i >= firstLastResort;
    const configuredPrimary = !c.selected && i === 0 && task.metered === "configured";
    const why = ineligible(m, task, taskClass, c, asFallback, configuredPrimary);
    if (why) {
      skipped.push({ model: m.id, why });
      continue;
    }
    const allowance =
      m.route === "subscription"
        ? ((c.allowance ?? ((p: string) => currentAllowance(p, c.now ?? Date.now())))(m.provider) ??
          null)
        : null;
    const kind =
      m.route === "free"
        ? m.verifiedFree
          ? "free"
          : "free-tier (billing unverified, pre-existing)"
        : m.route;
    const reason = isLastResort
      ? `${primaryId} and every candidate unavailable (${skipped[0]?.why ?? "failed"}); last resort ${m.id} (${kind})`
      : asFallback
      ? `${primaryId} unavailable (${skipped[0]?.why ?? "failed"}); fell back to ${kind} ${m.id}`
      : selectedBy === "rule"
        ? `${taskClass}: first candidate`
        : `${taskClass}: selected by ${selectedBy}`;
    return {
      provider: m.provider,
      model: m.id,
      providerModel: m.providerModel,
      route: m.route,
      reason,
      selectedBy,
      fallbackFrom: asFallback ? primaryId : null,
      allowance,
      skipped,
      lastResort: isLastResort,
    };
  }
  const detail = skipped.map((s) => `${s.model}: ${s.why}`).join("; ");
  throw new RouteError(
    "exhausted_free",
    `${taskClass}: no eligible model. ${task.onExhausted} [${detail}]`,
    skipped,
    primaryId,
  );
}

// --- running -----------------------------------------------------------------------------------

/**
 * A provider failure, classified. `sent`: false = the provider refused before doing the work (safe
 * to fall back); "unknown" = the request may have been executed (never replayed on a side-effecting task).
 */
export class ProviderError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public opts: {
      httpStatus?: number | null;
      sent: false | "unknown";
      retryAfterMs?: number | null;
      /** This site's pre-router rule says this failure ends the chain (e.g. Gemini flash on a 401/403). */
      stop?: boolean;
      /** Provider-reported cost of a call that RAN but failed (e.g. an empty reply). */
      costUsd?: number | null;
    } = { sent: "unknown" },
  ) {
    super(message);
  }
}

export class ReplayRefused extends Error {
  constructor(
    public requestId: string,
    public prior: ReceiptOutcome | "claimed",
  ) {
    super(
      prior === "claimed"
        ? `Not run: request ${requestId} is already claimed (running now, done, or its outcome is unknown).`
        : `Not run again: request ${requestId} may already have succeeded (${prior}).`,
    );
  }
}

export class MaybeExecuted extends Error {
  constructor(
    public model: string,
    public code: ErrorCode,
  ) {
    super(
      `${model} failed after the request may have run (${code}); not retried or replayed on another model.`,
    );
  }
}

/** The sink can't enforce no-replay (missing history or claims): nothing is run. */
export class SinkRefused extends Error {
  constructor() {
    super(
      "Receipt sink can't enforce the no-replay rule (forRequest, claim and release are required); not run.",
    );
  }
}

export type InvokeResult<T> = {
  value: T;
  providerModel?: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    characters?: number | null;
    audioSeconds?: number | null;
  };
  /** Provider-reported cost in USD (e.g. OpenRouter usage.cost). Wins over any catalogue figure, on every route. */
  costUsd?: number | null;
  /** HTTP status of the successful reply, when the transport is HTTP. */
  httpStatus?: number | null;
};

export type RunRequest<T> = {
  task: string;
  caller: string;
  requestId?: string;
  parentRequestId?: string | null;
  constraints?: RouteConstraints;
  sink: ReceiptSink;
  invoke: (choice: RouteChoice, signal: AbortSignal) => Promise<InvokeResult<T>>;
  signal?: AbortSignal;
  /** Override the task's sideEffects flag (only ever to be MORE careful). */
  sideEffects?: boolean;
  clock?: () => number;
};

export type RunResult<T> = {
  value: T;
  receipt: RouterReceipt;
  choice: RouteChoice;
  attempts: RouterReceipt[];
};

const TEXT_MAYBE_DONE = new Set<ReceiptOutcome>([
  "succeeded",
  "timed_out",
  "termination_unverified",
]);

/** Did this earlier row possibly do the step's work? Legacy rows without `sent` count as sent. */
function mayHaveRun(r: RouterReceipt, sideEffects: boolean): boolean {
  if (NOT_A_CALL.has(r.outcome)) return false;
  if (r.outcome === "succeeded") return true;
  if (r.sent === false) return false;
  return sideEffects || TEXT_MAYBE_DONE.has(r.outcome);
}

function toProviderError(error: unknown, aborted: boolean): ProviderError {
  if (error instanceof ProviderError) return error;
  if (aborted) return new ProviderError("cancelled", "cancelled", { sent: "unknown" });
  const name = (error as { name?: string })?.name ?? "";
  if (name === "TimeoutError")
    return new ProviderError("timeout", "timed out", { sent: "unknown" });
  if (name === "AbortError")
    return new ProviderError("cancelled", "cancelled", { sent: "unknown" });
  return new ProviderError("transport", "transport failure", { sent: "unknown" });
}

function outcomeFor(code: ErrorCode): ReceiptOutcome {
  if (code === "cancelled") return "cancelled";
  if (code === "timeout") return "timed_out";
  if (code === "rate_limited" || code === "quota_exhausted" || code === "insufficient_funds")
    return "rate_limited";
  if (code === "policy") return "refused_policy";
  return "failed";
}

/** How long a failed model sits out (health). No budget logic: provider signals only. */
function sitOut(
  code: ErrorCode,
  retryAfterMs: number | null | undefined,
): { state: "limited" | "exhausted" | "down"; ms: number } | null {
  switch (code) {
    case "rate_limited":
      return { state: "limited", ms: retryAfterMs ?? 60_000 };
    case "quota_exhausted":
      return { state: "limited", ms: retryAfterMs ?? 30 * 60_000 };
    case "insufficient_funds":
      return { state: "exhausted", ms: 30 * 60_000 };
    case "auth":
      return { state: "down", ms: 30 * 60_000 };
    case "not_found":
      return { state: "down", ms: 6 * 3_600_000 };
    case "unavailable":
      return { state: "down", ms: retryAfterMs ?? 60_000 };
    default:
      return null;
  }
}

type Cost = Pick<RouterReceipt, "costUsd" | "costBasis" | "priceAsOf">;

function costFor(
  choice: RouteChoice,
  result: InvokeResult<unknown> | null,
  failure: ProviderError | null,
): Cost {
  // Provider-reported cost wins on every route (a ":free" call OpenRouter did charge must show).
  if (typeof result?.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0)
    return { costUsd: result.costUsd, costBasis: "provider_reported", priceAsOf: null };
  if (typeof failure?.opts.costUsd === "number" && Number.isFinite(failure.opts.costUsd) && failure.opts.costUsd >= 0)
    return { costUsd: failure.opts.costUsd, costBasis: "provider_reported", priceAsOf: null };
  // Refused before doing any work: known to cost nothing.
  if (failure && failure.opts.sent === false)
    return { costUsd: 0, costBasis: "refused_before_work", priceAsOf: null };
  const model = catalogueModel(choice.model);
  if (choice.route === "free")
    return model.verifiedFree
      ? { costUsd: 0, costBasis: "free", priceAsOf: null }
      : { costUsd: null, costBasis: "free_tier_unverified", priceAsOf: null };
  if (choice.route === "subscription")
    return { costUsd: null, costBasis: "subscription_allowance", priceAsOf: null };
  if (failure) return { costUsd: null, costBasis: "unknown", priceAsOf: null };
  if (model.cost.basis === "catalogue_price") {
    const { usd, priceAsOf } = catalogueCost(
      model.id,
      result?.usage?.inputTokens ?? null,
      result?.usage?.outputTokens ?? null,
    );
    return { costUsd: usd, costBasis: usd === null ? "unknown" : "catalogue_price", priceAsOf };
  }
  return {
    costUsd: null,
    costBasis: model.cost.basis === "credits" ? "credits" : "unknown",
    priceAsOf: null,
  };
}

/** A receipt model for a refusal row, even when the id is not in the catalogue. */
function refusalModel(
  id: string | null,
  fallback: string,
): { provider: string; id: string; route: Route } {
  try {
    const m = catalogueModel(id ?? fallback);
    return { provider: m.provider, id: m.id, route: m.route };
  } catch {
    const m = catalogueModel(fallback);
    return { provider: m.provider, id: String(id).slice(0, 80), route: m.route };
  }
}

/**
 * Run one step through the router. Returns the value and the receipt of the attempt that succeeded;
 * throws RouteError / ProviderError / MaybeExecuted / ReplayRefused / SinkRefused otherwise, each after
 * its receipt (SinkRefused writes none: the sink can't be trusted).
 */
export async function runRouted<T>(req: RunRequest<T>): Promise<RunResult<T>> {
  const clock = req.clock ?? Date.now;
  const requestId = req.requestId ?? randomUUID();
  const task = catalogueTask(req.task);
  if (!task) throw new RouteError("unknown_task", `No router task called ${req.task}.`);
  const sink = req.sink as Partial<ReceiptSink> | undefined;
  if (
    !sink ||
    typeof sink.write !== "function" ||
    typeof sink.forRequest !== "function" ||
    typeof sink.claim !== "function" ||
    typeof sink.release !== "function"
  )
    throw new SinkRefused();
  const sideEffects = req.sideEffects === true || task.sideEffects;
  const c = { ...(req.constraints ?? {}) };
  const attempts: RouterReceipt[] = [];
  const base = {
    schema: "mu.router-receipt/v1" as const,
    requestId,
    parentRequestId: req.parentRequestId ?? null,
    task: req.task,
    caller: req.caller,
  };
  const write = async (r: RouterReceipt) => {
    attempts.push(r);
    // H1 (REVIEW-E12): receipt I/O is best-effort. A failed write (EBUSY/EPERM on Windows) is logged and
    // the call goes on; a good answer is never thrown away for it. The claim already guards replay.
    try {
      await req.sink.write(r);
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? (error as Error)?.name ?? "error").slice(0, 40);
      console.warn(`[model-router] receipt write failed (${code}) for ${r.task} ${r.model} ${r.outcome}; continuing`);
    }
  };
  const noCall = (
    at: string,
  ): Pick<
    RouterReceipt,
    | "providerModel"
    | "fallbackFrom"
    | "inputTokens"
    | "outputTokens"
    | "characters"
    | "audioSeconds"
    | "costUsd"
    | "costBasis"
    | "priceAsOf"
    | "allowance"
    | "latencyMs"
    | "httpStatus"
    | "startedAt"
    | "endedAt"
    | "sent"
  > => ({
    providerModel: null,
    fallbackFrom: null,
    inputTokens: null,
    outputTokens: null,
    characters: null,
    audioSeconds: null,
    costUsd: 0,
    costBasis: "refused_before_work",
    priceAsOf: null,
    allowance: null,
    latencyMs: 0,
    httpStatus: null,
    startedAt: at,
    endedAt: at,
    sent: false,
  });

  // Rule 6: take the requestId atomically BEFORE reading history or calling anything. A requestId this
  // call generated itself has no history and no other holder, so the history read and the claim (both
  // read files that grow with use, on the live voice path before every Jev reflex) are skipped; any
  // later reuse of that id by a caller is checked against its receipts as usual.
  const fresh = !req.requestId;
  const prior = fresh ? [] : await req.sink.forRequest(requestId);
  const nextAttempt = () =>
    Math.max(0, ...prior.map((r) => r.attempt), ...attempts.map((r) => r.attempt)) + 1;
  const refuseReplay = async (why: ReceiptOutcome | "claimed", like: RouterReceipt | null) => {
    const m = like
      ? { provider: like.provider, id: like.model, route: like.route }
      : refusalModel(c.selected ?? null, task.candidates[0]);
    await write({
      ...base,
      ...noCall(new Date(clock()).toISOString()),
      attempt: nextAttempt(),
      provider: m.provider,
      model: m.id,
      route: m.route,
      selectedBy: like?.selectedBy ?? (c.selected ? (c.selectedBy ?? "owner") : "rule"),
      reason:
        why === "claimed"
          ? "refused: this requestId is already claimed (running, done or unknown)"
          : `refused: this step already ${why === "succeeded" ? "succeeded" : `ended ${why} and may have succeeded`}`,
      outcome: "replay_refused",
      errorCode: "replay",
    });
    throw new ReplayRefused(requestId, why);
  };
  if (!fresh && !(await req.sink.claim(requestId))) return refuseReplay("claimed", prior.at(-1) ?? null);
  const done = prior.find((r) => mayHaveRun(r, sideEffects));
  if (done) return refuseReplay(done.outcome, done); // claim stays held: this step never runs again

  let released = false;
  const releaseIfNothingSent = async () => {
    if (released || attempts.some((r) => r.sent !== false)) return;
    released = true;
    if (fresh) return;
    await req.sink.release(requestId);
  };
  const exhausted = async (
    message: string,
    code: "exhausted_free" | "refused_policy",
    selected: string | null,
    origin: string | null,
  ) => {
    const m = refusalModel(origin ?? selected, task.candidates[0]);
    await write({
      ...base,
      ...noCall(new Date(clock()).toISOString()),
      attempt: nextAttempt(),
      provider: m.provider,
      model: m.id,
      route: m.route,
      selectedBy: c.selected ? (c.selectedBy ?? "owner") : "rule",
      reason: message.slice(0, 240),
      outcome: code,
      errorCode: code === "refused_policy" ? "policy" : "no_eligible_model",
    });
  };

  try {
    const tried: string[] = [];
    let origin: string | null = null;
    // At most one attempt per model the task could reach (candidates plus an explicitly selected one).
    for (let tries = 0; tries <= task.candidates.length + (task.lastResort?.length ?? 0); tries++) {
      let choice: RouteChoice;
      try {
        choice = route(req.task, { ...c, exclude: [...(c.exclude ?? []), ...tried] });
      } catch (error) {
        if (!(error instanceof RouteError)) throw error;
        await exhausted(
          error.message,
          error.code === "refused_policy" ? "refused_policy" : "exhausted_free",
          error.selected,
          origin,
        );
        throw error;
      }
      // route() reports fallbackFrom as the selected model whenever it had to pick another one.
      if (origin === null) origin = choice.fallbackFrom ?? choice.model;

      const controller = new AbortController();
      const signal = req.signal
        ? AbortSignal.any([req.signal, controller.signal])
        : controller.signal;
      const started = clock();
      let result: InvokeResult<T> | null = null;
      let failure: ProviderError | null = null;
      try {
        if (req.signal?.aborted)
          throw new ProviderError("cancelled", "cancelled before start", { sent: false });
        result = await req.invoke(choice, signal);
      } catch (error) {
        failure = toProviderError(error, !!req.signal?.aborted);
      }
      const ended = clock();
      const receipt: RouterReceipt = {
        ...base,
        attempt: nextAttempt(),
        provider: choice.provider,
        model: choice.model,
        providerModel: result ? (result.providerModel ?? null) : null,
        route: choice.route,
        selectedBy: choice.selectedBy,
        reason: choice.reason,
        fallbackFrom: choice.fallbackFrom,
        inputTokens: result?.usage?.inputTokens ?? null,
        outputTokens: result?.usage?.outputTokens ?? null,
        characters: result?.usage?.characters ?? null,
        audioSeconds: result?.usage?.audioSeconds ?? null,
        ...costFor(choice, result, failure),
        allowance: choice.allowance
          ? {
              plan: choice.allowance.plan,
              window: choice.allowance.window,
              usedPct: choice.allowance.usedPct,
            }
          : null,
        latencyMs: Math.max(0, ended - started),
        outcome: failure ? outcomeFor(failure.code) : "succeeded",
        errorCode: failure ? failure.code : null,
        httpStatus: failure ? (failure.opts.httpStatus ?? null) : (result?.httpStatus ?? null),
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString(),
        sent: failure ? failure.opts.sent !== false : true,
      };
      await write(receipt);

      if (!failure && result) {
        if (c.health && c.health.model(choice.model).state !== "ok")
          c.health.markModel(choice.model, { state: "ok", until: null, detail: null });
        return { value: result.value, receipt, choice, attempts };
      }
      const f = failure!;
      const out = sitOut(f.code, f.opts.retryAfterMs);
      if (out && c.health)
        c.health.markModel(choice.model, {
          state: out.state,
          until: new Date(ended + out.ms).toISOString(),
          lastFailure: {
            at: receipt.endedAt,
            errorCode: f.code,
            httpStatus: f.opts.httpStatus ?? null,
          },
          detail: f.opts.httpStatus ? `HTTP ${f.opts.httpStatus}` : f.code,
        });
      // Rule 6: once a side-effecting attempt may have reached the provider, stop: no retry, no fallback.
      if (f.opts.sent !== false && sideEffects) throw new MaybeExecuted(choice.model, f.code);
      // BL2 (REVIEW-E12): a 400/413/422 is specific to the model that refused it (a Hermes 400 is not a
      // Gemini 400), so a read-only task continues down its chain, as every site did before the router.
      // A side-effecting task, a cancel, a policy refusal, or a site rule that says stop (f.opts.stop) ends it.
      if (f.code === "cancelled" || f.code === "policy" || f.opts.stop || (f.code === "bad_request" && sideEffects)) throw f;
      tried.push(choice.model);
    }
    const message = `${req.task}: every eligible model failed. ${task.onExhausted}`;
    await exhausted(message, "exhausted_free", c.selected ?? null, origin);
    throw new RouteError("exhausted_free", message, [], origin);
  } catch (error) {
    await releaseIfNothingSent();
    throw error;
  }
}

/** The whole catalogue, for the Models page and tests. */
export function routerCatalogue() {
  return catalogue();
}

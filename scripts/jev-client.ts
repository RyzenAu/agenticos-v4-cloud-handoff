// scripts/jev-client.ts — THE Jev client (TARGET-ARCHITECTURE §3.4). Every TypeSafe Jev decision in
// the OS goes through jevDecide(): one endpoint, the model id from the catalogue, one timeout policy
// per surface, bounded retries on 429/5xx inside that surface's budget, and a router receipt per
// decision (task jev.decision, or approval.guardian for Hermes' approvals) with the HTTP status.
//
// Jev is a metered "System One" model: typed decisions (choice / score / noul) in ~70-500 ms. There is
// no free substitute for a calibrated typed decision, so when Jev is out the caller falls back to its
// own rules (the router records exhausted_free); nothing is ever routed to a language model here.
// No in-app caps (V7). A missing key means no call, so no receipt.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validJevAnswers } from "./jev-answer-validation";
import { providerModelId } from "./model-router/catalogue";
import { httpProviderError } from "./model-router/clients";
import { callHealth, defaultReceiptSink, defaultRequest } from "./model-router/defaults";
import type { HealthStore } from "./model-router/health";
import type { ReceiptSink, RouterReceipt } from "./model-router/receipts";
import { ProviderError, runRouted } from "./model-router/router";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** From the catalogue (typesafe/jev-latest): the one place model ids live. */
export const JEV_MODEL = providerModelId("typesafe/jev-latest");

export type JevAnswer = { type?: string; choice?: string; noul?: number; score?: number; confidence?: number; probabilities?: Record<string, number> };
export type JevAnswers = Record<string, JevAnswer>;

type Policy = { budgetMs: number; retries: number; task?: "jev.decision" | "approval.guardian" };

/**
 * One timeout policy per surface: `budgetMs` bounds the whole decision including retries (the
 * pre-router per-call timeouts, unchanged); `retries` is the most extra attempts on a 429 or 5xx,
 * each only if it still fits in the budget. Live voice and screen paths keep 0-1 retries so a slow
 * provider never adds latency past what they already allowed.
 */
export const JEV_SURFACES = {
  "voice.reflex": { budgetMs: 1500, retries: 1 },
  "voice.router": { budgetMs: 1200, retries: 1 },
  "hermes.plan": { budgetMs: 1200, retries: 1 },
  "hermes.guardian": { budgetMs: 2500, retries: 1, task: "approval.guardian" },
  "away.route": { budgetMs: 1200, retries: 1 },
  /** The command controller's one decision for a request no exact rule planned (scripts/jev-controller.ts). */
  "command.controller": { budgetMs: 1500, retries: 1 },
  "inbox.triage": { budgetMs: 2500, retries: 2 },
  "crm.duplicates": { budgetMs: 4000, retries: 2 },
  "leads.phone": { budgetMs: 6000, retries: 2 },
  "meeting.objection": { budgetMs: 1000, retries: 0 },
  "screen.verify": { budgetMs: 1500, retries: 1 },
  "screen.point": { budgetMs: 1500, retries: 1 },
  "screen.control": { budgetMs: 2500, retries: 1 },
  "screen.choose": { budgetMs: 2500, retries: 1 },
  "screen.step": { budgetMs: 2500, retries: 1 },
  "screen.fill": { budgetMs: 2500, retries: 1 },
  "screen.irreversible": { budgetMs: 1500, retries: 1 },
  "screen.lesson": { budgetMs: 3000, retries: 1 },
  bench: { budgetMs: 5000, retries: 0 },
} satisfies Record<string, Policy>;
export type JevSurface = keyof typeof JEV_SURFACES;

export type JevCall = {
  surface: JevSurface;
  /** The TypeSafe key (TYPESAFE_API_KEY / JEV_API_KEY), read by NAME by the caller. Never logged. */
  key: string;
  state: unknown;
  questions: Record<string, unknown>;
  /** Extra top-level body fields, if a surface needs them. `model` is always the catalogue's. */
  extra?: Record<string, unknown>;
  /** Receipt caller, e.g. "scripts/jev.ts". The surface is appended. */
  caller?: string;
  /** Overrides the surface budget (a caller's own timeoutMs option); never loosens retries. */
  timeoutMs?: number;
  request?: typeof fetch;
  signal?: AbortSignal;
  root?: string;
  sink?: ReceiptSink;
  health?: HealthStore;
  requestId?: string;
  parentRequestId?: string | null;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type JevOk = { ok: true; answers: JevAnswers; ms: number; httpStatus: number; attempts: number; receipt: RouterReceipt; raw: unknown };
export type JevFail = { ok: false; reason: "no-key" | "unavailable" | "http" | "timeout" | "cancelled" | "unreadable"; httpStatus: number | null; ms: number; receipt: RouterReceipt | null };
export type JevOutcome = JevOk | JevFail;

// TypeSafe also documents 529 for overload; it uses the same bounded budget.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One Jev decision. Never throws: a failure is a JevFail (with its receipt) and the caller uses its own rules. */
export async function jevDecide(call: JevCall): Promise<JevOutcome> {
  const clock = call.clock ?? Date.now;
  const started = clock();
  const policy: Policy = JEV_SURFACES[call.surface];
  if (!call.key) return { ok: false, reason: "no-key", httpStatus: null, ms: 0, receipt: null };
  const root = call.root ?? ROOT;
  const budget = call.timeoutMs ?? policy.budgetMs;
  const request = defaultRequest(call.request);
  const sleep = call.sleep ?? sleepMs;
  const target = call.sink ?? defaultReceiptSink(root);
  let written: RouterReceipt | null = null;
  const sink: ReceiptSink = {
    write: (r) => {
      written = r;
      return target.write(r);
    },
    forRequest: (id) => target.forRequest(id),
    claim: (id) => target.claim(id),
    release: (id) => target.release(id),
  };
  let lastStatus: number | null = null;
  let attempts = 0;
  let raw: unknown = null;
  let failed: ProviderError | null = null;
  const fail = (e: ProviderError) => {
    failed = e;
    return e;
  };
  try {
    const run = await runRouted<JevAnswers>({
      task: policy.task ?? "jev.decision",
      caller: `${call.caller ?? "scripts/jev-client"} (${call.surface})`,
      requestId: call.requestId,
      parentRequestId: call.parentRequestId,
      sink,
      clock,
      signal: call.signal,
      constraints: { providers: ["typesafe"], hasKey: () => true, health: call.health ?? callHealth(root) },
      invoke: async (choice, signal) => {
        const body = JSON.stringify({ ...(call.extra ?? {}), model: choice.providerModel, state: call.state, questions: call.questions });
        for (;;) {
          attempts++;
          const left = budget - (clock() - started);
          if (left <= 0) throw fail(new ProviderError("timeout", "over the surface budget", { sent: attempts > 1 ? "unknown" : false, httpStatus: lastStatus }));
          let res: Response;
          try {
            res = await request(JEV_URL, {
              method: "POST",
              headers: { Authorization: `Bearer ${call.key}`, "Content-Type": "application/json" },
              body,
              signal: AbortSignal.any([signal, AbortSignal.timeout(left)]),
            });
          } catch (error) {
            if (signal.aborted) throw fail(new ProviderError("cancelled", "cancelled", { sent: "unknown" }));
            if ((error as { name?: string })?.name === "TimeoutError") throw fail(new ProviderError("timeout", "timed out", { sent: "unknown" }));
            throw fail(new ProviderError("transport", "transport failure", { sent: "unknown" }));
          }
          lastStatus = res.status;
          if (res.ok) {
            raw = await res.json().catch(() => null);
            const answers = (raw as { answers?: unknown } | null)?.answers;
            if (!validJevAnswers(call.questions, answers)) throw fail(new ProviderError("unknown", "unreadable reply", { httpStatus: res.status, sent: "unknown" }));
            const usage = (raw as { usage?: { input_tokens?: number; prompt_tokens?: number } })?.usage;
            const input = usage?.input_tokens ?? usage?.prompt_tokens;
            return { value: answers as JevAnswers, httpStatus: res.status, providerModel: typeof (raw as { model?: unknown })?.model === "string" ? String((raw as { model: string }).model).slice(0, 80) : null, usage: { inputTokens: typeof input === "number" ? input : null, outputTokens: typeof input === "number" ? 0 : null } };
          }
          const text = await res.text().catch(() => "");
          const failure = httpProviderError(res.status, text, res.headers);
          // Bounded backoff: only on 429/5xx, only within the retry count and the surface budget.
          const backoff = Math.min(failure.opts.retryAfterMs ?? 100 * 2 ** (attempts - 1), 1000);
          if (!RETRYABLE.has(res.status) || attempts > policy.retries || clock() - started + backoff + 50 >= budget) throw fail(failure);
          await sleep(backoff);
        }
      },
    });
    return { ok: true, answers: run.value, ms: clock() - started, httpStatus: lastStatus ?? 200, attempts, receipt: run.receipt, raw };
  } catch (error) {
    // The provider's own failure (if a call was made) explains it; otherwise the route was unavailable.
    const cause: ProviderError | null = failed ?? (error instanceof ProviderError ? error : null);
    const reason: JevFail["reason"] = !cause
      ? "unavailable"
      : cause.code === "timeout"
        ? "timeout"
        : cause.code === "cancelled"
          ? "cancelled"
          : cause.code === "unknown" && lastStatus !== null && lastStatus < 300
            ? "unreadable"
            : cause.code === "transport"
              ? "unavailable"
              : "http";
    return { ok: false, reason, httpStatus: lastStatus, ms: clock() - started, receipt: written };
  }
}

/** The answers, or null on any failure (the common shape the pre-router callers used). */
export async function jevAnswers(call: JevCall): Promise<JevAnswers | null> {
  const out = await jevDecide(call);
  return out.ok ? out.answers : null;
}

/** Warm the TLS connection to Jev (a HEAD, no model call, no receipt). */
export function warmJev(request: typeof fetch = fetch) {
  return request(`${new URL(JEV_URL).origin}/`, { method: "HEAD", signal: AbortSignal.timeout(3000) }).catch(() => null);
}

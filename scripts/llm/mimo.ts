// scripts/llm/mimo.ts — Xiaomi MiMo-V2.6 (Pro / Flash) via OpenRouter, for bulk jobs (lead summaries,
// care-plan emails, receptionist one-liners). Since Stage E1 every call goes through the model router
// (scripts/model-router): the owner's MIMO_BULK=1 opt-in is the explicit selection of a METERED model,
// and when MiMo is unavailable or limited the router falls back automatically along the bulk.text chain
// (the models this file can call: Groq, OpenRouter's exact `:free` ids, then paid OpenRouter DeepSeek).
// Every attempt writes
// a router receipt (.operator-data/model-router/receipts.jsonl), priced from OpenRouter's own
// usage.cost when it reports one, else from the catalogue price. The old per-file MiMo ledger is no
// longer written; its existing rows are read back into the same receipts (receipts.ts legacy import).
//
// Gated behind MIMO_BULK=1 (mimoBulkEnabled) so callers opt in with an env flag.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerKey } from "../provider-config";
import { catalogueModel, modelByProviderId } from "../model-router/catalogue";
import { openAiCompatibleChat } from "../model-router/clients";
import { type HealthStore } from "../model-router/health";
import { callHealth } from "../model-router/defaults";
import { routerReceiptSink, type ReceiptSink } from "../model-router/receipts";
import { RouteError, runRouted } from "../model-router/router";
import { dataDirFor } from "../cloud/data-dir";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Provider ids, from the catalogue (the one place model ids live). */
export const MIMO_MODELS = {
  flash: catalogueModel("openrouter/mimo-v2.6-flash").providerModel as "xiaomi/mimo-v2.6-flash",
  pro: catalogueModel("openrouter/mimo-v2.6-pro").providerModel as "xiaomi/mimo-v2.6-pro",
} as const;

export type MimoModel = (typeof MIMO_MODELS)[keyof typeof MIMO_MODELS];

/** Catalogue list prices, US$ per million tokens (kept for callers that quote a price). */
export const MIMO_PRICES: Record<string, { input: number; output: number }> = Object.fromEntries(
  (["openrouter/mimo-v2.6-flash", "openrouter/mimo-v2.6-pro"] as const).map((id) => {
    const m = catalogueModel(id);
    return [m.providerModel, { input: m.cost.inputUsdPerM ?? 0, output: m.cost.outputUsdPerM ?? 0 }];
  }),
);

/** The hook for scripts/leads/* (and anything else doing bulk summarisation) to opt into MiMo
 * without this file touching another engineer's in-flight code. `MIMO_BULK=1` to switch on. */
export function mimoBulkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIMO_BULK === "1";
}

export type MimoContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** `content` is a plain string for text-only bulk jobs, or a parts array for the omnimodal
 * (image/video/audio) inputs MiMo-V2.6 also accepts, OpenAI-vision-message shape. */
export type MimoMessage = { role: "system" | "user" | "assistant"; content: string | MimoContentPart[] };

export type MimoCallResult = {
  text: string;
  /** The provider model that actually answered (a free fallback when MiMo was unavailable). */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Known cost in USD; null when unknown (never guessed as 0). Free fallbacks are 0. */
  costUsd: number | null;
  ms: number;
  /** Catalogue id MiMo fell back from, or null when MiMo itself answered. */
  fallbackFrom: string | null;
};

export type MimoCallOptions = {
  model?: MimoModel;
  messages: MimoMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Short label kept in the receipt's caller field, e.g. "lead-summary", "care-plan-email". */
  task: string;
  /** Router task class; bulk text by default. */
  taskClass?: string;
  root?: string;
  /** Deprecated: the MiMo ledger is no longer written (router receipts replace it). Ignored. */
  ledgerFile?: string;
  request?: typeof fetch;
  now?: () => number;
  sink?: ReceiptSink;
  health?: HealthStore;
  timeoutMs?: number;
  /** Test-only passthrough to providerKey's lookup; production calls omit both. */
  home?: string;
  env?: NodeJS.ProcessEnv;
};

export const mimoLedgerDefault = (root: string = ROOT) => join(dataDirFor(root), "mimo", "ledger.jsonl");

/** One chat completion through the router with MiMo selected. Throws a sanitised error (never the
 * key or the provider's body text) when MiMo and every eligible free fallback fail. */
export async function callMimo(options: MimoCallOptions): Promise<MimoCallResult> {
  const root = options.root ?? ROOT;
  const selected = modelByProviderId("openrouter", options.model ?? MIMO_MODELS.flash)?.id ?? "openrouter/mimo-v2.6-flash";
  const now = options.now ?? (() => Date.now());
  const started = now();
  try {
    const run = await runRouted({
      task: options.taskClass ?? "bulk.text",
      caller: `scripts/llm/mimo (${options.task})`,
      sink: options.sink ?? routerReceiptSink(root),
      clock: now,
      constraints: {
        selected,
        selectedBy: "owner",
        providers: ["openrouter", "groq"],
        // Per-call health (REVIEW-E12 R2): one MiMo 402 never sits MiMo out for every other caller.
        health: options.health ?? callHealth(root),
        hasKey: (name) => !!providerKey(root, name, { home: options.home, env: options.env }),
      },
      invoke: (choice, signal) =>
        openAiCompatibleChat(
          choice,
          {
            root,
            home: options.home,
            env: options.env,
            request: options.request,
            messages: options.messages,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            timeoutMs: options.timeoutMs,
          },
          signal,
        ),
    });
    return {
      text: run.value,
      model: run.receipt.providerModel ?? run.choice.providerModel,
      inputTokens: run.receipt.inputTokens,
      outputTokens: run.receipt.outputTokens,
      costUsd: run.receipt.costUsd,
      ms: now() - started,
      fallbackFrom: run.receipt.fallbackFrom,
    };
  } catch (error) {
    if (error instanceof RouteError) throw new Error(`MiMo and its free fallbacks are unavailable: ${error.message}`);
    throw new Error(`MiMo call failed (${(error as Error).message})`);
  }
}

/** Sums this month's MiMo ledger entries — mirrors ai-usage/snapshot.ts's higgsfieldCredits so a
 * /usage row can read it the same way (see summarizeMimoLedgerRow wired into snapshot.ts). */
export function summarizeMimoLedger(
  file: string,
  monthStart: Date,
  monthEnd: Date,
): { costUsd: number; calls: number; byTask: Record<string, { calls: number; costUsd: number }> } | null {
  try {
    if (!existsSync(file)) return null;
    let costUsd = 0;
    let calls = 0;
    const byTask: Record<string, { calls: number; costUsd: number }> = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const ts = Number(e.ts);
        if (!Number.isFinite(ts) || ts < monthStart.getTime() || ts >= monthEnd.getTime()) continue;
        if (typeof e.costUsd !== "number") continue;
        costUsd += e.costUsd;
        calls++;
        const t = (byTask[String(e.task ?? "unlabelled")] ??= { calls: 0, costUsd: 0 });
        t.calls++;
        t.costUsd += e.costUsd;
      } catch {
        /* skip a bad line */
      }
    }
    return { costUsd, calls, byTask };
  } catch {
    return null;
  }
}

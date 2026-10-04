// scripts/model-router/chat.ts — routedChat(): one text turn through the router, whichever provider
// the route picks. The call sites that used to hand-roll "Claude, else Hermes, else Gemini" (inbox
// questions, meeting summaries, CAD code, call scripts, vision) use this, so each has ONE route, the
// owner rules (paid -> free fallback, privacy class, no replay) and one receipt per attempt.
//
// Providers with a client here: openrouter and groq (clients.ts), codex via Hermes and claude-sub via
// `claude -p` (subscription-clients.ts). `local` and `cline` run only when the caller passes their
// invoker. A route never picks a provider this call can't run (constraints.providers).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerKey } from "../provider-config";
import { openAiCompatibleChat, type ChatMessage } from "./clients";
import { callHealth, defaultReceiptSink, defaultRequest, inTests } from "./defaults";
import type { HealthStore } from "./health";
import type { ReceiptSink } from "./receipts";
import { ProviderError, runRouted, type InvokeResult, type RouteChoice, type RouteConstraints, type RunResult } from "./router";
import { claudeChat, hermesChat, type ClaudeComplete } from "./subscription-clients";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type ExtraInvoke = (choice: RouteChoice, messages: ChatMessage[], signal: AbortSignal) => Promise<InvokeResult<string>>;

export type RoutedChatDeps = {
  request?: typeof fetch;
  /** Claude bridge `complete` (default: a lazily created in-process claudeBridge()). */
  claude?: ClaudeComplete;
  /** Hermes API server key; default read from Hermes' .env by NAME (hermes-api.ts). */
  hermesKey?: () => string;
  hermesEndpoint?: string;
  hermesEffort?: "low" | "medium" | "high";
  /** On-device model invoker (Ollama / LM Studio); enables provider "local". */
  local?: ExtraInvoke;
  /** Cline bridge invoker; enables provider "cline". */
  cline?: ExtraInvoke;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

export type RoutedChatOptions = {
  task: string;
  /** Receipt caller: "path/to/file (surface)". */
  caller: string;
  messages: ChatMessage[];
  root?: string;
  temperature?: number;
  maxTokens?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  constraints?: RouteConstraints;
  requestId?: string;
  parentRequestId?: string | null;
  sink?: ReceiptSink;
  health?: HealthStore;
  signal?: AbortSignal;
  clock?: () => number;
  deps?: RoutedChatDeps;
  /** The exact provider model to send for an owner-choice catalogue entry (catalogue id -> provider id). */
  exactModel?: Record<string, string>;
  /** Extra body fields for OpenRouter attempts only (per catalogue id, or "*" for every one). */
  openRouterBody?: Record<string, Record<string, unknown>>;
};

let sharedClaude: ClaudeComplete | null = null;
async function defaultClaude(): Promise<ClaudeComplete> {
  if (inTests()) return async () => { throw new Error("ENOENT: no real claude -p under bun test (inject deps.claude)"); };
  if (!sharedClaude) {
    const { claudeBridge } = await import("../claude-bridge");
    sharedClaude = claudeBridge({ timeoutMs: 4 * 60_000 }).complete as unknown as ClaudeComplete;
  }
  return sharedClaude;
}

async function defaultHermesKey(): Promise<string> {
  if (inTests()) return "";
  const { hermesApiKey } = await import("../hermes-api");
  return hermesApiKey();
}

/** Providers this call can run. */
export function chatProviders(deps: RoutedChatDeps = {}): string[] {
  return ["openrouter", "groq", "codex", "claude-sub", ...(deps.local ? ["local"] : []), ...(deps.cline ? ["cline"] : [])];
}

export async function routedChat(options: RoutedChatOptions): Promise<RunResult<string>> {
  const root = options.root ?? ROOT;
  const deps = { ...(options.deps ?? {}) };
  deps.request = defaultRequest(deps.request);
  const c = options.constraints ?? {};
  const allowed = chatProviders(deps);
  const providers = c.providers ? c.providers.filter((p) => allowed.includes(p)) : allowed;
  return runRouted<string>({
    task: options.task,
    caller: options.caller,
    requestId: options.requestId,
    parentRequestId: options.parentRequestId,
    sink: options.sink ?? defaultReceiptSink(root),
    signal: options.signal,
    clock: options.clock,
    constraints: {
      ...c,
      providers,
      health: c.health ?? options.health ?? callHealth(root),
      hasKey: c.hasKey ?? ((name) => !!providerKey(root, name, { home: deps.home, env: deps.env })),
    },
    invoke: async (routed, signal) => {
      const exact = options.exactModel?.[routed.model];
      const choice = exact ? { ...routed, providerModel: exact } : routed;
      switch (choice.provider) {
        case "openrouter":
        case "groq":
          return openAiCompatibleChat(
            choice,
            {
              root,
              home: deps.home,
              env: deps.env,
              request: deps.request,
              messages: options.messages,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              timeoutMs: options.timeoutMs,
              openRouterBody: options.openRouterBody?.[choice.model] ?? options.openRouterBody?.["*"],
            },
            signal,
          );
        case "codex":
          return hermesChat(
            choice,
            { key: deps.hermesKey ? deps.hermesKey() : await defaultHermesKey(), request: deps.request, endpoint: deps.hermesEndpoint, messages: options.messages, timeoutMs: options.timeoutMs, effort: deps.hermesEffort },
            signal,
          );
        case "claude-sub":
          return claudeChat(choice, { complete: deps.claude ?? (await defaultClaude()), messages: options.messages }, signal);
        case "local":
          return deps.local!(choice, options.messages, signal);
        case "cline":
          return deps.cline!(choice, options.messages, signal);
        default:
          throw new ProviderError("policy", `No chat client for ${choice.provider}`, { sent: false });
      }
    },
  });
}

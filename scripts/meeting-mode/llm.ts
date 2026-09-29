// The summary and coaching step (docs/MEETING-MODE.md) runs through the model router (Stage E2):
// task meeting.notes, in its pre-E2 order: Claude Sonnet (official `claude -p` under his claude.ai
// login), then Hermes' warm gateway on the Codex pool (the old fallback, a subscription), with free
// Groq models added after them. Every attempt writes a router receipt naming the model that ran; the
// ids come from the model catalogue. As before E2, Claude and Hermes are always tried before the step
// gives up, even when the router has recently seen them limited.
//
// routedLlm() is the shared shape for "one system + one prompt -> text": CAD code (scripts/cad-hands.ts,
// task cad.code) uses it too.
import { modelByProviderId } from "../model-router/catalogue";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chatProviders, routedChat, type RoutedChatDeps } from "../model-router/chat";
import { defaultReceiptSink, inTests } from "../model-router/defaults";
import { MemoryHealthStore, type HealthStore } from "../model-router/health";
import type { ReceiptSink } from "../model-router/receipts";
import { route, type RouteChoice, type RunResult } from "../model-router/router";
import { providerKey } from "../provider-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
import type { ClaudeComplete } from "../model-router/subscription-clients";
import type { Llm } from "./coach";

export type RoutedLlmOptions = {
  task: string;
  /** Receipt caller: "path/to/file (surface)". */
  caller: string;
  /** Catalogue id the owner chose for this surface (e.g. claude/sonnet-5); omitted = the task's rule. */
  selected?: string;
  /** A reply this surface can't use (no JSON, no code block) is retried once on the next model. */
  usable?: (text: string) => boolean;
  /** Appended to the prompt for every model (e.g. "Do not use any tools."). */
  suffix?: string;
  timeoutMs?: number;
  root?: string;
  sink?: ReceiptSink;
  health?: HealthStore;
  deps?: RoutedChatDeps;
  /** Providers this surface may use (default: every chat provider). */
  providers?: string[];
};

/** A readable name for the model that answered, from the receipt (never "hermes-agent"). */
export function routedModelLabel(choice: RouteChoice, providerModel: string | null): string {
  const ran = providerModel ?? choice.providerModel;
  if (choice.provider === "claude-sub") return `${ran} (Claude subscription)`;
  if (choice.provider === "codex") return providerModel ? `${providerModel} (Hermes, ChatGPT subscription)` : "Hermes (ChatGPT subscription)";
  if (choice.route === "free") return `${ran} (${choice.provider} free)`;
  return `${ran} (${choice.provider})`;
}

let sharedBridge: ClaudeComplete | null = null;
/** The in-process Claude bridge (`claude -p`), created on first use. Never a real CLI under bun test. */
async function bridgeComplete(): Promise<ClaudeComplete> {
  if (inTests()) return async () => { throw new Error("ENOENT: no real claude -p under bun test (inject deps.claude)"); };
  if (!sharedBridge) {
    const { claudeBridge } = await import("../claude-bridge");
    sharedBridge = claudeBridge({ timeoutMs: 4 * 60_000 }).complete as unknown as ClaudeComplete;
  }
  return sharedBridge;
}

/** One system + prompt through the router. An unusable reply moves on once to the next model, as a new
 *  request linked to the first (the first succeeded; this is not a replay of it). On failure the error
 *  keeps Claude's own reason (the receipts keep every attempt's class). */
export function routedLlm(options: RoutedLlmOptions): Llm {
  return async (system, prompt) => {
    const failures: string[] = [];
    const claude: ClaudeComplete = async (body) => {
      const complete = options.deps?.claude ?? (await bridgeComplete());
      try {
        return await complete(body);
      } catch (error) {
        failures.push(`Claude: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
        throw error;
      }
    };
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: options.suffix ? `${prompt}\n\n${options.suffix}` : prompt },
    ];
    const root = options.root ?? ROOT;
    const receipts = options.sink ?? defaultReceiptSink(root);
    const tried: string[] = [];
    let firstRequest: string | null = null;
    const sink: ReceiptSink = {
      write: (r) => {
        if (r.outcome !== "exhausted_free" && r.outcome !== "refused_policy" && r.outcome !== "replay_refused") tried.push(r.model);
        firstRequest ??= r.requestId;
        return receipts.write(r);
      },
      forRequest: (id) => receipts.forRequest(id),
      claim: (id) => receipts.claim(id),
      release: (id) => receipts.release(id),
    };
    const deps = { ...(options.deps ?? {}), claude };
    const selection = options.selected ? { selected: options.selected, selectedBy: "owner" as const } : {};
    const once = (exclude: string[], parent: string | null, health: HealthStore | undefined): Promise<RunResult<string>> =>
      routedChat({
        task: options.task,
        caller: options.caller,
        messages,
        root: options.root,
        timeoutMs: options.timeoutMs,
        sink,
        health,
        parentRequestId: parent,
        deps,
        constraints: { ...selection, ...(exclude.length ? { exclude } : {}), ...(options.providers ? { providers: options.providers } : {}) },
      });
    /** One routed call, then (as before E2) one more pass over the models it didn't reach because the
     *  router had them sitting out or stopped early; models already tried are never run again. */
    const call = async (exclude: string[], parent: string | null): Promise<RunResult<string>> => {
      try {
        return await once(exclude, parent, options.health);
      } catch (error) {
        if ((error as { code?: string })?.code === "cancelled") throw error;
        const rest = [...exclude, ...tried];
        try {
          route(options.task, { ...selection, exclude: rest, health: new MemoryHealthStore(), providers: options.providers ?? chatProviders(deps), hasKey: (name) => !!providerKey(root, name, { home: deps.home, env: deps.env }) });
        } catch {
          throw error;
        }
        return await once(rest, parent ?? firstRequest, new MemoryHealthStore());
      }
    };
    const failed = (error: unknown) => new Error([...failures, String((error as Error)?.message ?? error).slice(0, 400)].join("; "));
    let run: RunResult<string>;
    try {
      run = await call([], null);
    } catch (error) {
      throw failed(error);
    }
    if (options.usable && !options.usable(run.value)) {
      const first = run;
      try {
        run = await call([...tried], first.receipt.requestId);
      } catch (error) {
        throw new Error(`${first.choice.model} gave no usable reply, and no other model could: ${failed(error).message.slice(0, 400)}`);
      }
      // The second reply is returned as it is (the caller validates it), as the old fallback did.
    }
    return { text: run.value, model: routedModelLabel(run.choice, run.receipt.providerModel) };
  };
}

/** A configured model name (catalogue id, or Claude's own id like "claude-sonnet-5") -> catalogue id. */
export function claudeModelId(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  if (name.includes("/")) return name;
  return modelByProviderId("claude-sub", name)?.id ?? fallback;
}

/** The router task for meeting notes and narrated skill drafts (Claude, then Hermes, then free Groq). */
export const MEETING_TASK = "meeting.notes";

export function subscriptionLlm(options: { complete?: ClaudeComplete; model?: string; deps?: RoutedChatDeps; sink?: ReceiptSink; health?: HealthStore; root?: string } = {}): Llm {
  return routedLlm({
    task: MEETING_TASK,
    caller: "scripts/meeting-mode/llm (meeting notes)",
    selected: options.model ? claudeModelId(options.model, "") || undefined : undefined,
    usable: (text) => text.includes("{"),
    suffix: "Do not use any tools. Reply with the JSON object only.",
    timeoutMs: 5 * 60_000,
    root: options.root,
    sink: options.sink,
    health: options.health,
    deps: { ...(options.deps ?? {}), ...(options.complete ? { claude: options.complete } : {}) },
  });
}

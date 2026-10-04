// Inbox questions ("did Sam ever reply about the quote?") answered from his own email excerpts.
// Since Stage E2 it goes through the model router (task inbox.question), with receipts:
//   1. the original default, DeepSeek v4.1 Flash on OpenRouter (the owner's choice; no data policy
//      is imposed: owner, 28 Sep, "its all my data");
//   2. the free fallbacks (Groq gpt-oss-120b, then 20b): tool-free chat completions.
// No Hermes/Codex leg: Hermes runs a tool-using agent and third-party email text must not reach it
// (REVIEW-E12 M3). An on-device model the owner picked in Chat stays on-device. Every attempt writes a
// router receipt with the model that actually answered.
import { runAssistant } from "./assistant-adapters";
import type { InboxQuestionModel } from "./inbox-questions";
import { providerKey } from "./provider-config";
import { catalogueTask, modelByProviderId } from "./model-router/catalogue";
import { routedChat, type RoutedChatDeps } from "./model-router/chat";
import { RouteError, route, type RouteConstraints } from "./model-router/router";

const TASK = "inbox.question";
const CALLER = "scripts/inbox-question-model (inbox ask)";
const MAX_ANSWER = 18_000;
/** One attempt's deadline; the router moves on to the next model after it. */
const ATTEMPT_MS = 30_000;

export type InboxModelDeps = RoutedChatDeps & { constraints?: RouteConstraints };
/** The pre-router harness sent DeepSeek Flash with reasoning off; the default route keeps that. */
const DEFAULT_REASONING = { reasoning: { effort: "none" } };

/** The catalogue route the owner's Chat choice maps to (null = the rule's default). */
export function inboxSelection(selected: InboxQuestionModel | undefined): Pick<RouteConstraints, "selected" | "selectedBy" | "providers"> {
  if (!selected) return {};
  if (selected.backend === "local") return { selected: "local/on-device", selectedBy: "owner", providers: ["local"] };
  const m = modelByProviderId("openrouter", selected.name);
  const task = catalogueTask(TASK);
  // A pick the task doesn't list (or the catalogue doesn't know) still runs as picked, as before.
  if (!m || !task || ![...task.candidates, ...(task.selectable ?? [])].includes(m.id)) return { selected: OWNER_CHOICE, selectedBy: "owner" };
  return m.id === "openrouter/deepseek-v4.1-flash" ? {} : { selected: m.id, selectedBy: "owner" };
}

/** Any other OpenRouter deepseek/* model the owner picks in Chat (allowed before the router). */
const OWNER_CHOICE = "openrouter/deepseek-owner-choice";

/** Is there any route that could answer? Key presence by NAME only; nothing is called. */
export function inboxQuestionModelAvailable(root: string, _key: string, model?: InboxQuestionModel, deps: InboxModelDeps = {}) {
  if (model?.backend === "local") return ["ollama", "lmstudio"].includes(model.provider) && !!model.name && !model.name.includes(":cloud");
  try {
    route(TASK, {
      ...inboxSelection(model),
      providers: ["openrouter", "groq"],
      hasKey: (name) => !!providerKey(root, name, { home: deps.home, env: deps.env }),
      ...deps.constraints,
    });
    return true;
  } catch {
    return false;
  }
}

/** The on-device invoker: streams from Ollama / LM Studio, reports the local model's name. */
function localInvoke(root: string, selected: InboxQuestionModel): RoutedChatDeps["local"] {
  return async (_choice, messages, signal) => {
    let answer = "";
    const prompt = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n");
    await runAssistant(root, { backend: "local", provider: selected.provider, model: selected.name, maxOutputTokens: 4096, prompt }, "", signal, (part) => {
      answer += part;
      if (answer.length > MAX_ANSWER) throw new Error("The answer was too long.");
    });
    return { value: answer, providerModel: `${selected.provider}:${selected.name}`.slice(0, 120) };
  };
}

export async function generateInboxQuestionAnswer(root: string, _key: string, prompt: string, selected: InboxQuestionModel | undefined, signal: AbortSignal, deps: InboxModelDeps = {}) {
  if (signal.aborted) throw new Error("Stopped.");
  if (!prompt.trim() || prompt.length > 100_000) throw new Error("The inbox question contains too much context or is empty.");
  const selection = inboxSelection(selected);
  try {
    const run = await routedChat({
      task: TASK,
      caller: CALLER,
      root,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      // As before the router: 1,024 tokens for the default, 4,096 for a model the owner picked.
      maxTokens: selected ? 4096 : 1024,
      exactModel: selected?.backend === "deepseek" ? { [OWNER_CHOICE]: selected.name } : undefined,
      openRouterBody: selected ? undefined : { "openrouter/deepseek-v4.1-flash": DEFAULT_REASONING },
      timeoutMs: ATTEMPT_MS,
      signal,
      constraints: {
        ...selection,
        providers: selection.providers ?? ["openrouter", "groq"],
        ...deps.constraints,
      },
      deps: { ...deps, ...(selected?.backend === "local" ? { local: localInvoke(root, selected) } : {}) },
    });
    const answer = run.value.trim();
    if (!answer) throw new Error("The inbox assistant returned an empty answer.");
    if (answer.length > MAX_ANSWER) throw new Error("The answer was too long.");
    return answer;
  } catch (error) {
    if (signal.aborted) throw new Error("Stopped.");
    if (error instanceof RouteError) throw new Error("No inbox model is available right now. Your matching conversations are still shown.");
    throw new Error("The inbox assistant could not complete this answer. Your matching conversations are still available.");
  }
}

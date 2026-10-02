// Deterministic answers from the OS's own page data (AUDIT-F3 F3-01): "which models are free" and "what
// needs setup" are read from the same sources the Models and System pages show, never a chat model.
// `pageAnswerQuery` spots the question (pure; the voice turn and the typed box both use it); the answer
// is built by the browser (voice-companion's `page_answer` tool and the typed box) from those sources.
import { modelsFacts, modelsSummary } from "../../components/shell/models-facts";
import { toolAttentionLabel, toolCounts, type Capabilities } from "../../components/shell/system-facts";
import type { ModelRouterView } from "../../../scripts/model-router/api";

export type PageAnswerQuery = "models.free" | "setup.needed";

const LEAD = /^(?:(?:hey|ok)\s+)?(?:jarvis[,\s]+)?(?:please\s+)?(?:can you\s+)?(?:tell me\s+)?/i;

/** The question, or null. Pure. */
export function pageAnswerQuery(text: string): PageAnswerQuery | null {
  const t = text.trim().replace(LEAD, "").toLowerCase().replace(/[?.!]+$/, "");
  if (/^(?:which|what)\s+(?:models?|llms?|ai models?)\s+(?:are|is)\s+free\b|^(?:list|what are)\s+(?:the\s+)?free\s+(?:models?|llms?)\b|^free models\b/.test(t)) return "models.free";
  if (/^what\s+(?:needs?|still needs?)\s+(?:setting up|set ?up|setup)\b|^what(?:'s| is)\s+not\s+set\s*up\b|^(?:what|which)\s+tools?\s+(?:need|are broken)\b|^setup needed\b/.test(t)) return "setup.needed";
  return null;
}

export type PageAnswer = { said: string; to: string; source: string };

/** "Free models: 19 verified no-charge, plus 8 free tier with billing unverified." From the router view. Pure. */
export function freeModelsAnswer(view: ModelRouterView): PageAnswer {
  const s = modelsSummary(modelsFacts(view, null));
  const names = view.catalogue.models
    .filter((m) => m.route === "free" && m.verifiedFree && (m.status === "verified" || m.status === "configured"))
    .slice(0, 5)
    .map((m) => m.id);
  return {
    said: `${s.free} free model${s.free === 1 ? "" : "s"} verified at no charge${s.freeUnverified ? `, plus ${s.freeUnverified} on a free tier whose billing isn't verified` : ""}.${names.length ? ` For example: ${names.join(", ")}.` : ""} The full list is on Models.`,
    to: "/models",
    source: "Model catalogue (/__operator/model-router)",
  };
}

/** "2 need setup · 1 broken: Gmail (connect it in Settings), …". From the capability registry. Pure. */
export function setupNeededAnswer(caps: Capabilities): PageAnswer {
  if (!caps.generatedAt) return { said: "The tool check hasn't run yet, so I can't say what needs setup. System shows it once it has.", to: "/system", source: "Capability registry (/__operator/capabilities)" };
  const c = toolCounts(caps);
  if (!c.attention.length) return { said: `Nothing needs setup: ${c.total} tools checked${c.unknown ? `, ${c.unknown} with an unknown status` : ""}.`, to: "/system", source: "Capability registry (/__operator/capabilities)" };
  const list = c.attention.slice(0, 5).map((t) => `${t.name} (${t.status === "broken" ? "broken" : "needs setup"}${t.ownerAction ? `: ${t.ownerAction}` : ""})`);
  return { said: `${toolAttentionLabel(c)}. ${list.join("; ")}${c.attention.length > 5 ? "; and more on System" : ""}.`, to: "/system", source: "Capability registry (/__operator/capabilities)" };
}

/** Browser: read the page's own source and answer. Never throws; a failed read says so. */
/** Just the call shape this module uses; `typeof fetch` also carries runtime extras (Bun's `preconnect`) a test double need not fake. */
export type PageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function answerFromPage(query: PageAnswerQuery, request: PageFetch = (input, init) => fetch(input, init)): Promise<PageAnswer> {
  const token = await request("/__token").then((r) => (r.ok ? r.json() : null)).then((t) => (typeof t?.token === "string" ? t.token : "")).catch(() => "");
  const get = async (path: string) => {
    const r = await request(path, { headers: { Accept: "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) }, cache: "no-store" });
    if (!r.ok) throw new Error(`${path} answered HTTP ${r.status}`);
    return r.json();
  };
  try {
    if (query === "models.free") return freeModelsAnswer((await get("/__operator/model-router")) as ModelRouterView);
    return setupNeededAnswer((await get("/__operator/capabilities")) as Capabilities);
  } catch (error) {
    const to = query === "models.free" ? "/models" : "/system";
    return { said: `I couldn't read that just now (${(error as Error).message}), so I won't guess. It's on ${query === "models.free" ? "Models" : "System"}.`, to, source: "unavailable" };
  }
}

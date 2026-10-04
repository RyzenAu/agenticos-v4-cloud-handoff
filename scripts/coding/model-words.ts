// A model the words name that this harness cannot run (round 6, item 5): said out loud and refused, never replaced by another
// model nobody asked for. Pure: no accounts, no clock. The shaper (typed, spoken and the page) and the voice edit-draft use it.

/** Families that are not in any catalogue here. Only read next to a role word ("Gemini builds", "use Grok for the review"). */
const FOREIGN = String.raw`(?:gemini|bard|grok|llama|mistral|mixtral|qwen|kimi|copilot|chatgpt|gpt[ -]?[2-5](?:\.\d+)?(?:[ -](?:sol|terra|luna|mini|turbo))?|o[34](?:-mini)?|cursor)`;
const ROLE = String.raw`(?:build|builds|building|builder|implement|implements|write|writes|fix|fixes|review|reviews|reviewing|reviewer|check|checks|test|tests|tester)`;
/** What a model named as the subject does: a third-person verb or a role noun, never the bare imperative ("Gemini reviews it", not "the Gemini review summary"). */
const SUBJECT_ROLE = String.raw`(?:builds|building|builder|implements|writes|fixes|reviews|reviewing|reviewer|checks|tests|tester)`;
const near = (name: string) => new RegExp(
  String.raw`(?:\b(${name})(?:\s+(?:agent|model|session))?\s+${SUBJECT_ROLE}\b)|(?:\b${ROLE}\b\s+(?:with|using|by|on|to)\s+(?:an?\s+|another\s+|the\s+)?\b(${name})\b)|(?:\b(?:use|have|let|ask|get|tell)\s+(?:an?\s+|another\s+)?\b(${name})\b\s+(?:(?:for|as)\s+(?:the\s+)?|to\s+)${ROLE}\b)|(?:\b(?:have|let|ask|tell)\s+(?:an?\s+|another\s+)?\b(${name})\b\s+(?:to\s+)?(?:build|implement|write|fix|review|check|test)\b)|(?:\b(${name})\s+as\s+(?:the\s+)?(?:builder|reviewer|tester)\b)`,
  "i",
);

/** Codex models the harness offers (spec.ts CODEX_MODELS): never "unknown", whatever GPT-looking name they carry. */
const CODEX_NAMES = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
export const isCodexModelName = (said: string) => CODEX_NAMES.has(said.trim().toLowerCase().replace(/[ _]+/g, "-"));

/** The Claude versions this harness runs for each family (claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1, claude-haiku-4-5). */
const CLAUDE_VERSIONS: Record<string, { current: string; accepts: string[] }> = {
  opus: { current: "5.5", accepts: ["5", "5.5"] },
  sonnet: { current: "5.5", accepts: ["5", "5.5"] },
  fable: { current: "5.1", accepts: ["5", "5.1"] },
  haiku: { current: "4.5", accepts: ["4", "4.5"] },
};
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export const AVAILABLE_MODELS_SENTENCE = "Opus, Sonnet, Fable or Haiku on your Claude plan, Codex (GPT-6 Astra), Hermes, or the free Cline models (MiMo, DeepSeek, Muse)";

export type UnavailableModel = { said: string; reason: string };

/**
 * The first model these words ask for that cannot be run, with the sentence to say; null when every named model is one
 * the harness offers. A foreign family ("Gemini builds") is never mapped to something else, and a Claude version that
 * isn't offered ("Sonnet 4.5 builds") is never quietly bumped to the current one.
 */
export function unavailableModelWords(text: string): UnavailableModel | null {
  const foreign = near(FOREIGN).exec(text);
  if (foreign) {
    const said = (foreign.slice(1).find(Boolean) ?? "that model").trim();
    if (isCodexModelName(said)) return null;
    const label = /^gpt|^o\d/i.test(said) ? said.toUpperCase().replace(/^O/, "o") : title(said);
    return { said: label, reason: `${label} isn't a model this harness can run, so I haven't drafted this or put a different model in its place. Available: ${AVAILABLE_MODELS_SENTENCE}. Name one of those, or leave the model out and I'll choose.` };
  }
  const versioned = new RegExp(String.raw`\b(opus|sonnet|fable|haiku)[ -]?v?(\d+(?:[.-]\d+)?)\b(?:\s+\w+){0,2}?\s+${ROLE}\b|\b${ROLE}\b\s+(?:with|using|by|on|to)\s+(?:an?\s+|another\s+|the\s+)?(opus|sonnet|fable|haiku)[ -]?v?(\d+(?:[.-]\d+)?)\b|\buse\s+(?:an?\s+|another\s+)?(opus|sonnet|fable|haiku)[ -]?v?(\d+(?:[.-]\d+)?)\s+(?:for|as)\s+(?:the\s+)?${ROLE}\b`, "i").exec(text);
  if (versioned) {
    const g = versioned.slice(1);
    const family = (g[0] ?? g[2] ?? g[4]).toLowerCase();
    const version = (g[1] ?? g[3] ?? g[5]).replace("-", ".");
    const known = CLAUDE_VERSIONS[family];
    if (known && !known.accepts.includes(version)) {
      const said = `${title(family)} ${version}`;
      return { said, reason: `${said} isn't offered here; the ${title(family)} this harness runs is ${known.current}. I haven't drafted this or swapped one in. Say "${title(family)}" for ${known.current}, or name another model (${AVAILABLE_MODELS_SENTENCE}).` };
    }
  }
  return null;
}

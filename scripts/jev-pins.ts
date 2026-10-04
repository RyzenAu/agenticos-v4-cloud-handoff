/**
 * Explicit model/account pins in his words (round 10, brief §4.5, acceptance #8/#9). Pure: no I/O.
 *
 * "Fix this bug using Opus on Claude Max 2" names the WORKER for the whole job: that account and that model. The controller turns the
 * words into a structured pin before the coding harness sees them, so
 *   - the draft's builder is exactly that account/model or nothing is drafted (scripts/coding/shaper.ts pinnedBuilder), and
 *   - the pin is saved on the job (spec.builderPin), so a retry or the automatic account fallback never moves it
 *     (scripts/coding/orchestrator.ts planFallback leaves a pinned builder where it is).
 * An account that isn't on this server is refused HERE with the accounts that are (never swapped for the automatic pick, never a paid API).
 *
 * Words with no account and no model name pin nothing: the job's worker is chosen per task (Auto, scripts/coding/role-choice.ts), so a
 * second unrelated task in the same conversation can get a different worker (acceptance #10). A pin never carries over to the next request.
 */
import { claudeSlotFromWords } from "./coding/shaper";
import type { AccountsConfig } from "./coding/accounts";

export type ExplicitPin = { accountSlot: string | null; model: string | null };
/** The accounts this server actually has (the coding accounts file), by slot, with the label Jarvis says. */
export type PinCatalogue = { claude: { slot: string; label: string }[]; codex: { slot: string; label: string }[] };

export type PinResolution =
  | { kind: "none" }
  | { kind: "pin"; pin: ExplicitPin; said: string }
  | { kind: "refused"; said: string; alternatives: string[] };

/** Every Claude slot a person can name ("Claude Max" … "Claude Max 9"), so an unconnected one is still READ, then refused by name. */
const EVERY_CLAUDE: AccountsConfig = {
  version: 1,
  codex: [],
  claude: ["claude:max", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `claude:max-${n}`)].map((slot, order) => ({ slot, configDir: null, plan: "claude-max-20x", label: slot, order })),
} as unknown as AccountsConfig;

const MODEL_IDS: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", fable: "claude-fable-5-1", haiku: "claude-haiku-4-5", codex: "gpt-6-astra", astra: "gpt-6-astra" };
const MODEL_WORD = String.raw`(opus|sonnet|fable|haiku|codex|(?:gpt[- ]?6[- ]?)?astra)`;
/**
 * A model named as THE worker: "using Opus", "with Sonnet", "on Opus", "via Codex", "have Opus fix", "Opus, fix …", "get Codex to …".
 * A model named as the REVIEWER ("and Codex reviews it", "with Codex reviewing") is not the builder and pins nothing here.
 */
const BUILDER_MODEL = [
  new RegExp(String.raw`\b(?:using|use|with|on|via|through)\s+(?:claude\s+)?${MODEL_WORD}\b(?!\s+(?:review|reviews|reviewing|reviewer|to review|check|checks|checking))`, "i"),
  new RegExp(String.raw`\b(?:have|get|let|ask|tell)\s+(?:claude\s+)?${MODEL_WORD}\s+(?:to\s+)?(?!review|check)\w`, "i"),
  new RegExp(String.raw`^\s*(?:claude\s+)?${MODEL_WORD}\s*,\s*(?!review|check)\w`, "i"),
];

/** The coding accounts file's slots as a pin catalogue (labels as configured). Pure. */
export function pinCatalogueFrom(config: AccountsConfig): PinCatalogue {
  return { claude: config.claude.map((c) => ({ slot: c.slot, label: c.label || accountLabel(c.slot) })), codex: config.codex.map((c) => ({ slot: c.slot, label: (c as { label?: string }).label || accountLabel(c.slot) })) };
}

export const accountLabel =(slot: string) => (slot === "claude:max" ? "Claude Max" : slot.startsWith("claude:max-") ? `Claude Max ${slot.split("-").pop()}` : slot.startsWith("codex:") ? `Codex ${slot.slice(6)}` : slot);
const modelLabel = (id: string) => ({ "claude-opus-5-5": "Opus", "claude-sonnet-5-5": "Sonnet", "claude-fable-5-1": "Fable", "claude-haiku-4-5": "Haiku", "gpt-6-astra": "Codex" } as Record<string, string>)[id] ?? id;

/** The model the words name as the builder, or null. Pure. */
export function builderModelIn(text: string): string | null {
  const plain = text.replace(/\bclaude\s+(?:max|account)\s*\d?\b/gi, " ");
  for (const re of BUILDER_MODEL) {
    const m = re.exec(plain);
    if (m) return MODEL_IDS[m[1].toLowerCase().replace(/^gpt[- ]?6[- ]?/, "")] ?? null;
  }
  return null;
}

/**
 * The pin his words ask for, checked against the accounts this server has. `catalogue` null = not known here: a named account is still
 * pinned (the harness then refuses an unconnected one itself, by name), but no alternatives can be offered. Pure.
 */
export function resolvePin(text: string, catalogue: PinCatalogue | null): PinResolution {
  const slot = claudeSlotFromWords(text, EVERY_CLAUDE);
  const model = builderModelIn(text);
  if (!slot && !model) return { kind: "none" };
  if (slot && model && !model.startsWith("claude-")) {
    return { kind: "refused", said: `${modelLabel(model)} doesn't run on ${accountLabel(slot)}, so nothing started. Say Opus, Sonnet, Fable or Haiku on ${accountLabel(slot)}, or Codex on its own.`, alternatives: [] };
  }
  if (slot && catalogue && !catalogue.claude.some((c) => c.slot === slot)) {
    const have = catalogue.claude.map((c) => c.label || accountLabel(c.slot));
    const alternatives = have.length ? have : [];
    return {
      kind: "refused",
      alternatives,
      said: `${accountLabel(slot)} isn't connected on this server, so nothing started, and I won't move it to another account or a paid API. ${have.length ? `Connected: ${have.join(", ")}. Say one of those to use it instead.` : "No Claude account is connected here; connect one on the Coding page."}`,
    };
  }
  const pin: ExplicitPin = { accountSlot: slot, model };
  const what = [model ? modelLabel(model) : null, slot ? `on ${accountLabel(slot)}` : null].filter(Boolean).join(" ");
  return { kind: "pin", pin, said: `Pinned to ${what} for the whole job.` };
}

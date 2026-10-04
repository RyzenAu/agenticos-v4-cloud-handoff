import { unavailableModelWords } from "./model-words";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JevAnswers, JevOutcome } from "../jev-client";
import { pickCodexSlot, slotReadings, type AccountsConfig } from "./accounts";
import type {
  AgentBinding,
  ClaudeAccountSlot,
  ClaudeModelId,
  CodexModelId,
  CommandId,
  DoneCriterion,
  IsoTime,
  JevDecision,
  JevShapingRecord,
  OwnershipSpec,
  RepoRegistry,
  RepoRegistryEntry,
  RoleTemplate,
  TaskSpec,
  TaskSpecValidation,
  Uuid,
  VerifiedPrincipal,
} from "./contracts";
import { redactText } from "./redact";
import { chooseRoles, choiceSentence, DEFAULT_CODING_PREFS, modelLabel, type ChoiceEnv, type CodingModelPrefs, type RoleChoiceResult } from "./role-choice";
import { codingMoneyRefusal } from "../jarvis-execution/spoken-money";
import { reposFor } from "./registry";
import { CLAUDE_MODELS, CODEX_MODELS, claudeBinding, codexBinding, draftSpec, routerBinding, slugOf } from "./spec";
import { isSiteRequest, siteObjective } from "../../src/lib/site-maker";
import { siteDraftPlan } from "./site-plan";

/**
 * The shaper (CODING-HARNESS §3.2, task C4): a spoken or typed request → a bounded, UNCONFIRMED TaskSpec,
 * or ONE clarifying question.
 *
 *  - Jev (TypeSafe, through the one Jev client) makes the typed choices it is good at: which repo, which
 *    team shape, whether the request is complete, whether it asks for anything consequential. Policy:
 *    act ≥ 0.6 with a 0.2 margin, look again 0.4–0.6, ask < 0.4 (REVIEW-JEV).
 *  - Words the owner actually said win over Jev ("Opus builds, Codex reviews" is explicit). With no Jev
 *    key, a slow answer or an error, deterministic rules decide and ambiguity is ASKED, never guessed.
 *  - The planner (a read-only Claude session in plan mode, planner.ts) drafts the objective, done-when,
 *    owned files and checks; without it, a deterministic plan is used only when the request names files.
 *  - Consequential words (merge, deploy, push) never become role instructions: they are offered as
 *    approval points after the job completes.
 */

export type JevFn = (call: { state: unknown; questions: Record<string, unknown> }) => Promise<JevOutcome | null>;

export type PlannerDraft = {
  objective: string;
  nonGoals: string[];
  doneWhen: DoneCriterion[];
  builders: { owns: OwnershipSpec; instructions?: string }[];
  testAuthorOwns?: OwnershipSpec | null;
  checks: CommandId[];
  plannerSession?: { binding: AgentBinding; sessionId: string } | null;
};
export type PlannerFn = (input: { entry: RepoRegistryEntry; objective: string; utterance: string; specId: Uuid }) => Promise<PlannerDraft | { question: string }>;

export type ShaperDeps = {
  registry: () => RepoRegistry;
  accounts: () => AccountsConfig;
  jev?: JevFn | null;
  planner?: PlannerFn | null;
  cliVersions: () => { claude: string; codex: string };
  /** The owner's paid/free preferences (coding-prefs.json). Default: paid subscription models allowed, free-only off. */
  prefs?: () => CodingModelPrefs;
  /** What is known about availability (CLI installed, Codex isolation applied, a stop window); anything unset is assumed available. */
  choice?: () => Partial<Pick<ChoiceEnv, "claudeAvailable" | "codexAvailable" | "codexReady" | "claudeBlocked" | "route" | "hasKey" | "readings">>;
  /**
   * The Claude account a NEW Claude role goes to (30 Sep 2026): the preferred/first connected account
   * below its stop threshold. `slot` null = none can take work (the reason says why). Absent = "claude:max".
   */
  claudeSlot?: (preferred?: ClaudeAccountSlot) => { slot: ClaudeAccountSlot | null; label: string; reason: string };
  now?: () => Date;
};

export type ShapeResult =
  | { kind: "ask"; draftId: Uuid; question: string; options?: string[] }
  | { kind: "draft"; spec: TaskSpec; spokenSummary: string }
  | { kind: "refused"; reason: string };

type Pending = {
  draftId: Uuid;
  principal: VerifiedPrincipal;
  /** R3: the Claude planner runs only for a person (it spends the Max allowance); programs get the heuristic plan. */
  usePlanner: boolean;
  channel: "voice" | "typed" | "ui";
  utterance: string;
  repoId: string | null;
  objective: string | null;
  asked: "repo" | "objective" | "planner" | null;
  options: string[];
  clarifications: { question: string; answer: string; at: IsoTime }[];
  decisions: JevDecision[];
  jevModel: string;
  jevMs: number;
  /** Models Jev proposed for a role (only when it acted on them); the words and the prefs still win. */
  jevModels: { builder?: string | null; reviewer?: string | null };
  /** The builder pinned by the caller (an Agents bot's coding setting), kept across clarifying questions. */
  pin: BuilderPin | null;
  at: number;
};

/**
 * A builder fixed by the caller as STRUCTURED fields (not words): this exact account slot and/or model. The draft's builder is exactly this
 * or the request is refused with a reason; it is never replaced by another account or model. null/absent fields are left to the automatic pick.
 */
export type BuilderPin = { accountSlot?: string | null; model?: string | null };

const isClaudeModel = (m: string) => (CLAUDE_MODELS as readonly string[]).includes(m);
const isCodexModel = (m: string) => (CODEX_MODELS as readonly string[]).includes(m);

/**
 * The builder binding a pin asks for, or a plain refusal. `named` is the builder the words already name, if any; `auto` is the builder the shaper
 * would pick with no pin. A field the pin leaves open is filled the way the shaper normally would: an account alone keeps the model the shaper
 * chose for that provider (its own default when it chose another provider); a model alone takes the normal slot selection (rotation and limits)
 * among the accounts that can run it, and is refused (never moved to a fixed account) when none can.
 */
export function pinnedBuilder(pin: BuilderPin, named: AgentBinding | null, d: Pick<ShaperDeps, "accounts" | "cliVersions" | "claudeSlot">, auto: AgentBinding | null = null): { ok: true; binding: AgentBinding } | { ok: false; reason: string } {
  const slot = pin.accountSlot ?? null;
  const model = pin.model ?? null;
  const config = d.accounts();
  const versions = d.cliVersions();
  const nothing = "Nothing was drafted, and no other account or model was used instead.";
  if (model && !isClaudeModel(model) && !isCodexModel(model)) return { ok: false, reason: `${model} isn't a model this harness offers. ${nothing} Change the model in the bot's Setup.` };
  const slotFamily = slot ? (slot.startsWith("claude:") ? "claude" : slot.startsWith("codex:") ? "codex" : null) : null;
  const modelFamily = model ? (isClaudeModel(model) ? "claude" : "codex") : null;
  if (slot && !slotFamily) return { ok: false, reason: `${slot} isn't a coding account this harness knows. ${nothing}` };
  if (slotFamily && modelFamily && slotFamily !== modelFamily) return { ok: false, reason: `${modelLabel(model!)} doesn't run on ${slot}. ${nothing} Fix the bot's coding setting.` };
  const family = slotFamily ?? modelFamily;
  const namedFamily = named ? (named.provider === "anthropic" ? "claude" : named.provider === "openai" ? "codex" : "other") : null;
  if (named && family && namedFamily !== family) return { ok: false, reason: `You asked for ${modelLabel(named.model)}, but this bot's coding setting is ${slot ?? modelLabel(model!)}. ${nothing}` };
  if (family === "claude") {
    if (slot && !config.claude.some((c) => c.slot === slot)) return { ok: false, reason: `${slot} isn't connected on this server. ${nothing}` };
    const useModel = (model ?? (named?.provider === "anthropic" ? named.model : auto?.provider === "anthropic" ? auto.model : "claude-opus-5-5")) as ClaudeModelId;
    let useSlot = (slot ?? (named?.provider === "anthropic" ? named.accountSlot : null)) as ClaudeAccountSlot | null;
    if (!useSlot) {
      // A model alone: the normal automatic account pick (the least-used signed-in account below its limit).
      const pick = d.claudeSlot?.();
      if (pick && !pick.slot) return { ok: false, reason: `No Claude account can take work right now (${pick.reason}). ${nothing}` };
      useSlot = (pick?.slot ?? (config.claude[0]?.slot ?? "claude:max")) as ClaudeAccountSlot;
    }
    return { ok: true, binding: claudeBinding(useModel, versions.claude ?? "unknown", useSlot) };
  }
  if (family === "codex") {
    if (slot && !config.codex.some((c) => c.slot === slot)) return { ok: false, reason: `${slot} isn't connected on this server. ${nothing}` };
    const useModel = (model ?? (named?.provider === "openai" ? named.model : auto?.provider === "openai" ? auto.model : "gpt-6-astra")) as CodexModelId;
    let useSlot: string | null = slot ?? (named?.provider === "openai" ? named.accountSlot : null);
    if (!useSlot) {
      // A model alone: the normal Codex slot selection (rotation among the connected accounts below their limit), never a fixed first account.
      const choice = pickCodexSlot(config, slotReadings());
      if (!choice.ok) return { ok: false, reason: `${choice.reason} ${nothing}` };
      useSlot = choice.slot.slot;
    }
    return { ok: true, binding: codexBinding(useModel, useSlot as never, versions.codex ?? "unknown") };
  }
  return { ok: false, reason: `The coding setting names no usable account or model. ${nothing}` };
}

const TTL = 10 * 60_000;

// ─────────────────────────── words ───────────────────────────

/** "Claude account 2", "the second Claude account", "Max 2" / "my first Claude account": the slot the words name, or null. */
const NUMBER_WORD: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
/** How speech-to-text hears "Claude" and spoken numbers ("cloud account two"), for the account words only. */
export const spokenClaude = (text: string) => text
  .replace(/\b(?:cloud|clod|clawed|claud)(?=\s+(?:account|max|code)\b)/gi, "claude")
  .replace(/\b(account|max)\s+(one|two|three|four|five|six|seven|eight|nine)\b/gi, (_m, w: string, n: string) => `${w} ${NUMBER_WORD[n.toLowerCase()]}`);

/**
 * Which Claude account these words name, or null. Strict on purpose (1 Oct 2026): "max", "account" and a digit
 * are everyday words ("allow max 3 retries", "the balance in account 2", "open a new account"), so an account
 * is named only as "Claude Max 2" / "Claude account 2" (any preposition), or after a using-verb ("use / using / via
 * (the) (Claude) (Max) account 2", "use max 2", "use the second Claude account").
 */
export function claudeSlotFromWords(text0: string, config: AccountsConfig): ClaudeAccountSlot | null {
  const slot = claudeSlotNamed(text0);
  return slot && config.claude.some((c) => c.slot === slot) ? slot : null;
}

/** The Claude account slot these words name, whether or not it is connected here (the same strict grammar as claudeSlotFromWords), or null. */
export function claudeSlotNamed(text0: string): ClaudeAccountSlot | null {
  const text = spokenClaude(text0);
  // A bare "account N" counts only after a using-verb ("use / using / via"); "on account two" could be a bank.
  const USE = String.raw`(?:use|using|via)\s+(?:my\s+|the\s+|our\s+)?`;
  const END = String.raw`(?=\s*(?:$|[,.;!?]|and\b|for\b|to\b|please\b|then\b|while\b|so\b))`;
  const num = (re: string) => new RegExp(re, "i").exec(text)?.[1];
  const n = num(String.raw`\bclaude\s+(?:max|account)\s*(?:number\s*)?([1-9])\b`)
    ?? num(USE + String.raw`(?:claude\s+)?(?:max\s+)?account\s*(?:number\s*)?([1-9])\b`)
    ?? num(USE + String.raw`max\s*(?:number\s*)?([1-9])\b` + END)
    ?? (/\b(?:second|2nd|other)\s+claude\s+(?:max\s+)?account\b|\b(?:second|2nd)\s+max\s+account\b/i.test(text) || new RegExp(USE + String.raw`(?:second|2nd|other|new)\s+(?:claude\s+|max\s+)?account\b`, "i").test(text) ? "2"
      : /\b(?:first|1st|original|old|main)\s+claude\s+(?:max\s+)?account\b/i.test(text) || new RegExp(USE + String.raw`(?:first|1st|original|old|main)\s+(?:claude\s+|max\s+)?account\b`, "i").test(text) ? "1" : null);
  if (!n) return null;
  return (n === "1" ? "claude:max" : `claude:max-${n}`) as ClaudeAccountSlot;
}

const slotWords = (slot: string) => (slot === "claude:max" ? "Claude Max" : `Claude Max ${slot.split("-").pop()}`);

/**
 * A Claude account the words name that this server doesn't have (round 10): "fix X using Opus on Claude Max 3" with no Max 3 connected was read as no
 * account at all and the automatic pick ran the job on another account. Now it is refused by name. Pure.
 */
export function unconnectedAccountWords(text: string, config: AccountsConfig): string | null {
  const slot = claudeSlotNamed(text);
  if (!slot || config.claude.some((c) => c.slot === slot)) return null;
  const have = config.claude.map((c) => c.label).join(", ");
  return `${slotWords(slot)} isn't connected on this server${have ? ` (connected: ${have})` : ""}. Nothing was drafted, and I won't use a different account instead. Name one of those, or connect ${slotWords(slot)} first.`;
}

/** The account for a Claude role these words name: an explicit account wins, else the automatic pick. */
function claudeSlotFor(d: ShaperDeps, text: string): ClaudeAccountSlot {
  const named = claudeSlotFromWords(text, d.accounts());
  if (named) return named;
  return d.claudeSlot?.()?.slot ?? "claude:max";
}

// Without the word "claude" (that rule already reads the account): only an unmistakable account phrase.
const ACCOUNT_WORDS = /\b(?:second|2nd|new)\s+(?:max\s+)?account\b|\b(?:on|use|with|using)\s+(?:my\s+|the\s+)?(?:max\s+)?account\s+(?:number\s*)?[1-9]\b/i;

const PAID_DEEPSEEK = /\b(?:openrouter|paid|metered)\s+deep[ -]?seek\b|\bdeep[ -]?seek(?:[ -]?v4(?:\.1)?)?[ -]?pro\b|\bdeep[ -]?seek\b[^.,;]{0,24}?\b(?:via|on|through)\s+openrouter\b/i;
const PAID_MIMO = /\b(?:openrouter|paid|metered)\s+mimo\b|\bmimo(?:[ -]?v?2\.6)?[ -]?pro\b|\bmimo\b[^.,;]{0,24}?\b(?:via|on|through)\s+openrouter\b/i;

/**
 * An explicit free cue for ONE model family: "free DeepSeek", "MiMo Flash free", "DeepSeek ... free tier", "Cline MiMo",
 * "MiMo Flash", "DeepSeek via Cline". A bare "free" ("error-free") or "flash" ("flash of unstyled content") is not one.
 */
const freeCue = (family: string) => new RegExp(
  String.raw`\bfree\s+${family}\b|\b${family}(?:[ -]?v?\d[\d.]*)*(?:[ -]?(?:flash|spark))*[ -]+free\b(?!\s+(?:deep[ -]?seek|mimo|muse|cline)\b)|\b${family}\b[^.;]{0,40}?\bfree\s+(?:route|model|tier|version)\b|\bfree\s+(?:route|model|tier|version)\s+(?:of\s+|for\s+)?${family}\b|\bcline\s+${family}\b|\b${family}(?:[ -]?v?\d[\d.]*)?[ -]flash\b|\b${family}\b[^.;]{0,24}?\b(?:via|on|through)\s+cline\b`,
  "i",
);
/** Negation before a paid phrase: "not", "no", "skip", "avoid", "don't want", "rather than"... then up to three plain words ("avoid the paid"). */
const NEGATED = /(?:\b(?:not|never|avoid|no|skip|don'?t|do not|without|rather than|instead of)(?:\s+(?:want|use|using|need|like))?)\s+(?:[^\s,;.]+\s+){0,3}$/i;
/** "<paid model> is too pricey": the owner is saying no to it. */
const TOO_DEAR = /^\s*(?:is\s+|are\s+|seems\s+|looks\s+)?(?:far\s+|way\s+|a bit\s+|really\s+)?too\s+(?:pricey|expensive|costly)\b/i;
/** The paid route is wanted: a paid match that no negation surrounds, and no free cue for that same model overrides. */
export function paidWanted(re: RegExp, text: string, family: string): boolean {
  if (freeCue(family).test(text)) return false;
  for (const m of text.matchAll(new RegExp(re.source, "gi"))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (!NEGATED.test(before) && !TOO_DEAR.test(after)) return true;
  }
  return false;
}

const MODEL_WORDS: Array<{ re: RegExp; binding: (d: ShaperDeps, text: string) => AgentBinding; guard?: (text: string) => boolean }> = [
  { re: /\bopus\b/i, binding: (d, t) => claudeBinding("claude-opus-5-5", d.cliVersions().claude, claudeSlotFor(d, t)) },
  { re: /\bsonnet\b/i, binding: (d, t) => claudeBinding("claude-sonnet-5-5", d.cliVersions().claude, claudeSlotFor(d, t)) },
  { re: /\bfable\b/i, binding: (d, t) => claudeBinding("claude-fable-5-1", d.cliVersions().claude, claudeSlotFor(d, t)) },
  { re: /\bhaiku\b/i, binding: (d, t) => claudeBinding("claude-haiku-4-5", d.cliVersions().claude, claudeSlotFor(d, t)) },
  { re: /\bclaude\b/i, binding: (d, t) => claudeBinding("claude-opus-5-5", d.cliVersions().claude, claudeSlotFor(d, t)) },
  // "Use account 2 for the build": an account named without a model is Opus on that account.
  { re: ACCOUNT_WORDS, binding: (d, t) => claudeBinding("claude-opus-5-5", d.cliVersions().claude, claudeSlotFor(d, t)) },
  { re: /\bhermes\b|\bgpt[- ]?6[- ]?sol\b/i, binding: () => routerBinding("codex/gpt-6-sol") },
  // A PAID (metered OpenRouter) route is selected only when the words say so ("paid DeepSeek", "OpenRouter MiMo",
  // "DeepSeek Pro", "MiMo via OpenRouter"). A bare "DeepSeek" or "MiMo" is the free Cline Flash route.
  { re: PAID_DEEPSEEK, binding: () => routerBinding("openrouter/deepseek-v4-pro"), guard: (t) => paidWanted(PAID_DEEPSEEK, t, "deep[ -]?seek") },
  { re: PAID_MIMO, binding: () => routerBinding("openrouter/mimo-v2.6-pro"), guard: (t) => paidWanted(PAID_MIMO, t, "mimo") },
  { re: /\bdeep[ -]?seek\b/i, binding: () => routerBinding("cline/deepseek-v4.1-flash") },
  { re: /\bmimo\b/i, binding: () => routerBinding("cline/mimo-v2.6-flash") },
  { re: /\bmuse\b/i, binding: () => routerBinding("cline/muse-spark-1.3") },
  { re: /\bcline\b/i, binding: () => routerBinding("cline/deepseek-v4.1-flash") },
  // A named Codex model ("gpt-5.6-sol", "gpt-5.5") is that model, never the default Astra (round 6).
  { re: /\bgpt[ -]?(?:5\.5|5\.6[ -](?:sol|terra|luna))\b/i, binding: (d, t) => codexFor(d, codexModelIn(t)) },
  { re: /\bcodex\b|\bgpt[- ]?6[- ]?astra\b|\bastra\b/i, binding: (d) => codexFor(d) },
];

/** The binding a phrase names ("Use Codex", "Sonnet"), or null. The one place the model words live (voice.ts edits use it too). */
export function bindingFromWords(text0: string, d: ShaperDeps): AgentBinding | null {
  const text = spokenClaude(text0);
  for (const m of MODEL_WORDS) if (m.re.test(text) && m.guard?.(text) !== false) return m.binding(d, text);
  return null;
}

/** The Codex model a phrase names ("gpt-5.6-sol", "GPT 5.5"), as the catalogue id. */
function codexModelIn(text: string): CodexModelId {
  const m = /\bgpt[ -]?(5\.5|5\.6[ -](?:sol|terra|luna))\b/i.exec(text);
  return (m ? `gpt-${m[1].toLowerCase().replace(/ /g, "-")}` : "gpt-6-astra") as CodexModelId;
}
function codexFor(d: ShaperDeps, model: CodexModelId = "gpt-6-astra"): AgentBinding {
  // Owner decision 1: a NEW job goes to the least-used connected account below the limit.
  const choice = pickCodexSlot(d.accounts(), slotReadings());
  const slot = choice.ok ? choice.slot.slot : d.accounts().codex[0]?.slot ?? "codex:openai-2";
  return codexBinding(model, slot, d.cliVersions().codex);
}

const SAME_MODEL_ASKED = /\b(?:another|a second|a separate|fresh|new)\s+(?:opus|sonnet|fable|haiku|codex|claude|hermes|deep[ -]?seek|mimo|muse|cline|astra)(?:\s+(?:session|agent))?\s+(?:reviews?|reviewer)\b/i;
const ROLE_VERB ="(?:build|builds|building|builder|implement|implements|write|writes|fix|fixes|review|reviews|reviewing|reviewer|check|checks|test|tests|tester|test-author)";
/** "<model> builds", "have <model> build", "<model> for the build". */
function roleModel(text0: string, role: "build" | "review" | "test", d: ShaperDeps): AgentBinding | null {
  const text = spokenClaude(text0);
  const verb = role === "build" ? "(?:build|builds|building|builder|implement|implements|write|writes|fix|fixes)" : role === "review" ? "(?:review|reviews|reviewing|reviewer|check|checks)" : "(?:test|tests|tester|test-author|writes? the tests)";
  for (const m of MODEL_WORDS) {
    const name = m.re.source;
    // The gap may not hold another role's verb: "DeepSeek builds and MiMo reviews" is DeepSeek-builds, MiMo-reviews.
    // (Before 1 Oct 2026 the reviewer matched DeepSeek too; two jobs were shaped with one model in both roles.)
    const GAP = `(?:(?!\\b${ROLE_VERB}\\b)[^.,;]){0,24}?`;
    const near = new RegExp(`(?:${name})${GAP}\\b${verb}\\b|\\b${verb}\\b${GAP}(?:with|using|by|on|to)\\s+(?:an?\\s+|another\\s+|the\\s+)?(?:${name})|use\\s+(?:an?\\s+|another\\s+)?(?:${name})\\s+(?:for|as)\\s+(?:the\\s+)?${verb}`, "i");
    if (near.test(text) && m.guard?.(text) !== false) return m.binding(d, text);
  }
  // Round 10: "Fix the greeting in src/a.ts of the fixture app using Opus on Claude Max 2" names the builder too, though "using Opus" is far from the
  // verb (the role grammar above allows 24 characters and no punctuation). Only "using/via <model>" closing the request (end, or followed by "on <account>",
  // "and ..." or "for/to build|fix"), never a model a reviewer or tester is given, never a bare "Claude" (that is the account's word).
  if (role === "build") {
    const REVIEWISH = "(?:review|reviews|reviewing|reviewer|check|checks|checking|test|tests|testing|tester)";
    for (const m of MODEL_WORDS) {
      if (m.re === ACCOUNT_WORDS || m.re.source === "\\bclaude\\b") continue;
      const using = new RegExp(`\\b(?:using|via)\\s+(?:an?\\s+|the\\s+)?(?:${m.re.source})(?!\\s+(?:(?:for|as|to)\\s+(?:the\\s+)?)?${REVIEWISH}\\b)(?=\\s*(?:$|[,;!?]|\\.(?:\\s|$)|\\s+(?:on|via|and|then|for\\s+(?:the\\s+)?(?:build|fix|job|change)|to\\s+(?:build|fix|do|make|change))\\b))`, "i");
      if (using.test(text) && m.guard?.(text) !== false) return m.binding(d, text);
    }
  }
  return null;
}

export function templateFrom(text: string): RoleTemplate {
  if (/\b(?:just|only)\s+review\b|\breview[- ]only\b|\breview (?:the|my) (?:branch|code|changes)\b/i.test(text)) return "review-only";
  if (/\b(?:add|with) a tester\b|\btest[- ]author\b|\bwrite (?:the )?tests\b/i.test(text)) return "build+review+test-author";
  if (/\b(?:no|without)\s+(?:a\s+|any\s+)?review(?:er)?\b|\bbuild[- ]only\b/i.test(text)) return "build-only";
  if (/\binvestigate\b|\blook into\b|\bfind out why\b/i.test(text)) return "investigate";
  return "build+review";
}

const AGENT_WORD = "(?:(?:(?:openrouter|paid|metered)\\s+)?(?:opus|sonnet|fable|haiku|codex|claude|hermes|deep[ -]?seek|mimo|muse|cline|astra))";
/** A sentence that starts with the task itself ("Fix the Claude reviewer badge…"), not with who does it. */
const TASK_SENTENCE = /^\s*(?:(?:hey\s+)?jarvis[,\s]+)?(?:please\s+)?(?:fix|make|change|update|add|remove|delete|rename|set|move|refactor|rewrite|create|implement|improve|investigate|look into|find out|debug|repair|replace|hide|show|style|colou?r|clean up|tidy|speed up|stop|ensure|align|centre|center|correct|swap|convert|build (?:a|an|the)\b)/i;
/** One clause that only says who does which role ("Opus builds", "another Opus reviews it", "use Sonnet for the build"). */
const TEAM_CLAUSE = new RegExp(
  `^(?:(?:and|then|with|while|but|have|get|plus)\\s+)*(?:(?:(?:another|a second|an?|the)\\s+)?${AGENT_WORD}(?:\\s+(?:agent|model|session))?\\s+(?:(?:should|will|can|must|to)\\s+)?(?:builds?|building|reviews?|reviewing|tests?|as (?:the )?(?:builder|reviewer|tester))|use\\s+(?:(?:another|an?)\\s+)?${AGENT_WORD}\\s+(?:for|as)\\s+(?:the\\s+)?(?:build|builder|review|reviewer|tests?|tester))(?:\\s+(?:it|this|that|them|the (?:build|code|changes?|work|diff)|after(?:wards)?|too|as well))*[.!]?$`,
  "i",
);

/** A task verb with a real object next ("fix the login bug", not "build it" or "review the code"). */
const TASK_AHEAD =
  "(?:fix|make|change|update|add|remove|delete|rename|set|move|refactor|rewrite|create|implement|improve|investigate|look into|find out|debug|repair|replace|hide|show|style|colou?r|clean up|tidy|speed up|stop|ensure|align|centre|center|correct|swap|convert|build|write)\\s+(?!(?:it|this|that|them|the (?:build|code|changes?|work|diff))\\b)[a-z0-9'\"]";
/**
 * An agent-first lead-in at the start of a sentence (REVIEW-T1 P1 follow-up): "Codex, fix X", "ask Codex to
 * fix X", "assign Codex to build X", "have Opus build X", "use Codex as the builder to add X". Stripped, so the
 * task clause that follows is the objective.
 */
const LEAD_IN = new RegExp(
  `(^|[.!?]\\s+)(?:please\\s+)?(?:${AGENT_WORD}\\s*[,:]\\s*|(?:ask|tell|assign|get|have|let|use|using)\\s+(?:(?:another|an?|the)\\s+)?${AGENT_WORD}(?:\\s+(?:agent|model|session))?\\s+(?:(?:as|for)\\s+(?:the\\s+)?(?:builder|build)\\s+)?(?:to\\s+)?)(?=${TASK_AHEAD})`,
  "gi",
);
/** "Claude builds and reviews the fix for X" / "Codex fixes the login bug": the agent is the subject; keep the verb and the task. */
const AGENT_DOES = new RegExp(
  `(^|[.!?]\\s+)(?:please\\s+)?${AGENT_WORD}\\s+(build|fix|implement|add|write)(?:es|s)?(?:\\s+and\\s+reviews?)?\\s+(?!(?:it|this|that|them)\\b)(?=[a-z])`,
  "gi",
);

/**
 * "assign a builder to fix X and a reviewer to check it", "have a builder fix X", "get a builder to X and a
 * second agent to check it" (no model named): the role words only say who does what. The lead-in and the
 * reviewer tail are stripped so the objective is the task itself.
 */
const ROLE_LEAD = new RegExp(`(^|[.!?]\\s+)(?:please\\s+)?(?:assign|get|have|let|put|give me|i want)\\s+(?:an?|the|another|one)\\s+(?:builder|coder|developer|agent)(?:\\s+and\\s+(?:an?|the|another|one)\\s+(?:reviewer|checker|second agent))?(?:\\s+to)?\\s+(?=${TASK_AHEAD})`, "gi");
const ROLE_NOUN = "(?:second agent|another agent|second reviewer|reviewer|checker)";
const ROLE_TAIL = new RegExp(`(?:\\s*[,;]\\s*|\\s+(?:and|then|plus|with)\\s+)(?:(?:an?|the|another|one)\\s+)?${ROLE_NOUN}\\s+(?:(?:should|will|can|must|to)\\s+)?(?:check|checks|review|reviews|verify|verifies)\\b(?:\\s+(?:it|this|that|them|the (?:build|code|changes?|work|diff|fix)|after(?:wards)?|too|as well))*(?=\\s*(?:[.!,;]|$|\\b(?:and|then)\\b))`, "gi");
/** A whole sentence that is only the reviewer's job: "Then a reviewer checks it." */
const ROLE_SENTENCE = new RegExp(`(^|[.!?]\\s+)(?:(?:and|then)\\s+)?(?:(?:an?|the|another|one)\\s+)?${ROLE_NOUN}\\s+(?:(?:should|will|can|must|to)\\s+)?(?:check|checks|review|reviews|verify|verifies)\\b(?:\\s+(?:it|this|that|them|the (?:build|code|changes?|work|diff|fix)|after(?:wards)?|too|as well))*\\s*[.!]?(?=\\s|$)`, "gi");

/**
 * The request with the team/model/show-me phrasing stripped: what's left is the objective.
 * Agent-first lead-ins ("Codex, fix X…", "ask Codex to fix X and Claude to review") are stripped first.
 * A sentence about who builds/reviews is dropped whole; but a sentence that starts with the task keeps it,
 * even when the task names an agent or a role ("Fix the Claude reviewer badge colour", REVIEW-T3 R5), and
 * only its team clauses ("…, Opus builds, Codex reviews") are dropped.
 */
const JOB_LEAD = /^\s*(?:please\s+)?(?:start|begin|kick off|create|open|set up|run|spin up|queue|make)\s+(?:me\s+)?(?:a|an|the|another)?\s*(?:new\s+)?coding\s+(?:job|task|run)\s*(?:to|for|that|which|so (?:that )?it|:|,|-)?\s*/i;

export function objectiveFrom(text: string): string {
  return text
    .replace(/^\s*(?:hey\s+)?jarvis[,\s]+/i, "")
    .replace(JOB_LEAD, "")
    .replace(LEAD_IN, "$1")
    .replace(ROLE_LEAD, "$1")
    .replace(ROLE_TAIL, "")
    .replace(ROLE_SENTENCE, "$1")
    .replace(AGENT_DOES, (_m, lead: string, verb: string) => `${lead}${verb.toLowerCase()} `)
    // A sentence ends at a full stop followed by a space (or the end), so "src/a.ts" doesn't split one.
    .replace(/(?:[^.]|\.(?=\S))*\b(?:builds?|reviews?|reviewer|builder|tester)\b(?:[^.]|\.(?=\S))*\.?/gi, (s) => {
      if (!/\b(?:opus|sonnet|codex|claude|hermes|deepseek|mimo|muse|cline|another|agent)\b/i.test(s)) return s;
      if (!TASK_SENTENCE.test(s)) return "";
      const parts = s.split(/(\s*[,;]\s*|\s+and\s+)/i);
      const kept: string[] = [parts[0]];
      for (let i = 1; i < parts.length; i += 2) if (!TEAM_CLAUSE.test(parts[i + 1].trim())) kept.push(parts[i], parts[i + 1]);
      const end = /\.\s*$/.test(s) && !/\.\s*$/.test(kept[kept.length - 1]) ? "." : "";
      return kept.join("") + end;
    })
    .replace(/\bshow me (?:the )?(?:tests?|what changed|changes|diff)(?: and (?:the )?(?:tests?|what changed|changes|diff))?\.?/gi, "")
    .replace(/\b(?:and )?(?:then )?(?:merge|deploy|push) it\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim()
    .replace(/[.,;]+$/, "");
}

/** An objective with a verb and a concrete target/symptom; "fix the dashboard" alone is not enough. */
export function objectiveComplete(objective: string): boolean {
  const words = objective.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (words.length >= 9) return true;
  if (words.length >= 6 && /^(?:fix|change|update|add|remove|rename|refactor|rewrite|improve|debug|repair|replace|hide|show|style|clean up|speed up|correct|implement|build|create|make)\b/i.test(objective) && /\b(?:in|on|of|for)\s+(?:the\s+|our\s+|my\s+|a\s+)?[\w'-]+/i.test(objective)) return true;
  return /\b(?:so that|because|when|shows?|should|to\s+\w+|instead of|wrong|broken|missing|error|fails?|set|add|rename|remove|change|make)\b/i.test(objective) && words.length >= 5;
}

export const CONSEQUENTIAL_WORDS = /\b(?:merge|deploy|push|publish|release|ship it)\b/i;

function repoByWords(text: string, repos: readonly RepoRegistryEntry[]): { id: string; score: number }[] {
  const t = text.toLowerCase();
  return repos
    .map((r) => {
      const idWords = r.id.split("-").filter((w) => w.length > 2 && w !== "muv");
      let score = t.includes(r.id) ? 3 : 0;
      for (const w of idWords) if (new RegExp(`\\b${w}`, "i").test(t)) score += 1;
      for (const w of r.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4)) if (t.includes(w)) score += 0.25;
      return { id: r.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────── Jev ───────────────────────────

function jevPolicy(confidence: number, margin: number): JevDecision["policy"] {
  if (confidence >= 0.6 && margin >= 0.2) return "act";
  if (confidence >= 0.4) return "look-again";
  return "ask";
}

async function askJev(deps: ShaperDeps, text: string, repos: readonly RepoRegistryEntry[]): Promise<{ answers: JevAnswers | null; model: string; ms: number }> {
  if (!deps.jev) return { answers: null, model: "none", ms: 0 };
  const questions: Record<string, unknown> = {
    repo: { type: "choice", instructions: "Which code repository is this coding request about?", criteria: Object.fromEntries(repos.map((r) => [r.id, r.description])) },
    complete: { type: "score", instructions: "Does the request say concretely what should change or what is wrong (not just which area)?" },
    consequential: { type: "score", instructions: "Does the request ask to merge, push, deploy, publish or release anything?" },
    // Jev may delegate: which model is best for each role. Its pick is used only if that model is available and allowed.
    builder: { type: "choice", instructions: "Which model should BUILD this change (write the code)?", criteria: MODEL_CRITERIA },
    reviewer: { type: "choice", instructions: "Which model should independently REVIEW the change? It must not be the builder's model.", criteria: MODEL_CRITERIA },
  };
  try {
    const out = await deps.jev({ state: { request: redactText(text, 1000) }, questions });
    if (!out || !out.ok) return { answers: null, model: "jev-unavailable", ms: out?.ms ?? 0 };
    return { answers: out.answers, model: String((out.raw as { model?: string } | null)?.model ?? "jev-latest"), ms: out.ms };
  } catch { return { answers: null, model: "jev-error", ms: 0 }; }
}

const MODEL_CRITERIA: Record<string, string> = {
  "claude-opus-5-5": "Opus: the strongest general coder; large or subtle changes",
  "claude-sonnet-5-5": "Sonnet: lighter and faster; small, well-scoped changes",
  "gpt-6-astra": "Codex: strong at test and typecheck repair and mechanical refactors",
};
const isFreeBinding = (b: AgentBinding) => b.route === "model-router" && b.model.startsWith("cline/");

// ─────────────────────────── the shaper ───────────────────────────

export function createShaper(deps: ShaperDeps) {
  const pending = new Map<string, Pending>();
  const now = () => (deps.now?.() ?? new Date());
  const sweep = () => { const t = Date.now(); for (const [k, p] of pending) if (t - p.at > TTL) pending.delete(k); };

  const choiceEnv = (): ChoiceEnv => {
    const base: ChoiceEnv = { cliVersions: deps.cliVersions(), accounts: deps.accounts(), readings: slotReadings(), ...deps.choice?.() };
    const pick = deps.claudeSlot?.();
    if (!pick) return base;
    // No Claude account can take work: Claude isn't an automatic pick (another provider is chosen, said aloud).
    if (!pick.slot) return { ...base, claudeBlocked: base.claudeBlocked ?? pick.reason };
    return { ...base, claudeSlot: pick.slot, claudeSlotWhy: pick.reason };
  };
  /** Builder and an independent reviewer for these words (named models win; the prefs and Jev's pick fill the rest). */
  function pickRoles(text: string, template: RoleTemplate, jevModels: Pending["jevModels"], prefs: CodingModelPrefs, override?: { builder?: AgentBinding | null; reviewer?: AgentBinding | null }): RoleChoiceResult {
    const first = pickRolesOnce(text, template, jevModels, prefs, override);
    // A draft never pairs the builder and the reviewer on one model (the /account route refuses the same edit).
    // However the words were read, the reviewer is picked again as a DIFFERENT model; if nothing else can run, say so.
    if (!first.ok || !first.reviewer || first.reviewer.binding.model !== first.builder.binding.model) return first;
    // The one exception is the owner asking for it in so many words: "Opus builds, another Opus reviews it" is a fresh
    // session of the same model, said aloud and named on purpose. A model merely read twice from the words is not.
    if (first.reviewer.choice.basis === "named" && SAME_MODEL_ASKED.test(text)) return first;
    const again = pickRolesOnce(text, template, jevModels, prefs, { builder: first.builder.binding, reviewer: null }, true);
    if (again.ok && (!again.reviewer || again.reviewer.binding.model !== again.builder.binding.model)) return again;
    return { ok: false, reason: `The builder and the reviewer would both be ${modelLabel(first.builder.binding.model)}, and no other model can review it right now. Name a different reviewer, or connect another account.` };
  }
  function pickRolesOnce(text: string, template: RoleTemplate, jevModels: Pending["jevModels"], prefs: CodingModelPrefs, override?: { builder?: AgentBinding | null; reviewer?: AgentBinding | null }, ignoreNamedReviewer = false): RoleChoiceResult {
    // An account named in the words applies to every Claude role of the job (the reviewer too), so "…using account two
    // and another agent review it" doesn't quietly put the review on a different login.
    const named = claudeSlotFromWords(text, deps.accounts());
    const env = named ? { ...choiceEnv(), claudeSlot: named, claudeSlotWhy: "the account you named", claudeBlocked: undefined } : choiceEnv();
    return chooseRoles({
      text, template, prefs, env, jev: jevModels,
      named: { builder: override?.builder ?? roleModel(text, "build", deps), reviewer: ignoreNamedReviewer ? null : override?.reviewer ?? roleModel(text, "review", deps) },
    });
  }

  async function finish(p: Pending): Promise<ShapeResult> {
    const registry = deps.registry();
    const entry = registry.repos.find((r) => r.id === p.repoId);
    if (!entry) return { kind: "refused", reason: "That repo isn't in the coding registry." };
    const text = [p.utterance, ...p.clarifications.map((c) => c.answer)].join(". ");
    const template = templateFrom(p.utterance);
    const prefs = deps.prefs?.() ?? DEFAULT_CODING_PREFS;
    // The words the owner said win; who does what when they don't is role-choice.ts (an independent reviewer,
    // the owner's paid/free prefs), and each pick carries the reason the draft says aloud.
    const callerPin = p.pin && (p.pin.accountSlot || p.pin.model) ? p.pin : null;
    // An account the words name must be able to take the work NOW: otherwise the request is refused by name, with the account that could take it,
    // and nothing is drafted on another account (round 10: the named account was used only as a preference, so a signed-out or exhausted one was
    // quietly replaced at start by the limit fallback).
    const namedSlot = claudeSlotFromWords(text, deps.accounts());
    const wantSlot = callerPin?.accountSlot ?? namedSlot;
    if (wantSlot?.startsWith("claude:") && deps.claudeSlot) {
      const can = deps.claudeSlot(wantSlot as ClaudeAccountSlot);
      // Refused only when the pick says why THIS account was passed over ("Claude Max 2: not signed in"); a pick that simply went elsewhere is not proof.
      const why = can.slot === wantSlot ? null : new RegExp(`${slotWords(wantSlot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\([^)]*\\))?: ([^;)]+)`).exec(can.reason)?.[1];
      if (why) {
        const instead = can.slot ? ` ${can.label} could take it: say "using ${can.label}" if you want that.` : "";
        return { kind: "refused", reason: `${slotWords(wantSlot)} isn't ready (${why}). Nothing was drafted, and I won't use a different account instead.${instead}` };
      }
    }
    // The words' account and builder model are a pin for the whole job, like a bot's setting: a retry or the limit fallback never moves the builder
    // to another account, and the receipts must show exactly this builder.
    // Only a subscription account's model (Claude or Codex) is pinned this way; a router model named in the words keeps its own route rules.
    const namedBuild = roleModel(text, "build", deps);
    const pinModel = namedBuild && (isClaudeModel(namedBuild.model) || isCodexModel(namedBuild.model)) ? namedBuild.model : null;
    const wordsPin: BuilderPin | null = !callerPin && (namedSlot || pinModel) ? { accountSlot: namedSlot ?? null, model: pinModel } : null;
    const pin = callerPin ?? wordsPin;
    let override: { builder?: AgentBinding | null } | undefined;
    if (pin) {
      const unpinned = pickRoles(text, template, p.jevModels, prefs);
      const pinned = pinnedBuilder(pin, roleModel(text, "build", deps), deps, unpinned.ok ? unpinned.builder.binding : null);
      if (!pinned.ok) return { kind: "refused", reason: pinned.reason };
      override = { builder: pinned.binding };
    }
    const chosen = pickRoles(text, template, p.jevModels, prefs, override);
    if (!chosen.ok) return { kind: "refused", reason: chosen.reason };
    // The pin is exact: whatever the words and the picks did, the builder is the pinned account and model or nothing is drafted.
    if (pin) {
      const b = chosen.builder.binding;
      if ((pin.accountSlot && b.accountSlot !== pin.accountSlot) || (pin.model && b.model !== pin.model)) return { kind: "refused", reason: `This bot's coding setting is ${[pin.accountSlot, pin.model && modelLabel(pin.model)].filter(Boolean).join(" with ")}, but the draft would have used ${modelLabel(b.model)} on ${b.accountSlot}. Nothing was drafted, and no other account or model was used instead.` };
    }
    const { builder, reviewer } = { builder: chosen.builder.binding, reviewer: chosen.reviewer?.binding ?? null };
    const namedTester = roleModel(text, "test", deps);
    const tester = template === "build+review+test-author" ? namedTester ?? (prefs.freeOnly ? builder : codexFor(deps)) : null;
    if (tester && namedTester && prefs.freeOnly && !isFreeBinding(namedTester)) return { kind: "refused", reason: `Free-only is on, so I won't run ${modelLabel(namedTester.model)}; it uses a paid plan or metered API. Name a free model or turn free-only off in coding-prefs.json.` };
    const site = isSiteRequest(p.utterance);
    const objective = p.objective ?? (site ? siteObjective(p.utterance) : objectiveFrom(p.utterance));
    const specId = randomUUID() as Uuid;
    let plan: PlannerDraft | { question: string } | null = null;
    if (site) plan = siteDraftPlan(entry, p.utterance);
    if (!plan && deps.planner && p.usePlanner) {
      try { plan = await deps.planner({ entry, objective, utterance: text, specId }); }
      catch (e) { return { kind: "refused", reason: `The planner couldn't draft this: ${redactText((e as Error).message, 200)}` }; }
    } else if (!plan) plan = heuristicPlan(entry, objective, text);
    if (!plan) {
      p.asked = "planner";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: "Which files should the builder change? Name the folder or files." };
    }
    if ("question" in plan) {
      p.asked = "planner";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: plan.question };
    }
    const jev: JevShapingRecord | null = p.decisions.length ? { model: p.jevModel, latencyMs: p.jevMs, decisions: p.decisions, clarifications: p.clarifications } : p.clarifications.length ? { model: "rules", latencyMs: 0, decisions: [], clarifications: p.clarifications } : null;
    const spec = draftSpec({
      id: specId,
      requestedBy: p.principal,
      channel: p.channel,
      utterance: p.utterance,
      entry,
      objective: plan.objective || objective,
      nonGoals: plan.nonGoals,
      doneWhen: plan.doneWhen,
      roleTemplate: template === "investigate" || template === "review-only" ? "build+review" : template,
      builders: plan.builders.map((b) => ({ binding: builder, owns: repoOwns(entry, b.owns), instructions: b.instructions })),
      testAuthor: tester && plan.testAuthorOwns ? { binding: tester, owns: plan.testAuthorOwns } : null,
      reviewer: reviewer ? { binding: reviewer } : null,
      checks: plan.checks,
      approvalPoints: CONSEQUENTIAL_WORDS.test(p.utterance) ? [{ action: "git.merge.protected", describe: `merge into ${entry.defaultBaseRef} of ${entry.id} (asked after completion)`, when: "after-completion" }] : [],
      jev,
      ...(pin ? { builderPin: { accountSlot: pin.accountSlot ?? null, model: pin.model ?? null } } : {}),
      roleChoices: [chosen.builder.choice, ...(chosen.reviewer ? [chosen.reviewer.choice] : [])],
      planner: plan.plannerSession ?? null,
      now: deps.now,
    });
    pending.delete(p.draftId);
    return { kind: "draft", spec, spokenSummary: spokenSummary(spec) };
  }

  /** A request, or the answer to the question just asked. */
  async function shape(input: { utterance: string; channel: "voice" | "typed" | "ui"; principal: VerifiedPrincipal; draftId?: string; answer?: string; usePlanner?: boolean; pin?: BuilderPin | null }): Promise<ShapeResult> {
    sweep();
    const registry = deps.registry();
    const repos = reposFor(registry, input.principal.personId);
    if (!repos.length) return { kind: "refused", reason: "No code repositories are set up for coding jobs yet (.operator-data/coding/repos.json)." };
    if (input.draftId) {
      const p = pending.get(input.draftId);
      if (!p || p.principal.personId !== input.principal.personId) return { kind: "refused", reason: "That draft expired; say the request again." };
      const answer = redactText(String(input.answer ?? input.utterance ?? ""), 600).trim();
      // A money order is never turned into a coding job, whatever lane sent it (REVIEW S2d-2).
      const moneyAnswer = codingMoneyRefusal(`${p.utterance}. ${answer}`);
      if (moneyAnswer) return { kind: "refused", reason: moneyAnswer };
      const noModelAnswer = unavailableModelWords(answer);
      if (noModelAnswer) return { kind: "refused", reason: noModelAnswer.reason };
      if (!answer) return { kind: "ask", draftId: p.draftId, question: "I didn't catch that. " + (p.asked === "repo" ? `Which repo: ${p.options.join(" or ")}?` : "What should change?") };
      p.clarifications.push({ question: p.asked ?? "", answer, at: now().toISOString() as IsoTime });
      if (p.asked === "repo") {
        const pick = repoByWords(answer, repos.filter((r) => p.options.includes(r.id)))[0] ?? (/\b(?:first|former)\b/i.test(answer) ? { id: p.options[0] } : /\b(?:second|latter|other)\b/i.test(answer) ? { id: p.options[1] } : null)
          ?? (/client|app|dashboard/i.test(answer) ? repoByWords(answer + " client app", repos.filter((r) => p.options.includes(r.id)))[0] : null);
        if (!pick) return { kind: "ask", draftId: p.draftId, question: `Sorry, which one: ${p.options.join(" or ")}?`, options: p.options };
        p.repoId = pick.id;
      } else if (p.asked === "objective") {
        p.objective = `${objectiveFrom(p.utterance)}: ${answer}`.replace(/^:\s*/, "");
      } else if (p.asked === "planner") {
        p.utterance = `${p.utterance}${/[.!?]$/.test(p.utterance) ? "" : "."} Files: ${answer}`;
      }
      p.asked = null;
      return next(p, repos);
    }
    const utterance = redactText(String(input.utterance ?? ""), 2000).trim();
    if (!utterance) return { kind: "refused", reason: "Say what the coding job should do." };
    // A money order is never turned into a coding job: voice, typed, the brain's delegate_task / run_workflow
    // and the Coding page all come through here (REVIEW S2d-2).
    const money = codingMoneyRefusal(utterance);
    if (money) return { kind: "refused", reason: money };
    // A model the words name that this harness can't run is said, never replaced by another (round 6).
    const noModel = unavailableModelWords(utterance);
    if (noModel) return { kind: "refused", reason: noModel.reason };
    // An account the words name that isn't connected here is said, never replaced by the automatic pick (round 10).
    const noAccount = unconnectedAccountWords(utterance, deps.accounts());
    if (noAccount) return { kind: "refused", reason: noAccount };
    const p: Pending = { draftId: randomUUID() as Uuid, principal: input.principal, usePlanner: input.usePlanner !== false, channel: input.channel, utterance, repoId: null, objective: null, asked: null, options: [], clarifications: [], decisions: [], jevModel: "none", jevMs: 0, jevModels: {}, pin: input.pin ?? null, at: Date.now() };
    // F1: a site request already says what to build; its first sentence is the objective, so nothing is asked.
    if (isSiteRequest(utterance)) p.objective = siteObjective(utterance);
    // A repo that exists but isn't registered is said plainly, not guessed between two other repos.
    const unregistered = unregisteredRepoMention(utterance, repos);
    if (unregistered) return { kind: "refused", reason: unregistered };
    const jev = await askJev(deps, utterance, repos);
    p.jevModel = jev.model;
    p.jevMs = jev.ms;
    for (const role of ["builder", "reviewer"] as const) {
      const pick = jev.answers?.[role];
      const probs2 = pick?.probabilities ? Object.entries(pick.probabilities).sort((a, b) => b[1] - a[1]) : [];
      if (!pick?.choice || !probs2.length) continue;
      const m2 = probs2.length > 1 ? probs2[0][1] - probs2[1][1] : probs2[0][1];
      const policy = jevPolicy(probs2[0][1], m2);
      p.decisions.push({ question: "modelFor", subject: role, choice: pick.choice, confidence: probs2[0][1], probabilities: pick.probabilities ?? undefined, policy });
      if (policy === "act") p.jevModels[role] = pick.choice;
    }
    // Repo: the owner's explicit words, else Jev, else ask.
    const byWords = repoByWords(utterance, repos);
    const probs = jev.answers?.repo?.probabilities ?? null;
    const jevTop = probs ? Object.entries(probs).sort((a, b) => b[1] - a[1]) : [];
    const margin = jevTop.length > 1 ? jevTop[0][1] - jevTop[1][1] : jevTop.length ? jevTop[0][1] : 0;
    if (jev.answers?.repo) p.decisions.push({ question: "repo", choice: jev.answers.repo.choice ?? null, confidence: jevTop[0]?.[1] ?? jev.answers.repo.confidence ?? 0, probabilities: probs ?? undefined, policy: jevPolicy(jevTop[0]?.[1] ?? 0, margin) });
    const complete = jev.answers?.complete?.score;
    if (typeof complete === "number") p.decisions.push({ question: "complete", choice: null, confidence: complete, policy: complete >= 0.6 ? "act" : complete >= 0.4 ? "look-again" : "ask" });
    const consequential = jev.answers?.consequential?.score;
    if (typeof consequential === "number") p.decisions.push({ question: "consequential", choice: null, confidence: consequential, policy: consequential >= 0.6 ? "act" : "look-again" });
    if (repos.length === 1) p.repoId = repos[0].id;
    else if (byWords.length && (byWords.length === 1 || byWords[0].score - byWords[1].score >= 1)) p.repoId = byWords[0].id;
    else if (jevTop.length && jevPolicy(jevTop[0][1], margin) === "act" && repos.some((r) => r.id === jevTop[0][0])) p.repoId = jevTop[0][0];
    else {
      const options = (jevTop.length ? jevTop.map(([id]) => id) : byWords.length ? byWords.map((b) => b.id) : repos.map((r) => r.id)).filter((id) => repos.some((r) => r.id === id)).slice(0, 2);
      if (options.length < 2) options.push(...repos.map((r) => r.id).filter((id) => !options.includes(id)).slice(0, 2 - options.length));
      p.options = options;
      p.asked = "repo";
      pending.set(p.draftId, p);
      const describe = (id: string) => { const r = repos.find((x) => x.id === id)!; return `${id} (${r.description.split(/[:;]/)[0]})`; };
      return { kind: "ask", draftId: p.draftId, question: `Which one: ${describe(options[0])}, or ${describe(options[1])}?`, options };
    }
    return next(p, repos);
  }

  async function next(p: Pending, repos: readonly RepoRegistryEntry[]): Promise<ShapeResult> {
    if (!p.repoId) return { kind: "ask", draftId: p.draftId, question: `Which repo: ${repos.slice(0, 2).map((r) => r.id).join(" or ")}?`, options: repos.slice(0, 2).map((r) => r.id) };
    const objective = p.objective ?? objectiveFrom(p.utterance);
    const jevComplete = p.decisions.find((d) => d.question === "complete");
    const complete = objectiveComplete(objective) && !(jevComplete && jevComplete.confidence < 0.4 && objective.split(/\s+/).length < 9);
    if (!complete && !p.objective) {
      p.asked = "objective";
      pending.set(p.draftId, { ...p, at: Date.now() });
      return { kind: "ask", draftId: p.draftId, question: `What should change in ${p.repoId}? Tell me what's wrong or what it should do.` };
    }
    return finish(p);
  }

  return { shape, pending: () => pending.size, /** Drop a pending question (an explicit Stop): the next words are a new request, never its answer. */ cancel: (draftId: string) => pending.delete(draftId as Uuid), pickRoles: (text: string, template: RoleTemplate, override?: { builder?: AgentBinding | null; reviewer?: AgentBinding | null }) => pickRoles(text, template, {}, deps.prefs?.() ?? DEFAULT_CODING_PREFS, override), bindingFromWords: (text: string) => bindingFromWords(text, deps), prefs: () => deps.prefs?.() ?? DEFAULT_CODING_PREFS };
}

// A Windows drive path ("C:/Users/Nebula PC/.../BRIEF.md"). A folder name may hold spaces ("Nebula PC") when the next
// word starts with a capital or a digit; a lower-case word ("and fix src/a.ts") ends the path, so a relative file
// named after it is never swallowed. The last segment (the file) holds no space.
const EXT = "ts|tsx|js|jsx|mjs|cjs|py|md|json|css|html|txt|sql|prisma|yml|yaml";
// "*" is allowed so a glob ("C:/x/app/src/**") stays one token.
const PATH_WORD = String.raw`[^\s\\/"'<>|?,;]+`;
// A continuation word never holds ":" so a second drive path ("And C:/x.ts") starts a new match instead of joining this one.
const PATH_CONT = String.raw`(?: [A-Z0-9][^\s\\/:"'<>|?,;]*)`;
const PATH_SEG = String.raw`${PATH_WORD}${PATH_CONT}*`;
// The file name may hold spaces too ("Read Me.md": capitalised words up to a known extension). A path cut short takes one
// following capitalised word with it, so that word is never re-read as a file at the repo root.
const WIN_ABS = new RegExp(
  String.raw`([A-Za-z]:[\\/](?:${PATH_SEG}[\\/])*(?:(?!${PATH_WORD}\.(?:${EXT})(?![\w-]))${PATH_WORD}${PATH_CONT}{1,3}(?<=\.(?:${EXT}))(?![\w-])|${PATH_WORD})?)(?: [A-Z0-9][\w-]*(?![\w./\\:-]))?`,
  "g",
);
const POSIX_ABS = /(?<![\w.~:/\\-])~?(?:\/[\w.@-]+)+\/?/g;

/**
 * Absolute paths named in the words: taken out of the text (so a space in one never splits it into a relative
 * file), and kept only when they sit inside the repo (as a repo-relative path). One outside the repo is never owned.
 */
export function absolutePathsIn(entry: Pick<RepoRegistryEntry, "canonicalPath">, text: string): { rest: string; inside: string[]; outside: string[] } {
  const root = entry.canonicalPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const inside: string[] = [], outside: string[] = [];
  const take = (m: string) => {
    const norm = m.replace(/\\/g, "/").replace(/[.,;:!?)]+$/, "");
    const low = norm.toLowerCase();
    if (low.startsWith(root + "/") && !norm.includes("..")) inside.push(norm.slice(root.length + 1));
    else outside.push(norm);
    return " ";
  };
  const rest = text.replace(WIN_ABS, (_m: string, path: string) => take(path)).replace(POSIX_ABS, (m: string) => take(m));
  return { rest, inside, outside };
}

/** A plan from the request's own words: only when it names files (else the planner or a question decides). */
/** Whatever drafted the plan (words, planner), an absolute path is owned only when it is inside the repo, and then as a repo-relative path. */
export function repoOwns(entry: Pick<RepoRegistryEntry, "canonicalPath">, owns: { globs: readonly string[]; newFiles: readonly string[] }): { globs: string[]; newFiles: string[] } {
  const fix = (list: readonly string[]) => list.flatMap((f) => {
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(f)) return [f];
    const abs = absolutePathsIn(entry, f);
    return abs.inside;
  });
  return { globs: fix(owns.globs).filter(Boolean), newFiles: fix(owns.newFiles).filter(Boolean) };
}

export function heuristicPlan(entry: RepoRegistryEntry, objective: string, text0: string): PlannerDraft | null {
  const FILE = /\b((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|css|html|txt|sql|prisma|yml|yaml))\b/g;
  const DIR = /\b((?:[\w.-]+\/)+)(?:\*\*)?(?=[\s,.]|$)/g;
  // "Leave src/a.test.ts alone" / "don't touch src/legacy/": what a clause says to leave is off limits, not owned. Read clause by clause, so
  // "Fix src/a.ts but leave src/a.test.ts alone" gives a plan that owns a.ts and excludes the test, for files, folders and absolute paths alike (round 6).
  const LEAVE = /\b(?:leave|don'?t (?:touch|change|edit|modify)|do not (?:touch|change|edit|modify)|without (?:touching|changing|editing|modifying))\b/i;
  const CLAUSES = /(?<=[.!?])\s+|;\s*|,?\s+\bbut\b\s+|,\s*(?:and\s+)?(?=(?:leave|don'?t|do not|without)\b)|\s+and\s+(?=(?:leave|don'?t|do not|without)\b)/i;
  const wanted = new Set<string>(), wantedDirs = new Set<string>(), offLimits = new Set<string>();
  for (const clause of text0.split(CLAUSES)) {
    const abs = absolutePathsIn(entry, clause);
    const into = LEAVE.test(clause) ? offLimits : wanted;
    const intoDirs = LEAVE.test(clause) ? offLimits : wantedDirs;
    for (const p of abs.inside) { if (!p) continue; if (p.includes("*") || p.endsWith("/")) intoDirs.add(p.endsWith("/") ? `${p}**` : p); else into.add(p); }
    for (const m of abs.rest.matchAll(FILE)) into.add(m[1]);
    for (const m of abs.rest.matchAll(DIR)) intoDirs.add(`${m[1]}**`);
  }
  for (const f of [...wanted, ...wantedDirs]) offLimits.delete(f);
  const files = [...wanted];
  const dirs = [...wantedDirs];
  if (!files.length && !dirs.length) return null;
  const tests = entry.commands.filter((c) => c.kind === "test").map((c) => c.id);
  const typecheck = entry.commands.filter((c) => c.kind === "typecheck").map((c) => c.id);
  const checks = [...tests.slice(0, 1), ...typecheck.slice(0, 1)] as CommandId[];
  return {
    objective,
    nonGoals: ["No changes outside the owned files", "No dependency changes", ...[...offLimits].map((f) => `Do not change ${f.replace(/\*\*$/, "")}`)],
    doneWhen: [
      ...checks.map((id, i) => ({ id: `c${i + 1}`, text: `${id} passes at the integrated commit`, evidence: (entry.commands.find((c) => c.id === id)?.kind === "typecheck" ? "typecheck" : "test") as DoneCriterion["evidence"], ref: id })),
      { id: `c${checks.length + 1}`, text: objective, evidence: "reviewer-confirms" as const },
    ],
    // Named files that exist are owned; named files that don't exist yet are declared new files.
    builders: [{ owns: { globs: [...dirs, ...files.filter((f) => existsSync(join(entry.canonicalPath, f)))], newFiles: files.filter((f) => !existsSync(join(entry.canonicalPath, f))) } }],
    checks,
  };
}

export function unregisteredRepoMention(text: string, repos: readonly RepoRegistryEntry[]): string | null {
  if (repos.some((r) => /receptionist/i.test(r.id))) return null;
  if (/\bmu-receptionist\b/i.test(text) || /\b(?:mu[- ]?)?receptionist (?:app|repo|repository|project|codebase|dashboard)\b/i.test(text))
    return "The receptionist app isn't in the coding registry yet, so I can't draft that. Add mu-receptionist to .operator-data/coding/repos.json (its base branch and check commands) and ask again.";
  return null;
}

export const START_PROMPT = "Start it?";
export const STARTS_WITH_PROMPT = /(?:\bStart it\?|Say start when you want it built\.)\s*$/i;

export function draftTitle(spec: Pick<TaskSpec, "objective" | "repo">): string {
  let t = spec.objective
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/,?\s+(?:in|on) the [a-z0-9-]+ repo\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\s]+$/, "");
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, "").replace(/[.:;,\s]+$/, "") + "…";
  t = t || "coding job";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The paid OpenRouter routes by name (role-choice's table calls them plain "DeepSeek"/"MiMo", which sounds free). */
const paidName = (model: string) => (model === "openrouter/deepseek-v4-pro" ? "DeepSeek Pro (paid)" : model === "openrouter/mimo-v2.6-pro" ? "MiMo Pro (paid)" : `${model} (paid)`);
export const modelName = (b: AgentBinding | null) => (b ? (b.model.startsWith("openrouter/") ? paidName(b.model) : modelLabel(b.model)) : "nobody");

/** "Draft ready: receptionist app, Opus builds, Opus reviews, tests and typecheck. Start it?" */
export function spokenSummary(spec: TaskSpec): string {
  const roles = spec.roles ?? [];
  // A Claude role on another account than the original says which (the original stays unannounced, as before).
  const routes = roles.filter((r) => r.agent).map((r) => `${r.roleId}: ${r.agent!.model}${r.agent!.route === "claude-code-cli" && r.agent!.accountSlot !== "claude:max" ? ` on Claude account ${r.agent!.accountSlot.split("-").pop()}` : ""}${r.agent!.model.startsWith("cline/") ? " (free only)" : r.agent!.model.startsWith("openrouter/") ? " (PAID: metered per token through OpenRouter)" : r.agent!.route === "model-router" ? " (automatic fallback may use metered models)" : ""}`);
  // A paid route is said before Start, in plain words, in addition to the route list.
  const paid = [...new Set(roles.filter((r) => r.agent?.route === "model-router" && r.agent.model.startsWith("openrouter/")).map((r) => paidName(r.agent!.model)))];
  const snapshot = spec.repo?.baseSha ? `Source snapshot: ${spec.repo.baseRef} at ${spec.repo.baseSha.slice(0, 12)}; uncommitted checkout changes are excluded. ` : "";
  const who = choiceSentence(spec.roleChoices);
  const namedRoles = who ? "" : roles.filter((r) => r.agent).map((r) => `${modelName(r.agent)} ${r.role === "builder" ? "builds" : r.role === "reviewer" ? "reviews" : "writes tests"}`).join(", ");
  const roleText = (who || namedRoles).replace(/[.!?\s]+$/, "");
  const repo = spec.repo?.repoId ? `${spec.repo.repoId} — ` : "";
  return "Draft ready: " + repo + draftTitle(spec) + ". " + snapshot + (routes.length ? `Selected routes: ${routes.join("; ")}. ` : "") + (paid.length ? `Paid route: ${paid.join(" and ")} costs money per token through OpenRouter, so check that is what you want before you say start. ` : "") + (roleText ? `${roleText}. ` : "") + START_PROMPT;
}

export { slugOf };

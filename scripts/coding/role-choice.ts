import { existsSync, lstatSync, readFileSync } from "node:fs";
import { route as routerRoute, type RouteConstraints } from "../model-router/router";
import { pickCodexSlot, type AccountsConfig, type SlotReading } from "./accounts";
import type { AgentBinding, RoleChoice, RoleTemplate } from "./contracts";
import { claudeBinding, codexBinding, ROUTER_TASK, routerBinding } from "./spec";

/**
 * Who builds and who reviews when the words don't say (CODING-HARNESS §3.2, brief "assign a builder to fix X
 * and a reviewer to check it"). Pure, deterministic and injectable: no clock, no file read, no network. The
 * shaper passes what is available (CLI versions, connected Codex accounts and their windows, the router
 * catalogue) and the owner's CodingModelPrefs; this returns the builder and an INDEPENDENT reviewer, each with
 * a short `why` the draft can say aloud.
 *
 *  - Words the owner said always win ("Opus builds, Codex reviews"); the auto picks work around them.
 *  - The reviewer is never the builder's model, and prefers a different provider family. Two roles are
 *    always two sessions; a different MODEL is what makes the check independent.
 *  - Jev (the typed decision brain) may PROPOSE a model for a role; its pick is used only if that model is
 *    available and the prefs allow it, and it is recorded as basis "jev". It never overrides the words.
 *  - Prefs (`.operator-data/coding-prefs.json`): the safe default is today's behaviour: paid SUBSCRIPTION
 *    models (Claude plan, Codex accounts) may be chosen; metered or paid-API models are never auto-selected.
 *    `freeOnly` picks from the verified-free Cline routes only, and refuses an explicitly named paid model
 *    rather than running it. `allowPaidFallback: false` stops a routed role falling back onto a metered
 *    model when its own route is down (runners/router.ts reads it).
 *  - The choice is a plan. The receipt of each run records the model that ACTUALLY ran.
 */

export type CodingModelPrefs = {
  /** Only the verified-free Cline routes; a named paid model is refused with the way out. */
  freeOnly: boolean;
  /** A routed role may fall back onto a metered model when its route is down (today's behaviour: true). */
  allowPaidFallback: boolean;
  /** Model ids tried first, in order (binding vocabulary: "claude-opus-5-5", "gpt-6-astra", "cline/mimo-v2.6-flash"). */
  preferred?: string[];
};

export const DEFAULT_CODING_PREFS: CodingModelPrefs = { freeOnly: false, allowPaidFallback: true };

/** The names Jarvis says. The single map (shaper.modelName re-exports it). */
export const MODEL_NAME: Record<string, string> = {
  "claude-opus-5-5": "Opus", "claude-sonnet-5": "Sonnet", "claude-fable-5-1": "Fable", "claude-haiku-4-5": "Haiku",
  "gpt-6-astra": "Codex", "codex/gpt-6-sol": "Hermes (GPT-6 Sol)", "openrouter/deepseek-v4-pro": "DeepSeek", "openrouter/mimo-v2.6-pro": "MiMo", "cline/deepseek-v4.1-flash": "Cline DeepSeek", "cline/mimo-v2.6-flash": "Cline MiMo", "cline/muse-spark-1.3": "Cline Muse",
};
export const modelLabel = (model: string) => MODEL_NAME[model] ?? model;

/** Models whose "no charge" the catalogue verifies (Cline's free list) and that `coding.router` may run. */
export const FREE_CODING_MODELS = ["cline/deepseek-v4.1-flash", "cline/mimo-v2.6-flash", "cline/muse-spark-1.3"] as const;

export type ChoiceEnv = {
  cliVersions: { claude: string; codex: string };
  /** false = known not installed/signed in; undefined = unknown (assumed available, as today). */
  claudeAvailable?: boolean;
  codexAvailable?: boolean;
  /** Codex's sandbox isolation applied (a Codex role can start). undefined = assumed. */
  codexReady?: boolean;
  /** A reason Claude can't start a role now (its window is at the stop threshold). */
  claudeBlocked?: string | null;
  accounts: AccountsConfig;
  readings: readonly SlotReading[];
  /** The router's route() and key lookup, injectable so a test needs no catalogue state or key files. */
  route?: typeof routerRoute;
  hasKey?: (name: string) => boolean;
};

type Cand = { model: string; family: string; free: boolean; binding: AgentBinding; why: string };

export type Picked = { binding: AgentBinding; choice: RoleChoice };
export type RoleChoiceResult =
  | { ok: true; builder: Picked; reviewer: Picked | null; notes: string[] }
  | { ok: false; reason: string };

export type RoleChoiceInput = {
  text: string;
  template: RoleTemplate;
  /** Bindings the owner's words named for a role (null = not named). */
  named: { builder: AgentBinding | null; reviewer: AgentBinding | null };
  env: ChoiceEnv;
  prefs: CodingModelPrefs;
  /** Model ids Jev proposed for a role, when it answered; used only when allowed and available. */
  jev?: { builder?: string | null; reviewer?: string | null };
};

const SMALL_CHANGE = /\b(?:typo|label|wording|copy|colou?r|padding|margin|spacing|font|rename|tooltip|text|icon|css|style|styling|readme|comment)\b/i;
const TEST_REPAIR = /\b(?:failing tests?|flaky|typecheck|type errors?|lint(?:ing)?|test suite)\b/i;

export const familyOf = (b: AgentBinding): string =>
  b.route === "claude-code-cli" ? "anthropic" : b.route === "codex-app-server" ? "openai" : b.model.startsWith("codex/") ? "openai" : b.model.startsWith("claude/") ? "anthropic" : `router:${b.model.split("/").pop()!.split(/[-.]/)[0]}`;

const isFree = (b: AgentBinding) => b.route === "model-router" && b.model.startsWith("cline/");
const sameModel = (a: AgentBinding, b: AgentBinding) => a.route === b.route && a.model === b.model;

/** The candidates that could run now, in the default order for a role, each with the reason it would be picked. */
function candidates(role: "builder" | "reviewer", input: RoleChoiceInput): Cand[] {
  const { env, prefs, text } = input;
  const out: Cand[] = [];
  const claudeOk = env.claudeAvailable !== false && !env.claudeBlocked;
  const add = (binding: AgentBinding, why: string) => out.push({ model: binding.model, family: familyOf(binding), free: isFree(binding), binding, why });
  if (!prefs.freeOnly) {
    const small = role === "builder" && SMALL_CHANGE.test(text) && !TEST_REPAIR.test(text);
    const codexSlot = env.codexAvailable !== false && env.codexReady !== false ? pickCodexSlot(env.accounts, env.readings) : null;
    const opus = claudeOk ? [claudeBinding("claude-opus-5-5", env.cliVersions.claude), "your Claude plan, the strongest general coder"] as const : null;
    const sonnet = claudeOk ? [claudeBinding("claude-sonnet-5", env.cliVersions.claude), small ? "a small change, so the lighter model saves your Claude allowance" : "a lighter Claude model"] as const : null;
    // A slot that would draw paid credits (every plan window at its limit) is never an automatic pick.
    const codex = codexSlot?.ok && !codexSlot.creditsLikely ? [codexBinding("gpt-6-astra", codexSlot.slot.slot, env.cliVersions.codex), `your Codex account ${codexSlot.slot.slot.replace("codex:", "")}${/least used at \d+%/.exec(codexSlot.reason)?.[0] ? `, ${/least used at \d+%/.exec(codexSlot.reason)![0]}` : ""}`] as const : null;
    const order = role === "builder"
      ? (small ? [sonnet, opus, codex] : TEST_REPAIR.test(text) ? [codex, opus, sonnet] : [opus, codex, sonnet])
      : [opus, codex, sonnet];
    for (const c of order) if (c) add(c[0], c[1]);
  }
  // Free Cline routes: the whole pool under freeOnly; otherwise the last resort for a builder (no paid model
  // available) and the last choice for a reviewer (so it can still be a different model than the builder).
  if (prefs.freeOnly || !out.length || role === "reviewer") {
    const route = env.route ?? routerRoute;
    for (const id of FREE_CODING_MODELS) {
      try {
        const c = route(ROUTER_TASK, { selected: id, selectedBy: "rule", freeOnly: true, hasKey: env.hasKey } as RouteConstraints);
        if (c.model === id && !c.fallbackFrom) add(routerBinding(id), `a verified-free route (${prefs.freeOnly ? "free-only is on" : role === "reviewer" ? "the only other model available" : "no paid model is available"})`);
      } catch { /* not configured or unhealthy: not a candidate */ }
    }
  }
  return out;
}

/** Preferred (coding-prefs) first, then Jev's proposal, then the default order. */
function rank(list: Cand[], input: RoleChoiceInput, role: "builder" | "reviewer"): { cand: Cand; basis: RoleChoice["basis"] }[] {
  const pref = input.prefs.preferred ?? [];
  const jev = input.jev?.[role] ?? null;
  const at = (c: Cand) => { const i = pref.indexOf(c.model); return i < 0 ? Infinity : i; };
  const scored = list.map((cand, i) => ({ cand, i, p: at(cand), j: jev && cand.model === jev ? 0 : 1 }));
  scored.sort((a, b) => (a.p !== b.p ? a.p - b.p : a.j !== b.j ? a.j - b.j : a.i - b.i));
  return scored.map((s) => ({ cand: s.cand, basis: s.p !== Infinity ? "preferred" as const : s.j === 0 ? "jev" as const : "auto" as const }));
}

function record(role: RoleChoice["role"], binding: AgentBinding, basis: RoleChoice["basis"], why: string): Picked {
  return { binding, choice: { role, model: binding.model, accountSlot: binding.accountSlot, family: familyOf(binding), basis, why } };
}

const basisWhy = (basis: RoleChoice["basis"], why: string) => (basis === "preferred" ? `your saved preference; ${why}` : basis === "jev" ? `Jev's pick; ${why}` : why);

/** A named binding that free-only refuses (anything that isn't a verified-free Cline route). */
export function freeOnlyRefusal(b: AgentBinding | null, prefs: CodingModelPrefs): string | null {
  if (!b || !prefs.freeOnly || isFree(b)) return null;
  return `Free-only is on, so I won't run ${modelLabel(b.model)}; it uses a paid plan or metered API. Name a free model (${FREE_CODING_MODELS.map(modelLabel).join(", ")}) or turn free-only off in coding-prefs.json.`;
}

export function chooseRoles(input: RoleChoiceInput): RoleChoiceResult {
  const { named, prefs, template } = input;
  const notes: string[] = [];
  const refused = freeOnlyRefusal(named.builder, prefs) ?? freeOnlyRefusal(named.reviewer, prefs);
  if (refused) return { ok: false, reason: refused };
  const wantsReviewer = template !== "build-only";

  // Nothing known-installed: keep today's default rather than inventing a fallback the box can't run.
  const claudeKnown = input.env.claudeAvailable !== false;
  const noneKnown = !claudeKnown && input.env.codexAvailable === false;

  let builder: Picked | null = named.builder ? record("builder", named.builder, "named", `you asked for ${modelLabel(named.builder.model)}`) : null;
  const reviewerNamed: Picked | null = named.reviewer && wantsReviewer ? record("reviewer", named.reviewer, "named", `you asked for ${modelLabel(named.reviewer.model)}`) : null;

  if (!builder) {
    const ranked = rank(candidates("builder", input), input, "builder");
    // With a named reviewer, prefer a builder that isn't the same model (so the check stays independent).
    const distinct = reviewerNamed ? ranked.filter((r) => !sameModel(r.cand.binding, reviewerNamed.binding)) : ranked;
    const pool = distinct.length ? distinct : ranked;
    const first = pool[0];
    if (first) builder = record("builder", first.cand.binding, first.basis, basisWhy(first.basis, first.cand.why));
    else if (!noneKnown) return { ok: false, reason: prefs.freeOnly ? "Free-only is on, but no free coding route is set up on this PC (Cline). Turn free-only off in coding-prefs.json or connect a free route." : "No coding model is available right now. Check the accounts on the Coding page." };
    else builder = record("builder", claudeBinding("claude-opus-5-5", input.env.cliVersions.claude), "auto", "the default (nothing reported as connected yet)");
  }

  let reviewer: Picked | null = reviewerNamed;
  if (wantsReviewer && !reviewer) {
    const ranked = rank(candidates("reviewer", input), input, "reviewer").filter((r) => !sameModel(r.cand.binding, builder!.binding));
    // An explicit preference or Jev's pick first; then a different provider family; then another model of the same
    // family; a free route only after those (unless free-only is on). The default order breaks ties.
    const fam = builder.choice.family;
    const tier = (r: (typeof ranked)[number]) => (r.basis !== "auto" ? 0 : r.cand.free && !prefs.freeOnly ? 3 : r.cand.family !== fam ? 1 : 2);
    const first = [...ranked].sort((a, b) => tier(a) - tier(b))[0];
    if (first) {
      const differs = first.cand.family !== fam;
      const why = first.basis === "auto"
        ? `${differs ? "a different provider than the builder" : "a different model than the builder"}, so it isn't checking its own work; ${first.cand.why}`
        : basisWhy(first.basis, `${differs ? "a different provider than the builder" : "a different model than the builder"}; ${first.cand.why}`);
      reviewer = record("reviewer", first.cand.binding, first.basis, why);
    } else if (noneKnown) {
      reviewer = record("reviewer", claudeBinding("claude-sonnet-5", input.env.cliVersions.claude), "auto", "a different model than the builder (nothing reported as connected yet)");
    } else {
      // Only one model can run: the same model in a fresh, read-only session, said out loud.
      reviewer = record("reviewer", builder.binding, "auto", `only ${modelLabel(builder.binding.model)} is available, so it reviews in a separate read-only session`);
      notes.push("The reviewer is the same model as the builder (nothing else is available); it is a separate session.");
    }
  }
  return { ok: true, builder, reviewer, notes };
}

/** "Builder: Codex (why). Reviewer: Opus (why)." for the spoken summary; only choices that weren't named. */
export function choiceSentence(choices: readonly RoleChoice[] | undefined): string {
  const auto = (choices ?? []).filter((c) => c.basis !== "named");
  if (!auto.length) return "";
  return auto.map((c) => `${c.role === "builder" ? "Builder" : c.role === "reviewer" ? "Reviewer" : "Tester"}: ${modelLabel(c.model)}, ${c.why}.`).join(" ");
}

// ─────────────────────────── the prefs file ───────────────────────────

export type PrefsLoad = { prefs: CodingModelPrefs; problem: string | null };

/** `.operator-data/coding-prefs.json`. Missing = the safe default. Unreadable/invalid = the safe default, with the reason. */
export function loadCodingPrefs(file: string): PrefsLoad {
  if (!existsSync(file)) return { prefs: DEFAULT_CODING_PREFS, problem: null };
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024) return { prefs: DEFAULT_CODING_PREFS, problem: "coding-prefs.json can't be opened safely; using the defaults" };
    return { prefs: validatePrefs(JSON.parse(readFileSync(file, "utf8"))), problem: null };
  } catch (e) {
    return { prefs: DEFAULT_CODING_PREFS, problem: `coding-prefs.json ignored (${(e as Error).message.slice(0, 120)}); using the defaults` };
  }
}

export function validatePrefs(v: unknown): CodingModelPrefs {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("needs an object");
  if (o.freeOnly !== undefined && typeof o.freeOnly !== "boolean") throw new Error("freeOnly must be true or false");
  if (o.allowPaidFallback !== undefined && typeof o.allowPaidFallback !== "boolean") throw new Error("allowPaidFallback must be true or false");
  if (o.preferred !== undefined && (!Array.isArray(o.preferred) || o.preferred.some((m) => typeof m !== "string" || m.length > 80))) throw new Error("preferred must be a list of model ids");
  return { freeOnly: o.freeOnly === true, allowPaidFallback: o.allowPaidFallback !== false, ...(Array.isArray(o.preferred) && o.preferred.length ? { preferred: (o.preferred as string[]).slice(0, 8) } : {}) };
}

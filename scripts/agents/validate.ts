import { PERSON_IDS } from "../devices/types";
import { BOT_ID, type Bot } from "./types";

/**
 * What PATCH /__agents/bots/:id may change, checked against the services the bot points at. Pure: the services come in as functions, so the
 * same rules run in the route, in tests with fakes, and nowhere else.
 *
 *   name, purpose, instructions   text with limits (purpose is required, 300 characters; instructions 8,000)
 *   computer      must exist in the computers store (or null)
 *   coding        a WHOLE object { enabled, accountSlot, model } that replaces the old one. `enabled` is not editable here (authority to run
 *                 coding jobs is fixed when the bot is seeded); accountSlot must be a configured coding account (claude:max, claude:max-2,
 *                 codex:openai-2 ... from the accounts service) or null = automatic; model must belong to that slot's provider, or null
 *   modelPreference  a WHOLE object { route }: "auto", "free-only", or a model id from the model-router catalogue
 *   memory        a WHOLE object { recall, saveResults }
 *   skills        NOT editable: a bot's abilities come from its computer and coding set-up (read-only, derived); a PATCH naming them is a 400
 *   routines      each must be an existing routine (a routine trigger id)
 */
export type ValidationDeps = {
  computerExists(name: string): boolean;
  /** Every coding account slot the accounts service lists. */
  accountSlots(): string[];
  /** Models a slot can run (CLAUDE_MODELS for a Claude slot, CODEX_MODELS for a Codex slot). Unknown slot: empty. */
  modelsFor(slot: string): string[];
  /** Every model the coding harness offers, for a model chosen with no slot. */
  allModels(): string[];
  /** Every model id in the model-router catalogue (what `modelPreference.route` may name). */
  routerModels(): string[];
  routineIds(): string[];
  /** The id of ANOTHER bot (not `exceptBot`) that already lists this routine, or null. A routine runs as exactly one bot. */
  routineBotElsewhere?(routineId: string, exceptBot: string): string | null;
  /** Every bot's id and name (archived included), for the uniqueness of names and ids. Absent: no clash is checked. */
  bots?(): Array<{ id: string; name: string }>;
};

export type FieldError = { field: string; message: string; /** A stable word for a refusal the caller treats specially (`id-taken` is a 409 on create). */ code?: string };

const PATCH_KEYS = ["rev", "name", "purpose", "instructions", "computer", "coding", "modelPreference", "skills", "routines", "memory"] as const;
const CODING_KEYS = ["enabled", "accountSlot", "model"];
const MEMORY_KEYS = ["recall", "saveResults"];
const COMPUTER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_LIST = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
export const LIMITS = { name: 40, purpose: 300, instructions: 8000 } as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const words = (list: readonly string[], max = 8) => (list.length > max ? `${list.slice(0, max).join(", ")} ...` : list.join(", ") || "none");

export function parsePatch(body: unknown, deps: ValidationDeps, current: Bot): { ok: true; rev: number; apply: (bot: Bot) => Bot } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const bad = (field: string, message: string) => void errors.push({ field, message });
  if (!isObj(body)) return { ok: false, errors: [{ field: "body", message: "Send a JSON object with the rev you edited and the fields to change." }] };
  for (const key of Object.keys(body)) if (!(PATCH_KEYS as readonly string[]).includes(key)) bad(key, `"${key}" can't be changed here. Editable: ${PATCH_KEYS.filter((k) => k !== "rev").join(", ")}.`);
  if (!Number.isInteger(body.rev) || (body.rev as number) < 1) bad("rev", "Send the rev of the bot you edited (from GET /__agents/bots/:id), so a change made meanwhile is never overwritten.");
  const edits: Array<(b: Bot) => void> = [];

  const text = (key: "name" | "purpose" | "instructions", min: number) => {
    if (!(key in body)) return;
    const v = body[key];
    const max = LIMITS[key];
    if (typeof v !== "string") return bad(key, `${key} must be text.`);
    // A name is normalised exactly as it is on create (one function), so a rename can't smuggle in what a new bot's name couldn't.
    const t = key === "name" ? normaliseName(v) : v.trim();
    if (t.length < min) return bad(key, `${key} can't be empty.`);
    if (t.length > max) return bad(key, `${key} is ${t.length} characters; the limit is ${max.toLocaleString("en-AU")}.`);
    if (key === "name") {
      const refusal = nameRefusal(t, deps.bots?.() ?? [], current.id);
      if (refusal) return bad("name", refusal.message);
    }
    edits.push((b) => void (b[key] = t));
  };
  text("name", 1);
  text("purpose", 1);
  text("instructions", 0);

  if ("computer" in body) {
    const v = body.computer;
    if (v === null) edits.push((b) => void (b.computer = null));
    else if (typeof v !== "string" || !COMPUTER_NAME.test(v)) bad("computer", "computer must be a shared computer's name (lowercase letters, digits, hyphens) or null.");
    else if (!deps.computerExists(v)) bad("computer", `There is no shared computer called "${v}". Create it on the Computers page first, or pick one that exists.`);
    else edits.push((b) => void (b.computer = v));
  }

  if ("coding" in body) {
    const c = body.coding;
    if (!isObj(c)) bad("coding", "coding must be a whole object: { enabled, accountSlot, model }.");
    else {
      for (const k of Object.keys(c)) if (!CODING_KEYS.includes(k)) bad(`coding.${k}`, `coding.${k} isn't a setting.`);
      for (const k of CODING_KEYS) if (!(k in c)) bad(`coding.${k}`, `coding replaces the whole setting, so it must include ${CODING_KEYS.join(", ")} (missing: ${k}).`);
      if (!errors.some((e) => e.field.startsWith("coding"))) {
        if (c.enabled !== current.coding.enabled) bad("coding.enabled", `coding.enabled can't be changed here: ${current.name} ${current.coding.enabled ? "runs" : "doesn't run"} coding jobs, and that is set when the bot is created, not from Setup. Send enabled: ${current.coding.enabled}.`);
        let slot: string | null = null;
        if (c.accountSlot === null) slot = null;
        else if (typeof c.accountSlot !== "string") bad("coding.accountSlot", "coding.accountSlot must be an account slot such as claude:max-2, or null for the automatic pick.");
        else if (!deps.accountSlots().includes(c.accountSlot)) bad("coding.accountSlot", `"${c.accountSlot}" isn't a configured coding account. Configured: ${words(deps.accountSlots())}.`);
        else slot = c.accountSlot;
        if (c.model === null) {
          /* automatic */
        } else if (typeof c.model !== "string") bad("coding.model", "coding.model must be a model name, or null.");
        else if (!errors.some((e) => e.field === "coding.accountSlot")) {
          const allowed = slot ? deps.modelsFor(slot) : deps.allModels();
          if (!allowed.includes(c.model)) bad("coding.model", slot ? `${c.model} isn't a model ${slot} runs. It runs: ${words(allowed)}.` : `${c.model} isn't a model the coding harness offers. Offered: ${words(allowed)}.`);
        }
        if (!errors.some((e) => e.field.startsWith("coding"))) {
          const next = { enabled: c.enabled as boolean, accountSlot: slot, model: c.model as string | null };
          edits.push((b) => void (b.coding = next));
        }
      }
    }
  }

  if ("modelPreference" in body) {
    const m = body.modelPreference;
    if (!isObj(m) || typeof m.route !== "string" || Object.keys(m).some((k) => k !== "route")) bad("modelPreference", "modelPreference must be the whole object { route }, where route is auto, free-only or a model from the router catalogue.");
    else if (m.route !== "auto" && m.route !== "free-only" && !deps.routerModels().includes(m.route)) bad("modelPreference.route", `"${m.route}" isn't auto, free-only or a model in the router catalogue (for example ${words(deps.routerModels(), 4)}).`);
    else edits.push((b) => void (b.modelPreference = { route: (m as { route: string }).route }));
  }

  const idList = (key: "routines", known: () => string[], what: "routine") => {
    if (!(key in body)) return;
    const v = body[key];
    if (!Array.isArray(v) || v.length > 40 || v.some((x) => typeof x !== "string" || !ID_LIST.test(x))) return bad(key, `${key} must be a list of at most 40 ${what} names.`);
    const list = [...new Set(v as string[])];
    const have = known();
    const unknown = list.filter((x) => !have.includes(x));
    if (unknown.length) return bad(key, `${unknown.join(", ")} ${unknown.length === 1 ? "isn't" : "aren't"} an existing routine.`);
    for (const x of list) {
      const other = deps.routineBotElsewhere?.(x, current.id);
      if (other) return bad(key, `${x} is already linked to ${other}. A routine runs as one bot, so unlink it there first, then link it here.`);
    }
    edits.push((b) => void (b[key] = list));
  };
  if ("skills" in body) bad("skills", "skills are not configurable yet: a bot's abilities are what its computer and coding set-up can do (shown read-only).");
  idList("routines", deps.routineIds, "routine");

  if ("memory" in body) {
    const m = body.memory;
    if (!isObj(m)) bad("memory", "memory must be the whole object { recall, saveResults }.");
    else {
      for (const k of Object.keys(m)) if (!MEMORY_KEYS.includes(k)) bad(`memory.${k}`, `memory.${k} isn't a setting.`);
      for (const k of MEMORY_KEYS) if (typeof m[k] !== "boolean") bad(`memory.${k}`, `memory replaces the whole setting, so memory.${k} must be true or false.`);
      if (!errors.some((e) => e.field.startsWith("memory"))) {
        const next = { recall: m.recall as boolean, saveResults: m.saveResults as boolean };
        edits.push((b) => void (b.memory = next));
      }
    }
  }

  if (!edits.length && !errors.length) bad("body", "Nothing to change: send at least one field besides rev.");
  if (errors.length) return { ok: false, errors };
  return { ok: true, rev: body.rev as number, apply: (bot) => (edits.forEach((e) => e(bot)), bot) };
}

// ── creating, copying and archiving ───────────────────────────────────────────────────────────────────────────────────────────

/** One whole `coding` setting for a NEW bot, checked against the accounts service (an edit keeps `enabled` fixed; a create may choose it). */
function checkCoding(c: unknown, deps: ValidationDeps, bad: (field: string, message: string) => void, enabledProblem: (enabled: unknown) => string | null): Bot["coding"] | null {
  let failed = false;
  const err = (field: string, message: string) => {
    failed = true;
    bad(field, message);
  };
  if (!isObj(c)) return err("coding", "coding must be a whole object: { enabled, accountSlot, model }."), null;
  for (const k of Object.keys(c)) if (!CODING_KEYS.includes(k)) err(`coding.${k}`, `coding.${k} isn't a setting.`);
  for (const k of CODING_KEYS) if (!(k in c)) err(`coding.${k}`, `coding replaces the whole setting, so it must include ${CODING_KEYS.join(", ")} (missing: ${k}).`);
  if (failed) return null;
  const problem = enabledProblem(c.enabled);
  if (problem) err("coding.enabled", problem);
  let slot: string | null = null;
  let slotBad = false;
  if (c.accountSlot === null) slot = null;
  else if (typeof c.accountSlot !== "string") (slotBad = true), err("coding.accountSlot", "coding.accountSlot must be an account slot such as claude:max-2, or null for the automatic pick.");
  else if (!deps.accountSlots().includes(c.accountSlot)) (slotBad = true), err("coding.accountSlot", `"${c.accountSlot}" isn't a configured coding account. Configured: ${words(deps.accountSlots())}.`);
  else slot = c.accountSlot;
  if (c.model === null) {
    /* automatic */
  } else if (typeof c.model !== "string") err("coding.model", "coding.model must be a model name, or null.");
  else if (!slotBad) {
    const allowed = slot ? deps.modelsFor(slot) : deps.allModels();
    if (!allowed.includes(c.model)) err("coding.model", slot ? `${c.model} isn't a model ${slot} runs. It runs: ${words(allowed)}.` : `${c.model} isn't a model the coding harness offers. Offered: ${words(allowed)}.`);
  }
  return failed ? null : { enabled: c.enabled as boolean, accountSlot: slot, model: c.model as string | null };
}

/** The lowercase slug a name makes (accents dropped, at most 32 characters), or "bot" when nothing usable is left. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || "bot";
}

/**
 * THE one name normaliser (create, rename and copy all use it): Unicode-compatible form, every whitespace run (new lines and tabs too) becomes one space, then
 * control, zero-width and other invisible characters go, then the ends are trimmed. "Re\nsearch\u0007" is "Re search" everywhere.
 */
export function normaliseName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/gu, " ").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
}

/**
 * Words Jarvis's routing would capture if a bot answered to them (scripts/agents/jarvis.ts `named`, `scope`, `run`): the lead-ins and verbs ("ask", "stop"),
 * the pointing words ("it", "that", "this", "its"), the nouns it skips ("bot", "task", "computer"), the words of an own-device request ("my pc"), the bare
 * answers and small talk it recognises ("yes", "thanks", "start"), and the page names of the workspace. A name made only of these is refused, and so is a person.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(
  `jarvis hey hi hello please thanks thank cheers yes yeah yep no nope ok okay sure cool great nice good right perfect brilliant go do start run confirm confirmed
   ask tell have get let show open bring pull up check on continue resume carry pick stop cancel abort what whats how is doing going status
   the a an and or to of for in at it its that this those these them they he she his her you your us we i me my mine
   task tasks job jobs work bot bots agent agents computer computers desktop machine cloud pc laptop mac phone windows screen
   workspace new files thread duplicate archive setup chat`.split(/\s+/).filter(Boolean),
);
/** The people Jarvis addresses by name (ids and the names they go by). */
const PEOPLE: ReadonlySet<string> = new Set([...PERSON_IDS, "mohammad", "nahda"]);
const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** True for a name or id that is nothing but reserved words or a person. */
export function isReservedName(name: string): boolean {
  const w = wordsOf(name);
  return w.length === 0 || w.every((x) => RESERVED_WORDS.has(x) || PEOPLE.has(x));
}
const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
type Named = ReadonlyArray<{ id: string; name: string }>;
/** An id is taken by any bot's id, and also by any bot's NAME: Jarvis matches "ask <word> to ..." on either, so the two must never overlap. A reserved word is never free. */
export const idTaken = (id: string, bots: Named) => isReservedName(id) || bots.some((b) => b.id === id || same(b.name, id));
/** Why this name can't be used, or null. `exceptId` is the bot being renamed. `name-reserved` is a plain refusal; `name-taken` is a clash with a bot. */
export function nameRefusal(name: string, bots: Named, exceptId?: string): { code: "name-taken" | "name-reserved"; message: string } | null {
  if (letters(name) < 2) return { code: "name-reserved", message: "A name needs at least two letters, so that \"ask <name> to ...\" can be told apart from other words." };
  if (isReservedName(name)) return { code: "name-reserved", message: `"${name}" is a word Jarvis already uses (or a person's name), so "ask ${name} to ..." would be taken for something else. Pick another name.` };
  const other = bots.find((b) => b.id !== exceptId && (same(b.name, name) || b.id === name.trim().toLowerCase()));
  if (!other) {
    // "Builder Task", "The Builder", "Research Computer": once Jarvis's own words and a leading article are taken off, the rest is another bot's name or id,
    // and Jarvis drops those words when it listens, so saying the one would reach the other.
    const rest = wordsOf(name).filter((x) => !RESERVED_WORDS.has(x)).join(" ");
    const confused = rest && rest !== wordsOf(name).join(" ") ? bots.find((b) => b.id !== exceptId && (wordsOf(b.name).join(" ") === rest || b.id === rest)) : undefined;
    if (confused) return { code: "name-taken", message: `"${name}" would be confused with ${confused.name} when spoken ("ask ${confused.name} to ..."). Pick a name that isn't ${confused.name} plus a filler word.` };
  }
  return other ? { code: "name-taken", message: `Another bot already answers to "${name}" (${other.name}). Pick a different name, so "ask ${name} to ..." is never ambiguous.` } : null;
}
export const nameProblem = (name: string, bots: Named, exceptId?: string): string | null => nameRefusal(name, bots, exceptId)?.message ?? null;
/** A free id for a name: the slug, then slug-2, slug-3 ... (within 32 characters). Never an id any bot has had, archived ones included. */
export function freeId(base: string, bots: Named): string {
  if (!idTaken(base, bots)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!idTaken(id, bots)) return id;
  }
  return `${base.slice(0, 22).replace(/-+$/, "")}-${Date.now().toString(36)}`.slice(0, 32);
}

const CREATE_KEYS = ["id", "name", "purpose", "instructions", "computer", "coding", "modelPreference", "memory"] as const;
export type BotDraft = Pick<Bot, "id" | "name" | "purpose" | "instructions" | "computer" | "coding" | "modelPreference" | "memory">;

/**
 * POST /__agents/bots. Everything is checked against the services the bot will point at, exactly as an edit is, so a bot can't be created pointing at
 * something that doesn't exist or can't run.
 *
 *   name          required, 1-40 characters; no other bot (archived too) already answers to it
 *   id            optional lowercase slug (letters, digits, hyphens); derived from the name when absent; never an id a bot has had
 *   purpose       required, 300 characters; instructions optional, 8,000
 *   computer      an EXISTING shared computer or null. Creating a bot never creates a computer, and several bots may use one
 *   coding        a whole { enabled, accountSlot, model }; enabled only when a coding account is configured (the coding executor can honour it)
 *   modelPreference / memory   as in an edit; memory defaults to recall on, save-results off
 *   skills, routines   NOT accepted: abilities are derived, and a routine is linked from the new bot's Setup
 */
export function parseCreate(body: unknown, deps: ValidationDeps): { ok: true; draft: BotDraft } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const bad = (field: string, message: string, code?: string) => void errors.push({ field, message, ...(code ? { code } : {}) });
  if (!isObj(body)) return { ok: false, errors: [{ field: "body", message: "Send a JSON object: at least a name and a purpose." }] };
  const all = deps.bots?.() ?? [];
  for (const key of Object.keys(body)) {
    if (key === "skills") bad(key, "skills are not configurable: a bot's abilities are what its computer and coding set-up can do (shown read-only).");
    else if (key === "routines") bad(key, "A routine is linked to a bot from its Setup, once the bot exists (a routine runs as one bot).");
    else if (key === "rev") bad(key, "rev isn't sent when creating a bot.");
    else if (!(CREATE_KEYS as readonly string[]).includes(key)) bad(key, `"${key}" isn't a setting of a bot. Accepted: ${CREATE_KEYS.join(", ")}.`);
  }

  let name = "";
  if (typeof body.name !== "string") bad("name", "Give the bot a name.");
  else {
    name = normaliseName(body.name);
    if (!name) bad("name", "Give the bot a name.");
    else if (name.length > LIMITS.name) bad("name", `name is ${name.length} characters; the limit is ${LIMITS.name}.`);
    else {
      const refusal = nameRefusal(name, all);
      if (refusal) bad("name", refusal.message, refusal.code);
    }
  }

  let id = "";
  if (body.id === undefined || body.id === null || body.id === "") id = name && !errors.some((e) => e.field === "name") ? freeId(slugOf(name), all) : "";
  else if (typeof body.id !== "string" || !BOT_ID.test(body.id)) bad("id", "id must be lowercase letters, digits and hyphens, starting with a letter or digit, up to 32 characters.");
  else if (isReservedName(body.id)) bad("id", `"${body.id}" is a word Jarvis already uses (or a person's name). Pick another id.`);
  else if (idTaken(body.id, all)) bad("id", `"${body.id}" is already used by a bot (archived bots keep their id, so an id is never reused). Pick another id.`, "id-taken");
  else id = body.id;

  let purpose = "";
  if (typeof body.purpose !== "string" || !body.purpose.trim()) bad("purpose", "Say what this bot is for, in a sentence.");
  else if (body.purpose.trim().length > LIMITS.purpose) bad("purpose", `purpose is ${body.purpose.trim().length} characters; the limit is ${LIMITS.purpose}.`);
  else purpose = body.purpose.trim();

  let instructions = "";
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") bad("instructions", "instructions must be text.");
    else if (body.instructions.trim().length > LIMITS.instructions) bad("instructions", `instructions is ${body.instructions.trim().length} characters; the limit is ${LIMITS.instructions.toLocaleString("en-AU")}.`);
    else instructions = body.instructions.trim();
  }

  let computer: string | null = null;
  if (body.computer !== undefined && body.computer !== null) {
    if (typeof body.computer !== "string" || !COMPUTER_NAME.test(body.computer)) bad("computer", "computer must be a shared computer's name (lowercase letters, digits, hyphens) or null.");
    else if (!deps.computerExists(body.computer)) bad("computer", `There is no shared computer called "${body.computer}". Creating a bot never creates a computer: make it on the Computers page first, or pick one that exists.`);
    else computer = body.computer;
  }

  let coding: Bot["coding"] = { enabled: false, accountSlot: null, model: null };
  if (body.coding !== undefined) {
    const c = checkCoding(body.coding, deps, bad, (enabled) => (typeof enabled !== "boolean" ? "coding.enabled must be true or false." : enabled && deps.accountSlots().length === 0 ? "Coding can't be turned on: no coding account is configured on this hub, so coding jobs couldn't run." : null));
    if (c && !c.enabled && (c.accountSlot || c.model)) bad("coding", "An account or model is only used when coding is on. Turn coding on, or leave them empty.");
    else if (c) coding = c;
  }

  let modelPreference: Bot["modelPreference"] = { route: "auto" };
  if (body.modelPreference !== undefined) {
    const m = body.modelPreference;
    if (!isObj(m) || typeof m.route !== "string" || Object.keys(m).some((k) => k !== "route")) bad("modelPreference", "modelPreference must be the whole object { route }, where route is auto, free-only or a model from the router catalogue.");
    else if (m.route !== "auto" && m.route !== "free-only" && !deps.routerModels().includes(m.route)) bad("modelPreference.route", `"${m.route}" isn't auto, free-only or a model in the router catalogue (for example ${words(deps.routerModels(), 4)}).`);
    else modelPreference = { route: m.route };
  }

  let memory: Bot["memory"] = { recall: true, saveResults: false };
  if (body.memory !== undefined) {
    const m = body.memory;
    if (!isObj(m)) bad("memory", "memory must be the whole object { recall, saveResults }.");
    else {
      for (const k of Object.keys(m)) if (!MEMORY_KEYS.includes(k)) bad(`memory.${k}`, `memory.${k} isn't a setting.`);
      for (const k of MEMORY_KEYS) if (typeof m[k] !== "boolean") bad(`memory.${k}`, `memory replaces the whole setting, so memory.${k} must be true or false.`);
      if (!errors.some((e) => e.field.startsWith("memory"))) memory = { recall: m.recall as boolean, saveResults: m.saveResults as boolean };
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, draft: { id, name, purpose, instructions, computer, coding, modelPreference, memory } };
}

/**
 * What a copy of a bot is: its CONFIGURATION only (purpose, instructions, computer, coding, model route, memory switches). It is called "<name> copy"
 * (then "copy 2" ...) with a fresh id. It never carries credentials or browser sessions (a bot has none: they belong to its computer, which the copy
 * only SHARES, queue and control lease included), approvals, routine links (a routine runs as one bot), conversations, tasks or results.
 */
export function copyOf(source: Bot, deps: ValidationDeps): BotDraft {
  const all = deps.bots?.() ?? [];
  let name = "";
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    name = normaliseName(`${source.name.slice(0, LIMITS.name - suffix.length).trimEnd()}${suffix}`);
    if (!nameProblem(name, all)) break;
  }
  // A computer or account that is gone isn't carried over: the copy starts without it rather than pointing at nothing.
  const slot = source.coding.accountSlot && deps.accountSlots().includes(source.coding.accountSlot) ? source.coding.accountSlot : null;
  const model = source.coding.model && (slot ? deps.modelsFor(slot) : deps.allModels()).includes(source.coding.model) && (slot || !source.coding.accountSlot) ? source.coding.model : null;
  return {
    id: freeId(slugOf(name), all),
    name,
    purpose: source.purpose,
    instructions: source.instructions,
    computer: source.computer && deps.computerExists(source.computer) ? source.computer : null,
    // Coding stays on only where the coding executor could run it (the same rule as creating a bot): with no account configured, the copy has it off.
    coding: { enabled: source.coding.enabled && deps.accountSlots().length > 0, accountSlot: slot, model },
    modelPreference: { route: source.modelPreference.route },
    memory: { recall: source.memory.recall, saveResults: source.memory.saveResults },
  };
}

/** POST /__agents/bots/:id/archive body: { rev, archived: boolean, afterCurrentWork?: boolean }. */
export function parseArchive(body: unknown): { ok: true; rev: number; archived: boolean; afterCurrentWork: boolean } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const bad = (field: string, message: string) => void errors.push({ field, message });
  if (!isObj(body)) return { ok: false, errors: [{ field: "body", message: "Send { rev, archived: true or false }." }] };
  for (const key of Object.keys(body)) if (!["rev", "archived", "afterCurrentWork"].includes(key)) bad(key, `"${key}" isn't accepted here. Send rev, archived and (optionally) afterCurrentWork.`);
  if (!Number.isInteger(body.rev) || (body.rev as number) < 1) bad("rev", "Send the rev of the bot you were looking at, so a change made meanwhile is never overwritten.");
  if (typeof body.archived !== "boolean") bad("archived", "archived must be true (archive) or false (unarchive).");
  if (body.afterCurrentWork !== undefined && typeof body.afterCurrentWork !== "boolean") bad("afterCurrentWork", "afterCurrentWork must be true or false.");
  if (body.afterCurrentWork === true && body.archived === false) bad("afterCurrentWork", "afterCurrentWork only applies when archiving.");
  if (errors.length) return { ok: false, errors };
  return { ok: true, rev: body.rev as number, archived: body.archived as boolean, afterCurrentWork: body.afterCurrentWork === true };
}

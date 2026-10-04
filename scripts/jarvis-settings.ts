import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { peopleFile, readPeople, type Person } from "./remote-access";
import { DEFAULT_SHORTHAND } from "./shorthand";
import { dataDirFor } from "./cloud/data-dir";

/**
 * What the owner can customise about Jarvis from Settings → Jarvis: his shorthand, who can
 * reach Jarvis (people.json), and the spoken greeting. Voice, engine and wake word stay in the
 * voice panel. Every write is validated here, written atomically, and people.json keeps a
 * .bak of the previous version so a bad edit can't lock him out silently.
 */

export const DEFAULT_GREETING = "At your service, sir.";
const TERM = /^[a-z0-9&+.\-]{1,20}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const TELEGRAM_ID = /^\d{5,15}$/;

function dataDir(root: string) {
  const dir = join(dataDirFor(root));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function readJarvisSettings(root: string) {
  const own = readJson(join(dataDir(root), "jarvis-settings.json"));
  const shorthand = readJson(join(dataDir(root), "shorthand.json"));
  return {
    greeting: typeof own.greeting === "string" && own.greeting.trim() ? own.greeting : DEFAULT_GREETING,
    shorthand: { defaults: DEFAULT_SHORTHAND, own: (shorthand && typeof shorthand.terms === "object" ? shorthand.terms : {}) as Record<string, string> },
    people: readPeople(root),
  };
}

export function validateGreeting(value: unknown) {
  // Text only: an object used to be saved as the greeting "[object Object]" (Audit F5 P2-3).
  if (typeof value !== "string") throw new Error("The greeting must be text.");
  const text = value.trim();
  if (!text || text.length > 120) throw new Error("The greeting must be 1–120 characters.");
  return text;
}

export function validateShorthand(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Shorthand must be a list of terms.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 200) throw new Error("Keep shorthand to 200 terms.");
  const clean: Record<string, string> = {};
  for (const [rawTerm, rawMeaning] of entries) {
    const term = rawTerm.trim().toLowerCase();
    if (typeof rawMeaning !== "string") throw new Error(`"${term}" needs a meaning in words.`);
    const meaning = rawMeaning.trim();
    if (!TERM.test(term)) throw new Error(`"${rawTerm}" isn't a usable shorthand (letters, digits, & + . - up to 20).`);
    if (!meaning || meaning.length > 80) throw new Error(`"${term}" needs a meaning up to 80 characters.`);
    clean[term] = meaning;
  }
  return clean;
}

export function validatePeople(value: unknown): Person[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error(!Array.isArray(value) || !value.length ? "Add at least one person, with the role owner." : "Keep it to 20 people.");
  const people = value.map((raw, index): Person => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = String(p.name ?? "").trim();
    if (!name || name.length > 60) throw new Error(`Person ${index + 1} needs a name (up to 60 characters).`);
    const role = String(p.role ?? "").trim().slice(0, 60) || undefined;
    const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    const tailscale = list(p.tailscale);
    const telegram = list(p.telegram);
    for (const login of tailscale) if (!EMAIL.test(login)) throw new Error(`${name}: "${login}" isn't a Tailscale login (an email address).`);
    for (const id of telegram) if (!TELEGRAM_ID.test(id)) throw new Error(`${name}: "${id}" isn't a Telegram user ID (digits only).`);
    const notes = String(p.notes ?? "").trim().slice(0, 300) || undefined;
    return { name, ...(role ? { role } : {}), ...(tailscale.length ? { tailscale } : {}), ...(telegram.length ? { telegram } : {}), ...(notes ? { notes } : {}) };
  });
  if (!people.some((p) => /owner/i.test(p.role ?? ""))) throw new Error("Keep one person with the role 'owner' so nobody is locked out.");
  const names = new Set(people.map((p) => p.name.toLowerCase()));
  if (names.size !== people.length) throw new Error("Two people have the same name.");
  return people;
}

/** Apply a validated patch. Returns the new settings. */
export function writeJarvisSettings(root: string, patch: { greeting?: unknown; shorthand?: unknown; people?: unknown }) {
  const dir = dataDir(root);
  const greeting = patch.greeting === undefined ? undefined : validateGreeting(patch.greeting);
  const shorthand = patch.shorthand === undefined ? undefined : validateShorthand(patch.shorthand);
  const people = patch.people === undefined ? undefined : validatePeople(patch.people);
  // Validate everything before writing anything.
  if (greeting !== undefined) atomicJson(join(dir, "jarvis-settings.json"), { ...readJson(join(dir, "jarvis-settings.json")), greeting });
  if (shorthand !== undefined) {
    const file = join(dir, "shorthand.json");
    const existing = readJson(file);
    atomicJson(file, { ...(existing._about ? { _about: existing._about } : {}), terms: shorthand });
  }
  if (people !== undefined) {
    const file = peopleFile(root);
    const existing = readJson(file);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    atomicJson(file, { ...(existing._about ? { _about: existing._about } : {}), people });
  }
  return readJarvisSettings(root);
}

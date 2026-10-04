import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Input checks for the dev server's inline /__* handlers in vite.config.ts (Audit F5). They live
 * here so they can be tested without booting the server, and so the handlers change by a line.
 */

/** A path separator (either kind), a drive colon, or NUL and the other control characters. */
const HAS_BAD_CHAR = /[\\/:\u0000-\u001f]/;

/** One path segment that could name a project folder (the syntax half of designProjectFolder). */
export function isDesignProjectIdShape(id: unknown): id is string {
  if (typeof id !== "string" || !id || id.length > 200) return false;
  return !(id === "." || id === ".." || HAS_BAD_CHAR.test(id) || /[. ]$/.test(id) || isAbsolute(id));
}

/**
 * The folder a project removal may touch (Audit F5 P1-1; widened after review S3). The id must be
 * EXACTLY the name of a folder that sits directly in the designs root, i.e. one the studio lists:
 * app-made ids (including a leading "-" from a non-Latin name) and hand-made folders ("Acme.Site",
 * "My Project", "Q3_Deck") alike. Refused (null): a separator, a drive colon, NUL or another control
 * character, ".", "..", a trailing dot or space (Windows drops them, so "x." would name "x"), an
 * absolute path, and anything that is not an exact directory entry (so "VICTIM" never removes
 * "victim" on a case-insensitive disk). The caller still checks the folder holds an index.html.
 */
export function designProjectFolder(root: string, id: unknown): string | null {
  if (!isDesignProjectIdShape(id)) return null;
  const base = resolve(root);
  const dir = resolve(base, id);
  if (dirname(dir) !== base || basename(dir) !== id || dir === base) return null;
  let listed = false;
  try {
    listed = readdirSync(base, { withFileTypes: true }).some((e) => e.name === id && (e.isDirectory() || e.isSymbolicLink()));
  } catch {
    listed = false;
  }
  return listed ? dir : null;
}

/** `real` is `home` or inside it; a sibling that merely shares the prefix (home-evil) is not (P2-7). */
export function isInside(home: string, real: string): boolean {
  return real === home || real.startsWith(home.endsWith(sep) ? home : home + sep);
}

/**
 * A folder name for an exported carousel (P2-10). A titled deck keeps the name it always had
 * (<title>-deck, so a re-export updates the same wall entry). An untitled one used to become
 * "undefined-deck", shared by every untitled export; now it is carousel-<its id>-deck.
 */
export function exportFolderName(title: unknown, carouselId: unknown, now = Date.now()): string {
  const slug = (value: unknown, max: number) =>
    (typeof value === "string" ? value : "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max);
  const name = slug(title, 46);
  if (name) return `${name}-deck`;
  const id = slug(carouselId, 40).replace(/-+$/g, "") || now.toString(36);
  return `carousel-${id}-deck`;
}

const PERSONA_STRING_FIELDS = new Set(["name", "job", "description", "avatar"]);
const PERSONA_LIST_FIELDS = new Set(["skills", "tools", "summon_phrases"]);
const PERSONA_FIELDS = new Set([...PERSONA_STRING_FIELDS, ...PERSONA_LIST_FIELDS, "model", "behavior", "default"]);

/**
 * A PUT /__hermes_pantheon/<id> patch (P2-3). The route shallow-merges it into the persona YAML,
 * so an unknown key (`{"persona": "x"}`) or a wrong type used to be written into the file with a
 * 200. Returns the error to answer with, or null when the patch is sound.
 */
export function personaPatchError(patch: unknown): string | null {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return "The patch must be a JSON object.";
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) return "The patch is empty.";
  const unknown = entries.map(([k]) => k).filter((k) => !PERSONA_FIELDS.has(k));
  if (unknown.length) return `Unknown persona field${unknown.length > 1 ? "s" : ""}: ${unknown.slice(0, 5).join(", ")}.`;
  for (const [key, value] of entries) {
    if (PERSONA_STRING_FIELDS.has(key) && typeof value !== "string") return `${key} must be text.`;
    if (PERSONA_LIST_FIELDS.has(key) && !(Array.isArray(value) && value.every((v) => typeof v === "string")))
      return `${key} must be a list of text.`;
    if (key === "default" && typeof value !== "boolean") return "default must be true or false.";
    if (key === "model" || key === "behavior") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${key} must be an object.`;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const ok = typeof v === "string" || (key === "model" && k === "effort" && v === null);
        if (!ok) return `${key}.${k} must be text.`;
      }
    }
  }
  return null;
}

/**
 * Every Dream prescription id the dashboard can show (P2-3): the aggregated live-data.json, the
 * dream-*.json files it is built from, and ids already in state.json. /__dream_action used to
 * record a verdict for any slug, so a typo became a permanent state entry.
 */
export function knownDreamIds(liveDataPath: string, dreamsDir: string): Set<string> {
  const ids = new Set<string>();
  const collect = (doc: any) => {
    for (const list of [doc?.prescriptions, doc?.dream?.prescriptions])
      if (Array.isArray(list)) for (const p of list) if (p && (typeof p.id === "string" || typeof p.id === "number")) ids.add(String(p.id));
  };
  const read = (file: string) => {
    try {
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  };
  collect(read(liveDataPath));
  try {
    const files = readdirSync(dreamsDir).filter((f) => /^dream-.*\.json$/.test(f)).sort().slice(-60);
    for (const f of files) collect(read(join(dreamsDir, f)));
  } catch {
    /* no dreams yet */
  }
  const state = read(join(dreamsDir, "state.json"));
  if (state?.actions && typeof state.actions === "object") for (const id of Object.keys(state.actions)) ids.add(id);
  return ids;
}

/**
 * Moves a file or folder into `trashDir` under a unique name and returns where it went (P1-1:
 * a project removal is recoverable, as /__design_trash already was for files). Across drives a
 * rename fails, so it copies, then removes the original only once the copy is complete.
 */
export function moveIntoTrash(source: string, trashDir: string, now = Date.now()): string {
  mkdirSync(trashDir, { recursive: true });
  const destination = join(trashDir, `${now}-${randomBytes(3).toString("hex")}-${basename(source)}`);
  try {
    renameSync(source, destination);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    cpSync(source, destination, { recursive: true, errorOnExist: true });
    rmSync(source, { recursive: true, force: true });
  }
  return destination;
}

/**
 * A shared (founder-readable) response as a remote caller sees it (Audit F5 P3): every string
 * that is a path under the hub's home folder becomes "~/…", so the hub's disk layout and account
 * name are not handed to another device. The owner at the PC gets the real paths ("Copy path").
 */
export function hideHomePaths<T>(value: T, home: string): T {
  const norm = (p: string) => p.split("\\").join("/").replace(/\/+$/, "");
  const base = norm(home);
  const win = /^[a-z]:\//i.test(base);
  const under = (s: string) => {
    const n = norm(s);
    const a = win ? n.toLowerCase() : n;
    const b = win ? base.toLowerCase() : base;
    return a === b ? "~" : a.startsWith(b + "/") ? `~${n.slice(base.length)}` : null;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return under(v) ?? v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function sharedView<T>(atHub: boolean, body: T, home: string): T {
  return atHub ? body : hideHomePaths(body, home);
}

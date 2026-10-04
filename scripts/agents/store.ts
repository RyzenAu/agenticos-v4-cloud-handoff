import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirFor } from "../cloud/data-dir";
import { HISTORY_MAX, seedBots, type Bot, type BotEvent } from "./types";

/**
 * `<MU_DATA_DIR>/agents/bots.json`: the bot records. One small file, written atomically (temp file, then rename) and never edited in place.
 *
 *  - Seeded ONCE: when the file does not exist, Research and Builder are written. After that the file is the truth: a bot that is not in it is
 *    not re-created, and an unreadable file is refused (503 upstream) and left exactly as it was, never replaced by the seed.
 *  - `rev` is the honest concurrent-edit guard. An edit names the rev it was made against; if the stored rev has moved on, nothing is written
 *    and the caller gets the stored bot back (409). Read, check and write happen with no await between them, so two edits in this process cannot
 *    interleave.
 */

export const botsFile = (root: string) => join(dataDirFor(root), "agents", "bots.json");

export class BotsFileUnreadable extends Error {
  constructor() {
    super("The saved bots could not be read. They were left untouched.");
  }
}

type FileShape = { version: 1; seededAt: number; bots: Bot[] };

export type PatchResult = { ok: true; bot: Bot } | { ok: false; status: 404 | 409; bot: Bot | null };
export type CreateResult = { ok: true; bot: Bot } | { ok: false; status: 409; reason: "id-taken" };
/** Archiving never deletes; it can be refused when it would leave no active bot, or when the bot is already archived. */
export type ArchiveResult = PatchResult | { ok: false; status: 422; reason: "last-active" | "already-archived" | "not-archived"; bot: Bot };

/** A bot is active until it is archived. A bots.json written before archiving existed has no `archived` field anywhere, so every bot is active. */
export const isActive = (b: Bot) => !b.archived;
/** The settings a person can change in Setup; what an edit's history entry names. */
const EDITABLE = ["name", "purpose", "instructions", "computer", "coding", "modelPreference", "skills", "routines", "memory"] as const satisfies readonly (keyof Bot)[];
const log = (bot: Bot, event: BotEvent): BotEvent[] => [...(bot.history ?? []), event].slice(-HISTORY_MAX);

export function createBotStore(options: { file: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const load = (): FileShape => {
    if (!existsSync(options.file)) {
      const t = now();
      const seeded: FileShape = { version: 1, seededAt: t, bots: seedBots(t) };
      write(seeded);
      return seeded;
    }
    try {
      const parsed = JSON.parse(readFileSync(options.file, "utf8")) as FileShape;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.bots)) throw new Error("shape");
      return parsed;
    } catch {
      throw new BotsFileUnreadable();
    }
  };
  const write = (data: FileShape) => {
    mkdirSync(dirname(options.file), { recursive: true });
    const tmp = `${options.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, options.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  };
  return {
    file: options.file,
    list: (): Bot[] => load().bots,
    get: (id: string): Bot | null => load().bots.find((b) => b.id === id) ?? null,
    /**
     * Apply `change` to the bot, but only if `expectedRev` is still its rev. `change` returns the edited copy (rev, id and createdAt are not
     * its to set). Returns the new bot, or why nothing was written.
     */
    /**
     * Add a new bot (rev 1). Ids and names are unique across EVERY bot, archived ones included: an id is never handed out twice, so a conversation
     * key `agent:<person>:<id>` can never reach a different bot than the one it was made for. Read, check and write have no await between them.
     */
    create(bot: Bot): CreateResult {
      const data = load();
      if (data.bots.some((b) => b.id === bot.id)) return { ok: false, status: 409, reason: "id-taken" };
      data.bots.push(bot);
      write(data);
      return { ok: true, bot };
    },
    /** Archive (or unarchive) with the same rev guard as an edit. Refuses to archive the last active bot, whatever else is true. */
    setArchived(id: string, expectedRev: number, change: { archive: { by: string; afterCurrentWork: boolean } | null; by: string }): ArchiveResult {
      const data = load();
      const at = data.bots.findIndex((b) => b.id === id);
      if (at < 0) return { ok: false, status: 404, bot: null };
      const current = data.bots[at];
      if (current.rev !== expectedRev) return { ok: false, status: 409, bot: current };
      const t = now();
      let next: Bot;
      if (change.archive) {
        if (current.archived) return { ok: false, status: 422, reason: "already-archived", bot: current };
        if (!data.bots.some((b) => b.id !== id && isActive(b))) return { ok: false, status: 422, reason: "last-active", bot: current };
        // Archiving releases the bot's routine links in this same write ("after current work" too: a routine is not work in flight).
        next = { ...current, routines: [], releasedRoutines: current.routines, archived: { at: t, by: change.archive.by, afterCurrentWork: change.archive.afterCurrentWork }, history: log(current, { at: t, by: change.by, action: "archived", ...(change.archive.afterCurrentWork ? { note: "after current work" } : {}) }) };
      } else {
        if (!current.archived) return { ok: false, status: 422, reason: "not-archived", bot: current };
        next = { ...current, archived: null, history: log(current, { at: t, by: change.by, action: "unarchived" }) };
      }
      next = { ...next, rev: current.rev + 1, updatedAt: t };
      data.bots[at] = next;
      write(data);
      return { ok: true, bot: next };
    },
    /** `by`: who made the edit; recorded in the bot's history with the NAMES of the fields that changed (never their values: instructions are not logged). */
    patch(id: string, expectedRev: number, change: (current: Bot) => Bot, by?: string): PatchResult {
      const data = load();
      const at = data.bots.findIndex((b) => b.id === id);
      if (at < 0) return { ok: false, status: 404, bot: null };
      const current = data.bots[at];
      if (current.rev !== expectedRev) return { ok: false, status: 409, bot: current };
      const edited = change(structuredClone(current));
      // Who made it, where it came from, whether it is archived and its history are not an edit's to set.
    const next: Bot = { ...edited, id: current.id, createdAt: current.createdAt, rev: current.rev + 1, updatedAt: now(), ...(current.createdBy ? { createdBy: current.createdBy } : {}), ...(current.duplicatedFrom !== undefined ? { duplicatedFrom: current.duplicatedFrom } : {}), ...(current.archived !== undefined ? { archived: current.archived } : {}), ...(current.releasedRoutines ? { releasedRoutines: current.releasedRoutines } : {}), ...(current.history ? { history: current.history } : {}) };
      const changed = EDITABLE.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
      if (changed.length) next.history = log(next, { at: next.updatedAt, by: by ?? "unknown", action: "edited", note: changed.join(", ") });
      data.bots[at] = next;
      write(data);
      return { ok: true, bot: next };
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirFor } from "../cloud/data-dir";
import type { ArtifactStore } from "../computers/artifacts";
import { botThreadId } from "../conversations";
import type { ThreadStore } from "../jarvis-command/threads";
import type { JobService } from "../jobs/service";
import type { MemoryPort } from "./brief";
import type { Bot } from "./types";

/**
 * Two things a bot's Setup drives after the job has been started:
 *
 *  1. `routines`: a routine (an existing trigger) linked to a bot runs AS that bot. Which founder's conversation its work lands in is the founder who
 *     linked it (kept in routine-links.json beside the bots); a routine linked before that was recorded lands in the default owner's, `usman`.
 *     Unlinking is just the bot no longer listing it: the very next run is nobody's bot.
 *  2. `memory.saveResults`: when a bot's job ends with a saved result and the bot's setting is on, ONE concise memory of the outcome goes to the shared
 *     pool through the existing remember path. The key is `<jobId>:result`: a marker file makes it once, however many times the job's end is seen.
 *     A refusal (writes off, screened out) is reported in the conversation and nothing else changes.
 */

export const DEFAULT_ROUTINE_OWNER = "usman";
const dir = (root: string) => join(dataDirFor(root), "agents");
export const routineLinksFile = (root: string) => join(dir(root), "routine-links.json");
export const memorySavesFile = (root: string) => join(dir(root), "memory-saves.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function createRoutineLinks(file: string) {
  const load = () => readJson<{ owners?: Record<string, string> }>(file, {}).owners ?? {};
  return {
    owner: (routineId: string): string => load()[routineId] ?? DEFAULT_ROUTINE_OWNER,
    /** The founder who linked these routines (kept until they are unlinked). */
    link(routineIds: readonly string[], personId: string) {
      if (!routineIds.length) return;
      const owners = load();
      for (const id of routineIds) owners[id] = personId;
      writeJson(file, { version: 1, owners });
    },
    unlink(routineIds: readonly string[]) {
      if (!routineIds.length) return;
      const owners = load();
      for (const id of routineIds) delete owners[id];
      writeJson(file, { version: 1, owners });
    },
  };
}
export type RoutineLinks = ReturnType<typeof createRoutineLinks>;

/** The bot a routine runs as right now (derived from the bots, so an unlink takes effect at once), and the founder whose conversation it lands in. */
export function routineBinding(bots: () => Bot[], links: RoutineLinks) {
  return (routineId: string): { bot: Bot; personId: string } | null => {
    // An archived bot has released its routines; one that somehow still lists a routine isn't running it.
    const bot = bots().find((b) => !b.archived && b.routines.includes(routineId));
    return bot ? { bot, personId: links.owner(routineId) } : null;
  };
}

/**
 * What the conversation says about saving a result to shared memory: short, plain, and never a config name, a switch, a memory id or the hub's own
 * refusal text. (The service's message is for logs; the person reads this.)
 */
export function memoryNote(r: { ok: boolean; message: string }): string {
  if (r.ok) return "Saved the outcome to shared memory.";
  if (/writing is off|writes?-disabled|not on|switched off|read-only|read only/i.test(r.message)) return "Not saved to shared memory: saving is switched off on this hub.";
  if (/screen|sensitive|private|secret|refus/i.test(r.message)) return "Not saved to shared memory: it looked like it held private details, so it was left out.";
  return "Not saved to shared memory: it could not be saved just now.";
}

const readMarks = (file: string) => readJson<{ keys?: Record<string, { at: number; ok: boolean }> }>(file, {}).keys ?? {};
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function startResultMemory(deps: {
  jobs: () => JobService | null;
  bots: () => Bot[];
  artifacts: ArtifactStore;
  memory: () => MemoryPort | null;
  conversations: ThreadStore;
  file: string;
}): () => void {
  const inflight = new Set<string>();
  async function onEnded(jobId: string) {
    const key = `${jobId}:result`;
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      const job = deps.jobs()?.get(jobId);
      if (!job || job.state !== "succeeded" || !job.bot) return;
      const bot = deps.bots().find((b) => b.id === job.bot);
      // The setting as it is NOW: switching it off stops saving at once.
      if (!bot?.memory.saveResults) return;
      const person = job.principal.personId;
      const meta = deps.artifacts.get(jobId, person);
      if (!meta) return; // no saved result: nothing to remember
      if (readMarks(deps.file)[key]) return;
      const memory = deps.memory();
      const say = (text: string) => {
        const thread = deps.conversations.get(botThreadId(person, bot.id));
        if (thread) deps.conversations.appendEntry(thread.id, { key: `${jobId}:memory`, jobId, state: "note", text: text.slice(0, 500), jobKind: "computer" });
      };
      if (!memory) return say("Not saved to shared memory: the shared memory isn't connected here.");
      const text = cut(`${bot.name} finished "${cut(flat(job.title), 80)}": ${flat(meta.summary)} The saved result is artifact:${jobId}.`, 780);
      const r = await memory.remember(person, { text, title: cut(`${bot.name} result: ${flat(job.title)}`, 80) });
      // Only a save (or an exact repeat the pool already holds) is marked done. A switched-off pool is tried again at the next result, not remembered as done.
      // Re-read just before writing (no await between the read and the write): another job's mark that landed during `remember` is kept.
      if (r.ok) writeJson(deps.file, { version: 1, keys: { ...readMarks(deps.file), [key]: { at: Date.now(), ok: true } } });
      say(memoryNote(r));
    } catch {
      /* a result that couldn't be remembered never breaks the job's end */
    } finally {
      inflight.delete(key);
    }
  }
  const jobs = deps.jobs();
  if (!jobs) return () => undefined;
  return jobs.subscribe((e) => {
    if (e.type === "job" && e.job.state === "succeeded" && e.job.bot) void onEnded(e.jobId);
  });
}

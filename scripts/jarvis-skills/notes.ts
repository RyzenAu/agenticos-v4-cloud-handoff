// Quick notes: "note: …", "take a note …", "add to my notes …" append one timestamped line to
// Inbox/Jarvis notes.md in his Obsidian vault; "read my notes" reads the last three back. The vault
// is OBSIDIAN_VAULT_PATH from Hermes' .env: only that one variable is read, and the path is never
// spoken, logged or returned. Anything that looks like a password or key is neither saved nor read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { screenFact } from "../memory/guard";
import { spokenNoteDay } from "../memory/note-day";
import { notesIntent, type NotesRequest } from "./notes-intent";
import { looksSecret, sydney } from "./text";

export const NOTE_FILE = ["Inbox", "Jarvis notes.md"] as const;
const HEADER = "# Jarvis notes\n\nVoice notes Jarvis took for you, newest at the bottom.\n\n";

export { notesIntent, type NotesRequest };

/** What Jarvis says once a note is saved: it says WHERE, not just that it did. */
export const NOTED = "Added to your Jarvis notes in the vault.";

/**
 * Why a note is refused, in the memory guard's own words ("remember that …" says exactly the same), or null. The
 * guard (scripts/memory/guard.ts) covers bank and BSB, TFN, one-time codes, login pairs, keys and card numbers;
 * the older `looksSecret` check stays on top of it, so this only ever refuses more, never less.
 */
export function noteRefusal(text: string): string | null {
  const screened = screenFact(text);
  if (!screened.ok) return screened.message;
  if (looksSecret(text)) return "That looks like a password or key, sir. I'd rather not put it in a plain note.";
  return null;
}
/** True when a saved note must not be read aloud or offered as a recall hit (a secret written before the guard was used). */
const hiddenNote = (text: string) => looksSecret(text) || !screenFact(text).ok;

/** Reads ONLY OBSIDIAN_VAULT_PATH from Hermes' .env (never any other key). Null if unset or missing. */
export function hermesVaultPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const homes = [join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes"), join(homedir(), ".hermes")];
  for (const home of homes) {
    try {
      const line = readFileSync(join(home, ".env"), "utf8").match(/^\s*OBSIDIAN_VAULT_PATH\s*=\s*(.+?)\s*$/m);
      const value = line?.[1]?.replace(/^(['"])(.*)\1$/, "$2").trim();
      if (value && existsSync(value) && statSync(value).isDirectory()) return value;
    } catch {
      /* no .env here */
    }
  }
  return null;
}

/** `- 2026-09-24 15:42 — text`, one line, Sydney time. */
export function noteLine(text: string, now: number) {
  const p = sydney(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `- ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} — ${text.replace(/[\r\n]+/g, " ").trim()}`;
}
const LINE = /^- (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) — (.+)$/;

export function lastNotes(content: string, count = 3) {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(LINE))
    .filter((m): m is RegExpMatchArray => !!m)
    .slice(-count)
    .reverse()
    .map((m) => ({ date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, text: m[6] }));
}

export function spokenNotes(notes: ReturnType<typeof lastNotes>, now: number) {
  if (!notes.length) return "You haven't any Jarvis notes yet, sir.";
  const p = sydney(now);
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const words = ["Latest", "Before that", "And before that"];
  let skipped = 0;
  const parts: string[] = [];
  notes.forEach((n) => {
    if (hiddenNote(n.text)) return void skipped++;
    const when = n.date === today ? "today" : n.date;
    parts.push(`${words[parts.length] ?? "Then"}, ${when === "today" ? "today" : `on ${when}`}: ${n.text.slice(0, 150)}`);
  });
  const skip = skipped ? ` I've skipped ${skipped === 1 ? "one that looks" : `${skipped} that look`} like a password or key.` : "";
  if (!parts.length) return `Your latest notes look like passwords or keys, sir, so I won't read them aloud.`;
  return `${parts.join(". ")}.${skip}`;
}

export function createNotes(options: { vault?: () => string | null; now?: () => number } = {}) {
  const vault = options.vault ?? (() => hermesVaultPath());
  const now = options.now ?? Date.now;
  function file() {
    const root = vault();
    if (!root) return null;
    const target = resolve(root, ...NOTE_FILE);
    // Belt and braces: the note must live inside the vault.
    if (!target.startsWith(resolve(root) + sep)) return null;
    return target;
  }
  return {
    handle(req: NotesRequest): string {
      const target = file();
      if (!target) return "I can't find your Obsidian vault, sir. Hermes' OBSIDIAN_VAULT_PATH isn't set or the folder's gone.";
      if (req.action === "add") {
        const refusal = noteRefusal(req.text);
        if (refusal) return refusal;
        mkdirSync(join(target, ".."), { recursive: true });
        if (!existsSync(target)) writeFileSync(target, HEADER, "utf8");
        const existing = readFileSync(target, "utf8");
        appendFileSync(target, `${existing.endsWith("\n") || !existing ? "" : "\n"}${noteLine(req.text, now())}\n`, "utf8");
        return NOTED;
      }
      if (!existsSync(target)) return "You haven't any Jarvis notes yet, sir.";
      if (statSync(target).size > 5 * 1024 * 1024) return "Your notes file has grown too large for me to read aloud, sir.";
      return spokenNotes(lastNotes(readFileSync(target, "utf8")), now());
    },
  };
}

// --- reading the notes file for recall (read-only) ---------------------------------------------------------------
export type NoteHit = { date: string; time: string; text: string };
export { spokenNoteDay };
const STOP = new Set(["the", "and", "that", "this", "what", "did", "you", "about", "tell", "told", "say", "said", "any", "anything", "have", "has", "for", "with", "our", "your", "my", "was", "were", "are", "not", "but", "from", "into", "when", "how", "who", "why", "know", "remember"]);
/** Words worth matching in a recall question ("what did I tell you about Bianca" → ["bianca"]). */
const queryWords = (query: string) => (query.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * The notes file, read-only, for "what did I tell you about X" and "read my notes": the memory turn searches this as
 * well as the screened memory and names where each result came from. A note that the memory guard (or the older
 * secret check) would refuse is never returned, whenever it was written.
 */
export function createNotesReader(options: { vault?: () => string | null } = {}) {
  const vault = options.vault ?? (() => hermesVaultPath());
  function all(): { notes: NoteHit[]; skipped: number } {
    const root = vault();
    if (!root) return { notes: [], skipped: 0 };
    try {
      const target = resolve(root, ...NOTE_FILE);
      if (!target.startsWith(resolve(root) + sep) || !existsSync(target) || statSync(target).size > 5 * 1024 * 1024) return { notes: [], skipped: 0 };
      const rows = lastNotes(readFileSync(target, "utf8"), Number.MAX_SAFE_INTEGER); // newest first
      const notes = rows.filter((n) => !hiddenNote(n.text));
      return { notes, skipped: rows.length - notes.length };
    } catch {
      return { notes: [], skipped: 0 };
    }
  }
  return {
    /** The newest notes, newest first. */
    latest: (count = 3) => {
      const { notes, skipped } = all();
      return { hits: notes.slice(0, count), skipped };
    },
    /** Notes that mention the question's words, best match first, then newest. */
    search: (query: string, max = 3) => {
      const words = queryWords(query);
      if (!words.length) return { hits: [] as NoteHit[], skipped: 0 };
      const need = words.length <= 2 ? 1 : Math.ceil(words.length / 2);
      const { notes, skipped } = all();
      const scored = notes
        .map((n, i) => ({ n, i, score: words.filter((w) => n.text.toLowerCase().includes(w)).length }))
        .filter((x) => x.score >= need)
        .sort((a, b) => b.score - a.score || a.i - b.i);
      return { hits: scored.slice(0, max).map((x) => x.n), skipped };
    },
  };
}
export type NotesReader = ReturnType<typeof createNotesReader>;

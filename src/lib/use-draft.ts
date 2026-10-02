// Unfinished text survives navigation, a reload and a failed submit (programme C, round 3).
// Stored only in this browser (localStorage), keyed per form AND per signed-in person, and never when it looks like a credential:
// a shared browser must not show one founder's unfinished note to the other, and a refused secret must not come back on reload.
// Clear it by setting "" after a real send.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSignedIn } from "@/components/shell/signed-in";
import { screenFact, screenNote, sensitiveCategory } from "../../scripts/memory/guard";

const PREFIX = "agentic-os.draft.v2.";
/** The first version stored drafts raw and unkeyed; they are removed, never read. */
const LEGACY_PREFIX = "agentic-os.draft.v1.";
const MAX = 20000;
/** A draft older than this is dropped on read. */
export const DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const slot = (key: string, who: string) => `${PREFIX}${who}.${key}`;

/** True when the same screens the memory service uses would refuse this text as credential-shaped. Such text is never persisted. */
export function looksSensitive(value: string): boolean {
  if (!value) return false;
  try {
    if (sensitiveCategory(value)) return true;
    const note = screenNote(value);
    if (!note.ok && note.code === "prohibited-content") return true;
    if (value.length <= 800) {
      const fact = screenFact(value);
      if (!fact.ok && fact.code === "prohibited-content") return true;
    }
  } catch {
    return true; // when the screen itself fails, keep nothing
  }
  return false;
}

/** The stored draft for this person and form, or "" (also when it is older than the TTL). `who` empty means no known person: nothing is read. */
export function readDraft(key: string, who: string, now = Date.now()): string {
  if (!who) return "";
  try {
    const raw = window.localStorage.getItem(slot(key, who));
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    if (typeof parsed.v !== "string" || typeof parsed.at !== "number" || now - parsed.at > DRAFT_TTL_MS) {
      window.localStorage.removeItem(slot(key, who));
      return "";
    }
    if (looksSensitive(parsed.v)) {
      window.localStorage.removeItem(slot(key, who));
      return "";
    }
    return parsed.v;
  } catch {
    return "";
  }
}

/** Remember the text for this person. Empty or credential-shaped text removes the stored draft instead. */
export function writeDraft(key: string, value: string, who: string, now = Date.now()): void {
  if (!who) return;
  try {
    if (value && !looksSensitive(value)) window.localStorage.setItem(slot(key, who), JSON.stringify({ v: value.slice(0, MAX), at: now }));
    else window.localStorage.removeItem(slot(key, who));
  } catch {
    /* private mode or blocked storage: the form still works, it just is not remembered */
  }
}

/** Remove every stored draft, except those of `keepWho` when given. Used on sign-out and when a different person is signed in. */
export function clearDrafts(keepWho = ""): void {
  try {
    const ls = window.localStorage;
    const names: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k) names.push(k);
    }
    for (const k of names) {
      if (k.startsWith(LEGACY_PREFIX)) ls.removeItem(k);
      else if (k.startsWith(PREFIX) && !(keepWho && k.startsWith(`${PREFIX}${keepWho}.`))) ls.removeItem(k);
    }
  } catch {
    /* nothing to clear */
  }
}

/**
 * Like useState<string>, but remembered per `key` and per signed-in person. `seed` (for example a value from the URL) wins over a
 * stored draft, and a changed seed replaces the text. Nothing is read or stored until the person is known.
 */
export function useDraft(key: string, seed = ""): [string, (next: string) => void] {
  const who = useSignedIn()?.id ?? "";
  const [value, setValue] = useState(seed);
  const restoredFor = useRef("");
  const lastSeed = useRef(seed);
  useEffect(() => {
    if (!who) return;
    if (restoredFor.current !== who) {
      // A different person on this browser (or the first time the person is known): drop everyone else's drafts, then restore.
      clearDrafts(who);
      const previous = restoredFor.current;
      restoredFor.current = who;
      if (!seed) {
        const stored = readDraft(key, who);
        // Text typed before the person was known is kept; a different person never inherits the previous person's text.
        if (stored || previous) setValue(stored);
      }
    }
  }, [key, seed, who]);
  useEffect(() => {
    if (seed !== lastSeed.current) {
      lastSeed.current = seed;
      if (seed) setValue(seed);
    }
  }, [seed]);
  const set = useCallback(
    (next: string) => {
      setValue(next);
      writeDraft(key, next, who);
    },
    [key, who],
  );
  return [value, set];
}

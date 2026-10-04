// Read-through cache of the operator workspace (.operator-data/workspace.json) for READ-ONLY paths.
//
// Why (Track 8, 28 Sep): the file had grown to 54 MB (4,394 memory sources, 50 MB of it source
// text), and every GET /__operator/state — which the sidebar polls every 15 s on every page, in
// every open window — read and parsed all of it, then built and serialised an 8 MB reply. Live, one
// such GET took 17 s and the next timed out at 60 s; the desktop app's health check (/__token, same
// event loop) stalled for 20+ s and flipped the owner's window to "Recovering…" every 1-2 minutes.
//
// peek() parses the file once per version (its inode, size and mtime, plus the small
// brain-preferences file that load() merges in) and hands out a deep-frozen object, so a read-only
// caller that mutated it by mistake throws instead of corrupting the shared copy. Every path that
// changes the workspace keeps using the plugin's load() (a fresh, mutable parse) and save(), and
// save() invalidates this cache. body() memoises a serialised reply per state version.
import { statSync } from "node:fs";

/** A cheap version of a set of files: inode, size and mtime each ("-" when missing). A save renames a
 *  new file into place, so the inode changes even when size and mtime would not. */
export function filesStamp(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        const s = statSync(file);
        return `${s.ino}:${s.size}:${s.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value as object)) {
    seen.add(value as object);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key], seen);
    Object.freeze(value);
  }
  return value;
}

export type StateCache<T> = {
  /** The parsed state, re-read only when a file changed. Deep-frozen: never mutate it. */
  peek(): Readonly<T>;
  /** A reply derived from the current state, computed once per state version and key. */
  body(key: string, make: (state: Readonly<T>) => string): string;
  /** Drop the cached copy (after a save). */
  invalidate(): void;
  /** How many times the file has been parsed (tests, diagnostics). */
  readonly reads: number;
};

export function createStateCache<T>(files: readonly string[], read: () => T, stamp: (files: readonly string[]) => string = filesStamp): StateCache<T> {
  let entry: { stamp: string; value: Readonly<T>; bodies: Map<string, string> } | null = null;
  let reads = 0;
  const current = () => {
    const now = stamp(files);
    if (!entry || entry.stamp !== now) {
      // Stat before reading: a write landing mid-read leaves a newer stamp, so the next call re-reads.
      reads++;
      entry = { stamp: now, value: deepFreeze(read()), bodies: new Map() };
    }
    return entry;
  };
  return {
    peek: () => current().value,
    body(key, make) {
      const e = current();
      let text = e.bodies.get(key);
      if (text === undefined) {
        text = make(e.value);
        e.bodies.set(key, text);
      }
      return text;
    },
    invalidate() {
      entry = null;
    },
    get reads() {
      return reads;
    },
  };
}

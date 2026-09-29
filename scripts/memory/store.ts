/**
 * The app-owned memory store (default `<app>/.operator-data/memory/`, git-ignored; never inside
 * the vault). Plain JSON files written atomically (temp + rename), so a crash leaves either the
 * old or the new file, never half of one.
 *
 *   notes.json        path → { note id, hash, rev }         (stable ids + rename detection)
 *   vault-docs.json   documents derived from permitted notes (what the index should hold)
 *   memories.json     Hindsight-only memories (mem-…): the provenance record, all versions
 *   index.json        what Hindsight is confirmed to hold: id → { sync_key, synced_at, inflight }
 *   outbox.json       the durable journal of pending upserts/retracts, with attempts + errors
 *   tombstones.json   forgotten ids + content hashes (never the text)
 *   exclusions.json   ids removed from the index while their note stays in the vault
 *   status.json       last scan / drain / success, skipped-note summary
 *   receipts.jsonl    one usage receipt per Hindsight call
 *   processing.jsonl  one line per Hindsight write attempt: outcome, retries, which model processed it
 *   held.json         the mass-removal hold: the digest of vanished documents released by an approval
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "./wiki-store";
import type { NoteMap, Skip } from "./vault";
import type { Exclusion, IndexDoc, MemoryRecord, OutboxOp, ProcessedBy, ProcessingRecord, Tombstone, UsageReceipt } from "./types";

/** `purge`: delete the document from Hindsight before re-sending it (full forget of one section). */
export type IndexEntry = {
  sync_key: string | null;
  synced_at: string | null;
  inflight: boolean;
  purge?: boolean;
  /** Which model processed the confirmed version (Hindsight's receipts). */
  processed_by?: ProcessedBy | null;
  /** Set while the model receipt hasn't been read yet (it lands just after the retain). */
  model_pending?: string | null;
  /** The document's facts are marked invalidated in Hindsight while its delete waits (rate limit). */
  invalidated_at?: string | null;
};
export type HeldFile = { released_digest: string | null; released_by: string | null; released_at: string | null; approval_id: string | null };
export type StatusFile = {
  last_scan_at: string | null;
  last_drain_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  skipped: Skip[];
  /** Saves per processing model since the store began ("unknown" when no receipt was found). Never trimmed. */
  models?: Record<string, number>;
};
/** The append-only logs rotate at this size (one previous generation kept). */
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

/**
 * A missing file is an empty store. Anything else (unreadable, corrupt) throws: silently treating
 * a broken index or tombstone file as empty could orphan documents in Hindsight or let forgotten
 * content back in. Writes are atomic, so a half-written file can't happen.
 */
function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    throw e;
  }
  return JSON.parse(raw) as T;
}

/** The real path, or for a path that doesn't exist yet: its nearest existing ancestor's real path + the rest. */
const real = (p: string): string => {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
};
/** Junction- and symlink-aware: both paths are resolved to their real locations first. */
export function isInside(child: string, parent: string) {
  const rel = relative(real(parent), real(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function appendRotating(path: string, line: string) {
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch {
    /* not there yet */
  }
  appendFileSync(path, line + "\n", "utf8");
}

function readLines<T>(path: string, max: number): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-max)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export function createStore(stateDir: string, vaultRoot: string) {
  if (isInside(stateDir, vaultRoot)) throw new Error("The memory store must live outside the vault (sensitive memories never go in the Git-backed wiki).");
  mkdirSync(stateDir, { recursive: true });
  const p = (name: string) => join(stateDir, name);
  const write = (name: string, value: unknown) => atomicWrite(p(name), JSON.stringify(value, null, 1) + "\n");
  return {
    dir: stateDir,
    readNotes: () => readJson<NoteMap>(p("notes.json"), {}),
    writeNotes: (m: NoteMap) => write("notes.json", m),
    readVaultDocs: () => readJson<IndexDoc[]>(p("vault-docs.json"), []),
    writeVaultDocs: (d: IndexDoc[]) => write("vault-docs.json", d),
    readMemories: () => readJson<MemoryRecord[]>(p("memories.json"), []),
    writeMemories: (m: MemoryRecord[]) => write("memories.json", m),
    readIndex: () => readJson<Record<string, IndexEntry>>(p("index.json"), {}),
    writeIndex: (i: Record<string, IndexEntry>) => write("index.json", i),
    readOutbox: () => readJson<OutboxOp[]>(p("outbox.json"), []),
    writeOutbox: (o: OutboxOp[]) => write("outbox.json", o),
    readTombstones: () => readJson<Tombstone[]>(p("tombstones.json"), []),
    writeTombstones: (t: Tombstone[]) => write("tombstones.json", t),
    readExclusions: () => readJson<Exclusion[]>(p("exclusions.json"), []),
    writeExclusions: (e: Exclusion[]) => write("exclusions.json", e),
    readStatus: () => readJson<StatusFile>(p("status.json"), { last_scan_at: null, last_drain_at: null, last_success_at: null, last_error: null, skipped: [] }),
    writeStatus: (s: StatusFile) => write("status.json", s),
    appendReceipt: (r: UsageReceipt) => appendRotating(p("receipts.jsonl"), JSON.stringify(r)),
    appendProcessing: (r: ProcessingRecord) => appendRotating(p("processing.jsonl"), JSON.stringify(r)),
    /** Newest last; bounded to the last `max` lines. */
    readProcessing: (max = 500): ProcessingRecord[] => readLines<ProcessingRecord>(p("processing.jsonl"), max),
    readHeld: () => readJson<HeldFile>(p("held.json"), { released_digest: null, released_by: null, released_at: null, approval_id: null }),
    writeHeld: (h: HeldFile) => write("held.json", h),
    /** The most recent receipts (bounded read; the file rotates at LOG_ROTATE_BYTES). */
    readReceipts: (max = 2000): UsageReceipt[] => readLines<UsageReceipt>(p("receipts.jsonl"), max),
  };
}
export type MemoryStore = ReturnType<typeof createStore>;

/**
 * Reading the Obsidian vault for the connector. Read-only: nothing here writes to the vault.
 *
 *  - permitted notes: allow/deny globs over vault-relative paths (settings.ts), never raw/,
 *    templates or Obsidian internals, never a note that screens as credential-, transcript-,
 *    bank- or audio-shaped (guard.ts), never a note that opts out in frontmatter
 *    (`memory: false`, `hindsight: false`, `private: true` or `sensitive: true`);
 *  - stable note ids: frontmatter `id`, else a persisted path→id map, with renames detected by
 *    content hash so a moved note keeps its id (and its Hindsight document);
 *  - documents: one per current fact block (`mf-…`) and one for the rest of the note's body.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentHash, sha256, tokenize } from "./derived";
import { screenNote } from "./guard";
import { FACT_PAGE, blockLink, bucketOfPath, headingSectionText, parseFactBlocks, removeHeadingSection, stripFactBlocks } from "./wiki-store";
import { isBucket, type Bucket, type IndexDoc, type Tombstone } from "./types";

// ── globs ───────────────────────────────────────────────────────────────────────────────
const globCache = new Map<string, RegExp>();
/** `**` any depth, `*` within a segment, `?` one char. Case-insensitive (Windows vaults). */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re = new RegExp(`^${out}$`, "i");
  globCache.set(glob, re);
  return re;
}
export const matchesAny = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(path));

// ── frontmatter ─────────────────────────────────────────────────────────────────────────
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(m[0].length) };
}

const OPT_OUT = (f: Record<string, string>) =>
  /^(false|no|off|0)$/i.test(f.memory ?? "") || /^(false|no|off|0)$/i.test(f.hindsight ?? "") || /^(true|yes|1)$/i.test(f.private ?? "") || /^(true|yes|1)$/i.test(f.sensitive ?? "");

// ── scanning ────────────────────────────────────────────────────────────────────────────
export type ScannedNote = { path: string; raw: string; hash: string; bodyHash: string; mtime: string; fields: Record<string, string>; body: string };
export type Skip = { path: string; reason: string };

function walk(root: string, rel: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Never follow links or junctions out of the vault; never descend into dot folders.
    if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, next, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(next);
  }
}

/**
 * The app's own block and memory ids (`mf-`/`mem-` + 10 random hex, api.ts newId) are structure, not
 * content, so the note screen doesn't read them. A random id with six digits in a row ("mf-5f385935bb")
 * sat 11 characters before the fact footer's date ("Saved 2026-09-28"), and in a note that mentions an
 * account the bank-record rule read them as a BSB and an account number: the whole note, the fact just
 * saved included, was skipped and never indexed (about 1 save in 30; Track 8, 28 Sep). The fact text
 * itself is screened when it is saved; everything else in the note is still screened here.
 */
const GENERATED_ID = "(?:mf|mem)-[0-9a-f]{10}";
/**
 * Only where the app itself writes an id (wiki-store.ts renderFact): the begin/end markers, the meta
 * comment's JSON values, a block anchor at the end of a line, a block link, a backticked ref in the
 * "Corrects"/"Superseded" line, and "source: <id>" in the saved-by footer. An id-shaped token anywhere
 * else in hand-written text is screened like any other text (review T8 S-8: blanking every such token
 * let "account mf-1234567890" in a note past the bank-details screen).
 */
const STRUCTURAL_IDS: RegExp[] = [
  new RegExp(`(<!-- memory:(?:begin|end) )${GENERATED_ID}( -->)`, "g"),
  new RegExp(`(\\s\\^)${GENERATED_ID}$`, "gm"),
  new RegExp(`(\\[\\[[^\\]#\\n]*#\\^)${GENERATED_ID}(\\]\\])`, "g"),
  new RegExp(`(^(?:Corrects|\\*\\*Superseded \\([0-9-]+\\):\\*\\* replaced by) \`)${GENERATED_ID}(\`)`, "gm"),
  new RegExp(`(^\\*Saved [^\\n]*?source: )${GENERATED_ID}(?=[ ·*])`, "gm"),
];
export function withoutGeneratedIds(text: string): string {
  let out = text.replace(/^<!-- memory:meta [^\n]*-->$/gm, (line) => line.replace(new RegExp(`"${GENERATED_ID}"`, "g"), '"id"'));
  for (const re of STRUCTURAL_IDS) out = out.replace(re, (_m, before: string, after = "") => `${before}id${after}`);
  return out;
}

export function scanVault(vaultRoot: string, sync: { allow: string[]; deny: string[] }): { notes: ScannedNote[]; skipped: Skip[] } {
  if (!existsSync(join(vaultRoot, "wiki"))) throw new Error(`Not a vault root (no wiki/ folder): ${vaultRoot}`);
  const files: string[] = [];
  walk(vaultRoot, "", files);
  const notes: ScannedNote[] = [];
  const skipped: Skip[] = [];
  for (const path of files.sort()) {
    if (!matchesAny(path, sync.allow)) continue; // outside the allow list: not a candidate at all
    if (matchesAny(path, sync.deny)) {
      skipped.push({ path, reason: "denied path" });
      continue;
    }
    const abs = join(vaultRoot, path);
    let raw: string;
    let mtime: string;
    try {
      raw = readFileSync(abs, "utf8");
      mtime = statSync(abs).mtime.toISOString();
    } catch {
      continue; // vanished mid-scan: the next scan decides
    }
    const { fields, body } = parseFrontmatter(raw);
    if (OPT_OUT(fields)) {
      skipped.push({ path, reason: "opted out in frontmatter" });
      continue;
    }
    const screened = screenNote(withoutGeneratedIds(body), { script: /^script$/i.test(fields.type ?? "") });
    if (!screened.ok) {
      skipped.push({ path, reason: screened.code === "prohibited-content" ? `${screened.category}-shaped content` : screened.code });
      continue;
    }
    const norm = raw.replace(/\r\n/g, "\n");
    notes.push({ path, raw: norm, hash: sha256(norm), bodyHash: contentHash(body), mtime, fields, body });
  }
  return { notes, skipped };
}

// ── note ids ────────────────────────────────────────────────────────────────────────────
/**
 * `missing_since`: the note isn't in the vault right now (deleted, moved out, a branch switch, a sync
 * glitch). Its id is KEPT for NOTE_MEMORY_MS so a restore at the same path, or a slow rename with the
 * same content, gets the same id back: no duplicate in Hindsight, no re-processing, and an "unindex"
 * decision still applies (REVIEW-STAGE-D B5).
 */
export type NoteEntry = { id: string; hash: string; bodyHash: string; rev: number; missing_since?: string | null };
/** How long a vanished note's identity is remembered. */
export const NOTE_MEMORY_MS = 30 * 24 * 3600_000;
export type NoteMap = Record<string, NoteEntry>; // path → entry

const FM_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const newNoteId = (taken: Set<string>) => {
  for (;;) {
    const id = `n-${randomBytes(5).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * Give every scanned note a stable id: its frontmatter `id` (as `n-<id>`), else the id its path
 * had before (also when the path came back after being missing), else — when a previously known
 * path vanished and a new path has the same content — the vanished note's id (a rename), else a
 * fresh id. Vanished notes stay in the map, marked `missing_since`, for NOTE_MEMORY_MS.
 */
export function assignNoteIds(
  notes: ScannedNote[],
  previous: NoteMap,
  now: Date = new Date(),
  /** Ids still held in Hindsight (e.g. under a pending removal hold): their identity is kept however long. */
  stillIndexed: Set<string> = new Set(),
): { map: NoteMap; renames: { from: string; to: string; id: string }[] } {
  const map: NoteMap = {};
  const renames: { from: string; to: string; id: string }[] = [];
  const present = new Set(notes.map((n) => n.path));
  const taken = new Set<string>();
  const vanished = Object.entries(previous).filter(([p]) => !present.has(p));
  const usedVanished = new Set<string>();

  // Pass 1: frontmatter ids and unchanged paths.
  const pending: ScannedNote[] = [];
  for (const n of notes) {
    const fm = n.fields.id;
    if (fm && FM_ID.test(fm) && !taken.has(`n-${fm}`)) {
      const id = `n-${fm}`;
      const prevAtPath = previous[n.path];
      const vanishedSame = vanished.find(([, e]) => e.id === id);
      if (vanishedSame && !prevAtPath) (renames.push({ from: vanishedSame[0], to: n.path, id }), usedVanished.add(vanishedSame[0]));
      const prev = prevAtPath?.id === id ? prevAtPath : vanishedSame?.[1];
      map[n.path] = { id, hash: n.hash, bodyHash: n.bodyHash, rev: prev ? prev.rev + (prev.hash === n.hash ? 0 : 1) : 1 };
      taken.add(id);
      if (vanishedSame) usedVanished.add(vanishedSame[0]);
    } else pending.push(n);
  }
  for (const n of [...pending]) {
    const prev = previous[n.path];
    if (prev && !taken.has(prev.id)) {
      map[n.path] = { id: prev.id, hash: n.hash, bodyHash: n.bodyHash, rev: prev.rev + (prev.hash === n.hash ? 0 : 1) };
      taken.add(prev.id);
      pending.splice(pending.indexOf(n), 1);
    }
  }
  // Pass 2: renames by content, then fresh ids.
  for (const n of pending) {
    const match = vanished.find(([p, e]) => !usedVanished.has(p) && !taken.has(e.id) && (e.hash === n.hash || e.bodyHash === n.bodyHash));
    if (match) {
      usedVanished.add(match[0]);
      renames.push({ from: match[0], to: n.path, id: match[1].id });
      map[n.path] = { id: match[1].id, hash: n.hash, bodyHash: n.bodyHash, rev: match[1].rev };
      taken.add(match[1].id);
    } else {
      const id = newNoteId(new Set([...taken, ...Object.values(previous).map((e) => e.id)]));
      map[n.path] = { id, hash: n.hash, bodyHash: n.bodyHash, rev: 1 };
      taken.add(id);
    }
  }
  // Keep every vanished, unclaimed note's identity for a while (a restore gets it back).
  const at = now.toISOString();
  for (const [p, e] of vanished) {
    if (usedVanished.has(p) || taken.has(e.id) || map[p]) continue;
    const since = e.missing_since ?? at;
    if (now.getTime() - Date.parse(since) > NOTE_MEMORY_MS && !stillIndexed.has(e.id)) continue;
    map[p] = { ...e, missing_since: since };
    taken.add(e.id);
  }
  return { map, renames };
}

// ── documents ───────────────────────────────────────────────────────────────────────────
export const obsidianUri = (vaultName: string, path: string) =>
  `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/i, ""))}`;
const slugOf = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

export function noteBucket(path: string, fields: Record<string, string>): Bucket {
  if (isBucket(fields.bucket)) return fields.bucket;
  return bucketOfPath(path) ?? "general";
}
export function noteTitle(path: string, fields: Record<string, string>, body: string) {
  return fields.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slugOf(path);
}

export type Extracted = { docs: IndexDoc[]; skipped: Skip[] };

/**
 * The documents one note contributes. Superseded fact blocks are never indexed (so a
 * correction retracts the old fact), and tombstoned blocks, sections or notes are skipped
 * (so a restored file can't resurrect what was forgotten).
 */
export function extractDocs(note: ScannedNote, entry: NoteEntry, vaultName: string, tombstones: Tombstone[]): Extracted {
  const docs: IndexDoc[] = [];
  const skipped: Skip[] = [];
  const deadIds = new Set(tombstones.map((t) => t.id));
  const deadHashes = new Set(tombstones.map((t) => t.content_hash));
  if (deadIds.has(entry.id) || deadHashes.has(note.bodyHash)) return { docs, skipped: [{ path: note.path, reason: "forgotten (tombstoned)" }] };

  const bucket = noteBucket(note.path, note.fields);
  const uri = obsidianUri(vaultName, note.path);
  for (const f of parseFactBlocks(note.body, bucket, note.path)) {
    if (f.status !== "current") continue;
    if (deadIds.has(f.wiki_ref) || deadHashes.has(contentHash(f.text))) {
      skipped.push({ path: `${note.path}#^${f.wiki_ref}`, reason: "forgotten (tombstoned)" });
      continue;
    }
    docs.push({
      id: f.wiki_ref,
      kind: "fact",
      origin: "obsidian",
      title: f.title,
      content: f.text,
      bucket,
      version: f.version,
      version_hash: sha256(`${f.title}\n${f.text}`),
      updated: f.updated,
      source: { kind: "vault", path: note.path, note_id: entry.id, link: blockLink(note.path, f.wiki_ref), uri, block: f.wiki_ref },
      actor: f.saved_by,
      chain: f.chain,
    });
  }

  if (!FACT_PAGE.test(slugOf(note.path) + ".md")) {
    let body = stripFactBlocks(note.body).trim();
    // A forgotten heading section that reappears (e.g. a Git revert) is left out of the index.
    for (const t of tombstones) {
      if (t.kind !== "section" || !t.id.startsWith(`${entry.id}#`)) continue;
      const heading = t.id.slice(entry.id.length + 1);
      const section = headingSectionText(body, heading);
      if (section !== null && contentHash(section) === t.content_hash) {
        body = removeHeadingSection(body, heading) ?? body;
        skipped.push({ path: `${note.path}#${heading}`, reason: "forgotten (tombstoned)" });
      }
    }
    if (tokenize(body).length >= 3) {
      const title = noteTitle(note.path, note.fields, body);
      docs.push({
        id: entry.id,
        kind: "note",
        origin: "obsidian",
        title,
        content: body,
        bucket,
        version: entry.rev,
        version_hash: sha256(`${title}\n${body}`),
        updated: note.fields.updated && /^\d{4}-\d{2}-\d{2}/.test(note.fields.updated) ? new Date(note.fields.updated).toISOString() : note.mtime,
        source: { kind: "vault", path: note.path, note_id: entry.id, link: `[[${slugOf(note.path)}]]`, uri },
      });
    }
  }
  return { docs, skipped };
}

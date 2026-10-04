/**
 * "Save to the vault" facts: curated facts as sections of Obsidian notes.
 *
 *   wiki/topics/<bucket>/memory-<bucket>-shared.md     (type: topic, follows the vault schema)
 *
 * Each fact is one block:
 *
 *   <!-- memory:begin mf-1a2b3c4d5e -->
 *   ## Essential package price
 *   <!-- memory:meta {"wiki_ref":"mf-1a2b3c4d5e",...} -->
 *   Essential is A$699 a month. ^mf-1a2b3c4d5e
 *
 *   *Saved 2026-09-27 by Usman · voice*
 *   <!-- memory:end mf-1a2b3c4d5e -->
 *
 * A superseded fact stays in place (the vault never silently deletes a superseded claim) with a
 * `**Superseded (date):**` line linking the new version; the connector stops indexing it.
 * A full forget is the one operation that removes a block outright.
 *
 * Every write is conflict-safe: the file must still hash to what was read, or nothing is
 * written and a VaultConflictError surfaces (Obsidian or a person edited it meanwhile).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./derived";
import { BUCKETS, isBucket, type Bucket, type Fact } from "./types";

/** Legacy per-person pages are still read (single shared pool); new facts go to `-shared`. */
export const FACT_PAGE = /^memory-([a-z]+)-(usman|mehroz|shared)\.md$/;

export class VaultConflictError extends Error {
  constructor(public readonly path: string) {
    super(`The vault note ${path} changed since it was read. Nothing was overwritten; reload and try again.`);
  }
}

export function factPageSlug(bucket: Bucket) {
  return `memory-${bucket}-shared`;
}
export function factPagePath(bucket: Bucket) {
  return `wiki/topics/${bucket}/${factPageSlug(bucket)}.md`;
}
const slugOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
export function blockLink(path: string, ref: string) {
  return `[[${slugOf(path)}#^${ref}]]`;
}

type Meta = Omit<Fact, "title" | "text" | "source">;

const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Keep fact text from breaking the block markers or becoming a heading. */
export function sanitiseText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/<!--|-->/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").replace(/^(#{1,6}\s)/, "\\$1").replace(/\s\^mf-[0-9a-f]+$/, ""))
    .join("\n")
    .trim();
}
export function sanitiseTitle(title: string) {
  return title.replace(/[\r\n#<>[\]^|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

export function renderFact(fact: Fact, lookupPath: (ref: string) => string | undefined): string {
  const meta: Meta = {
    wiki_ref: fact.wiki_ref,
    chain: fact.chain,
    version: fact.version,
    bucket: fact.bucket,
    status: fact.status,
    created: fact.created,
    updated: fact.updated,
    saved_by: fact.saved_by,
    origin: fact.origin,
    supersedes: fact.supersedes,
    superseded_by: fact.superseded_by,
  };
  const via = [fact.origin.kind, fact.origin.ref ? `source: ${fact.origin.ref}` : "", fact.origin.note ?? ""].filter(Boolean).join(" · ");
  const link = (ref: string) => {
    const p = lookupPath(ref);
    return p ? blockLink(p, ref) : "`" + ref + "`";
  };
  const lines = [
    `<!-- memory:begin ${fact.wiki_ref} -->`,
    `## ${fact.title}`,
    `<!-- memory:meta ${safeJson(meta)} -->`,
    `${sanitiseText(fact.text)} ^${fact.wiki_ref}`,
    "",
    `*Saved ${fact.created.slice(0, 10)} by ${fact.saved_by} · ${via}${fact.version > 1 ? ` · version ${fact.version}` : ""}*`,
  ];
  if (fact.supersedes) lines.push(`Corrects ${link(fact.supersedes)}.`);
  if (fact.status === "superseded" && fact.superseded_by)
    lines.push(`**Superseded (${fact.updated.slice(0, 10)}):** replaced by ${link(fact.superseded_by)}.`);
  lines.push(`<!-- memory:end ${fact.wiki_ref} -->`);
  return lines.join("\n");
}

const BLOCK = /<!-- memory:begin (mf-[0-9a-f]+) -->\n([\s\S]*?)\n<!-- memory:end \1 -->/g;

function parseBlock(ref: string, body: string, bucket: Bucket, path: string): Fact | null {
  const lines = body.split("\n");
  const heading = lines.findIndex((l) => l.startsWith("## "));
  const metaAt = lines.findIndex((l) => l.startsWith("<!-- memory:meta "));
  if (heading < 0 || metaAt < 0) return null;
  let meta: Meta & { scope?: string };
  try {
    meta = JSON.parse(lines[metaAt].slice("<!-- memory:meta ".length, -" -->".length));
  } catch {
    return null;
  }
  if (meta.wiki_ref !== ref) return null;
  const end = lines.findIndex((l, i) => i > metaAt && l.endsWith(` ^${ref}`));
  if (end < 0) return null;
  const textLines = lines.slice(metaAt + 1, end + 1);
  textLines[textLines.length - 1] = textLines[textLines.length - 1].slice(0, -(` ^${ref}`.length));
  const text = textLines.join("\n").replace(/^\\(#{1,6}\s)/gm, "$1").trim();
  const { scope: _legacyScope, ...rest } = meta;
  // Legacy blocks recorded a person id; show it as a display name.
  const savedBy = typeof rest.saved_by === "string" && /^[a-z]+$/.test(rest.saved_by) ? titleCase(rest.saved_by) : rest.saved_by;
  return {
    ...rest,
    saved_by: savedBy || "Unknown",
    // Page location decides the bucket: a block moved by hand takes its new page's bucket.
    bucket,
    status: rest.status === "superseded" ? "superseded" : "current",
    title: lines[heading].slice(3).trim(),
    text,
    source: { path, wiki_ref: ref, link: blockLink(path, ref) },
  };
}

/** Every fact block in a note's text. */
export function parseFactBlocks(raw: string, bucket: Bucket, path: string): Fact[] {
  const facts: Fact[] = [];
  for (const m of raw.replace(/\r\n/g, "\n").matchAll(BLOCK)) {
    const fact = parseBlock(m[1], m[2], bucket, path);
    if (fact) facts.push(fact);
  }
  return facts;
}

/** The note text with every fact block cut out (what a note-level document indexes). */
export function stripFactBlocks(raw: string) {
  return raw.replace(/\r\n/g, "\n").replace(BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

export type FactPage = { path: string; bucket: Bucket; preamble: string; facts: Fact[]; hash: string | null };

function frontmatter(bucket: Bucket, date: string) {
  const title = `Memory ${titleCase(bucket)} Shared`;
  return [
    "---",
    `title: ${title}`,
    "type: topic",
    `bucket: ${bucket}`,
    `created: ${date}`,
    `updated: ${date}`,
    "sources: []",
    "memory_scope: shared",
    "---",
    "",
    `# ${title}`,
    "",
    'Curated facts saved to the vault through AgenticOS ("save this to the vault" or the Memory page). Shared business memory.',
    "Each section is one fact with a stable `wiki_ref`. Corrections keep the old version, marked superseded.",
    "A full forget removes the section and tombstones its `wiki_ref` so no index can bring it back.",
    "Edit through AgenticOS or directly here; the connector re-indexes changes. Map: [[canonical-map]].",
    "",
  ].join("\n");
}

export function readNoteRaw(vaultRoot: string, path: string): string | null {
  const abs = join(vaultRoot, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}
export const noteHash = (raw: string | null) => (raw === null ? null : sha256(raw.replace(/\r\n/g, "\n")));

export function readFactPage(vaultRoot: string, bucket: Bucket, path = factPagePath(bucket)): FactPage {
  const raw = readNoteRaw(vaultRoot, path);
  if (raw === null) return { path, bucket, preamble: "", facts: [], hash: null };
  const text = raw.replace(/\r\n/g, "\n");
  const first = text.search(/<!-- memory:begin mf-[0-9a-f]+ -->/);
  return { path, bucket, preamble: first < 0 ? text : text.slice(0, first), facts: parseFactBlocks(text, bucket, path), hash: noteHash(raw) };
}

/** Every fact page that exists, in a stable order. */
export function listFactPages(vaultRoot: string): string[] {
  const out: string[] = [];
  for (const bucket of BUCKETS) {
    const dir = join(vaultRoot, "wiki", "topics", bucket);
    if (!existsSync(dir)) continue;
    for (const name of readdirSafe(dir)) {
      const m = FACT_PAGE.exec(name);
      if (m && m[1] === bucket) out.push(`wiki/topics/${bucket}/${name}`);
    }
  }
  return out;
}
function readdirSafe(dir: string) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function bucketOfPath(path: string): Bucket | null {
  const m = /^wiki\/(?:topics|reports)\/([a-z]+)\//.exec(path);
  return m && isBucket(m[1]) ? m[1] : null;
}

export function atomicWrite(abs: string, content: string) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}

/**
 * Compare-and-swap for one vault note: write only if the file still hashes to `expected`
 * (null = must not exist yet). Throws VaultConflictError otherwise.
 */
export function writeNoteIfUnchanged(vaultRoot: string, path: string, expected: string | null, content: string | null) {
  const abs = join(vaultRoot, path);
  const current = noteHash(existsSync(abs) ? readFileSync(abs, "utf8") : null);
  if (current !== expected) throw new VaultConflictError(path);
  if (content === null) rmSync(abs, { force: true });
  else atomicWrite(abs, content);
}

/** Rewrite one fact page's blocks, conflict-safe against the hash it was read at. */
export function writeFactPage(vaultRoot: string, page: FactPage, facts: Fact[], today: string, lookupPath: (ref: string) => string | undefined) {
  let preamble = page.preamble || frontmatter(page.bucket, today);
  preamble = preamble.replace(/^updated:.*$/m, `updated: ${today}`);
  if (!preamble.endsWith("\n")) preamble += "\n";
  const body = facts.length ? facts.map((f) => renderFact(f, lookupPath)).join("\n\n") + "\n" : "_No facts saved here yet._\n";
  writeNoteIfUnchanged(vaultRoot, page.path, page.hash, preamble + (preamble.endsWith("\n\n") ? "" : "\n") + body);
}

/** Cut the fact blocks with these refs out of a note's text. */
export function removeBlocks(raw: string, refs: Set<string>) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(BLOCK, (whole, ref: string) => (refs.has(ref) ? "" : whole))
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Cut one heading section (the heading line through to the next heading of the same or a
 * higher level). Returns null when the heading isn't there.
 */
export function removeHeadingSection(raw: string, heading: string): string | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The text of one heading section (for hashing and previews), or null. */
export function headingSectionText(raw: string, heading: string): string | null {
  const without = removeHeadingSection(raw, heading);
  if (without === null) return null;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
  const level = /^(#+)/.exec(lines[start])![1].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

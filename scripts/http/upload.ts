import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Chat attachment uploads into ~/.hermes/image_cache (Audit F5, P1-2). The route used to save any
 * body under whatever extension the Content-Type or X-File-Name suggested, with no real size cap
 * and no pruning, so `{}`, malformed text and a 12 MB blob all landed on disk. Now the BYTES decide:
 *   - images: PNG, JPEG, WebP and GIF, by their magic numbers (up to 10 MB);
 *   - documents the chat composer offers: PDF (%PDF-) and Office Open XML (a ZIP holding the
 *     word/, xl/ or ppt/ part the extension names), up to 25 MB, the composer's old limit;
 *   - plain text named or typed .txt, .md, .csv or .json, only when it is valid UTF-8 with no NUL
 *     byte (up to 10 MB). HTML and SVG are never accepted: they would render as active content.
 * Anything else is refused. The composer's file picker and drag-drop use the same list
 * (ATTACHMENT_ACCEPT in src/components/home-command.tsx).
 */

const MB = 1024 * 1024;
export const IMAGE_LIMIT = 10 * MB;
export const DOCUMENT_LIMIT = 25 * MB;
export const TEXT_LIMIT = 10 * MB;
/** Read this much at most; each kind then has its own limit (UploadKind.limit). */
export const UPLOAD_LIMIT = DOCUMENT_LIMIT;

export type UploadKind = {
  ext: "png" | "jpg" | "webp" | "gif" | "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "md" | "csv" | "json";
  mime: string;
  image: boolean;
  /** The most bytes this kind may have. */
  limit: number;
};

const startsWith = (buf: Buffer, bytes: number[], at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const image = (ext: UploadKind["ext"], mime: string): UploadKind => ({ ext, mime, image: true, limit: IMAGE_LIMIT });

/** The image type these bytes really are, or null. */
export function sniffImage(buf: Buffer): UploadKind | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return image("png", "image/png");
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return image("jpg", "image/jpeg");
  if (startsWith(buf, ascii("GIF87a")) || startsWith(buf, ascii("GIF89a"))) return image("gif", "image/gif");
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return image("webp", "image/webp");
  return null;
}

const OOXML: Record<string, { part: string; mime: string }> = {
  docx: { part: "word/", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { part: "xl/", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { part: "ppt/", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(OOXML).map(([ext, v]) => [v.mime, ext]));

const TEXT: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json" };
const TEXT_BY_MIME: Record<string, string> = { "text/plain": "txt", "text/markdown": "md", "text/x-markdown": "md", "text/csv": "csv", "application/json": "json" };

/** Valid UTF-8 with no NUL byte: what a text attachment must be. */
export function isPlainUtf8(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * What an upload really is. `declared` is the Content-Type and `fileName` the X-File-Name the
 * browser sent: they only choose between the Office formats, which share one ZIP signature, and
 * name the text formats, whose bytes carry no signature of their own.
 */
export function sniffUpload(buf: Buffer, declared = "", fileName = ""): UploadKind | null {
  const img = sniffImage(buf);
  if (img) return img;
  const name = fileName.toLowerCase();
  const mime = declared.split(";")[0].trim().toLowerCase();
  if (startsWith(buf, ascii("%PDF-"))) return { ext: "pdf", mime: "application/pdf", image: false, limit: DOCUMENT_LIMIT };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) && buf.includes("[Content_Types].xml")) {
    const fromName = (name.match(/\.(docx|xlsx|pptx)$/) ?? [])[1];
    const ext = fromName ?? EXT_BY_MIME[mime];
    if (ext && buf.includes(OOXML[ext].part)) return { ext: ext as UploadKind["ext"], mime: OOXML[ext].mime, image: false, limit: DOCUMENT_LIMIT };
    return null;
  }
  const textExt = (name.match(/\.(txt|md|csv|json)$/) ?? [])[1] ?? (name.includes(".") ? undefined : TEXT_BY_MIME[mime]);
  if (textExt && buf.length && isPlainUtf8(buf)) return { ext: textExt as UploadKind["ext"], mime: TEXT[textExt], image: false, limit: TEXT_LIMIT };
  return null;
}

/** Only the files this route wrote: dashboard-<ms>-<16 hex>.<ext>. Hermes' own cache entries stay. */
const OURS = /^dashboard-\d+-[0-9a-f]{16}\.[a-z]{2,5}$/;

/**
 * Keeps the upload cache bounded: drops our uploads older than `maxAgeMs`, then the oldest until
 * at most `maxFiles` and `maxBytes` remain. Never touches a file this route did not write.
 * Returns how many files it removed.
 */
export function pruneUploadCache(
  dir: string,
  limits: { maxFiles?: number; maxBytes?: number; maxAgeMs?: number; now?: number } = {},
): number {
  const { maxFiles = 200, maxBytes = 500 * 1024 * 1024, maxAgeMs = 14 * 24 * 60 * 60 * 1000, now = Date.now() } = limits;
  let entries: Array<{ path: string; mtime: number; size: number }> = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => OURS.test(name))
      .map((name) => {
        try {
          const st = statSync(join(dir, name));
          return st.isFile() ? { path: join(dir, name), mtime: st.mtimeMs, size: st.size } : null;
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; mtime: number; size: number } => e !== null)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return 0;
  }
  let removed = 0;
  let keptFiles = 0;
  let keptBytes = 0;
  for (const e of entries) {
    const keep = now - e.mtime <= maxAgeMs && keptFiles < maxFiles && keptBytes + e.size <= maxBytes;
    if (keep) {
      keptFiles++;
      keptBytes += e.size;
      continue;
    }
    try {
      unlinkSync(e.path);
      removed++;
    } catch {
      /* in use or already gone */
    }
  }
  return removed;
}

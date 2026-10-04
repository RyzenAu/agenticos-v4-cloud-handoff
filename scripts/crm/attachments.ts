/** Private CRM attachments and external keys: additive tables created on first use (CREATE IF NOT EXISTS, like `optouts`),
 * so the schema v1 migration is untouched. Files live in the hub's own data folder (`<data>/crm-files/<aa>/<sha256>`), never in
 * the repository and never under a public/static folder; they are served only by the CRM's founder-session route.
 * Nothing here sends, publishes or fetches anything. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { CrmError, type Attachment, type CrmRef } from "./types";

export type ExternalKind = CrmRef["kind"] | "task";
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_DIR_NAME = "crm-files";

export function attachmentRoot(root: string): string {
  return join(dataDirFor(root), ATTACHMENT_DIR_NAME);
}

export function ensureAttachmentTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS crm_attachments(
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, company_id TEXT NOT NULL, deal_id TEXT,
    name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, added_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS crm_attachments_document ON crm_attachments(document_id);
  CREATE TABLE IF NOT EXISTS crm_external_keys(
    key TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL);`);
}

export function externalKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 300 ||
    /[\u0000-\u001f]/.test(value) ||
    value.trim() !== value
  )
    throw new CrmError(
      "validation",
      "An external key must be plain text of at most 300 characters.",
    );
  return value;
}

export function findByExternalKey(db: Database, kind: ExternalKind, key: string): string | null {
  ensureAttachmentTables(db);
  const row = db.query("SELECT ref_kind,ref_id FROM crm_external_keys WHERE key=?").get(key) as {
    ref_kind: string;
    ref_id: string;
  } | null;
  if (!row) return null;
  if (row.ref_kind !== kind)
    throw new CrmError(
      "idempotency-conflict",
      `This external key already belongs to a ${row.ref_kind}, not a ${kind}.`,
    );
  return row.ref_id;
}

export function recordExternalKey(db: Database, kind: ExternalKind, key: string, id: string): void {
  ensureAttachmentTables(db);
  db.query("INSERT INTO crm_external_keys(key,ref_kind,ref_id) VALUES(?,?,?)").run(key, kind, id);
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
};
/** Types a browser may show in place. Everything else, including HTML, is a download so stored files can never run script. */
const INLINE = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

export function attachmentMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}
export function attachmentInline(mime: string): boolean {
  return INLINE.has(mime) || mime.startsWith("text/plain");
}
export function safeAttachmentName(value: string): string {
  const name = basename(value.replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"<>:|?*]/g, "_")
    .trim()
    .slice(0, 200);
  if (!name || name === "." || name === "..")
    throw new CrmError("validation", "Attachment needs a file name.");
  return name;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rowToAttachment = (r: Record<string, unknown>): Attachment => ({
  id: String(r.id),
  documentId: String(r.document_id),
  companyId: String(r.company_id),
  dealId: (r.deal_id as string | null) ?? null,
  name: String(r.name),
  mime: String(r.mime),
  bytes: Number(r.bytes),
  sha256: String(r.sha256),
  addedAt: String(r.added_at),
});

export function listAttachments(db: Database, documentId?: string): Attachment[] {
  const has = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='crm_attachments'")
    .get();
  if (!has) return [];
  const rows = (
    documentId
      ? db
          .query("SELECT * FROM crm_attachments WHERE document_id=? ORDER BY added_at,name")
          .all(documentId)
      : db.query("SELECT * FROM crm_attachments ORDER BY added_at,name").all()
  ) as Record<string, unknown>[];
  return rows.map(rowToAttachment);
}

function blobPath(dir: string, sum: string): string {
  return join(dir, sum.slice(0, 2), sum);
}

/** Copies `bytes` into private storage and links it to the document. Re-adding the same file under the same document is a no-op. */
export function addAttachment(
  db: Database,
  dir: string,
  input: {
    documentId: string;
    companyId: string;
    dealId: string | null;
    name: string;
    bytes: Uint8Array;
    now: string;
  },
): { attachment: Attachment; created: boolean; blobCreated: boolean; blobPath: string } {
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES)
    throw new CrmError("validation", "Attachments can be at most 25 MB.");
  ensureAttachmentTables(db);
  const name = safeAttachmentName(input.name);
  const sum = sha(input.bytes);
  const id = `attachment-${createHash("sha256").update(`${input.documentId}\0${name}\0${sum}`).digest("hex").slice(0, 32)}`;
  const existing = db.query("SELECT * FROM crm_attachments WHERE id=?").get(id) as Record<
    string,
    unknown
  > | null;
  const target = blobPath(dir, sum);
  const blobCreated = !existsSync(target);
  if (blobCreated) {
    mkdirSync(join(dir, sum.slice(0, 2)), { recursive: true });
    const part = `${target}.part-${process.pid}`;
    writeFileSync(part, input.bytes);
    renameSync(part, target);
  }
  if (existing)
    return { attachment: rowToAttachment(existing), created: false, blobCreated, blobPath: target };
  const mime = attachmentMime(name);
  db.query(
    "INSERT INTO crm_attachments(id,document_id,company_id,deal_id,name,mime,bytes,sha256,added_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    input.documentId,
    input.companyId,
    input.dealId,
    name,
    mime,
    input.bytes.byteLength,
    sum,
    input.now,
  );
  return {
    attachment: {
      id,
      documentId: input.documentId,
      companyId: input.companyId,
      dealId: input.dealId,
      name,
      mime,
      bytes: input.bytes.byteLength,
      sha256: sum,
      addedAt: input.now,
    },
    created: true,
    blobCreated,
    blobPath: target,
  };
}

export type OpenedAttachment = { attachment: Attachment; body: Buffer };
/** Reads a stored file back, refusing a path outside the folder and any file whose bytes no longer match its recorded hash. */
export function openAttachment(db: Database, dir: string, id: string): OpenedAttachment {
  if (!/^attachment-[0-9a-f]{32}$/.test(id))
    throw new CrmError("not-found", "Attachment not found.");
  const row = db.query("SELECT * FROM crm_attachments WHERE id=?").get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) throw new CrmError("not-found", "Attachment not found.");
  const attachment = rowToAttachment(row);
  const file = resolve(blobPath(dir, attachment.sha256));
  if (!file.startsWith(resolve(dir) + sep) || !/^[0-9a-f]{64}$/.test(attachment.sha256))
    throw new CrmError("not-found", "Attachment not found.");
  if (!existsSync(file) || statSync(file).size !== attachment.bytes)
    throw new CrmError("not-found", "This file is missing from private storage.");
  const body = readFileSync(file);
  if (sha(body) !== attachment.sha256)
    throw new CrmError(
      "not-found",
      "This file no longer matches its saved fingerprint, so it was not served.",
    );
  return { attachment, body };
}

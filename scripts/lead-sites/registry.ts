// The record of every founder-triggered lead preview: one row per lead, in
// .operator-data/lead-sites.json (never committed). It's what the Leads UI reads for the
// "Preview live / expires in N days / expired — take it down" state.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PreviewStatus = "generated" | "deploying" | "live" | "taken_down" | "failed";

export type PreviewRecord = {
  leadId: number;
  business: string;
  vertical: string;
  slug: string;
  domain: string;
  url: string;
  /** Vercel project (team nahda) — one per preview, so a take-down removes everything at once. */
  project: string;
  /** Local folder the preview was generated into. */
  dir: string;
  status: PreviewStatus;
  generatedAt: string;
  generatedBy: string;
  deployedAt: string | null;
  deployedBy: string | null;
  expiresAt: string | null;
  takenDownAt: string | null;
  takenDownBy: string | null;
  /** Last live check after a deploy. */
  verified: { at: string; status: number; banner: boolean; noindexHeader: boolean } | null;
  lastError: string | null;
  /** How many verified services / facts the preview carries (for the drawer). */
  serviceCount: number;
  missing: string[];
};

export function registryPath(root: string) {
  return join(root, ".operator-data", "lead-sites.json");
}

export function readRegistry(root: string): PreviewRecord[] {
  const file = registryPath(root);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.previews) ? data.previews : [];
  } catch {
    return [];
  }
}

function writeRegistry(root: string, previews: PreviewRecord[]) {
  const file = registryPath(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, previews }, null, 2), "utf8");
  renameSync(tmp, file);
}

export function getPreview(root: string, leadId: number): PreviewRecord | null {
  return readRegistry(root).find((p) => p.leadId === leadId) ?? null;
}

export function upsertPreview(root: string, record: PreviewRecord): PreviewRecord {
  const all = readRegistry(root).filter((p) => p.leadId !== record.leadId);
  all.push(record);
  writeRegistry(root, all);
  return record;
}

export function patchPreview(root: string, leadId: number, patch: Partial<PreviewRecord>): PreviewRecord {
  const current = getPreview(root, leadId);
  if (!current) throw new Error("No preview on file for this lead.");
  return upsertPreview(root, { ...current, ...patch });
}

/** Days left before the 30-day expiry (negative once past it); null if never deployed. */
export function daysLeft(record: Pick<PreviewRecord, "expiresAt">, now = new Date()): number | null {
  if (!record.expiresAt) return null;
  return Math.ceil((Date.parse(record.expiresAt) - now.getTime()) / 86_400_000);
}

export function isExpired(record: Pick<PreviewRecord, "expiresAt" | "status">, now = new Date()): boolean {
  return record.status === "live" && !!record.expiresAt && Date.parse(record.expiresAt) <= now.getTime();
}

/** What the UI shows for each preview: the record plus its computed expiry state. */
export function withExpiry(record: PreviewRecord, now = new Date()) {
  return { ...record, daysLeft: daysLeft(record, now), expired: isExpired(record, now) };
}

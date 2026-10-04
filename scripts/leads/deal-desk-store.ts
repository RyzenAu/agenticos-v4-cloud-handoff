// Shared, founder-visible quote workbooks (the "deal desk"): one JSON file per workbook under <data dir>/deal-desk/.
// A workbook holds pricing scenarios and draft documents ONLY. The CRM owns the authoritative deals: this
// module never writes pipeline values, stages, probability or deal amounts, and only stores a crmDealRef string.
// Draft-only: nothing here sends, invoices or contacts anyone. Every write is atomic, keeps one
// previous version (<id>.prev.json) and is guarded by an optimistic revision check, so one founder's
// save can never silently overwrite the other's. Damaged files are listed but never rewritten.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { parseDealShape, type Deal } from "../../src/lib/deal-desk/deal";
import { validateDeal } from "../../src/lib/deal-desk/validate";
import { buildQuote, renderQuoteHtml } from "../../src/lib/deal-desk/quote";
import { renderAgreementHtml } from "../../src/lib/deal-desk/agreement";
import { draftDir } from "./sales-backoffice";

export const MAX_DEAL_BYTES = 512 * 1024;
const ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const CRM_REF_RE = /^crm:deal:[A-Za-z0-9_-]{1,80}$/;
export const DEAL_DESK_FILES = ["deal-desk-quote.html", "deal-desk-agreement.html", "deal-desk-deal.json"] as const;

/** An error that carries its own HTTP status and JSON body (operator-plugin sends it as-is). */
export class DealDeskError extends Error {
  constructor(public status: 400 | 404 | 409, message: string, public payload: Record<string, unknown> = { error: message }) {
    super(message);
  }
}

export type DealRecord = {
  schemaVersion: 1; id: string; rev: number; updatedAt: string; updatedBy: "usman" | "mehroz" | "dot" | "local";
  deal: Deal | null; draft: Deal | null; problem: string | null; leadId: number | null; archived: boolean;
  /** A reference to the CRM deal this workbook prices, e.g. "crm:deal:abc". Stored only; the CRM is never called. */
  crmDealRef: string | null;
};
export type DamagedRecord = { id: string; status: "damaged"; raw: string };
export type DealListRow =
  | { id: string; rev: number; name: string; updatedAt: string; updatedBy: string; status: "ready" | "draft"; problem: string | null; leadId: number | null; archived: boolean; crmDealRef: string | null }
  | { id: string; status: "damaged"; error: string };

/** What a caller who is not a confirmed human session may see of a workbook list or record: that it exists, who last saved it and
 * when, and whether it is ready or a draft. No quote bodies, no problem text, no lead or CRM links, no raw damaged text. */
export type WithheldWorkbook = { id: string; rev?: number; name?: string; updatedAt?: string; updatedBy?: string; status: "ready" | "draft" | "damaged"; archived?: boolean; withheld: true };
export function withholdWorkbookRow(row: DealListRow): WithheldWorkbook {
  if (row.status === "damaged") return { id: row.id, status: "damaged", withheld: true };
  return { id: row.id, rev: row.rev, name: row.name, updatedAt: row.updatedAt, updatedBy: row.updatedBy, status: row.status, archived: row.archived, withheld: true };
}
export function withholdWorkbookList(list: { deals: DealListRow[] }): { deals: WithheldWorkbook[] } {
  return { deals: list.deals.map(withholdWorkbookRow) };
}
export function withholdWorkbook(record: DealRecord | DamagedRecord): WithheldWorkbook {
  if ("raw" in record) return { id: record.id, status: "damaged", withheld: true };
  return { id: record.id, rev: record.rev, name: (record.draft ?? record.deal)?.name ?? record.id, updatedAt: record.updatedAt, updatedBy: record.updatedBy, status: record.draft ? "draft" : "ready", archived: record.archived, withheld: true };
}

const dirOf = (root: string) => join(dataDirFor(root), "deal-desk");
export function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new DealDeskError(400, "The quote workbook id must be 1 to 80 letters, digits or hyphens.");
  return id;
}
const fileOf = (root: string, id: string) => join(dirOf(root), `${id}.json`);

function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

/** Why a stored file is not a usable record, or the record. Never throws. */
function parseRecord(id: string, text: string): { record: DealRecord } | { error: string } {
  let r: any;
  try { r = JSON.parse(text); } catch { return { error: "The file is not valid JSON." }; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "The file is not a quote workbook record." };
  if (r.schemaVersion !== 1) return { error: "Unsupported schemaVersion." };
  if (r.id !== id) return { error: "The record id does not match the file name." };
  if (!Number.isSafeInteger(r.rev) || r.rev < 1) return { error: "Bad revision number." };
  if (typeof r.updatedAt !== "string" || !["usman", "mehroz", "dot", "local"].includes(r.updatedBy)) return { error: "Bad updatedAt or updatedBy." };
  if (!(r.crmDealRef === null || (typeof r.crmDealRef === "string" && CRM_REF_RE.test(r.crmDealRef)))) return { error: "Bad crmDealRef." };
  if (typeof r.archived !== "boolean" || !(r.leadId === null || Number.isSafeInteger(r.leadId))) return { error: "Bad archived or leadId." };
  if (!(r.problem === null || typeof r.problem === "string")) return { error: "Bad problem." };
  for (const key of ["deal", "draft"] as const) {
    if (r[key] === null) continue;
    try { if (parseDealShape(r[key], key).id !== id) return { error: `${key} id does not match the record id.` }; }
    catch (e) { return { error: `${key}: ${(e as Error).message}` }; }
  }
  return { record: r as DealRecord };
}

type Read = { kind: "missing" } | { kind: "damaged"; text: string; error: string } | { kind: "ok"; record: DealRecord };
function read(root: string, id: string): Read {
  const file = fileOf(root, id);
  if (!existsSync(file)) return { kind: "missing" };
  const text = readFileSync(file, "utf8");
  const parsed = parseRecord(id, text);
  return "record" in parsed ? { kind: "ok", record: parsed.record } : { kind: "damaged", text, error: parsed.error };
}

export function listDeals(root: string): { deals: DealListRow[] } {
  const dir = dirOf(root);
  const rows: DealListRow[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".prev.json")) continue;
      const id = f.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const r = read(root, id);
      if (r.kind === "damaged") rows.push({ id, status: "damaged", error: r.error });
      else if (r.kind === "ok") {
        const x = r.record;
        rows.push({ id, rev: x.rev, name: (x.draft ?? x.deal)?.name ?? id, updatedAt: x.updatedAt, updatedBy: x.updatedBy, status: x.draft ? "draft" : "ready", problem: x.problem, leadId: x.leadId, archived: x.archived, crmDealRef: x.crmDealRef });
      }
    }
  }
  const stamp = (r: DealListRow) => ("updatedAt" in r ? r.updatedAt : "");
  rows.sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.id.localeCompare(b.id));
  return { deals: rows };
}

export function getDeal(root: string, id: unknown): DealRecord | DamagedRecord {
  const safe = checkId(id);
  const r = read(root, safe);
  if (r.kind === "missing") throw new DealDeskError(404, "Quote workbook not found.");
  if (r.kind === "damaged") return { id: safe, status: "damaged", raw: r.text.slice(0, MAX_DEAL_BYTES) };
  return r.record;
}

const conflict = (message: string, current: unknown) => new DealDeskError(409, message, { error: message, current });
/** The signer of a remote request (set by the operator plugin) or "local" at this PC; never a self-declared name. */
// "dot": the gateway collaborator drafting a quote through the CRM (scripts/crm/ops.ts crm.quote.package); never a founder.
const who = (by: unknown): DealRecord["updatedBy"] => (typeof by === "string" && ["usman", "mehroz", "dot"].includes(by.toLowerCase()) ? (by.toLowerCase() as "usman" | "mehroz" | "dot") : "local");

function baseRevOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DealDeskError(400, "baseRev must be a whole number, 0 for a new deal.");
  return value as number;
}

/** Load the record a write is based on, enforcing the missing/damaged/stale rules. null = a new deal. */
function base(root: string, id: string, baseRev: number): DealRecord | null {
  const r = read(root, id);
  if (r.kind === "damaged") throw conflict("This quote workbook's file is damaged and was left untouched. It needs repair before it can be saved.", { id, status: "damaged", raw: r.text.slice(0, MAX_DEAL_BYTES) });
  if (r.kind === "missing") {
    if (baseRev !== 0) throw conflict("This quote workbook no longer exists on the server.", null);
    return null;
  }
  if (baseRev !== r.record.rev) throw conflict(`This quote workbook was changed by ${r.record.updatedBy} (now revision ${r.record.rev}). Reload it before saving.`, r.record);
  return r.record;
}

function commit(root: string, prev: DealRecord | null, next: DealRecord): DealRecord {
  const file = fileOf(root, next.id);
  if (prev) copyFileSync(file, join(dirOf(root), `${next.id}.prev.json`));
  atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function saveDeal(root: string, body: { deal?: unknown; baseRev?: unknown; by?: unknown }): { record: DealRecord } {
  const raw = body?.deal;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DealDeskError(400, "Send the workbook to save as { deal, baseRev }.");
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_DEAL_BYTES) throw new DealDeskError(400, "That workbook is too large to save (over 512 KB).");
  const id = checkId((raw as { id?: unknown }).id);
  const baseRev = baseRevOf(body.baseRev);
  let parsed: Deal;
  try { parsed = parseDealShape(raw, "Deal"); } catch (e) { throw new DealDeskError(400, (e as Error).message); }
  const prev = base(root, id, baseRev);
  const problem = validateDeal(parsed);
  const next: DealRecord = {
    schemaVersion: 1, id, rev: (prev?.rev ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: who(body.by),
    deal: problem === null ? parsed : prev?.deal ?? null, draft: problem === null ? null : parsed, problem,
    leadId: prev?.leadId ?? null, archived: prev?.archived ?? false, crmDealRef: prev?.crmDealRef ?? null,
  };
  return { record: commit(root, prev, next) };
}

export function archiveDeal(root: string, body: { id?: unknown; baseRev?: unknown; by?: unknown }): { record: DealRecord } {
  const id = checkId(body?.id);
  const prev = base(root, id, baseRevOf(body.baseRev));
  if (!prev) throw new DealDeskError(404, "Quote workbook not found.");
  return { record: commit(root, prev, { ...prev, rev: prev.rev + 1, updatedAt: new Date().toISOString(), updatedBy: who(body.by), archived: true }) };
}

/** Store (or clear, with null) the reference to the CRM deal this workbook prices. Reference only: no CRM call. */
export function linkDeal(root: string, body: { id?: unknown; baseRev?: unknown; crmDealRef?: unknown; by?: unknown }): { record: DealRecord } {
  const id = checkId(body?.id);
  const ref = body?.crmDealRef;
  if (!(ref === null || (typeof ref === "string" && CRM_REF_RE.test(ref)))) throw new DealDeskError(400, "crmDealRef must look like crm:deal:<id>, or be null to unlink.");
  const prev = base(root, id, baseRevOf(body.baseRev));
  if (!prev) throw new DealDeskError(404, "Quote workbook not found.");
  return { record: commit(root, prev, { ...prev, rev: prev.rev + 1, updatedAt: new Date().toISOString(), updatedBy: who(body.by), crmDealRef: ref }) };
}

/** Write the quote, agreement and deal JSON into the lead's drafts folder and link the record. The caller
 *  has already validated the lead (exists, not excluded, not closed). Nothing is sent. */
export function attachDeal(root: string, body: { id?: unknown; baseRev?: unknown; by?: unknown }, leadId: number, assertLeadMatches: (deal: Deal) => void = () => {}): { record: DealRecord; files: string[] } {
  const id = checkId(body?.id);
  // The founder attaches the version they are looking at: a stale revision is refused, never silently replaced.
  const rec = base(root, id, baseRevOf(body.baseRev));
  if (!rec) throw new DealDeskError(404, "Quote workbook not found.");
  if (!rec.deal || rec.draft) throw conflict("Finish or discard the unfinished changes first.", rec);
  assertLeadMatches(rec.deal);
  const dir = draftDir(root, leadId);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, "deal-desk-quote.html"), renderQuoteHtml(buildQuote(rec.deal), false));
  atomicWrite(join(dir, "deal-desk-agreement.html"), renderAgreementHtml(rec.deal));
  atomicWrite(join(dir, "deal-desk-deal.json"), JSON.stringify(rec.deal, null, 2) + "\n");
  const record = commit(root, rec, { ...rec, rev: rec.rev + 1, updatedAt: new Date().toISOString(), updatedBy: who(body.by), leadId });
  return { record, files: [...DEAL_DESK_FILES] };
}

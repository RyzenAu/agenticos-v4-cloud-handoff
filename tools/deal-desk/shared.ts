/**
 * Shared quote workbooks: the client for the OS's /leads/deal-desk/* routes (reached through the existing
 * /__operator mount, which applies the OS session, origin and identity checks). Used only when the desk is
 * served by the OS; the standalone preview keeps using this browser's storage.
 *
 * A workbook holds pricing scenarios and draft documents. It is not a CRM deal: the CRM stays authoritative
 * for pipeline values, and a workbook only stores a reference to one (crm:deal:<id>).
 */
import { parseDealShape, type Deal } from "../../src/lib/deal-desk/deal";

export type Owner = "usman" | "mehroz" | "local";
export type WorkbookRecord = {
  id: string; rev: number; updatedAt: string; updatedBy: Owner;
  deal: Deal | null; draft: Deal | null; problem: string | null;
  leadId: number | null; crmDealRef: string | null; archived: boolean;
};
export type WorkbookSummary = { id: string; rev?: number; name?: string; updatedAt?: string; updatedBy?: Owner; status: "ready" | "draft" | "damaged"; problem?: string | null; error?: string; leadId?: number | null; crmDealRef?: string | null; archived?: boolean; /** The server withheld the quote bodies: this browser is not a confirmed human session. */ withheld?: boolean };
export type Damaged = { id: string; error: string; raw: string | null };

/** The workbook on the server has moved on from the revision this browser had: someone else saved it. */
export class ConflictError extends Error {
  constructor(readonly current: WorkbookRecord | null, message = "Someone else saved a newer version of this workbook.") { super(message); }
}
export class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }

let tokenRequest: Promise<string> | null = null;
/** The OS page token for this browser session (each signed-in founder has their own); empty if the OS gives none. */
function pageToken(): Promise<string> {
  tokenRequest ??= fetch("/__token", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).then((j) => (typeof j?.token === "string" ? j.token : ""))
    .catch(() => "");
  return tokenRequest;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const send = async () => fetch(`/__operator/leads/deal-desk${path}`, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await pageToken() }, body: JSON.stringify(body) });
  let r = await send();
  if (r.status === 403 && body !== undefined) { tokenRequest = null; r = await send(); } // stale token after a server restart
  const json: any = await r.json().catch(() => null);
  if (!r.ok) throw classify(r.status, json, (body as { baseRev?: number } | undefined)?.baseRev);
  return json as T;
}

/**
 * A 409 is a revision conflict only when the server's current revision differs from the one this request was based
 * on. Every other refusal (package mismatch, "choose the package first", unfinished changes, a damaged file) reaches
 * the founder in the server's own words.
 */
export function classify(status: number, json: any, baseRev: number | undefined): Error {
  const message = typeof json?.error === "string" && json.error ? json.error : `Request failed (${status})`;
  if (status !== 409) return new RequestError(message, status);
  const cur = json?.current;
  if (cur === null && baseRev) return new ConflictError(null, message); // the workbook no longer exists on the server
  if (cur && typeof cur.rev === "number" && cur.rev !== baseRev) { try { return new ConflictError(toRecord(cur), message); } catch { return new RequestError(message, status); } }
  return new RequestError(message, status);
}

function toRecord(raw: any): WorkbookRecord {
  return {
    id: String(raw.id), rev: Number(raw.rev) || 0, updatedAt: String(raw.updatedAt ?? ""), updatedBy: raw.updatedBy ?? "local",
    deal: raw.deal ? parseDealShape(raw.deal, "Saved workbook") : null,
    draft: raw.draft ? parseDealShape(raw.draft, "Unfinished changes") : null,
    problem: raw.problem ?? null, leadId: raw.leadId ?? null, crmDealRef: raw.crmDealRef ?? null, archived: Boolean(raw.archived),
  };
}

export const shared = {
  /** True when this page is served by an OS that has the shared workbook routes and lets this session read them. */
  async available(): Promise<boolean> {
    try { const r = await fetch("/__operator/leads/deal-desk/list", { credentials: "same-origin" }); return r.ok && (r.headers.get("content-type") ?? "").includes("json"); }
    catch { return false; }
  },
  async list(): Promise<WorkbookSummary[]> { return (await call<{ deals: WorkbookSummary[] }>("/list")).deals; },
  async get(id: string): Promise<WorkbookRecord | Damaged> {
    const raw: any = await call(`/get?id=${encodeURIComponent(id)}`);
    if (raw?.status === "damaged") return { id, error: "This saved workbook could not be read.", raw: typeof raw.raw === "string" ? raw.raw : null };
    try { return toRecord(raw); } catch (e) { return { id, error: (e as Error).message, raw: JSON.stringify(raw) }; }
  },
  async save(deal: Deal, baseRev: number): Promise<WorkbookRecord> { return toRecord((await call<{ record: unknown }>("/save", { deal, baseRev })).record); },
  async archive(id: string, baseRev: number): Promise<WorkbookRecord> { return toRecord((await call<{ record: unknown }>("/archive", { id, baseRev })).record); },
  async link(id: string, baseRev: number, crmDealRef: string | null): Promise<WorkbookRecord> { return toRecord((await call<{ record: unknown }>("/link", { id, baseRev, crmDealRef })).record); },
  async attach(id: string, baseRev: number, lead: number): Promise<{ record: WorkbookRecord; files: string[] }> {
    const r = await call<{ record: unknown; files: string[] }>("/attach", { id, baseRev, lead });
    return { record: toRecord(r.record), files: r.files };
  },
};
/**
 * What to do when another browser's newer save of a workbook arrives while this tab is open.
 *  - "skip":     this tab's own save is still on its way; its response will bring the new revision.
 *  - "ours":     the newer save is the content this tab last sent (its response was not processed yet): take it quietly.
 *  - "conflict": this tab has unsaved edits and the newer save is someone else's: ask, never overwrite.
 *  - "replace":  nothing unsaved here: show the newer save.
 */
export function refreshDecision(x: { inFlight: boolean; dirty: boolean; timerPending: boolean; incoming: string; lastSent: string | undefined }): "skip" | "ours" | "conflict" | "replace" {
  if (x.inFlight) return "skip";
  if (x.lastSent !== undefined && x.incoming === x.lastSent) return "ours";
  if (x.dirty || x.timerPending) return "conflict";
  return "replace";
}

/** Can this browser change shared workbooks? Only a confirmed human session can; anything else may read them. */
export async function sessionCanWrite(): Promise<{ canWrite: boolean; who: string | null }> {
  try {
    const r = await fetch("/__devices/me", { credentials: "same-origin" });
    const me: any = r.ok ? await r.json() : null;
    return { canWrite: me?.principal?.actor === "human", who: me?.principal?.displayName ?? me?.person?.name ?? null };
  } catch { return { canWrite: false, who: null }; }
}

export const ownerName = (o: Owner) => (o === "usman" ? "Usman" : o === "mehroz" ? "Mehroz" : "this PC");

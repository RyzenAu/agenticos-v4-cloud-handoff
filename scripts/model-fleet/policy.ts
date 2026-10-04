import { catalogue } from "../model-router/catalogue";
/** Public catalogue facts are separate from account authentication and remaining allowance. */
export const CLINE_CATALOGUE = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
export type Availability = { listedFree: boolean; checkedAt: number; source: string; remainingQuota: null };
export type Receipt = {
  model: string; provider: "cline"; providerModel: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "termination_unverified";
  elapsedMs: number; contextTrimmed: boolean; fallback: "none";
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  /** Row id for a routed attempt (fleetReceiptId in model-router/receipts.ts), so the router's view
   *  counts the call once. Absent for unrouted calls (a random id is used). */
  rowId?: string;
};
export class FleetError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
/** One Cline model as the bridge names it: `name` is the catalogue id without "cline/". */
export type ClineModel = { id: string; name: string; providerModel: string; routable: boolean };

/** Every Cline model in the catalogue (scripts/model-router/catalogue.json), the one place ids live. */
export function clineModels(): ClineModel[] {
  return catalogue().models.filter((m) => m.provider === "cline").map((m) => ({
    id: m.id, name: m.id.slice("cline/".length), providerModel: m.providerModel,
    routable: m.status === "verified" || m.status === "configured" }));
}
/** The bridge's name for a catalogue id ("cline/deepseek-v4.1-flash" -> "deepseek-v4.1-flash"). */
export function clineBridgeName(id: string) {
  if (!id.startsWith("cline/")) throw new Error(`${id} is not a Cline model`);
  return id.slice("cline/".length);
}
/** Refused by owner policy: Pixel Canary under any spelling, and any Cline model the catalogue
 *  excludes or marks stale (e.g. the stealth Space Bunny), by bridge name or provider id. */
export function excluded(model: string) {
  if (/pixel[-_ ]?canary/i.test(model)) return true;
  const wanted = model.trim().toLowerCase();
  return clineModels().some((m) => !m.routable && (m.name.toLowerCase() === wanted || m.providerModel.toLowerCase() === wanted));
}
export const finiteUsage = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

/** Exact free-list membership only; never infer free from a name or from API reachability. */
export async function freeAvailability(id: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<Availability> {
  const response = await request(CLINE_CATALOGUE, {signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8_000)]), redirect:"error"});
  if (!response.ok) throw new FleetError("Free availability could not be verified; no fallback attempted.",503);
  const body = await response.json() as any;
  return {listedFree:Array.isArray(body.free) && body.free.some((r:any)=>r?.id===id), checkedAt:Date.now(), source:CLINE_CATALOGUE, remainingQuota:null};
}

/** Abort even when an adapter ignores its signal; late replies cannot become success. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(signal.reason ?? new FleetError("Cancelled.",499));
    if(signal.aborted) { work.catch(()=>{}); stop(); return; }
    signal.addEventListener("abort",stop,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener("abort",stop));
  });
}

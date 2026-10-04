import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { clineModels, type Receipt } from "./policy";
import { dataDirFor } from "../cloud/data-dir";

// Bridge name -> Cline provider id, from the catalogue (every Cline model, so a legacy row for a
// since-excluded model still validates; the bridge itself refuses excluded models).
const routes: Record<string,string> = Object.fromEntries(clineModels().map((m)=>[m.name,m.providerModel]));
const outcomes=new Set(["succeeded","failed","cancelled","timed_out","termination_unverified"]);
const usage=(n:unknown)=>n===null || typeof n==="number"&&Number.isFinite(n)&&n>=0;
const tokenCount=(n:unknown)=>n===null || typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const validReceipt=(r:Receipt)=>!!r && Object.hasOwn(routes,r.model) && r.provider==="cline" &&
  (r.providerModel===routes[r.model] || (r.providerModel===null && r.outcome!=="succeeded")) &&
  outcomes.has(r.outcome) && Number.isFinite(r.elapsedMs) && r.elapsedMs>=0 &&
  typeof r.contextTrimmed==="boolean" && r.fallback==="none" && !!r.usage &&
  tokenCount(r.usage.inputTokens) && tokenCount(r.usage.outputTokens) && usage(r.usage.costUsd) &&
  (r.rowId===undefined || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.rowId));

/** Reason codes only. Never carries prompt, output, error text, paths or OS error codes. */
export type RecorderFailureReason = "invalid_metadata" | "storage_unavailable" | "recorder_exception";
export type RecorderHealth = { failures:number; lastFailureAt:number|null; lastFailureReason:RecorderFailureReason|null; since:number };
export class ReceiptRecorderFailure extends Error {
  constructor(public reason:RecorderFailureReason) { super("Fleet receipt recorder failed"); }
}
/** Process-wide (survives Vite config reloads), per data root. A process restart starts a
 * new window, reported as `since`: absence of failures before it is not evidence. */
const healthKey=Symbol.for("mu.model-fleet.recorder-health.v1");
const healthRegistry=globalThis as typeof globalThis & {[healthKey]?:Map<string,RecorderHealth>};
function healthFor(root:string) {
  const all=healthRegistry[healthKey] ?? (healthRegistry[healthKey]=new Map());
  const key=resolve(root);
  let health=all.get(key);
  if(!health) { health={failures:0,lastFailureAt:null,lastFailureReason:null,since:Date.now()}; all.set(key,health); }
  return health;
}
export function recorderHealth(root:string):RecorderHealth { return {...healthFor(root)}; }
function recordFailure(root:string,reason:RecorderFailureReason) {
  const health=healthFor(root);
  health.failures++; health.lastFailureAt=Date.now(); health.lastFailureReason=reason;
}

/** Dedicated metadata store. Explicit projection prevents extra prompt/output/error
 * fields from being persisted. Not invoice reconciliation; unknown usage stays null.
 */
export class ModelFleetReceiptSink {
  private db:Database;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path,{create:true});
    this.db.exec(`PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, recordedAt INTEGER NOT NULL, model TEXT NOT NULL,
      provider TEXT NOT NULL, providerModel TEXT, outcome TEXT NOT NULL,
      elapsedMs REAL NOT NULL, contextTrimmed INTEGER NOT NULL, fallback TEXT NOT NULL,
      inputTokens REAL, outputTokens REAL, costUsd REAL)`);
  }
  append(r:Receipt) {
    if(!validReceipt(r)) throw new Error("Invalid fleet receipt metadata");
    this.db.query("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      r.rowId ?? randomUUID(),Date.now(),r.model,r.provider,r.providerModel,r.outcome,r.elapsedMs,
      Number(r.contextTrimmed),r.fallback,r.usage.inputTokens,r.usage.outputTokens,r.usage.costUsd);
  }
  list(limit=50) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("Invalid receipt limit");
    return this.db.query("SELECT * FROM receipts ORDER BY rowid DESC LIMIT ?").all(limit);
  }
  close(){this.db.close();}
}

/** Minimal host constructor hook. Opens only this dedicated metadata database and
 * only on first settlement; never scans existing private state or provider config.
 * One connection per synchronous append, including across host reloads.
 */
export function modelFleetReceiptSink(root:string):(r:Receipt)=>void {
  return r=>{
    // Any failure is counted before rethrowing a sanitised error: a missing row is a
    // visible accounting gap, never silently read as zero spend.
    if(!validReceipt(r)) { recordFailure(root,"invalid_metadata"); throw new ReceiptRecorderFailure("invalid_metadata"); }
    let sink:ModelFleetReceiptSink|undefined;
    try{
      sink=new ModelFleetReceiptSink(join(dataDirFor(root),"model-fleet","receipts.sqlite"));
      sink.append(r);
    }catch{
      recordFailure(root,"storage_unavailable"); throw new ReceiptRecorderFailure("storage_unavailable");
    }finally{try{sink?.close();}catch{/* close failure after a committed insert is not a lost row */}}
  };
}

export function readModelFleetReceipts(root:string,limit=50) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("Invalid receipt limit");
  const file=join(dataDirFor(root),"model-fleet","receipts.sqlite");
  if(!existsSync(file))return [];
  const db=new Database(file,{readonly:true});
  try{return db.query(`SELECT id,recordedAt,model,provider,providerModel,outcome,
    elapsedMs,contextTrimmed,fallback,inputTokens,outputTokens,costUsd
    FROM receipts ORDER BY rowid DESC LIMIT ?`).all(limit);}finally{db.close();}
}

/** Register under the operator's existing host/origin checks. GET additionally
 * requires the page token; a loopback proxy is not local-owner authority.
 */
export function modelFleetReceiptRoute(input:{path:string;method:string;url:URL;remote:boolean;authenticated:boolean},root:string) {
  if(input.path!=="/model-fleet/receipts")return null;
  if(input.remote||!input.authenticated)return {status:403,body:{error:"Local owner authentication required."}};
  if(input.method!=="GET")return {status:405,body:{error:"Method not allowed."}};
  const limit=Number(input.url.searchParams.get("limit")??50);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)return {status:400,body:{error:"limit must be a whole number from 1 to 100."}};
  const recorder=recorderHealth(root);
  try{return {status:200,body:{receipts:readModelFleetReceipts(root,limit),
    costBasis:"provider_reported",unknownCost:"null",invoiceReconciled:false,
    // Rows missing because the recorder failed make any spend total a lower bound. This is NOT
    // complete accounting (audit A-L3): it cannot see calls that died before onReceipt ran, or
    // receipts lost before a restart. It only says the recorder has not failed since `since`.
    recorder,since:new Date(recorder.since).toISOString(),
    noRecorderFailuresSince:recorder.failures===0?new Date(recorder.since).toISOString():null,
    spendIsLowerBound:recorder.failures>0}};}
  catch{return {status:503,body:{error:"Receipt storage is unavailable."}};}
}

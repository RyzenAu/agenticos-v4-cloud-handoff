/** Explicitly invoked synthetic review only. Never imports account configuration. */
import { writeFileSync } from "node:fs";
import { providerModelId } from "../model-router/catalogue";
import { CLINE_CATALOGUE as catalogueUrl, clineBridgeName } from "./policy";
import { localOwnerHeaders } from "../identity/local-owner-token";

/** Bridge name + Cline provider id for a catalogue id (ids live in the catalogue only). */
const fleetModel = (id: string) => ({ model: clineBridgeName(id), id: providerModelId(id) });
const reviews = [
  { ...fleetModel("cline/deepseek-v4.1-flash"), topic: "synthetic economics", code: `// Entirely synthetic AUD scenario, not a real offer or tax advice.
function margin(monthlyIncludingGst, minutes, usdPerMinute, audPerUsd, supportHours, hourlyCost) {
 const revenue = monthlyIncludingGst / 1.1;
 const variable = minutes * usdPerMinute * audPerUsd;
 return {profit: revenue - variable, margin: (monthlyIncludingGst - variable)/monthlyIncludingGst};
}
// scenario: 550 incl GST, 300 minutes, USD 0.10/min, FX 1.5, support 2h at AUD 40/h.
// Requirement: separate contribution from profit after support, don't double-count bundled LLM fees.` },
  { ...fleetModel("cline/mimo-v2.6-flash"), topic: "synthetic finance adapter", code: `// Synthetic pseudocode only, no bank accounts, credentials or transactions.
async function sync(owner, consent, provider, db) {
 const rows = await provider.transactions(consent.id);
 for (const row of rows) await db.insert({id: row.id, owner, amount: parseFloat(row.amount), status: row.status});
 return {state:'connected', syncedAt:Date.now()};
}
// Requirement: read-only authorised owner, revocable scoped consent, idempotent import,
// pending-to-booked reconciliation, exact currency arithmetic, truthful last successful sync.` },
  { ...fleetModel("cline/muse-spark-1.3"), topic: "synthetic routing QA", code: `// Synthetic pseudocode only.
async function complete(request) {
 try {return await freeModel(request);} catch {return paidModel(request);}
}
function onDisconnect(job) {job.status='cancelled';}
function parseResult(raw) {return {ok: true, text:raw.text, tokens:raw.usage?.tokens || 0};}
// Requirement: no paid fallback or quota rotation; child abort; bounded queue and timeout;
// failed/truncated output never success; unknown usage never asserted zero; no raw prompt logging.
// Propose adversarial synthetic tests with expected outcomes, distinguishing transport from live proof.` },
];

async function review(item: typeof reviews[number]) {
  const checkedAt = new Date().toISOString();
  const catalog = await fetch(catalogueUrl, { signal: AbortSignal.timeout(10_000) });
  if (!catalog.ok) throw new Error("Public free catalogue unavailable; no completion attempted");
  const data = await catalog.json() as any;
  if (!data.free?.some((row: any) => row.id === item.id)) throw new Error("Model not currently listed free; no fallback");
  const start = Date.now();
  const response = await fetch("http://127.0.0.1:8081/__cline/v1/chat/completions", {
    // Deliberately synthetic code, declared so (recorded by the bridge; never a refusal).
    method: "POST", headers: { "Content-Type": "application/json", "X-MU-Data-Class": "synthetic", ...localOwnerHeaders() }, signal: AbortSignal.timeout(320_000),
    body: JSON.stringify({model:item.model, messages:[{role:"user",content:
      `Independent review of this deliberately flawed SYNTHETIC example. No tools. Give at most 5 concrete findings and corrected expected values or test assertions. Under 250 words. Do not invent runtime evidence.\n${item.code}`}]}),
  });
  const body = await response.json() as any;
  return {topic:item.topic, model:item.model, providerId:item.id, checkedAt, elapsedMs:Date.now()-start,
    httpStatus:response.status, returnedModel:body.model ?? null, usage:body.usage ?? null,
    receipt:body.fleet_receipt ?? null, routerReceipt:body.router_receipt ?? null, freeListingVerified:true, remainingQuota:null,
    review:response.ok ? body.choices?.[0]?.message?.content ?? null : null,
    error:response.ok ? null : "Completion failed; no fallback attempted"};
}

if (import.meta.main) {
  const results: unknown[] = [];
  for (const batch of [reviews.slice(0,2), reviews.slice(2)]) {
    const settled = await Promise.allSettled(batch.map(review));
    settled.forEach((r,i) => results.push(r.status === "fulfilled" ? r.value : {model:batch[i].model,error:"Probe failed or timed out; no fallback"}));
    writeFileSync(new URL("./review-results.json", import.meta.url), JSON.stringify(results,null,2)+"\n");
    console.log(JSON.stringify(results.map((r:any)=>({model:r.model,httpStatus:r.httpStatus,elapsedMs:r.elapsedMs,error:r.error}))));
  }
}

/** Explicit owner-authorised source-only reviews. No runtime data or config files. The source
 *  is this repo's own code, declared as data class "public" (a record; the bridge never refuses on it). */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { providerModelId } from "../model-router/catalogue";
import { clineBridgeName, freeAvailability } from "./policy";

/** Bridge name + Cline provider id for a catalogue id (ids live in the catalogue only). */
const fleetModel=(id:string)=>({model:clineBridgeName(id),id:providerModelId(id)});

const root=new URL("../../",import.meta.url);
const flags=readFileSync(new URL("scripts/receptionist/flags.ts",root),"utf8");
const signals=readFileSync(new URL("scripts/receptionist/signals.ts",root),"utf8");
const aggregate=readFileSync(new URL("scripts/receptionist/aggregate.ts",root),"utf8");
const types=readFileSync(new URL("scripts/receptionist/types.ts",root),"utf8");
const legal=readFileSync("C:/Users/Nebula PC/source/repos/muv-flagship-legal-wt-design/assets/site.js","utf8");
const assignments=process.argv.includes("--business") ? [
 {...fleetModel("cline/deepseek-v4.1-flash"),topic:"economics actual source QA",source:readFileSync(new URL("src/lib/business-economics.ts",root),"utf8"),instruction:"Independent source review: examine GST, FX, margins, double counting, missing rates, billing increments, break-even and integer rounding. All inputs are synthetic. Report at most 4 concrete defects with reproduction, expected vs actual, or say no defect found. Under 500 words. No runtime claims or tools."},
 {...fleetModel("cline/mimo-v2.6-flash"),topic:"NAB synthetic adapter actual source QA",source:readFileSync(new URL("scripts/nab/service.ts",root),"utf8")+"\n"+readFileSync(new URL("scripts/nab/normalise.ts",root),"utf8"),instruction:"Independent source review of SYNTHETIC ONLY read-only adapter. No bank records or credentials present. Examine owner isolation, consent/revocation/expiry, idempotency, pending-to-posted transitions, money precision and partial failures. Report at most 4 concrete defects with reproductions, expected vs actual. No runtime claims/tools. Under 500 words."},
] : [
 {...fleetModel("cline/muse-spark-1.3"), topic:"receptionist source QA", source:flags+"\n"+signals+"\n"+types.slice(types.indexOf("export type FlagCode"),types.indexOf("export type CallRow"))+"\n"+aggregate.slice(aggregate.indexOf("const INCIDENT_FLAGS"),aggregate.indexOf("export const sydneyDay")), instruction:"Review false clean calls, 000 advice false positives/false negatives, danger parity and stale-cache behaviour. Provide at most 4 concrete reproducible SYNTHETIC cases with expected vs code behaviour. Do not claim tests ran. No real caller data exists here."},
 {...fleetModel("cline/deepseek-v4.1-flash"), topic:"legal film loader source QA", source:legal.slice(legal.indexOf("// One film")), instruction:"Review onload recursion, bounded frame window, resize/generation handling, duplicate image requests and poster fallback. At most 4 concrete findings with synthetic reproduction and expected behaviour. If no defect, say limits. No tools; do not claim runtime tests."},
];

if(import.meta.main) {
 const settled=await Promise.allSettled(assignments.map(async item=>{
  const fact=await freeAvailability(item.id);
  if(!fact.listedFree) throw new Error("Not verified free");
  const start=Date.now();
  const response=await fetch("http://127.0.0.1:8081/__cline/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","X-MU-Data-Class":"public"},signal:AbortSignal.timeout(320_000),body:JSON.stringify({model:item.model,messages:[{role:"user",content:item.instruction+"\nSOURCE ONLY:\n"+item.source}]})});
  const body=await response.json() as any;
  return {topic:item.topic,model:item.model,providerId:item.id,sourceSha256:createHash("sha256").update(item.source).digest("hex"),sourceChars:item.source.length,elapsedMs:Date.now()-start,status:response.status,usage:body.usage ?? null,receipt:body.fleet_receipt ?? null, routerReceipt:body.router_receipt ?? null,review:response.ok?body.choices?.[0]?.message?.content:null,error:response.ok?null:"Review failed; no fallback"};
 }));
 const results=settled.map((r,i)=>r.status==="fulfilled"?r.value:{model:assignments[i].model,topic:assignments[i].topic,error:"Transport failed; result and usage unknown; no automatic retry/fallback",review:null});
 writeFileSync(new URL(process.argv.includes("--business") ? "business-review-results.json" : "source-review-results.json",import.meta.url),JSON.stringify(results,null,2)+"\n");
 console.log(JSON.stringify(results.map(({review,...metadata})=>metadata)));
}

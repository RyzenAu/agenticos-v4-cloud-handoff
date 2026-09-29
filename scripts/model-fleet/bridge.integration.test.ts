import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { clineBridge } from "../cline-bridge";
import { freeAvailability, type Receipt } from "./policy";

const body=(model="mimo-v2.6-flash")=>({model,messages:[{role:"user",content:"Synthetic review"}]});
const result=(extra={})=>JSON.stringify({type:"run_result",finishReason:"completed",text:"Synthetic answer",model:{id:"cline-free/mimo-v2.6-flash",provider:"cline"},...extra});
const available=async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null});
async function fixture(deps:Parameters<typeof clineBridge>[0],work:(url:string)=>Promise<void>) {
 const bridge=clineBridge({availability:available,...deps});
 const server=createServer((req,res)=>void bridge.handle(req,res));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try {await work(`http://127.0.0.1:${(server.address() as any).port}`);}
 finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
// Every prompt here is synthetic, and says so (the bridge records the declared class).
const post=(url:string,value:unknown,signal?:AbortSignal)=>fetch(url+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","X-MU-Data-Class":"synthetic"},body:JSON.stringify(value),signal});

test("real HTTP handler refuses Pixel aliases and prototype keys, advertises uncertainty",async()=>{
 let runs=0;
 await fixture({run:async()=>{runs++;return result();}},async url=>{
  for(const id of ["pixel-canary","stealth/pixel-canary","PIXEL_CANARY"])
   expect((await post(url,body(id))).status).toBe(403);
  expect((await post(url,body("toString"))).status).toBe(400);
  const list=await (await fetch(url+"/v1/models")).json() as any;
  expect(list.data.map((r:any)=>r.id)).toContain("mimo-v2.6-flash");
  expect(list.data.every((r:any)=>r.remaining_quota===null && r.availability==="unverified_until_request")).toBe(true);
 }); expect(runs).toBe(0);
});
test("all three selected routes stay on cline and retain unknown usage",async()=>{
 const receipts:Receipt[]=[];
 await fixture({onReceipt:r=>receipts.push(r),run:async args=>{
  expect(args[args.indexOf("-P")+1]).toBe("cline");
  expect(args[args.indexOf("-m")+1]).toStartWith("cline-free/");return result({model:{id:args[args.indexOf("-m")+1],provider:"cline"}});
 }},async url=>{
  for(const id of ["mimo-v2.6-flash","deepseek-v4.1-flash","muse-spark-1.3"]){
   const response=await post(url,body(id)); expect(response.status).toBe(200);
   const output=await response.json() as any; expect(output.usage.total_tokens).toBeNull();expect(output.fleet_receipt.fallback).toBe("none");
  }
 }); expect(receipts.length).toBe(3);expect(receipts.every(r=>r.outcome==="succeeded")).toBe(true);
});
test("unverified or stale free listing prevents execution",async()=>{
 for(const fact of [{listedFree:false,checkedAt:Date.now()},{listedFree:true,checkedAt:0}]){
  let runs=0;
  await fixture({availability:async()=>({...fact,source:"synthetic",remainingQuota:null}),run:async()=>{runs++;return result();}},async url=>expect((await post(url,body())).status).toBe(503));
  expect(runs).toBe(0);
 }
});
test("real HTTP rejects tools and image content before dispatch",async()=>{
 let runs=0;
 await fixture({run:async()=>{runs++;return result();}},async url=>{
  expect((await post(url,{...body(),tools:[{name:"read"}]})).status).toBe(400);
  expect((await post(url,{...body(),messages:[{role:"user",content:[{type:"image_url",image_url:"synthetic"}]}]})).status).toBe(400);
 });expect(runs).toBe(0);
});
test("deadline aborts adapter and settles one timeout receipt despite a late reply",async()=>{
 let observed:AbortSignal|undefined;const receipts:Receipt[]=[];
 await fixture({timeoutMs:25,onReceipt:r=>receipts.push(r),run:async(_a,_c,_t,signal)=>{observed=signal;return new Promise(resolve=>setTimeout(()=>resolve(result()),70));}},async url=>{
  expect((await post(url,body())).status).toBe(504);
 });await Bun.sleep(80);expect(observed?.aborted).toBe(true);expect(receipts.map(r=>r.outcome)).toEqual(["timed_out"]);
});
test("HTTP client disconnect propagates cancellation and settles once",async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const receipts:Receipt[]=[];let observed:AbortSignal|undefined;
 await fixture({onReceipt:r=>receipts.push(r),run:async(_a,_c,_t,signal)=>{observed=signal;entered();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));}},async url=>{
  const controller=new AbortController();const response=post(url,body(),controller.signal).catch(()=>null);
  await started;controller.abort();await response;
  for(let i=0;i<30&&!receipts.length;i++) await Bun.sleep(5);
 });expect(observed?.aborted).toBe(true);expect(receipts.map(r=>r.outcome)).toEqual(["cancelled"]);
});
test("bounded queue rejects saturation and cancelled waiter never dispatches",async()=>{
 let runs=0;let release!:(value:string)=>void;
 const bridge=clineBridge({maxParallel:1,maxQueued:1,availability:available,run:async()=>{runs++;return new Promise(r=>release=r);}});
 const first=bridge.complete(body());while(!release)await Bun.sleep(1);
 const controller=new AbortController();const second=bridge.complete(body(),controller.signal).catch(error=>error);
 await expect(bridge.complete(body())).rejects.toThrow("queue full");controller.abort();expect((await second).message).toContain("Cancelled");
 release(result());await first;expect(runs).toBe(1);
});
test("provider errors and truncated or switched routes cannot become success or leak raw errors",async()=>{
 for(const run of [async()=>{throw new Error("SYNTHETIC_PRIVATE_MARKER");},async()=>result({finishReason:"aborted",text:"SYNTHETIC_PRIVATE_MARKER"}),async()=>result({model:{id:"paid/model",provider:"openrouter"}})]){
  await fixture({run},async url=>{const response=await post(url,body());expect(response.status).toBe(502);expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE_MARKER");});
 }
});
test("context clipping is explicit in usage receipt and bounded before runner",async()=>{
 const bridge=clineBridge({availability:available,run:async(args)=>{expect(args.at(-1)!.length).toBeLessThanOrEqual(26_000);return result();}});
 const output=await bridge.complete({...body(),messages:[{role:"user",content:"x".repeat(90_000)}]});
 expect(output.fleet_receipt.contextTrimmed).toBe(true);
});
test("public catalogue exact membership cannot infer entitlement from a free-looking ID",async()=>{
 const request=(async()=>Response.json({free:[{id:"cline-free/actual"}],recommended:[{id:"cline-free/not-free"}]})) as typeof fetch;
 const fact=await freeAvailability("cline-free/not-free",undefined,request);expect(fact.listedFree).toBe(false);expect(fact.remainingQuota).toBeNull();
});
test("failed completion retains provider-reported usage in its settlement",async()=>{
 const receipts:Receipt[]=[];
 const bridge=clineBridge({availability:available,onReceipt:r=>receipts.push(r),run:async()=>result({finishReason:"aborted",usage:{inputTokens:12,outputTokens:3,totalCost:0}})});
 await expect(bridge.complete(body())).rejects.toThrow("did not complete");
 expect(receipts[0].usage).toEqual({inputTokens:12,outputTokens:3,costUsd:0});
 expect(receipts[0].outcome).toBe("failed");
});

test("missing or mismatched provider identity cannot verify the requested route",async()=>{
 for(const model of [undefined,{id:"cline-free/mimo-v2.6-flash",provider:"other"},{id:"paid/model",provider:"cline"}]) {
  const receipts:Receipt[]=[];
  const bridge=clineBridge({availability:available,onReceipt:r=>receipts.push(r),run:async()=>result({model})});
  await expect(bridge.complete(body())).rejects.toThrow("route");
  expect(receipts[0].outcome).toBe("failed");expect(receipts[0].providerModel).toBeNull();
 }
});

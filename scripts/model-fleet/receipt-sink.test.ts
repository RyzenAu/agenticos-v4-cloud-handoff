import { expect,test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelFleetReceiptSink,modelFleetReceiptSink,modelFleetReceiptRoute } from "./receipt-sink";
import { createServer } from "node:http";
import { clineBridge } from "../cline-bridge";
import type { Receipt } from "./policy";
const receipt:Receipt={model:"mimo-v2.6-flash",provider:"cline",providerModel:"cline-free/mimo-v2.6-flash",
  outcome:"succeeded",elapsedMs:12,contextTrimmed:false,fallback:"none",usage:{inputTokens:null,outputTokens:null,costUsd:null}};
test("sink rejects fractional and unsafe token counts before persistence while accepting fractional cost",()=>{
  const sink=new ModelFleetReceiptSink(join(mkdtempSync(join(tmpdir(),"fleet-token-validation-")),"receipts.sqlite"));
  try {
    for(const key of ["inputTokens","outputTokens"] as const) {
      for(const value of [0.5,Number.MAX_SAFE_INTEGER+1,-1,Infinity,NaN]) {
        expect(()=>sink.append({...receipt,usage:{...receipt.usage,[key]:value}})).toThrow("Invalid fleet receipt metadata");
        expect(sink.list()).toHaveLength(0);
      }
    }
    for(const value of [null,0,Number.MAX_SAFE_INTEGER]) sink.append({...receipt,usage:{inputTokens:value,outputTokens:value,costUsd:0.000125}});
    const rows=sink.list() as any[];
    expect(rows.map(r=>r.inputTokens)).toEqual([Number.MAX_SAFE_INTEGER,0,null]);
    expect(rows.every(r=>r.costUsd===0.000125)).toBe(true);
    for(const costUsd of [-1,Infinity,NaN]) expect(()=>sink.append({...receipt,usage:{...receipt.usage,costUsd}})).toThrow();
  }finally{sink.close();}
});
test("real SQLite sink survives reopen, projects metadata and preserves unknown usage",()=>{
  const file=join(mkdtempSync(join(tmpdir(),"fleet-sink-")),"receipts.sqlite");
  let sink=new ModelFleetReceiptSink(file);
  sink.append({...receipt,prompt:"SYNTHETIC-PRIVATE",output:"SYNTHETIC-PRIVATE",error:"SYNTHETIC-PRIVATE"} as Receipt);
  sink.close();sink=new ModelFleetReceiptSink(file);
  try{const rows=sink.list() as any[];expect(rows).toHaveLength(1);expect(rows[0].costUsd).toBeNull();
    expect(rows[0].inputTokens).toBeNull();expect(JSON.stringify(rows)).not.toContain("SYNTHETIC-PRIVATE");
    expect(()=>sink.append({...receipt,model:"private text"})).toThrow();expect(sink.list()).toHaveLength(1);
  }finally{sink.close();}
});

test("receipt GET over real synthetic HTTP refuses unauthorised reads and exposes metadata",async()=>{
 const root=mkdtempSync(join(tmpdir(),"fleet-route-"));
 const input={path:"/model-fleet/receipts",method:"GET",url:new URL("http://localhost/model-fleet/receipts"),remote:false,authenticated:false};
 expect(modelFleetReceiptRoute(input,root)?.status).toBe(403);
 expect(existsSync(join(root,".operator-data"))).toBe(false);
 expect((modelFleetReceiptRoute({...input,authenticated:true},root)?.body as any).receipts).toEqual([]);
 expect(existsSync(join(root,".operator-data"))).toBe(false);
 expect(modelFleetReceiptRoute({...input,authenticated:true,remote:true},root)?.status).toBe(403);
 modelFleetReceiptSink(root)(receipt);
 const server=createServer((req,res)=>{
   const reply=modelFleetReceiptRoute({...input,method:req.method!,url:new URL(req.url!,"http://localhost"),authenticated:req.headers["x-claude-os-token"]==="synthetic"},root)!;
   res.statusCode=reply.status;res.setHeader("Content-Type","application/json");res.end(JSON.stringify(reply.body));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
   expect((await fetch(base)).status).toBe(403);
   const output=await (await fetch(base,{headers:{"X-Claude-OS-Token":"synthetic"}})).json() as any;
   expect(output.receipts).toHaveLength(1);expect(output.receipts[0].costUsd).toBeNull();expect(output.invoiceReconciled).toBe(false);
   expect((await fetch(base+"?limit=101",{headers:{"X-Claude-OS-Token":"synthetic"}})).status).toBe(400);
   expect((await fetch(base,{method:"POST",headers:{"X-Claude-OS-Token":"synthetic"}})).status).toBe(405);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test("real bridge settlement uses host hook once for success and refused identity",async()=>{
  const root=mkdtempSync(join(tmpdir(),"fleet-host-"));
  for(const model of [{id:receipt.providerModel,provider:"cline"},undefined]) {
    const bridge=clineBridge({availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
      onReceipt:modelFleetReceiptSink(root),run:async()=>JSON.stringify({type:"run_result",finishReason:"completed",text:"SYNTHETIC-OUTPUT",model})});
    await bridge.complete({model:receipt.model,messages:[{role:"user",content:"SYNTHETIC-PROMPT"}]}).catch(()=>{});
  }
  const sink=new ModelFleetReceiptSink(join(root,".operator-data","model-fleet","receipts.sqlite"));
  try{const rows=sink.list() as any[];expect(rows).toHaveLength(2);expect(rows.map(r=>r.outcome)).toEqual(["failed","succeeded"]);
    expect(JSON.stringify(rows)).not.toContain("SYNTHETIC-");}finally{sink.close();}
});

test("recorder failures are visible: sanitised counter in the authenticated GET, content-free log, never zero spend",async()=>{
  const {mkdirSync,writeFileSync}=await import("node:fs");
  const {recorderHealth}=await import("./receipt-sink");
  const root=mkdtempSync(join(tmpdir(),"fleet-recorder-failure-"));
  mkdirSync(join(root,".operator-data"));
  writeFileSync(join(root,".operator-data","model-fleet"),"not a directory"); // storage cannot open
  const input={path:"/model-fleet/receipts",method:"GET",url:new URL("http://localhost/model-fleet/receipts"),remote:false,authenticated:true};
  const clean=modelFleetReceiptRoute(input,root)!.body as any;
  expect(clean).toMatchObject({receipts:[],noRecorderFailuresSince:clean.since,recorder:{failures:0,lastFailureAt:null,lastFailureReason:null}});
  expect(Number.isFinite(Date.parse(clean.since))).toBe(true);
  expect(clean).not.toHaveProperty("accountingComplete"); // audit A-L3: never claims complete accounting
  const warnings:string[]=[];const warn=console.warn;
  console.warn=(...args:unknown[])=>{warnings.push(args.map(String).join(" "));};
  try {
    const bridge=clineBridge({availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
      onReceipt:modelFleetReceiptSink(root),run:async()=>JSON.stringify({type:"run_result",finishReason:"completed",text:"SYNTHETIC-OUTPUT",
        model:{id:receipt.providerModel,provider:"cline"},usage:{inputTokens:3,outputTokens:4,totalCost:0}})});
    // Telemetry failure must not change execution: the completed call still returns.
    const out:any=await bridge.complete({model:receipt.model,messages:[{role:"user",content:"SYNTHETIC-PROMPT"}]});
    expect(out.choices[0].message.content).toBe("SYNTHETIC-OUTPUT");
    expect(bridge.recorderHealth()).toMatchObject({failures:1,lastFailureReason:"storage_unavailable"});
    expect(typeof bridge.recorderHealth().lastFailureAt).toBe("number");
    const body=modelFleetReceiptRoute(input,root)!.body as any;
    expect(body.receipts).toEqual([]);
    expect(body.noRecorderFailuresSince).toBeNull();
    expect(body.spendIsLowerBound).toBe(true);
    expect(body.recorder).toMatchObject({failures:1,lastFailureReason:"storage_unavailable"});
    expect(typeof body.recorder.lastFailureAt).toBe("number");
    expect(Object.keys(body.recorder).sort()).toEqual(["failures","lastFailureAt","lastFailureReason","since"]);
    const text=JSON.stringify(body)+warnings.join("\n");
    for(const leak of ["SYNTHETIC-",root,"EEXIST","ENOTDIR","not a directory"]) expect(text).not.toContain(leak);
    expect(warnings.some(w=>w.includes("reason=storage_unavailable"))).toBe(true);
    expect(modelFleetReceiptRoute({...input,authenticated:false},root)!.body).not.toHaveProperty("recorder");
    // Invalid metadata and an arbitrary custom recorder each get their own reason code.
    const other=mkdtempSync(join(tmpdir(),"fleet-recorder-invalid-"));
    expect(()=>modelFleetReceiptSink(other)({...receipt,model:"SYNTHETIC-private"})).toThrow();
    expect(recorderHealth(other)).toMatchObject({failures:1,lastFailureReason:"invalid_metadata"});
    const custom=clineBridge({availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
      onReceipt:()=>{throw new Error("SYNTHETIC-SECRET recorder text");},run:async()=>{throw new Error("synthetic failure");}});
    await custom.complete({model:receipt.model,messages:[{role:"user",content:"SYNTHETIC-PROMPT"}]}).catch(()=>{});
    expect(custom.recorderHealth()).toMatchObject({failures:1,lastFailureReason:"recorder_exception"});
    expect(warnings.join("\n")).not.toContain("SYNTHETIC-");
  } finally { console.warn=warn; }
});

test("routed bridge calls still reach the fleet view, and readAllReceipts counts each call once",async()=>{
  const {readAllReceipts,routerReceiptSink}=await import("../model-router/receipts");
  const {EventEmitter}=await import("node:events");
  const root=mkdtempSync(join(tmpdir(),"fleet-dedupe-"));
  // A pre-E2 row (random id, no router receipt) stays counted as history.
  modelFleetReceiptSink(root)(receipt);
  const bridge=clineBridge({root,sink:routerReceiptSink(root),onReceipt:modelFleetReceiptSink(root),
    availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
    run:async()=>JSON.stringify({type:"run_result",finishReason:"completed",text:"SYNTHETIC-OUTPUT",model:{id:receipt.providerModel,provider:"cline"},usage:{inputTokens:3,outputTokens:4,totalCost:0}})});
  const req:any=Object.assign(new EventEmitter(),{method:"POST",url:"/v1/chat/completions",socket:{remoteAddress:"127.0.0.1"},
    headers:{"content-type":"application/json",host:"127.0.0.1:8081"},
    async *[Symbol.asyncIterator](){yield JSON.stringify({model:receipt.model,messages:[{role:"user",content:"SYNTHETIC-PROMPT"}]});}});
  const res:any={statusCode:0,body:"",setHeader(){},end(chunk=""){this.body+=chunk;}};
  await bridge.handle(req,res);
  expect(res.statusCode).toBe(200);
  const view=modelFleetReceiptRoute({path:"/model-fleet/receipts",method:"GET",url:new URL("http://localhost/model-fleet/receipts"),remote:false,authenticated:true},root)!.body as any;
  expect(view.receipts).toHaveLength(2); // the new call is in the Cline usage view, as before E2
  const all=readAllReceipts(root).filter(r=>r.provider==="cline");
  expect(all.map(r=>[r.legacy ?? "router",r.outcome])).toEqual([["fleet-sqlite","succeeded"],["router","succeeded"]]);
  expect(JSON.stringify(all)+JSON.stringify(view)).not.toContain("SYNTHETIC-");
});

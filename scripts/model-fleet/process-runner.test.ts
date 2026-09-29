import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRun } from "./process-runner";
import { clineBridge } from "../cline-bridge";
import { FleetError, type Receipt } from "./policy";
import { createServer } from "node:http";

const node=Bun.which("node")!;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check:()=>boolean) {
  const end=Date.now()+5000;
  while(!check()){if(Date.now()>end)throw new Error("Synthetic fixture deadline");await Bun.sleep(10);}
}
/** Windows can hold a just-killed tree's cwd briefly (EBUSY); cleanup is best-effort. */
async function removeTemp(dir:string) {
  for(let n=0;n<40;n++){try{rmSync(dir,{recursive:true,force:true});return;}catch{await Bun.sleep(50);}}
}
/* PID fixture protocol. The old fixture had every level rewrite one shared pids.json with
   writeFileSync (truncate, then write) while the other levels and the test polled it every
   10 ms. A reader could see an empty or partial file: in the test that surfaced as
   "JSON Parse error: Unexpected EOF"; inside a fixture process it was an uncaught
   "Unexpected end of JSON input" that killed that level, so the tree never completed and the
   test hit "Synthetic fixture deadline". Now each level publishes only its own PID to its own
   file, written to a temp name and renamed into place (a new name, so no replace-while-open
   on Windows). A reader only ever sees a complete file or no file. Level 0 publishes last,
   after its whole subtree has published. */
// Real process trees and the adapter's termination grace: measured up to 6.4 s under load
// against the old 10 s budgets; 20 s is 3x.
const REAL_TREE_TIMEOUT_MS=20_000;
for(const mode of ["abort","timeout","output","disconnect"] as const) {
  test(`real owned parent/child/grandchild termination: ${mode}`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),"cline-tree-")), file=join(dir,"pid"), script=join(dir,"tree.cjs");
    const published=(level:number)=>`${file}-${level}`;
    // Only PID metadata is written, never provider data or environment.
    writeFileSync(script,`const {spawn}=require('node:child_process');const fs=require('node:fs');
const [file,level,mode]=process.argv.slice(2);
const publish=()=>{fs.writeFileSync(file+'-'+level+'.tmp',String(process.pid));fs.renameSync(file+'-'+level+'.tmp',file+'-'+level);};
if(level==='2'){publish();setInterval(()=>{},1000);}
else {spawn(process.execPath,[__filename,file,String(Number(level)+1),mode],{stdio:'ignore',windowsHide:true,env:{}});
const t=setInterval(()=>{if(fs.existsSync(file+'-'+(Number(level)+1))){clearInterval(t);publish();if(level==='0'&&mode==='output')process.stdout.write('x'.repeat(2048));}},10);setInterval(()=>{},1000);}`);
    const controller=new AbortController();
    const receipts:Receipt[]=[];
    const runner=spawnRun(node,{outputLimit:1024});
    const bridge=clineBridge({availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
      onReceipt:r=>receipts.push(r),run:(_a,_c,t,s)=>runner([script,file,"0",mode],dir,t,s)});
    const server=mode==="disconnect"?createServer((req,res)=>void bridge.handle(req,res)):undefined;
    if(server)await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const completion=server?fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`,{
      method:"POST",headers:{"Content-Type":"application/json","X-MU-Data-Class":"synthetic"},signal:controller.signal,
      body:JSON.stringify({model:"mimo-v2.6-flash",messages:[{role:"user",content:"Synthetic"}]})}).catch(e=>e)
      :runner([script,file,"0",mode],dir,mode==="timeout"?1500:5000,controller.signal).catch(e=>e);
    let pids:number[]=[];
    try {
      await until(()=>existsSync(published(0)));
      pids=[0,1,2].map(level=>Number(readFileSync(published(level),"utf8")));
      expect(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0)).toBe(true);
      if(mode==="abort"||mode==="disconnect")controller.abort(new FleetError("Synthetic cancellation",499));
      const error=await completion;
      if(mode==="disconnect") {await until(()=>receipts.length===1);expect(receipts[0].outcome).toBe("cancelled");}
      else expect(error.status).toBe(mode==="abort"?499:mode==="timeout"?504:502);
      await until(()=>pids.every(pid=>!alive(pid)));
      expect(pids.every(pid=>!alive(pid))).toBe(true);
    } finally {
      controller.abort();await completion;
      if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
      await removeTemp(dir);
    }
  },REAL_TREE_TIMEOUT_MS);
}

test("active slot remains occupied until cancelled runner settles; late success refused",async()=>{
  let runs=0,settle!:(s:string)=>void;const receipts:Receipt[]=[];
  const bridge=clineBridge({maxParallel:1,availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
    onReceipt:r=>receipts.push(r),run:async()=>{runs++;return runs===1?new Promise(r=>settle=r):JSON.stringify({type:"run_result",finishReason:"completed",model:{id:"cline-free/mimo-v2.6-flash",provider:"cline"},text:"synthetic"});}});
  const body={model:"mimo-v2.6-flash",messages:[{role:"user",content:"Synthetic"}]};
  const controller=new AbortController();const first=bridge.complete(body,controller.signal).catch(e=>e);
  await until(()=>!!settle);const second=bridge.complete(body);controller.abort();await Bun.sleep(30);
  expect(runs).toBe(1);expect(receipts.length).toBe(0);
  settle("late synthetic reply");expect((await first).status).toBe(499);await second;
  expect(runs).toBe(2);expect(receipts.map(r=>r.outcome)).toEqual(["cancelled","succeeded"]);
});

test("unverified termination quarantines queued and subsequent dispatch",async()=>{
  let runs=0,release!:()=>void;
  const bridge=clineBridge({maxParallel:1,availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),run:async()=>{
    runs++;await new Promise<void>(r=>release=r);throw new FleetError("termination unverified",598);
  }});
  const body={model:"mimo-v2.6-flash",messages:[{role:"user",content:"Synthetic"}]};
  const first=bridge.complete(body).catch(e=>e);await until(()=>!!release);
  const second=bridge.complete(body).catch(e=>e);release();
  expect((await first).status).toBe(598);expect((await second).status).toBe(503);
  expect((await bridge.complete(body).catch(e=>e)).status).toBe(503);expect(runs).toBe(1);
});

test("signal-ignoring adapter gets an unverified receipt and quarantine after grace",async()=>{
  const receipts:Receipt[]=[];let entered=false;
  const bridge=clineBridge({availability:async()=>({listedFree:true,checkedAt:Date.now(),source:"synthetic",remainingQuota:null}),
    onReceipt:r=>receipts.push(r),run:async()=>{entered=true;return new Promise(()=>{});}});
  const body={model:"mimo-v2.6-flash",messages:[{role:"user",content:"Synthetic"}]};
  const controller=new AbortController();const first=bridge.complete(body,controller.signal).catch(e=>e);
  await until(()=>entered);controller.abort();expect((await first).status).toBe(598);
  expect(receipts[0].outcome).toBe("termination_unverified");
  expect((await bridge.complete(body).catch(e=>e)).status).toBe(503);
},REAL_TREE_TIMEOUT_MS);

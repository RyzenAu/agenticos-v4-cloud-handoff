import { spawn } from "node:child_process";
import { join } from "node:path";
import { FleetError } from "./policy";

/** Trusted executable only. Cline inherits its existing auth environment; stderr
 * is drained without retention. Stop never kills the parent before tree discovery.
 */
export function spawnRun(bin: string, options: { outputLimit?: number; graceMs?: number } = {}) {
  return (args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      if(signal.aborted) return reject(signal.reason);
      const child = spawn(bin,args,{cwd,windowsHide:true,shell:false,
        detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
      let out="", bytes=0, closed=false, treeStopped=false, settled=false;
      let reason: FleetError | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const cleanup=()=>{clearTimeout(timer);clearTimeout(grace);signal.removeEventListener("abort",abort);};
      const unverified=()=>{
        if(settled) return;
        settled=true; cleanup();
        reject(new FleetError("Cline termination unverified; bridge quarantined.",598));
      };
      const finish=(code:number|null)=>{
        if(settled || !closed || (reason && !treeStopped)) return;
        settled=true;cleanup();
        if(reason) reject(reason);
        else if(code===0 && out.trim()) resolve(out);
        else reject(new FleetError("Cline process did not complete successfully.",502));
      };
      let exitCode:number|null=null;
      const stop=(why:FleetError)=>{
        if(reason || settled) return;
        reason=why;
        grace=setTimeout(unverified,options.graceMs??5000);
        if(!child.pid) return; // spawn/error event decides; never target an unknown PID
        if(process.platform==="win32") {
          const killer=spawn(join(process.env.SystemRoot||"C:\\Windows","System32","taskkill.exe"),
            ["/pid",String(child.pid),"/t","/f"],{env:{},stdio:"ignore",windowsHide:true});
          killer.once("error",unverified);
          killer.once("close",code=>{if(code!==0) unverified();else {treeStopped=true;finish(exitCode);}});
        } else {
          try {process.kill(-child.pid,"SIGKILL");treeStopped=true;finish(exitCode);}
          catch {unverified();}
        }
      };
      const abort=()=>stop(signal.reason instanceof FleetError ? signal.reason : new FleetError("Cancelled; no fallback attempted.",499));
      const timer=setTimeout(()=>stop(new FleetError("Cline timed out; no fallback attempted.",504)),timeoutMs);
      signal.addEventListener("abort",abort,{once:true});
      child.stdout.on("data",chunk=>{
        if(reason) return;
        bytes+=chunk.length;
        if(bytes>(options.outputLimit??4*1024*1024)) stop(new FleetError("Cline output limit exceeded.",502));
        else out+=chunk;
      });
      child.stderr.on("data",()=>{});
      child.once("error",()=>{if(!settled){settled=true;cleanup();reject(new FleetError("Cline process failed.",502));}});
      child.once("close",code=>{closed=true;exitCode=code;finish(code);});
      child.once("spawn",()=>{if(signal.aborted) abort();});
      if(signal.aborted) abort();
    });
}

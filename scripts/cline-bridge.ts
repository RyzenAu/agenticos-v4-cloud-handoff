import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgePrompt } from "./claude-bridge";
import { spawnRun } from "./model-fleet/process-runner";
import { abortable, clineBridgeName, clineModels, excluded, finiteUsage, FleetError, freeAvailability, type Availability, type Receipt } from "./model-fleet/policy";
import { ReceiptRecorderFailure } from "./model-fleet/receipt-sink";
import { catalogueTask } from "./model-router/catalogue";
import { defaultReceiptSink } from "./model-router/defaults";
import type { HealthStore } from "./model-router/health";
import { fleetReceiptId, type ReceiptSink, type RouterReceipt } from "./model-router/receipts";
import { MaybeExecuted, ProviderError, RouteError, runRouted, type RouteChoice } from "./model-router/router";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Cline's free models, for Hermes. An OpenAI-compatible endpoint (`/v1/models`,
 * `/v1/chat/completions`) that runs the official Cline CLI headless under his own
 * Cline login. Hermes never sees Cline's credentials; it only sees text. Tools are
 * refused (auto-approve off in a non-interactive run), so this is text only: good for
 * drafts, summaries and Mixture-of-Agents references. Free models are promotional and
 * may train on prompts (the owner accepts that for his own data, 28 Sep).
 *
 * The HTTP path (`handle`) runs through the model router (task bridge.cline) and writes a router
 * receipt per attempt. Data use is not a routing concern (owner, 28 Sep), so nothing about the
 * request's data is read or refused. A model that refused before the
 * prompt ran may fall back to another Cline model; a prompt that may have run is never replayed. `complete()` is the raw
 * transport for in-process callers, which route through routedChat (and its receipts) themselves.
 */

/** Bridge name -> Cline provider id: the routable Cline models of task bridge.cline in the catalogue.
 *  Excluded models (Pixel Canary, the stealth Space Bunny) are absent here and refused by `excluded()`. */
export const CLINE_BRIDGE_MODELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries((() => {
  const t = catalogueTask("bridge.cline");
  const ids = [...(t?.candidates ?? []), ...(t?.selectable ?? [])];
  return clineModels().filter((m) => m.routable && ids.includes(m.id)).map((m) => [m.name, m.providerModel]);
})()));
type BridgeModel = string;

export const CLINE_TASK = "bridge.cline";
type Run = (args: string[], cwd: string, timeoutMs: number, signal: AbortSignal) => Promise<string>;
type Dependencies = { bin?: string | null; run?: Run; now?: () => number; maxParallel?: number; maxQueued?: number; timeoutMs?: number;
  availability?: (id:string, signal:AbortSignal)=>Promise<Availability>; onReceipt?: (receipt:Receipt)=>void;
  /** Router receipts and health for the HTTP path (default: the shared router files under `root`; in-memory under bun test). */
  root?: string; sink?: ReceiptSink; health?: HealthStore };

/** Validate a completion request before anything runs (tools, roles, size). Throws FleetError 400/413. */
function checkRequest(body: any) {
  if(body?.tools?.length || body?.functions?.length || body?.tool_choice || body?.function_call)
    throw new FleetError("This bridge supports text only; tools are unavailable.",400);
  if(!Array.isArray(body?.messages) || !body.messages.length || body.messages.length>100 || body.messages.some((m:any)=>
    !m || !["system","developer","user","assistant"].includes(m.role) || typeof m.content!=="string" || m.tool_calls))
    throw new FleetError("Use 1–100 text messages with supported roles.",400);
  if(Buffer.byteLength(JSON.stringify(body))>MAX_BODY) throw new FleetError("Request too large.",413);
  try { return bridgePrompt(body.messages); }
  catch { throw new FleetError("Invalid or oversized conversation.",400); }
}

/** A bridge failure as the router sees it. `sent: false` only when Cline never got the prompt. */
function providerError(error: FleetError): ProviderError {
  switch (error.status) {
    case 499: return new ProviderError("cancelled", "cancelled", { sent: "unknown" });
    case 504: return new ProviderError("timeout", "timed out", { sent: "unknown" });
    // Termination unverified: the prompt may still be running.
    case 598: return new ProviderError("timeout", "termination unverified", { sent: "unknown" });
    case 400: case 413: return new ProviderError("bad_request", "request refused", { httpStatus: error.status, sent: false });
    // Bridge-wide conditions (queue, quarantine, catalogue unreachable) are not this model's fault
    // (no health mark), and another model would hit the same condition, so the chain stops here
    // as it always did: `sent: "unknown"` with sideEffects makes the router stop, not fall back.
    case 429: return new ProviderError("transport", "bridge queue full", { sent: "unknown" });
    case 503: return /not freshly verified free/.test(error.message)
      ? new ProviderError("unavailable", "not verified free now", { sent: false })
      : new ProviderError("transport", "bridge unavailable", { sent: "unknown" });
    default: return new ProviderError("unknown", "Cline failed", { httpStatus: error.status, sent: "unknown" });
  }
}

const MAX_BODY = 4 * 1024 * 1024;
/** Windows caps a command line at 32,767 chars and this Cline build ignores piped stdin
    on Windows (it only accepts a FIFO or file), so the prompt rides as an argument. */
export const MAX_ARG = 26_000;
const SYSTEM =
  "You are a helpful expert answering in plain text. You have no tools; never try to use one. " +
  "Follow any instructions at the top of the user's message.";

export function defaultClineBin() {
  const candidates = [
    process.env.CLINE_BRIDGE_BIN,
    // The compiled binary, not the npm .cmd shim or node wrapper: shims can't be spawned.
    process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "cline", "node_modules", "@cline", "cli-windows-x64", "bin", "cline.exe"),
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Characters Windows argument quoting adds: a backslash per quote and per backslash, worst case. */
const argLength = (value: string) => value.length + (value.match(/["\\]/g)?.length ?? 0);

/** Fit system + transcript into one argument: trim the system prompt first, then the oldest turns. */
export function fitPrompt(system: string, prompt: string, budget = MAX_ARG) {
  const join2 = (head: string, body: string) => (head ? `Instructions:\n${head}\n\n---\n\n${body}` : body);
  let full = join2(system, prompt);
  if (argLength(full) <= budget) return full;
  let head = system;
  if (argLength(head) > budget / 3) {
    head = head.slice(0, Math.floor(budget / 3));
    while (argLength(head) > budget / 3) head = head.slice(0, Math.floor(head.length * 0.9));
    head += "\n[instructions trimmed]";
  }
  full = join2(head, prompt);
  if (argLength(full) <= budget) return full;
  const marker = "[earlier conversation trimmed]\n";
  let tail = prompt.slice(-(budget - argLength(join2(head, marker))));
  while (argLength(join2(head, marker + tail)) > budget) tail = tail.slice(Math.ceil(tail.length * 0.1));
  return join2(head, marker + tail);
}

/** The last `run_result` line of Cline's JSON-lines output. */
export function runResult(raw: string) {
  let result: any = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('"run_result"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "run_result") result = parsed;
    } catch {
      /* not a JSON line */
    }
  }
  return result;
}

/** Host headers a local caller (Hermes on this PC) sends. Anything else came through a proxy. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

export function clineBridge(dependencies: Dependencies = {}) {
  const bin = dependencies.bin === undefined ? defaultClineBin() : dependencies.bin;
  const run = dependencies.run ?? (bin ? spawnRun(bin) : null);
  const now = dependencies.now ?? Date.now;
  const maxParallel = Math.max(1, Math.min(2, dependencies.maxParallel ?? 2));
  const maxQueued = dependencies.maxQueued ?? 8;
  const timeoutMs = dependencies.timeoutMs ?? 5 * 60_000;
  const availability = dependencies.availability ?? freeAvailability;
  // An empty folder, so even a model that asks for tools has nothing to read.
  const cwd = join(tmpdir(), "agentic-os-cline-bridge");
  let active = 0;
  let quarantined = false;
  // Receipt recorder failures: reason codes and counts only, never prompt/output/error text.
  const recorder: { failures: number; lastFailureAt: number | null; lastFailureReason: string | null } =
    { failures: 0, lastFailureAt: null, lastFailureReason: null };
  const waiting: (() => void)[] = [];

  async function slot<T>(work: () => Promise<T>, signal:AbortSignal) {
    if (quarantined) throw new FleetError("Cline termination unverified; bridge quarantined.",503);
    if (signal.aborted) throw signal.reason;
    if (active >= maxParallel) {
      if(waiting.length >= maxQueued) throw new FleetError("Cline queue full; no fallback attempted.",429);
      await new Promise<void>((resolve,reject)=>{
        const enter=()=>{signal.removeEventListener("abort",stop); resolve();};
        const stop=()=>{const i=waiting.indexOf(enter); if(i>=0) waiting.splice(i,1); reject(signal.reason);};
        waiting.push(enter);
        signal.addEventListener("abort",stop,{once:true});
      });
    } else active++;
    try {
      if(quarantined) throw new FleetError("Cline termination unverified; bridge quarantined.",503);
      if(signal.aborted) throw signal.reason;
      return await work();
    } finally {
      const next=waiting.shift();
      if(next) next(); else active--;
    }
  }

  function knownModel(body: any): BridgeModel {
    const model = String(body?.model || "") as BridgeModel;
    if(excluded(model)) throw new FleetError("Model excluded by owner policy.",403);
    if (!Object.hasOwn(CLINE_BRIDGE_MODELS, model))
      throw Object.assign(new Error(`Unknown model. Use one of: ${Object.keys(CLINE_BRIDGE_MODELS).join(", ")}.`), { status: 400 });
    return model;
  }

  async function complete(body: any, callerSignal?:AbortSignal, rowId?:string) {
    const model = knownModel(body);
    if (!run) throw Object.assign(new Error("The Cline CLI is not installed (npm i -g cline)."), { status: 503 });
    const {system,prompt}=checkRequest(body);
    const controller=new AbortController();
    const cancel=()=>controller.abort(new FleetError("Cancelled; no fallback attempted.",499));
    callerSignal?.addEventListener("abort",cancel,{once:true});
    if(callerSignal?.aborted) cancel();
    const timer=setTimeout(()=>controller.abort(new FleetError("Cline timed out; no fallback attempted.",504)),timeoutMs);
    const signal=controller.signal;
    const started=now();
    const fitted=fitPrompt(system === "You are a helpful expert. Answer directly." ? "" : system,prompt);
    const receipt:Receipt={model,provider:"cline",providerModel:null,outcome:"failed",elapsedMs:0,
      contextTrimmed:fitted.includes("[earlier conversation trimmed]") || fitted.includes("[instructions trimmed]"),fallback:"none",
      usage:{inputTokens:null,outputTokens:null,costUsd:null},...(rowId ? {rowId} : {})};
    try {
    const args = [
      "--json",
      "-P", "cline",
      "-m", CLINE_BRIDGE_MODELS[model],
      // Non-interactive + auto-approve off = every tool call is refused.
      "--auto-approve", "false",
      "-t", String(Math.round(timeoutMs / 1000)),
      "-c", cwd,
      "-s", SYSTEM,
      fitted,
    ];
    mkdirSync(cwd, { recursive: true });
    const raw = await slot(async () => {
      const fact=await abortable(availability(CLINE_BRIDGE_MODELS[model],signal),signal);
      if(!fact.listedFree || now()-fact.checkedAt>60_000 || fact.checkedAt>now()+1000)
        throw new FleetError("Model is not freshly verified free; no fallback attempted.",503);
      // A runner must settle only after its child tree is closed. Never race it
      // against abort: that would release this slot while execution continues.
      try {
        const raw = await new Promise<string>((resolve,reject)=>{
          let grace: ReturnType<typeof setTimeout> | undefined;
          const abort=()=>{grace=setTimeout(()=>reject(new FleetError("Cline termination unverified; bridge quarantined.",598)),6000);};
          signal.addEventListener("abort",abort,{once:true});
          if(signal.aborted) abort();
          const cleanup=()=>{clearTimeout(grace);signal.removeEventListener("abort",abort);};
          Promise.resolve().then(()=>run(args,cwd,timeoutMs,signal)).then(
            value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
        });
        if(signal.aborted) throw signal.reason;
        return raw;
      } catch(error) {
        if(error instanceof FleetError && error.status===598) quarantined=true;
        throw error;
      }
    },signal);
    if(Buffer.byteLength(raw)>MAX_BODY) throw new FleetError("Cline output limit exceeded.",502);
    const result = runResult(raw);
    if (!result) throw Object.assign(new Error("Cline returned no result."), { status: 502 });
    const usage = result.usage || {};
    const baseInput=finiteUsage(usage.inputTokens), cache=finiteUsage(usage.cacheReadTokens);
    const input=baseInput===null ? null : baseInput+(cache ?? 0);
    const output=finiteUsage(usage.outputTokens);
    receipt.usage={inputTokens:input,outputTokens:output,costUsd:finiteUsage(usage.totalCost)};
    if (result.finishReason !== "completed" || typeof result.text !== "string" || !result.text.trim())
      throw new FleetError("Cline did not complete; no fallback attempted.",502);
    if(!result.model || result.model.id !== CLINE_BRIDGE_MODELS[model] || result.model.provider !== "cline")
      throw new FleetError("Provider returned a different route; result refused.",502);
    receipt.providerModel=result.model.id;
    if(receipt.usage.costUsd !== null && receipt.usage.costUsd>0) throw new FleetError("Unexpected nonzero provider cost; no fallback attempted.",502);
    receipt.outcome="succeeded";
    receipt.elapsedMs=now()-started;
    return {
      id: `chatcmpl-cline-${now()}`,
      object: "chat.completion",
      created: Math.floor(now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text.trim() }, finish_reason: "stop" }],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input===null || output===null ? null : input+output },
      fleet_receipt:receipt,
    };
    } catch(error) {
      const safe=error instanceof FleetError && error.status===598 ? error : signal.aborted ? signal.reason : error instanceof FleetError ? error : new FleetError("Cline failed; no fallback attempted.",502);
      receipt.outcome=safe.status===598 ? "termination_unverified" : safe.status===499 ? "cancelled" : safe.status===504 ? "timed_out" : "failed";
      throw safe;
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener("abort",cancel);
      receipt.elapsedMs=now()-started;
      // Telemetry must not change execution, but a lost receipt must never be silent.
      try { dependencies.onReceipt?.(receipt); } catch (error) {
        const reason = error instanceof ReceiptRecorderFailure ? error.reason : "recorder_exception";
        recorder.failures++; recorder.lastFailureAt = now(); recorder.lastFailureReason = reason;
        console.warn(`[cline-bridge] receipt recorder failure reason=${reason} failures=${recorder.failures}`);
      }
    }
  }

  const root = dependencies.root ?? ROOT;
  const sink = dependencies.sink ?? defaultReceiptSink(root);
  // No shared health by default: as before E2, every request tries the model it names (a model
  // another caller saw limited is not skipped). Tests and callers may pass a store.
  const health = dependencies.health;

  /**
   * One HTTP completion through the router (task bridge.cline): the requested model is selected
   * (the task's first candidate is the rule default), and every attempt writes a receipt. Throws FleetError (or a status-carrying Error) with the status to send.
   */
  async function routed(body: any, signal: AbortSignal) {
    const model = knownModel(body);
    // Same checks, same order and statuses as complete() always had.
    if (!run) throw Object.assign(new Error("The Cline CLI is not installed (npm i -g cline)."), { status: 503 });
    checkRequest(body);
    // Bridge-wide refusals before any model is chosen: nothing was attempted, so no receipt.
    if (quarantined) throw new FleetError("Cline termination unverified; bridge quarantined.",503);
    if (active >= maxParallel && waiting.length >= maxQueued) throw new FleetError("Cline queue full; no fallback attempted.",429);
    const id = `cline/${model}`;
    const first = catalogueTask(CLINE_TASK)?.candidates[0];
    let last: FleetError | null = null;
    let attempts = 0;
    const requestId = randomUUID();
    try {
      const result = await runRouted({
        task: CLINE_TASK,
        caller: "scripts/cline-bridge (/__cline)",
        requestId,
        sink,
        signal,
        // Never replay a prompt that may have run on another model (latency, and the bounded queue).
        sideEffects: true,
        constraints: { ...(id === first ? {} : { selected: id, selectedBy: "owner" as const }), providers: ["cline"], health },
        invoke: async (choice: RouteChoice, attemptSignal: AbortSignal) => {
          attempts++;
          try {
            // A fresh requestId: invoke call n is router attempt n. The fleet row gets the matching
            // id so readAllReceipts counts this call once (fleetReceiptId).
            const out = await complete({ ...body, model: clineBridgeName(choice.model) }, attemptSignal, fleetReceiptId(requestId, attempts));
            return {
              value: out,
              providerModel: out.fleet_receipt.providerModel,
              usage: { inputTokens: out.usage.prompt_tokens, outputTokens: out.usage.completion_tokens },
              costUsd: out.fleet_receipt.usage.costUsd,
            };
          } catch (error) {
            last = error instanceof FleetError ? error : new FleetError("Cline failed; no fallback attempted.", 502);
            throw providerError(last);
          }
        },
      });
      return { ...result.value, router_receipt: publicReceipt(result.receipt) };
    } catch (error) {
      const failed = last as FleetError | null;
      if (error instanceof RouteError) {
        const reasons = error.skipped.map((s) => s.why).join("; ");
        if (error.code === "refused_policy") throw new FleetError(`${model} is not a model for ${CLINE_TASK}.`, 403);
        if (failed) throw attempts > 1 ? new FleetError(`${attempts} Cline models tried, none answered (last: ${failed.message})`, failed.status) : failed;
        throw new FleetError(`No Cline model can take this now (${reasons.slice(0, 200) || error.code}).`, 503);
      }
      if (failed) throw failed;
      if (error instanceof MaybeExecuted || error instanceof ProviderError) throw new FleetError("Cline failed; no fallback attempted.", 502);
      throw error;
    }
  }

  function send(res: ServerResponse, status: number, value: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  }

  /** Mounted at /__cline. Loopback only, never from a browser page, never through the tailnet. */
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url || "/").split("?")[0].replace(/\/+$/, "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || ""))
      return send(res, 403, { error: { message: "Local access only" } });
    // Tailscale Serve proxies :8443 to loopback, so the socket alone proves nothing (audit A-L2):
    // refuse any tailnet identity header and any Host that is not this PC's own loopback name.
    if (Object.keys(req.headers).some((h) => h.toLowerCase().startsWith("tailscale-")) || !LOOPBACK_HOST.test(String(req.headers.host ?? "")))
      return send(res, 403, { error: { message: "Local access only" } });
    // Hermes sends neither header; any browser page does, so no website can drive his Cline login.
    if (req.headers.origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none"))
      return send(res, 403, { error: { message: "Not available to web pages" } });
    const controller=new AbortController();
    const disconnect=()=>{if(!res.writableEnded) controller.abort();};
    req.on("aborted",disconnect); res.on?.("close",disconnect);
    try {
      if (req.method === "GET" && path === "/v1/models")
        return send(res, 200, {
          object: "list",
          data: Object.keys(CLINE_BRIDGE_MODELS).map((id) => ({ id, object: "model", owned_by: "cline",
            availability:"unverified_until_request", remaining_quota:null, capabilities:["text"], context_argument_chars:MAX_ARG })),
        });
      if (req.method !== "POST" || path !== "/v1/chat/completions") return send(res, 404, { error: { message: "Not found" } });
      if (!String(req.headers["content-type"] || "").includes("application/json"))
        return send(res, 415, { error: { message: "Send JSON" } });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > MAX_BODY) return send(res, 413, { error: { message: "Request too large" } });
      }
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: { message: "Invalid JSON" } });
      }
      const completion = await routed(body ?? {}, controller.signal);
      if (!body?.stream) return send(res, 200, completion);
      // Cline answers in one piece; stream it as one chunk for clients that asked.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: completion.choices[0].message.content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: completion.usage, fleet_receipt:completion.fleet_receipt, router_receipt:completion.router_receipt })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      if (!res.headersSent && !res.destroyed) send(res, status, { error: { message: (error as Error).message } });
      else res.end();
    } finally {
      req.off("aborted",disconnect); res.off?.("close",disconnect);
    }
  }

  return { handle, complete, routed, recorderHealth: () => ({ ...recorder }) };
}

/** What the caller sees of its receipt: ids, the model that ran and how; never prompt or output. */
function publicReceipt(r: RouterReceipt) {
  return { requestId: r.requestId, attempt: r.attempt, task: r.task, model: r.model, providerModel: r.providerModel,
    route: r.route, selectedBy: r.selectedBy, fallbackFrom: r.fallbackFrom, costUsd: r.costUsd, costBasis: r.costBasis, outcome: r.outcome };
}

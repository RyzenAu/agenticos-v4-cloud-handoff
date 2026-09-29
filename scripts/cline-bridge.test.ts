import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { clineBridge as makeBridge, fitPrompt, MAX_ARG, runResult } from "./cline-bridge";

const clineBridge = (deps: Parameters<typeof makeBridge>[0] = {}) => makeBridge({ availability: async()=>({listedFree:true,checkedAt:deps.now?.() ?? Date.now(),source:"synthetic",remainingQuota:null}), ...deps });

type Call = { args: string[] };
const line = (value: unknown) => JSON.stringify(value);
const ok = [
  line({ type: "hook_event", hookEventName: "agent_start" }),
  line({ type: "agent_event", event: { type: "done", text: "Draft." } }),
  line({ type: "run_result", finishReason: "completed", model: {id:"cline-free/deepseek-v4.1-flash",provider:"cline"}, text: "\n\nDraft.", usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 7 } }),
].join("\n");
function fakeRun(output: string, calls: Call[] = []) {
  return async (args: string[]) => {
    calls.push({ args });
    return output;
  };
}

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, remote = "127.0.0.1") {
  const req: any = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: { "content-type": "application/json", host: "127.0.0.1:8081", "x-mu-data-class": "synthetic", ...headers },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  const res: any = {
    statusCode: 0,
    headersSent: false,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    write(chunk: string) { this.headersSent = true; this.body += chunk; },
    end(chunk = "") { this.headersSent = true; this.body += chunk; },
  };
  return { req, res };
}

describe("fitPrompt", () => {
  test("short prompts pass through, with any system prompt as leading instructions", () => {
    expect(fitPrompt("", "Hi")).toBe("Hi");
    expect(fitPrompt("Be brief.", "Hi")).toBe("Instructions:\nBe brief.\n\n---\n\nHi");
  });
  test("long prompts fit the Windows argument budget: system trimmed first, then the oldest turns", () => {
    const out = fitPrompt("S".repeat(40_000), "old ".repeat(10_000) + "LATEST QUESTION");
    expect(out.length).toBeLessThanOrEqual(MAX_ARG);
    expect(out).toContain("[instructions trimmed]");
    expect(out).toContain("[earlier conversation trimmed]");
    expect(out.endsWith("LATEST QUESTION")).toBe(true);
  });
  test("counts the escaping quotes and backslashes need", () => {
    const out = fitPrompt("", '"\\'.repeat(20_000));
    expect(out.length + (out.match(/["\\]/g)?.length ?? 0)).toBeLessThanOrEqual(MAX_ARG);
  });
});

describe("runResult", () => {
  test("takes the last run_result line and ignores noise", () => {
    expect(runResult(`not json\n${ok}\n`)?.text).toBe("\n\nDraft.");
    expect(runResult("nothing here")).toBeNull();
  });
});

describe("clineBridge", () => {
  test("runs Cline headless on the cline provider, tools refused, in an empty folder", async () => {
    const calls: Call[] = [];
    const bridge = clineBridge({ run: fakeRun(ok, calls), now: () => 1_000_000 });
    const out: any = await bridge.complete({ model: "deepseek-v4.1-flash", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Q" }] });
    expect(out.choices[0].message.content).toBe("Draft.");
    expect(out.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
    const { args } = calls[0];
    expect(args).toContain("--json");
    expect(args[args.indexOf("-P") + 1]).toBe("cline");
    expect(args[args.indexOf("-m") + 1]).toBe("cline-free/deepseek-v4.1-flash");
    expect(args[args.indexOf("--auto-approve") + 1]).toBe("false");
    expect(args[args.indexOf("-c") + 1]).toContain("agentic-os-cline-bridge");
    expect(args.at(-1)).toBe("Instructions:\nBe brief.\n\n---\n\nQ");
  });
  test("unknown models, a missing CLI and Cline errors are reported, never faked", async () => {
    const failed = line({ type: "run_result", finishReason: "error", text: "Unauthorized: re-authenticate your Cline account." });
    const bridge = clineBridge({ run: fakeRun(failed) });
    await expect(bridge.complete({ model: "gpt-6-sol", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow("Unknown model");
    await expect(bridge.complete({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow("did not complete");
    await expect(clineBridge({ bin: null }).complete({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "Q" }] })).rejects.toThrow("not installed");
  });
  test("lists models and answers chat completions over HTTP, streamed or not", async () => {
    const bridge = clineBridge({ run: fakeRun(ok) });
    let { req, res } = request("GET", "/v1/models");
    await bridge.handle(req, res);
    expect(JSON.parse(res.body).data.map((m: any) => m.id)).toContain("deepseek-v4.1-flash");
    ({ req, res } = request("POST", "/v1/chat/completions", { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "Q" }], stream: true }));
    await bridge.handle(req, res);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toContain('"content":"Draft."');
    expect(res.body.trim().endsWith("data: [DONE]")).toBe(true);
  });
  test("refuses other machines, browser pages and non-JSON posts", async () => {
    const bridge = clineBridge({ run: fakeRun(ok) });
    const body = { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "Q" }] };
    for (const [headers, remote, status] of [
      [{}, "192.168.1.20", 403],
      [{ origin: "https://evil.example" }, "127.0.0.1", 403],
      [{ "sec-fetch-site": "cross-site" }, "127.0.0.1", 403],
      [{ "content-type": "text/plain" }, "127.0.0.1", 415],
      // Audit A-L2: Tailscale Serve reaches loopback, so tailnet identity or a non-local Host is refused.
      [{ "tailscale-user-login": "someone@example.invalid" }, "127.0.0.1", 403],
      [{ host: "nebula-pc.tailnet.ts.net" }, "127.0.0.1", 403],
      [{ host: "nebula-pc.tailnet.ts.net:8443" }, "127.0.0.1", 403],
      [{ host: "" }, "127.0.0.1", 403],
    ] as const) {
      const { req, res } = request("POST", "/v1/chat/completions", body, headers as Record<string, string>, remote);
      await bridge.handle(req, res);
      expect(res.statusCode).toBe(status);
    }
  });
});

describe("clineBridge through the model router", () => {
  const { MemoryReceiptSink } = require("./model-router/receipts") as typeof import("./model-router/receipts");
  const { MemoryHealthStore } = require("./model-router/health") as typeof import("./model-router/health");
  const { catalogue, providerModelId } = require("./model-router/catalogue") as typeof import("./model-router/catalogue");
  const { route } = require("./model-router/router") as typeof import("./model-router/router");
  const reply = (providerModel: string) => line({ type: "run_result", finishReason: "completed", model: { id: providerModel, provider: "cline" }, text: "Draft.", usage: { inputTokens: 4, outputTokens: 2, totalCost: 0 } });
  const byModel = (runs: string[] = []) => async (args: string[]) => {
    const id = args[args.indexOf("-m") + 1];
    runs.push(id);
    return reply(id);
  };
  const post = async (bridge: ReturnType<typeof clineBridge>, body: unknown, headers: Record<string, string> = {}) => {
    const { req, res } = request("POST", "/v1/chat/completions", body, headers);
    await bridge.handle(req, res);
    return { status: res.statusCode, body: JSON.parse(res.body || "null") };
  };
  const q = (model: string) => ({ model, messages: [{ role: "user", content: "Q" }] });

  test("the bridge's models are task bridge.cline's catalogue models; excluded ones are refused", async () => {
    const { CLINE_BRIDGE_MODELS } = await import("./cline-bridge");
    const task = catalogue().tasks["bridge.cline"];
    expect(Object.values(CLINE_BRIDGE_MODELS).sort()).toEqual([...task.candidates, ...(task.selectable ?? [])].map(providerModelId).sort());
    expect(CLINE_BRIDGE_MODELS["muse-spark-1.3"]).toBe(providerModelId("cline/muse-spark-1.3"));
    const runs: string[] = [];
    const bridge = clineBridge({ run: byModel(runs), sink: new MemoryReceiptSink(), health: new MemoryHealthStore() });
    // Pixel Canary stays excluded; Space Bunny is served again, as before E2.
    for (const model of ["pixel-canary", "Pixel Canary"]) expect((await post(bridge, q(model))).status).toBe(403);
    const { req, res } = request("GET", "/v1/models");
    await bridge.handle(req, res);
    const listed = JSON.parse(res.body).data.map((m: any) => m.id);
    expect(listed).toContain("space-bunny-alpha");
    expect(listed).not.toContain("pixel-canary");
    expect(runs).toEqual([]);
  });

  // Owner, 28 Sep: data retention/training is not a constraint for his own data, so the bridge
  // never refuses on the data class. (Guarded: runs once the router's own data rule is gone.)
  const routerAllowsBusinessOnCline = (() => {
    try {
      route("bridge.cline", { dataClass: "private", hasKey: () => true, health: new MemoryHealthStore() });
      return true;
    } catch {
      return false;
    }
  })();
  test.skipIf(!routerAllowsBusinessOnCline)("no request is refused for what its data is (headers are ignored)", async () => {
    const runs: string[] = [];
    const sink = new MemoryReceiptSink();
    const bridge = clineBridge({ run: byModel(runs), sink, health: new MemoryHealthStore() });
    for (const headers of [{ "x-mu-data-class": "" }, { "x-mu-data-class": "business-internal" }, { "x-mu-data-class": "private" }, { "x-mu-data-class": "secret" }])
      expect((await post(bridge, q("deepseek-v4.1-flash"), headers)).status).toBe(200);
    expect(runs).toHaveLength(4);
    expect(sink.receipts.every((r) => r.outcome === "succeeded")).toBe(true);
  });

  test("a completion runs, with a free receipt naming the model and who chose it", async () => {
    const sink = new MemoryReceiptSink();
    const bridge = clineBridge({ run: byModel(), sink, health: new MemoryHealthStore() });
    let out = await post(bridge, q("deepseek-v4.1-flash"), { "x-mu-data-class": "public" });
    expect(out.status).toBe(200);
    expect(out.body.router_receipt).toMatchObject({ model: "cline/deepseek-v4.1-flash", route: "free", selectedBy: "rule", outcome: "succeeded" });
    out = await post(bridge, { ...q("mimo-v2.6-flash"), mu_data_class: "synthetic" }, { "x-mu-data-class": "" });
    expect(out.status).toBe(200);
    expect(sink.receipts.map((r) => [r.model, r.providerModel, r.route, r.selectedBy, r.costUsd, r.costBasis, r.outcome])).toEqual([
      // Cline reports its own cost ($0); E1: a provider-reported cost wins on every route.
      ["cline/deepseek-v4.1-flash", providerModelId("cline/deepseek-v4.1-flash"), "free", "rule", 0, "provider_reported", "succeeded"],
      ["cline/mimo-v2.6-flash", providerModelId("cline/mimo-v2.6-flash"), "free", "owner", 0, "provider_reported", "succeeded"],
    ]);
    expect(JSON.stringify(sink.receipts)).not.toContain("Draft.");
  });

  test("a model that refused before the prompt ran falls back to a free Cline model; a timeout is never replayed", async () => {
    const runs: string[] = [];
    const sink = new MemoryReceiptSink();
    const notFree = providerModelId("cline/gemini-3.8-flash");
    const bridge = clineBridge({ run: byModel(runs), sink, health: new MemoryHealthStore(),
      availability: async (id) => ({ listedFree: id !== notFree, checkedAt: Date.now(), source: "synthetic", remainingQuota: null }) });
    const out = await post(bridge, q("gemini-3.8-flash"));
    expect(out.status).toBe(200);
    expect(out.body.model).toBe("deepseek-v4.1-flash"); // the model that actually answered
    expect(runs).toEqual([providerModelId("cline/deepseek-v4.1-flash")]);
    expect(sink.receipts.map((r) => [r.model, r.outcome, r.fallbackFrom])).toEqual([
      ["cline/gemini-3.8-flash", "failed", null],
      ["cline/deepseek-v4.1-flash", "succeeded", "cline/gemini-3.8-flash"],
    ]);

    const slow = new MemoryReceiptSink();
    let calls = 0;
    const timing = clineBridge({ timeoutMs: 20, sink: slow, health: new MemoryHealthStore(),
      run: async (_args, _cwd, _t, signal) => { calls++; return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
    expect((await post(timing, q("deepseek-v4.1-flash"))).status).toBe(504);
    expect(calls).toBe(1);
    expect(slow.receipts.map((r) => [r.model, r.outcome])).toEqual([["cline/deepseek-v4.1-flash", "timed_out"]]);
  });
});

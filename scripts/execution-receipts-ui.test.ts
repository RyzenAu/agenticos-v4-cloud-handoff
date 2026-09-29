import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { catalogue } from "./model-router/catalogue";
import { fmtTime } from "../src/lib/format";

const source = readFileSync(new URL("../src/components/business/execution-receipts.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("execution-receipts.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && ["refresh", "validReceipts"].includes(node.name.text))
    declarations.set(node.name.text, node.getText(ast));
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && ["statuses", "uuid"].includes(d.name.text)))
    declarations.set(node.declarationList.declarations[0].name.getText(ast), node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of ["statuses", "uuid", "validReceipts", "refresh"]) {
  if (!declarations.has(name)) throw new Error(`Production ${name} declaration missing; update the source harness explicitly.`);
}
// Compile the actual production handler and validator. Only transport and React
// state setters are substituted; no copied implementation or network requests.
const compiled = ts.transpileModule([...declarations.values()].join("\n") + "\nreturn refresh;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const factory = new Function("busy", "active", "setBusy", "setMessage", "setRows", "setChecked", "fetch", "fmtTime", compiled); // fmtTime is the production formatter (src/lib/format.ts), injected because the handler is compiled standalone
const job = "11111111-1111-4111-8111-111111111111";
const previous = [{ id: job, status: "running", evidence: null, usageMicrousd: null }];

function harness(options: { cancel?: "accepted" | "conflict" | "unknown"; list?: "fail" | "invalid" } = {}) {
  const state = { busy: false, message: "", rows: previous as unknown, checked: "previous-check" };
  const messages: string[] = [];
  const requests: { url: string; method: string }[] = [];
  const request = async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? "GET" });
    if (url === "/__token") return { ok: true, json: async () => ({ token: "synthetic-only" }) };
    expect(init.headers).toEqual({ "X-Claude-OS-Token": "synthetic-only", "Content-Type": "application/json" });
    if (url === `/__operator/control/jobs/${job}/cancel`) {
      expect(init.method).toBe("POST"); expect(init.body).toBe("{}");
      if (options.cancel === "unknown") throw new Error("Synthetic POST transport failure");
      return { status: options.cancel === "conflict" ? 409 : 202 };
    }
    expect(url).toBe("/__operator/control/jobs?limit=50");
    expect(init.method ?? "GET").toBe("GET");
    if (options.cancel === "accepted") expect(state.message).toContain("Cancellation requested");
    if (options.cancel === "conflict") expect(state.message).toContain("no longer cancellable");
    if (options.list === "fail") throw new Error("Synthetic GET transport failure");
    return { ok: true, json: async () => ({ receipts: options.list === "invalid" ? [{ ...previous[0], status: "fabricated" }] : previous }) };
  };
  const refresh = factory(false, { current: null }, (v: boolean) => state.busy = v,
    (v: string) => { state.message = v; messages.push(v); }, (v: unknown) => state.rows = v,
    (v: string) => state.checked = v, request, fmtTime) as (cancelId?: string) => Promise<void>;
  return { state, requests, messages, refresh };
}

test("accepted cancellation acknowledgement survives failed receipt GET without claiming settlement", async () => {
  const h = harness({ cancel: "accepted", list: "fail" });
  await h.refresh(job);
  expect(h.state.message).toContain("Cancellation requested");
  expect(h.state.message).toContain("status refresh failed");
  expect(h.state.message).toContain("partial effects may remain");
  expect(h.state.rows).toBe(previous); expect(h.state.checked).toBe("previous-check");
  expect(h.state.busy).toBe(false);
  expect(h.requests.map(r => r.method)).toEqual(["GET", "POST", "GET"]);
  expect(h.messages.some(m => m === "Cancellation completed")).toBe(false);
});

test("unknown cancellation POST outcome requires status-only recovery and is never retried", async () => {
  const h = harness({ cancel: "unknown" });
  await h.refresh(job);
  expect(h.state.message).toContain("Cancellation outcome unknown");
  expect(h.state.message).toContain("Refresh status before trying Stop again");
  expect(h.state.message).toContain("No task has been resubmitted");
  expect(h.requests.map(r => r.method)).toEqual(["GET", "POST"]);
  expect(h.state.rows).toBe(previous); expect(h.state.busy).toBe(false);
});

test("simple refresh performs only metadata GETs and validates the actual receipt projection", async () => {
  const h = harness(); await h.refresh();
  expect(h.requests).toEqual([{ url: "/__token", method: "GET" }, { url: "/__operator/control/jobs?limit=50", method: "GET" }]);
  expect(h.state.rows).toEqual(previous); expect(h.state.message).toBe(""); expect(h.state.busy).toBe(false);
});

test("accepted cancellation also survives invalid receipt metadata", async () => {
  const h = harness({ cancel: "accepted", list: "invalid" }); await h.refresh(job);
  expect(h.state.message).toContain("Cancellation requested"); expect(h.state.message).toContain("status refresh failed");
  expect(h.state.rows).toBe(previous); expect(h.state.checked).toBe("previous-check");
});

test("noncancellable acknowledgement survives failed refresh", async () => {
  const h = harness({ cancel: "conflict", list: "fail" }); await h.refresh(job);
  expect(h.state.message).toContain("no longer cancellable"); expect(h.state.message).toContain("status refresh failed");
  expect(h.requests.filter(r => r.method === "POST")).toHaveLength(1);
});

const modelSource = readFileSync(new URL("../src/components/business/model-receipts.tsx", import.meta.url), "utf8");
const modelAst = ts.createSourceFile("model-receipts.tsx", modelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const modelDeclarations: string[] = [];
const found = new Set<string>();
function visitModels(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && ["projectRows", "refreshModels"].includes(node.name.text)) {
    found.add(node.name.text); modelDeclarations.push(node.getText(modelAst));
  }
  if (ts.isVariableStatement(node)) {
    const name = node.declarationList.declarations[0].name.getText(modelAst);
    if (["models", "outcomes", "usage", "tokenCount"].includes(name)) { found.add(name); modelDeclarations.push(node.getText(modelAst)); }
  }
  ts.forEachChild(node, visitModels);
}
visitModels(modelAst);
for (const name of ["models", "outcomes", "usage", "tokenCount", "projectRows", "refreshModels"]) if (!found.has(name)) throw new Error(`Production ${name} missing`);
const modelCompiled = ts.transpileModule(modelDeclarations.join("\n") + "\nreturn {projectRows, refreshModels};", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
// The component reads the Cline model list from the router catalogue (Stage E2): its one import is
// injected like the transport, the rest is the production code.
const modelFactoryWith = new Function("catalogue", "busy", "active", "setBusy", "setError", "setRows", "fetch", modelCompiled);
const modelFactory = (...args: unknown[]) => modelFactoryWith(catalogue, ...args);
const modelRow = { id: job, recordedAt: 1790467200000, provider: "cline", model: "deepseek-v4.1-flash", outcome: "failed", inputTokens: null, outputTokens: null, costUsd: null };

test("actual model projection requires canonical UUID and nullable safe token counts", () => {
  const h = modelFactory(false, { current: null }, () => {}, () => {}, () => {}, () => { throw Error("No requests allowed"); });
  for (const id of ["-".repeat(36), "a".repeat(36), "111111111-111-4111-8111-111111111111"])
    expect(() => h.projectRows([{ ...modelRow, id }])).toThrow();
  for (const key of ["inputTokens", "outputTokens"]) {
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, -1, Infinity, NaN])
      expect(() => h.projectRows([{ ...modelRow, [key]: value }])).toThrow();
    for (const value of [null, 0, Number.MAX_SAFE_INTEGER])
      expect(h.projectRows([{ ...modelRow, [key]: value }])[0][key]).toBe(value);
  }
  expect(h.projectRows([{ ...modelRow, id: job.toUpperCase(), costUsd: 0.000125 }])[0].costUsd).toBe(0.000125);
});

test("actual model refresh uses authenticated GETs only, preserves unknown usage and drops prompt fields", async () => {
  let rows: any, error = "", busy = false;
  const requests: string[] = [];
  const h = modelFactory(false, { current: null }, (v: boolean) => busy = v, (v: string) => error = v, (v: unknown) => rows = v,
    async (url: string, init: RequestInit = {}) => {
      requests.push(url); expect(init.method ?? "GET").toBe("GET"); expect(init.body).toBeUndefined();
      if (url === "/__token") return { ok: true, json: async () => ({ token: "synthetic-only" }) };
      expect(url).toBe("/__operator/model-fleet/receipts?limit=50");
      expect(init.headers).toEqual({ "X-Claude-OS-Token": "synthetic-only" });
      return { ok: true, json: async () => ({ receipts: [{ ...modelRow, prompt: "SYNTHETIC-DO-NOT-DISPLAY", response: "SYNTHETIC-OUTPUT" }] }) };
    });
  await h.refreshModels();
  expect(requests).toHaveLength(2); expect(busy).toBe(false); expect(error).toBe("");
  expect(rows[0].inputTokens).toBeNull(); expect(rows[0].outputTokens).toBeNull(); expect(rows[0].costUsd).toBeNull();
  expect(rows[0]).not.toHaveProperty("prompt"); expect(rows[0]).not.toHaveProperty("response");
  for (const patch of [{ model: "SYNTHETIC-PROMPT" }, { outcome: "SYNTHETIC-PROMPT" }, { provider: "arbitrary" }, { costUsd: -1 }, { outputTokens: Infinity }])
    expect(() => h.projectRows([{ ...modelRow, ...patch }])).toThrow("Invalid model receipts");
});

test("actual model refresh failure preserves previous metadata and never starts a model call", async () => {
  let rows: unknown = [modelRow], error = "", busy = false; const before = rows; const requests: string[] = [];
  const h = modelFactory(false, { current: null }, (v: boolean) => busy = v, (v: string) => error = v, (v: unknown) => rows = v,
    async (url: string, init: RequestInit = {}) => {
      requests.push(url); expect(init.method ?? "GET").toBe("GET");
      if (url === "/__token") return { ok: true, json: async () => ({ token: "synthetic-only" }) };
      throw new Error("Synthetic failure containing content that must not be displayed");
    });
  await h.refreshModels();
  expect(rows).toBe(before); expect(busy).toBe(false); expect(error).toContain("Previous rows may be stale");
  expect(error).toContain("no model call was started"); expect(error).not.toContain("containing content");
  expect(requests).toEqual(["/__token", "/__operator/model-fleet/receipts?limit=50"]);
});

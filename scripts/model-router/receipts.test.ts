import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRouterRoute } from "./api";
import { httpProviderError, openAiCompatibleChat } from "./clients";
import { FileHealthStore, MemoryHealthStore } from "./health";
import { probeCatalogue } from "./probe";
import {
  JsonlReceiptSink,
  legacyMimoReceipts,
  meteredSpendByProvider,
  mimoLedgerFile,
  readAllReceipts,
  receiptsFile,
  summariseReceipts,
  type RouterReceipt,
} from "./receipts";
import { route, runRouted } from "./router";

const roots: string[] = [];
const tempRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "router-test-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const receipt = (over: Partial<RouterReceipt> = {}): RouterReceipt => ({
  schema: "mu.router-receipt/v1",
  requestId: "r1",
  attempt: 1,
  parentRequestId: null,
  task: "bulk.text",
  caller: "test",
  provider: "groq",
  model: "groq/gpt-oss-120b",
  providerModel: "openai/gpt-oss-120b",
  route: "free",
  selectedBy: "rule",
  reason: "first",
  fallbackFrom: null,
  inputTokens: 1,
  outputTokens: 2,
  characters: null,
  audioSeconds: null,
  costUsd: 0,
  costBasis: "free",
  priceAsOf: null,
  allowance: null,
  latencyMs: 5,
  outcome: "succeeded",
  errorCode: null,
  httpStatus: null,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  ...over,
});

test("JSONL sink persists only projected metadata and answers forRequest", () => {
  const root = tempRoot();
  const sink = new JsonlReceiptSink(receiptsFile(root));
  sink.write({
    ...receipt(),
    prompt: "SYNTHETIC-SECRET-PROMPT",
    output: "SYNTHETIC-OUTPUT",
  } as any);
  sink.write(receipt({ requestId: "r2", fallbackFrom: "claude/haiku-4-5" }));
  const text = readFileSync(receiptsFile(root), "utf8");
  expect(text).not.toContain("SYNTHETIC");
  expect(sink.forRequest("r2")).toHaveLength(1);
  expect(sink.forRequest("r2")[0].fallbackFrom).toBe("claude/haiku-4-5");
  expect(() => sink.write(receipt({ outcome: "weird" as any }))).toThrow();
});

test("the MiMo ledger (repo path) and Cline fleet receipts reconcile into the one receipt shape", () => {
  const root = tempRoot();
  mkdirSync(join(root, ".operator-data", "mimo"), { recursive: true });
  const ts = Date.now() - 1000;
  writeFileSync(
    mimoLedgerFile(root),
    `${JSON.stringify({ ts, model: "xiaomi/mimo-v2.6-flash", task: "receptionist-summary", inputTokens: 100, outputTokens: 10, costUsd: 0.0000168, ms: 900 })}\nnot json\n`,
  );
  mkdirSync(join(root, ".operator-data", "model-fleet"), { recursive: true });
  const db = new Database(join(root, ".operator-data", "model-fleet", "receipts.sqlite"), {
    create: true,
  });
  db.exec(`CREATE TABLE receipts (id TEXT PRIMARY KEY, recordedAt INTEGER NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, providerModel TEXT, outcome TEXT NOT NULL,
    elapsedMs REAL NOT NULL, contextTrimmed INTEGER NOT NULL, fallback TEXT NOT NULL, inputTokens REAL, outputTokens REAL, costUsd REAL)`);
  db.query("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "a",
    Date.now(),
    "deepseek-v4.1-flash",
    "cline",
    "cline-free/deepseek-v4.1-flash",
    "succeeded",
    5000,
    0,
    "none",
    10,
    20,
    0,
  );
  db.close();
  new JsonlReceiptSink(receiptsFile(root)).write(
    receipt({
      provider: "openrouter",
      model: "openrouter/mimo-v2.6-flash",
      route: "metered",
      costUsd: 0.01,
      costBasis: "catalogue_price",
      caller: "scripts/llm/mimo (care-plan-email)",
    }),
  );

  const legacy = legacyMimoReceipts(mimoLedgerFile(root));
  expect(legacy).toHaveLength(1);
  expect(legacy[0]).toMatchObject({
    model: "openrouter/mimo-v2.6-flash",
    route: "metered",
    costUsd: 0.0000168,
    legacy: "mimo-ledger",
  });

  const all = readAllReceipts(root);
  expect(all.map((r) => r.legacy ?? "router").sort()).toEqual([
    "fleet-sqlite",
    "mimo-ledger",
    "router",
  ]);
  const usage = summariseReceipts(all);
  expect(usage["openrouter/mimo-v2.6-flash"]).toMatchObject({ calls: 2, succeeded: 2 });
  expect(usage["cline/deepseek-v4.1-flash"]).toMatchObject({ calls: 1, costUsd: 0 });
  const metered = meteredSpendByProvider(all);
  expect(metered.openrouter.calls).toBe(2);
  expect(metered.openrouter.byTask).toMatchObject({
    "receptionist-summary": 1,
    "care-plan-email": 1,
  });
});

test("unknown cost is counted as unknown, never as zero", () => {
  const u = summariseReceipts([
    receipt({
      route: "metered",
      provider: "openrouter",
      model: "openrouter/mimo-v2.6-flash",
      costUsd: null,
      costBasis: "unknown",
    }),
    receipt({ outcome: "rate_limited", errorCode: "rate_limited", httpStatus: 429 }),
  ]);
  expect(u["openrouter/mimo-v2.6-flash"]).toMatchObject({ unknownCostCalls: 1, costUsd: 0 });
  expect(u["groq/gpt-oss-120b"].lastFailure).toMatchObject({
    errorCode: "rate_limited",
    httpStatus: 429,
  });
});

test("HTTP failures classify into limits the router can fall back from, without body text", () => {
  expect(httpProviderError(429, "Rate limit reached. Please try again in 7.5s").opts).toMatchObject(
    { sent: false, retryAfterMs: 7500 },
  );
  expect(httpProviderError(429, "tokens per day (TPD) limit").code).toBe("quota_exhausted");
  expect(httpProviderError(402, "SYNTHETIC-BODY").code).toBe("insufficient_funds");
  expect(httpProviderError(402, "SYNTHETIC-BODY").message).not.toContain("SYNTHETIC");
  expect(httpProviderError(403, "Key limit exceeded; buy credits").code).toBe("insufficient_funds");
  expect(httpProviderError(401, "").code).toBe("auth");
  expect(httpProviderError(404, "").code).toBe("not_found");
  expect(httpProviderError(503, "").opts.sent).toBe("unknown");
  expect(httpProviderError(400, "").code).toBe("bad_request");
});

test("an OpenRouter :free model is sent with max_price 0 and the key never reaches an error", async () => {
  const bodies: any[] = [];
  const request = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: "SYNTHETIC" }), { status: 429 });
  }) as unknown as typeof fetch;
  const choice = route("bulk.text", {
    hasKey: () => true,
    dataClass: "public",
    providers: ["openrouter"],
  });
  expect(choice.model).toBe("openrouter-free/nemotron-3-super-120b");
  const env = { OPENROUTER_API_KEY: "SYNTHETIC-KEY-VALUE" } as NodeJS.ProcessEnv;
  let message = "";
  try {
    await openAiCompatibleChat(
      choice,
      { root: tempRoot(), env, request, messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );
  } catch (e) {
    message = (e as Error).message;
  }
  expect(bodies[0]).toMatchObject({
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    provider: { max_price: { prompt: 0, completion: 0 } },
  });
  expect(message).not.toContain("SYNTHETIC");
});

test("probes read list endpoints only, mark unlisted and price drift, and respect the interval", async () => {
  const root = tempRoot();
  const health = new MemoryHealthStore();
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    if (url.includes("cline.bot"))
      return Response.json({
        free: [{ id: "cline-free/deepseek-v4.1-flash" }, { id: "cline-free/gemini-3.8-flash" }],
      });
    if (url.includes("openrouter.ai"))
      return Response.json({
        data: [
          { id: "qwen/qwen3.8-27b:free", pricing: { prompt: "0.0000001", completion: "0" } },
          {
            id: "google/gemma-4-31b-it:free",
            pricing: { prompt: "0", completion: "0", request: "0.001" },
          },
          {
            id: "nvidia/nemotron-3-super-120b-a12b:free",
            pricing: { prompt: "0", completion: "0", image: "0", discount: 0 },
          },
          {
            id: "xiaomi/mimo-v2.6-flash",
            pricing: { prompt: "0.0000002", completion: "0.00000028" },
          },
        ],
      });
    if (url.includes("groq.com")) return Response.json({ data: [{ id: "openai/gpt-oss-120b" }] });
    if (url.includes("googleapis")) return new Response("{}", { status: 500 });
    if (url.includes("8642")) return new Response("ok");
    throw new Error("unexpected");
  }) as unknown as typeof fetch;
  let t = Date.parse("2026-09-28T00:00:00Z");
  const out = await probeCatalogue({ root, request, health, key: () => "SYNTHETIC", now: () => t });
  expect(
    urls.every((u) =>
      /recommended-models|api\/v1\/models$|openai\/v1\/models$|v1beta\/models\?|\/health$/.test(u),
    ),
  ).toBe(true);
  expect(urls.some((u) => /completions|generateContent|chat/.test(u))).toBe(false);
  expect(health.model("cline/mimo-v2.6-flash").state).toBe("unlisted");
  expect(health.model("cline/deepseek-v4.1-flash").state).toBe("ok");
  expect(health.model("openrouter-free/qwen3.8-27b")).toMatchObject({
    state: "unlisted",
    detail: "no longer listed at $0",
  });
  expect(health.model("openrouter/mimo-v2.6-flash").detail).toMatch(/price now \$0\.2\/\$0\.28/);
  expect(health.model("openrouter-free/gemma-4-31b-it").state).toBe("unlisted"); // a per-request charge isn't free
  expect(health.model("openrouter-free/nemotron-3-super-120b").state).toBe("ok");
  expect(health.model("groq/gpt-oss-20b").state).toBe("unlisted");
  expect(out.find((o) => o.provider === "gemini")).toMatchObject({ ok: false });
  expect(health.provider("gemini").failure?.detail).toBe("HTTP 500");
  // An unlisted free model is no longer routed.
  expect(route("screen.plan", { hasKey: () => true, health }).model).toBe("groq/gpt-oss-120b");
  expect(() =>
    route("screen.plan", { hasKey: () => true, health, exclude: ["groq/gpt-oss-120b"] }),
  ).toThrow(/no longer listed|absent/);

  const before = urls.length;
  t += 10 * 60_000;
  const again = await probeCatalogue({
    root,
    request,
    health,
    key: () => "SYNTHETIC",
    now: () => t,
  });
  expect(urls.length).toBe(before);
  expect(again.every((o) => o.skipped)).toBe(true);
});

test("health persists to a file and a real call's limit is visible to the next route", async () => {
  const root = tempRoot();
  const file = join(root, "health.json");
  const health = new FileHealthStore(file);
  const sink = new JsonlReceiptSink(receiptsFile(root));
  const { ProviderError } = await import("./router");
  await runRouted({
    task: "screen.plan",
    caller: "t",
    sink,
    constraints: { hasKey: () => true, health },
    invoke: async (c) => {
      if (c.model === "groq/gpt-oss-120b")
        throw new ProviderError("quota_exhausted", "429", {
          httpStatus: 429,
          sent: false,
          retryAfterMs: 3_600_000,
        });
      return { value: "ok" };
    },
  });
  const reread = new FileHealthStore(file);
  expect(reread.model("groq/gpt-oss-120b").state).toBe("limited");
  // Several writes from one store all persist (each write re-reads the file first).
  reread.markModel("groq/gpt-oss-20b", { state: "ok" });
  reread.markProvider("groq", {
    failure: { at: new Date().toISOString(), errorCode: "probe_failed", detail: "x" },
  });
  reread.markModel("cline/muse-spark-1.3", { state: "unlisted", detail: "absent" });
  const third = new FileHealthStore(file).snapshot();
  expect(Object.keys(third.models).sort()).toEqual([
    "cline/muse-spark-1.3",
    "groq/gpt-oss-120b",
    "groq/gpt-oss-20b",
  ]);
  expect(third.providers.groq.failure?.errorCode).toBe("probe_failed");
  expect(route("screen.plan", { hasKey: () => true, health: reread })).toMatchObject({
    model: "groq/gpt-oss-20b",
    fallbackFrom: "groq/gpt-oss-120b",
  });
});

test("the Models endpoint needs sign-in and returns catalogue, health and receipt totals only", async () => {
  const root = tempRoot();
  new JsonlReceiptSink(receiptsFile(root)).write(receipt());
  expect(
    (
      await modelRouterRoute(
        { path: "/model-router", method: "GET", remote: false, authenticated: false },
        root,
      )
    )?.status,
  ).toBe(403);
  expect(
    await modelRouterRoute(
      { path: "/other", method: "GET", remote: false, authenticated: true },
      root,
    ),
  ).toBeNull();
  const ok = await modelRouterRoute(
    { path: "/model-router", method: "GET", remote: false, authenticated: true },
    root,
  );
  const body = ok!.body as any;
  expect(ok!.status).toBe(200);
  expect(body.catalogue.models.length).toBeGreaterThan(30);
  expect(body.usage["groq/gpt-oss-120b"].calls).toBe(1);
  expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC|Bearer/);
  const remote = await modelRouterRoute(
    { path: "/model-router", method: "GET", remote: true, authenticated: false },
    root,
  );
  expect(remote!.status).toBe(200);
  const probed = await modelRouterRoute(
    { path: "/model-router/probe", method: "POST", remote: false, authenticated: true },
    root,
    { probe: async () => [] },
  );
  expect((probed!.body as any).probes).toEqual([]);
  expect(
    (
      await modelRouterRoute(
        { path: "/model-router/probe", method: "GET", remote: false, authenticated: true },
        root,
      )
    )?.status,
  ).toBe(405);
});

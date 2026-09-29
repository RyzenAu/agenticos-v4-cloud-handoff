import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { callMimo, MIMO_MODELS, MIMO_PRICES, mimoBulkEnabled, summarizeMimoLedger } from "./mimo";

const root = mkdtempSync(join(tmpdir(), "mimo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, ".env.local"), "OPENROUTER_API_KEY=fixture-key\n");
// Isolated home/env so this never reads the real ~/.config/agentic-os.env key.
const fixtureHome = mkdtempSync(join(tmpdir(), "mimo-home-"));
afterAll(() => rmSync(fixtureHome, { recursive: true, force: true }));

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String((init as RequestInit).body));
  expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer fixture-key");
  return new Response(
    JSON.stringify({
      model: body.model,
      choices: [{ message: { content: "summary text" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200 },
  );
}) as typeof fetch;

test("callMimo runs through the router: priced from usage, one receipt, MiMo selected by the owner", async () => {
  const now = Date.UTC(2026, 8, 25, 0, 0, 0);
  const sink = new MemoryReceiptSink();
  const result = await callMimo({
    model: MIMO_MODELS.flash,
    messages: [{ role: "user", content: "summarise this lead" }],
    task: "lead-summary",
    root,
    request: fakeFetch,
    now: () => now,
    sink,
    health: new MemoryHealthStore(),
    home: fixtureHome,
    env: {},
  });
  expect(result.text).toBe("summary text");
  // 1000 * 0.14/1e6 + 500 * 0.28/1e6 (catalogue price; the fake reports no usage.cost)
  expect(result.costUsd).toBeCloseTo(0.00028, 8);
  expect(result.fallbackFrom).toBeNull();
  expect(sink.receipts).toHaveLength(1);
  expect(sink.receipts[0]).toMatchObject({
    model: "openrouter/mimo-v2.6-flash",
    route: "metered",
    selectedBy: "owner",
    costBasis: "catalogue_price",
    caller: "scripts/llm/mimo (lead-summary)",
    outcome: "succeeded",
  });
  expect(MIMO_PRICES[MIMO_MODELS.flash]).toEqual({ input: 0.14, output: 0.28 });
});

test("when MiMo is out of credit it falls back automatically to a free model and records fallbackFrom", async () => {
  const sink = new MemoryReceiptSink();
  const urls: string[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    if (String(input).includes("openrouter.ai")) return new Response(JSON.stringify({ error: { message: "SYNTHETIC insufficient credits" } }), { status: 402 });
    const body = JSON.parse(String(init!.body));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: "free text" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }), { status: 200 });
  }) as typeof fetch;
  const result = await callMimo({
    messages: [{ role: "user", content: "x" }],
    task: "care-plan-email",
    root,
    request,
    sink,
    health: new MemoryHealthStore(),
    home: fixtureHome,
    env: { GROQ_API_KEY: "fixture-groq" },
  });
  expect(result).toMatchObject({ text: "free text", model: "openai/gpt-oss-120b", costUsd: 0, fallbackFrom: "openrouter/mimo-v2.6-flash" });
  expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions", "https://api.groq.com/openai/v1/chat/completions"]);
  expect(sink.receipts.map((r) => [r.model, r.outcome, r.errorCode, r.fallbackFrom])).toEqual([
    ["openrouter/mimo-v2.6-flash", "rate_limited", "insufficient_funds", null],
    ["groq/gpt-oss-120b", "succeeded", null, "openrouter/mimo-v2.6-flash"],
  ]);
});

test("the legacy MiMo ledger is still summarised (read-only)", () => {
  const ledgerFile = join(root, "ledger.jsonl");
  writeFileSync(ledgerFile, `${JSON.stringify({ ts: Date.UTC(2026, 8, 25), model: MIMO_MODELS.flash, task: "lead-summary", inputTokens: 1000, outputTokens: 500, costUsd: 0.00028, ms: 5 })}
`);
  const summary = summarizeMimoLedger(ledgerFile, new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 9, 1)));
  expect(summary?.calls).toBe(1);
  expect(summary?.byTask["lead-summary"].calls).toBe(1);
  expect(readFileSync(ledgerFile, "utf8")).toContain("lead-summary");
});

test("callMimo throws without an OpenRouter key instead of silently skipping", async () => {
  const bareRoot = mkdtempSync(join(tmpdir(), "mimo-bare-"));
  try {
    const bareHome = mkdtempSync(join(tmpdir(), "mimo-bare-home-"));
    await expect(
      callMimo({ messages: [{ role: "user", content: "x" }], task: "t", root: bareRoot, home: bareHome, env: {}, request: fakeFetch }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    rmSync(bareHome, { recursive: true, force: true });
  } finally {
    rmSync(bareRoot, { recursive: true, force: true });
  }
});

test("mimoBulkEnabled only fires on MIMO_BULK=1", () => {
  expect(mimoBulkEnabled({})).toBe(false);
  expect(mimoBulkEnabled({ MIMO_BULK: "0" })).toBe(false);
  expect(mimoBulkEnabled({ MIMO_BULK: "1" })).toBe(true);
});

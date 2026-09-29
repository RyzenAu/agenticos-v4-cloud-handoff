import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, createProviderCache } from "./snapshot";
import { aiUsageIntent, answerAiUsage, providerSpend, spokenAud } from "./jarvis-intent";
import type { AiUsageSnapshot } from "./types";

// Synthetic fixture home: fake tokens only, no real credentials.
const root = mkdtempSync(join(tmpdir(), "aiu-snap-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const exp = Math.floor(Date.now() / 1000) + 86_400;
const codexToken = (plan: string, email: string, account: string) =>
  jwt({ exp, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: account }, "https://api.openai.com/profile": { email } });

const home = join(root, "home");
const hermes = join(root, "hermes");
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(join(home, ".config"), { recursive: true });
mkdirSync(hermes, { recursive: true });
writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-fixture", expiresAt: Date.now() + 3_600_000, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
writeFileSync(join(home, ".config", "agentic-os.env"), "OPENROUTER_API_KEY=file-key\nRETELL_API_KEY=retell-key\nGROQ_API_KEY=groq-key\n");
writeFileSync(
  join(hermes, "auth.json"),
  JSON.stringify({
    credential_pool: {
      "openai-codex": [
        { label: "openai-1", access_token: codexToken("prolite", "a@muventures.com.au", "acct-mu") },
        { label: "openai-2", access_token: codexToken("plus", "u@gmail.com", "acct-u") },
        { label: "openai-3", access_token: codexToken("prolite", "m@gmail.com", "acct-m") },
      ],
    },
  }),
);

const calls: string[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  const headers = new Headers(init?.headers);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://open.er-api.com")) return json({ result: "success", time_last_update_utc: "Thu, 24 Sep 2026 00:00:00 +0000", rates: { AUD: 1.5 } });
  if (url.includes("/api/oauth/usage"))
    return json({ five_hour: { utilization: 12, resets_at: "2026-09-24T10:00:00Z" }, seven_day: { utilization: 46, resets_at: "2026-09-28T02:00:00Z" }, extra_usage: { is_enabled: false } });
  if (url.includes("/wham/usage")) {
    const acct = headers.get("ChatGPT-Account-Id");
    if (acct === "acct-m") return json({ detail: "expired" }, 401);
    const used = acct === "acct-mu" ? 57 : 2;
    return json({ plan_type: acct === "acct-u" ? "plus" : "prolite", rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1790422270 } } });
  }
  if (url.endsWith("/api/v1/key")) return json({ data: { label: "sk-or-v1-abc...123", limit: 19, limit_remaining: 17, usage: 2, usage_monthly: 2, is_free_tier: false } });
  if (url.endsWith("/api/v1/credits")) return json({ data: { total_credits: 10, total_usage: 2 } });
  if (url.includes("retellai.com")) return json([{ start_timestamp: Date.now() - 1000, call_cost: { combined_cost: 50, total_duration_seconds: 60 }, transcript: "never read" }]);
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;

let snap: AiUsageSnapshot;

describe("snapshot", () => {
  test("builds totals from subscriptions and metered keys", async () => {
    const env: Record<string, string> = {};
    snap = await buildSnapshot({
      settingsFile: join(root, "ai-usage.json"),
      cache: createProviderCache(),
      counts: () => null,
      transcripts: () => null,
      transcriptsScanning: () => true,
      providerKey: (n) => ({ RETELL_API_KEY: "retell-key", GROQ_API_KEY: "groq-key" } as Record<string, string>)[n] ?? "",
      request: fakeFetch,
      now: () => new Date(2026, 8, 24, 12),
      home,
      hermesHome: hermes,
      env,
      designLedger: join(root, "none.jsonl"),
    });
    // Claude 340 (AUD incl. GST) + Pro 100×1.1×1.5 ×2 + Plus 20×1.1×1.5 = 340 + 330 + 33
    expect(snap.totals.fixedAud).toBe(703);
    // OpenRouter US$2 + Retell 50 cents, ×1.5, no GST on metered API use
    expect(snap.totals.meteredAud).toBe(3.75);
    expect(snap.totals.monthAud).toBe(706.75);
    // metered 3.75 over 23.5 days × 30 days
    expect(snap.totals.projectedAud).toBeCloseTo(703 + (3.75 / 23.5) * 30, 2);
  });

  test("router receipts (including MiMo) show as a breakdown row and are never added to the total twice", async () => {
    const at = new Date(2026, 8, 20, 9).toISOString();
    const receipt = { schema: "mu.router-receipt/v1", requestId: "r", attempt: 1, parentRequestId: null, task: "bulk.text", caller: "scripts/llm/mimo (lead-summary)", provider: "openrouter",
      model: "openrouter/mimo-v2.6-flash", providerModel: "xiaomi/mimo-v2.6-flash", route: "metered", selectedBy: "owner", reason: "x", fallbackFrom: null, inputTokens: 1, outputTokens: 1,
      characters: null, audioSeconds: null, costUsd: 1, costBasis: "catalogue_price", priceAsOf: null, allowance: null, latencyMs: 1, outcome: "succeeded", errorCode: null, httpStatus: null, startedAt: at, endedAt: at } as const;
    const withRouter = await buildSnapshot({
      settingsFile: join(root, "ai-usage.json"),
      cache: createProviderCache(),
      counts: () => null,
      transcripts: () => null,
      transcriptsScanning: () => true,
      providerKey: (n) => ({ RETELL_API_KEY: "retell-key", GROQ_API_KEY: "groq-key" } as Record<string, string>)[n] ?? "",
      request: fakeFetch,
      now: () => new Date(2026, 8, 24, 12),
      home,
      hermesHome: hermes,
      env: {},
      designLedger: join(root, "none.jsonl"),
      routerReceipts: () => [receipt, { ...receipt, requestId: "free", route: "free", provider: "groq", model: "groq/gpt-oss-120b", costUsd: 0, costBasis: "free" }],
    });
    const row = withRouter.apiKeys.find((k) => k.id === "router:openrouter");
    expect(row?.usage).toContain("1 metered call this month · lead-summary 1");
    expect(row?.spend?.aud).toBe(1.5);
    expect(withRouter.apiKeys.some((k) => k.id === "router:groq")).toBe(false);
    expect(withRouter.totals.meteredAud).toBe(snap.totals.meteredAud);
  });

  test("maps pooled accounts to owners and keeps a failed read honest", () => {
    const codex = snap.subscriptions.filter((s) => s.provider === "openai");
    expect(codex.map((s) => [s.owner, s.plan])).toEqual([
      ["M&U Ventures", "ChatGPT Pro (US$100 tier)"],
      ["Usman", "ChatGPT Plus"],
      ["Mehroz", "ChatGPT Pro (US$100 tier)"],
    ]);
    const mehroz = codex[2];
    expect(mehroz.status.ok).toBe(false);
    expect(mehroz.peakPercent).toBeNull();
    expect(mehroz.monthly?.aud).toBe(165); // plan is still known from the token, so the fee counts
    expect(snap.sources.find((s) => s.name === "Codex · Mehroz")!.ok).toBe(false);
  });

  test("never leaks key or token values", () => {
    const text = JSON.stringify(snap);
    for (const secret of ["file-key", "retell-key", "groq-key", "sk-ant-oat01-fixture", "acct-mu", "muventures.com.au", "never read"]) expect(text).not.toContain(secret);
  });

  test("Claude card uses the plan tier and live windows", () => {
    const c = snap.subscriptions.find((s) => s.provider === "anthropic")!;
    expect(c.plan).toBe("Claude Max 20x");
    expect(c.monthly).toEqual({ aud: 340, original: { amount: 340, currency: "AUD" } });
    expect(c.peakPercent).toBe(46);
  });

  test("provider reads are cached", async () => {
    const before = calls.length;
    const cache = createProviderCache();
    const deps = { settingsFile: join(root, "ai-usage.json"), cache, counts: () => null, transcripts: () => null, transcriptsScanning: () => false, providerKey: () => "", request: fakeFetch, home, hermesHome: hermes, env: {}, designLedger: join(root, "none.jsonl") };
    await buildSnapshot(deps);
    const first = calls.length - before;
    await buildSnapshot(deps);
    expect(calls.length - before).toBe(first);
  });
});

describe("Jarvis intent", () => {
  test("recognises the questions", () => {
    expect(aiUsageIntent("how much have I spent on AI this month")).toEqual({ skill: "ai_usage", action: "spend" });
    expect(aiUsageIntent("Jarvis, what's my AI spend?")).toEqual({ skill: "ai_usage", action: "spend" });
    expect(aiUsageIntent("how much are the AIs costing us")).toEqual({ skill: "ai_usage", action: "spend" });
    expect(aiUsageIntent("which Codex account is nearly out")).toEqual({ skill: "ai_usage", action: "codex" });
    expect(aiUsageIntent("which ChatGPT account is closest to its limit?")).toEqual({ skill: "ai_usage", action: "codex" });
    expect(aiUsageIntent("how much Claude have I got left")).toEqual({ skill: "ai_usage", action: "claude" });
    expect(aiUsageIntent("how much have I spent on Claude")).toEqual({ skill: "ai_usage", action: "spend", provider: "anthropic" });
    expect(aiUsageIntent("how much have I spent on OpenAI this month")).toEqual({ skill: "ai_usage", action: "spend", provider: "openai" });
    expect(aiUsageIntent("what's my ChatGPT spend")).toEqual({ skill: "ai_usage", action: "spend", provider: "openai" });
  });
  test("AI spend phrasings reach the AI usage skill, not the bank (J3, audit top-15 #5)", () => {
    const all = { skill: "ai_usage", action: "spend" };
    for (const u of [
      "how much have I spent on AI tools this month",
      "what have I spent on AI this month",
      "how much am I spending on ChatGPT and Claude",
      "sorry I keep going on but before you do anything can you tell me how much I've spent on AI this month because I think it's a lot",
      "hey Jarvis how much did AI cost me this month",
    ])
      expect([u, aiUsageIntent(u)]).toEqual([u, all]);
    expect(aiUsageIntent("how much am I spending on Claude")).toEqual({ ...all, provider: "anthropic" });
    expect(aiUsageIntent("how much is my ChatGPT plan costing me")).toEqual({ ...all, provider: "openai" });
  });
  test("bank, shopping and package-price spend questions are still the bank's or the catalogue's (J3)", () => {
    for (const u of [
      "how much have I spent on groceries this month",
      "how much have I spent at the bank this month",
      "what did I spend on NAB this month",
      "how much did I spend on AI on my NAB card",
      "how much does the AI receptionist cost per month",
      "how much time have I spent on AI this week",
      "how much have I spent on software",
      "what have I spent on coffee",
    ])
      expect([u, aiUsageIntent(u)]).toEqual([u, null]);
  });
  test("ignores everything else", () => {
    for (const u of ["open the usage page", "spend some time on the dental site", "which account should I email from", "what's the weather", ""]) expect(aiUsageIntent(u)).toBeNull();
  });
  test("answers from the snapshot", () => {
    const now = Date.parse("2026-09-24T02:00:00Z");
    const spend = answerAiUsage({ skill: "ai_usage", action: "spend" }, snap, now);
    expect(spend).toContain("About 707 dollars on AI so far this September");
    expect(spend).toContain("703 dollars in subscriptions");
    const codex = answerAiUsage({ skill: "ai_usage", action: "codex" }, snap, now);
    expect(codex).toStartWith("M&U Ventures' Pro account is closest, at 57% of its weekly limit");
    expect(codex).toContain("Usman's Plus 2%");
    expect(codex).toContain("1 account couldn't be read");
    expect(answerAiUsage({ skill: "ai_usage", action: "claude" }, snap, now)).toStartWith("Claude Max 20x is at 12% of the 5-hour session and 46% of the weekly limit");
  });
  test("a per-provider spend question is plans plus API actually billed; API-equivalent value is never added in (J3)", () => {
    const now = Date.parse("2026-09-24T02:00:00Z");
    const providerSnap = {
      ...snap,
      subscriptions: [
        { ...snap.subscriptions[0], provider: "anthropic", monthly: { aud: 340, original: { amount: 309.09, currency: "AUD" } } },
        { ...snap.subscriptions[0], provider: "openai", monthly: { aud: 150, original: { amount: 100, currency: "USD" } } },
      ],
      apiKeys: [],
      // The audit case: Claude Max usage that WOULD cost A$17,076 on the API. Not money spent.
      claudeModels: { rows: [], totalApiEquivalent: { aud: 17076, original: { amount: 11983, currency: "USD" } }, freshness: { checkedAt: null, source: "local transcripts", estimated: true }, scope: "test" },
    } as AiUsageSnapshot;
    const claude = answerAiUsage({ skill: "ai_usage", action: "spend", provider: "anthropic" }, providerSnap, now);
    expect(claude).toBe("About 340 dollars on Claude so far this September, all in subscriptions. Its usage is worth about 17,076 dollars at API prices, which is not money you paid.");
    expect(claude).not.toContain("17,416");
    expect(answerAiUsage({ skill: "ai_usage", action: "spend", provider: "openai" }, providerSnap, now)).toBe("About 150 dollars on OpenAI so far this September, all in subscriptions.");
    // A billed Anthropic API row IS spend: it is added, and named as API use.
    const billed = { ...providerSnap, apiKeys: [{ id: "anthropic-api", provider: "Anthropic", spend: { aud: 43, original: { amount: 30, currency: "USD" } } }] } as unknown as AiUsageSnapshot;
    expect(answerAiUsage({ skill: "ai_usage", action: "spend", provider: "anthropic" }, billed, now)).toStartWith("About 383 dollars on Claude so far this September: 340 dollars in subscriptions and 43 dollars of API use.");
    // The router-receipt breakdown rows are already inside their provider's row: never counted twice.
    const receipts = { ...billed, apiKeys: [...billed.apiKeys, { id: "router:anthropic", provider: "Anthropic · router receipts", spend: { aud: 43, original: { amount: 30, currency: "USD" } } }] } as unknown as AiUsageSnapshot;
    expect(answerAiUsage({ skill: "ai_usage", action: "spend", provider: "anthropic" }, receipts, now)).toStartWith("About 383 dollars on Claude");
    const noSpend = { ...providerSnap, subscriptions: [], claudeModels: { ...providerSnap.claudeModels, totalApiEquivalent: null } } as AiUsageSnapshot;
    expect(answerAiUsage({ skill: "ai_usage", action: "spend", provider: "anthropic" }, noSpend, now)).toBe("I can't see any Claude spend in Hermes' pool.");
  });
  test("the spoken all-AI total is the Usage page's total, and a provider's never exceeds it (J3)", () => {
    const now = Date.parse("2026-09-24T02:00:00Z");
    // The real builder's snapshot from the fixture home (the same object the /usage page renders).
    const all = answerAiUsage({ skill: "ai_usage", action: "spend" }, snap, now);
    expect(all).toContain(`About ${spokenAud(snap.totals.monthAud)} on AI so far this September`);
    expect(all).toContain(`${spokenAud(snap.totals.fixedAud)} in subscriptions and ${spokenAud(snap.totals.meteredAud)} of metered API use`);
    expect(snap.totals.monthAud).toBeCloseTo(snap.totals.fixedAud + snap.totals.meteredAud, 2);
    for (const provider of ["anthropic", "openai"] as const) {
      const said = providerSpend(snap, provider);
      expect(said.totalAud).toBeLessThanOrEqual(snap.totals.monthAud + 0.005);
    }
    // Even with a huge API-equivalent figure in the snapshot, nothing spoken for Claude reaches it as spend.
    const audit = { ...snap, claudeModels: { rows: [], totalApiEquivalent: { aud: 17076, original: { amount: 11983, currency: "USD" } }, freshness: { checkedAt: null, source: "local transcripts", estimated: true }, scope: "test" } } as AiUsageSnapshot;
    const claude = answerAiUsage({ skill: "ai_usage", action: "spend", provider: "anthropic" }, audit, now);
    const spent = Number(claude.match(/^About ([\d,]+) dollars on Claude/)![1].replace(/,/g, ""));
    expect(spent).toBeLessThanOrEqual(Math.round(snap.totals.monthAud));
    expect(claude).toContain("not money you paid");
    // And the all-AI line is identical with or without that figure.
    expect(answerAiUsage({ skill: "ai_usage", action: "spend" }, audit, now)).toBe(all);
  });
  test("spoken money", () => {
    expect(spokenAud(0.46)).toBe("46 cents");
    expect(spokenAud(3.75)).toBe("3.75 dollars");
    expect(spokenAud(683.99)).toBe("684 dollars");
  });
});

// System > Models view model: honest route labels, funds/limits shown with balance, usage and
// failure, and no cap setting anywhere. Synthetic data only.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ModelsPage } from "../../src/components/shell/pages/models-page";
import { modelsFacts, modelsSummary, routeLabel } from "../../src/components/shell/models-facts";
import { modelRouterView } from "./api";
import type { AiUsageSnapshot } from "../ai-usage/types";

const NOW = Date.parse("2026-09-28T02:00:00Z");

function view() {
  const root = mkdtempSync(join(tmpdir(), "models-facts-"));
  try {
    return modelRouterView(root, NOW);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const usage = (limit: string, status: "ok" | "danger") =>
  ({
    apiKeys: [
      {
        id: "openrouter:abc",
        provider: "OpenRouter",
        keyName: "OPENROUTER_API_KEY",
        keyTail: null,
        usage: "US$50.00 this month",
        spend: null,
        spendEstimated: false,
        limit,
        status,
        note: "",
        freshness: {
          checkedAt: "2026-09-28T01:50:00Z",
          source: "OpenRouter /api/v1/key (provider figure)",
          estimated: false,
        },
      },
    ],
    subscriptions: [
      {
        id: "claude:max",
        provider: "anthropic",
        owner: "M&U Ventures",
        plan: "Max 20x",
        planSlug: null,
        monthly: null,
        priceNote: "",
        status: {
          ok: true,
          windows: [{ label: "5-hour", usedPercent: 97, resetsAt: "2026-09-28T04:00:00Z" }],
          notes: [],
          freshness: { checkedAt: null, source: "x", estimated: false },
        },
        peakPercent: 97,
      },
    ],
  }) as unknown as AiUsageSnapshot;

test("route labels never call a paid route free", () => {
  expect(routeLabel("subscription", { verifiedFree: false }).label).toBe("Subscription");
  expect(routeLabel("metered", { verifiedFree: false }).label).toBe("Metered");
  expect(routeLabel("free", { verifiedFree: true }).label).toBe("Free");
  expect(routeLabel("free", { verifiedFree: false }).label).toBe("Free tier, billing unverified");
  const facts = modelsFacts(view(), null, NOW);
  for (const p of facts)
    for (const m of p.models) {
      if (m.model.route !== "free") expect(m.route.label).not.toMatch(/free/i);
      if (m.model.route === "subscription") expect(m.cost).toMatch(/allowance/);
    }
});

test("exhausted funds and a spent plan window show balance, usage and the failure", () => {
  const v = view();
  v.health.models["openrouter/mimo-v2.6-flash"] = {
    state: "exhausted",
    until: "2026-09-28T02:30:00Z",
    lastProbe: null,
    lastFailure: { at: "2026-09-28T01:59:00Z", errorCode: "insufficient_funds", httpStatus: 402 },
    detail: "HTTP 402",
  };
  v.usage["openrouter/mimo-v2.6-flash"] = {
    model: "openrouter/mimo-v2.6-flash",
    calls: 3,
    succeeded: 2,
    failures: 1,
    fallbacksInto: 0,
    inputTokens: 300,
    outputTokens: 30,
    costUsd: 0.0001,
    unknownCostCalls: 1,
    lastUsedAt: "2026-09-28T01:59:00Z",
    lastFailure: {
      at: "2026-09-28T01:59:00Z",
      errorCode: "insufficient_funds",
      httpStatus: 402,
      outcome: "rate_limited",
    },
  };
  const facts = modelsFacts(v, usage("US$50 key limit · US$0.00 left", "danger"), NOW);
  const or = facts.find((p) => p.provider.id === "openrouter")!;
  expect(or.alert?.title).toBe("Funds or plan limit exhausted");
  expect(or.alert?.failure).toBe("insufficient funds (HTTP 402)");
  expect(or.balance[0].text).toContain("US$0.00 left");
  const mimo = or.models.find((m) => m.model.id === "openrouter/mimo-v2.6-flash")!;
  expect(mimo.health.label).toMatch(/^Out of funds until/);
  expect(mimo.cost).toBe("US$0.0001 + 1 call unknown");
  expect(mimo.failures).toMatch(/^1 failed · last insufficient funds \(HTTP 402\)/);

  const claude = facts.find((p) => p.provider.id === "claude-sub")!;
  expect(claude.windows[0].text).toContain("5-hour 97%");
  expect(claude.alert?.title).toBe("Funds or plan limit exhausted");
  expect(modelsSummary(facts).attention).toBeGreaterThanOrEqual(2);
});

test("the page source has no cap control", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "..", "src", "components", "shell", "pages", "models-page.tsx"),
  ).text();
  expect(src).not.toMatch(/\bcap(s|Id)?\b\s*[:=(]|spending limit|set (a )?cap/i);
  const html = renderToStaticMarkup(
    createElement("div", null, routeLabel("subscription", { verifiedFree: false }).title),
  );
  expect(html).toContain("Not free");
});

test("the Models page renders every provider with honest labels, health, usage and the exhausted-funds notice", () => {
  const v = view();
  v.health.models["openrouter/mimo-v2.6-flash"] = {
    state: "exhausted",
    until: new Date(Date.now() + 3_600_000).toISOString(),
    lastProbe: null,
    lastFailure: { at: new Date().toISOString(), errorCode: "insufficient_funds", httpStatus: 402 },
    detail: "HTTP 402",
  };
  const client = new QueryClient();
  client.setQueryData(["system", "model-router"], v);
  client.setQueryData(["ai-usage"], {
    ...usage("US$50 key limit · US$0.00 left", "danger"),
    generatedAt: new Date().toISOString(),
    claudeModels: { ok: false, reason: "synthetic", checkedAt: null },
  });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ModelsPage)),
  );
  for (const label of [
    "Cline free models",
    "Claude Max 20x (subscription)",
    "ChatGPT/Codex pool",
    "Hermes agent gateway",
    "Groq (free plan)",
    "OpenRouter",
    "TypeSafe Jev",
    "ElevenLabs",
    "DeepSeek direct",
  ])
    expect(html).toContain(label);
  expect(html).toContain("xiaomi/mimo-v2.6-flash");
  expect(html).toContain("Out of funds");
  expect(html).toContain("Funds and limits");
  expect(html).toContain("US$0.00 left");
  expect(html).toContain("nvidia/nemotron-3-super-120b-a12b:free");
  expect(html).toContain(">Subscription<");
  expect(html).not.toMatch(/spending cap|set a cap/i);
});

test("one pooled Codex account at 100% is not shown as the pool being exhausted", () => {
  const snap = usage("US$50 key limit · US$40.00 left", "ok");
  const c = (id: string, used: number) => ({
    ...snap.subscriptions[0],
    id,
    provider: "openai",
    plan: "Pro",
    status: {
      ...(snap.subscriptions[0].status as any),
      windows: [{ label: "Weekly", usedPercent: used, resetsAt: null }],
    },
  });
  const facts = modelsFacts(
    view(),
    {
      ...snap,
      subscriptions: [c("codex:openai-1", 100), c("codex:openai-2", 12)],
    } as unknown as AiUsageSnapshot,
    NOW,
  );
  expect(facts.find((p) => p.provider.id === "codex")!.alert).toBeNull();
  const spent = modelsFacts(
    view(),
    {
      ...snap,
      subscriptions: [c("codex:openai-1", 100), c("codex:openai-2", 97)],
    } as unknown as AiUsageSnapshot,
    NOW,
  );
  expect(spent.find((p) => p.provider.id === "codex")!.alert?.title).toBe(
    "Funds or plan limit exhausted",
  );
});

// Audit F3-09/10/11/36: words don't split mid-word, the page can be filtered and quiet providers fold,
// and a catalogue listing date is labelled as a listing, not as a health probe.
test("route filters, search and 'needing attention' narrow the list; quiet providers fold", async () => {
  const { filterModels, providerIsQuiet } = await import("../../src/components/shell/models-facts");
  const v = view();
  v.health.models["openrouter/mimo-v2.6-flash"] = {
    state: "exhausted",
    until: "2026-09-28T02:30:00Z",
    lastProbe: null,
    lastFailure: { at: "2026-09-28T01:59:00Z", errorCode: "insufficient_funds", httpStatus: 402 },
    detail: "HTTP 402",
  };
  const facts = modelsFacts(v, null, NOW);
  const all = facts.flatMap((p) => p.models);
  for (const route of ["free", "subscription", "metered"] as const) {
    const shown = filterModels(facts, route).flatMap((p) => p.models);
    expect(shown.length).toBe(all.filter((m) => m.model.route === route).length);
    expect(shown.every((m) => m.model.route === route)).toBe(true);
  }
  const attention = filterModels(facts, "attention");
  expect(attention.flatMap((p) => p.models).some((m) => m.model.id === "openrouter/mimo-v2.6-flash")).toBe(true);
  expect(attention.every((p) => p.alert || p.models.every((m) => m.health.tone === "danger"))).toBe(true);
  const search = filterModels(facts, "all", "NEMOTRON").flatMap((p) => p.models);
  expect(search.length).toBeGreaterThan(0);
  expect(search.every((m) => /nemotron/i.test(`${m.model.id} ${m.model.providerModel}`))).toBe(true);
  expect(filterModels(facts, "all")).toBe(facts);
  expect(filterModels(facts, "free", "no-such-model-xyz")).toEqual([]);
  // No receipts in a fresh root: every provider without an alert or a failing model is quiet.
  const or = facts.find((p) => p.provider.id === "openrouter")!;
  expect(providerIsQuiet(or)).toBe(false);
  expect(facts.filter((p) => p.models.length && !p.alert && p.models.every((m) => m.health.tone !== "danger")).every(providerIsQuiet)).toBe(true);
});

test("a catalogue listing reads 'Listed …', a router probe reads as a check", async () => {
  const { lastCheckText } = await import("../../src/components/shell/models-facts");
  const fmt = (iso: string) => iso.slice(0, 10);
  const probe = { at: "2026-09-27T15:52:21Z", method: "OpenRouter public /api/v1/models", result: "listed at $0/$0" };
  expect(lastCheckText({ lastProbe: probe, probeSource: "catalogue" }, fmt).text).toBe("Listed 2026-09-27");
  expect(lastCheckText({ lastProbe: probe, probeSource: "catalogue" }, fmt).title).toMatch(/^Catalogue listing, not a health check/);
  expect(lastCheckText({ lastProbe: probe, probeSource: "health" }, fmt).text).toBe("2026-09-27");
  expect(lastCheckText({ lastProbe: null, probeSource: null }, fmt).text).toBe("—");
  const facts = modelsFacts(view(), null, NOW);
  const listed = facts.flatMap((p) => p.models).filter((m) => m.probeSource === "catalogue");
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.every((m) => m.health.label === "Not checked" || m.model.status !== "verified")).toBe(true);
});

test("the rendered table doesn't allow mid-word breaks outside the model id, and folds quiet providers", () => {
  const client = new QueryClient();
  client.setQueryData(["system", "model-router"], view());
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ModelsPage)));
  expect(html).not.toContain('max-w-[1320px] [overflow-wrap:anywhere]');
  const ths = html.match(/<th [^>]*>/g) ?? [];
  expect(ths.length).toBeGreaterThan(0);
  expect(ths.every((t) => t.includes("whitespace-nowrap"))).toBe(true);
  expect(html).toContain(">Last check<");
  expect(html).not.toContain(">Last probe<");
  expect(html).toContain("none used in the last 30 days");
  expect(html).toContain('aria-label="Show models"');
  expect(html).toContain("Search model, provider or task");
});

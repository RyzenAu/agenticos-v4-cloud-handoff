import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteOpenRouterFailure, openRouterCreditsExhausted, providerKey, resetOpenRouterCreditsGateForTests } from "./provider-config";

afterEach(() => resetOpenRouterCreditsGateForTests());

test("fresh provider is unconfigured; explicit local settings override legacy store", () => {
  const root = mkdtempSync(join(tmpdir(), "agentic-provider-"));
  const options = { home: root, env: {} };
  try {
    expect(providerKey(root, "OPENROUTER_API_KEY", options)).toBe("");
    mkdirSync(join(root, ".hermes"));
    writeFileSync(join(root, ".hermes/.env"), "OPENROUTER_API_KEY=legacy-fixture\n");
    expect(providerKey(root, "OPENROUTER_API_KEY", options)).toBe("legacy-fixture");
    mkdirSync(join(root, ".config"));
    writeFileSync(join(root, ".config/agentic-os.env"), "export OPENROUTER_API_KEY='generic-fixture'\n");
    expect(providerKey(root, "OPENROUTER_API_KEY", options)).toBe("generic-fixture");
    writeFileSync(join(root, ".env.local"), "OPENROUTER_API_KEY=project-fixture # example\n");
    expect(providerKey(root, "OPENROUTER_API_KEY", options)).toBe("project-fixture");
    expect(providerKey(root, "OPENROUTER_API_KEY", { home: root, env: { OPENROUTER_API_KEY: "env-fixture" } })).toBe("env-fixture");
    expect(providerKey(root, ".*", options)).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("openRouterCreditsExhausted: only a genuine 'no purchased credits' response trips it", () => {
  expect(openRouterCreditsExhausted()).toBe(false);
  noteOpenRouterFailure(429, "rate limited");
  expect(openRouterCreditsExhausted()).toBe(false); // an ordinary rate limit is not "no credits"
  noteOpenRouterFailure(403, "forbidden: bad api key");
  expect(openRouterCreditsExhausted()).toBe(false); // a 403 that isn't about credits either
  noteOpenRouterFailure(403, '{"error":{"message":"This key has no credits available to purchase completions"}}');
  expect(openRouterCreditsExhausted()).toBe(true); // a 403 whose body actually talks about credits
});

test("openRouterCreditsExhausted: a 402 always trips it, and only warns once", () => {
  const lines: string[] = [];
  noteOpenRouterFailure(402, '{"error":"payment required"}', (l) => lines.push(l));
  expect(openRouterCreditsExhausted()).toBe(true);
  expect(lines).toHaveLength(1);
  noteOpenRouterFailure(402, '{"error":"payment required"}', (l) => lines.push(l));
  expect(lines).toHaveLength(1); // second failure: remembered, not re-warned
});

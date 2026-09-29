// L2 (29 Sep 2026), owner: the Memory map "doesn't show connected or not, just 'not checked yet'".
// Nothing probed Hindsight until a recall or save ran. status() now starts a background health
// probe through the configured URL (the proxy), caches it ~60 s, and never waits for it. A fake
// health endpoint stands in for Hindsight; no network, synthetic paths only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnector } from "./connector";
import type { MemorySettings } from "./settings";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function settings(writes = true): MemorySettings {
  const root = mkdtempSync(join(tmpdir(), "l2-hs-health-"));
  dirs.push(root);
  return {
    mode: writes ? "on" : "read",
    writes,
    retired: [],
    writer: null,
    hindsight: { enabled: true, url: "http://127.0.0.1:59999", bank: "syn-health", apiKeyEnv: "SYN_HINDSIGHT_KEY_UNSET", approvalSecretFile: [], reason: null },
    vaultRoot: join(root, "vault"),
    vaultName: "synthetic",
    stateDir: join(root, "state"),
    sync: { allow: [], deny: [] },
  };
}

/** A fake Hindsight: /health answers `status`, or the connection fails when status is 0. */
function fakeHealth(status: () => number) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const s = status();
    if (s === 0) throw new TypeError("connection refused");
    return new Response(JSON.stringify({ status: s === 200 ? "healthy" : "unhealthy" }), { status: s });
  }) as typeof fetch;
  return { f, calls };
}

describe("Hindsight health is probed, cached and reported", () => {
  test("not-checked before the first probe, then connected; the probe hits <url>/health once per TTL", async () => {
    const t = { now: Date.parse("2026-09-29T02:00:00Z") };
    const fake = fakeHealth(() => 200);
    const c = createConnector({ settings: settings(), fetch: fake.f, now: () => new Date(t.now), env: {} });
    const first = c.status();
    expect(first.hindsight_health).toBe("not-checked");
    expect(first.hindsight).toBe("unknown");
    await c.probeHealth();
    const after = c.status();
    expect(after.hindsight_health).toBe("connected");
    expect(after.hindsight).toBe("ok");
    expect(after.hindsight_checked_at).toBe("2026-09-29T02:00:00.000Z");
    expect(fake.calls).toEqual(["http://127.0.0.1:59999/health"]);
    // Within the TTL: no new probe, however often the page polls.
    t.now += 30_000;
    c.status();
    c.status();
    await c.probeHealth();
    expect(fake.calls.length).toBe(1);
    // After the TTL: probed again.
    t.now += 31_000;
    c.status();
    await c.probeHealth();
    expect(fake.calls.length).toBe(2);
  });

  test("a failing or unreachable Hindsight is 'down' (unavailable), never 'not checked'", async () => {
    let code = 503;
    const fake = fakeHealth(() => code);
    const c = createConnector({ settings: settings(), fetch: fake.f, env: {}, health: { ttlMs: 0 } });
    await c.probeHealth();
    expect(c.status().hindsight_health).toBe("down");
    expect(c.status().hindsight).toBe("unavailable");
    code = 0;
    await c.probeHealth();
    expect(c.status().hindsight_health).toBe("down");
    code = 200;
    await c.probeHealth(); // the probe status() just started (it saw the refused connection)
    await c.probeHealth(); // a fresh one (TTL 0)
    expect(c.status().hindsight_health).toBe("connected");
  });

  test("a hung Hindsight times out quickly and status() never waits for the probe", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as typeof fetch;
    const c = createConnector({ settings: settings(), fetch: hang, env: {}, health: { timeoutMs: 50 } });
    const t0 = Date.now();
    expect(c.status().hindsight_health).toBe("not-checked");
    expect(Date.now() - t0).toBeLessThan(500);
    await c.probeHealth();
    expect(c.status().hindsight_health).toBe("down");
  });

  test("read-only mode still says connected (writes-off state), and Hindsight off is 'disabled' with no probe", async () => {
    const fake = fakeHealth(() => 200);
    const c = createConnector({ settings: settings(false), fetch: fake.f, env: {} });
    await c.probeHealth();
    expect(c.status().hindsight_health).toBe("connected");
    expect(c.status().hindsight).toBe("writes-off");
    const off = settings();
    off.hindsight = { ...off.hindsight, enabled: false, url: null, reason: "HINDSIGHT_URL is off" };
    const none = fakeHealth(() => 200);
    const d = createConnector({ settings: off, fetch: none.f, env: {} });
    expect(d.status().hindsight_health).toBe("disabled");
    await d.probeHealth();
    expect(none.calls.length).toBe(0);
  });
});

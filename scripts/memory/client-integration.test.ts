// The Memory UI's HTTP client driving the real /__memory middleware and API over a TEMP
// synthetic vault and the FAKE Hindsight — the same calls the page makes, approval step included.
import { afterEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createHttpMemoryClient } from "../../src/components/memory/client";
import { createSyntheticMemoryClient } from "../../src/components/memory/synthetic-client";
import { memoryMiddleware } from "./plugin";
import { cleanup, setup, usman } from "./testing/harness";

afterEach(cleanup);

function clientOver(api: Parameters<typeof memoryMiddleware>[0]["api"] extends () => infer A ? A : never, signedIn = true) {
  const mw = memoryMiddleware({ api: () => api, principalFor: () => (signedIn ? usman : null) });
  const fakeFetch = (async (input: string, init?: RequestInit) => {
    const url = String(input).replace(/^\/__memory/, "");
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url,
      headers: { host: "localhost:8081", ...(init?.headers as Record<string, string>), "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    return new Promise<Response>((resolve) => {
      const res = {
        statusCode: 200,
        setHeader() {},
        end(b: string) {
          resolve(new Response(b, { status: this.statusCode }));
        },
      };
      mw(req as never, res as never, () => resolve(new Response(JSON.stringify({ error: "no route" }), { status: 404 })));
    });
  }) as unknown as typeof fetch;
  return createHttpMemoryClient("/__memory", fakeFetch);
}

test(
  "status, capture with destinations, browse, correct, and forget through the approval step",
  async () => {
    const h = await setup();
    const client = clientOver(h.api);
    await client.sync();
    const st = await client.status();
    expect(st.principal.name).toBe("Usman");
    expect(st.hindsight).toBe("ok");
    expect(st.pending).toBe(0);
    expect(st.skipped.map((s) => s.reason)).toContain("secret-shaped content");

    const m = await client.remember({ text: "The synthetic Robin account prefers afternoon calls." });
    if (!m.ok) throw new Error(m.message);
    expect(m.destination.label).toBe("Hindsight memory (not in the vault)");
    const v = await client.saveToVault({ text: "Synthetic Robin proposals include a two-week pilot review." });
    if (!v.ok) throw new Error(v.message);
    expect(v.destination.kind === "vault" && v.destination.path).toBe("wiki/topics/business/memory-business-shared.md");

    const rows = await client.items({ q: "Robin" });
    expect(rows.map((r) => r.destination_label).sort()).toEqual(["Hindsight memory", "Vault fact"]);
    const c = await client.correct(m.memory.id, "The synthetic Robin account prefers morning calls.", (await client.item(m.memory.id))!.row.version_hash);
    if (!c.ok) throw new Error(c.message);
    expect((await client.item(c.id))!.history.map((x) => x.status)).toEqual(["superseded", "current"]);

    const ask = await client.forget({ kind: "memory", target: c.id });
    if (ask.ok || ask.code !== "approval-required" || !ask.approval) throw new Error("expected approval step");
    // The card (a confirm nonce for this browser session), then its button: the server runs the forget.
    const card = await client.card(ask.approval.id);
    if (!card.ok) throw new Error(card.reason);
    const g = await client.grant(ask.approval.id, card.card_nonce);
    if (!g.ok) throw new Error(g.reason);
    const done = g.result as Awaited<ReturnType<typeof client.forget>>;
    expect(done.ok).toBe(true);
    expect(await client.item(c.id)).toBeNull();
    expect((await client.factsUsed([c.id, v.fact.wiki_ref])).facts.map((f) => f.id)).toEqual([v.fact.wiki_ref]);
  },
  { timeout: 30_000 },
);

test("signed out: the page gets a clear sign-in error", async () => {
  const h = await setup();
  const client = clientOver(h.api, false);
  await expect(client.status()).rejects.toThrow(/Sign in/);
});

test("the synthetic preview client follows the same approval step", async () => {
  const s = createSyntheticMemoryClient({ latencyMs: 0 });
  const ask = await s.forget({ kind: "memory", target: "mem-5e1a0c0004" });
  if (ask.ok || !ask.approval) throw new Error("expected approval");
  expect((await s.forget({ kind: "memory", target: "mem-5e1a0c0004", approval_id: ask.approval.id })).ok).toBe(false);
  const card = await s.card(ask.approval.id);
  if (!card.ok) throw new Error(card.reason);
  expect((await s.grant(ask.approval.id, "a-forged-nonce")).ok).toBe(false);
  const g = await s.grant(ask.approval.id, card.card_nonce);
  expect(g.ok && g.result?.ok).toBe(true);
});

import { expect, test } from "bun:test";
import { BasiqApiError, BasiqConfigError, createBasiqClient } from "./basiq";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("token and authenticated requests prohibit redirects; malformed lists fail closed", async () => {
  const redirects: unknown[] = [];
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn: (async (url: string, init: RequestInit) => {
    redirects.push(init.redirect);
    return String(url).endsWith("/token") ? jsonResponse({ access_token: "synthetic", expires_in: 3600 }) : jsonResponse({ data: null });
  }) as any });
  await expect(client.listAccounts("syn-user")).rejects.toThrow("Incomplete accounts page");
  await expect(client.listAccountIdentities("syn-user")).rejects.toThrow("Incomplete accounts page");
  await expect(client.listAccountsDecimal("syn-user")).rejects.toThrow("Incomplete accounts page");
  await expect(client.listConnections("syn-user")).rejects.toThrow("Incomplete connections page");
  expect(redirects).toHaveLength(5);
  expect(redirects.every(value => value === "error")).toBe(true);
});

test("without an API key every call fails with a clear configuration error, never a network call", async () => {
  const calls: string[] = [];
  const client = createBasiqClient({ root: "/synthetic", env: {}, home: "/nowhere", fetchFn: (async (url: string) => { calls.push(String(url)); throw new Error("should not fetch"); }) as any });
  expect(client.configured()).toBe(false);
  await expect(client.createUser({ email: "a@b.com" })).rejects.toBeInstanceOf(BasiqConfigError);
  expect(calls).toEqual([]);
});

test("the server token is requested once and reused until it is near expiry, then refreshed", async () => {
  let tokenCalls = 0, clock = 0;
  const fetchFn = (async (url: string, init: any) => {
    if (String(url).endsWith("/token")) {
      tokenCalls++;
      expect(init.headers.Authorization).toBe("Basic test-key");
      expect(init.headers["basiq-version"]).toBe("3.0");
      expect(String(init.body)).toBe("scope=SERVER_ACCESS");
      return jsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 3600 });
    }
    if (String(url).includes("/users/u1/accounts")) {
      expect(init.headers.Authorization).toBe(`Bearer tok-${tokenCalls}`);
      return jsonResponse({ data: [] });
    }
    throw new Error(`unexpected url ${url}`);
  }) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "test-key" }, fetchFn, now: () => clock });
  await client.listAccounts("u1");
  expect(tokenCalls).toBe(1);
  clock += 1000; // still fresh
  await client.listAccounts("u1");
  expect(tokenCalls).toBe(1);
  clock += 3600_000; // now expired
  await client.listAccounts("u1");
  expect(tokenCalls).toBe(2);
});

test("concurrent calls share one in-flight token request", async () => {
  let tokenCalls = 0;
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith("/token")) { tokenCalls++; await new Promise((r) => setTimeout(r, 5)); return jsonResponse({ access_token: "shared", expires_in: 3600 }); }
    return jsonResponse({ data: [] });
  }) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  await Promise.all([client.listAccounts("u1"), client.listAccounts("u1"), client.listAccounts("u1")]);
  expect(tokenCalls).toBe(1);
});

test("a failed request surfaces Basiq's own error detail and status", async () => {
  const fetchFn = (async (url: string) => (String(url).endsWith("/token") ? jsonResponse({ access_token: "t", expires_in: 3600 }) : jsonResponse({ data: [{ detail: "User not found." }] }, 404))) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  await expect(client.listAccounts("missing")).rejects.toThrow("User not found.");
  try { await client.listAccounts("missing"); } catch (error) { expect(error).toBeInstanceOf(BasiqApiError); expect((error as BasiqApiError).status).toBe(404); }
});

test("consentUrl requests a CLIENT_ACCESS token bound to the user and builds the hosted link", async () => {
  const fetchFn = (async (url: string, init: any) => {
    expect(String(init.body)).toBe("scope=CLIENT_ACCESS&userId=u42");
    return jsonResponse({ access_token: "client-tok", expires_in: 300 });
  }) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  const url = await client.consentUrl("u42");
  expect(url).toBe("https://consent.basiq.io/home?token=client-tok");
});

test("listTransactionsSince follows Basiq's cursor pagination and stops when links.next disappears", async () => {
  const pages = [
    { data: [{ id: "t1", amount: 10, direction: "credit", status: "posted", account: "a1" }], links: { next: "https://au-api.basiq.io/users/u1/transactions?cursor=2" } },
    { data: [{ id: "t2", amount: 20, direction: "credit", status: "posted", account: "a1" }], links: {} },
  ];
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith("/token")) return jsonResponse({ access_token: "t", expires_in: 3600 });
    seen.push(String(url));
    return jsonResponse(pages[seen.length - 1]);
  }) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  const transactions = await client.listTransactionsSince("u1", "2026-06-01T00:00:00.000Z");
  expect(transactions.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(seen[0]).toContain("filter=transaction.postDate.gte.2026-06-01");
  expect(seen[1]).toBe("https://au-api.basiq.io/users/u1/transactions?cursor=2");
});

test("listTransactionsSince fails instead of returning a partial snapshot at the page cap", async () => {
  let calls = 0;
  const fetchFn = (async (url: string) => {
    if (String(url).endsWith("/token")) return jsonResponse({ access_token: "t", expires_in: 3600 });
    calls++;
    return jsonResponse({ data: [{ id: `t${calls}`, amount: 1, direction: "credit", status: "posted", account: "a1" }], links: { next: `https://au-api.basiq.io/users/u1/transactions?cursor=${calls}` } });
  }) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  await expect(client.listTransactionsSince("u1", "2026-01-01T00:00:00.000Z")).rejects.toThrow("page limit");
  expect(calls).toBe(30);
});

test("pagination rejects origin, credentials, user-path, fragment and protocol attacks before authenticated dispatch", async () => {
  for (const next of ["https://review.invalid/next", "http://au-api.basiq.io/users/u1/transactions", "https://user:password@au-api.basiq.io/users/u1/transactions", "https://au-api.basiq.io/users/u2/transactions", "https://au-api.basiq.io/users/u1/accounts", "//review.invalid/next", "https://au-api.basiq.io/users/u1/transactions#x"]) {
    let dispatched = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      if (String(url).endsWith("/token")) return jsonResponse({ access_token: "synthetic", expires_in: 3600 });
      dispatched++; if (dispatched > 1) throw new Error("Unsafe second dispatch");
      return jsonResponse({ data: [], links: { next } });
    }) as any;
    const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn });
    await expect(client.listTransactionsSince("u1", "2026-09-01")).rejects.toThrow("Blocked provider destination");
    expect(dispatched).toBe(1);
  }
});

test("malformed pages and repeated cursors never become empty or partial success", async () => {
  for (const body of [{}, { data: [] , links: { next: 42 } }, { data: [], links: { next: "/users/u1/transactions" } }]) {
    const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn: (async (url: string) => String(url).endsWith("/token") ? jsonResponse({ access_token: "synthetic", expires_in: 3600 }) : jsonResponse(body)) as any });
    await expect(client.listTransactionsSince("u1", "2026-09-01")).rejects.toThrow();
  }
});

test("decimal response mapping preserves raw JSON cents before numeric parsing", async () => {
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn: (async (url: string) => String(url).endsWith("/token") ? jsonResponse({ access_token: "synthetic", expires_in: 3600 }) : new Response('{"data":[{"id":"t1","amount":90071992547409.91,"direction":"credit","status":"posted"}]}')) as any });
  expect((await client.listTransactionsSinceDecimal("u1", "2026-09-01"))[0].amount).toBe("90071992547409.91");
  await expect(client.listTransactionsSince("u1", "2026-09-01")).rejects.toThrow("legacy numeric contract");
});

test("money rejects extra precision, exponents, missing values and malformed direction/status", async () => {
  for (const patch of [{ amount: "1.001" }, { amount: "1e2" }, { amount: "90071992547409.92" }, { amount: null }, { direction: "unknown" }, { status: "unknown" }]) {
    const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn: (async (url: string) => String(url).endsWith("/token") ? jsonResponse({ access_token: "synthetic", expires_in: 3600 }) : jsonResponse({ data: [{ id: "t1", amount: "0.29", direction: "credit", status: "posted", ...patch }] })) as any });
    await expect(client.listTransactionsSinceDecimal("u1", "2026-09-01")).rejects.toThrow();
  }
});

test("identity-only account mapper needs no balance and rejects missing currency", async () => {
  let currency: string | undefined = "AUD";
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "synthetic" }, fetchFn: (async (url: string) => String(url).endsWith("/token") ? jsonResponse({ access_token: "synthetic", expires_in: 3600 }) : jsonResponse({ data: [{ id: "a1", currency, institution: "AU00NAB", connection: "c1" }] })) as any });
  expect((await client.listAccountIdentities("u1"))[0]).not.toHaveProperty("balance");
  await expect(client.listAccounts("u1")).rejects.toThrow("money");
  currency = undefined; await expect(client.listAccountIdentities("u1")).rejects.toThrow("identity");
});

test("mapped accounts and transactions carry no more than the documented fields", async () => {
  const fetchFn = (async (url: string) => (String(url).endsWith("/token") ? jsonResponse({ access_token: "t", expires_in: 3600 }) : jsonResponse({ data: [{ id: "a1", name: "Business account", balance: 4200.5, availableFunds: 4100, currency: "AUD", institution: "AU00000", connection: "conn1", status: "available", lastUpdated: "2026-09-24T00:00:00Z", accountNo: "083123 123456789" }] }))) as any;
  const client = createBasiqClient({ root: "/synthetic", env: { BASIQ_API_KEY: "k" }, fetchFn });
  const accounts = await client.listAccounts("u1");
  expect(accounts).toEqual([{ id: "a1", name: "Business account", accountNo: "083123 123456789", balance: 4200.5, availableFunds: 4100, currency: "AUD", institutionId: "AU00000", connectionId: "conn1", status: "available", lastUpdated: "2026-09-24T00:00:00Z" }]);
});

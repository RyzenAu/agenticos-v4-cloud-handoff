import { createBasiqClient } from "../finance/basiq";
import { fixture } from "./fixtures";
import { minorUnits, normalise } from "./normalise";
import type { NabSyntheticService, OwnerContext } from "./service";

export type SyntheticProviderScenario = "ok" | "expired" | "provider-error" | "wrong-account" | "wrong-currency" | "wrong-date" | "identity-only";
/** Actual existing Basiq client, closed in-memory HTTP transport. No live transport injection. */
export function createNabBasiqSyntheticAdapter(service: NabSyntheticService, owner: OwnerContext, scenario: SyntheticProviderScenario = "ok") {
  const bound = { ...owner };
  let requests = 0;
  const data = fixture("cashflow-v1");
  let readBalances = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const url = new URL(String(input));
    if (url.origin !== "https://au-api.basiq.io") throw new Error("DESTINATION_BLOCKED");
    if (url.pathname === "/token" && init?.method === "POST" && String(init.body) === "scope=SERVER_ACCESS") return json({ access_token: "synthetic-token-not-a-credential", expires_in: 3600 });
    if ((init?.method ?? "GET") !== "GET") throw new Error("WRITE_BLOCKED");
    if (scenario === "provider-error") return json({ message: "Synthetic provider failure" }, 503);
    if (url.pathname === "/users/syn-user/connections") return json({ data: [{ id: "syn-connection", status: "active", institution: "AU00NAB", method: "open-banking", expiryDate: scenario === "expired" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z" }] });
    if (url.pathname === "/users/syn-user/accounts") return json({ data: [{ id: scenario === "wrong-account" ? "syn-other" : "syn-business", name: "Synthetic business account", ...(readBalances && scenario !== "identity-only" ? { balance: "2315.00" } : {}), currency: scenario === "wrong-currency" ? "USD" : "AUD", institution: "AU00NAB", connection: "syn-connection" }] });
    if (url.pathname === "/users/syn-user/transactions") {
      const second = url.searchParams.get("cursor") === "second";
      const rows = second ? data.rows.slice(3) : data.rows.slice(0, 3);
      return json({ data: rows.map(row => ({ id: row.id, account: row.accountId, connection: "syn-connection", amount: row.amount, direction: row.direction, status: row.status, class: row.kind, postDate: scenario === "wrong-date" ? "2026-09-26" : row.date })),
        links: second ? {} : { next: "https://au-api.basiq.io/users/syn-user/transactions?cursor=second" } });
    }
    throw new Error("ROUTE_BLOCKED");
  }) as typeof fetch;
  const client = createBasiqClient({ root: "synthetic-unused", home: "synthetic-unused", env: { BASIQ_API_KEY: "synthetic-not-a-credential" }, fetchFn });
  function gate(ctx: OwnerContext, generation: number) {
    if (ctx.tenantId !== bound.tenantId || ctx.ownerId !== bound.ownerId) throw new Error("UNAUTHORISED");
    const status = service.status(ctx);
    if (!["awaiting-import", "fresh", "stale", "error"].includes(status.phase)) throw new Error("CONSENT_REQUIRED");
    if (status.generation !== generation) throw new Error("STALE_CONSENT_JOB");
    return status;
  }
  return {
    async read(ctx: OwnerContext, generation: number) {
      const status = gate(ctx, generation), before = requests;
      readBalances = status.scopes.includes("balances");
      try {
        const connections = await client.listConnections("syn-user");
        gate(ctx, generation);
        if (connections.length !== 1 || connections[0].method !== "open-banking" || connections[0].status !== "active" || Date.parse(connections[0].expiryDate ?? "") <= Date.now() || !Number.isFinite(Date.parse(connections[0].expiryDate ?? ""))) throw new Error("PROVIDER_CONSENT_INVALID");
        const accounts = readBalances ? await client.listAccountsDecimal("syn-user") : await client.listAccountIdentities("syn-user");
        gate(ctx, generation);
        if (accounts.length !== 1 || accounts[0].id !== "syn-business" || accounts[0].connectionId !== "syn-connection" || accounts[0].currency !== "AUD") throw new Error("PROVIDER_ACCOUNT_REJECTED");
        if (readBalances && (!("balance" in accounts[0]) || minorUnits(accounts[0].balance as string) !== minorUnits(data.balance))) throw new Error("FIXTURE_MISMATCH");
        if (status.scopes.includes("transactions")) {
          const rows = await client.listTransactionsSinceDecimal("syn-user", "2026-09-01T00:00:00Z");
          gate(ctx, generation);
          if (rows.length !== data.rows.length) throw new Error("INCOMPLETE_SNAPSHOT");
          rows.forEach((row, index) => {
            const expected = data.rows[index];
            const normal = normalise({ id: row.id, accountId: row.accountId, amount: String(row.amount), currency: accounts[0].currency,
              direction: row.direction, status: row.status, kind: row.class as typeof expected.kind, date: row.postDate ?? "" });
            if (normal.date !== expected.date || normal.id !== expected.id || normal.minor !== minorUnits(expected.amount) || normal.accountId !== expected.accountId || row.connectionId !== "syn-connection" || normal.kind !== expected.kind || normal.direction !== expected.direction || normal.status !== expected.status) throw new Error("FIXTURE_MISMATCH");
          });
        }
        gate(ctx, generation);
        return { ...service.importFixture(ctx, { fixtureId: "cashflow-v1", ownerInitiated: true, generation }), transport: "synthetic-in-memory" as const, requestCount: requests - before };
      } catch {
        try { service.recordProviderFailure(ctx, generation); } catch { /* Old work cannot mark a newer grant failed. */ }
        // Never bubble provider messages, token strings, account IDs or payloads into logs/UI.
        throw new Error("SYNTHETIC_PROVIDER_REJECTED");
      }
    },
  };
}

/** Explicit fail-closed boundary: no boolean flag can turn this module into a live connector. */
export function activateLiveNab(): never { throw new Error("LIVE_NAB_NOT_AUTHORISED_OR_IMPLEMENTED"); }

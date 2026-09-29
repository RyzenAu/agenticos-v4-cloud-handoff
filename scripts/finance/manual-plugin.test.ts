import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CLEAR_CONFIRMATION, MIGRATE_CONFIRMATION, handleManualFinance, manualFinancePlugin, resolveManualFinanceOwner } from "./manual-plugin";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { buildNabCsv, SYNTHETIC_SEPTEMBER } from "./manual-fixtures";
import { syntheticSeptemberCsv } from "./manual-fixtures";

describe("owner resolution", () => {
  const root = "synthetic-root";
  const loop = { remoteAddress: "127.0.0.1" };
  test("plain local requests are the PC owner; remote sockets are refused", () => {
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "localhost:8081" } }, { root })).toBe("usman");
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "127.0.0.1:4303" } }, { root })).toBe("usman");
    expect(resolveManualFinanceOwner({ socket: { remoteAddress: "100.64.0.9" }, headers: { host: "localhost" } }, { root })).toBeNull();
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "evil.example" } }, { root })).toBeNull();
  });
  test("Tailscale-proxied requests map to the verified principal's person, else refused", () => {
    // Stage B1: the owner is the one verified principal (scripts/identity/principal.ts); `principal` is the seam.
    const as = (personId: "usman" | "mehroz" | null) => () => (personId ? { personId, via: "tailnet-person" as const, displayName: personId } : null);
    const req = { socket: loop, headers: { host: "pc.tailnet.ts.net", "tailscale-user-login": "synthetic@example.com" } };
    expect(resolveManualFinanceOwner(req, { root, principal: as("mehroz") })).toBe("mehroz");
    expect(resolveManualFinanceOwner(req, { root, principal: as(null) })).toBeNull();
    // A tailscale header never falls back to the PC owner.
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "localhost", "tailscale-user-login": "x" } }, { root })).toBeNull();
    // Nor does any other relay header claiming Host: localhost (the 849f205 class of bug).
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "localhost:8081", "x-forwarded-for": "100.64.0.7" } }, { root })).toBeNull();
    expect(resolveManualFinanceOwner({ socket: loop, headers: { host: "127.0.0.1:8081", forwarded: "for=100.64.0.7" } }, { root })).toBeNull();
  });
});

describe("handler", () => {
  const store = openManualFinanceStore(":memory:");
  const call = (over: Partial<Parameters<typeof handleManualFinance>[0]>) =>
    handleManualFinance({ method: "GET", path: "/status", query: new URLSearchParams(), owner: "usman", tokenOk: false, ...over }, { store: () => store, today: () => "2026-09-27" });
  test("refuses unresolved owners and unauthenticated mutations", () => {
    expect(call({ owner: null }).status).toBe(403);
    expect(call({ method: "POST", path: "/import", query: new URLSearchParams("via=drop"), body: syntheticSeptemberCsv(), contentType: "text/csv" }).status).toBe(403);
    expect(call({ method: "POST", path: "/clear", body: JSON.stringify({ confirm: CLEAR_CONFIRMATION }) }).status).toBe(403);
    expect(store.count(SHARED_LEDGER)).toBe(0);
  });
  test("import needs an explicit drop/picker origin and text/csv", () => {
    expect(call({ method: "POST", path: "/import", tokenOk: true, body: syntheticSeptemberCsv(), contentType: "text/csv" }).status).toBe(400);
    expect(call({ method: "POST", path: "/import", query: new URLSearchParams("via=downloads"), tokenOk: true, body: syntheticSeptemberCsv(), contentType: "text/csv" }).status).toBe(400);
    expect(call({ method: "POST", path: "/import", query: new URLSearchParams("via=drop"), tokenOk: true, body: syntheticSeptemberCsv(), contentType: "application/json" }).status).toBe(415);
    const bad = call({ method: "POST", path: "/import", query: new URLSearchParams("via=drop"), tokenOk: true, body: "Date,Amount\n1,2", contentType: "text/csv" });
    expect(bad).toEqual({ status: 422, body: expect.objectContaining({ code: "HEADER_MISMATCH", issues: [expect.objectContaining({ line: 1, code: "HEADER_MISMATCH", text: expect.stringContaining("header") })] }) });
    expect(store.count(SHARED_LEDGER)).toBe(0);
  });
  test("status carries the Basiq not-connected card and legacy NAB stays refused", () => {
    const s = call({}).body as any;
    expect(s.basiq).toMatchObject({ connected: false, phase: "not-connected", headline: "Live bank feed: not connected (deferred by owner decision)", decision: { kind: "deferred-by-owner" } });
    expect(s.basiq.reason).toContain("Basiq production enablement and your consent");
    expect(s).toMatchObject({ rowCount: 0, asOf: null, stale: true, daysSinceAsOf: null });
    expect(s.legacyNab).toEqual({ admitted: false });
    expect(call({ path: "/summary", query: new URLSearchParams("period=bogus") }).status).toBe(400);
  });
});

describe("one shared ledger for both founders (V7); the person is provenance only", () => {
  const store = openManualFinanceStore(":memory:");
  const as = (owner: string | null, over: Partial<Parameters<typeof handleManualFinance>[0]>) =>
    handleManualFinance({ method: "GET", path: "/status", query: new URLSearchParams(), owner, tokenOk: true, ...over }, { store: () => store, today: () => "2026-09-27" });
  const csv = (path: string, body: string, owner = "usman", query = "via=drop") => as(owner, { method: "POST", path, query: new URLSearchParams(query), body, contentType: "text/csv" });

  test("Mehroz sees and corrects exactly what Usman imported; each change says who made it", () => {
    const preview = csv("/preview", syntheticSeptemberCsv(), "mehroz");
    expect(preview).toMatchObject({ status: 200, body: { preview: true, inserted: 24, issues: [] } });
    expect(store.count(SHARED_LEDGER)).toBe(0); // a preview writes nothing
    expect(csv("/import", syntheticSeptemberCsv(), "usman").status).toBe(200);
    const mehroz = as("mehroz", {}).body as any, usman = as("usman", {}).body as any;
    expect(mehroz).toMatchObject({ ledger: "shared", actor: "mehroz", rowCount: 24 });
    expect(usman).toMatchObject({ ledger: "shared", actor: "usman", rowCount: 24 });
    expect(mehroz.audit[0]).toMatchObject({ action: "import", actor: "usman", asOf: "2026-09-26" });
    const review = as("mehroz", { path: "/transactions", query: new URLSearchParams("period=all&filter=review") }).body as any;
    const target = review.rows.find((r: any) => r.vendorId === "m-officeworks");
    expect(target).toMatchObject({ needsReview: true, scope: "unreviewed" });
    expect(review.rows.every((r: any) => !("accountAlias" in r) && !("dedupeKey" in r))).toBe(true);
    const fixed = as("mehroz", { method: "POST", path: "/correct", body: JSON.stringify({ txId: target.id, patch: { scope: "business" } }) });
    expect(fixed).toMatchObject({ status: 200, body: { scope: "business", edited: { scope: { by: "mehroz", source: "row" } } } });
    expect(as("usman", { path: "/edits" }).body).toMatchObject({ edits: [expect.objectContaining({ actor: "mehroz", field: "scope", newValue: "business" })] });
    expect(as("usman", { method: "POST", path: "/correct", body: JSON.stringify({ txId: target.id, patch: { scope: "everyone" } }) })).toMatchObject({ status: 400, body: { code: "INVALID_VALUE" } });
    expect(as("usman", { method: "POST", path: "/correct", body: "not json" })).toMatchObject({ status: 400, body: { code: "BAD_REQUEST" } });
    // Re-import by the other founder: nothing doubles, the correction stays.
    expect(csv("/import", syntheticSeptemberCsv(), "mehroz", "via=picker")).toMatchObject({ status: 200, body: { inserted: 0, unchanged: 24 } });
    const transfers = as("usman", { path: "/transactions", query: new URLSearchParams("period=all&filter=transfers") }).body as any;
    expect(transfers.rows.filter((r: any) => r.ownAccountPair)).toHaveLength(2);
    const refunds = as("usman", { path: "/transactions", query: new URLSearchParams("period=all&filter=refunds") }).body as any;
    expect(refunds.rows[0]).toMatchObject({ kind: "refund", matchedCharge: expect.stringMatching(/^nab-/), needsReview: false });
    expect(as("usman", { path: "/transactions", query: new URLSearchParams("filter=bogus") }).status).toBe(400);
    expect(as("usman", { method: "POST", path: "/vendor-rule", body: JSON.stringify({ vendorId: "m-officeworks", patch: { category: "Office" } }) })).toMatchObject({ status: 200 });
    expect(as(null, {}).status).toBe(403); // an unverified request still sees nothing
  });

  test("a balance warning comes back per row, blocks the import, and imports only when accepted", () => {
    const own = openManualFinanceStore(":memory:");
    const call = (query: string) => handleManualFinance({ method: "POST", path: "/import", query: new URLSearchParams(query), owner: "usman", tokenOk: true, body: missing, contentType: "text/csv" }, { store: () => own });
    const full = buildNabCsv(SYNTHETIC_SEPTEMBER.slice(0, 6)).split("\r\n");
    const missing = [...full.slice(0, 3), ...full.slice(4)].join("\r\n");
    expect(call("via=drop")).toMatchObject({ status: 422, body: { code: "BALANCE_MISMATCH", issues: [expect.objectContaining({ line: 4, severity: "warning", text: expect.stringContaining("running balance") })] } });
    expect(own.count(SHARED_LEDGER)).toBe(0);
    expect(call("via=drop&accept=warnings")).toMatchObject({ status: 200, body: { inserted: 5, warnings: 1 } });
  });

  test("legacy migration needs the token, a confirmation and a legacy store", () => {
    expect(as("usman", { method: "POST", path: "/migrate-legacy", tokenOk: false, body: "{}" }).status).toBe(403);
    expect(as("usman", { method: "POST", path: "/migrate-legacy", body: "{}" })).toMatchObject({ status: 400, body: { code: "CONFIRM" } });
    expect(as("usman", { method: "POST", path: "/migrate-legacy", body: JSON.stringify({ confirm: MIGRATE_CONFIRMATION }) })).toMatchObject({ status: 404, body: { code: "NO_LEGACY" } });
  });
});

describe("real loopback HTTP through the Vite plugin", () => {
  const dir = mkdtempSync(join(tmpdir(), "finance-manual-http-"));
  const token = "synthetic-token";
  let server: Server, base = "";
  beforeAll(async () => {
    const mounts: Array<[string, (req: IncomingMessage, res: ServerResponse, next: () => void) => void]> = [];
    const plugin = manualFinancePlugin({ root: dir, token });
    server = createServer((req, res) => {
      const hit = mounts.find(([p]) => req.url!.startsWith(p));
      if (!hit) { res.statusCode = 404; return res.end(); }
      req.url = req.url!.slice(hit[0].length) || "/"; // connect strips the mount path
      hit[1](req, res, () => { res.statusCode = 404; res.end(); });
    });
    (plugin.configureServer as any)({ httpServer: server, middlewares: { use: (path: string, fn: any) => mounts.push([path, fn]) } });
    expect(existsSync(join(dir, ".operator-data"))).toBe(false); // nothing opened or scheduled at startup
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}/__finance_manual`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

  test("import → summary → re-import → clear, persisted in finance-manual.sqlite", async () => {
    const post = (path: string, body: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", body, headers });
    expect((await post("/import?via=drop", syntheticSeptemberCsv(), { "Content-Type": "text/csv" })).status).toBe(403);
    const first = await post("/import?via=drop", syntheticSeptemberCsv(), { "Content-Type": "text/csv", "X-Claude-OS-Token": token });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ inserted: 24, unchanged: 0 });
    expect(existsSync(join(dir, ".operator-data", "finance-manual.sqlite"))).toBe(true);
    expect(existsSync(join(dir, ".operator-data", "finance.sqlite"))).toBe(false);
    const again = await post("/import?via=picker", syntheticSeptemberCsv(), { "Content-Type": "text/csv", "X-Claude-OS-Token": token });
    expect(await again.json()).toMatchObject({ inserted: 0, unchanged: 24 });
    const s = await (await fetch(`${base}/summary?period=all`)).json();
    expect(s).toMatchObject({ source: "nab-csv-manual", owner: "shared", cashInCents: 82500, cashOutCents: 29804, stripePayouts: { inCents: 41250, count: 1 } });
    const imported = await (await fetch(`${base}/status`)).json();
    expect(imported).toMatchObject({ rowCount: 24, asOf: "2026-09-26", sourceLabel: "NAB CSV imported, as of 26 Sep 2026", liveFeedLabel: "Live bank feed: not connected", live: false, actor: "usman", basiq: { connected: false, phase: "not-connected", decision: { kind: "deferred-by-owner" } } });
    expect(typeof imported.stale).toBe("boolean");
    const ask = await (await fetch(`${base}/ask?q=${encodeURIComponent("how much did we spend on twilio overall")}`)).json();
    expect(ask).toMatchObject({ matched: true, said: expect.stringContaining("Twilio") });
    expect((await post("/clear", "{}", { "Content-Type": "application/json", "X-Claude-OS-Token": token })).status).toBe(400);
    const cleared = await post("/clear", JSON.stringify({ confirm: CLEAR_CONFIRMATION }), { "Content-Type": "application/json", "X-Claude-OS-Token": token });
    expect(await cleared.json()).toMatchObject({ deleted: 24, backup: expect.stringContaining("finance-manual.pre-clear-") });
    const status = await (await fetch(`${base}/status`)).json();
    expect(status).toMatchObject({ rowCount: 0, lastImportAt: null, asOf: null, stale: true });
    expect(status.audit.map((a: any) => a.action)).toEqual(["clear", "import", "import"]);
  });

  test("oversized uploads are refused before parsing", async () => {
    const res = await fetch(`${base}/import?via=drop`, { method: "POST", body: "x".repeat(4 * 1024 * 1024 + 2048), headers: { "Content-Type": "text/csv", "X-Claude-OS-Token": token } });
    expect(res.status).toBe(413);
  });
});

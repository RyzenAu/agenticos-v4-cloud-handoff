// Fail-closed admission for the legacy NAB/Basiq path. Synthetic temp roots, spy providers and
// a spy fetch only: no real home, config, finance store, Downloads folder or network is used.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as admission from "../finance/legacy-admission";
import { handleLegacyNabRoute, LEGACY_NAB_LIVE_AUTHORISATION, legacyNabAdmission, LegacyNabRefusal, type LegacyNabLiveAuthorisation, type LegacyNabRouteDeps } from "../finance/legacy-admission";
import { createFinanceSync } from "../finance/sync";
import { createBasiqClient } from "../finance/basiq";
import { answerFinanceIntent } from "../finance/jarvis-intent";
import { SHARED_LEDGER, manualFinanceDbPath, openManualFinanceStore } from "../finance/manual-store";
import { syntheticSeptemberCsv } from "../finance/manual-fixtures";

const NOW = new Date("2026-09-27T06:00:00Z");
const SYNTHETIC_CSV = "24/09/2026,1200.00,083123456789,PAYMENT RECEIVED INV1042,5000.00";
/** Code-level synthetic record: proves what the gate protects. Never a real review. */
const syntheticAuthorisation = (patch: Partial<Record<keyof LegacyNabLiveAuthorisation, unknown>> = {}) => ({
  kind: "legacy-nab-live-authorisation/v1", reviewRef: "synthetic-test-only", reviewedBy: "legacy-admission.test",
  reviewedAt: "2026-09-27T00:00:00Z", expiresAt: "2026-10-27T00:00:00Z", provider: "basiq",
  capabilities: ["status", "connect", "sync", "summary", "import-csv", "schedule"], ...patch,
}) as LegacyNabLiveAuthorisation;

let dirs: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
const storageTouched = (root: string) => existsSync(join(root, ".operator-data"));
beforeEach(() => { dirs = []; });
afterEach(() => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* bun:sqlite handle on Windows */ } } });

function spyClient() {
  const calls: string[] = [];
  const record = <T>(name: string, value: T) => async (..._: unknown[]) => { calls.push(name); return value; };
  const client = {
    configured: () => { calls.push("configured"); return true; },
    createUser: record("createUser", { id: "synthetic-user" }),
    consentUrl: record("consentUrl", "https://consent.invalid/synthetic"),
    listConnections: record("listConnections", []),
    refreshConnection: record("refreshConnection", undefined),
    job: record("job", undefined),
    listAccounts: record("listAccounts", []),
    listTransactionsSince: record("listTransactionsSince", []),
  };
  return { client: client as any, calls };
}

/** A real Basiq client that "has a key" (synthetic env value) with a spy transport. */
function keyedRealClient() {
  const requests: string[] = [];
  const home = temp("nab-home-");
  const fetchFn = (async (url: string | URL | Request) => { requests.push(String(url)); return new Response("{}", { status: 500 }); }) as typeof fetch;
  return { client: createBasiqClient({ root: temp("nab-client-root-"), env: { BASIQ_API_KEY: "synthetic-not-a-key" }, home, fetchFn }), requests };
}

function withIntervalSpy<T>(fn: (started: { count: number }) => T): T {
  const original = globalThis.setInterval;
  const started = { count: 0 };
  (globalThis as any).setInterval = () => { started.count++; return { unref() {}, ref() {} } as any; };
  try { return fn(started); } finally { globalThis.setInterval = original; }
}

// Loopback harness mirroring scripts/operator-plugin.ts: pathname routing, JSON body, errors → 500.
async function serve(deps: LegacyNabRouteDeps): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url || "/", "http://localhost"), method = req.method || "GET";
      let body: any = {};
      if (method !== "GET") { const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
      const reply = await handleLegacyNabRoute({ method, path: url.pathname, body }, deps);
      if (!reply) return send({ error: "Not found" }, 404);
      return send(reply.body, reply.status);
    } catch (error) { return send({ error: (error as Error).message }, 500); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const LEGACY_REQUESTS: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
  { method: "GET", path: "/business/finance/status" },
  { method: "POST", path: "/business/finance/connect", body: { email: "owner@example.invalid" } },
  { method: "POST", path: "/business/finance/sync", body: {} },
  { method: "GET", path: "/business/finance/summary" },
];

function routeFixture(authorisation?: LegacyNabLiveAuthorisation | null) {
  const root = temp("nab-legacy-root-");
  const { client, calls } = spyClient();
  const seen = { financeBuilt: 0, imported: 0 };
  const deps: LegacyNabRouteDeps = {
    finance: () => { seen.financeBuilt++; return createFinanceSync(root, { client, now: () => NOW, ...(authorisation !== undefined ? { authorisation } : {}) } as any); },
    syncing: new Set(),
    importFinances: () => { seen.imported++; return { finances: { recordedAt: NOW.toISOString() } }; },
    ...(authorisation !== undefined ? { authorisation } : {}),
    now: () => NOW,
  };
  return { root, calls, seen, deps };
}

// --- Code-owned authorisation ----------------------------------------------------------

test("the code-owned live authorisation is null and cannot be reassigned by an importer", () => {
  expect(LEGACY_NAB_LIVE_AUTHORISATION).toBeNull();
  expect(() => { (admission as any).LEGACY_NAB_LIVE_AUTHORISATION = syntheticAuthorisation(); }).toThrow();
  expect(admission.LEGACY_NAB_LIVE_AUTHORISATION).toBeNull();
  const decision = legacyNabAdmission("sync");
  expect(decision).toMatchObject({ admitted: false, status: 403, code: "nab_legacy_not_authorised" });
});

test("authorisation must be a well-formed, in-date, capability-scoped reviewed record", () => {
  expect(legacyNabAdmission("sync", syntheticAuthorisation(), NOW)).toEqual({ admitted: true, capability: "sync" });
  for (const junk of [true, 1, "yes", {}, { admitted: true }, syntheticAuthorisation({ kind: "other" }), syntheticAuthorisation({ provider: "mercury" }),
    syntheticAuthorisation({ reviewRef: " " }), syntheticAuthorisation({ reviewedBy: "" }), syntheticAuthorisation({ reviewedAt: "yesterday" }),
    syntheticAuthorisation({ expiresAt: "2026-09-26T00:00:00Z" }), syntheticAuthorisation({ expiresAt: "2027-09-27T00:00:00Z" }),
    syntheticAuthorisation({ capabilities: [] }), syntheticAuthorisation({ capabilities: ["sync", "payments"] }), syntheticAuthorisation({ capabilities: "sync" })])
    expect(legacyNabAdmission("sync", junk as any, NOW)).toMatchObject({ admitted: false, status: 503, code: "nab_legacy_authorisation_invalid" });
  expect(legacyNabAdmission("sync", syntheticAuthorisation(), new Date("2026-10-28T00:00:00Z"))).toMatchObject({ admitted: false, status: 403, code: "nab_legacy_authorisation_expired" });
  expect(legacyNabAdmission("sync", syntheticAuthorisation(), new Date("2026-09-26T00:00:00Z"))).toMatchObject({ admitted: false, status: 403, code: "nab_legacy_authorisation_expired" });
  expect(legacyNabAdmission("connect", syntheticAuthorisation({ capabilities: ["status"] }), NOW)).toMatchObject({ admitted: false, status: 403, code: "nab_legacy_capability_not_authorised" });
});

// --- Construction and background schedule --------------------------------------------------

test("construction opens no finance storage, reads no state and calls no provider or config", () => {
  const root = temp("nab-construct-");
  const { client, calls } = spyClient();
  const finance = createFinanceSync(root, { client });
  expect(storageTouched(root)).toBe(false);
  expect(finance.configured()).toBe(false); // refused: answers without consulting the provider/config
  expect(calls).toEqual([]);
  const defaultRoot = temp("nab-construct-default-");
  createFinanceSync(defaultRoot); // default client + default store, exactly as the operator plugin wires it
  expect(storageTouched(defaultRoot)).toBe(false);
});

test("schedule() starts no background timer and scans nothing while unauthorised", () => {
  const root = temp("nab-schedule-");
  const { client, calls } = spyClient();
  withIntervalSpy((started) => {
    const stop = createFinanceSync(root, { client }).schedule(1000);
    expect(started.count).toBe(0);
    expect(typeof stop).toBe("function");
    stop();
  });
  expect(calls).toEqual([]);
  expect(storageTouched(root)).toBe(false);
});

test("every legacy operation is refused before provider, config, store, state or file access", async () => {
  const root = temp("nab-methods-");
  const downloads = temp("nab-downloads-");
  writeFileSync(join(downloads, "NAB-synthetic.csv"), SYNTHETIC_CSV);
  const { client, calls } = spyClient();
  const finance = createFinanceSync(root, { client, now: () => NOW });
  const refusals: unknown[] = [];
  const capture = async (run: () => unknown) => { try { await run(); refusals.push("NOT REFUSED"); } catch (error) { refusals.push(error); } };
  await capture(() => finance.status());
  await capture(() => finance.connect({ email: "owner@example.invalid" }));
  await capture(() => finance.sync());
  await capture(() => finance.summary());
  await capture(() => finance.invoiceMatches());
  await capture(() => finance.categorySpend("software"));
  for (const refusal of refusals) {
    expect(refusal).toBeInstanceOf(LegacyNabRefusal);
    expect((refusal as LegacyNabRefusal).code).toBe("nab_legacy_not_authorised");
  }
  expect(calls).toEqual([]);
  expect(storageTouched(root)).toBe(false);
  expect(readFileSync(join(downloads, "NAB-synthetic.csv"), "utf8")).toBe(SYNTHETIC_CSV);
});

test("a real Basiq client that has a key still makes zero requests and opens no storage", async () => {
  const root = temp("nab-keyed-");
  const { client, requests } = keyedRealClient();
  expect(client.configured()).toBe(true); // the key exists…
  const finance = createFinanceSync(root, { client });
  await expect(finance.connect({ email: "owner@example.invalid" })).rejects.toBeInstanceOf(LegacyNabRefusal);
  await expect(finance.sync()).rejects.toBeInstanceOf(LegacyNabRefusal);
  expect(requests).toEqual([]); // …but nothing is admitted because of it
  expect(storageTouched(root)).toBe(false);
});

// --- Routes over loopback HTTP --------------------------------------------------------------

test("every legacy route is refused over HTTP with a 403 JSON reason code and touches nothing", async () => {
  const fixture = routeFixture();
  const { base, close } = await serve(fixture.deps);
  try {
    for (const request of LEGACY_REQUESTS) {
      const res = await fetch(base + request.path, { method: request.method, ...(request.method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body) } : {}) });
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json() as any;
      expect(body).toMatchObject({ refused: true, code: "nab_legacy_not_authorised" });
      expect(body.error).toMatch(/no reviewed live authorisation/);
    }
  } finally { await close(); }
  expect(fixture.seen).toEqual({ financeBuilt: 0, imported: 0 });
  expect(fixture.calls).toEqual([]);
  expect(storageTouched(fixture.root)).toBe(false);
  expect(fixture.deps.syncing.size).toBe(0);
});

test("spoofed headers, query, body, path variants and environment variables cannot bypass admission", async () => {
  const fixture = routeFixture();
  const forged = JSON.stringify(syntheticAuthorisation());
  const envKeys = ["NAB_LIVE_AUTHORISED", "AGENTIC_NAB_LIVE", "LEGACY_NAB_LIVE_AUTHORISATION", "NAB_LEGACY_LIVE", "BASIQ_LIVE", "BASIQ_API_KEY", "FINANCE_LIVE_AUTHORISED"];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) process.env[k] = k === "LEGACY_NAB_LIVE_AUTHORISATION" ? forged : k === "BASIQ_API_KEY" ? "synthetic-not-a-key" : "1";
  const { base, close } = await serve(fixture.deps);
  try {
    const spoofHeaders = { "Content-Type": "application/json", "X-NAB-Live-Authorisation": forged, "X-Legacy-NAB-Authorised": "true", "X-Claude-OS-Token": "synthetic", "X-Forwarded-For": "127.0.0.1", Authorization: "Bearer synthetic" };
    const paths = [...LEGACY_REQUESTS.map((r) => r.path), "/business/finance/sync/", "/Business/Finance/Sync", "/BUSINESS/FINANCE/STATUS"];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const query = `?authorised=1&live=true&authorisation=${encodeURIComponent(forged)}`;
        const res = await fetch(base + path + query, { method, headers: spoofHeaders, ...(method === "POST" ? { body: JSON.stringify({ authorisation: syntheticAuthorisation(), authorised: true, live: true, filename: "NAB.csv", content: SYNTHETIC_CSV, email: "owner@example.invalid" }) } : {}) });
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).code).toBe("nab_legacy_not_authorised");
      }
    }
    // Directly constructed finance ignores the environment too.
    await expect(createFinanceSync(fixture.root, { client: spyClient().client }).sync()).rejects.toBeInstanceOf(LegacyNabRefusal);
  } finally {
    await close();
    for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  expect(fixture.seen).toEqual({ financeBuilt: 0, imported: 0 });
  expect(fixture.calls).toEqual([]);
  expect(storageTouched(fixture.root)).toBe(false);
});

test("Stripe and unrelated finance paths are not claimed by the legacy NAB handler", async () => {
  const fixture = routeFixture();
  for (const path of ["/business/finance/stripe/status", "/business/finance/stripe/sync", "/business/finance/stripe/summary", "/business/finances", "/business/mercury/sync", "/business/finance/statusx"])
    expect(await handleLegacyNabRoute({ method: "GET", path }, fixture.deps)).toBeUndefined();
  expect(fixture.seen.financeBuilt).toBe(0);
});

test("Jarvis finance answers say live NAB is off and open no storage while unauthorised", async () => {
  const root = temp("nab-jarvis-");
  const { client, calls } = spyClient();
  const said = await answerFinanceIntent({ kind: "balance" }, createFinanceSync(root, { client }));
  expect(said).toMatch(/switched off/);
  expect(calls).toEqual([]);
  expect(storageTouched(root)).toBe(false);
});

// --- Characterisation: what the gate is protecting ------------------------------------------

test("only a code-level reviewed authorisation re-enables the legacy exposure (provider call, state write, storage open)", async () => {
  const fixture = routeFixture(syntheticAuthorisation());
  const { base, close } = await serve(fixture.deps);
  try {
    const connect = await fetch(base + "/business/finance/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.invalid" }) });
    expect(connect.status).toBe(200);
    expect(fixture.calls).toContain("createUser"); // provider call
    expect(existsSync(join(fixture.root, ".operator-data", "finance.json"))).toBe(true); // private state write
    const status = await fetch(base + "/business/finance/status");
    expect(status.status).toBe(200);
    expect(existsSync(join(fixture.root, ".operator-data", "finance.sqlite"))).toBe(true); // storage open
  } finally { await close(); }
  const partial = routeFixture(syntheticAuthorisation({ capabilities: ["status"] }));
  const reply = await handleLegacyNabRoute({ method: "POST", path: "/business/finance/sync", body: {} }, partial.deps);
  expect(reply).toMatchObject({ status: 403, body: { code: "nab_legacy_capability_not_authorised" } });
  expect(partial.seen.financeBuilt).toBe(0);
  withIntervalSpy((started) => {
    const stop = createFinanceSync(temp("nab-schedule-admitted-"), { client: spyClient().client, authorisation: syntheticAuthorisation(), now: () => NOW } as any).schedule(1000);
    expect(started.count).toBe(1); // the background refresh only exists behind the reviewed flag
    stop();
  });
});

// --- The NAB CSV import has ONE path: the Finance page (manual-*.ts) -------------------------

test("the legacy CSV route is retired: 410 with a pointer to Finance, even when a reviewed authorisation admits everything", async () => {
  for (const authorisation of [undefined, syntheticAuthorisation()]) {
    const fixture = routeFixture(authorisation);
    const reply = await handleLegacyNabRoute({ method: "POST", path: "/business/finance/import-csv", body: { filename: "NAB-synthetic.csv", content: SYNTHETIC_CSV } }, fixture.deps);
    expect(reply).toMatchObject({ status: 410, body: { code: "nab_csv_moved", refused: true, moved: "/__finance_manual/import" } });
    expect(fixture.seen).toEqual({ financeBuilt: 0, imported: 0 });
    expect(storageTouched(fixture.root)).toBe(false);
  }
});

test("the Finance NAB CSV import works with legacy NAB refused and never opens the legacy finance.sqlite", async () => {
  expect(LEGACY_NAB_LIVE_AUTHORISATION).toBeNull();
  const root = temp("nab-finance-csv-");
  const store = openManualFinanceStore(manualFinanceDbPath(root));
  try {
    expect(store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "picker")).toMatchObject({ inserted: 24 });
  } finally { store.close(); }
  expect(existsSync(join(root, ".operator-data", "finance-manual.sqlite"))).toBe(true);
  expect(existsSync(join(root, ".operator-data", "finance.sqlite"))).toBe(false);
});

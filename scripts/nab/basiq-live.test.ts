import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activateLiveNab } from "./basiq-adapter";
import { BASIQ_LIVE_ADMISSION, BASIQ_LIVE_REQUIREMENTS, BasiqLiveRefused, basiqLiveAdmitted, basiqLiveStatus, createBasiqLiveAdapter } from "./basiq-live";
import { legacyNabAdmission } from "../finance/legacy-admission";
import { openManualFinanceStore } from "../finance/manual-store";

test("the code-owned admission is null and the status card says not connected", () => {
  expect(BASIQ_LIVE_ADMISSION).toBeNull();
  expect(basiqLiveAdmitted()).toBe(false);
  expect(basiqLiveStatus()).toMatchObject({ provider: "basiq", connected: false, phase: "not-connected", headline: "Live bank feed: not connected (deferred by owner decision)", fallback: "nab-csv-manual", error: null,
    decision: { kind: "deferred-by-owner", decidedAt: "2026-09-27", route: "nab-csv-manual" } });
  expect(basiqLiveStatus().reason).toMatch(/Basiq production enablement and your consent/);
  expect(BASIQ_LIVE_REQUIREMENTS.join(" ")).toMatch(/production.*commercial.*nominated representative.*consent.*reviewed commit/s);
});

test("every live method refuses before touching the secret, transport or store", async () => {
  let secretReads = 0, calls = 0;
  const store = openManualFinanceStore(":memory:");
  const adapter = createBasiqLiveAdapter({
    token: { kind: "secret-ref", name: "BASIQ_API_KEY" },
    resolveSecret: () => { secretReads++; return "SENTINEL-SECRET-VALUE"; },
    transport: (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch,
    store,
  });
  for (const run of [() => adapter.sync("usman"), () => adapter.startConsent("usman"), () => adapter.revoke("usman")]) {
    await expect(run()).rejects.toBeInstanceOf(BasiqLiveRefused);
  }
  expect({ secretReads, calls, rows: store.count("usman") }).toEqual({ secretReads: 0, calls: 0, rows: 0 });
  expect(JSON.stringify(adapter.status())).not.toContain("SENTINEL-SECRET-VALUE");
});

test("even a well-formed injected admission reaches only unimplemented stubs (no live code exists)", async () => {
  const adapter = createBasiqLiveAdapter({
    token: { kind: "secret-ref", name: "BASIQ_API_KEY" }, resolveSecret: () => null,
    transport: (() => { throw new Error("transport must not be called"); }) as unknown as typeof fetch,
    store: openManualFinanceStore(":memory:"),
    admission: { kind: "basiq-live-admission/v1", reviewRef: "synthetic", approvedBy: "owner", approvedAt: "2026-09-27T00:00:00Z", productionEnabledEvidence: "synthetic", ownerConsentEvidence: "synthetic", scopes: ["accounts"] },
  });
  await expect(adapter.sync("usman")).rejects.toThrow("BASIQ_LIVE_SYNC_NOT_IMPLEMENTED");
  await expect(adapter.startConsent("usman")).rejects.toThrow("BASIQ_LIVE_CONSENT_IS_OWNER_ACTION");
});

test("legacy NAB routes stay fail-closed and activateLiveNab() still throws", () => {
  expect(() => activateLiveNab()).toThrow("LIVE_NAB_NOT_AUTHORISED_OR_IMPLEMENTED");
  for (const cap of ["status", "connect", "sync", "summary", "import-csv", "schedule"] as const) expect(legacyNabAdmission(cap).admitted).toBe(false);
});

test("the skeleton has no network, env or config access of its own", () => {
  const src = readFileSync(join(import.meta.dir, "basiq-live.ts"), "utf8");
  expect(src).not.toMatch(/\bfetch\(|process\.env|readFileSync|agentic-os\.env|https:\/\//);
});

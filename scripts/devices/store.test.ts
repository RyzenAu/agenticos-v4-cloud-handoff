import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_MAX_FAILURES, CODE_TTL_MS, DeviceStore, SESSION_TTL_MS } from "./store";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function fresh(start = 1_700_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), "devices-store-"));
  roots.push(root);
  let t = start;
  const store = new DeviceStore(root, { now: () => t });
  return { root, store, advance: (ms: number) => (t += ms) };
}

describe("sessions (30-day signed cookie)", () => {
  test("a minted session verifies; only its hash is stored", () => {
    const { store } = fresh();
    const { cookie, session } = store.mintSession("mehroz", "Study PC", "tailnet");
    expect(store.verifySession(cookie)?.personId).toBe("mehroz");
    const onDisk = readFileSync(store.file, "utf8");
    expect(onDisk).not.toContain(cookie.split(".")[0]);
    expect(onDisk).toContain(session.id);
    expect(session.expiresAt - session.createdAt).toBe(SESSION_TTL_MS);
  });
  test("a tampered or foreign cookie is rejected", () => {
    const { store } = fresh();
    const { cookie } = store.mintSession("usman", "Phone", "tailnet");
    const [secret, sig] = cookie.split(".");
    expect(store.verifySession(`${secret}x.${sig}`)).toBeNull();
    expect(store.verifySession(`${secret}.${sig.slice(1)}A`)).toBeNull();
    expect(store.verifySession("nonsense")).toBeNull();
    expect(store.verifySession("")).toBeNull();
    // Same cookie against another install's secret.
    const other = fresh();
    expect(other.store.verifySession(cookie)).toBeNull();
  });
  test("expires after exactly 30 days, and use does not extend it", () => {
    const { store, advance } = fresh();
    const { cookie } = store.mintSession("mehroz", "Laptop", "code");
    advance(SESSION_TTL_MS - 1000);
    expect(store.verifySession(cookie)).not.toBeNull();
    advance(1000);
    expect(store.verifySession(cookie)).toBeNull();
  });
  test("revocation is immediate", () => {
    const { store } = fresh();
    const { cookie, session } = store.mintSession("mehroz", "Laptop", "code");
    store.revokeSession(session.id);
    expect(store.verifySession(cookie)).toBeNull();
    expect(store.sessions("mehroz")[0].revokedAt).toBeDefined();
  });
});

describe("one-time pairing codes", () => {
  test("single use, purpose-bound, case/dash-insensitive", () => {
    const { store } = fresh();
    const { code } = store.createCode("mehroz", "browser", "mehroz");
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(store.redeemCode(code, "companion").ok).toBe(false);
    const again = store.createCode("mehroz", "browser", "mehroz").code;
    expect(store.redeemCode(again.toLowerCase().replace("-", " "), "browser")).toEqual({ ok: true, personId: "mehroz" });
    expect(store.redeemCode(again, "browser").ok).toBe(false);
  });
  test("expires after 10 minutes", () => {
    const { store, advance } = fresh();
    const { code } = store.createCode("usman", "companion", "usman");
    advance(CODE_TTL_MS + 1);
    expect(store.redeemCode(code, "companion").ok).toBe(false);
  });
  test("five wrong codes lock redemption, even for a right code", () => {
    const { store, advance } = fresh();
    const { code } = store.createCode("mehroz", "browser", "usman");
    for (let i = 0; i < CODE_MAX_FAILURES; i++) expect(store.redeemCode("AAAA-AAAA", "browser").ok).toBe(false);
    const locked = store.redeemCode(code, "browser");
    expect(locked.ok).toBe(false);
    advance(10 * 60 * 1000 + 1);
    const fresh2 = store.createCode("mehroz", "browser", "usman").code;
    expect(store.redeemCode(fresh2, "browser").ok).toBe(true);
  });
});

describe("companions", () => {
  test("token verifies, is stored hashed, expires in 30 days, can be revoked", () => {
    const { store, advance } = fresh();
    const { device, token } = store.registerCompanion("mehroz", { label: "Mehroz's PC", aliases: ["pc", "desktop"] });
    expect(device.primary).toBe(true);
    expect(readFileSync(store.file, "utf8")).not.toContain(token);
    expect(store.verifyCompanion(token)?.id).toBe(device.id);
    expect(store.verifyCompanion("wrong")).toBeNull();
    const second = store.registerCompanion("mehroz", { label: "Mehroz's laptop", aliases: ["laptop"] });
    expect(second.device.primary).toBe(false);
    store.revokeCompanion(second.device.id);
    expect(store.verifyCompanion(second.token)).toBeNull();
    advance(SESSION_TTL_MS);
    expect(store.verifyCompanion(token)).toBeNull();
  });
  test("Usman's companions are never primary (his hub PC is)", () => {
    const { store } = fresh();
    expect(store.registerCompanion("usman", { label: "Usman's laptop" }).device.primary).toBe(false);
  });
});

test("finance grants: only non-owners can be granted, default none", () => {
  const { store } = fresh();
  expect(store.policy().financeGrants).toEqual([]);
  store.setFinanceGrant("usman", true);
  expect(store.policy().financeGrants).toEqual([]);
  store.setFinanceGrant("mehroz", true);
  expect(store.policy().financeGrants).toEqual(["mehroz"]);
  store.setFinanceGrant("mehroz", false);
  expect(store.policy().financeGrants).toEqual([]);
});

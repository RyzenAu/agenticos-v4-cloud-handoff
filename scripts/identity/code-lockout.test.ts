import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicesService, type DevicesService } from "../devices/service";
import { setActiveRegistry } from "../devices/registry";
import { CODE_LOCK_MS, CODE_MAX_FAILURES, DeviceStore, HUB_CONFIRM_MAX_FAILURES } from "../devices/store";
import { syntheticTailnetForTests } from "../remote-access";
import { createPrincipalGate, under } from "./gate";

/**
 * REVIEW-S1 R2-2: one requester's wrong codes lock out only that requester, in that flow.
 *
 * Before: one shared `codeFailures` list. A local program that forged a page navigation (a PENDING hub
 * session) submitted 5 wrong confirm codes and locked out, for 10 minutes and repeatably, both the
 * owner's genuine new-browser confirm and Mehroz's /pair/redeem. Now: a pending hub session gets three
 * wrong codes and is revoked; browser pairing and companion pairing count per verified person. The
 * brute-force limits stay (per scope), and a forged navigation buys only three guesses.
 */

const TAILNET = "lockout-hub.tail-test.ts.net";
const INTERNAL = "lockout-internal-page-token";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
const TAILNET_STATUS = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);
const SOURCE = { usman: "100.64.0.11", mehroz: "100.64.0.12" };

let root: string;
let server: Server;
let base: string;
let store: DeviceStore;
let devices: DevicesService;
let ownerCookie = "";

type Mount = { path: string | null; fn: (req: IncomingMessage, res: ServerResponse, next: () => unknown) => unknown };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "code-lockout-"));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }),
  );
  store = new DeviceStore(root);
  const mounts: Mount[] = [];
  mounts.push({ path: null, fn: createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: () => true, tailnet: TAILNET_STATUS }) });
  devices = createDevicesService({ root, token: INTERNAL, tailnetName: TAILNET, store, servePeer: () => true, tailnet: TAILNET_STATUS });
  mounts.push({ path: "/__devices", fn: (r, s, n) => void devices.handle(r, s, n) });
  mounts.push({ path: null, fn: (_r, s) => void s.end("served") });
  server = createServer((r, s) => {
    let i = 0;
    const original = r.url || "/";
    const next = (): unknown => {
      r.url = original;
      const m = mounts[i++];
      if (!m) return s.end();
      if (m.path === null) return m.fn(r, s, next);
      if (!under(original.split("?")[0], m.path)) return next();
      r.url = original.slice(m.path.length) || "/";
      return m.fn(r, s, next);
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ownerCookie = await navigate(); // the first page load at this PC is trusted on first use
}, 60_000);

afterAll(async () => {
  devices?.close();
  setActiveRegistry(undefined);
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

const local = () => ({ host: `127.0.0.1:${new URL(base).port}` });
/** A page navigation at this PC (any local program can send these two headers): mints a hub session. */
async function navigate() {
  const res = await fetch(base + "/", { headers: { ...local(), "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
  return (res.headers.getSetCookie().find((c) => c.startsWith("mu_session=")) ?? "").split(";")[0];
}
async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const h = { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const program = (cookie = "") => ({ ...local(), "x-claude-os-token": INTERNAL, ...(cookie ? { cookie } : {}) });
async function remote(who: "usman" | "mehroz") {
  const h = { host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN[who], "x-forwarded-for": SOURCE[who], "x-forwarded-proto": "https" };
  const token = (await call("GET", "/__token", h)).json.token as string;
  return { ...h, "x-claude-os-token": token };
}
const hubCode = async () => (await call("POST", "/__devices/sessions/confirm-code", program(ownerCookie), {})).json.code as string;
const browserCodeFor = async (personId: "usman" | "mehroz") => (await call("POST", "/__devices/pair/code", program(ownerCookie), { purpose: "browser", personId })).json.code as string;

describe("R2-2: a program's wrong confirm codes lock out nobody else", () => {
  test("a forged pending session's wrong codes: it is revoked at three; the owner's new browser and Mehroz's pairing still work", async () => {
    const ownersNewBrowser = await navigate(); // the owner opens a new browser at this PC: pending
    const forged = await navigate(); // a local program forges a navigation: pending too
    const tries = [];
    for (let i = 0; i < CODE_MAX_FAILURES + 2; i++) tries.push(await call("POST", "/__devices/sessions/confirm", program(forged), { code: "AAAA-AAAA" }));
    expect(tries.every((r) => r.status === 403)).toBe(true);
    expect(tries[HUB_CONFIRM_MAX_FAILURES - 1].json.error).toContain("Too many wrong codes for this browser");
    // The forged session is gone: it can't keep guessing, not even with a real code.
    const me = await call("GET", "/__devices/me", program(forged));
    expect(me.json.session).toBeNull();
    // The owner's genuine confirm is NOT locked out.
    const ok = await call("POST", "/__devices/sessions/confirm", program(ownersNewBrowser), { code: await hubCode() });
    expect([ok.status, ok.json.confirmed?.pending]).toEqual([200, false]);
    // Mehroz's pairing is NOT locked out either.
    const mehroz = await remote("mehroz");
    const paired = await call("POST", "/__devices/pair/redeem", mehroz, { code: await browserCodeFor("mehroz"), label: "Mehroz's laptop" });
    expect([paired.status, paired.json.paired]).toEqual([200, true]);
  });

  test("repeatable forging buys three guesses per navigation and never locks the owner", async () => {
    for (let round = 0; round < 4; round++) {
      const forged = await navigate();
      for (let i = 0; i < HUB_CONFIRM_MAX_FAILURES; i++) await call("POST", "/__devices/sessions/confirm", program(forged), { code: "BBBB-BBBB" });
      expect((await call("GET", "/__devices/me", program(forged))).json.session).toBeNull();
    }
    const ownersNewBrowser = await navigate();
    expect((await call("POST", "/__devices/sessions/confirm", program(ownersNewBrowser), { code: await hubCode() })).status).toBe(200);
  });
});

describe("R2-2: pairing codes lock per person and per flow, and still stop guessing", () => {
  test("Mehroz's own wrong codes lock Mehroz's browser pairing only; Usman's remote pairing is untouched", async () => {
    const mehroz = await remote("mehroz");
    for (let i = 0; i < CODE_MAX_FAILURES; i++) expect((await call("POST", "/__devices/pair/redeem", mehroz, { code: "CCCC-CCCC" })).status).toBe(403);
    // Brute-force protection kept: even his right code now waits.
    const locked = await call("POST", "/__devices/pair/redeem", mehroz, { code: await browserCodeFor("mehroz") });
    expect([locked.status, locked.json.error]).toEqual([403, expect.stringContaining("Too many")]);
    // Usman's own phone, pairing by code over the tailnet (self-pair off for him so the code path is used).
    store.setSelfPair("usman", false);
    try {
      const usman = await remote("usman");
      const paired = await call("POST", "/__devices/pair/redeem", usman, { code: await browserCodeFor("usman") });
      expect([paired.status, paired.json.paired]).toEqual([200, true]);
    } finally {
      store.setSelfPair("usman", true);
    }
  });
});

describe("R2-2: the store's scopes", () => {
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "lockout-store-"));
    mkdirSync(join(dir, ".operator-data"));
    let t = 1_700_000_000_000;
    return { dir, s: new DeviceStore(dir, { now: () => t }), advance: (ms: number) => (t += ms) };
  }

  test("per requester and per flow; someone else's code is a wrong code for you and isn't burnt", () => {
    const { dir, s, advance } = fresh();
    try {
      const forMehroz = s.createCode("mehroz", "browser", "usman").code;
      // Usman presenting Mehroz's code: refused for him, and the code still works for Mehroz.
      expect(s.redeemCode(forMehroz, "browser", "usman").ok).toBe(false);
      for (let i = 0; i < CODE_MAX_FAILURES; i++) s.redeemCode("DDDD-DDDD", "browser", "usman");
      expect(s.redeemCode(forMehroz, "browser", "mehroz")).toEqual({ ok: true, personId: "mehroz" });
      // Usman's browser flow is locked; his companion flow isn't.
      const comp = s.createCode("usman", "companion", "usman").code;
      expect(s.redeemCode(s.createCode("usman", "browser", "usman").code, "browser", "usman").ok).toBe(false);
      expect(s.redeemCode(comp, "companion", "usman").ok).toBe(true);
      // The lock lifts after 10 minutes.
      advance(CODE_LOCK_MS + 1);
      expect(s.redeemCode(s.createCode("usman", "browser", "usman").code, "browser", "usman").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store written before the fix (one shared failure list) loads, and its old list locks nobody", () => {
    const { dir, s } = fresh();
    try {
      s.createCode("mehroz", "browser", "usman");
      const file = JSON.parse(readFileSync(s.file, "utf8"));
      file.codeFailures = [1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000];
      writeFileSync(s.file, JSON.stringify(file));
      expect(s.read().codeFailures).toEqual({});
      expect(s.redeemCode(s.createCode("mehroz", "browser", "usman").code, "browser", "mehroz").ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

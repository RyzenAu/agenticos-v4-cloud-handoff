// /__commands (scripts/commands/plugin.ts): the target preview shows only the signed-in person's own
// devices; the hub's app and file index is served only to the hub's owner; the middleware refuses a
// caller without a verified principal or without their own page token.
import { describe, expect, test } from "bun:test";
import { commandsMiddleware, commandsRoute, previewTarget } from "./commands/plugin";
import { defaultHub, staticRegistry } from "./devices/registry";
import type { Principal } from "./identity/principal";
import type { TargetDevice } from "./devices/types";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman", deviceId: "usman-pc" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
const laptop: TargetDevice = { id: "mehroz-laptop", owner: "mehroz", kind: "companion", label: "Mehroz's laptop", aliases: ["laptop"], primary: true };
const t0 = 1_000_000;
const registry = (online = true) => {
  const r = staticRegistry([defaultHub(), laptop], () => t0);
  if (online) r.heartbeat(laptop.id);
  return r;
};
const deps = (r = registry()) => ({
  registry: () => r,
  apps: async () => [{ name: "PowerPoint", id: "Microsoft.Office.POWERPNT.EXE.15" }, { name: "Notepad", id: "x" }, { name: "PowerPoint", id: "dup" }],
  files: () => ["D:\\tmp\\jarvis-acceptance\\plans\\quarterly-plan.docx"],
  roots: () => ["D:\\tmp\\jarvis-acceptance"],
  platform: "win32",
});
const u = (s: string) => new URL(s, "http://localhost");

describe("target preview", () => {
  test("Usman, 'here' → Usman's PC", () => {
    expect(previewTarget(usman, "here", registry())).toEqual({ ok: true, deviceId: "usman-pc", label: "Usman's PC", owner: "usman", online: true, routing: "devices" });
  });
  test("Mehroz → his own laptop, never the hub", async () => {
    const r = await commandsRoute("/target", u("/target"), mehroz, deps());
    expect(r.body).toMatchObject({ ok: true, deviceId: "mehroz-laptop", owner: "mehroz" });
  });
  test("'here' from Mehroz's laptop session is his laptop", () => {
    expect(previewTarget({ ...mehroz, deviceId: "mehroz-laptop" }, "here", registry())).toMatchObject({ ok: true, deviceId: "mehroz-laptop" });
  });
  test("Mehroz naming Usman's PC is refused and names no device of Usman's", () => {
    const r = previewTarget(mehroz, "on usman's pc", registry());
    expect(r.ok).toBe(false);
    expect("deviceId" in r ? r.deviceId : undefined).toBeUndefined();
  });
  test("Mehroz's laptop offline → fails clearly naming his device; never re-routed to the hub", () => {
    const r = previewTarget(mehroz, undefined, registry(false));
    expect(r).toMatchObject({ ok: false, reason: "device offline", deviceId: "mehroz-laptop", label: "Mehroz's laptop" });
  });
});

describe("own-device indexes", () => {
  test("the hub's owner gets app names (deduplicated, sorted, names only)", async () => {
    const r = await commandsRoute("/apps", u("/apps"), usman, deps());
    expect(r.body).toMatchObject({ state: "live", items: [{ name: "Notepad" }, { name: "PowerPoint" }] });
    expect(JSON.stringify(r.body)).not.toContain("POWERPNT");
  });
  test("someone else gets setup-required with the reason, never the hub's apps or files", async () => {
    for (const path of ["/apps", "/files"]) {
      const r = await commandsRoute(path, u(`${path}?q=plan`), mehroz, deps());
      expect(r.body).toMatchObject({ state: "setup-required", items: [] });
      expect((r.body as { reason: string }).reason).toContain("Usman's PC only");
    }
  });
  test("files: names and root-relative folder, never an absolute path", async () => {
    const r = await commandsRoute("/files", u("/files?q=quarterly"), usman, deps());
    expect(r.body).toMatchObject({ state: "live", items: [{ name: "quarterly-plan.docx", where: "jarvis-acceptance/plans" }] });
    expect(JSON.stringify(r.body)).not.toContain("D:");
  });
  test("an empty app list is 'failed', not an empty live list", async () => {
    const r = await commandsRoute("/apps", u("/apps"), usman, { ...deps(), apps: async () => [] });
    expect(r.body).toMatchObject({ state: "failed" });
  });
});

describe("middleware", () => {
  const call = async (headers: Record<string, string>, url = "/target", method = "GET", remoteAddress = "127.0.0.1") => {
    const mw = commandsMiddleware({ root: process.cwd(), token: () => "internal-token", deps: deps() });
    let status = 0;
    let body = "";
    let nexted = false;
    const res = { statusCode: 0, setHeader() {}, end(b: string) { status = this.statusCode; body = b; } } as never;
    await mw({ url, method, headers: { host: "127.0.0.1:4371", ...headers }, socket: { remoteAddress } } as never, res, () => (nexted = true));
    return { status, body, nexted };
  };
  test("other paths fall through", async () => {
    expect((await call({}, "/nope")).nexted).toBe(true);
  });
  test("no page token → 403; wrong method → 405", async () => {
    expect((await call({})).status).toBe(403);
    expect((await call({ "x-claude-os-token": "wrong" })).status).toBe(403);
    expect((await call({}, "/target", "POST")).status).toBe(405);
  });
  test("the owner at this PC with the internal page token is served", async () => {
    const r = await call({ "x-claude-os-token": "internal-token" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, deviceId: "usman-pc" });
  });
  test("no verified principal (not at this PC, no session) → 401", async () => {
    expect((await call({ "x-claude-os-token": "internal-token" }, "/target", "GET", "100.64.0.9")).status).toBe(401);
  });
});

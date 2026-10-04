// R7 review m3/m4: Sync now tells the truth. A read-only copy is not "switched off", and a missing vault is not a "try again in a moment".
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Readable } from "node:stream";
import { memoryMiddleware } from "./plugin";
import { cleanup, setup, usman } from "./testing/harness";

afterEach(cleanup);

async function post(mw: ReturnType<typeof memoryMiddleware>, url: string) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req = Object.assign(Readable.from([Buffer.from("{}")]), {
      method: "POST",
      url,
      headers: { host: "localhost:8081", "content-type": "application/json", "x-claude-os-token": "t" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 200;
    mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end(text?: string) { resolve({ status, body: text ? JSON.parse(text) : {} }); } } as never, () => resolve({ status: 404, body: {} }));
  });
}

test("sync on a read-only copy says this hub reads the vault, not that saving is switched off", async () => {
  const h = await setup({ proxy: true });
  const api = { ...h.api, settings: { ...h.api.settings, mode: "read" as const, writes: false } };
  const r = await post(memoryMiddleware({ api: () => api as never, principalFor: () => usman, tokenOk: () => true }), "/sync");
  expect(r.status).toBe(409);
  expect(r.body.code).toBe("memory-read-only");
  expect(r.body.message).toMatch(/reads the shared vault/);
  expect(r.body.message).not.toMatch(/switched off/);
});

test("sync with the vault missing is a plain 'can't reach the vault', not 'try again'", async () => {
  const h = await setup({ proxy: true });
  rmSync(h.api.paths.vaultRoot, { recursive: true, force: true });
  const r = await post(memoryMiddleware({ api: () => h.api, principalFor: () => usman, tokenOk: () => true }), "/sync");
  expect(r.status).toBe(503);
  expect(r.body.code).toBe("vault-unavailable");
  expect(r.body.message).not.toMatch(/try again|moment/i);
});

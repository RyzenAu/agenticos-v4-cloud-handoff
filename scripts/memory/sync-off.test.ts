// R7 audit 2 item 6: with saving switched off a forced sync answered 500 "Memory is unavailable". It is now a plain 409 refusal the page shows as-is,
// and with saving on it still works.
import { afterEach, expect, test } from "bun:test";
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

test("sync with saving off is a 409 refusal in plain words (never a 500); with saving on it syncs", async () => {
  const off = await setup({ writes: false, hindsight: false }); // the switch really is off (writes:false alone is read mode, which sync-honest.test.ts covers)
  const mwOff = memoryMiddleware({ api: () => off.api, principalFor: () => usman, tokenOk: () => true });
  const refused = await post(mwOff, "/sync");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ ok: false, code: "memory-off" });
  expect(refused.body.message).toBe("Saving to shared memory is switched off on this hub, so there is nothing to sync.");
  expect(JSON.stringify(refused.body)).not.toMatch(/MU_MEMORY_WRITES|unavailable/);

  const on = await setup({ proxy: true });
  const mwOn = memoryMiddleware({ api: () => on.api, principalFor: () => usman, tokenOk: () => true });
  const ok = await post(mwOn, "/sync");
  expect(ok.status).toBe(200);
  expect(ok.body.ok).toBe(true);
});

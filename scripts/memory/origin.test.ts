// REVIEW-STAGE-D B1: /__memory refuses other origins by itself (defence in depth behind the identity
// gate), and with tokenOk every POST needs the caller's own page token.
import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { memoryMiddleware } from "./plugin";
import { cleanup, setup, usman } from "./testing/harness";

afterEach(cleanup);

async function hit(mw: ReturnType<typeof memoryMiddleware>, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<number>((resolve) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method,
      url,
      headers: { host: "localhost:8081", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 200;
    mw(req as never, { set statusCode(s: number) { status = s; }, setHeader() {}, end() { resolve(status); } } as never, () => resolve(404));
  });
}

describe("memory routes: same origin only, page token on every POST", () => {
  test("another localhost port, a foreign Origin or a cross-site fetch is refused; the own origin works", async () => {
    const h = await setup({ proxy: true });
    const mw = memoryMiddleware({ api: () => h.api, principalFor: () => usman, tokenOk: (req) => req.headers["x-claude-os-token"] === "synthetic-page-token" });
    const token = { "x-claude-os-token": "synthetic-page-token" };
    for (const headers of [
      { origin: "http://localhost:5173", "sec-fetch-site": "same-site" },
      { origin: "http://localhost:5173" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "http://evil.example" },
    ]) {
      expect(await hit(mw, "GET", "/items", headers)).toBe(403);
      expect(await hit(mw, "POST", "/remember", { ...headers, ...token }, { text: "Cross-origin synthetic note." })).toBe(403);
    }
    expect(h.api.list({ q: "Cross-origin synthetic" })).toEqual([]);
    expect(await hit(mw, "GET", "/items", { origin: "http://localhost:8081", "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await hit(mw, "GET", "/items", { origin: "https://localhost:8081" })).toBe(200); // Serve's https own origin
    // Every POST needs the token, not only the approval steps.
    expect(await hit(mw, "POST", "/recall", {}, { query: "x" })).toBe(403);
    expect(await hit(mw, "POST", "/forget", {}, { kind: "unindex", target: "n-proposal-terms" })).toBe(403);
    expect(await hit(mw, "POST", "/remember", token, { text: "The synthetic Oriole desk opens at 8am." })).toBe(200);
  });
});

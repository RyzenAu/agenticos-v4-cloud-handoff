import { describe, expect, test } from "bun:test";
import { versionEndpoint, versionInfo } from "./version";

describe("versionInfo", () => {
  test("reads a real semver-ish version and a short git SHA", async () => {
    const info = await versionInfo();
    expect(info.version).not.toBe("unknown");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.gitSha).not.toBe("unknown");
    expect(info.gitSha).toMatch(/^[0-9a-f]{7,}$/);
    expect(() => new Date(info.buildTime).toISOString()).not.toThrow();
    expect(typeof info.dirty).toBe("boolean");
  });

  test("is cached across calls (same object identity)", async () => {
    expect(versionInfo()).toBe(versionInfo());
    expect(await versionInfo()).toBe(await versionInfo());
  });
});

describe("versionEndpoint", () => {
  function fakeRes() {
    const headers: Record<string, string> = {};
    let statusCode: number | undefined;
    let body: string | undefined;
    return {
      res: {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
        end: (b?: string) => {
          body = b;
        },
        get statusCode() {
          return statusCode;
        },
        set statusCode(value: number | undefined) {
          statusCode = value;
        },
      },
      headers,
      body: () => body,
      statusCode: () => statusCode,
    };
  }

  test("rejects non-loopback callers with 403 and no body leak", () => {
    const handler = versionEndpoint(() => false);
    const { res, body, statusCode } = fakeRes();
    let calledNext = false;
    handler({ method: "GET" }, res, () => (calledNext = true));
    expect(statusCode()).toBe(403);
    expect(body()).toBe(JSON.stringify({ error: "loopback only" }));
    expect(calledNext).toBe(false);
  });

  test("serves version JSON for loopback GET requests", async () => {
    const handler = versionEndpoint(() => true);
    const { res, body, headers } = fakeRes();
    handler({ method: "GET" }, res, () => {});
    await versionInfo();
    await Bun.sleep(0);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(body() ?? "{}")).toEqual(await versionInfo());
  });

  test("falls through to next() for non-GET methods", () => {
    const handler = versionEndpoint(() => true);
    const { res, body } = fakeRes();
    let calledNext = false;
    handler({ method: "POST" }, res, () => (calledNext = true));
    expect(calledNext).toBe(true);
    expect(body()).toBeUndefined();
  });
});

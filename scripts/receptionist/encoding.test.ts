import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { receptionistMiddleware } from "./plugin";
import { buildReceptionistSnapshot } from "./aggregate";
import { inputs, NOW } from "./aggregate.test";

test("JSON declares UTF-8 so legacy HTTP clients preserve separators and masked phones", async () => {
  // Exercise actual producer strings (readiness separators and aggregate phone masking).
  const fixture = buildReceptionistSnapshot(inputs(), NOW);
  const headers: Record<string, string> = {};
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/", headers: { host: "127.0.0.1:8081" }, socket: { remoteAddress: "127.0.0.1" } });
  const body = await new Promise<string>(resolve => receptionistMiddleware({ get: async () => fixture } as any, "fixture")(req as any, {
    setHeader: (key: string, value: string) => { headers[key] = value; }, end: resolve,
  } as any, () => { throw Error("Unexpected next"); }));
  // Windows PowerShell's legacy HTTP reader defaults to a single-byte encoding without charset.
  const legacyDecode = (contentType: string) => new TextDecoder(
    /charset=([^;]+)/i.exec(contentType)?.[1] ?? "windows-1252",
  ).decode(Buffer.from(body, "utf8"));
  // Original path: correct UTF-8 source -> JSON UTF-8 bytes -> missing charset -> ANSI decode.
  expect(body).toContain("·");
  expect(body).toContain("••• 208");
  expect(body).not.toContain("Â·");
  expect(legacyDecode("application/json")).toContain("Â·");
  expect(legacyDecode("application/json")).not.toContain("••• 208");
  const decoded = legacyDecode(headers["Content-Type"]);
  expect(JSON.parse(decoded)).toEqual(JSON.parse(JSON.stringify(fixture)));
  expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
  expect(decoded).not.toMatch(/Â|â€/);
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalRequest, safeAssetPath } from "../src/motion/server/util";

const root = mkdtempSync(join(tmpdir(), "motion-boundaries-"));
const studio = join(root, "studio");
const assets = join(studio, "assets");
mkdirSync(assets, { recursive: true });
const env = { MOTION_STUDIO_HOME: studio };
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Motion asset boundaries", () => {
  test("accepts a regular asset, rejects external paths, directories and missing files", () => {
    const file = join(assets, "synthetic.png");
    writeFileSync(file, "synthetic image fixture");
    expect(safeAssetPath(file, env)).toBe(realpathSync(file));
    expect(safeAssetPath(assets, env)).toBeNull();
    expect(safeAssetPath(join(assets, "missing.png"), env)).toBeNull();
    expect(safeAssetPath("bad\0path", env)).toBeNull();
    const sibling = join(studio, "assets-other");
    mkdirSync(sibling);
    const external = join(sibling, "synthetic-private.txt");
    writeFileSync(external, "synthetic private fixture");
    expect(safeAssetPath(external, env)).toBeNull();
    expect(safeAssetPath(join(assets, "..", "assets-other", "synthetic-private.txt"), env)).toBeNull();
  });

  // Symlinks need admin or Developer Mode on Windows; the realpath check is the same code.
  test.skipIf(process.platform === "win32")("rejects an asset symlink that escapes the canonical root", () => {
    const outside = join(root, "synthetic-private.txt");
    writeFileSync(outside, "synthetic private fixture");
    const link = join(assets, "linked.png");
    symlinkSync(outside, link);
    expect(safeAssetPath(link, env)).toBeNull();
    const linkedDirectory = join(assets, "linked-folder");
    symlinkSync(root, linkedDirectory);
    expect(safeAssetPath(join(linkedDirectory, "synthetic-private.txt"), env)).toBeNull();
  });
});

function request(headers: Record<string, string> = {}, peer = "127.0.0.1") {
  return { headers: { host: "localhost:8081", ...headers }, socket: { remoteAddress: peer } } as IncomingMessage;
}

describe("Motion request boundaries", () => {
  test("accepts loopback browser requests and direct local clients", () => {
    expect(isLocalRequest(request())).toBe(true);
    expect(isLocalRequest(request({ origin: "http://localhost:8081", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isLocalRequest(request({}, "::1"))).toBe(true);
    expect(isLocalRequest(request({}, "::ffff:127.0.0.1"))).toBe(true);
  });

  test("rejects remote sockets even with forged localhost headers", () => {
    expect(isLocalRequest(request({ origin: "http://localhost:8081" }, "203.0.113.9"))).toBe(false);
    expect(isLocalRequest({ headers: { host: "localhost:8081" } } as IncomingMessage)).toBe(false);
  });

  test("rejects foreign hosts, ports, origins and browser cross-site requests", () => {
    expect(isLocalRequest(request({ host: "localhost.attacker.test:8081" }))).toBe(false);
    expect(isLocalRequest(request({ host: "attacker.test:8081" }))).toBe(false);
    expect(isLocalRequest(request({ origin: "http://localhost:8082" }))).toBe(false);
    expect(isLocalRequest(request({ origin: "https://attacker.test" }))).toBe(false);
    expect(isLocalRequest(request({ origin: "null" }))).toBe(false);
    expect(isLocalRequest(request({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isLocalRequest(request({ "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});

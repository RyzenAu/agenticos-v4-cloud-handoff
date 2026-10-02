import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "./config";

// The browser's profile and session are per companion, outside the source checkout, and never invented from a bad value.
const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function cfg(browser: unknown) {
  const d = mkdtempSync(join(tmpdir(), "browser-cfg-"));
  dirs.push(d);
  writeFileSync(join(d, "companion.json"), JSON.stringify({ hubUrl: "http://127.0.0.1:1", deviceId: "usman-x", owner: "usman", label: "PC", token: "t", expiresAt: 1, pairedAt: 1, browser }));
  return readConfig(d)!;
}
const checkout = resolve(import.meta.dir, "..");

describe("companion.json browser settings", () => {
  test("a profile folder outside the checkout, a port and a session label are kept", () => {
    expect(cfg({ port: 9334, profileDir: "D:\\scratch\\profile-a", session: "companion-usman-x" }).browser).toEqual({ port: 9334, profileDir: "D:\\scratch\\profile-a", session: "companion-usman-x" });
  });
  test("a profile inside the source checkout (it would hold cookies next to code that gets committed) is dropped", () => {
    expect(cfg({ profileDir: join(checkout, ".operator-data", "profile") }).browser).toEqual({});
    expect(cfg({ profileDir: checkout }).browser).toEqual({});
  });
  test("a relative profile, a reserved port and an odd session label are dropped", () => {
    expect(cfg({ profileDir: "relative\\dir", port: 80, session: "bad name; rm" }).browser).toEqual({});
  });
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { backupDataDir } from "./backup";
import { DeviceStore } from "../devices/store";

/**
 * R7 review (restore security): a restore onto another folder or machine signs everyone out by default (`--fresh-sessions`); same-machine disaster
 * recovery keeps people signed in only with an explicit `--keep-sessions`. These run the real CLI against a real backup of a synthetic data folder.
 */
const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "restore-sessions-"));
  made.push(root);
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const store = new DeviceStore(data, { file: join(data, "devices.json"), secretFile: join(data, "devices-secret") });
  const session = store.mintSession("usman", "Study PC", "hub");
  const pairing = store.mintSession("mehroz", "Phone", "tailnet");
  const code = store.createCode("mehroz", "browser", "usman").code;
  writeFileSync(join(data, "note.json"), JSON.stringify({ keep: "me" }));
  const { dir } = backupDataDir({ dataDir: data, outRoot: join(root, "backups"), gitSha: null, hubRole: "server" });
  return { root, data, dir, session, pairing, code, secret: readFileSync(join(data, "devices-secret")) };
}
const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/cloud/backup-cli.ts", ...args], { cwd: join(import.meta.dir, "..", ".."), encoding: "utf8" });
const storeAt = (dir: string) => new DeviceStore(dir, { file: join(dir, "devices.json"), secretFile: join(dir, "devices-secret") });

test("--fresh-sessions signs everyone out: secret rotated, sessions revoked, unused codes dropped, other data intact", () => {
  const f = fixture();
  const to = join(f.root, "restored");
  const r = cli("restore", "--from", f.dir, "--to", to, "--fresh-sessions");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("sessions: fresh");
  expect(r.stdout).toMatch(/2 browser session\(s\) revoked, 1 unused pairing code\(s\) dropped/);
  const after = storeAt(to);
  expect(after.verifySession(f.session.cookie)).toBeNull(); // the old cookie no longer opens the hub
  expect(after.verifySession(f.pairing.cookie)).toBeNull();
  expect(readFileSync(join(to, "devices-secret")).equals(f.secret)).toBe(false); // a new signing secret
  expect(after.sessions().every((s) => !!s.revokedAt)).toBe(true);
  expect(after.redeemCode(f.code, "browser", "mehroz").ok).toBe(false);
  expect(JSON.parse(readFileSync(join(to, "note.json"), "utf8"))).toEqual({ keep: "me" });
  // a person can still sign in again afterwards
  expect(after.verifySession(after.mintSession("usman", "New PC", "hub").cookie)).not.toBeNull();
});

test("--keep-sessions is the explicit same-machine option: everyone stays signed in, the code still works", () => {
  const f = fixture();
  const to = join(f.root, "restored");
  const r = cli("restore", "--from", f.dir, "--to", to, "--keep-sessions");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("sessions: kept");
  const after = storeAt(to);
  expect(after.verifySession(f.session.cookie)).not.toBeNull();
  expect(readFileSync(join(to, "devices-secret")).equals(f.secret)).toBe(true);
  expect(after.redeemCode(f.code, "browser", "mehroz").ok).toBe(true);
});

test("neither option is refused (production must never be signed out, or left signed in, by accident); asking for both is refused too", () => {
  const f = fixture();
  const none = cli("restore", "--from", f.dir, "--to", join(f.root, "a"));
  expect(none.status).not.toBe(0);
  expect(none.stderr).toContain("--keep-sessions");
  expect(none.stderr).toContain("--fresh-sessions");
  expect(() => readFileSync(join(f.root, "a", "devices.json"))).toThrow(); // nothing was restored
  const both = cli("restore", "--from", f.dir, "--to", join(f.root, "b"), "--fresh-sessions", "--keep-sessions");
  expect(both.status).not.toBe(0);
  expect(both.stderr).toContain("contradict");
  expect(() => readFileSync(join(f.root, "b", "devices.json"))).toThrow();
});

// R8 F: retention must not remove a good backup to make room for one that fails verification.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDataDir, pruneAfterVerifiedBackup } from "./backup";

const TMP_BASE = existsSync("D:/") ? "D:/tmp" : tmpdir();
let work: string;
beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  work = mkdtempSync(join(TMP_BASE, "mu-prune-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function seed() {
  const live = join(work, "live");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "notes.json"), JSON.stringify({ a: 1 }));
  const out = join(work, "backups");
  const at = (i: number) => () => new Date(Date.UTC(2026, 9, 1, 3, 0, i));
  return { live, out, at };
}

test("a verified new backup prunes down to keep", () => {
  const { live, out, at } = seed();
  backupDataDir({ dataDir: live, outRoot: out, now: at(0) });
  backupDataDir({ dataDir: live, outRoot: out, now: at(1) });
  const { dir } = backupDataDir({ dataDir: live, outRoot: out, now: at(2) });
  const r = pruneAfterVerifiedBackup(out, 2, dir);
  expect(r.verified.ok).toBe(true);
  expect(r.removed).toEqual(["backup-20261001T030000Z"]);
  expect(readdirSync(out).sort()).toEqual(["backup-20261001T030001Z", "backup-20261001T030002Z"]);
});

test("a new backup that fails verification removes nothing: the older good ones stay", () => {
  const { live, out, at } = seed();
  backupDataDir({ dataDir: live, outRoot: out, now: at(0) });
  backupDataDir({ dataDir: live, outRoot: out, now: at(1) });
  const { dir } = backupDataDir({ dataDir: live, outRoot: out, now: at(2) });
  writeFileSync(join(dir, "notes.json"), "damaged on the way to the disk");
  const r = pruneAfterVerifiedBackup(out, 1, dir);
  expect(r.verified.ok).toBe(false);
  expect(r.removed).toEqual([]);
  expect(readdirSync(out).length).toBe(3);
});

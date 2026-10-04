#!/usr/bin/env bun
// Command line for scripts/cloud/backup.ts. Prints paths, counts and checksums-verified lines only.
//
//   bun scripts/cloud/backup-cli.ts backup  [--data-dir D] --out ROOT [--keep N]
//   bun scripts/cloud/backup-cli.ts verify  --from BACKUP_FOLDER
//   bun scripts/cloud/backup-cli.ts restore --from BACKUP_FOLDER --to EMPTY_DIR (--keep-sessions | --fresh-sessions)
//
//   restore REQUIRES one of the two session options (it refuses with neither, so a rollback can never sign production out by accident):
//     --keep-sessions   leave every login as in the backup: production rollback / same-machine disaster recovery
//     --fresh-sessions  rotate the session signing secret, revoke every browser session and drop unused pairing codes: test restores and any
//                       restore onto another machine, where the old logins must not stay alive
//
// --data-dir defaults to MU_DATA_DIR, then <repo>/.operator-data.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDataDir, pruneAfterVerifiedBackup, readManifest, restoreBackup, verifyAgainstManifest } from "./backup";
import { dataDirFor } from "./data-dir";
import { DeviceStore } from "../devices/store";
import { hubRole } from "./hub-role";
import { gitHeadShortSha } from "../nonblocking-exec";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

try {
  if (cmd === "backup") {
    const out = flag("--out") ?? fail("backup needs --out <folder outside the data directory>");
    const dataDir = flag("--data-dir") ?? dataDirFor(REPO);
    const { dir, manifest } = backupDataDir({ dataDir, outRoot: out, gitSha: gitHeadShortSha(REPO) || null, hubRole: hubRole() });
    console.log(`backup: ${dir}`);
    console.log(`files: ${manifest.totals.files} (${manifest.totals.sqliteStores} SQLite stores), ${manifest.totals.bytes} bytes`);
    for (const f of manifest.files.filter((x) => x.kind === "sqlite")) {
      const rows = Object.values(f.tables ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0);
      console.log(`  ${f.path}: ${Object.keys(f.tables ?? {}).length} tables, ${rows} rows`);
    }
    const keep = flag("--keep");
    if (keep) {
      // Verify the new backup before anything older is removed: a bad backup must never push a good one out.
      const { verified, removed } = pruneAfterVerifiedBackup(out, Number(keep), dir);
      if (!verified.ok) fail(`backup written but FAILED verification, nothing pruned: ${verified.problems.slice(0, 5).join("; ")}`);
      if (removed.length) console.log(`pruned: ${removed.join(", ")}`);
    }
  } else if (cmd === "verify") {
    const from = flag("--from") ?? fail("verify needs --from <backup folder>");
    const r = verifyAgainstManifest(readManifest(from), from);
    console.log(r.ok ? `verified: ${r.checked} files match the manifest` : `FAILED: ${r.problems.join("; ")}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "restore") {
    const from = flag("--from") ?? fail("restore needs --from <backup folder>");
    const to = flag("--to") ?? fail("restore needs --to <empty, isolated folder>");
    if (args.includes("--fresh-sessions") && args.includes("--keep-sessions")) fail("--fresh-sessions and --keep-sessions contradict each other.");
    if (!args.includes("--fresh-sessions") && !args.includes("--keep-sessions")) fail("restore needs --keep-sessions (production rollback: everyone stays signed in) or --fresh-sessions (test or other-machine restore: everyone is signed out).");
    const keep = args.includes("--keep-sessions");
    const r = restoreBackup({ backupDir: from, targetDir: to });
    console.log(`restored: ${r.targetDir} (${r.files} files, checksums ${r.verified.ok ? "verified" : "FAILED"})`);
    for (const s of r.stores) console.log(`  ${s.path}: ${s.tables} tables, ${s.rows} rows, ${s.matches ? "matches manifest" : "MISMATCH"}`);
    if (!r.verified.ok || r.stores.some((s) => !s.matches)) process.exit(1);
    if (keep) console.log("sessions: kept as in the backup (--keep-sessions): everyone who was signed in stays signed in");
    else {
      const done = new DeviceStore(r.targetDir, { file: join(r.targetDir, "devices.json"), secretFile: join(r.targetDir, "devices-secret") }).freshenForRestore();
      console.log(`sessions: fresh: signing secret rotated, ${done.sessionsRevoked} browser session(s) revoked, ${done.codesDropped} unused pairing code(s) dropped; sign in again (--keep-sessions to keep them)`);
    }
    console.log(`next: start the hub with MU_DATA_DIR=${join(r.targetDir)} (deploy/README.md, Restore)`);
  } else {
    fail("usage: backup-cli.ts backup|verify|restore (see the header of this file)");
  }
} catch (e) {
  fail(`error: ${(e as Error).message}`);
}

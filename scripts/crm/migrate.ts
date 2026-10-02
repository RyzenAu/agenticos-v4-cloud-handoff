/** Safe migration command: dry run by default. Uses the existing authoritative SQLite file.
 * bun scripts/crm/migrate.ts --db <crm.sqlite>
 * bun scripts/crm/migrate.ts --db <copy.sqlite> --apply --backup <new-backup.sqlite>
 * bun scripts/crm/migrate.ts --db <disposable.sqlite> --rollback --disposable --acknowledge-data-loss
 * Restore: stop the hub, retain the current DB/WAL/SHM together for diagnosis, restore the
 * verified backup as crm.sqlite without stale WAL/SHM siblings, then start the previous build.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dryRunMigration, migrateCrm, rollbackCrm } from "./migrations";
export function migrationMain(args: string[]): void {
  const after = (flag: string) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : (args[at + 1] ?? null);
  };
  const path = after("--db");
  if (!path || !existsSync(path))
    throw new Error(
      "Pass --db pointing to an existing crm.sqlite. Never infer the live data directory.",
    );
  const apply = args.includes("--apply"),
    rollback = args.includes("--rollback");
  if (apply && rollback) throw new Error("Choose apply or rollback, not both.");
  const db =
    !apply && !rollback
      ? new Database(resolve(path), { readonly: true })
      : new Database(resolve(path));
  try {
    if (rollback) {
      if (!args.includes("--disposable") || !args.includes("--acknowledge-data-loss"))
        throw new Error(
          "Rollback is only supported on an explicitly acknowledged disposable verification copy. Restore your backup for production.",
        );
      rollbackCrm(db, { disposable: true, acknowledgeDataLoss: true });
      console.log(JSON.stringify({ rolledBack: true, originalLeadsPreserved: true }, null, 2));
      return;
    }
    if (!apply) {
      console.log(JSON.stringify(dryRunMigration(db), null, 2));
      return;
    }
    const backup = after("--backup");
    if (!backup || existsSync(backup) || resolve(backup) === resolve(path))
      throw new Error(
        "Apply requires --backup with a new path. Existing backups are never overwritten.",
      );
    db.query("VACUUM INTO ?").run(resolve(backup));
    const copy = new Database(resolve(backup), { readonly: true });
    try {
      const check = copy.query("PRAGMA integrity_check").all() as Record<string, string>[];
      if (check.length !== 1 || Object.values(check[0])[0] !== "ok")
        throw new Error("Backup integrity check failed; migration not applied.");
    } finally {
      copy.close();
    }
    console.log(
      JSON.stringify(
        {
          ...migrateCrm(db, new Date().toISOString(), { backupPath: resolve(backup) }),
          backup: resolve(backup),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  try {
    migrationMain(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

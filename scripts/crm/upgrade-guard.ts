// The live hub never upgrades a real crm.sqlite on its own. Opening the CRM runtime would otherwise run the schema v1 migration
// (store.ts openCrmStore -> migrateCrm) the first time anyone loads /crm or runs a Jarvis CRM command. The migration is a one-time,
// owner-run step with a verified backup (scripts/crm/migrate.ts --apply --backup, docs/crm-20261002/MIGRATION.md), so until it has
// run the runtime refuses to open and every caller shows the same plain state instead.
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { crmPath } from "../leads/crm";
import { CRM_SCHEMA_VERSION, hasTable, schemaVersion } from "./migrations";

export type CrmUpgradeState =
  | { state: "ready" }
  | { state: "fresh" }
  | { state: "needs-upgrade"; version: number };

export const CRM_NEEDS_UPGRADE_MESSAGE =
  "CRM needs its one-time upgrade. Your existing leads and notes are untouched. Run the owner upgrade (scripts/crm/migrate.ts --apply --backup), then reload.";

export class CrmNeedsUpgradeError extends Error {
  readonly code = "needs-upgrade";
  constructor() {
    super(CRM_NEEDS_UPGRADE_MESSAGE);
    this.name = "CrmNeedsUpgradeError";
  }
}

/**
 * Read-only look at the real file: no migration, no backup, no table created. `fresh` (no file yet) may be created at the current schema;
 * a file that predates schema v1 and holds Leads tables must go through the owner-run migration.
 */
export function crmUpgradeState(root: string): CrmUpgradeState {
  const file = crmPath(root);
  if (!existsSync(file)) return { state: "fresh" };
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const version = schemaVersion(db);
    if (version < CRM_SCHEMA_VERSION && hasTable(db, "leads"))
      return { state: "needs-upgrade", version };
    return { state: "ready" };
  } catch {
    // An unreadable or locked file is not proof it is current: refuse rather than let the store try to migrate it.
    return { state: "needs-upgrade", version: -1 };
  } finally {
    db?.close();
  }
}

export function assertCrmUpgraded(root: string): void {
  if (crmUpgradeState(root).state === "needs-upgrade") throw new CrmNeedsUpgradeError();
}

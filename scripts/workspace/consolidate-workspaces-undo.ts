// Undo the workspaces consolidation (consolidate-workspaces.ts). Deletes nothing.
//
//   - With a backup that holds workspaces.json.before: that file is restored as
//     .operator-data/workspaces.json (the current one is first kept in the backup folder as
//     workspaces.json.undone-<stamp>).
//   - With a backup from a first run (there was no saved file before): the current
//     workspaces.json is MOVED into the backup folder as workspaces.json.undone-<stamp>, so the OS is
//     back to having no saved grouping.
//
// The project folders themselves were never changed, so there is nothing else to restore. With no
// saved grouping the Workspaces page still shows the three workspaces, placed by the name rules in
// three-workspaces.ts; reverting the page itself is a code revert of branch f/wg-shell-20260929.
//
// CLI (dry run by default):
//   bun scripts/workspace/consolidate-workspaces-undo.ts --root <AgenticOS folder> [--backup <dir>] [--apply]
// Without --backup the most recent workspaces-* backup is used.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stampOf, workspacesFilePath } from "./consolidate-workspaces";
import { dataDirFor } from "../cloud/data-dir";

export type UndoResult = {
  applied: boolean;
  backupDir: string | null;
  action: "restore-previous" | "set-aside" | "nothing-to-undo";
  keptCurrentAs: string | null;
  error?: string;
};

/** The newest workspaces-<stamp> backup folder with a manifest, or null. */
export function latestBackup(root: string): string | null {
  const dir = join(dataDirFor(root), "backups");
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir)
    .filter((name) => name.startsWith("workspaces-") && existsSync(join(dir, name, "manifest.json")) && statSync(join(dir, name)).isDirectory())
    .sort();
  return found.length ? join(dir, found[found.length - 1]) : null;
}

export function undoConsolidation(options: { root: string; backupDir?: string; apply?: boolean; now?: () => Date }): UndoResult {
  const now = (options.now ?? (() => new Date()))();
  const backupDir = options.backupDir ?? latestBackup(options.root);
  if (!backupDir || !existsSync(join(backupDir, "manifest.json"))) return { applied: false, backupDir: backupDir ?? null, action: "nothing-to-undo", keptCurrentAs: null, error: "No workspaces backup found" };
  let manifest: { kind?: string; previousFile?: string | null };
  try {
    manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
  } catch {
    return { applied: false, backupDir, action: "nothing-to-undo", keptCurrentAs: null, error: "The backup's manifest.json can't be read" };
  }
  if (manifest.kind !== "workspaces-consolidation") return { applied: false, backupDir, action: "nothing-to-undo", keptCurrentAs: null, error: "Not a workspaces backup" };
  const file = workspacesFilePath(options.root);
  const previous = manifest.previousFile ? join(backupDir, manifest.previousFile) : null;
  if (previous && !existsSync(previous)) return { applied: false, backupDir, action: "nothing-to-undo", keptCurrentAs: null, error: "The backup's previous file is missing" };
  const action: UndoResult["action"] = previous ? "restore-previous" : existsSync(file) ? "set-aside" : "nothing-to-undo";
  const keptCurrentAs = existsSync(file) ? join(backupDir, `workspaces.json.undone-${stampOf(now)}`) : null;
  if (!options.apply || action === "nothing-to-undo") return { applied: false, backupDir, action, keptCurrentAs };

  if (keptCurrentAs) {
    if (existsSync(keptCurrentAs)) throw new Error("UNDO_TARGET_EXISTS");
    // Keep the current file first (a copy when restoring, a move when setting aside).
    if (previous) copyFileSync(file, keptCurrentAs);
    else renameSync(file, keptCurrentAs);
  }
  if (previous) {
    const temp = `${file}.tmp-${process.pid}`;
    copyFileSync(previous, temp);
    renameSync(temp, file);
  }
  return { applied: true, backupDir, action, keptCurrentAs };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const root = arg("root");
  if (!root) {
    console.error("Usage: bun scripts/workspace/consolidate-workspaces-undo.ts --root <AgenticOS folder> [--backup <dir>] [--apply]");
    process.exit(2);
  }
  const r = undoConsolidation({ root, backupDir: arg("backup"), apply: process.argv.includes("--apply") });
  console.log(JSON.stringify(r, null, 2));
  if (r.error) process.exit(1);
}

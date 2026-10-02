// One place that decides where the hub keeps its data (cloud programme, Agent A).
//
//   MU_DATA_DIR unset  -> `<root>/.operator-data`  (today's behaviour, unchanged)
//   MU_DATA_DIR set    -> that directory, for every store, whatever `root` the caller passed
//
// Stores keep passing their `root` exactly as before; only the base folder can be redirected. Paths
// stay `join(dataDirFor(root), "crm.sqlite")`, so nothing outside this file knows about the variable.
import { join, resolve } from "node:path";

export const DEFAULT_DATA_DIR_NAME = ".operator-data";

/** The override as an absolute path, or null when unset/blank. Reads the environment at call time. */
export function dataDirOverride(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.MU_DATA_DIR?.trim();
  return raw ? resolve(raw) : null;
}

/** The hub's data directory for a repo root. */
export function dataDirFor(root: string, env: Record<string, string | undefined> = process.env): string {
  return dataDirOverride(env) ?? join(root, DEFAULT_DATA_DIR_NAME);
}

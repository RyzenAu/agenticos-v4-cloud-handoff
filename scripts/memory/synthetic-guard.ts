/**
 * Memory isolation for TEST hubs (round 10, owner requirement). A synthetic hub (MU_SYNTHETIC_HUB=1, or a data folder the gate seed made) may run on
 * the account's real home folder (a coding journey needs the owner's CLI login in place), and the memory settings used to fall back to
 * `~/source/repos/mu-ventures-obsidian-wiki` whenever MU_WIKI_ROOT was unset: a research step on such a hub recalled facts from the owner's real vault.
 *
 * Rule: on a synthetic hub every vault/memory path is inside its own data folder. With no vault of its own it gets `<data>/synthetic-vault` (empty
 * unless a test puts notes there). A vault outside the data folder (an MU_WIKI_ROOT from the environment or the owner's config file, or the home
 * default) is REFUSED loudly and replaced by the synthetic one. CLI logins are unaffected (they use their own explicit configDir).
 */
import { resolve } from "node:path";
import { join } from "node:path";
import { isSyntheticHub } from "../cli-home-guard";
import { dataDirFor } from "../cloud/data-dir";

export const SYNTHETIC_VAULT = "synthetic-vault";
const fold = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const inside = (child: string, parent: string) => fold(child) === fold(parent) || fold(child).startsWith(`${fold(parent)}/`);

export type VaultChoice = { root: string; synthetic: boolean; refused: string | null };

/** The vault a memory reader may use here: `wanted` (an explicit root, or the home default) on a real hub; on a synthetic hub only a folder inside its data. */
export function guardVaultRoot(wanted: string, env: Record<string, string | undefined> = process.env, appRoot = process.cwd(), log: (line: string) => void = (l) => console.error(l)): VaultChoice {
  if (!isSyntheticHub(env as NodeJS.ProcessEnv)) return { root: wanted, synthetic: false, refused: null };
  const data = dataDirFor(appRoot, env);
  if (inside(wanted, data)) return { root: wanted, synthetic: true, refused: null };
  const root = join(data, SYNTHETIC_VAULT);
  const refused = `a synthetic hub never reads a vault outside its own data folder (${wanted} was refused; using ${root})`;
  log(`[memory] REFUSED: ${refused}`);
  return { root, synthetic: true, refused };
}

/** Whether a synthetic hub may read this folder as a home-based source (an Obsidian vault the dashboard would scan): only inside its data folder. */
export function syntheticMayRead(path: string, env: Record<string, string | undefined> = process.env, appRoot = process.cwd()): boolean {
  if (!isSyntheticHub(env as NodeJS.ProcessEnv)) return true;
  return inside(path, dataDirFor(appRoot, env));
}

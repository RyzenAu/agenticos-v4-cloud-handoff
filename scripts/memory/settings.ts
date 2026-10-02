/**
 * Memory settings. ONE switch (Stage D, 28 Sep 2026):
 *
 *   MU_MEMORY_WRITES=off   (default, or unset) read-only: browse and recall from the local index.
 *                          No call to Hindsight at all; nothing is saved, corrected or forgotten.
 *   MU_MEMORY_WRITES=read  as off, plus recall from Hindsight (read-only through the proxy).
 *   MU_MEMORY_WRITES=on    everything: "remember this", "save this to the vault", correct, forget,
 *                          and the Obsidian -> Hindsight sync (retain / retract).
 *
 * The switch is read from the process environment first, then ~/.config/agentic-os.env (see
 * memoryEnv in plugin.ts). The Hindsight side has its own gate on the proxy
 * (`hindsightctl writes -State on -Profile pilot`); both must be on for a save to land.
 *
 * Connection (not switches):
 *   HINDSIGHT_URL          default http://127.0.0.1:8878, the client proxy (holds the key; clients send
 *                          none). Loopback only; "off" keeps Hindsight out entirely (vault + local index).
 *   HINDSIGHT_BANK         default "mu-shared", the one shared pool (never the pilot bank by default)
 *   HINDSIGHT_APPROVAL_SECRET_FILE   the proxy's approval secret (default the pilot's), read at delete
 *                          time only, never copied or logged (hindsight-client.ts)
 *   HINDSIGHT_API_KEY      NOT needed through the proxy and should stay unset (only a direct,
 *                          non-proxy test instance uses it; read by name, never stored)
 *   MU_WIKI_ROOT           the Obsidian vault (the folder holding wiki/)
 *   MEMORY_STATE_DIR       app-owned store, default <app>/.operator-data/memory (git-ignored)
 *   MEMORY_SYNC_ALLOW / MEMORY_SYNC_DENY   comma-separated globs over vault-relative paths
 *
 * Retired names: MEMORY_WRITES and HINDSIGHT_ENABLED (the connector's two switches) are no longer
 * read; if either is set, the status panel says so, so nobody thinks they did something.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";

export const API_KEY_ENV = "HINDSIGHT_API_KEY";
export const DEFAULT_BANK = "mu-shared";
/** The client proxy on the pilot profile (scripts/hindsight/proxy.py): the only client-facing route. */
export const DEFAULT_HINDSIGHT_URL = "http://127.0.0.1:8878";
/**
 * The pilot proxy's document-delete secret: rev 3 keeps it in pilot-docdelete.key, rev 2 in
 * pilot-approval.key. The first readable one is used (read at delete time only, never copied).
 */
export const DEFAULT_APPROVAL_SECRET_FILES = ["D:\\hindsight\\service\\secrets\\pilot-docdelete.key", "D:\\hindsight\\service\\secrets\\pilot-approval.key"];
/** THE switch. */
export const SWITCH_ENV = "MU_MEMORY_WRITES";
export type MemoryMode = "off" | "read" | "on";
/** Names the connector used before the one switch; ignored now, reported if set. */
export const RETIRED_SWITCHES = ["MEMORY_WRITES", "HINDSIGHT_ENABLED"] as const;
/** Every setting memoryEnv() looks up by name (process env first, then the OS config file). */
export const MEMORY_ENV_NAMES = [SWITCH_ENV, "HINDSIGHT_URL", "HINDSIGHT_BANK", "HINDSIGHT_APPROVAL_SECRET_FILE", "MU_WIKI_ROOT", "MEMORY_STATE_DIR"] as const;

export function memoryMode(env: Record<string, string | undefined>): MemoryMode {
  const v = (env[SWITCH_ENV] ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "read" ? "read" : "off";
}

/** Only compiled wiki notes are candidates. */
export const DEFAULT_ALLOW = ["wiki/**/*.md"];
/**
 * Never synced, whatever the allow list says: raw sources, templates, Obsidian internals,
 * schema/readme files, and anything named like a credential, transcript or bank export.
 */
export const HARD_DENY = [
  "raw/**",
  "**/templates/**",
  ".obsidian/**",
  ".trash/**",
  ".git/**",
  ".scripts/**",
  ".skills/**",
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/README.md",
  "**/*credential*",
  "**/*secret*",
  "**/*password*",
  "**/*.env*",
  "**/*transcript*",
  "**/*bank-statement*",
];

export type MemorySettings = {
  /** The one switch's value (MU_MEMORY_WRITES). */
  mode: MemoryMode;
  writes: boolean;
  /** Retired switch names that are still set somewhere (shown on the status panel). */
  retired: string[];
  /** Why this copy is read-only although the switch is on (single writer, writer.ts), or absent. */
  writer?: string | null;
  hindsight: {
    enabled: boolean;
    url: string | null;
    bank: string;
    apiKeyEnv: string;
    /** The proxy's document-delete secret file(s), first readable wins (deletes only; read at call time, never copied). */
    approvalSecretFile: string[];
    /** Why Hindsight is off or refused, for the status panel. */
    reason: string | null;
  };
  vaultRoot: string;
  vaultName: string;
  stateDir: string;
  sync: { allow: string[]; deny: string[] };
};

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** A Hindsight URL must point at this machine. Returns the normalised origin, or null. */
export function loopbackUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
  if (u.username || u.password) return null;
  return `${u.protocol}//${u.host}`;
}

export function resolveMemorySettings(env: Record<string, string | undefined> = process.env, appRoot = process.cwd()): MemorySettings {
  const mode = memoryMode(env);
  const rawUrl = (env.HINDSIGHT_URL ?? "").trim() || DEFAULT_HINDSIGHT_URL;
  const urlOff = /^off$/i.test(rawUrl);
  const url = urlOff ? null : loopbackUrl(rawUrl);
  const bank = (env.HINDSIGHT_BANK || DEFAULT_BANK).trim();
  const bankOk = /^[A-Za-z0-9_.-]{1,64}$/.test(bank);
  let reason: string | null = null;
  if (mode === "off") reason = `${SWITCH_ENV} is off`;
  else if (urlOff) reason = "HINDSIGHT_URL is off (vault and local index only)";
  else if (!url) reason = "HINDSIGHT_URL must be a loopback address (127.0.0.1, localhost or ::1)";
  else if (!bankOk) reason = "HINDSIGHT_BANK has invalid characters";
  const vaultRoot = env.MU_WIKI_ROOT || join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki");
  return {
    mode,
    writes: mode === "on",
    retired: RETIRED_SWITCHES.filter((n) => (env[n] ?? "").trim() !== ""),
    hindsight: {
      enabled: mode !== "off" && !!url && bankOk,
      url,
      bank,
      apiKeyEnv: API_KEY_ENV,
      approvalSecretFile: (env.HINDSIGHT_APPROVAL_SECRET_FILE ?? "").trim() ? [(env.HINDSIGHT_APPROVAL_SECRET_FILE ?? "").trim()] : DEFAULT_APPROVAL_SECRET_FILES,
      reason,
    },
    vaultRoot,
    vaultName: env.MU_WIKI_VAULT_NAME || vaultRoot.split(/[\\/]/).filter(Boolean).pop() || "vault",
    stateDir: env.MEMORY_STATE_DIR || join(dataDirFor(appRoot), "memory"),
    sync: {
      allow: list(env.MEMORY_SYNC_ALLOW).length ? list(env.MEMORY_SYNC_ALLOW) : DEFAULT_ALLOW,
      deny: [...HARD_DENY, ...list(env.MEMORY_SYNC_DENY)],
    },
  };
}

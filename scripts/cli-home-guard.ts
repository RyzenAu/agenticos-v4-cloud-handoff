import { userInfo } from "node:os";
import { join, resolve } from "node:path";

/**
 * CLI home isolation for copies of the OS (AUDIT-F3 F3-26, with A1-6; Track 3, 28 Sep 2026).
 *
 * A preview or quiet copy (ARGENTIC_PREVIEW=1 or AGENTIC_OS_NO_BACKGROUND=1) often runs with a SYNTHETIC
 * home (HOME/USERPROFILE/APPDATA/LOCALAPPDATA pointed at a scratch folder). Codex doesn't only read its
 * home: with its default credential store ("auto") it can reach the owner's login through the Windows
 * credential manager, so a "synthetic" preview still read the owner's real Google account through Codex.
 *
 * Rule: in a copy, every Codex/Claude child runs on the COPY's home, never the owner's:
 *  - Codex: CODEX_HOME = <copy home>/.codex (or a CODEX_HOME already inside the copy home), plus
 *    `-c cli_auth_credentials_store="file"` so the OS keyring is never consulted;
 *  - Claude: CLAUDE_CONFIG_DIR = <copy home>/.claude (or one already inside it).
 * A CODEX_HOME/CLAUDE_CONFIG_DIR pointing OUTSIDE the copy's home is refused (it would be the owner's).
 * With no home in the environment at all, the copy is refused too (the CLI would fall back to the
 * account's real profile). The live server (not a copy) is unchanged.
 *
 * A copy is recognised by its flags, AND by its home (REVIEW-T3): a process whose USERPROFILE/HOME is not
 * the Windows account's own profile folder is running on a synthetic home, flag or no flag.
 */

export type CliName = "codex" | "claude";
export type CliHomeVerdict =
  | { ok: true; copy: boolean; env: NodeJS.ProcessEnv; args: string[]; home: string | null }
  | { ok: false; copy: true; reason: string };

/** The account's real profile folder (from the OS account database, not the environment). */
let accountHome: () => string | null = () => { try { return userInfo().homedir || null; } catch { return null; } };
/** Tests only: stand in for the account's profile folder. */
export function setAccountHomeForTest(fn: (() => string | null) | null) {
  accountHome = fn ?? (() => { try { return userInfo().homedir || null; } catch { return null; } });
}

export const isCopy = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.ARGENTIC_PREVIEW === "1" || env.AGENTIC_OS_NO_BACKGROUND === "1") return true;
  const home = envValue(env, "USERPROFILE") || envValue(env, "HOME");
  const real = accountHome();
  return !!home && !!real && fold(home) !== fold(real);
};

const fold = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const inside = (child: string, parent: string) => fold(child) === fold(parent) || fold(child).startsWith(`${fold(parent)}/`);

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** The environment and extra args a CLI child must use in this process. */
export function cliHomeGuard(cli: CliName, env: NodeJS.ProcessEnv = process.env): CliHomeVerdict {
  if (!isCopy(env)) return { ok: true, copy: false, env, args: [], home: null };
  const home = envValue(env, "USERPROFILE") || envValue(env, "HOME");
  if (!home) return { ok: false, copy: true, reason: `This is a preview or quiet copy with no home folder of its own, so ${cli} would use the owner's login. It isn't started here.` };
  const out: NodeJS.ProcessEnv = { ...env };
  if (cli === "codex") {
    const current = envValue(env, "CODEX_HOME");
    if (current && !inside(current, home)) return { ok: false, copy: true, reason: `CODEX_HOME points outside this copy's home (${current}); a copy never uses the owner's Codex login.` };
    for (const k of Object.keys(out)) if (k.toLowerCase() === "codex_home") delete out[k];
    out.CODEX_HOME = current ?? join(home, ".codex");
    return { ok: true, copy: true, env: out, args: ["-c", 'cli_auth_credentials_store="file"'], home };
  }
  const current = envValue(env, "CLAUDE_CONFIG_DIR");
  if (current && !inside(current, home)) return { ok: false, copy: true, reason: `CLAUDE_CONFIG_DIR points outside this copy's home (${current}); a copy never uses the owner's Claude login.` };
  for (const k of Object.keys(out)) if (k.toLowerCase() === "claude_config_dir") delete out[k];
  out.CLAUDE_CONFIG_DIR = current ?? join(home, ".claude");
  return { ok: true, copy: true, env: out, args: [], home };
}

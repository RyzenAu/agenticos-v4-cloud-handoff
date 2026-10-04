import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

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
 *
 * Round 7 (finding H-05): that second test never fired under Bun on Windows. The account's own profile folder was read with
 * `os.userInfo().homedir`, and Bun answers that from USERPROFILE, so a hub started with HOME, USERPROFILE, APPDATA and LOCALAPPDATA
 * redirected to an empty folder believed the redirected folder WAS the account's own, applied no isolation, and Codex (a Rust program that
 * resolves the Windows profile itself, ignoring those variables) reported the owner's real login: "Codex Ready · signed in" on a synthetic hub.
 * The account's folder now comes from the registry's profile list (by the account's SID), never from the environment.
 *
 * A SYNTHETIC HUB is the second case: a hub whose data folder holds the synthetic marker the gate seed writes (`.gate-seed.json`, or
 * `.synthetic-hub`) or that is started with MU_SYNTHETIC_HUB=1. Even on the owner's real home it gets its own empty CLI home
 * (<data folder>/cli-home), so its System page reads "not signed in" and no click can spend the owner's account. Using the owner's real
 * logins from such a hub is a DELIBERATE choice, made out loud: start it with MU_OWNER_CLI_LOGINS=allow (a real coding journey does).
 */

export type CliName = "codex" | "claude";
export type CliHomeVerdict =
  | { ok: true; copy: boolean; env: NodeJS.ProcessEnv; args: string[]; home: string | null }
  | { ok: false; copy: true; reason: string };

/** The SID in `whoami /user /fo csv /nh` output ("domain\\user","S-1-5-21-..."), or null. Pure. */
export function parseSid(out: string): string | null {
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  return m ? m[1] : null;
}
/** The folder in `reg query ... /v ProfileImagePath` output (REG_EXPAND_SZ or REG_SZ), with %SystemDrive%-style variables expanded from `env`, or null. Pure. */
export function parseProfileImagePath(out: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const m = /ProfileImagePath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(out);
  if (!m) return null;
  const expanded = m[1].replace(/%([^%]+)%/g, (all, name: string) => envValue(env, name) ?? all);
  return /%/.test(expanded) ? null : expanded;
}

let windowsHomeCache: string | null | undefined;
/** The Windows account's profile folder from the registry's profile list by the account's SID: not the environment (H-05). Cached for the process. */
function windowsProfileFolder(): string | null {
  if (windowsHomeCache !== undefined) return windowsHomeCache;
  windowsHomeCache = null;
  try {
    // The Windows tools by full path: a Git Bash PATH finds MSYS's own whoami first, which does not take /user.
    const system32 = join(envValue(process.env, "SystemRoot") || envValue(process.env, "windir") || "C:/Windows", "System32");
    const who = spawnSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    const sid = parseSid(who.stdout ?? "");
    if (sid) {
      const reg = spawnSync(join(system32, "reg.exe"), ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`, "/v", "ProfileImagePath"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
      windowsHomeCache = parseProfileImagePath(reg.stdout ?? "");
    }
    if (!windowsHomeCache) {
      // The profiles folder beside the public one (PUBLIC is not something a hub redirects), plus the account's own name.
      const pub = envValue(process.env, "PUBLIC");
      const name = userInfo().username;
      const guess = pub && name ? join(dirname(pub), name) : null;
      windowsHomeCache = guess && existsSync(guess) ? guess : null;
    }
  } catch { windowsHomeCache = null; }
  return windowsHomeCache;
}

const defaultAccountHome = (): string | null => {
  try {
    if (process.platform === "win32") return windowsProfileFolder();
    return userInfo().homedir || null;
  } catch { return null; }
};
/** The account's real profile folder (from the OS, not the environment). */
let accountHome: () => string | null = defaultAccountHome;
/** Tests only: stand in for the account's profile folder. */
export function setAccountHomeForTest(fn: (() => string | null) | null) {
  accountHome = fn ?? defaultAccountHome;
}

/** The owner's explicit choice to let a synthetic hub use his real CLI logins. */
export const OWNER_LOGINS_FLAG = "MU_OWNER_CLI_LOGINS";
export const ownerLoginsAllowed = (env: NodeJS.ProcessEnv = process.env) => envValue(env, OWNER_LOGINS_FLAG)?.toLowerCase() === "allow";
/** A hub made for tests or acceptance: a flag, or a synthetic marker in its data folder. */
export function isSyntheticHub(env: NodeJS.ProcessEnv = process.env): boolean {
  if (envValue(env, "MU_SYNTHETIC_HUB") === "1") return true;
  const data = envValue(env, "MU_DATA_DIR");
  return !!data && (existsSync(join(data, ".gate-seed.json")) || existsSync(join(data, ".synthetic-hub")));
}
/** On the owner's real home but a synthetic hub that has not been given his logins: it gets a home of its own. */
const withheldFromSynthetic = (env: NodeJS.ProcessEnv) => isSyntheticHub(env) && !ownerLoginsAllowed(env);

export const isCopy = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.ARGENTIC_PREVIEW === "1" || env.AGENTIC_OS_NO_BACKGROUND === "1") return true;
  const home = envValue(env, "USERPROFILE") || envValue(env, "HOME");
  const real = accountHome();
  if (!!home && !!real && fold(home) !== fold(real)) return true;
  // The account's own folder could not be found, so a redirected home cannot be told from the real one: fail closed (review finding 8).
  if (!real && !ownerLoginsAllowed(env)) return true;
  return withheldFromSynthetic(env);
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
  const own = envValue(env, "USERPROFILE") || envValue(env, "HOME");
  const real = accountHome();
  if (!real && !(env.ARGENTIC_PREVIEW === "1" || env.AGENTIC_OS_NO_BACKGROUND === "1")) return { ok: false, copy: true, reason: `The account's own profile folder could not be found, so this process can't be told apart from a test hub, and ${cli} is not started (it might use the owner's login). A deliberate real run sets ${OWNER_LOGINS_FLAG}=allow.` };
  // A synthetic hub on the owner's real home gets a home of its own inside its data folder (the CLI then reads no login at all).
  const onRealHome = !!own && !!real && fold(own) === fold(real);
  const data = envValue(env, "MU_DATA_DIR");
  if (onRealHome && withheldFromSynthetic(env) && !data) return { ok: false, copy: true, reason: `This is a synthetic hub without a data folder of its own, so ${cli} would use the owner's login. Give it MU_DATA_DIR, or set ${OWNER_LOGINS_FLAG}=allow to use the real login on purpose.` };
  const home = onRealHome && withheldFromSynthetic(env) && data ? join(data, "cli-home") : own;
  if (!home) return { ok: false, copy: true, reason: `This is a preview or quiet copy with no home folder of its own, so ${cli} would use the owner's login. It isn't started here.` };
  const out: NodeJS.ProcessEnv = { ...env };
  if (cli === "codex") {
    const current = envValue(env, "CODEX_HOME");
    if (current && !inside(current, home)) return { ok: false, copy: true, reason: `CODEX_HOME points outside this copy's home (${current}); a copy never uses the owner's Codex login (a deliberate real run sets ${OWNER_LOGINS_FLAG}=allow).` };
    for (const k of Object.keys(out)) if (k.toLowerCase() === "codex_home") delete out[k];
    out.CODEX_HOME = current ?? join(home, ".codex");
    return { ok: true, copy: true, env: out, args: ["-c", 'cli_auth_credentials_store="file"'], home };
  }
  const current = envValue(env, "CLAUDE_CONFIG_DIR");
  if (current && !inside(current, home)) return { ok: false, copy: true, reason: `CLAUDE_CONFIG_DIR points outside this copy's home (${current}); a copy never uses the owner's Claude login (a deliberate real run sets ${OWNER_LOGINS_FLAG}=allow).` };
  for (const k of Object.keys(out)) if (k.toLowerCase() === "claude_config_dir") delete out[k];
  out.CLAUDE_CONFIG_DIR = current ?? join(home, ".claude");
  return { ok: true, copy: true, env: out, args: [], home };
}

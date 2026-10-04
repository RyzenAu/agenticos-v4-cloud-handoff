import * as nodePath from "node:path";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { cliHomeGuard } from "./cli-home-guard";
import { dataDirOverride, DEFAULT_DATA_DIR_NAME } from "./cloud/data-dir";

/** Platform facts are parameters, so every Windows branch can be proven from a macOS host. */
export type PlatformOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};
export type LookupOptions = PlatformOptions & {
  home?: string;
  path?: string;
  /** Replaces the file-system probe; tests point it at synthetic Windows paths. */
  exists?: (candidate: string) => boolean;
};

const platformPath = (platform: NodeJS.Platform) =>
  platform === "win32" ? nodePath.win32 : nodePath.posix;
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const isExecutableFile = (platform: NodeJS.Platform) => (candidate: string) => {
  try {
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/** Suffixes Windows launches for a bare command name. `.exe` first: a native
 * install starts directly, an npm `.cmd` shim needs cmd.exe. PATHEXT can narrow
 * the list but never adds script kinds this OS does not spawn. */
export function windowsExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const allowed = new Set(
    (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean),
  );
  const ordered = [".exe", ".cmd", ".bat", ".com"].filter((extension) => allowed.has(extension));
  return ordered.length ? ordered : [".exe", ".cmd", ".bat", ".com"];
}

/** Folders where a CLI is commonly installed, PATH first, then well-known per-user locations. */
export function executableDirectories(name: string, options: LookupOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const p = platformPath(platform);
  const searchPath = options.path ?? env.PATH ?? env.Path ?? "";
  const fromPath = searchPath
    .split(p.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  if (platform === "win32") {
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    return unique([
      ...fromPath,
      // npm global shims: codex.cmd and claude.cmd live here.
      p.join(appData, "npm"),
      p.join(localAppData, "pnpm"),
      p.join(localAppData, "Volta", "bin"),
      p.join(home, ".bun", "bin"),
      // Claude Code's native installer.
      p.join(home, ".local", "bin"),
      p.join(home, "scoop", "shims"),
      p.join(localAppData, "Programs", name),
      p.join(localAppData, "Programs", name, "bin"),
      p.join(localAppData, "Programs", title),
      p.join(localAppData, "Programs", title, "bin"),
      p.join(programFiles, title),
      p.join(programFiles, title, "bin"),
      // Microsoft Store execution aliases are readable without elevation.
      p.join(localAppData, "Microsoft", "WindowsApps"),
    ]);
  }
  return unique([
    ...fromPath,
    p.join(home, ".local", "bin"),
    p.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
}

/** Every file the OS would accept as the named command, in probe order. */
export function executableCandidates(name: string, options: LookupOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const p = platformPath(platform);
  const files =
    platform === "win32"
      ? windowsExtensions(options.env ?? process.env).map((extension) => name + extension)
      : [name];
  const candidates = executableDirectories(name, options).flatMap((directory) =>
    files.map((file) => p.join(directory, file)),
  );
  if (platform !== "win32" && name === "codex")
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  return unique(candidates);
}

export function findExecutable(name: string, options: LookupOptions = {}): string | undefined {
  const exists = options.exists ?? isExecutableFile(options.platform ?? process.platform);
  return executableCandidates(name, options).find(exists);
}

export function assistantBinary(
  name: "codex" | "claude",
  home = homedir(),
  path?: string,
  options: LookupOptions = {},
): string | undefined {
  return findExecutable(name, { ...options, home, path });
}

/** Where an npm `.cmd` shim's real executable lives, relative to the shim folder. Codex ships a
 * per-architecture package, nested under @openai/codex or hoisted beside it. */
function shimTargets(name: "codex" | "claude", shimDirectory: string, arch: string): string[] {
  const p = nodePath.win32;
  if (name === "claude")
    return [p.join(shimDirectory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")];
  const [pkg, triple] = arch === "arm64"
    ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"]
    : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  const tail = [pkg, "vendor", triple, "bin", "codex.exe"];
  return [
    p.join(shimDirectory, "node_modules", "@openai", "codex", "node_modules", "@openai", ...tail),
    p.join(shimDirectory, "node_modules", "@openai", ...tail),
  ];
}

/**
 * The real executable for a delegated agent, never an npm `.cmd`/`.bat` shim (CODING-HARNESS §2.6
 * rule 1): a shim needs cmd.exe, which caps the command line at 8,191 characters and adds a process
 * layer that a tree-kill must see through. On Windows a PATH `.exe` wins; a shim is followed to the
 * `.exe` its package installed; the pinned Claude bridge copy is the last resort. No real
 * executable = undefined, so the caller fails closed instead of falling back to the shim.
 * POSIX has no shim problem, so it is the ordinary lookup there.
 */
export function realExecutable(
  name: "codex" | "claude",
  options: LookupOptions & { arch?: string } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return findExecutable(name, options);
  const env = options.env ?? process.env;
  const exists = options.exists ?? isExecutableFile(platform);
  const p = nodePath.win32;
  const arch = options.arch ?? process.arch;
  for (const candidate of executableCandidates(name, options)) {
    // A relative PATH entry would resolve against whatever the cwd is: never trust it (review minor).
    if (!p.isAbsolute(candidate) || !exists(candidate)) continue;
    if (/\.exe$/i.test(candidate)) return candidate;
    if (/\.(?:cmd|bat)$/i.test(candidate)) {
      const real = shimTargets(name, p.dirname(candidate), arch).find(exists);
      if (real) return real;
    }
  }
  if (name === "claude") {
    const localAppData = env.LOCALAPPDATA || p.join(options.home ?? homedir(), "AppData", "Local");
    const pinned = p.join(localAppData, "claude-bridge", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (exists(pinned)) return pinned;
  }
  return undefined;
}

/** System variables a CLI needs to find its own login, temp folder and tools. Nothing else from the
 * server's environment reaches an agent (CODING-HARNESS §2.6 rule 6: an allowlist, not a blocklist). */
export const CHILD_ENV_ALLOWLIST = [
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG",
  // Non-secret paths that pick which login/config and shell the CLI itself uses. Dropping them
  // would sign an agent out or break Claude's Bash tool on Windows.
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "CODEX_HOME",
  // POSIX equivalents, so the same adapters run on a macOS or Linux host.
  "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LC_ALL", "LC_CTYPE",
] as const;

/** Names that never reach an agent, even when a caller passes them as extras: provider routing and
 * billing overrides, and anything shaped like a credential. */
export function forbiddenChildEnvName(name: string): boolean {
  return /^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|AZURE_OPENAI_)/i.test(name)
    || /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?|_PAT)$/i.test(name)
    || /^(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name);
}

/** The only fixed settings a caller may add for a CLI. */
export const CHILD_ENV_SETTINGS: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "RUST_LOG", "CI", "NO_COLOR", "FORCE_COLOR",
]);

export type ChildEnvOptions = {
  /** The environment to pick from. Defaults to this process. */
  env?: NodeJS.ProcessEnv;
  /** Fixed, non-secret settings for this CLI, e.g. CLAUDE_CODE_DISABLE_AUTO_MEMORY or RUST_LOG. */
  extra?: Record<string, string>;
  /** Credentials scoped to one job (the design's "scoped credentials"): named explicitly by the
   * caller, never inherited. Provider routing/billing names (ANTHROPIC_*, OPENAI_*, CLAUDE_CODE_USE_*)
   * are refused here too, because they move a subscription CLI onto metered API billing. */
  scopedCredentials?: Record<string, string>;
};

/**
 * The only environment a delegated agent gets: the allowlisted system variables, the caller's fixed
 * settings, and any explicitly scoped credential. Windows names are case-insensitive, so matching is
 * too; the original spelling is kept. Values are never logged.
 */
export function childEnv(options: ChildEnvOptions = {}): Record<string, string> {
  const source = options.env ?? process.env;
  const allowed = new Map(CHILD_ENV_ALLOWLIST.map((name) => [name.toLowerCase(), name]));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || !allowed.has(name.toLowerCase())) continue;
    if (forbiddenChildEnvName(name)) continue;
    if (Object.keys(out).some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    // A closed list: NODE_OPTIONS, DATABASE_URL and the like can't ride in as "settings" (review minor).
    if (forbiddenChildEnvName(name) || !CHILD_ENV_SETTINGS.has(name)) throw new Error(`Refusing to pass ${name} to an agent as a setting.`);
    out[name] = String(value);
  }
  for (const [name, value] of Object.entries(options.scopedCredentials ?? {})) {
    if (/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|AZURE_OPENAI_)/i.test(name))
      throw new Error(`Refusing to pass ${name} to an agent: it would switch the CLI to metered API billing.`);
    out[name] = String(value);
  }
  for (const name of Object.keys(out)) if (name.toLowerCase() === "path") out[name] = withoutBunNodeShim(out[name]);
  return out;
}

/**
 * The hub runs under `bun --bun run`, which puts a `bun-node-<hash>` folder holding a fake `node.exe` (Bun itself) first on PATH.
 * A child that runs `node` must get real Node: Bun-as-node ignores flags such as `--check` and RUNS the script (a registry lint
 * started the site's server and hung the coding gate on Ryzen, 4 Oct 2026).
 */
export function withoutBunNodeShim(path: string): string {
  const sep = path.includes(";") || process.platform === "win32" ? ";" : ":";
  return path.split(sep).filter((dir) => dir && !/[\\/]bun-node-[0-9a-f]+[\\/]?$/i.test(dir)).join(sep);
}

export type CommandLaunch = { file: string; args: string[]; windowsVerbatimArguments: boolean };

/** cmd.exe must run `.cmd`/`.bat` shims (the npm layout on Windows); a native `.exe` or a POSIX binary starts directly. */
export function needsCommandShell(binary: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
}

/** Quote one argument for `cmd.exe /s /c` so the program parses the same argv as a
 * direct spawn (CommandLineToArgvW rules). Arguments here are fixed CLI flags; an
 * argument that mixes `"` with cmd metacharacters (& | < > ^) is not supported. */
export function quoteCommandArgument(argument: string): string {
  if (argument !== "" && !/[\s"&|<>^()%!]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const char of argument) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** What to hand `spawn`/`execFile` for a binary: unchanged on POSIX and for a
 * Windows `.exe`; wrapped in `cmd.exe /d /s /c` with verbatim quoting for a shim. */
export function commandLaunch(
  binary: string,
  args: string[],
  options: PlatformOptions = {},
): CommandLaunch {
  const platform = options.platform ?? process.platform;
  if (!needsCommandShell(binary, platform))
    return { file: binary, args, windowsVerbatimArguments: false };
  const env = options.env ?? process.env;
  const shell = env.ComSpec || env.COMSPEC || "cmd.exe";
  const command = [binary, ...args].map(quoteCommandArgument).join(" ");
  return { file: shell, args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
}

/** Stop a runtime child. POSIX signals the process (or its detached group).
 * Windows has no signals: `taskkill /t` ends the tree, because killing only a
 * cmd.exe shim would leave the real Codex or Claude process running. */
export function terminateChild(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  options: PlatformOptions & { detached?: boolean; run?: typeof spawn } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    if (child.pid) {
      const env = options.env ?? process.env;
      const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
      try {
        const killer = (options.run ?? spawn)(
          nodePath.win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/t", "/f"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.on("error", () => {});
        killer.unref?.();
      } catch {
        /* taskkill is optional; the direct kill below still runs. */
      }
    }
    try {
      child.kill();
    } catch {
      /* It has already exited. */
    }
    return;
  }
  try {
    if (options.detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* It has already exited. */
    }
  }
}

export async function claudeSignInStatus(
  binary = assistantBinary("claude"),
  run: (file: string, args: string[], options: any) => Promise<{ stdout: string }> = async (
    file,
    args,
    options,
  ) => {
    const result = await promisify(execFile)(file, args, { ...options, encoding: "utf8" });
    return { stdout: String(result.stdout) };
  },
  options: PlatformOptions = {},
  processEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!binary)
    return {
      id: "claude",
      installed: false,
      ready: false,
      detail: "Install Claude Code, then sign in there.",
    };
  // F3-26 (R3): a copy with a synthetic home asks Claude Code about THAT home's login, or not at all.
  const home = cliHomeGuard("claude", processEnv);
  if (!home.ok) return { id: "claude", installed: true, ready: false, detail: home.reason };
  try {
    const launch = commandLaunch(binary, ["auth", "status", "--json"], options);
    const { stdout } = await run(launch.file, launch.args, {
      timeout: 4000,
      maxBuffer: 32000,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      ...(home.copy ? { env: home.env } : {}),
    });
    const ready = JSON.parse(stdout).loggedIn === true;
    return {
      id: "claude",
      installed: true,
      ready,
      detail: ready
        ? "Claude Code reports signed in; generation and app access are not verified."
        : "Open Claude Code and sign in. A Claude desktop login alone is not confirmation.",
    };
  } catch (error) {
    // Claude returns exit 1 with valid status JSON when signed out. That is a
    // confirmed signed-out state, not a broken discovery or a missing history.
    try {
      if (JSON.parse(String((error as any)?.stdout || "")).loggedIn === false)
        return { id: "claude", installed: true, ready: false,
          detail: "Claude Code is installed but signed out. Open Claude Code and run /login. Saved local history can still be imported." };
    } catch { /* Unreadable status remains unverified below. */ }
    return {
      id: "claude",
      installed: true,
      ready: false,
      detail: "Could not verify Claude Code sign-in. Open Claude Code and check /login.",
    };
  }
}

export function assistantPython(root: string, platform: NodeJS.Platform = process.platform): string {
  // Joined with the TARGET platform's path rules (the override, when set, is already absolute on this host).
  const override = dataDirOverride();
  return platformPath(platform).resolve(
    ...(override ? [override] : [root, DEFAULT_DATA_DIR_NAME]),
    "dsh-venv",
    ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
}

export function hermesInstalled(
  home = homedir(),
  path?: string,
  options: LookupOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const p = platformPath(platform);
  const exists = options.exists ?? existsSync;
  const runtime = p.join(home, ".hermes", "hermes-agent");
  const python = p.join(
    runtime,
    "venv",
    ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
  if (exists(python) && exists(p.join(runtime, "hermes_cli", "main.py"))) return true;
  return !!findExecutable("hermes", { ...options, home, path });
}

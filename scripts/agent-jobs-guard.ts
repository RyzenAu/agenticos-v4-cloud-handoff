import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

/**
 * Agents never edit the live OS checkout (CODING-HARNESS C1 (d); owner decision 6, 28 Sep).
 *
 * Layers, strongest first:
 *  1. Task folders live OUTSIDE the live checkout (agent-jobs.ts `tasksRoot`), so an agent's own
 *     folder, its parent climbs and its project files (CLAUDE.md/AGENTS.md) are not the OS repo.
 *  2. Codex runs with its workspace-write sandbox rooted at the task folder.
 *  3. This guard, in front of the owner's approval cards: a write, file change, permission grant or
 *     shell command that reaches the live checkout is refused WITHOUT a card. Paths are resolved the
 *     way Windows will: env vars and `~` expanded, `\\?\` and `\\localhost\C$\` forms normalised,
 *     then the longest existing ancestor is realpath'd (8.3 names like AGENTI~1 expanded, junctions
 *     and symlinks followed). Creating a junction/symlink/hard link is always refused, and so is
 *     changing directory or climbing (`..`) out of the task folder.
 *
 * HONEST LIMITS (documented, not solved here):
 *  - Shell text can't be fully understood: a path built at run time (string concatenation, a script
 *    file, `$(dirname …)`, Python `os.chdir`) is not seen. Claude still asks the owner for every
 *    shell command it runs, and the owner sees the command.
 *  - READS are not confined. An agent can still read any file this Windows user can read, including
 *    secrets on disk (.env files, ~/.config/agentic-os.env, Hermes' .env, other repos). The env
 *    allowlist keeps secrets out of the process environment only. Confining reads needs the C3
 *    policy engine (registry denyRead) and OS-level sandboxing; until then, don't run agent jobs
 *    for anyone who shouldn't be able to read this PC's files.
 */
export const LIVE_CHECKOUT_REFUSAL =
  "Agents never edit the live OS checkout. Use Coding, which works in an isolated worktree.";
export const LINK_REFUSAL = "Agents can't create junctions, symlinks or hard links from a task folder.";
export const PATHLESS_CHANGE_REFUSAL = "Codex asked to change files without saying which ones, so it was refused.";
export const OUTSIDE_TASK_REFUSAL = "Codex asked to change files outside its task folder, so it was refused.";

export type LiveCheckoutGuard = {
  protectedRoot: string;
  cwd: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected for tests; defaults to realpath of the longest existing ancestor. */
  realpath?: (path: string) => string;
};

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? nodePath.win32 : nodePath.posix);
const platformOf = (g: LiveCheckoutGuard) => g.platform ?? process.platform;

/** Resolve like the OS: follow junctions/symlinks and expand 8.3 names on the part that exists. */
export function realResolve(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  let head = p.resolve(path);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(head)) {
      try { head = realpathSync.native(head); } catch { /* unreadable: keep the lexical form */ }
      break;
    }
    const parent = p.dirname(head);
    if (parent === head) break;
    rest.unshift(p.basename(head));
    head = parent;
  }
  return rest.length ? p.join(head, ...rest) : head;
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** `%USERPROFILE%\x`, `$env:USERPROFILE\x`, `${HOME}/x`, `$HOME/x`, `~/x`, `\\?\C:\x`, `\\localhost\C$\x`, `file:///C:/x`. */
export function expandPathText(raw: string, guard: LiveCheckoutGuard): string {
  const platform = platformOf(guard);
  const env = guard.env ?? process.env;
  const home = guard.home ?? envValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform) ?? homedir();
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/^file:\/{2,3}/i, "");
  t = t.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, n) => envValue(env, n, platform) ?? m);
  t = t.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, n) => envValue(env, n, platform) ?? m);
  t = t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => envValue(env, a ?? b, platform) ?? m);
  if (/^~(?=$|[\\/])/.test(t)) t = home + t.slice(1);
  return platform === "win32" ? windowsSpellings(t) : t;
}

/**
 * Rewrite every Windows alias of a drive path to `C:/…`, ANYWHERE in the text (review R2: an unquoted
 * UNC path mid-command, and the Git Bash `/c/Users/…` spelling that Claude's Bash tool uses on Windows).
 * Forms: `\\?\C:\`, `\\.\C:\`, `\\?\UNC\…`, `\\localhost\C$\`, `\\127.0.0.1\c$\`, `/c/`, `/mnt/c/`, `/C:/`.
 */
export function windowsSpellings(text: string): string {
  const start = String.raw`(^|[\s"'\x60=<>|;&(,])`;
  return text
    .replace(new RegExp(String.raw`${start}[\\/]{2}[?.][\\/]UNC[\\/]`, "gi"), "$1\\\\")
    .replace(new RegExp(String.raw`${start}[\\/]{2}[?.][\\/](?=[A-Za-z]:)`, "g"), "$1")
    .replace(new RegExp(String.raw`${start}[\\/]{2}(?:localhost|127\.0\.0\.1|\[?::1\]?|\.)[\\/]([A-Za-z])\$(?=$|[\\/\s"'])`, "gi"), "$1$2:")
    .replace(new RegExp(String.raw`${start}/(?:mnt/)?([A-Za-z])(?=/|$|[\s"'])`, "g"), "$1$2:")
    .replace(new RegExp(String.raw`${start}/([A-Za-z]):(?=[\\/]|$)`, "g"), "$1$2:");
}

function folded(path: string, platform: NodeJS.Platform) {
  const v = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? v.toLowerCase() : v;
}

/** True when `child` is `parent` or below it, after real resolution. */
export function insidePath(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const a = folded(child, platform), b = folded(parent, platform);
  return a === b || a.startsWith(b + "/");
}

function resolver(guard: LiveCheckoutGuard) {
  const platform = platformOf(guard);
  const real = guard.realpath ?? ((path: string) => realResolve(path, platform));
  const p = pathFor(platform);
  const root = real(p.resolve(guard.protectedRoot));
  const cwd = real(p.resolve(guard.cwd));
  const resolve = (raw: string) => real(p.resolve(guard.cwd, expandPathText(raw, guard)));
  return { platform, root, cwd, resolve, inLive: (r: string) => insidePath(r, root, platform), inTask: (r: string) => insidePath(r, cwd, platform) };
}

/** A path argument that resolves into the live checkout (outside the task folder). */
export function pathTouchesLiveCheckout(target: unknown, guard: LiveCheckoutGuard): boolean {
  if (typeof target !== "string" || !target.trim()) return false;
  const r = resolver(guard);
  const resolved = r.resolve(target);
  return r.inLive(resolved) && !r.inTask(resolved);
}

const LINK_COMMAND =
  /\bmklink\b|-ItemType\s+["']?(?:Junction|SymbolicLink|HardLink)\b|\bln\s|\bfsutil(?:\.exe)?\s+(?:hardlink|reparsepoint)\b|\bos\.(?:sym)?link\s*\(|\bsymlink(?:Sync)?\s*\(|CreateSymbolicLink|CreateHardLink|\bjunction(?:\.exe)?\s/i;
const CHDIR = /(?:^|[\s;&|(])(?:cd|chdir|pushd|Set-Location|sl|Push-Location)(?:\.exe)?(?=\s|$)(?:\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s;&|)]+))?/gi;

/** Split shell text into candidate words (quotes respected; operators split). */
function words(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"'<>|;&(),=]+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}
const looksLikePath = (w: string) => /[\\/]|^~|^%|\$|^\.\.?$|^[A-Za-z]:/.test(w) || /~\d/.test(w);

/** Why a shell command is refused, or null. Errs towards refusing. */
export function commandRefusal(command: unknown, guard: LiveCheckoutGuard): string | null {
  const text = Array.isArray(command) ? command.map(String).join(" ") : typeof command === "string" ? command : "";
  if (!text) return null;
  if (LINK_COMMAND.test(text)) return LINK_REFUSAL;
  const r = resolver(guard);
  // Spelled-out root anywhere in the text (after expanding env vars), even inside a longer word.
  const expanded = folded(expandPathText(text, guard), r.platform);
  const cwdSpell = folded(r.cwd, r.platform), rootSpell = folded(r.root, r.platform);
  const lexicalRoot = folded(pathFor(r.platform).resolve(guard.protectedRoot), r.platform);
  const withoutCwd = expanded.split(cwdSpell).join(" ");
  if (withoutCwd.includes(rootSpell) || withoutCwd.includes(lexicalRoot)) return LIVE_CHECKOUT_REFUSAL;
  // Changing directory out of the task folder: later relative paths would be relative to elsewhere.
  for (const m of text.matchAll(CHDIR)) {
    const dest = m[1];
    if (!dest || !r.inTask(r.resolve(dest))) return LIVE_CHECKOUT_REFUSAL;
  }
  if (/\bgit\b[^\n]*\s-C\s/.test(text)) {
    const dest = /\s-C\s+("[^"]*"|'[^']*'|\S+)/.exec(text)?.[1];
    if (!dest || !r.inTask(r.resolve(dest))) return LIVE_CHECKOUT_REFUSAL;
  }
  for (const w of words(text)) {
    if (!looksLikePath(w)) continue;
    const resolved = r.resolve(w);
    if (r.inLive(resolved) && !r.inTask(resolved)) return LIVE_CHECKOUT_REFUSAL;
    // Climbing out of the task folder with `..` is refused: where it lands can't be bounded.
    if (/(^|[\\/])\.\.([\\/]|$)/.test(w) && !r.inTask(resolved)) return LIVE_CHECKOUT_REFUSAL;
  }
  return null;
}

/** Kept for callers and tests: true when the command would be refused. */
export function commandTouchesLiveCheckout(command: unknown, guard: LiveCheckoutGuard): boolean {
  return commandRefusal(command, guard) !== null;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Claude `can_use_tool`: the refusal message, or null to let the owner decide. */
export function claudeRefusal(tool: string, input: Record<string, any>, guard: LiveCheckoutGuard): string | null {
  if (WRITE_TOOLS.has(tool))
    return [input.file_path, input.notebook_path, input.path].some((v) => pathTouchesLiveCheckout(v, guard)) ? LIVE_CHECKOUT_REFUSAL : null;
  if (SHELL_TOOLS.has(tool)) return commandRefusal(input.command, guard);
  return null;
}
export function claudeRequestTouchesLiveCheckout(tool: string, input: Record<string, any>, guard: LiveCheckoutGuard): boolean {
  return claudeRefusal(tool, input, guard) !== null;
}

/**
 * Codex approval request: the refusal message, or null to show the owner a card. `changedPaths` are
 * the paths Codex announced for this file-change item (`item/started` changes[].path), keyed by
 * itemId. A file-change approval with no known paths is ALWAYS refused: the owner is never asked to
 * approve changes they can't see. Any file change outside the task folder is refused.
 */
export function codexRefusal(method: string, params: Record<string, any>, guard: LiveCheckoutGuard, changedPaths?: readonly string[]): string | null {
  if (/requestUserInput$|elicitation/.test(method)) return null;
  const r = resolver(guard);
  const grants = [params?.grantRoot, params?.cwd, params?.path, ...(Array.isArray(params?.permissions?.fileSystem?.write) ? params.permissions.fileSystem.write : [])];
  if (grants.some((v) => pathTouchesLiveCheckout(v, guard))) return LIVE_CHECKOUT_REFUSAL;
  if (method.includes("fileChange")) {
    if (!changedPaths?.length) return PATHLESS_CHANGE_REFUSAL;
    for (const path of changedPaths) {
      const resolved = r.resolve(path);
      if (r.inLive(resolved) && !r.inTask(resolved)) return LIVE_CHECKOUT_REFUSAL;
      if (!r.inTask(resolved)) return OUTSIDE_TASK_REFUSAL;
    }
    return null;
  }
  if (method.includes("commandExecution")) return commandRefusal(params?.command, guard);
  return null;
}
export function codexRequestTouchesLiveCheckout(method: string, params: Record<string, any>, guard: LiveCheckoutGuard, changedPaths?: readonly string[]): boolean {
  return codexRefusal(method, params, guard, changedPaths) !== null;
}

/** Paths from a completed Codex file change that landed in the live checkout (after the fact). */
export function changesInLiveCheckout(paths: readonly string[], guard: LiveCheckoutGuard): string[] {
  const r = resolver(guard);
  return paths.filter((path) => { const x = r.resolve(path); return r.inLive(x) && !r.inTask(x); });
}

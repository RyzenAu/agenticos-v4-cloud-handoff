import { existsSync, lstatSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import type {
  CommandId,
  OwnershipSpec,
  PersonId,
  RegistryCommand,
  RepoId,
  RepoRegistry,
  RepoRegistryEntry,
  RoleAssignment,
  RoleId,
} from "./contracts";

/**
 * The owner-edited repo registry, `.operator-data/coding/repos.json` (CODING-HARNESS §3.3). It is the
 * only source of repos, worktree locations, protected branches, remote classes and runnable commands:
 * no free-text command or caller-supplied path is ever accepted. Validation is strict and total: a
 * registry with any error is refused as a whole, never partly loaded.
 */

export type RegistryError = { path: string; message: string };
export class RegistryInvalid extends Error {
  constructor(readonly errors: readonly RegistryError[]) {
    super(`The coding repo registry is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }
}

const REPO_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const COMMAND_ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const PERSON_ID = /^[a-z][a-z0-9-]{1,31}$/;
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!\/)[A-Za-z0-9._/-]{1,100}(?<!\/)(?<!\.lock)$/;
const REMOTE = /^[A-Za-z0-9._-]{1,60}$/;
/** Launchers that turn argv into free text. A registry command must name the real program. */
const SHELLS = /^(?:cmd|cmd\.exe|command\.com|powershell|powershell\.exe|pwsh|pwsh\.exe|bash|bash\.exe|sh|sh\.exe|zsh|fish|wsl|wsl\.exe|env|start|call)$/i;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 60 * 60_000;
/** Branches that must always be protected, whatever the file says. */
export const ALWAYS_PROTECTED = ["main", "master", "production"] as const;

const isAbsoluteAnywhere = (value: string) => nodePath.win32.isAbsolute(value) || nodePath.posix.isAbsolute(value);
const fold = (value: string) => nodePath.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const inside = (child: string, parent: string) => fold(child) === fold(parent) || fold(child).startsWith(fold(parent) + "/");

function checkCommand(value: unknown, at: string, errors: RegistryError[]): value is RegistryCommand {
  const before = errors.length;
  const push = (message: string, field = "") => errors.push({ path: `${at}${field}`, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) { push("must be an object"); return false; }
  const c = value as Record<string, unknown>;
  const allowed = ["id", "kind", "argv", "cwd", "timeoutMs", "counts"];
  for (const key of Object.keys(c)) if (!allowed.includes(key)) push(`unknown field "${key}"`);
  if (typeof c.id !== "string" || !COMMAND_ID.test(c.id)) push("must be a dotted id like aos.test", ".id");
  if (!["test", "typecheck", "build", "lint"].includes(c.kind as string)) push("must be test, typecheck, build or lint", ".kind");
  if (!Array.isArray(c.argv) || !c.argv.length || c.argv.length > 64 || c.argv.some((a) => typeof a !== "string" || !a || a.length > 500 || /[\0\r\n]/.test(a)))
    push("must be a non-empty array of plain strings", ".argv");
  else {
    const program = nodePath.win32.basename(nodePath.posix.basename(c.argv[0] as string));
    if (SHELLS.test(program)) push(`must name the real program, not a shell (${program})`, ".argv[0]");
    if (/\.(?:cmd|bat)$/i.test(program)) push("must not be a .cmd/.bat shim", ".argv[0]");
    if ((c.argv as string[]).some((a) => /^-[a-z]*c$/i.test(a) && SHELLS.test(program))) push("must not pass a shell -c string", ".argv");
  }
  if (typeof c.cwd !== "string" || isAbsoluteAnywhere(c.cwd) || c.cwd.replace(/\\/g, "/").split("/").includes(".."))
    push("must be a path relative to the worktree root, without ..", ".cwd");
  if (typeof c.timeoutMs !== "number" || !Number.isInteger(c.timeoutMs) || c.timeoutMs < MIN_TIMEOUT || c.timeoutMs > MAX_TIMEOUT)
    push(`must be an integer from ${MIN_TIMEOUT} to ${MAX_TIMEOUT}`, ".timeoutMs");
  if (c.counts !== undefined && !["bun", "vitest", "jest", "node-test", "none"].includes(c.counts as string))
    push("must be bun, vitest, jest, node-test or none", ".counts");
  return errors.length === before;
}

function checkEntry(value: unknown, at: string, errors: RegistryError[]): value is RepoRegistryEntry {
  const before = errors.length;
  const push = (message: string, field = "") => errors.push({ path: `${at}${field}`, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) { push("must be an object"); return false; }
  const r = value as Record<string, unknown>;
  const allowed = ["id", "description", "canonicalPath", "defaultBaseRef", "worktreeParent", "protectedBranches", "remotes", "commands", "nodeModules", "allowedPeople", "denyRead"];
  for (const key of Object.keys(r)) if (!allowed.includes(key)) push(`unknown field "${key}"`);
  if (typeof r.id !== "string" || !REPO_ID.test(r.id)) push("must be a lower-case id", ".id");
  if (typeof r.description !== "string" || !r.description.trim() || r.description.length > 300) push("must be a one-line description", ".description");
  if (typeof r.canonicalPath !== "string" || !isAbsoluteAnywhere(r.canonicalPath)) push("must be an absolute path", ".canonicalPath");
  if (typeof r.worktreeParent !== "string" || !isAbsoluteAnywhere(r.worktreeParent)) push("must be an absolute path", ".worktreeParent");
  else if (typeof r.canonicalPath === "string" && inside(r.worktreeParent, r.canonicalPath))
    push("must be outside the canonical checkout (worktrees never live inside it)", ".worktreeParent");
  if (typeof r.defaultBaseRef !== "string" || !BRANCH.test(r.defaultBaseRef)) push("must be a branch or ref name", ".defaultBaseRef");
  if (!Array.isArray(r.protectedBranches) || r.protectedBranches.some((b) => typeof b !== "string" || !BRANCH.test(b)))
    push("must be a list of branch names", ".protectedBranches");
  else for (const required of ALWAYS_PROTECTED)
    if (!r.protectedBranches.includes(required)) push(`must include ${required}`, ".protectedBranches");
  if (!Array.isArray(r.remotes)) push("must be a list", ".remotes");
  else r.remotes.forEach((remote, i) => {
    const x = remote as Record<string, unknown>;
    if (!x || typeof x !== "object" || typeof x.name !== "string" || !REMOTE.test(x.name)) push("needs a remote name", `.remotes[${i}].name`);
    if (!["backup-private", "production"].includes(x?.class as string)) push("must be backup-private or production", `.remotes[${i}].class`);
    if (typeof x?.vercelLinked !== "boolean") push("must be true or false", `.remotes[${i}].vercelLinked`);
    // Any push to a Vercel-linked origin creates a deployment, so it can never be a "backup".
    if (x?.vercelLinked === true && x?.class !== "production") push("a Vercel-linked remote is always production", `.remotes[${i}].class`);
  });
  if (!Array.isArray(r.commands)) push("must be a list", ".commands");
  else {
    r.commands.forEach((command, i) => checkCommand(command, `${at}.commands[${i}]`, errors));
    const ids = r.commands.map((c) => (c as RegistryCommand)?.id);
    if (new Set(ids).size !== ids.length) push("command ids must be unique", ".commands");
  }
  if (!["junction", "none", "real-install-only"].includes(r.nodeModules as string)) push("must be junction, none or real-install-only", ".nodeModules");
  if (!Array.isArray(r.allowedPeople) || r.allowedPeople.some((p) => typeof p !== "string" || !PERSON_ID.test(p)))
    push("must be a list of person ids (never display names)", ".allowedPeople");
  if (r.denyRead !== undefined && (!Array.isArray(r.denyRead) || r.denyRead.some((g) => typeof g !== "string" || !g)))
    push("must be a list of globs", ".denyRead");
  return errors.length === before;
}

/** Validate a parsed registry. Throws RegistryInvalid listing every problem. */
export function validateRegistry(value: unknown): RepoRegistry {
  const errors: RegistryError[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RegistryInvalid([{ path: "$", message: "must be an object" }]);
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!["version", "repos"].includes(key)) errors.push({ path: "$", message: `unknown field "${key}"` });
  if (v.version !== 1) errors.push({ path: "$.version", message: "must be 1" });
  if (!Array.isArray(v.repos)) errors.push({ path: "$.repos", message: "must be a list" });
  else {
    v.repos.forEach((entry, i) => checkEntry(entry, `$.repos[${i}]`, errors));
    const ids = v.repos.map((r) => (r as RepoRegistryEntry)?.id);
    if (new Set(ids).size !== ids.length) errors.push({ path: "$.repos", message: "repo ids must be unique" });
    const parents = v.repos.map((r) => (r as RepoRegistryEntry)?.canonicalPath).filter((p): p is string => typeof p === "string");
    if (new Set(parents.map(fold)).size !== parents.length) errors.push({ path: "$.repos", message: "two entries point at the same checkout" });
  }
  if (errors.length) throw new RegistryInvalid(errors);
  return value as RepoRegistry;
}

/** Load the registry file. Missing = an empty registry (no repos can be coded). A symlink, an
 * oversized file or invalid JSON is refused, never partly trusted. */
export function loadRegistry(file: string): RepoRegistry {
  if (!existsSync(file)) return { version: 1, repos: [] };
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new RegistryInvalid([{ path: file, message: "cannot be opened safely" }]);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new RegistryInvalid([{ path: file, message: "is not valid JSON" }]); }
  return validateRegistry(parsed);
}

export function repoById(registry: RepoRegistry, id: RepoId | string): RepoRegistryEntry | null {
  return registry.repos.find((r) => r.id === id) ?? null;
}

/** Repos a verified person may use. `personId` comes from the Stage B principal, never a body. */
export function reposFor(registry: RepoRegistry, personId: PersonId | string): RepoRegistryEntry[] {
  return registry.repos.filter((r) => r.allowedPeople.includes(personId as PersonId));
}

export function commandById(entry: RepoRegistryEntry, id: CommandId | string): RegistryCommand | null {
  return entry.commands.find((c) => c.id === id) ?? null;
}

export function isProtectedBranch(entry: RepoRegistryEntry, branch: string): boolean {
  const name = branch.replace(/^refs\/heads\//, "");
  return entry.protectedBranches.includes(name) || (ALWAYS_PROTECTED as readonly string[]).includes(name);
}

// ─────────────────────────── ownership globs ───────────────────────────

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. Forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Is this repo-relative path owned under the spec (globs or exact new files)? */
export function ownsPath(owns: OwnershipSpec, path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return owns.newFiles.some((f) => f.replace(/\\/g, "/") === p) || owns.globs.some((g) => globToRegExp(g).test(p));
}

/**
 * Windows name aliases (REVIEW-T3 minor): "file." and "file " are the same file, and "file:stream" is an
 * alternate data stream of it. Compare on the name Windows actually opens.
 */
export function windowsName(rel: string): string {
  return rel.split("/").map((seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, "") || seg).join("/");
}

/**
 * Files that configure an AGENT or a tool that runs code (REVIEW-T3 F4): Claude/Codex/Cursor/VS Code
 * settings and hooks, MCP config, instruction files a later session loads (CLAUDE.md, AGENTS.md), git
 * hooks and attributes, package-manager config that can preload code. A builder never writes these, a
 * spec never owns them, and a run refuses to start or resume when one changed in its worktree.
 */
export const AGENT_CONFIG = /(?:^|\/)(?:\.claude|\.codex|\.cursor|\.vscode|\.idea|\.husky|\.devcontainer|\.githooks|\.github\/workflows)(?:\/|$)|(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|AGENTS\.override\.md|\.mcp\.json|\.gitmodules|\.gitattributes|\.gitconfig|\.cursorrules|\.npmrc|\.yarnrc|\.yarnrc\.yml|bunfig\.toml|\.bunfig\.toml|lefthook\.ya?ml|\.pre-commit-config\.yaml)$/i;
export const isAgentConfig = (rel: string) => AGENT_CONFIG.test(windowsName(rel.replace(/\\/g, "/")));
/** Where ignored agent config usually hides (git pathspecs, case-insensitive), for the pre-start check. */
export const AGENT_CONFIG_PATHSPECS = [".claude", ".codex", ".cursor", ".vscode", ".husky", ".githooks", ".mcp.json", "CLAUDE.local.md", "AGENTS.override.md", ".cursorrules"].map((p) => `:(icase)${p}`);

export type OwnershipProblem = { code: "ownership_overlap" | "ownership_empty" | "path_outside_repo" | "agent_config"; roleId: RoleId; detail: string };

/**
 * Validator rule (§3.2): writing roles' ownership sets are disjoint, checked against the files git
 * tracks plus each role's declared new paths; read-only roles own nothing; nothing escapes the repo.
 */
export function checkOwnership(roles: readonly RoleAssignment[], trackedFiles: readonly string[]): OwnershipProblem[] {
  const problems: OwnershipProblem[] = [];
  const writers = roles.filter((r) => r.access === "write");
  for (const role of roles) {
    const entries = [...role.owns.globs, ...role.owns.newFiles];
    if (role.access !== "write" && entries.length)
      problems.push({ code: "ownership_overlap", roleId: role.roleId, detail: "a read-only role cannot own files" });
    for (const entry of entries) {
      const e = entry.replace(/\\/g, "/");
      if (isAbsoluteAnywhere(e) || e.split("/").includes("..")) problems.push({ code: "path_outside_repo", roleId: role.roleId, detail: e });
      // REVIEW-T3 F4: a role never owns agent or tool config (settings, hooks, instruction files), even by name.
      else if (isAgentConfig(e.replace(/\*+\/?/g, ""))) problems.push({ code: "agent_config", roleId: role.roleId, detail: `${e} is agent or tool configuration; no role may write it` });
    }
  }
  const universe = [...new Set([...trackedFiles, ...writers.flatMap((r) => r.owns.newFiles)].map((f) => f.replace(/\\/g, "/")))];
  const claimed = new Map<string, RoleId>();
  for (const role of writers) {
    const mine = universe.filter((f) => ownsPath(role.owns, f));
    if (!mine.length) problems.push({ code: "ownership_empty", roleId: role.roleId, detail: "owns no existing or declared file" });
    for (const file of mine) {
      const other = claimed.get(file);
      if (other && other !== role.roleId) problems.push({ code: "ownership_overlap", roleId: role.roleId, detail: `${file} is also owned by ${other}` });
      else claimed.set(file, role.roleId);
    }
  }
  return problems;
}

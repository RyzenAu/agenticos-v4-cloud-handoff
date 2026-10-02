import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { PolicyFn, PolicyRequest, PolicyVerdict } from "./types";

/**
 * Opt-in context helper for ONE Claude coding worker (programme CM pilot, 1 Oct 2026; see
 * docs/programme-20261001/CONTEXT-MODE-PILOT.md). The helper is context-mode (mksglu/context-mode, Elastic
 * License 2.0, internal M&U use only): an MCP server that runs a command in a subprocess, keeps the raw
 * output in a SQLite FTS5 store and returns only a summary plus a way to search the store later.
 *
 * What this module does, and what it never does:
 *  - MCP ONLY. No hook is installed: the runner keeps `disableAllHooks`, and the helper's own start.mjs (which
 *    rewrites the profile's settings.json and registers a hook) is never run. The bundle is started directly.
 *  - Every run gets its own data dir (CONTEXT_MODE_DIR) and its own CLAUDE_CONFIG_DIR *for the helper process*,
 *    both under the job's scratch, so two jobs can never read each other's store and the helper cannot touch the
 *    real profile.
 *  - Only three of its tools are exposed (ctx_batch_execute, ctx_execute, ctx_search) plus ctx_index. The rest
 *    are removed at the CLI (`--disallowedTools`) AND refused by the policy.
 *  - The helper's code-execution tools are NOT a way round policy.ts: each shell command is decided by the very
 *    same Bash verdict a plain Bash call gets (same worktree confinement, secret paths, consequential git,
 *    run-time-built text, network), and anything that is not plain shell (JavaScript, Python, background
 *    processes, a custom cwd outside the worktree) is denied.
 */

export const CONTEXT_HELPER_KIND = "context-mode" as const;
export type ContextHelperKind = typeof CONTEXT_HELPER_KIND;
/** The MCP server key in --mcp-config; it fixes the tool names (mcp__context-mode__ctx_*). */
export const CM_SERVER = "context-mode";
const PREFIX = `mcp__${CM_SERVER}__`;
export const CM_PINNED_VERSION = "1.0.169";
export const CM_PINNED_COMMIT = "573e697bcab10d8b743ab3e9444bcf0a0fcc709a";
/** Where the pilot clone lives on this PC (D:, never a global install). Override with AGENTICOS_CONTEXT_MODE_DIR. */
export const CM_DEFAULT_DIR = "D:/prog-scratch/ref-context-mode";

/** Tools the model may call (policy additionally constrains their arguments). */
export const CM_TOOLS = ["ctx_batch_execute", "ctx_execute", "ctx_search", "ctx_index"] as const;
/** Everything else the server registers: removed at the CLI, refused by the policy. */
export const CM_BLOCKED_TOOLS = ["ctx_execute_file", "ctx_fetch_and_index", "ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge", "ctx_insight"] as const;
export const CM_DISALLOWED = CM_BLOCKED_TOOLS.map((t) => `${PREFIX}${t}`);

export type ContextHelperRequest = {
  kind: ContextHelperKind;
  /** Per-run data dir (the job's scratch). Must be absolute; created if absent. */
  dataDir: string;
  /** The context-mode checkout; default AGENTICOS_CONTEXT_MODE_DIR or CM_DEFAULT_DIR. */
  installDir?: string;
};

export type ContextHelperLaunch = {
  /** The JSON for --mcp-config. */
  mcpConfig: string;
  /** Extra --disallowedTools entries. */
  disallowed: string[];
  /** Appended to the role's system text (no hook injects routing, so the model is told once). */
  guidance: string;
  dataDir: string;
};

export type ContextHelperResolution = { ok: true; installDir: string; server: string; version: string } | { ok: false; reason: string };

/** Checks the checkout is the pinned one and is Elastic-2.0 licensed. Never reads anything but package.json/LICENSE. */
export function resolveContextMode(request: Pick<ContextHelperRequest, "installDir">, env: NodeJS.ProcessEnv = process.env): ContextHelperResolution {
  const dir = resolve(request.installDir ?? env.AGENTICOS_CONTEXT_MODE_DIR ?? CM_DEFAULT_DIR);
  // Never a profile or a global npm location: the helper is a pinned checkout the owner placed on purpose (D: by default).
  if (/[\\/]\.(claude|codex)[\\/]|[\\/]node_modules[\\/]/i.test(dir)) return { ok: false, reason: "the context helper must not live inside an agent profile or node_modules" };
  const server = join(dir, "server.bundle.mjs");
  if (!existsSync(server)) return { ok: false, reason: `context-mode is not installed at ${dir}` };
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; license?: string };
    if (pkg.name !== "context-mode") return { ok: false, reason: "that folder is not context-mode" };
    if (pkg.license !== "Elastic-2.0") return { ok: false, reason: "context-mode's licence is not Elastic-2.0; internal use is only cleared for that licence" };
    if (pkg.version !== CM_PINNED_VERSION) return { ok: false, reason: `context-mode ${pkg.version} is not the pinned ${CM_PINNED_VERSION}` };
    return { ok: true, installDir: dir, server, version: pkg.version };
  } catch { return { ok: false, reason: "context-mode's package.json can't be read" }; }
}

export const CM_GUIDANCE = [
  "CONTEXT HELPER (opt-in, this run only). Large command output is kept out of your context:",
  "- For a command whose output may be long (tests, typecheck, searches, logs) call mcp__context-mode__ctx_batch_execute with commands:[{label,command}] and queries:[...] (or mcp__context-mode__ctx_execute with language \"shell\" and an `intent`). Only matching sections come back; the full output is stored.",
  "- Later, to recall an exact detail (a line number, an error code, a file name) call mcp__context-mode__ctx_search with queries:[...] instead of re-running the command.",
  "- Commands are still checked by the same coding policy as Bash: plain shell only, inside your worktree. Use Bash for short output and for edits and commits.",
].join("\n");

/** Builds the per-run launch pieces. Creates the data dir; writes nothing else and never touches the install. */
export function contextModeLaunch(input: { request: ContextHelperRequest; resolution: Extract<ContextHelperResolution, { ok: true }>; runtime: string; worktree: string; sessionId: string }): ContextHelperLaunch {
  const dataDir = resolve(input.request.dataDir);
  const configDir = join(dataDir, "profile-stub");
  mkdirSync(join(dataDir, "store"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const config = {
    mcpServers: {
      [CM_SERVER]: {
        command: input.runtime,
        args: [input.resolution.server],
        env: {
          CONTEXT_MODE_DIR: join(dataDir, "store"),
          // The helper reads/writes under its config dir (auto-memory, plugin registry). Point it at an empty stub so
          // it can never see or change a real profile, whichever account slot the run uses.
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_PROJECT_DIR: input.worktree,
          CONTEXT_MODE_PROJECT_DIR: input.worktree,
          CLAUDE_SESSION_ID: input.sessionId,
        },
      },
    },
  };
  return { mcpConfig: JSON.stringify(config), disallowed: [...CM_DISALLOWED], guidance: CM_GUIDANCE, dataDir };
}

/** Is this a tool of the helper's server (decided by the wrapper below rather than the generic MCP refusal)? */
export const isContextModeTool = (tool: string) => tool.startsWith(PREFIX);

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const deny = (target: string, message: string): PolicyVerdict => ({ decision: "auto-deny", rule: "mcp-tool", target, message });

/**
 * Wraps the role's policy so the helper's tools are decided by the SAME engine, never loosened:
 *  - shell code / batch commands: the base policy's verdict for a Bash call with that exact text;
 *  - cwd: must be inside the worktree (decided as a Glob of that path);
 *  - ctx_index: ONE explicit regular file that passes the Read verdict (its walk over a directory would skip the per-file secret rules, so
 *    directories, globs, symlinks and the walk options include/exclude/extensions/maxDepth/maxFiles/followSymlinks/respectGitignore are denied);
 *    inline content is allowed (it only fills the run's own store);
 *  - everything else the helper registers (and any other mcp__ tool) falls to the base policy, which refuses it.
 */
export function contextModePolicy(base: PolicyFn, worktree?: string): PolicyFn {
  return (request: PolicyRequest): PolicyVerdict => {
    if (request.kind !== "tool" || !isContextModeTool(request.tool)) return base(request);
    const tool = request.tool.slice(PREFIX.length);
    const input = record(request.input) ? request.input : {};
    const bash = (command: unknown): PolicyVerdict => {
      if (typeof command !== "string" || !command.trim()) return deny(tool, "That call has no command to check.");
      return base({ kind: "tool", tool: "Bash", input: { command } });
    };
    const cwdOk = (): PolicyVerdict | null => {
      if (input.cwd === undefined || input.cwd === null || input.cwd === "") return null;
      if (typeof input.cwd !== "string") return deny(tool, "cwd must be a path inside your worktree.");
      const v = base({ kind: "tool", tool: "Glob", input: { path: input.cwd } });
      return v.decision === "auto-allow" ? null : v;
    };
    switch (tool) {
      case "ctx_execute": {
        if (input.language !== "shell") return deny(tool, "Through the context helper only plain shell commands are allowed (they get the same checks as Bash). Use ctx_batch_execute or ctx_execute with language \"shell\".");
        if (input.background === true) return deny(tool, "Background processes are not available to coding roles.");
        return cwdOk() ?? bash(input.code);
      }
      case "ctx_batch_execute": {
        const commands = Array.isArray(input.commands) ? input.commands : null;
        if (!commands || !commands.length || commands.length > 12) return deny(tool, "Give 1 to 12 shell commands.");
        const bad = cwdOk();
        if (bad) return bad;
        let worst: PolicyVerdict | null = null;
        for (const c of commands) {
          const v = bash(record(c) ? c.command : undefined);
          if (v.decision === "auto-deny") return v;
          if (v.decision === "escalate") worst = worst ?? v;
        }
        return worst ?? { decision: "auto-allow", rule: "read-in-worktree", target: `${commands.length} commands`, message: "Each command passed the coding policy." };
      }
      case "ctx_search":
        return { decision: "auto-allow", rule: "harmless-tool", target: "ctx_search", message: "Searches only this run's own store." };
      case "ctx_index": {
        const extra = Object.keys(input).filter((k) => !["path", "content", "source"].includes(k));
        if (extra.length) return deny(tool, `ctx_index takes only a content text or one file path (not ${extra.join(", ")}).`);
        if (input.path !== undefined && input.path !== null && input.path !== "") {
          if (typeof input.path !== "string" || /[*?[\]{}]/.test(input.path)) return deny(tool, "ctx_index takes one explicit file path, not a pattern.");
          const verdict = base({ kind: "tool", tool: "Read", input: { file_path: input.path } });
          if (verdict.decision !== "auto-allow") return verdict;
          // A directory walk would not apply the per-file secret rules: only a regular file (never a directory or symlink) is indexed.
          try {
            const at = lstatSync(worktree && !isAbsolute(input.path) ? resolve(worktree, input.path) : resolve(input.path));
            if (!at.isFile()) return deny(tool, "ctx_index takes one regular file, not a directory or a link. Read the files you need instead.");
          } catch {
            if (!worktree && !isAbsolute(input.path)) return deny(tool, "ctx_index needs an absolute file path here.");
          }
          return verdict;
        }
        if (typeof input.content === "string") return { decision: "auto-allow", rule: "harmless-tool", target: "ctx_index", message: "Indexes text into this run's own store." };
        return deny(tool, "Give content or a path inside your worktree.");
      }
      default:
        return base({ kind: "mcp", server: CM_SERVER, tool });
    }
  };
}

/** Which of the helper's data dirs is this? (for cleanup and tests) */
const safeName = (v: string) => basename(v).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_");
/** One job's data lives in <root>/<jobId>/<roleId>, so deleting the job's directory removes every role's store at once. */
export const contextDataName = (jobId: string, roleId: string) => join(safeName(jobId), safeName(roleId));
/** Default root for the helper's per-job data: under the OS data dir (MU_DATA_DIR), never a fixed drive. */
export const contextDataRootFor = (codingDataDir: string) => join(codingDataDir, "context-mode");
/** Delete one job's helper data (raw command output kept by the helper). Only ever removes <dataRoot>/<jobId>. */
export function removeContextJobData(dataRoot: string, jobId: string): boolean {
  const dir = join(dataRoot, safeName(jobId));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

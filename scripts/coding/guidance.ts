import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBinding, GuidanceUse, RoleKind } from "./contracts";
import { scanLine } from "./redact";
import type { RoleRunner, RunnerHandle, RunnerStart } from "./runners/types";

/**
 * Engineering guidance for coding roles (1 Oct 2026, track K).
 *
 * One mechanism: three short markdown files in `scripts/coding/guidance/` (builder, reviewer, planner), pinned
 * by `manifest.json` (version, upstream commit, per-file sha256). A coding runner loads no profile CLAUDE.md or
 * global skills, so the ONLY way guidance reaches a role is through the system text. `withGuidance` wraps any
 * RoleRunner and appends the role's file to `RunnerStart.system`, which every route already carries (Claude:
 * --append-system-prompt-file; Codex: developerInstructions; router: the system message). The turn's outcome
 * then records exactly which files (repo path, full sha256, size) were supplied, or why none were, and
 * `buildReceipt` copies that to the receipt. A runner route that is not in `supports` gets no guidance and
 * says so ("not supported"), never a silent claim.
 *
 * Bounded: a file over MAX_GUIDANCE_CHARS is refused whole (never trimmed), as is one shaped like a credential.
 * Guidance is subordinate: the text itself says the job brief and policy win.
 */

export type GuidanceRole = "builder" | "reviewer" | "planner";
export const GUIDANCE_FILE: Record<GuidanceRole, string> = { builder: "builder.md", reviewer: "reviewer.md", planner: "planner.md" };
export const MAX_GUIDANCE_CHARS = 6000;
export const GUIDANCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "guidance");
/** Repo-relative form recorded in receipts (a path, never contents). */
export const GUIDANCE_REPO_PATH = "scripts/coding/guidance";

export type { GuidanceUse };

export const SUPPORTED_ROUTES: readonly AgentBinding["route"][] = ["claude-code-cli", "codex-app-server", "model-router"];

/** The guidance file a role kind takes. The tester role runs commands, not a model, so it has none. */
export function guidanceRoleFor(role: RoleKind): GuidanceRole | null {
  return role === "builder" || role === "test-author" ? "builder" : role === "reviewer" ? "reviewer" : role === "planner" ? "planner" : null;
}

type Manifest = { version?: unknown; files?: Record<string, unknown> };
function readManifest(dir: string): Manifest | null {
  try { return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest; } catch { return null; }
}

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Load one role's guidance. A file that is missing, a link, too large or credential-shaped is refused with a reason. */
export function loadGuidance(role: GuidanceRole, dir = GUIDANCE_DIR): { text: string; use: GuidanceUse } {
  const file = GUIDANCE_FILE[role];
  const path = `${GUIDANCE_REPO_PATH}/${file}`;
  const manifest = readManifest(dir);
  const version = typeof manifest?.version === "string" ? manifest.version : null;
  const refuse = (reason: string, chars = 0) => ({ text: "", use: { role, path, sha256: null, chars, version, supplied: false, reason } as GuidanceUse });
  const full = join(dir, file);
  try {
    if (!existsSync(full)) return refuse("guidance file is missing");
    const info = lstatSync(full);
    if (info.isSymbolicLink() || !info.isFile()) return refuse("guidance file can't be read safely");
    const text = readFileSync(full, "utf8").replace(/\r\n/g, "\n").trim();
    if (text.length > MAX_GUIDANCE_CHARS) return refuse(`guidance file is over ${MAX_GUIDANCE_CHARS} characters, so it was left out`, text.length);
    if (text.split("\n").some((line) => scanLine(line).length > 0)) return refuse("guidance file looks like it contains a credential, so it was left out", text.length);
    const sha256 = digestOf(text);
    const pinned = manifest?.files?.[file];
    return { text, use: { role, path, sha256, chars: text.length, version, supplied: true, ...(typeof pinned === "string" && pinned !== sha256 ? { unpinned: true } : {}) } };
  } catch { return refuse("guidance file couldn't be read"); }
}

/** The system-text block a role receives. */
export function guidanceBlock(role: GuidanceRole, text: string): string {
  return `\n\nEngineering workflow for your ${role} role (the job brief, owned paths and policy above always take precedence over it):\n${text}`;
}

export type WithGuidanceOptions = { dir?: string; supports?: readonly AgentBinding["route"][] };

/**
 * Wrap a runner so every start it receives carries the role's guidance, and its outcome says what went in.
 * The wrapped runner is otherwise untouched: same kind, same handle, same events.
 */
export function withGuidance(inner: RoleRunner, options: WithGuidanceOptions = {}): RoleRunner {
  const supports = options.supports ?? SUPPORTED_ROUTES;
  return {
    kind: inner.kind,
    start(input: RunnerStart): RunnerHandle {
      const role = guidanceRoleFor(input.role);
      if (!role) return inner.start(input);
      let use: GuidanceUse;
      let system = input.system;
      if (!supports.includes(input.binding.route)) {
        use = { role, path: `${GUIDANCE_REPO_PATH}/${GUIDANCE_FILE[role]}`, sha256: null, chars: 0, version: readManifestVersion(options.dir), supplied: false, reason: `not supported on the ${input.binding.route} route` };
      } else {
        const loaded = loadGuidance(role, options.dir);
        use = loaded.use;
        if (loaded.use.supplied) system = `${input.system}${guidanceBlock(role, loaded.text)}`;
      }
      try { input.onEvent({ type: "step", label: use.supplied ? `Engineering guidance: ${use.path} (sha ${use.sha256?.slice(0, 12)})` : `Engineering guidance not supplied: ${use.reason}` }); } catch { /* an event sink never breaks the run */ }
      const handle = inner.start({ ...input, system });
      return { ...handle, done: handle.done.then((o) => ({ ...o, guidance: [use] })) };
    },
  };
}

function readManifestVersion(dir = GUIDANCE_DIR): string | null {
  const v = readManifest(dir)?.version;
  return typeof v === "string" ? v : null;
}

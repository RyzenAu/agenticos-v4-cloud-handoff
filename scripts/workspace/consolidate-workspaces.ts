// Migration: consolidate the OS's workspaces into THREE (M&U Ventures, Receptionist, Websites).
//
// What it reads (read-only, never changed):
//   - src/data/live-data.json: recentProjects + allProjects, the project folders /workspaces listed
//     one per card before this change. These are the "old workspace records".
//   - .operator-data/workspace.json: checked for a top-level `workspaces` list (there is none on the
//     owner's PC; it holds memory sources, inbox and settings). Any found are merged the same way.
//   - .operator-data/workspaces.json: a previous run's saved grouping, kept (re-running is safe).
//   - git, read-only: `git rev-parse --git-common-dir` in each folder that still exists, so a linked
//     worktree collapses into its parent repo whatever it's called.
//   - the top level of the --discover folders (default: the folder holding this checkout) for repos
//     on the known list or matching the rules, so a site with no session this week still appears.
//
// What it writes, only with --apply:
//   1. A backup FIRST: .operator-data/backups/workspaces-<stamp>/ with
//        manifest.json            what was read and written, and how to undo
//        projects-before.json     every old workspace record, verbatim
//        workspaces.json.before   the previous saved file, if there was one
//      Nothing is written if the backup fails.
//   2. .operator-data/workspaces.json: the three workspaces with their projects, which folder
//      belongs to which project, and the archive of the old records. No folder, session, memory
//      source or other file is touched or deleted.
//
// Undo: bun scripts/workspace/consolidate-workspaces-undo.ts --root <folder> [--backup <dir>] --apply
//
// CLI (dry run by default; prints counts and the mapping, never file contents):
//   bun scripts/workspace/consolidate-workspaces.ts --root <AgenticOS folder> [--apply]
//       [--discover <dir>]... [--no-git] [--live-data <file>] [--json]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  KNOWN_PROJECTS,
  THREE_WORKSPACES,
  classifyProject,
  isWorkspaceId,
  parseWorkspacesFile,
  projectOfFolder,
  type Placement,
  type ProjectRecord,
  type ProjectRef,
  type SavedProject,
  type WorkspaceId,
  type WorkspacesFile,
} from "./three-workspaces";
import { dataDirFor } from "../cloud/data-dir";

export const WORKSPACES_FILE = "workspaces.json";

export const workspacesFilePath = (root: string) => join(dataDirFor(root), WORKSPACES_FILE);

export const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Finds a folder's parent repo. Injected so tests don't need real repos. */
export type GitParent = (dir: string) => string | null;

/** The repo a folder belongs to: for a linked worktree, the main checkout; null if not in git. */
export const gitParent: GitParent = (dir) => {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (r.status !== 0) return null;
    const common = r.stdout.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!common) return null;
    return /\/\.git$/i.test(common) ? common.replace(/\/\.git$/i, "") : common.replace(/\.git$/i, "");
  } catch {
    return null;
  }
};

export type MappingRow = { key: string; folder: string; from: string; project: string; to: WorkspaceId; placement: Placement; resolvedBy: "saved" | "git" | "path" };

export type ProjectRow = { id: string; name: string; to: WorkspaceId; placement: Placement; folders: number; discovered: boolean; path?: string };

export type ConsolidationResult = {
  applied: boolean;
  /** Old workspace records found, by where they came from. */
  found: { liveProjects: number; olderProjects: number; workspaceJson: number; previouslySaved: number; discovered: number };
  /** Distinct folders after de-duplication by key. */
  records: number;
  /** Projects per workspace (what the page shows), and folders per workspace. */
  counts: Record<WorkspaceId, number>;
  folderCounts: Record<WorkspaceId, number>;
  projects: ProjectRow[];
  /** Projects nothing matched: in M&U Ventures by default; move by hand with `overrides`. */
  unmatched: ProjectRow[];
  mapping: MappingRow[];
  backupDir: string | null;
  file: string;
  /** Problems reading an input: the input is skipped, never guessed. */
  warnings: string[];
};

function readJson(file: string, warnings: string[], label: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    warnings.push(`${label} could not be parsed, so it was skipped`);
    return undefined;
  }
}

const asRecords = (value: unknown): ProjectRecord[] =>
  Array.isArray(value)
    ? value.flatMap((p) => {
        const r = p as Partial<ProjectRecord> | null;
        return r && typeof r.key === "string" && r.key ? [r as ProjectRecord] : [];
      })
    : [];

/** Workspace-like records in workspace.json, if a future or older build ever stored some there. */
function workspaceJsonRecords(value: unknown): ProjectRecord[] {
  const list = (value as { workspaces?: unknown } | undefined)?.workspaces;
  if (!Array.isArray(list)) return [];
  return list.flatMap((w) => {
    const r = w as { id?: unknown; key?: unknown; name?: unknown; displayName?: unknown; path?: unknown } | null;
    const key = typeof r?.key === "string" ? r.key : typeof r?.id === "string" ? r.id : "";
    if (!key) return [];
    const name = typeof r?.displayName === "string" ? r.displayName : typeof r?.name === "string" ? r.name : key;
    return [{ key: `workspace-json:${key}`, displayName: name, path: typeof r?.path === "string" ? r.path : undefined }];
  });
}

const refOf = (name: string): ProjectRef => ({ id: name.trim().toLowerCase(), name });

/** A folder's absolute path on this PC, or null ("~/x" → home/x; "D:/x" as is). */
function absolute(path: string | undefined, home: string): string | null {
  if (!path) return null;
  const p = path.replace(/\\/g, "/");
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (/^[a-z]:\//i.test(p) || p.startsWith("/")) return p;
  return null;
}

/** The project a folder on disk belongs to: itself when it's on the known list, else its git parent. */
function projectFromDisk(dir: string, git: GitParent): ProjectRef | null {
  const own = basename(dir);
  if (KNOWN_PROJECTS[own.toLowerCase()]) return refOf(own);
  const parent = git(dir);
  if (!parent) return null;
  return refOf(basename(parent));
}

export function consolidateWorkspaces(options: {
  root: string;
  apply?: boolean;
  now?: () => Date;
  liveDataFile?: string;
  /** Folders whose top-level repos are checked against the known list and rules. */
  discover?: string[];
  git?: GitParent | false;
  home?: string;
}): ConsolidationResult {
  const now = (options.now ?? (() => new Date()))();
  const home = options.home ?? homedir();
  const git: GitParent | null = options.git === false ? null : (options.git ?? gitParent);
  const dataDir = join(dataDirFor(options.root));
  const file = workspacesFilePath(options.root);
  const warnings: string[] = [];

  const live = readJson(options.liveDataFile ?? join(options.root, "src", "data", "live-data.json"), warnings, "live-data.json") as
    | { recentProjects?: unknown; allProjects?: unknown; isExample?: unknown }
    | undefined;
  if (live === undefined && !warnings.length) warnings.push("live-data.json not found: run bun run scripts/aggregate.ts first, or no project folders are known");
  if (live && live.isExample === true) warnings.push("live-data.json is the shipped example, not this PC's data");
  const liveProjects = asRecords(live?.recentProjects);
  const olderProjects = asRecords(live?.allProjects);
  // workspace.json is 50+ MB on the owner's PC; it is only read, and only its `workspaces` key used.
  const fromWorkspaceJson = workspaceJsonRecords(readJson(join(dataDir, "workspace.json"), warnings, "workspace.json"));
  const previousRaw = readJson(file, warnings, WORKSPACES_FILE);
  const previous = previousRaw === undefined ? null : parseWorkspacesFile(previousRaw);
  if (previousRaw !== undefined && !previous) warnings.push(`${WORKSPACES_FILE} exists but is not a saved grouping; it is backed up and replaced only with --apply`);

  // Every old record once, first sighting wins (this week's data over older copies).
  const seen = new Map<string, { record: ProjectRecord; from: string }>();
  const add = (records: ProjectRecord[], from: string) => {
    for (const r of records) if (!seen.has(r.key)) seen.set(r.key, { record: r, from });
  };
  add(liveProjects, "this week");
  add(olderProjects, "all-time list");
  add(fromWorkspaceJson, "workspace.json");
  add(previous?.archived.records ?? [], "earlier archive");

  // Folder → project: saved, else git (folders that still exist), else the path rules.
  const parents: Record<string, ProjectRef> = {};
  const resolvedBy = new Map<string, MappingRow["resolvedBy"]>();
  for (const { record } of seen.values()) {
    const saved = previous?.parents[record.key];
    if (saved) {
      parents[record.key] = saved;
      resolvedBy.set(record.key, "saved");
      continue;
    }
    const dir = git ? absolute(record.path, home) : null;
    const fromGit = dir && existsSync(dir) && !projectOfFolder(record).id.match(/^(scratch|home)$/) ? projectFromDisk(dir, git!) : null;
    parents[record.key] = fromGit ?? projectOfFolder(record);
    resolvedBy.set(record.key, fromGit ? "git" : "path");
  }

  // Projects: from the folders, earlier saves and repos found on disk.
  const projects = new Map<string, { ref: ProjectRef; path?: string; discovered: boolean; folders: number }>();
  const ensure = (ref: ProjectRef, extra: { path?: string; discovered?: boolean } = {}) => {
    const p = projects.get(ref.id) ?? { ref, discovered: false, folders: 0 };
    if (extra.path && !p.path) p.path = extra.path;
    if (extra.discovered) p.discovered = true;
    projects.set(ref.id, p);
    return p;
  };
  for (const [key, ref] of Object.entries(parents)) if (seen.get(key)) ensure(ref).folders++;
  for (const w of previous?.workspaces ?? []) for (const p of w.projects) ensure(p, { path: p.path });
  let discovered = 0;
  for (const dir of options.discover ?? [dirname(resolve(options.root))]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      warnings.push(`${dir} could not be listed, so nothing there was discovered`);
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (/^(home|scratch)$/i.test(name)) continue; // the built-in Home and Scratch projects are never folders on disk
      const known = !!KNOWN_PROJECTS[name.toLowerCase()];
      try {
        // A known M&U folder joins even without git (a client build, the website hub); others need a repo.
        if (!statSync(full).isDirectory() || (!known && !existsSync(join(full, ".git")))) continue;
      } catch {
        continue;
      }
      const ref = known ? refOf(name) : git ? projectFromDisk(full, git) : refOf(name);
      if (!ref) continue;
      // Only M&U's own repos and rule matches join by discovery; other repos on disk stay out.
      if (classifyProject(ref).placement === "unmatched") continue;
      const isRoot = ref.id === name.toLowerCase();
      if (!projects.has(ref.id)) discovered++;
      ensure(ref, { path: isRoot ? full.replace(/\\/g, "/") : undefined, discovered: true });
    }
  }

  // Project → workspace: override > earlier save > known list > rules > M&U Ventures.
  const savedAt = new Map<string, WorkspaceId>();
  for (const w of previous?.workspaces ?? []) for (const p of w.projects) savedAt.set(p.id, w.id);
  const overrides = Object.fromEntries(Object.entries(previous?.overrides ?? {}).filter(([, w]) => isWorkspaceId(w))) as Record<string, WorkspaceId>;
  const rows: ProjectRow[] = [...projects.values()].map(({ ref, path, discovered: d, folders }) => {
    let to: WorkspaceId, placement: Placement;
    if (overrides[ref.id]) [to, placement] = [overrides[ref.id], "override"];
    else if (savedAt.has(ref.id)) [to, placement] = [savedAt.get(ref.id)!, "saved"];
    else ({ workspace: to, placement } = classifyProject(ref));
    return { id: ref.id, name: ref.name, to, placement, folders, discovered: d, ...(path ? { path } : {}) };
  });
  rows.sort((a, b) => a.to.localeCompare(b.to) || b.folders - a.folders || a.name.localeCompare(b.name));
  const workspaceOf = new Map(rows.map((r) => [r.id, r]));

  const mapping: MappingRow[] = [...seen.values()].map(({ record, from }) => {
    const project = workspaceOf.get(parents[record.key].id)!;
    return { key: record.key, folder: record.displayName || record.key, from, project: project.name, to: project.to, placement: project.placement, resolvedBy: resolvedBy.get(record.key)! };
  });
  const tally = (f: (r: ProjectRow) => number) =>
    Object.fromEntries(THREE_WORKSPACES.map((w) => [w.id, rows.filter((r) => r.to === w.id).reduce((n, r) => n + f(r), 0)])) as Record<WorkspaceId, number>;

  const next: WorkspacesFile = {
    version: 2,
    migratedAt: now.toISOString(),
    workspaces: THREE_WORKSPACES.map((def) => ({
      ...def,
      projects: rows.filter((r) => r.to === def.id).map((r): SavedProject => ({ id: r.id, name: r.name, placement: r.placement, ...(r.path ? { path: r.path } : {}) })),
    })),
    parents,
    overrides,
    archived: {
      at: previous?.archived.at || now.toISOString(),
      note: "The project folders the OS showed as separate workspaces before they were consolidated into three. Nothing was deleted; each folder belongs to one project, and each project to one of the three.",
      records: [...seen.values()].map((s) => s.record),
    },
  };

  const result: ConsolidationResult = {
    applied: false,
    found: {
      liveProjects: liveProjects.length,
      olderProjects: olderProjects.length,
      workspaceJson: fromWorkspaceJson.length,
      previouslySaved: previous ? previous.workspaces.reduce((n, w) => n + w.projects.length, 0) : 0,
      discovered,
    },
    records: seen.size,
    counts: tally(() => 1),
    folderCounts: tally((r) => r.folders),
    projects: rows,
    unmatched: rows.filter((r) => r.placement === "unmatched"),
    mapping,
    backupDir: null,
    file,
    warnings,
  };
  if (!options.apply) return result;

  // Backup first. A failure here throws before anything is written.
  const backupDir = join(dataDir, "backups", `workspaces-${stampOf(now)}`);
  if (existsSync(backupDir)) throw new Error("BACKUP_EXISTS");
  mkdirSync(backupDir, { recursive: true });
  const hadFile = existsSync(file);
  if (hadFile) copyFileSync(file, join(backupDir, "workspaces.json.before"));
  writeFileSync(join(backupDir, "projects-before.json"), JSON.stringify({ at: now.toISOString(), liveProjects, olderProjects, workspaceJson: fromWorkspaceJson }, null, 2));
  writeFileSync(
    join(backupDir, "manifest.json"),
    JSON.stringify(
      {
        kind: "workspaces-consolidation",
        at: now.toISOString(),
        wrote: file,
        previousFile: hadFile ? "workspaces.json.before" : null,
        counts: result.counts,
        records: seen.size,
        undo: `bun scripts/workspace/consolidate-workspaces-undo.ts --root "${options.root}" --backup "${backupDir}" --apply`,
      },
      null,
      2,
    ),
  );

  // Write atomically: a temp file then a rename, so a crash never leaves half a file.
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(next, null, 2));
  renameSync(temp, file);
  return { ...result, applied: true, backupDir };
}

/** The dry-run report: per workspace, its projects; then the unmatched; then every folder. */
export function formatReport(r: ConsolidationResult): string {
  const out: string[] = [];
  out.push(r.applied ? "APPLIED" : "DRY RUN (nothing written; add --apply)");
  out.push(
    `Old workspace records: ${r.records} folders (this week ${r.found.liveProjects}, all-time list ${r.found.olderProjects}, workspace.json ${r.found.workspaceJson}); earlier save ${r.found.previouslySaved} projects; found on disk ${r.found.discovered} more`,
  );
  for (const w of THREE_WORKSPACES) out.push(`  ${w.name}: ${r.counts[w.id]} projects (${r.folderCounts[w.id]} folders)`);
  for (const w of r.warnings) out.push(`Warning: ${w}`);
  if (r.backupDir) out.push(`Backup: ${r.backupDir}`);
  out.push(`File: ${r.file}`);
  for (const w of THREE_WORKSPACES) {
    out.push("", `## ${w.name}`, "project | folders this week | placement | found on disk");
    for (const p of r.projects.filter((x) => x.to === w.id)) out.push(`${p.name} | ${p.folders} | ${p.placement} | ${p.discovered ? p.path ?? "yes (worktree of it)" : "-"}`);
  }
  out.push("", "## Unmatched (in M&U Ventures by default; move with `overrides` in workspaces.json)");
  out.push(r.unmatched.length ? r.unmatched.map((p) => `${p.name} (${p.folders} folders)`).join("\n") : "none");
  out.push("", "## Every folder", "folder key | folder | from | project | workspace | resolved by");
  for (const m of r.mapping) out.push(`${m.key} | ${m.folder} | ${m.from} | ${m.project} | ${m.to} | ${m.resolvedBy}`);
  return out.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 ? args[i + 1] : undefined;
  };
  const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const root = arg("root");
  if (!root) {
    console.error("Usage: bun scripts/workspace/consolidate-workspaces.ts --root <AgenticOS folder> [--apply] [--discover <dir>]... [--no-git] [--live-data <file>] [--json]");
    process.exit(2);
  }
  const discover = all("discover");
  const r = consolidateWorkspaces({
    root,
    apply: args.includes("--apply"),
    liveDataFile: arg("live-data"),
    discover: discover.length ? [dirname(resolve(root)), ...discover] : undefined,
    git: args.includes("--no-git") ? false : undefined,
  });
  console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r));
}

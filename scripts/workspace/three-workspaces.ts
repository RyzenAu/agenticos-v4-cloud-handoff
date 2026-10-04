// The OS has THREE workspaces (owner, 29 Sep 2026: "too many workspaces; keep one for M&U Ventures
// itself, one for Receptionist, one for Websites").
//
// Before this, /workspaces listed every Claude Code project folder touched in the last week as its
// own "workspace" (102 on the owner's PC: the OS checkout, ~90 agent worktrees, scratch folders).
// Now:
//   folder  → project : a git worktree, agent worktree or scratch folder collapses into its PARENT
//                       repo (by path rules here; the migration confirms with git and saves it).
//   project → workspace: a known list of M&U's repos, then name rules; anything unmatched goes to
//                       M&U Ventures and is flagged so it can be moved by hand.
// Nothing about the folders changes; the migration (consolidate-workspaces.ts) archives the old
// list so the change is reversible.
//
// Pure: no file, git or network access. The server reads .operator-data/workspaces.json (written
// only by the migration) and the page combines it with the live folder list.

export type WorkspaceId = "mu-ventures" | "receptionist" | "websites";

export type WorkspaceDef = { id: WorkspaceId; name: string; purpose: string };

export const THREE_WORKSPACES: readonly WorkspaceDef[] = [
  { id: "mu-ventures", name: "M&U Ventures", purpose: "The business itself: the OS, agents, knowledge and research." },
  { id: "receptionist", name: "Receptionist", purpose: "The AI receptionist: calls, packages, delivery and its builds." },
  { id: "websites", name: "Websites", purpose: "M&U's site, client sites, flagships, demos and films." },
];

export const WORKSPACE_IDS: readonly WorkspaceId[] = THREE_WORKSPACES.map((w) => w.id);

export const isWorkspaceId = (value: unknown): value is WorkspaceId => typeof value === "string" && (WORKSPACE_IDS as readonly string[]).includes(value);

export const workspaceById = (id: WorkspaceId): WorkspaceDef => THREE_WORKSPACES.find((w) => w.id === id)!;

/** One project FOLDER as the aggregator reports it (live-data.json recentProjects / allProjects). */
export type ProjectRecord = {
  key: string;
  displayName?: string;
  /** "~/source/repos/AgenticOS-v4-wt/t6c", "D:/MU-Receptionist-wt-sms", … */
  path?: string;
  sessions?: number;
  messages?: number;
  lastActiveMs?: number | null;
  lastActiveAgo?: string;
};

/** A real project: one repo (or one standalone folder) and the folders that belong to it. */
export type ProjectRef = { id: string; name: string };

/**
 * How a project was placed. `known` = M&U's own list below; `rule:*` = the name rules;
 * `unmatched` = nothing matched, so M&U Ventures by default (listed separately for a hand move);
 * `saved` = the migration's frozen assignment; `override` = a hand edit of workspaces.json.
 */
export type Placement = "known" | "rule:tooling" | "rule:receptionist" | "rule:websites" | "unmatched" | "saved" | "override";

export const PLACEMENT_LABEL: Record<Placement, string> = {
  known: "Known project",
  "rule:tooling": "Scratch and temp folders",
  "rule:receptionist": "Receptionist rule",
  "rule:websites": "Websites rule",
  unmatched: "Unmatched, placed here by default",
  saved: "Saved",
  override: "Moved by hand",
};

// ── Folder → project ─────────────────────────────────────────────────────────────────────────────

export const SCRATCH_PROJECT: ProjectRef = { id: "scratch", name: "Scratch and temp folders" };
export const HOME_PROJECT: ProjectRef = { id: "home", name: "Home folder" };

const TEMP = /(?:^|\/)(?:appdata\/local\/temp|agent-scratch|tmp|temp)(?:\/|$)|scratchpad|claude-bridge-cwd|(?:^|\/)\.tmp-/i;

const slug = (name: string) => name.trim().toLowerCase();
const ref = (name: string): ProjectRef => ({ id: slug(name), name });

/** The folder's path with forward slashes, from `path`, else from the aggregator's slugged key. */
function pathOf(r: ProjectRecord): string {
  if (r.path && r.path.trim()) return r.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return r.key;
}

/**
 * Which project a folder belongs to, by path alone:
 *   …/X-wt/<name> and …/X-wt-<name> (agent worktrees) → X
 *   …/X/.claude/worktrees/<name> → X
 *   temp, scratch and probe folders → one "Scratch and temp folders" project
 *   the home folder ("~") → "Home folder"
 *   anything else → the folder itself
 * Git-accurate parents (a linked worktree with any name) come from the migration's saved `parents`.
 */
export function projectOfFolder(r: ProjectRecord): ProjectRef {
  const path = pathOf(r);
  if (TEMP.test(path)) return SCRATCH_PROJECT;
  if (path === "~" || /^[a-z]:\/users\/[^/]+$/i.test(path) || r.displayName === "Home folder") return HOME_PROJECT;
  const claudeWt = /([^/]+)\/\.claude\/worktrees\/[^/]+$/.exec(path);
  if (claudeWt) return ref(claudeWt[1]);
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? r.displayName ?? r.key;
  const parent = segments[segments.length - 2];
  if (parent && /-wt$/i.test(parent)) return ref(parent.replace(/-wt$/i, ""));
  const suffix = /^(.+?)-wt-.+$/i.exec(last);
  if (suffix) return ref(suffix[1]);
  return ref(last);
}

// ── Project → workspace ──────────────────────────────────────────────────────────────────────────

/**
 * M&U's own repos (lead, 29 Sep 2026). Matched on the project name, case-insensitive. The
 * migration also looks for these on disk, so a site repo with no session this week still appears.
 */
export const KNOWN_PROJECTS: Readonly<Record<string, WorkspaceId>> = {
  // Websites: M&U's own site, the demos and flagships, client sites, films and the website hub.
  "muv-marketing": "websites",
  "m-u-ventures": "websites",
  "muv-demo-dental": "websites",
  "muv-demo-conveyancing": "websites",
  "muv-flagship-legal": "websites",
  aldergate: "websites",
  "bianca-brown-realty": "websites",
  "mu-video-demos": "websites",
  "mu-site-drafts": "websites",
  "mu-generated-assets": "websites",
  "mu-workspace": "websites",
  // Receptionist
  "mu-receptionist": "receptionist",
  // M&U Ventures: the OS itself, the knowledge base and business-wide tooling.
  "agenticos-v4": "mu-ventures",
  agenticos: "mu-ventures",
  "mu-ventures-obsidian-wiki": "mu-ventures",
  "jarvis-next": "mu-ventures",
  "mu-aios": "mu-ventures",
  scratch: "mu-ventures",
  home: "mu-ventures",
};

/** Name rules for projects not on the known list, first match wins. */
export const RULES: ReadonlyArray<{ workspace: WorkspaceId; placement: Placement; test: RegExp; why: string }> = [
  {
    workspace: "receptionist",
    placement: "rule:receptionist",
    test: /receptionist|retell|speed-to-lead|(?:^|[-_ ])rx(?:[-_ ]|$)/,
    why: "Name mentions the receptionist, Retell, speed-to-lead or rx",
  },
  {
    workspace: "websites",
    placement: "rule:websites",
    test: /^muv[-_]|website|(?:^|[-_])sites?(?:[-_]|$)|flagship|dental|conveyanc|realty|aldergate|bianca|video-demos/,
    why: "Name is a website, demo, flagship, client site or film",
  },
];

/** Where a project belongs by the known list and the rules alone. */
export function classifyProject(p: ProjectRef): { workspace: WorkspaceId; placement: Placement } {
  const known = KNOWN_PROJECTS[p.id];
  if (known) return { workspace: known, placement: p.id === "scratch" ? "rule:tooling" : "known" };
  for (const rule of RULES) if (rule.test.test(p.id)) return { workspace: rule.workspace, placement: rule.placement };
  return { workspace: "mu-ventures", placement: "unmatched" };
}

// ── The saved file (.operator-data/workspaces.json) ──────────────────────────────────────────────

export type SavedProject = ProjectRef & { placement: Placement; /** Where the migration found it on disk, if it did. */ path?: string };

export type WorkspacesFile = {
  version: 2;
  /** When the migration wrote this file. */
  migratedAt: string;
  workspaces: Array<WorkspaceDef & { projects: SavedProject[] }>;
  /** Folder key → its project, as the migration resolved it (git where it could). */
  parents: Record<string, ProjectRef>;
  /** Hand edits: project id → workspace. Win over everything else. */
  overrides: Record<string, WorkspaceId>;
  /** The folders that were shown as separate workspaces, exactly as read. Never pruned. */
  archived: { at: string; note: string; records: ProjectRecord[] };
};

/** The saved grouping as GET /__workspace/groups answers it. A broken file is an error, never a guess. */
export type SavedGroups = { saved: WorkspacesFile | null; error?: string };

const isRef = (v: unknown): v is ProjectRef => !!v && typeof (v as ProjectRef).id === "string" && !!(v as ProjectRef).id && typeof (v as ProjectRef).name === "string";

/** A parsed saved file, or null when the value isn't one (a hand-broken file never crashes the page). */
export function parseWorkspacesFile(value: unknown): WorkspacesFile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<WorkspacesFile>;
  if (v.version !== 2 || !Array.isArray(v.workspaces)) return null;
  const workspaces = THREE_WORKSPACES.map((def) => {
    const found = v.workspaces!.find((w) => w && (w as { id?: unknown }).id === def.id) as { projects?: unknown } | undefined;
    const projects = Array.isArray(found?.projects)
      ? (found!.projects as unknown[]).flatMap((m) => {
          if (!isRef(m)) return [];
          const r = m as SavedProject;
          return [{ id: slug(r.id), name: r.name, placement: (r.placement ?? "saved") as Placement, ...(typeof r.path === "string" ? { path: r.path } : {}) }];
        })
      : [];
    return { ...def, projects };
  });
  const parents: Record<string, ProjectRef> = {};
  if (v.parents && typeof v.parents === "object") for (const [k, p] of Object.entries(v.parents)) if (isRef(p)) parents[k] = { id: slug(p.id), name: p.name };
  const overrides: Record<string, WorkspaceId> = {};
  if (v.overrides && typeof v.overrides === "object") for (const [k, w] of Object.entries(v.overrides)) if (isWorkspaceId(w)) overrides[slug(k)] = w;
  const archived = v.archived && typeof v.archived === "object" && Array.isArray(v.archived.records)
    ? { at: String(v.archived.at ?? ""), note: String(v.archived.note ?? ""), records: v.archived.records.filter((r) => r && typeof r.key === "string") }
    : { at: "", note: "", records: [] };
  return { version: 2, migratedAt: String(v.migratedAt ?? ""), workspaces, parents, overrides, archived };
}

// ── Grouping (what the page shows) ───────────────────────────────────────────────────────────────

export type GroupedFolder = ProjectRecord & { name: string; seenThisWeek: boolean };

export type GroupedProject = ProjectRef & {
  placement: Placement;
  folders: GroupedFolder[];
  /** Sessions this week across its folders. */
  sessions: number;
  lastActiveMs: number | null;
  lastActiveAgo: string | null;
  /** The folder a click opens: the repo's own checkout when present, else the busiest folder. */
  mainFolder: string | null;
  path?: string;
};

export type WorkspaceGroup = WorkspaceDef & {
  projects: GroupedProject[];
  folderCount: number;
  sessions: number;
  lastActiveMs: number | null;
  lastActiveAgo: string | null;
};

/**
 * The three workspaces, each with its projects, each project with its folders. Every folder is in
 * exactly one project and every project in exactly one workspace.
 *
 * `live` is this week's folders (recentProjects). A saved project with no folder active this week
 * still appears (0 sessions), so nothing assigned disappears from view.
 * Precedence for a project's workspace: override > saved > known list > rules > M&U Ventures.
 */
export function groupProjects(live: ProjectRecord[], saved: WorkspacesFile | null): WorkspaceGroup[] {
  const projects = new Map<string, GroupedProject>();
  const savedAt = new Map<string, { workspace: WorkspaceId; project: SavedProject }>();
  for (const w of saved?.workspaces ?? []) for (const p of w.projects) savedAt.set(p.id, { workspace: w.id, project: p });
  const ensure = (r: ProjectRef): GroupedProject => {
    let p = projects.get(r.id);
    if (!p) {
      const s = savedAt.get(r.id)?.project;
      p = { id: r.id, name: s?.name ?? r.name, placement: "unmatched", folders: [], sessions: 0, lastActiveMs: null, lastActiveAgo: null, mainFolder: null, ...(s?.path ? { path: s.path } : {}) };
      projects.set(r.id, p);
    }
    return p;
  };
  const seen = new Set<string>();
  for (const f of live) {
    if (!f || typeof f.key !== "string" || !f.key || seen.has(f.key)) continue;
    seen.add(f.key);
    const p = ensure(saved?.parents[f.key] ?? projectOfFolder(f));
    p.folders.push({ ...f, name: f.displayName || f.key, seenThisWeek: true });
  }
  for (const { project } of savedAt.values()) ensure(project);

  const overrides = saved?.overrides ?? {};
  const groups = new Map<WorkspaceId, GroupedProject[]>(WORKSPACE_IDS.map((id) => [id, []]));
  for (const p of projects.values()) {
    let workspace: WorkspaceId;
    if (overrides[p.id]) [workspace, p.placement] = [overrides[p.id], "override"];
    else if (savedAt.has(p.id)) [workspace, p.placement] = [savedAt.get(p.id)!.workspace, "saved"];
    else ({ workspace, placement: p.placement } = classifyProject(p));
    p.folders.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || a.name.localeCompare(b.name));
    p.sessions = p.folders.reduce((n, f) => n + (Number(f.sessions) || 0), 0);
    const latest = p.folders[0];
    p.lastActiveMs = latest?.lastActiveMs ?? null;
    p.lastActiveAgo = latest?.lastActiveAgo ?? null;
    const own = p.folders.find((f) => slug(f.displayName ?? "") === p.id || slug(pathOf(f).split("/").pop() ?? "") === p.id);
    p.mainFolder = own?.key ?? [...p.folders].sort((a, b) => (Number(b.sessions) || 0) - (Number(a.sessions) || 0))[0]?.key ?? null;
    groups.get(workspace)!.push(p);
  }

  return THREE_WORKSPACES.map((def) => {
    const list = groups.get(def.id)!.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || a.name.localeCompare(b.name));
    const latest = list.find((p) => p.lastActiveMs);
    return {
      ...def,
      projects: list,
      folderCount: list.reduce((n, p) => n + p.folders.length, 0),
      sessions: list.reduce((n, p) => n + p.sessions, 0),
      lastActiveMs: latest?.lastActiveMs ?? null,
      lastActiveAgo: latest?.lastActiveAgo ?? null,
    };
  });
}

/** Which workspace and project a folder key is in (for a folder's own page). */
export function locateFolder(groups: WorkspaceGroup[], key: string): { group: WorkspaceGroup; project: GroupedProject } | null {
  for (const group of groups) for (const project of group.projects) if (project.folders.some((f) => f.key === key)) return { group, project };
  return null;
}

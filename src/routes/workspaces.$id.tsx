import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { isFolderKeyShape } from "@/lib/route-checks";
import { type Workspace, type WorkspaceStatus } from "@/lib/mock-data";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useLiveDataStatus } from "@/lib/use-live-data";
import { Badge, Button, EmptyState, Notice, PageHeader, PageSkeleton, StatTile, type Tone } from "@/components/ds";
import { WORKSPACE_ICON, WorkspaceSwitcher, useWorkspaceGroups } from "@/components/workspace/three-workspaces";
import { PLACEMENT_LABEL, isWorkspaceId, locateFolder, workspaceById, type WorkspaceId } from "../../scripts/workspace/three-workspaces";
import "@/components/workspace/three-workspaces.css";

function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === "healthy" || s === "active" || s === "success") return "success";
  if (s === "stale" || s === "needs review" || s === "interrupted") return "warn";
  if (s === "missing" || s === "failed" || s === "broken") return "danger";
  return "neutral";
}

// See workspaces.index.tsx: the aggregator doesn't parse per-project
// CLAUDE.md health or memory freshness yet, so we don't assert a status —
// "unknown" falls back to StatusPill's neutral/muted style.
type LiveWorkspace = Omit<Workspace, "claudeMdStatus"> & {
  claudeMdStatus: WorkspaceStatus | "unknown";
};

function buildLiveWorkspaces(ld: any): LiveWorkspace[] {
  const projects = ld?.recentProjects;
  if (!Array.isArray(projects)) return [];
  return projects.map(
    (p: any): LiveWorkspace => ({
      id: String(p?.key ?? ""),
      name: String(p?.displayName ?? p?.key ?? "—"),
      path: String(p?.displayName ?? p?.key ?? "—"),
      claudeMdStatus: "unknown",
      lastRun: String(p?.lastActiveAgo ?? "—"),
      activeSkills: [],
      recentFiles: [],
      recentOutputs: [],
      memoryFreshness: 0,
      usageToday: 0,
      runs7d: Number(p?.sessions ?? 0) || 0,
      description: "",
      summary:
        "Per-workspace details aren't surfaced by the aggregator yet — only the high-level project signal is available.",
      memoryFiles: [],
      sessions: [],
      warnings: [],
    }),
  );
}

export const Route = createFileRoute("/workspaces/$id")({
  head: ({ params }) => ({
    meta: [
      { title: docTitle(isWorkspaceId(params.id) || isFolderKeyShape(params.id) ? "/workspaces/detail" : "/not-found") },
      { name: "description", content: "Workspace details" },
    ],
  }),
  component: WorkspaceDetail,
  // Only ids that can't be a workspace or a folder are a server-side 404; a well-formed folder id with no folder shows the same page.
  loader: ({ params }) => {
    if (!isWorkspaceId(params.id) && !isFolderKeyShape(params.id)) throw notFound();
    return {};
  },
  notFoundComponent: () => <WorkspaceNotFound />,
  errorComponent: ({ error }) => <div className="text-sm text-danger">{error.message}</div>,
});

/** A real "not found" page (audit F3-33: it was a bare one-liner), shown only after the list loaded. */
function WorkspaceNotFound({ id }: { id?: string }) {
  return (
    <div className="w-full max-w-[1680px]">
      <PageHeader title="Workspace not found" description={id ? `“${id}” isn't one of the workspaces.` : "This link isn't one of the workspaces."} />
      <EmptyState
        title="Nothing to show for this link"
        body="The workspaces are M&U Ventures, Receptionist and Websites. Pick one from the list."
        action={
          <Link to="/workspaces" className="inline-flex min-h-9 items-center gap-1 text-sm font-medium underline">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All workspaces
          </Link>
        }
      />
    </div>
  );
}

const BackLink = () => (
  <Link to="/workspaces" className="mb-4 inline-flex min-h-9 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
    <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All workspaces
  </Link>
);

/** /workspaces/<id>: one of the three workspaces, or (older links) one project folder. */
function WorkspaceDetail() {
  const { id } = Route.useParams();
  return isWorkspaceId(id) ? <ThreeWorkspacePage id={id} /> : <ProjectFolderDetail id={id} />;
}

/** How many folders are listed before "Show all". */
const FIRST = 12;

function ThreeWorkspacePage({ id }: { id: WorkspaceId }) {
  const ws = useWorkspaceGroups();
  const def = workspaceById(id);
  const Icon = WORKSPACE_ICON[id];
  const header = (
    <>
      <BackLink />
      <WorkspaceSwitcher current={id} className="mb-8" />
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <span className="ws3-card-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={1.75} />
            </span>
            {def.name}
          </span>
        }
        description={def.purpose}
      />
    </>
  );
  if (!ws.loaded) {
    return (
      <div className="w-full max-w-[1680px]">
        {header}
        {ws.failed ? (
          <Notice tone="danger" title="This workspace couldn't be read">
            {ws.error}. Its folders may still exist.{" "}
            <Button variant="outline" size="sm" className="ml-1" onClick={ws.refetch}>
              Retry
            </Button>
          </Notice>
        ) : (
          <PageSkeleton rows={4} label="Loading the workspace" />
        )}
      </div>
    );
  }
  const group = ws.groups.find((g) => g.id === id)!;
  const activeProjects = group.projects.filter((p) => p.folders.length > 0).length;
  const row = (p: (typeof group.projects)[number]) => {
    const meta = `${p.folders.length > 0 ? `${p.sessions} ${p.sessions === 1 ? "session" : "sessions"} this week · active ${p.lastActiveAgo ?? "—"}` : "No sessions this week"} · ${PLACEMENT_LABEL[p.placement]}`;
    const body = (
      <>
        <span className="min-w-0">
          <span className="ws3-row-name">{p.name}</span>
          <span className="ws3-row-meta">{meta}</span>
        </span>
        {p.mainFolder && <ArrowUpRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
      </>
    );
    return (
      <li key={p.id}>
        {p.mainFolder ? (
          <Link to="/workspaces/$id" params={{ id: p.mainFolder }} className="ws3-row">
            {body}
          </Link>
        ) : (
          <div className="ws3-row" title={p.path}>
            {body}
          </div>
        )}
        {/* Worktrees and other folders of the project: one quiet disclosure, never their own cards. */}
        {p.folders.length > 1 && (
          <details className="ws3-more ws3-folders">
            <summary>
              {p.folders.length} folders used this week
            </summary>
            <ul className="ws3-list">
              {p.folders.map((f) => (
                <li key={f.key}>
                  <Link to="/workspaces/$id" params={{ id: f.key }} className="ws3-row ws3-row-sub">
                    <span className="min-w-0">
                      <span className="ws3-row-name">{f.name}</span>
                      <span className="ws3-row-meta">
                        {f.sessions ?? 0} {f.sessions === 1 ? "session" : "sessions"} · active {f.lastActiveAgo ?? "—"}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </li>
    );
  };
  return (
    <div className="w-full max-w-[1680px]">
      {header}
      {ws.savedError && (
        <Notice tone="warn" title="The saved grouping couldn't be read" className="mb-8">
          {ws.savedError}. Projects are placed by the name rules until it can be read again.
        </Notice>
      )}
      <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Projects" value={String(group.projects.length)} hint={`${activeProjects} used this week`} />
        <StatTile label="Sessions this week" value={String(group.sessions)} />
        <StatTile label="Last active" value={group.lastActiveAgo} hint={group.lastActiveAgo ? undefined : "Nothing here was used this week"} />
      </div>
      <section aria-labelledby="ws3-projects" className="mb-12">
        <h2 id="ws3-projects" className="mb-4 text-lg font-semibold tracking-[-0.01em]">
          Projects
        </h2>
        {group.projects.length === 0 ? (
          <EmptyState title="No projects here yet" body="A project joins this workspace when it's one of M&U's known repos, its name matches the rules on the Workspaces page, or it's moved here by hand." />
        ) : (
          <>
            <ul className="ws3-list">{group.projects.slice(0, FIRST).map(row)}</ul>
            {group.projects.length > FIRST && (
              <details className="ws3-more">
                <summary>Show the other {group.projects.length - FIRST} projects</summary>
                <ul className="ws3-list">{group.projects.slice(FIRST).map(row)}</ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** One project folder (older links and the command palette still point here). */
function ProjectFolderDetail({ id }: { id: string }) {
  const live = useLiveDataStatus();
  const ld = live.data;
  const isDemoData = live.loaded && ld?.isExample === true;
  const allWorkspaces = live.loaded ? buildLiveWorkspaces(ld) : [];
  const groups = useWorkspaceGroups().groups;
  const ws = allWorkspaces.find((w) => w.id === id);

  // Only a loaded list can say "not found" (audit F1-05: a deep link read "Workspace not found"
  // for ~6 s on live while the list was still loading).
  if (!live.loaded) {
    return (
      <div className="w-full max-w-[1680px]">
        <BackLink />
        {live.failed ? (
          <Notice tone="danger" title="This workspace couldn't be read">
            {live.error}. It may still exist.{" "}
            <Button variant="outline" size="sm" className="ml-1" onClick={live.refetch}>
              Retry
            </Button>
          </Notice>
        ) : (
          <PageSkeleton rows={4} label="Loading the workspace" />
        )}
      </div>
    );
  }
  if (!ws) return <WorkspaceNotFound id={id} />;
  const home = locateFolder(groups, ws.id);

  return (
    <div className="w-full max-w-[1680px]">
      <BackLink />
      <PageHeader
        title={ws.name}
        description={ws.path}
        meta={
          <>
            {home && (
              <Link to="/workspaces/$id" params={{ id: home.group.id }} className="underline-offset-4 hover:text-foreground hover:underline">
                Part of {home.project.name} · {home.group.name}
              </Link>
            )}
          </>
        }
        actions={<Badge tone={statusTone(ws.claudeMdStatus)}>{ws.claudeMdStatus === "unknown" ? "Health not tracked yet" : ws.claudeMdStatus}</Badge>}
      />

      <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Last run" value={ws.lastRun} />
        <StatTile label="Sessions (7d)" value={ws.runs7d.toString()} />
        <StatTile label="Memory freshness" value={ws.memoryFreshness > 0 ? `${ws.memoryFreshness}%` : null} hint="Not tracked yet" />
      </div>

      {ws.warnings.length > 0 && (
        <Notice tone="warn" title="Open issues" className="mb-8">
          <ul className="space-y-1 list-disc pl-5">
            {ws.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <EmptyState
        variant="row"
        title="Memory files, skills, changed files and outputs aren't tracked per folder yet"
        body={ws.summary}
      />
    </div>
  );
}

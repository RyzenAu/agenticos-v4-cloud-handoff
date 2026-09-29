import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge, Button, EmptyState, Notice, PageHeader, PageSkeleton, fmtDate } from "@/components/ds";
import { WORKSPACE_ICON, useWorkspaceGroups } from "@/components/workspace/three-workspaces";
import { RULES } from "../../scripts/workspace/three-workspaces";
import "@/components/workspace/three-workspaces.css";

// Three workspaces (owner, 29 Sep 2026: "too many workspaces; keep one for M&U Ventures itself, one
// for Receptionist, one for Websites"). Every project folder the aggregator saw is a member of one
// of the three (scripts/workspace/three-workspaces.ts); none is hidden or removed.

export const Route = createFileRoute("/workspaces/")({
  head: () => ({
    meta: [
      { title: docTitle("/workspaces") },
      {
        name: "description",
        content: "Three workspaces: M&U Ventures, Receptionist and Websites. Every project folder belongs to one.",
      },
    ],
  }),
  component: WorkspacesPage,
});

const DESCRIPTION = "Three workspaces. Every project belongs to one, and every worktree to its project.";

function WorkspacesPage() {
  const ws = useWorkspaceGroups();
  // Only a real answer can say "demo data" or "none" (audit F1-05: the loading placeholder read as
  // "0 project folders · Demo data · No project workspaces detected yet" for ~10 s on live).
  if (!ws.loaded) {
    return (
      <div className="w-full max-w-[1680px]">
        <PageHeader
          title="Workspaces"
          description={DESCRIPTION}
          meta={<span className="text-muted-foreground">{ws.failed ? "Project folders unknown" : "Reading project folders…"}</span>}
        />
        {ws.failed ? (
          <Notice tone="danger" title="Project folders couldn't be read">
            {ws.error}. Nothing here means there are none.{" "}
            <Button variant="outline" size="sm" className="ml-1" onClick={ws.refetch}>
              Retry
            </Button>
          </Notice>
        ) : (
          <PageSkeleton variant="list" rows={3} label="Loading project folders" />
        )}
      </div>
    );
  }
  const total = ws.groups.reduce((n, g) => n + g.projects.length, 0);
  return (
    <div className="w-full max-w-[1680px]">
      <PageHeader
        title="Workspaces"
        description={DESCRIPTION}
        meta={
          <>
            <span className="ds-num">
              {ws.activeFolders} project {ws.activeFolders === 1 ? "folder" : "folders"} active this week
            </span>
            {ws.savedAt ? (
              <Badge tone="neutral" title="Saved by the workspaces migration; folders new since then are placed by the name rules.">
                Grouping saved {fmtDate(ws.savedAt)}
              </Badge>
            ) : (
              <Badge tone="neutral" title="No saved grouping yet: each folder is placed by the name rules below.">
                Placed by name rules
              </Badge>
            )}
            {ws.isDemo && (
              <Badge
                tone="warn"
                title="Sample data shipped with the app. Run `bun run scripts/aggregate.ts` to populate with your real ~/.claude/ activity."
              >
                Demo data
              </Badge>
            )}
          </>
        }
      />

      {ws.savedError && (
        <Notice tone="warn" title="The saved grouping couldn't be read" className="mb-8">
          {ws.savedError}. Folders are placed by the name rules until it can be read again.
        </Notice>
      )}

      <ul className="ws3-grid" aria-label="Workspaces">
        {ws.groups.map((g) => {
          const Icon = WORKSPACE_ICON[g.id];
          return (
            <li key={g.id}>
              <Link to="/workspaces/$id" params={{ id: g.id }} className="ws3-card group">
                <span className="ws3-card-icon" aria-hidden="true">
                  <Icon size={22} strokeWidth={1.75} />
                </span>
                <span className="ws3-card-name">{g.name}</span>
                <span className="ws3-card-purpose">{g.purpose}</span>
                {g.projects.length > 0 && (
                  <span className="ws3-card-projects">
                    {g.projects.slice(0, 4).map((p) => (
                      <span key={p.id} className="ws3-chip">
                        {p.name}
                      </span>
                    ))}
                    {g.projects.length > 4 && <span className="ws3-chip ws3-chip-more">+{g.projects.length - 4}</span>}
                  </span>
                )}
                <span className="ws3-card-facts">
                  <span>
                    <b className="ds-num">{g.projects.length}</b> {g.projects.length === 1 ? "project" : "projects"}
                  </span>
                  <span>
                    <b className="ds-num">{g.sessions}</b> {g.sessions === 1 ? "session" : "sessions"} this week
                  </span>
                  <span>{g.lastActiveAgo ? `Active ${g.lastActiveAgo}` : "Not active this week"}</span>
                </span>
                <span className="ws3-card-open">
                  Open <ArrowUpRight size={15} aria-hidden="true" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {total === 0 && (
        <EmptyState
          className="mt-8"
          title="No projects yet"
          body={
            <>
              Run a Claude Code session in one of your project folders and re-run{" "}
              <code className="text-foreground/80">bun run scripts/aggregate.ts</code>. Each project then joins one of the three.
            </>
          }
        />
      )}

      <details className="ws3-rules">
        <summary>How folders are placed</summary>
        <ol>
          <li>
            <b>Worktrees join their project:</b> agent worktrees (<code>…-wt/…</code>, <code>…-wt-…</code>, <code>.claude/worktrees</code>) and git worktrees count as the repo they came from; scratch and temp folders are one project.
          </li>
          <li>
            <b>M&amp;U&apos;s own repos</b> go where they belong: the OS and the wiki to M&amp;U Ventures, MU-Receptionist to Receptionist, the sites, demos, films and the website hub to Websites.
          </li>
          {RULES.map((r) => (
            <li key={r.placement}>
              <b>{r.workspace === "mu-ventures" ? "M&U Ventures" : r.workspace === "receptionist" ? "Receptionist" : "Websites"}:</b> {r.why.toLowerCase()}.
            </li>
          ))}
          <li>
            <b>M&amp;U Ventures:</b> anything else. Unmatched projects are marked, so they&apos;re easy to move.
          </li>
        </ol>
        <p>
          A saved grouping keeps each project where it was put. To move one, add its name to <code>overrides</code> in{" "}
          <code>.operator-data/workspaces.json</code>. Nothing is ever deleted: the folders shown one by one before are archived in that file.
        </p>
      </details>
    </div>
  );
}

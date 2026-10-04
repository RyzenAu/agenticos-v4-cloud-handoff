// The three workspaces (owner, 29 Sep 2026): M&U Ventures, Receptionist, Websites. The grouping
// logic is scripts/workspace/three-workspaces.ts; this is its data hook and the calm switcher shown
// on /workspaces and each workspace's page.
import { Link } from "@tanstack/react-router";
import { Briefcase, Globe2, PhoneCall, type LucideIcon } from "lucide-react";
import { useLiveDataStatus } from "@/lib/use-live-data";
import { cn } from "@/lib/utils";
import { useSavedWorkspaceGroups } from "./api";
import { groupProjects, type ProjectRecord, type WorkspaceGroup, type WorkspaceId } from "../../../scripts/workspace/three-workspaces";

export const WORKSPACE_ICON: Record<WorkspaceId, LucideIcon> = {
  "mu-ventures": Briefcase,
  receptionist: PhoneCall,
  websites: Globe2,
};

const records = (value: unknown): ProjectRecord[] => (Array.isArray(value) ? value.filter((p) => p && typeof p.key === "string" && p.key) : []);

export type WorkspaceGroupsState = {
  /** The live project list has arrived: only now may the page say "none" or "demo data". */
  loaded: boolean;
  failed: boolean;
  error: string | null;
  refetch: () => void;
  isDemo: boolean;
  groups: WorkspaceGroup[];
  /** Project folders active this week (the old count of "workspaces"). */
  activeFolders: number;
  /** When the migration saved the grouping, or null when the name rules place everything. */
  savedAt: string | null;
  /** The saved grouping couldn't be read: the page says so and falls back to the rules. */
  savedError: string | null;
};

export function useWorkspaceGroups(): WorkspaceGroupsState {
  const live = useLiveDataStatus();
  const saved = useSavedWorkspaceGroups();
  const ld = live.data;
  const savedFile = saved.data?.saved ?? null;
  // Sample data (no real history read yet) is never shown as the owner's projects: it is an empty list.
  const sample = live.loaded && ld?.isExample === true;
  const groups = live.loaded && !sample ? groupProjects(records(ld?.recentProjects), savedFile) : [];
  return {
    loaded: live.loaded,
    failed: live.failed,
    error: live.error,
    refetch: live.refetch,
    isDemo: false,
    groups,
    activeFolders: live.loaded && !sample ? records(ld?.recentProjects).length : 0,
    savedAt: savedFile?.migratedAt || null,
    savedError: saved.isError ? (saved.error as Error)?.message ?? "Unavailable" : saved.data?.error ?? null,
  };
}

/** The three as a calm row of pills: where you are, one tap to the others. */
export function WorkspaceSwitcher({ current, className }: { current?: WorkspaceId; className?: string }) {
  const items: { id: WorkspaceId; name: string }[] = [
    { id: "mu-ventures", name: "M&U Ventures" },
    { id: "receptionist", name: "Receptionist" },
    { id: "websites", name: "Websites" },
  ];
  return (
    <nav aria-label="Workspaces" className={cn("ws3-switcher", className)}>
      {items.map((w) => {
        const Icon = WORKSPACE_ICON[w.id];
        const here = w.id === current;
        return (
          <Link key={w.id} to="/workspaces/$id" params={{ id: w.id }} className="ws3-pill" data-current={here || undefined} aria-current={here ? "page" : undefined}>
            <Icon size={16} aria-hidden="true" />
            <span>{w.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}

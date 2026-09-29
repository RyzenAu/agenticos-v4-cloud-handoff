// Client side of /__workspace (scripts/workspace/plugin.ts). One query per panel so a slow source
// only holds up its own card. Receptionist refreshes every 60 s, everything else every 5 min.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { PanelResult } from "../../../scripts/workspace/aggregate";
import type { WorkspaceSnapshot } from "../../../scripts/workspace/sources";
import type { SavedGroups } from "../../../scripts/workspace/three-workspaces";

export type { PanelResult } from "../../../scripts/workspace/aggregate";
export type { Approval } from "../../../scripts/workspace/approvals";
export type { CallingWindowStatus } from "../../../scripts/workspace/calling-window";
export type { CallQueuePanel, EmailPanel, PipelinePanel, ReceptionistPanel, UrgentAlert } from "../../../scripts/workspace/projections";
export type { SiteCheck, SitesPanel } from "../../../scripts/workspace/sites";
export type { TodayPanel, WorkspaceSnapshot } from "../../../scripts/workspace/sources";
export type { NeedsYouPanel, NeedsYouPart } from "../../../scripts/workspace/needs-you";

export type PanelKey = keyof WorkspaceSnapshot;

const PATH: Record<PanelKey, string> = {
  today: "today",
  callQueue: "call-queue",
  receptionist: "receptionist",
  websites: "websites",
  email: "email",
  pipeline: "pipeline",
  enquiries: "enquiries",
  needsYou: "needs-you",
};

export const REFRESH_MS: Record<PanelKey, number> = {
  today: 5 * 60_000,
  callQueue: 5 * 60_000,
  receptionist: 60_000,
  websites: 5 * 60_000,
  email: 5 * 60_000,
  pipeline: 5 * 60_000,
  enquiries: 60_000,
  needsYou: 60_000,
};

/** Panels whose next read must bypass the server's reuse window (Refresh / Retry pressed). */
const wantFresh = new Set<PanelKey>();

/** The URL of a panel read; a requested fresh read adds ?fresh=1 once. */
export function panelUrl(key: PanelKey): string {
  const fresh = wantFresh.delete(key);
  return `/__workspace/${PATH[key]}${fresh ? "?fresh=1" : ""}`;
}

/**
 * Refresh / Retry: the next read of these panels (all when omitted) goes to the source, not the
 * server's recent read, then the queries refetch. needsYou re-reads the panels it's built from.
 */
export function refreshPanels(client: QueryClient, keys?: PanelKey[]) {
  const list = keys ?? (Object.keys(PATH) as PanelKey[]);
  for (const k of list) wantFresh.add(k);
  if (!keys) return client.invalidateQueries({ queryKey: ["workspace"] });
  return Promise.all(list.map((k) => client.invalidateQueries({ queryKey: ["workspace", k] })));
}

async function readPanel<K extends PanelKey>(key: K): Promise<WorkspaceSnapshot[K]> {
  const res = await fetch(panelUrl(key), { headers: { Accept: "application/json" } });
  if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("Start Agentic OS with bun run dev to see the workspace.");
  const body = await res.json();
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `Request failed (HTTP ${res.status})`);
  return body as WorkspaceSnapshot[K];
}

/**
 * The saved three-workspace grouping (GET /__workspace/groups; .operator-data/workspaces.json, written
 * only by scripts/workspace/consolidate-workspaces.ts). `saved: null` means none yet: the page then
 * places folders by the name rules. A failed read is an error, and the page says so.
 */
export function useSavedWorkspaceGroups() {
  return useQuery<SavedGroups>({
    queryKey: ["workspace", "groups"],
    queryFn: async () => {
      const res = await fetch("/__workspace/groups", { headers: { Accept: "application/json" } });
      if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("Start Agentic OS with bun run dev to see saved workspaces.");
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `Request failed (HTTP ${res.status})`);
      return body as SavedGroups;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** The panel's server result. A failed source is `data.ok === false` (not a thrown error). */
export function useWorkspacePanel<K extends PanelKey>(key: K) {
  const query = useQuery<PanelResult<WorkspaceSnapshot[K] extends PanelResult<infer T> ? T : never>>({
    queryKey: ["workspace", key],
    queryFn: () => readPanel(key) as never,
    refetchInterval: REFRESH_MS[key],
    staleTime: Math.min(REFRESH_MS[key], 60_000),
    retry: 1,
  });
  // A panel's own refresh button asks for a fresh read (never the server's recent one).
  const refetch: typeof query.refetch = (options) => {
    wantFresh.add(key);
    return query.refetch(options);
  };
  return { ...query, refetch };
}

/**
 * useLiveData — runtime loader for live-data.json
 *
 * Instead of `import liveData from "@/data/live-data.json"` (which bakes the
 * file into the bundle at startup and never updates), this hook fetches the
 * JSON fresh from disk on every page load via a Vite dev middleware endpoint.
 *
 * React Query deduplicates requests, so even if 11 components call this hook,
 * only one HTTP request fires.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

// Minimal shape so the app doesn't crash while the fetch is in-flight.
// `generatedAt` is a FIXED placeholder, not `new Date().toISOString()` — this
// module is evaluated once per process, so a wall-clock value here would be
// baked in at a different instant on the server (SSR) than in the browser
// (hydration), and the two would never agree. Any page that renders it before
// the real `/__live-data` fetch resolves would hydration-mismatch every load.
const EMPTY: Record<string, any> = {
  isExample: true,
  generatedAt: "1970-01-01T00:00:00.000Z",
  usage: { claudeWindow: null, chatgptWindow: null, openrouter: null },
  memory: { nodes: [], links: [], stats: {}, events: [], staleFiles: [], missing: [] },
  skills: { active: [], recommended: [] },
  subscriptions: {},
  detection: { apps: {}, memoryStores: {}, envKeysNeeded: [], envKeysPresent: [] },
  daily: [],
  dream: {},
  integrations: [],
  knowledgeStores: [],
  automations: [],
};

/**
 * Returns the latest live-data.json contents. Fetches from the dev server on
 * mount and caches in React Query. Call `refetchLiveData()` from the returned
 * tuple to re-fetch after running the aggregator.
 *
 * `hydrated` gates the query itself (not just the returned value): this SSR
 * app (TanStack Start) renders every route on the server, and a plain
 * `useQuery` with no `enabled` guard still fires its `queryFn` during that
 * server render. When it resolves before the tree is flushed, the server
 * HTML embeds real numbers while the client's first (pre-mount) render
 * still has none — a text mismatch that fails hydration on load (observed
 * on /memory-map). `hydrated` starts `false` identically on the server and
 * on the client's first render, and only flips (client-only, post-mount)
 * once `useEffect` runs — the same pattern already used by `useOperator()`
 * and `useWorkspaceProfile()`. So both environments agree on `EMPTY` for the
 * very first paint, and the real fetch only ever lands after hydration.
 */
export function useLiveData() {
  return useLiveDataStatus().data;
}

export type LiveDataStatus = {
  /** The file's contents, or the EMPTY placeholder until they arrive. */
  data: any;
  /** The real contents have arrived: only now may a page say "none", "demo data" or "not found". */
  loaded: boolean;
  /** The read failed and nothing was ever loaded: say so, never "none". */
  failed: boolean;
  error: string | null;
  refetch: () => void;
};

/**
 * useLiveData plus where the read is. Pages that turn an empty list into a verdict ("No project
 * workspaces detected yet", "Workspace not found", "Demo data") must wait for `loaded`: the EMPTY
 * placeholder is marked isExample and has no projects, so treating it as the answer showed "Demo
 * data · 0 folders" for ~10 s and "Workspace not found" for ~6 s on live (audit F1-05).
 */
export function useLiveDataStatus(): LiveDataStatus {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const query = useQuery({
    queryKey: ["live-data"],
    queryFn: async () => {
      const res = await fetch("/__live-data");
      if (!res.ok) throw new Error(`Failed to fetch live data: ${res.status}`);
      return res.json();
    },
    staleTime: 10_000, // consider fresh for 10s
    refetchOnWindowFocus: true, // re-fetch when user switches back to browser tab
    enabled: hydrated,
  });
  const data = hydrated ? (query.data ?? EMPTY) : EMPTY;
  const loaded = hydrated && query.data !== undefined;
  const failed = hydrated && !loaded && query.isError;
  return {
    data,
    loaded,
    failed,
    error: failed ? ((query.error as Error | null)?.message ?? "The live data couldn't be read") : null,
    refetch: () => void query.refetch(),
  };
}

/** Imperatively invalidate the live-data cache (e.g. after running aggregator) */
export function useRefreshLiveData() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["live-data"] });
}

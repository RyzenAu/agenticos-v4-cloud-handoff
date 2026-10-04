import { leadsApi } from "@/lib/leads";

/** The Leads list polls on its own, but only while the tab is in the foreground (react-query pauses a background tab). */
export const LEADS_POLL_MS = 30_000;
export function leadsListQuery(showExcluded: boolean, intervalMs: number = LEADS_POLL_MS) {
  return {
    queryKey: ["leads-list", "deals", showExcluded] as const,
    queryFn: () => leadsApi.board(showExcluded),
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
  };
}

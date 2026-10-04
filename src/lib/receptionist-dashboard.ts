import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DashboardViewModel } from "../../scripts/receptionist/dashboard";
export type {
  BlockMeta,
  ClientPackageMap,
  ClientRow,
  DashBlock,
  DashboardViewModel,
  ExceptionItem,
  TileRecovery,
  TileState,
} from "../../scripts/receptionist/dashboard";
// Pure tile-discipline helpers (zero / unknown / stale / failed), unit-tested in scripts/receptionist.
export { ageText, blockIsStale, tileRecovery, tileState } from "../../scripts/receptionist/dashboard";
export type { ChecklistStatus, ChecklistStep, ChecklistStepStatus } from "../../scripts/receptionist/checklist";

const KEY = ["receptionist", "dashboard"] as const;

async function view(response: Response): Promise<DashboardViewModel> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) throw new Error(body?.error ?? `Receptionist dashboard request failed (HTTP ${response.status})`);
  return body as DashboardViewModel;
}

/** GET /__receptionist/dashboard — the multi-client dashboard view model (scripts/receptionist/dashboard.ts). */
export function useReceptionistDashboard() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => view(await fetch("/__receptionist/dashboard", { headers: { Accept: "application/json" } })),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useReceptionistDashboardActions() {
  const client = useQueryClient();
  return {
    refresh: async () => {
      const tokenResponse = await fetch("/__token");
      if (!tokenResponse.ok) throw new Error("The local session token is unavailable.");
      const token = (await tokenResponse.json())?.token;
      if (typeof token !== "string" || !token) throw new Error("The local session token is unavailable.");
      const data = await view(
        await fetch("/__receptionist/dashboard/refresh", {
          method: "POST",
          headers: { "X-Claude-OS-Token": token },
        }),
      );
      client.setQueryData(KEY, data);
      return data;
    },
  };
}

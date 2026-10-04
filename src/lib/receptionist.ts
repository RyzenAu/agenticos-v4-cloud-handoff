import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BlockerId, IncidentPatch, ReadinessPatch, ReceptionistSnapshot } from "../../scripts/receptionist/types";
export { FLAG_LABEL } from "../../scripts/receptionist/types";
export type { AgencyFeedState, Blocker, CallRow, CallsBlock, CommercialBlock, FeedCall, FeedCallQa, FeedData, FeedTotals, HealthItem, Incident, ReceptionistSnapshot, Tone, TriageItem, Verdict } from "../../scripts/receptionist/types";

const KEY = ["receptionist"] as const;

async function snapshot(response: Response): Promise<ReceptionistSnapshot> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) throw new Error(body?.error ?? `Receptionist request failed (HTTP ${response.status})`);
  return body as ReceptionistSnapshot;
}

export function useReceptionist() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => snapshot(await fetch("/__receptionist", { headers: { Accept: "application/json" } })),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

async function post(path: string, body: unknown) {
  const response = await fetch("/__token");
  if (!response.ok) throw new Error("The local session token is unavailable.");
  const token = (await response.json())?.token;
  if (typeof token !== "string" || !token) throw new Error("The local session token is unavailable.");
  return snapshot(await fetch(`/__receptionist${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify(body),
  }));
}

// No "who" is sent with a sign-off or follow-up: the server records the verified principal
// (scripts/identity requestPrincipal) and ignores any name in the body (audit RX-5).
export function useReceptionistActions() {
  const client = useQueryClient();
  const set = (value: ReceptionistSnapshot) => client.setQueryData(KEY, value);
  return {
    /** A forced re-read (POST /refresh): Retell, Twilio AND the agency feed, bypassing every cache (RX-1). */
    refresh: async () => set(await post("/refresh", {})),
    setBlocker: async (id: BlockerId, done: boolean, note?: string) => {
      const patch: ReadinessPatch = { id, done, ...(note?.trim() ? { note: note.trim() } : {}) };
      return set(await post("/readiness", patch));
    },
    followUp: async (callId: string, note?: string) => {
      const patch: IncidentPatch = { callId, ...(note?.trim() ? { note: note.trim() } : {}) };
      return set(await post("/incident", patch));
    },
  };
}

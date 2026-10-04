import { useEffect, useRef } from "react";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";

type LeadsSearch = { lead?: number; view?: "today" };
export type Workspace = "leads" | "today";

/**
 * The Leads page's place in the address: the open lead (?lead=<id>) and the workspace tab (?view=today).
 * Opening a lead adds one history entry, so Back closes the drawer and lands on the list exactly as it was
 * (filters, view and scroll are page state and stay); switching to another lead from inside replaces it; a link or
 * reload reopens it. Back goes through the router's own history, so it behaves the same in a browser and in a test.
 */
export function useLeadsRoute(from: "/leads" = "/leads") {
  const search = useSearch({ from }) as LeadsSearch;
  const navigate = useNavigate();
  const router = useRouter();
  const pushed = useRef(false);
  // The router merges raw parent search into the validated one, so a junk ?lead=abc can still arrive: re-check here.
  const wanted = Number(search.lead);
  const openId = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : null;
  const workspace: Workspace = search.view === "today" ? "today" : "leads";
  useEffect(() => { if (openId === null) pushed.current = false; }, [openId]);
  const closeLead = () => {
    if (openId === null) return;
    if (pushed.current) { pushed.current = false; router.history.back(); }
    else void navigate({ to: from, search: (prev: LeadsSearch) => ({ ...prev, lead: undefined }), replace: true } as never);
  };
  const openLead = (id: number | null) => {
    if (id === null) return closeLead();
    void navigate({ to: from, search: (prev: LeadsSearch) => ({ ...prev, lead: id }), replace: openId !== null } as never);
    if (openId === null) pushed.current = true;
  };
  const setWorkspace = (next: Workspace) => {
    if (next === workspace) return;
    void navigate({ to: from, search: (prev: LeadsSearch) => ({ ...prev, view: next === "today" ? ("today" as const) : undefined }), replace: true } as never);
  };
  return { openId, workspace, openLead, closeLead, setWorkspace };
}

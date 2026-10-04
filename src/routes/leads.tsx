import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { LeadsCrm } from "@/components/operator/leads-crm";
export const Route = createFileRoute("/leads")({
  head: () => ({ meta: [{ title: docTitle("/leads") }] }),
  // ?lead=<id> opens that lead's drawer (the Ctrl/⌘K palette links here). ?view=today opens the Today workspace,
  // where the calls due are: Home and Work link there from "Calls to make".
  validateSearch: (search: Record<string, unknown>): { lead?: number; view?: "today" } => {
    const id = Number(search.lead);
    return { ...(Number.isSafeInteger(id) && id > 0 ? { lead: id } : {}), ...(search.view === "today" ? { view: "today" as const } : {}) };
  },
  component: LeadsCrm,
});

import { createFileRoute } from "@tanstack/react-router";
import { CrmWorkspace } from "@/components/crm/crm-workspace";
import { validateCrmSearch } from "@/components/crm/selectors";

export const Route = createFileRoute("/crm")({
  head: () => ({ meta: [{ title: "CRM — Agentic OS" }] }),
  validateSearch: validateCrmSearch,
  component: CrmWorkspace,
});

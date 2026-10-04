import { createFileRoute } from "@tanstack/react-router";
import { docTitle } from "@/components/shell/destinations";
import { CrmWorkspace } from "@/components/crm/crm-workspace";
import { validateCrmSearch } from "@/components/crm/selectors";

export const Route = createFileRoute("/crm")({
  head: () => ({ meta: [{ title: docTitle("/crm") }] }),
  validateSearch: validateCrmSearch,
  component: CrmWorkspace,
});

import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { MuOperations } from "@/components/business/mu-operations";

import { OPERATIONS_SECTIONS, type OperationsSection } from "@/components/business/mu-operations";

export const Route = createFileRoute("/operations")({
  head: () => ({ meta: [{ title: docTitle("/operations") }] }),
  // F1-11: the chosen tab is in the URL, so a reload or a shared link keeps it.
  validateSearch: (search: Record<string, unknown>): { section?: OperationsSection } =>
    OPERATIONS_SECTIONS.some((s) => s.id === search.section) ? { section: search.section as OperationsSection } : {},
  component: OperationsRoute,
});

function OperationsRoute() {
  const { section } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <MuOperations section={section} onSection={(next) => void navigate({ search: next === "packages" ? {} : { section: next }, replace: true })} />;
}

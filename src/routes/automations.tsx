import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { AutomationsWorkspace } from "@/components/operator/automations-workspace";
export const Route = createFileRoute("/automations")({
  head: () => ({ meta: [{ title: docTitle("/automations") }] }),
  component: AutomationsWorkspace,
});

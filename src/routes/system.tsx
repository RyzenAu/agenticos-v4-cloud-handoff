import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "@/components/shell/pages/system-page";

export const Route = createFileRoute("/system")({
  head: () => ({ meta: [{ title: docTitle("/system") }] }),
  component: SystemPage,
});

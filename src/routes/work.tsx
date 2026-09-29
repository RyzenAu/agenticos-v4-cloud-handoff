import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { WorkPage } from "@/components/shell/pages/work-page";

export const Route = createFileRoute("/work")({
  head: () => ({ meta: [{ title: docTitle("/work") }] }),
  component: WorkPage,
});

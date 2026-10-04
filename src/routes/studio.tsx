import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { StudioPage } from "@/components/shell/pages/studio-page";

export const Route = createFileRoute("/studio")({
  head: () => ({ meta: [{ title: docTitle("/studio") }] }),
  component: StudioPage,
});

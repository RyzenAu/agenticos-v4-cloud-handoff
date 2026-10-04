import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { ModelsPage } from "@/components/shell/pages/models-page";

// /models — System > Models: the model catalogue, routes, health, usage, cost and failures.
export const Route = createFileRoute("/models")({
  head: () => ({ meta: [{ title: docTitle("/models") }] }),
  component: ModelsPage,
});

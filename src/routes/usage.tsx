import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { AiUsagePage } from "@/components/ai-usage/ai-usage-page";

export const Route = createFileRoute("/usage")({
  head: () => ({ meta: [{ title: docTitle("/usage") }] }),
  component: AiUsagePage,
});

import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { FinancePage } from "@/components/shell/pages/finance-page";

export const Route = createFileRoute("/finance")({
  head: () => ({ meta: [{ title: docTitle("/finance") }] }),
  component: FinancePage,
});

import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { WorkPage } from "@/components/shell/pages/work-page";

// R12 rollout: `?decision=<id>` opens that decision's drawer (Back closes it; a link can open it).
export const Route = createFileRoute("/work")({
  validateSearch: (s: Record<string, unknown>): { decision?: string } => (typeof s.decision === "string" && /^[\w:.-]{1,120}$/.test(s.decision) ? { decision: s.decision } : {}),
  head: () => ({ meta: [{ title: docTitle("/work") }] }),
  component: WorkPage,
});

import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { SkillDraftsPage } from "@/components/operator/skill-drafts-page";

export const Route = createFileRoute("/skill-drafts")({
  head: () => ({ meta: [{ title: docTitle("/skill-drafts") }] }),
  component: SkillDraftsPage,
});

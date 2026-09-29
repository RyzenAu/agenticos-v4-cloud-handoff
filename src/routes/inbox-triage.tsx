import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { InboxTriageReview } from "@/components/operator/inbox-triage-review";

export const Route = createFileRoute("/inbox-triage")({
  head: () => ({ meta: [{ title: docTitle("/inbox-triage") }] }),
  component: InboxTriageReview,
});

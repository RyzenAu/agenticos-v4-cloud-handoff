import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { InboxWorkspace } from "@/components/operator/inbox-workspace";
export const Route = createFileRoute("/inbox")({
  head: () => ({ meta: [{ title: docTitle("/inbox") }] }),
  component: InboxWorkspace,
});

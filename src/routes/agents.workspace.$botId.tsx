import { createFileRoute } from "@tanstack/react-router";
import { docTitle } from "@/components/shell/destinations";

// /agents/workspace/<bot>: the path that names the bot. The parent route (agents.workspace.tsx) renders the workspace and reads
// the bot from this URL, so this route renders nothing of its own.
export const Route = createFileRoute("/agents/workspace/$botId")({
  head: () => ({ meta: [{ title: docTitle("/agents/workspace") }] }),
  component: () => null,
});

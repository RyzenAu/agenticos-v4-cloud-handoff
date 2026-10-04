import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { AgentsWorkspacePage } from "@/components/agents/workspace/workspace-page";
import { WORKSPACE_TABS, parseTab, type WorkspaceTab } from "@/components/agents/workspace/bots";

// /agents/workspace and /agents/workspace/<bot>?tab=chat|computer|tasks|setup — Jarvis > Agents. This route renders the whole workspace
// (it reads the bot from the URL itself), so the child route in agents.workspace.$botId.tsx only exists to give the bot a path.
export const Route = createFileRoute("/agents/workspace")({
  validateSearch: (s: Record<string, unknown>): { tab?: WorkspaceTab } => (typeof s.tab === "string" && (WORKSPACE_TABS as readonly string[]).includes(s.tab) ? { tab: s.tab as WorkspaceTab } : {}),
  head: () => ({ meta: [{ title: docTitle("/agents/workspace") }] }),
  component: AgentsWorkspaceRoute,
});

function AgentsWorkspaceRoute() {
  const { tab } = Route.useSearch();
  const { botId } = useParams({ strict: false }) as { botId?: string };
  return <AgentsWorkspacePage botId={botId} tab={parseTab(tab)} />;
}

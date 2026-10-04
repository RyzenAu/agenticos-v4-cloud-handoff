import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { CodingList } from "@/components/coding/coding-list";

// Work → Coding (Track 3 C5). `?request=` comes from the command palette or Jarvis ("fix X in <repo>"):
// the request is drafted and shown with its plan; nothing starts until "Start this job".
export const Route = createFileRoute("/coding/")({
  validateSearch: (s: Record<string, unknown>): { request?: string; filter?: string } => ({ ...(typeof s.request === "string" && s.request.trim() ? { request: s.request.slice(0, 20_000) } : {}), ...(typeof s.filter === "string" && ["active", "needs-you", "completed", "failed"].includes(s.filter) ? { filter: s.filter } : {}) }),
  head: () => ({ meta: [{ title: docTitle("/coding") }] }),
  component: CodingIndex,
});

function CodingIndex() {
  const { request, filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CodingList key={request ?? "manual"} request={request} filter={filter} onFilter={(f) => void navigate({ search: (prev) => ({ ...prev, filter: f === "all" ? undefined : f }), replace: true })} />;
}

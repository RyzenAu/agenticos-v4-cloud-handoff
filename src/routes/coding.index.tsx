import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { CodingList } from "@/components/coding/coding-list";

// Work → Coding (Track 3 C5). `?request=` comes from the command palette or Jarvis ("fix X in <repo>"):
// the request is drafted and shown with its plan; nothing starts until "Start this job".
export const Route = createFileRoute("/coding/")({
  validateSearch: (s: Record<string, unknown>): { request?: string } => (typeof s.request === "string" && s.request.trim() ? { request: s.request.slice(0, 20_000) } : {}),
  head: () => ({ meta: [{ title: docTitle("/coding") }] }),
  component: CodingIndex,
});

function CodingIndex() {
  const { request } = Route.useSearch();
  return <CodingList key={request ?? "manual"} request={request} />;
}

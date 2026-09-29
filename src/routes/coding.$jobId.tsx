import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { NotFoundPanel } from "@/components/shell/not-found-panel";
import { isJobIdShape } from "@/lib/route-checks";
import { CodingJobDetail } from "@/components/coding/job-detail";

// One coding job (Track 3 C5): plan, progress, changes, tests, review, usage, handoff; Stop/Pause/Resume.
export const Route = createFileRoute("/coding/$jobId")({
  validateSearch: (s: Record<string, unknown>): { tab?: string } => (typeof s.tab === "string" ? { tab: s.tab.slice(0, 20) } : {}),
  head: ({ params }) => ({ meta: [{ title: docTitle(isJobIdShape(params.jobId) ? "/coding/job" : "/not-found") }] }),
  // An id that can't be a job is a real 404 (status and page); a well-formed id with no job shows the same page from the component.
  loader: ({ params }) => {
    if (!isJobIdShape(params.jobId)) throw notFound();
    return {};
  },
  notFoundComponent: () => <CodingJobNotFound />,
  component: CodingJobPage,
});

function CodingJobNotFound() {
  return <NotFoundPanel title="Coding job not found" description="There's no coding job at this link. It may have been removed, or the link is mistyped." backTo="/coding" backLabel="All coding jobs" />;
}

function CodingJobPage() {
  const { jobId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <CodingJobDetail jobId={jobId} tab={tab} />;
}

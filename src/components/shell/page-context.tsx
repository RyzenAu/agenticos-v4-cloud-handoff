// React side of the ONE page-context API (src/lib/page-context.ts). The shell mounts
// <PageContextShell/> once: it publishes the active page on every navigation and the job the Jarvis chip
// follows. Pages call `usePageContext(id, part)` to publish their selection, focused item, visible items
// and data sources; the part is withdrawn when the page unmounts, so a page that says nothing leaves the
// context honestly empty (Jarvis then says it doesn't know and asks).
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { focusJob, subscribeJobs } from "@/lib/job-events";
import { publishPageContext, setActivePage, setContextJob, type PageContextPart } from "@/lib/page-context";
import { maskGoal } from "@/lib/agent-feed";
import { locate } from "./destinations";

export function PageContextShell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const view = useRouterState({ select: (s) => (s.location.search as { view?: string } | undefined)?.view });
  useEffect(() => {
    const where = locate(path, view);
    const title = where?.drilldown?.label ?? where?.destination.label ?? (typeof document !== "undefined" ? document.title.replace(/\s+—\s+Agentic OS$/, "") : path);
    setActivePage({ path, destination: where?.destination.id ?? null, title });
  }, [path, view]);
  useEffect(
    () =>
      subscribeJobs((jobs) => {
        const job = focusJob(jobs, Date.now());
        setContextJob(job ? { id: job.id, title: maskGoal(job.title, 60), state: job.state, ...(job.lastStep ? { step: maskGoal(job.lastStep.intent, 80) } : {}) } : null);
      }),
    [],
  );
  return null;
}

/** Publish this page's part of the context while it is mounted. Re-publishes only when the part changes. */
export function usePageContext(providerId: string, part: PageContextPart | null) {
  // Keyed on the part's content, so a re-render with the same content publishes nothing. The cleanup
  // withdraws it (unmount, or just before the next content), which also survives StrictMode's
  // mount-unmount-mount in development.
  const key = part === null ? "" : JSON.stringify(part);
  useEffect(() => {
    publishPageContext(providerId, part);
    return () => publishPageContext(providerId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, key]);
}

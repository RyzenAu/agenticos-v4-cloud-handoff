import { docTitle } from "@/components/shell/destinations";
import { jobsReadMessage } from "@/components/activity/read-error";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/ds";
import { ActivityView, jobIdFromHash, type ActivityRead, type SelectedRead } from "@/components/activity/activity-view";
import { fetchJob } from "@/lib/job-events";
import type { JobSummary } from "../../scripts/jobs/types";
import { botForJob, readBots } from "@/components/agents/workspace/bots";
import { readComputers } from "@/lib/computers-client";

// Audit F3-04: this page used to be fixed empty arrays with a TODO and an empty state that read as
// measured ("No runs yet"), plus a hash that made up which model ran each row. It now reads the one
// durable job history (GET /__jobs, scripts/jobs/routes.ts) and says when that read failed.

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: docTitle("/activity") },
      { name: "description", content: "Jobs the OS ran through Jarvis, newest first." },
    ],
  }),
  component: ActivityPage,
});

class JobsReadError extends Error {
  constructor(message: string, readonly signedOut: boolean) {
    super(message);
  }
}

async function readJobs(): Promise<JobSummary[]> {
  const r = await fetch("/__jobs?limit=50");
  if (r.status === 401) throw new JobsReadError("Signed out", true);
  if (!r.ok) {
    // The server says why (for example "The job and approval stores are unavailable."): show that, with the status, not the status alone.
    const why = await r.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error : ""), () => "");
    throw new JobsReadError(jobsReadMessage(why, r.status), false);
  }
  const body = (await r.json()) as { jobs?: JobSummary[] };
  if (!Array.isArray(body.jobs)) throw new JobsReadError("The server's answer had no job list", false);
  return body.jobs;
}

function ActivityPage() {
  // "Open job" in a conversation links to /activity#job-<id>: that job is shown, even when it is older than the list.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const navigate = useNavigate();
  const selectedId = jobIdFromHash(hash);
  const sel = useQuery({ queryKey: ["activity", "job", selectedId], queryFn: () => fetchJob(selectedId!), enabled: !!selectedId, refetchInterval: (query) => (query.state.data && ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(query.state.data.state) ? false : 4_000), retry: 1 });
  const selected: SelectedRead | null = !selectedId ? null : sel.data ? { id: selectedId, status: "ok", job: sel.data } : sel.isError ? { id: selectedId, status: "error", message: "The job couldn't be read" } : sel.isFetched ? { id: selectedId, status: "missing" } : { id: selectedId, status: "loading" };
  useEffect(() => {
    if (selected?.status === "ok") document.querySelector('[data-testid="selected-job"]')?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [selected?.status, selectedId]);
  const q = useQuery({ queryKey: ["activity", "jobs"], queryFn: readJobs, refetchInterval: 60_000, retry: 1 });
  const read: ActivityRead = q.data
    ? { status: "ok", jobs: q.data, stale: q.isError }
    : q.isError
      ? {
          status: "error",
          message: q.error instanceof Error ? q.error.message : "The request failed",
          signedOut: q.error instanceof JobsReadError && q.error.signedOut,
        }
      : { status: "loading" };
  // A job that belongs to an agent links to that agent's workspace (read only when a job is selected).
  const bots = useQuery({ queryKey: ["agent-bots"], queryFn: readBots, enabled: selected?.status === "ok", staleTime: 10_000, retry: false });
  const computers = useQuery({ queryKey: ["computers"], queryFn: readComputers, enabled: selected?.status === "ok", staleTime: 5_000, retry: false });
  const owner = selected?.status === "ok" && bots.data?.status === "ok" ? botForJob(bots.data.bots, computers.data?.status === "ok" ? computers.data.computers : [], selected.job) : null;
  return (
    <div className="max-w-[1400px]">
      <PageHeader title="Activity" spacing="tight" />
      <ActivityView read={read} onRetry={() => void q.refetch()} selected={selected} workspace={owner ? { botId: owner.id, name: owner.name } : null} onCloseSelected={() => void navigate({ to: "/activity", hash: "", replace: true })} />
    </div>
  );
}

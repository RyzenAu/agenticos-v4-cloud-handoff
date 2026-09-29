import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/ds";
import { ActivityView, type ActivityRead } from "@/components/activity/activity-view";
import type { JobSummary } from "../../scripts/jobs/types";

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
  if (!r.ok) throw new JobsReadError(`The server answered HTTP ${r.status}`, false);
  const body = (await r.json()) as { jobs?: JobSummary[] };
  if (!Array.isArray(body.jobs)) throw new JobsReadError("The server's answer had no job list", false);
  return body.jobs;
}

function ActivityPage() {
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
  return (
    <div className="max-w-[1400px]">
      <PageHeader title="Activity" description="What the OS did for you through Jarvis, newest first." />
      <ActivityView read={read} onRetry={() => void q.refetch()} />
    </div>
  );
}

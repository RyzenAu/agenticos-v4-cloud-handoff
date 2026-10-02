// One Approval service and one Job service per server process, shared by every gate that migrates onto
// them (memory forget, coding apply, and after safety-r3: screen, away, control, lesson).
//
// Recovery runs ONCE, only in the process that owns background work (a quiet second server started
// with AGENTIC_OS_NO_BACKGROUND=1 opens both stores read-only and never recovers or writes).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { backgroundJobsDisabled } from "../preview-guard";
import { JobService } from "./service";
import { dataDirFor } from "../cloud/data-dir";

export type JobsRuntime = { approvals: ApprovalService; jobs: JobService; owner: boolean; recovered: { approvals: ReturnType<ApprovalService["recover"]> | null; jobs: ReturnType<JobService["recover"]> | null } };

const runtimes = new Map<string, JobsRuntime>();

export function storePaths(root: string) {
  const dir = join(dataDirFor(root));
  return { approvals: join(dir, "approvals.sqlite"), jobs: join(dir, "jobs.sqlite") };
}

/** The process-wide runtime for this repo root (lazy; recovery once, by the owner only). */
export function jobsRuntime(root: string, options: { owner?: boolean } = {}): JobsRuntime {
  const existing = runtimes.get(root);
  if (existing) return existing;
  const owner = options.owner ?? !backgroundJobsDisabled();
  const paths = storePaths(root);
  // A quiet second server can only read what the owner already created.
  if (!owner && (!existsSync(paths.approvals) || !existsSync(paths.jobs))) throw new Error("The job and approval stores aren't created yet (the main server creates them).");
  const approvals = new ApprovalService({ path: paths.approvals, readOnly: !owner });
  const jobs = new JobService({ path: paths.jobs, readOnly: !owner });
  const runtime: JobsRuntime = {
    approvals,
    jobs,
    owner,
    recovered: owner ? { approvals: approvals.recover(), jobs: jobs.recover() } : { approvals: null, jobs: null },
  };
  runtimes.set(root, runtime);
  return runtime;
}

/** Tests and shutdown: close and forget the runtime for a root. */
export function closeJobsRuntime(root: string) {
  const r = runtimes.get(root);
  if (!r) return;
  runtimes.delete(root);
  try {
    r.approvals.close();
  } catch {
    /* already closed */
  }
  try {
    r.jobs.close();
  } catch {
    /* still running: the process is exiting anyway */
  }
}

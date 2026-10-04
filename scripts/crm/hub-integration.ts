// How the hub's owning services plug into the CRM (Claude owns this file; the CRM's business rules stay in ops.ts and store.ts).
//
//   events   the store's own post-commit notification -> the activity stream topic "crm" ({ref, change, at}, no field values)
//   jobs     verifyAgent reads the SAVED job, its agent and its CRM subjects from the real Jobs store (or the saved coding link) before
//            an agent result is attributed; nothing a browser or a memory recall says counts
//   comms    verifyCommunicationEvidence fails closed: nothing is sent or verified in this phase, so Sent/Received never verify
//   results  a job that ends successfully with a CRM subject adds AT MOST ONE activity (crm.activity.add, eventId `<jobId>:result`),
//            linking the saved result as `artifact:<jobId>[/file]` (opened through the identity-gated /__computers route)
import { join } from "node:path";
import type { JobEvent, JobSummary } from "../jobs/types";
import type { Principal } from "../identity/principal";
import { isPrincipal } from "../approvals/principal";
import { dataDirFor } from "../cloud/data-dir";
import { createArtifactStore, type ArtifactStore } from "../computers/artifacts";
import { hubRole } from "../cloud/hub-role";
import { crmWriteRefusal } from "../jarvis-command/crm";
import { backgroundJobsDisabled } from "../preview-guard";
import { crmRefString, parseCrmRef, type CrmRef } from "../../src/lib/crm-ref";
import { configureCrmIntegrations, crmRuntime } from "./runtime";
import type { CrmChange } from "./store";

type JobLike = Pick<JobSummary, "id" | "state" | "title" | "bot" | "subjects" | "principal">;
type JobsReader = {
  get(id: string): JobLike | null;
  list?(filter: {
    state?: JobSummary["state"];
    limit?: number;
    botSubjectJobs?: boolean;
  }): JobLike[];
  subscribe(listener: (event: JobEvent) => void): () => void;
};
export type CodingLinkLike = { bot: string; personId: string; subjects: string[] };

export type CrmHubDeps = {
  /** The activity stream: `activity.crmChanged` once the stream is mounted. A missing publisher leaves focus and the 30 s poll as the UI's fallback. */
  publish?: (change: CrmChange) => void;
  /** The real Jobs store (jobsRuntime(root).jobs). Resolved lazily: a quiet copy may not have one. */
  jobs: () => JobsReader | null;
  /** Saved results (computers/artifacts); default: the hub's own store. */
  artifacts?: () => Pick<ArtifactStore, "get">;
  /** Coding jobs live in the coding store; the Agents workspace keeps their bot and CRM subjects beside it (agents/links.ts). */
  codingLink?: (jobId: string) => CodingLinkLike | null;
  /** The coding store's saved state for a job, when it is already open (never opened here). */
  codingState?: (jobId: string) => string | null;
  /** Tests: the operation runner (default crmRuntime(root).operations). */
  run?: (name: string, input: unknown, principal: Principal) => unknown | Promise<unknown>;
  log?: (line: string) => void;
  /** Tests: the hub role (default hubRole()) and the retry interval for results the CRM could not take yet. */
  role?: () => string;
  retryMs?: number;
};

const slug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** True only when the saved job (or saved coding link) names this agent, this record and this verified person, and it succeeded. */
export function verifyAgentFromStores(
  deps: Pick<CrmHubDeps, "jobs" | "codingLink" | "codingState">,
) {
  return (by: { agent: string; jobId: string }, principal: Principal, ref: CrmRef): boolean => {
    if (
      !isPrincipal(principal) ||
      !by ||
      typeof by.jobId !== "string" ||
      typeof by.agent !== "string"
    )
      return false;
    const subject = crmRefString(ref);
    const agent = slug(by.agent);
    if (!agent) return false;
    let job: JobLike | null = null;
    try {
      job = deps.jobs()?.get(by.jobId) ?? null;
    } catch {
      job = null;
    }
    if (job)
      return (
        !!job.bot &&
        job.bot === agent &&
        !!job.subjects?.includes(subject) &&
        job.principal?.personId === principal.personId &&
        job.state === "succeeded"
      );
    const link = deps.codingLink?.(by.jobId) ?? null;
    return (
      !!link &&
      link.bot === agent &&
      link.subjects.includes(subject) &&
      link.personId === principal.personId &&
      deps.codingState?.(by.jobId) === "completed"
    );
  };
}

/** Nothing is sent or verified in this phase: Sent and Received can never be recorded as verified. */
export const verifyCommunicationEvidenceClosed = (): boolean => false;

/**
 * A job that has succeeded with a CRM subject adds one result activity, for BOT/AGENT jobs only (a plain Jarvis command never lands on the shared
 * timeline). It is written as the job's recorded person and only when that person may write the CRM here (the same refusal Jarvis and /__crm use:
 * the owner at the hub, or a confirmed human session in the server role; never Telegram, a routine, a gateway or a bare tailnet login).
 * Idempotent on `<jobId>:result`. A job is remembered as done only after the write succeeded (or the CRM refused it for good), so one that
 * finishes while the CRM needs its upgrade, or is busy, is retried: on the next job, on a 30 s timer, and when the hub connects.
 */
export function startCrmJobResults(root: string, deps: CrmHubDeps): () => void {
  const jobs = deps.jobs();
  if (!jobs || backgroundJobsDisabled()) return () => undefined;
  const store =
    deps.artifacts ?? (() => createArtifactStore(join(dataDirFor(root), "computers", "artifacts")));
  const run =
    deps.run ??
    ((name, input, principal) => crmRuntime(root).operations.run(name, input, principal));
  const role = deps.role ?? (() => hubRole());
  const done = new Set<string>();
  const pending = new Map<string, JobLike>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const remember = (id: string) => {
    done.add(id);
    pending.delete(id);
    if (done.size > 1000) done.delete(done.values().next().value as string);
  };
  const eligible = (job: JobLike) => {
    if (job.state !== "succeeded" || !job.bot || !isPrincipal(job.principal) || done.has(job.id))
      return null;
    const subject = job.subjects?.map(parseCrmRef).find((r): r is CrmRef => !!r);
    if (!subject) return null;
    if (crmWriteRefusal(job.principal as unknown as Principal, role(), backgroundJobsDisabled()))
      return null;
    return subject;
  };
  async function record(job: JobLike): Promise<void> {
    const subject = eligible(job);
    if (!subject) return;
    let artifact: string | undefined;
    try {
      const saved = store().get(job.id, job.principal.personId);
      if (saved) artifact = `artifact:${job.id}/${saved.main}`;
    } catch {
      /* no saved result: the activity still records that the work finished */
    }
    const input = {
      ref: subject,
      eventId: `${job.id}:result`,
      kind: "agent-result",
      title: `${job.bot} finished: ${job.title}`.replace(/[\r\n]+/g, " ").slice(0, 300),
      ...(artifact ? { artifact } : {}),
      by: { agent: job.bot, jobId: job.id },
    };
    try {
      const result = (await run(
        "crm.activity.add",
        input,
        job.principal as unknown as Principal,
      )) as { ok?: boolean; code?: string } | null;
      if (result?.ok === false && result.code === "unavailable") throw new Error("unavailable");
      if (result?.ok === false)
        deps.log?.(`crm: result for job ${job.id} not recorded (${result.code ?? "refused"})`);
      remember(job.id); // written, replayed, or refused for good (record gone, not verified): retrying would not change the answer
    } catch (error) {
      // The CRM needs its upgrade, is busy or is closed: keep the job for the next attempt.
      pending.set(job.id, job);
      deps.log?.(`crm: result for job ${job.id} not recorded yet (${(error as Error).name})`);
      arm();
    }
  }
  async function retryPending() {
    for (const job of [...pending.values()]) await record(job);
    if (!pending.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function arm() {
    if (timer || stopped) return;
    timer = setInterval(() => void retryPending(), deps.retryMs ?? 30_000);
    timer.unref?.();
  }
  /** Succeeded bot jobs with a CRM subject that were never recorded (the CRM was not open, or the hub restarted): exactly once through the event id. */
  async function backfill() {
    let recent: JobLike[] = [];
    try {
      recent = (jobs!.list?.({ state: "succeeded", botSubjectJobs: true, limit: 200 }) ??
        []) as JobLike[];
    } catch {
      return;
    }
    for (const job of recent) if (eligible(job)) await record(job);
  }
  const unsubscribe = jobs.subscribe((event) => {
    if (event.type !== "job" || event.job.state !== "succeeded") return;
    void record(event.job).then(() => (pending.size > 1 ? retryPending() : undefined));
  });
  void backfill();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    unsubscribe();
  };
}

/** Connect the CRM to the hub's owning services. Returns one function that disconnects everything. */
export function connectCrmToHub(root: string, deps: CrmHubDeps): () => void {
  const stopIntegrations = configureCrmIntegrations(root, {
    ...(deps.publish ? { publishChange: deps.publish } : {}),
    verifyAgent: (by, principal, ref) => verifyAgentFromStores(deps)(by, principal, ref),
    verifyCommunicationEvidence: verifyCommunicationEvidenceClosed,
  });
  let stopResults: () => void = () => undefined;
  try {
    stopResults = startCrmJobResults(root, deps);
  } catch {
    /* a quiet copy without job stores: the rest still works */
  }
  return () => {
    stopResults();
    stopIntegrations();
  };
}

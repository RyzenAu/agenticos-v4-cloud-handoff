// Work → Coding: the harness at a glance (CODING-HARNESS §5.2, Track 3 C5; W-B redesign 29 Sep 2026).
// Five-second test: what's running and what needs you (top), how to start one (the composer and the
// six-step pipeline it goes through), then every job as a lane, then who can do the work, which repos,
// and the rules. Honest states: a draft waits for a clear Start; "waiting for approval" is not done;
// interrupted says "not replayed"; a test count is only ever the orchestrator's own run.
import { Link, useNavigate } from "@tanstack/react-router";
import { ListChecks, Loader2, Play, Sparkles, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Disclosure, Notice, PageFoot, PageHeader, Segmented, Widget, WidgetGrid, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  ACTIVE_STATES,
  NEEDS_YOU,
  codingClient,
  jobStateLabel,
  modelLabel,
  type CodingAccounts,
  type CodingJob,
  type CodingRepo,
  type ShapeResponse,
} from "@/lib/coding-client";
import { pipelineFor, sampleRequest } from "@/lib/coding-pipeline";
import { CODING_REQUEST_MAX, codingTooLong } from "@/lib/commands/coding";
import { AgentsCard, PolicyCard, ReposCard } from "./harness-panel";
import { PipelineDots, PipelineLane } from "./pipeline-lane";

type Filter = "all" | "active" | "needs-you" | "completed" | "failed";
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Running" },
  { value: "needs-you", label: "Needs you" },
  { value: "completed", label: "Done" },
  { value: "failed", label: "Stopped" },
];

function needsYou(job: CodingJob) {
  return (NEEDS_YOU as string[]).includes(job.state) || job.runs.some((r) => r.state === "needs_input");
}

export function matches(job: CodingJob, f: Filter) {
  if (f === "all") return true;
  if (f === "active") return (ACTIVE_STATES as string[]).includes(job.state);
  if (f === "needs-you") return needsYou(job);
  if (f === "completed") return job.state === "completed";
  return ["failed", "interrupted", "cancelled"].includes(job.state);
}

/** Decisions first, then work in progress, then the most recently updated jobs. */
export function sortJobsForAction(jobs: CodingJob[]): CodingJob[] {
  const rank = (job: CodingJob) => needsYou(job) ? 0 : (ACTIVE_STATES as string[]).includes(job.state) ? 1 : 2;
  return [...jobs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Why a job needs you, in one line a person would say. */
export function needsYouLine(job: CodingJob): string {
  const asking = job.runs.find((r) => r.state === "needs_input" && r.pendingInput);
  if (asking) return `${asking.roleId} is asking: ${asking.pendingInput!.title}`;
  switch (job.state) {
    case "draft": return "The plan needs fixes before it can start";
    case "awaiting_confirmation": return "The plan is ready. Press Start when you're happy with it";
    case "awaiting_approval": return "Waiting for your spoken yes or Telegram code to merge. Not merged yet";
    case "interrupted": return "Interrupted: nothing was replayed. Resume when you're ready";
    case "blocked_allowance": return "Paused at an account limit. Resume after the reset, or on another model";
    case "needs_owner": return "The done gate or an agent needs your decision";
    default: return jobStateLabel(job.state).label;
  }
}

export function CodingList({ request }: { request?: string }) {
  const [jobs, setJobs] = useState<CodingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [accounts, setAccounts] = useState<{ data: CodingAccounts | null; error: string | null }>({ data: null, error: null });
  const [repos, setRepos] = useState<{ data: CodingRepo[] | null; error: string | null }>({ data: null, error: null });
  const [composer, setComposer] = useState(request ?? "");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const out = await codingClient.list();
      setJobs(out.jobs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  // Who can do the work and where: read once (they change only when the owner edits the registry).
  useEffect(() => {
    codingClient.accounts().then((data) => setAccounts({ data, error: null })).catch((e) => setAccounts({ data: null, error: (e as Error).message }));
    codingClient.repos().then((r) => setRepos({ data: r.repos, error: null })).catch((e) => setRepos({ data: null, error: (e as Error).message }));
  }, []);

  // "Jarvis, show me the tests": the voice rules set a focus; open that job on that tab.
  useEffect(() => {
    let stop = false;
    codingClient.focus().then((f) => {
      if (!stop && f.focus && !request) void navigate({ to: "/coding/$jobId", params: { jobId: f.focus.jobId }, search: { tab: f.focus.tab } as never });
    }).catch(() => undefined);
    return () => { stop = true; };
  }, [navigate, request]);

  const shown = useMemo(() => sortJobsForAction((jobs ?? []).filter((j) => matches(j, filter))), [jobs, filter]);
  const waiting = useMemo(() => (jobs ?? []).filter(needsYou), [jobs]);
  const running = useMemo(() => (jobs ?? []).filter((j) => (ACTIVE_STATES as string[]).includes(j.state)), [jobs]);
  const firstRepo = repos.data?.[0]?.id ?? null;

  const useExample = () => {
    setComposer(sampleRequest(firstRepo));
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  // Lead with the task and the ordered queue. Account and policy detail remains one click away.
  const loading = jobs === null && !error;
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Coding" description="Assign work and see what needs your decision." />

      {error && <Notice tone="danger" title="Couldn't load coding jobs" className="mb-6">{error} {jobs ? "The list below is the last successful read." : "Job counts are unavailable."} It retries every few seconds. <Button variant="outline" size="sm" onClick={() => void load()}>Try now</Button></Notice>}

      <WidgetGrid aria-label="Coding">
        <NewJob text={composer} setText={setComposer} textareaRef={composerRef} autoDraft={request ?? ""} onDrafted={load} />
        <Widget icon={ListChecks} span={4} title="Jobs" badge={jobs?.length || undefined} id="coding-jobs">
          {(loading || !jobs || jobs.length > 0) && (
            <p className="mt-3 text-sm text-muted-foreground" role="status">
              {loading ? "Reading jobs…" : !jobs ? "Job status unavailable" : `${waiting.length} need you · ${running.length} running${error ? " · last successful read" : ""}`}
            </p>
          )}
          <Segmented value={filter} options={FILTERS} onChange={setFilter} ariaLabel="Filter coding jobs" className="my-4 max-w-full overflow-x-auto" />
          {loading ? (
            <div role="status" aria-busy="true" className="rounded-2xl bg-inset p-6 text-sm text-muted-foreground">Loading coding jobs…</div>
          ) : !jobs ? (
            <p className="rounded-2xl border border-dashed border-border-strong p-6 text-sm text-muted-foreground">Jobs could not be read. Try again above.</p>
          ) : jobs.length === 0 ? (
            <FirstJob onExample={useExample} repo={firstRepo} />
          ) : shown.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border-strong p-6 text-sm text-muted-foreground">No job matches this filter.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2" aria-label="Coding jobs">
              {shown.map((job) => (
                <li key={job.id} className="min-w-0"><JobCard job={job} /></li>
              ))}
            </ul>
          )}
        </Widget>
      </WidgetGrid>

      <section className="mt-6 rounded-2xl border border-border bg-card px-3 py-2" aria-label="Coding setup">
        <Disclosure summary={<span className="font-medium">Agents, repositories and rules</span>} meta="Setup details">
          <WidgetGrid>
            <div className="col-span-full min-w-0 md:col-span-2"><AgentsCard data={accounts.data} error={accounts.error} /></div>
            <ReposCard repos={repos.data} error={repos.error} />
            <PolicyCard />
          </WidgetGrid>
        </Disclosure>
      </section>

      <PageFoot>
        Jobs refresh every few seconds. Agents work in separate git worktrees; merge and deploy need your approval.
      </PageFoot>
    </div>
  );
}

/** The teaching empty state: the six steps, and an example that only fills the box. Not a fake job. */
export function FirstJob({ onExample, repo }: { onExample: () => void; repo: string | null }) {
  return (
    <div className="rounded-2xl border border-dashed border-border-strong p-5 sm:p-7" data-empty="coding-jobs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2.5 text-lg font-semibold text-foreground">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-inset text-muted-foreground"><SquareTerminal className="size-4" /></span>
            No coding jobs yet
          </p>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
            Every job goes through the same six steps. You describe the change; the harness does the rest and stops at the two points that need you: starting it, and merging it.
          </p>
        </div>
        <Button variant="outline" className="h-10 shrink-0 rounded-full px-5" onClick={onExample}>
          <Sparkles aria-hidden="true" /> Try an example request
        </Button>
      </div>
      <PipelineLane className="mt-6" ariaLabel="How a coding job runs" />
      <div className="mt-5 rounded-xl bg-inset p-4">
        <p className="text-xs font-medium text-muted-foreground">Example request (it only fills the box above; nothing is drafted until you press Draft)</p>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground">“{sampleRequest(repo)}”</p>
        <p className="mt-2 text-xs text-muted-foreground">Or say it to Jarvis: “Fix X in {repo ?? "<repo>"}. Opus builds, another Opus reviews.”</p>
      </div>
    </div>
  );
}

export function JobCard({ job }: { job: CodingJob }) {
  const state = jobStateLabel(job.state);
  const steps = pipelineFor(job);
  const blocked = job.runs.find((r) => r.state === "blocked_allowance");
  return (
    <Link
      to="/coding/$jobId"
      params={{ jobId: job.id }}
      className="ds-interactive block min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm hover:border-border-strong hover:bg-surface-raised"
      aria-label={`${job.spec.objective}: ${state.label}`}
      data-job-state={job.state}
    >
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="min-w-0 text-base font-medium leading-snug text-foreground">{job.spec.objective}</p>
        <span className={cn("inline-flex shrink-0 items-center gap-2 text-xs font-medium", TONE_TEXT[state.tone])}>
          <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_DOT[state.tone])} />
          {state.label}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{job.spec.repo.repoId} · updated {fmtRelative(job.updatedAt)}</p>
      {needsYou(job) && <p className="mt-2 text-sm font-medium text-warn">{needsYouLine(job)}</p>}
      <div className="mt-4"><PipelineDots steps={steps} /></div>
      {blocked && (
        <p className="mt-3 text-xs text-warn">
          {blocked.binding.accountSlot} is at its limit: {blocked.error?.message ?? "waiting for its window to reset"}
        </p>
      )}
    </Link>
  );
}

const TONE_DOT: Record<string, string> = { neutral: "bg-muted-foreground", accent: "bg-brand", success: "bg-success", warn: "bg-warn", danger: "bg-danger", info: "bg-info" };
const TONE_TEXT: Record<string, string> = { neutral: "text-muted-foreground", accent: "text-brand", success: "text-success", warn: "text-warn", danger: "text-danger", info: "text-info" };

/** Describe a change → the shaper asks ONE question or drafts a plan → Start (a clear confirmation). */
function NewJob({ text, setText, textareaRef, autoDraft, onDrafted }: { text: string; setText: (s: string) => void; textareaRef: RefObject<HTMLTextAreaElement | null>; autoDraft: string; onDrafted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShapeResponse | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const navigate = useNavigate();
  const auto = useRef(false);

  const draft = useCallback(async (extra: { draftId?: string; answer?: string } = {}) => {
    // R4: a request longer than a draft takes is refused with the reason, never cut.
    if (!extra.draftId && text.trim().length > CODING_REQUEST_MAX) {
      setResult(null);
      setError(codingTooLong(CODING_REQUEST_MAX));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await codingClient.shape(text, extra);
      setResult(out);
      setAnswer("");
      if (out.kind === "draft") onDrafted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [text, onDrafted]);

  // Arriving from the command palette or Jarvis with a request: draft it (nothing starts until Start).
  useEffect(() => {
    if (autoDraft && !auto.current) { auto.current = true; void draft(); }
  }, [autoDraft, draft]);

  async function start() {
    if (result?.kind !== "draft") return;
    setBusy(true);
    try {
      await codingClient.start(result.jobId, result.specDigest);
      setStarted(result.jobId);
      void navigate({ to: "/coding/$jobId", params: { jobId: result.jobId }, search: { tab: "progress" } as never });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Widget icon={SquareTerminal} span={4} title="Start a job" data-coding="start">
      <div className="flex flex-col gap-4">
        <label htmlFor="coding-request" className="text-base font-medium text-foreground">What should change, and in which repo?</label>
        <textarea
          id="coding-request"
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Fix the calls table in the receptionist app: yesterday's calls show as today. Opus builds, another Opus reviews."
          className="w-full min-w-0 rounded-xl border border-input bg-background px-4 py-3 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" className="h-10 rounded-full px-5" onClick={() => void draft()} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Draft the plan
          </Button>
          <span className="text-sm text-muted-foreground">Drafting reads the repo; it never changes it. Nothing starts until you press Start.</span>
        </div>
        {error && <Notice tone="danger" title="That didn't work">{error}</Notice>}
        {result?.kind === "refused" && <Notice tone="warn" title="Can't draft that">{result.reason}</Notice>}
        {result?.kind === "ask" && (
          <form className="flex flex-col gap-3 rounded-xl bg-inset p-4" onSubmit={(e) => { e.preventDefault(); void draft({ draftId: result.draftId, answer }); }}>
            <label htmlFor="coding-answer" className="text-sm font-medium">{result.question}</label>
            {result.options?.length ? (
              <div className="flex flex-wrap gap-2">
                {result.options.map((o) => <Button key={o} type="button" variant="outline" className="rounded-full" onClick={() => void draft({ draftId: result.draftId, answer: o })}>{o}</Button>)}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <input id="coding-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <Button type="submit" variant="outline" className="rounded-full" disabled={busy || !answer.trim()}>Answer</Button>
            </div>
          </form>
        )}
        {result?.kind === "draft" && <DraftCard result={result} busy={busy} started={started} onStart={start} />}
      </div>
    </Widget>
  );
}

function DraftCard({ result, busy, started, onStart }: { result: Extract<ShapeResponse, { kind: "draft" }>; busy: boolean; started: string | null; onStart: () => void }) {
  const spec = result.spec;
  const ok = result.validation.ok;
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-inset p-4 sm:p-5" aria-label="Drafted plan">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center gap-2 text-xs font-medium", ok ? "text-info" : "text-warn")}>
          <span aria-hidden="true" className={cn("size-2 rounded-full", ok ? "bg-info" : "bg-warn")} />
          {ok ? "Plan ready: waiting for you to start it" : "Plan needs fixes"}
        </span>
      </div>
      <p className="text-base font-medium leading-snug text-foreground">{spec.objective}</p>
      <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="Plan facts">
        <li className="rounded-full bg-card px-3 py-1">{spec.repo.repoId} at {spec.repo.baseSha.slice(0, 7)} ({spec.repo.baseRef})</li>
        <li className="rounded-full bg-card px-3 py-1">branch {spec.repo.jobBranch}</li>
        <li className="rounded-full bg-card px-3 py-1">checks: {spec.checks.join(", ") || "none"}</li>
      </ul>
      <div className="-mx-3">
        <Disclosure summary={<span className="font-medium">Agents</span>} meta={`${spec.roles.length} roles`}>
          <ul className="flex flex-col gap-1 text-sm">
            {spec.roles.map((r) => (
              <li key={r.roleId}>{r.roleId}: {r.agent ? modelLabel(r.agent) : "the orchestrator's own test run"}{r.owns.globs.length || r.owns.newFiles.length ? ` — may change ${[...r.owns.globs, ...r.owns.newFiles].join(", ")}` : r.access === "read-only" ? " — read-only" : ""}</li>
            ))}
          </ul>
        </Disclosure>
        <Disclosure summary={<span className="font-medium">Done when</span>} meta={`${spec.doneWhen.length}`}>
          <ul className="list-disc pl-5 text-sm">{spec.doneWhen.map((d) => <li key={d.id}>{d.text} <span className="text-xs text-muted-foreground">({d.evidence}{d.ref ? `: ${d.ref}` : ""})</span></li>)}</ul>
        </Disclosure>
        <Disclosure summary={<span className="font-medium">After it's done</span>}>
          <p className="text-sm text-muted-foreground">Nothing is merged or deployed unless you approve it by voice or your Telegram code.</p>
        </Disclosure>
      </div>
      {!ok && (
        <Notice tone="warn" title="It can't start yet">
          {result.validation.errors.map((e) => e.detail).join("; ")}
        </Notice>
      )}
      {result.validation.warnings.length > 0 && <p className="text-xs text-muted-foreground">{result.validation.warnings.join(" ")}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" className="h-10 rounded-full px-5" onClick={onStart} disabled={!ok || busy || !!started}>
          <Play aria-hidden="true" />
          Start this job
        </Button>
        <Link to="/coding/$jobId" params={{ jobId: result.jobId }} className="text-sm text-muted-foreground underline underline-offset-4">Open the draft</Link>
      </div>
    </section>
  );
}

// Work → Coding: the harness at a glance (CODING-HARNESS §5.2, Track 3 C5; W-B redesign 29 Sep 2026).
// Five-second test: what's running and what needs you (top), how to start one (the composer and the
// six-step pipeline it goes through), then every job as a lane, then who can do the work, which repos,
// and the rules. Honest states: a draft waits for a clear Start; "waiting for approval" is not done;
// interrupted says "not replayed"; a test count is only ever the orchestrator's own run.
import { PlanEditor } from "./plan-editor";
import { Link, useNavigate } from "@tanstack/react-router";
import { ListChecks, Loader2, Play, Sparkles, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, Disclosure, Notice, PageFoot, PageHeader, Segmented, Widget, WidgetGrid, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  ACTIVE_STATES,
  NEEDS_YOU,
  claudeAccountLabel,
  codingClient,
  isClaudeAccount,
  jobLabel,
  modelLabel,
  type AgentBinding,
  type ClaudeCodingAccount,
  type CodingAccounts,
  type CodingJob,
  type CodingRepo,
  type ShapeResponse,
} from "@/lib/coding-client";
import { pipelineFor, sampleRequest } from "@/lib/coding-pipeline";
import { CODING_REQUEST_MAX, codingTooLong } from "@/lib/commands/coding";
import { AgentsCard, PolicyCard, ReposCard } from "./harness-panel";
import { PipelineDots, PipelineLane } from "./pipeline-lane";
import { useDraft } from "@/lib/use-draft";
import { useVisiblePoll } from "@/lib/visible-poll";
import { needsYou, needsYouLine } from "./needs-you";
import { codingResumeLabel, isPaidBinding } from "../../../scripts/coding/pause-reason";
import { RunsOnLine, codingSummary } from "./job-workspace";

export { needsYouLine };

type Filter = "all" | "active" | "needs-you" | "completed" | "failed";
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Running" },
  { value: "needs-you", label: "Needs you" },
  { value: "completed", label: "Done" },
  { value: "failed", label: "Stopped" },
];

export function matches(job: CodingJob, f: Filter) {
  if (f === "all") return true;
  if (f === "active") return (ACTIVE_STATES as string[]).includes(job.state);
  if (f === "needs-you") return needsYou(job);
  if (f === "completed") return job.state === "completed";
  return ["failed", "interrupted", "cancelled"].includes(job.state);
}

/** Decisions first, then work in progress, then the most recently updated jobs. */
/** Names the repo in the words the shaper already understands. */
export function withRepo(repo: string, text: string): string {
  return `In the ${repo} repo: ${text}`;
}

export function sortJobsForAction(jobs: CodingJob[]): CodingJob[] {
  const rank = (job: CodingJob) => needsYou(job) ? 0 : (ACTIVE_STATES as string[]).includes(job.state) ? 1 : 2;
  return [...jobs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function CodingList({ request }: { request?: string }) {
  const [jobs, setJobs] = useState<CodingJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [accounts, setAccounts] = useState<{ data: CodingAccounts | null; error: string | null }>({ data: null, error: null });
  const [repos, setRepos] = useState<{ data: CodingRepo[] | null; error: string | null }>({ data: null, error: null });
  const [composer, setComposer] = useDraft("coding-request", request ?? "");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const navigate = useNavigate();

  // A failed read is shown (the list keeps its last good rows, labelled "last successful read") and rethrown so the poll backs off.
  const load = useCallback(async () => {
    try {
      const out = await codingClient.list();
      setJobs(out.jobs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  // Round 6: 4 s only while a job is running or waiting on you, 15 s when nothing is; never in a hidden tab (it reads at once on return);
  // backs off while the hub is down. It was a fixed 4 s timer, hidden or not: 15 requests a minute on an idle page.
  const jobsRef = useRef<CodingJob[] | null>(null);
  jobsRef.current = jobs;
  useVisiblePoll(load, () => ((jobsRef.current ?? []).some((j) => needsYou(j) || (ACTIVE_STATES as string[]).includes(j.state)) ? 4_000 : 15_000));

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

  // The header button takes you to the request box however far down it is.
  const focusComposer = () => {
    composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    composerRef.current?.focus({ preventScroll: true });
  };

  // Lead with the task and the ordered queue. Account and policy detail remains one click away.
  const loading = jobs === null && !error;
  // Active work first: anything running or waiting on you is listed above the composer (2026-10-01).
  const activeFirst = waiting.length + running.length > 0;
  const jobsWidget = (
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
                <li key={job.id} className="min-w-0">
                  <JobCard job={job} />
                </li>
              ))}
            </ul>
          )}
        </Widget>
  );
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader
        title="Coding"
        description="Assign work and see what each job is waiting on."
        actions={<Button variant="accent" size="sm" onClick={focusComposer}>Assign work</Button>}
      />

      {error && (
        <Notice tone="danger" title="Couldn't load coding jobs" className="mb-6">
          {error}{" "}
          {jobs ? "The list below is the last successful read." : "Job counts are unavailable."} It keeps retrying, a little less often the longer the hub stays unreachable (at most once a minute). {" "}
          <Button variant="outline" size="sm" onClick={() => void load().catch(() => undefined)}>Try now</Button>
        </Notice>
      )}

      <WidgetGrid aria-label="Coding">
        {activeFirst && jobsWidget}
        <NewJob text={composer} setText={setComposer} textareaRef={composerRef} autoDraft={request ?? ""} onDrafted={load} repos={repos.data} />
{!activeFirst && jobsWidget}
      </WidgetGrid>

      <section className="mt-6 rounded-2xl border border-border bg-card px-3 py-2" aria-label="Coding setup">
        <Disclosure summary={<span className="font-medium">Agents, repositories and rules</span>} meta="Setup details">
          <WidgetGrid>
            <div className="col-span-full min-w-0 md:col-span-2">
              <AgentsCard data={accounts.data} error={accounts.error} />
            </div>
            <ReposCard repos={repos.data} error={repos.error} />
            <PolicyCard />
          </WidgetGrid>
        </Disclosure>
      </section>

      <PageFoot>
        Jobs refresh every few seconds while one is running, and every 15 seconds otherwise. Agents work in separate git worktrees; merge and deploy need your approval.
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
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-inset text-muted-foreground">
              <SquareTerminal className="size-4" />
            </span>
            No coding jobs yet
          </p>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
            Describe the change above, review the plan, then start the job.
          </p>
        </div>
        <Button variant="outline" className="h-10 shrink-0 rounded-full px-5" onClick={onExample}>
          <Sparkles aria-hidden="true" /> Try an example request
        </Button>
      </div>
      <details className="mt-4">
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">
          Example & workflow
        </summary>
        <PipelineLane className="mt-3" ariaLabel="How a coding job runs" />
        <div className="mt-5 rounded-xl bg-inset p-4">
        <p className="text-xs font-medium text-muted-foreground">Example request (it only fills the box above; nothing is drafted until you press Draft)</p>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground">“{sampleRequest(repo)}”</p>
        <p className="mt-2 text-xs text-muted-foreground">Or say it to Jarvis: “Fix X in {repo ?? "<repo>"}. Opus builds, another Opus reviews.”</p>
      </div>
      </details>
    </div>
  );
}

export function JobCard({ job }: { job: CodingJob }) {
  const state = jobLabel(job);
  const steps = pipelineFor(job);
  const blocked = job.runs.find((r) => r.state === "blocked_allowance");
  const summary = codingSummary(job);
  const waiting = summary.waiting ? summary.waiting.replace(/^Waiting for you — /, "").replace(/^./, (c) => c.toUpperCase()) : null;
  return (
    <Link
      to="/coding/$jobId"
      params={{ jobId: job.id }}
      className="ds-interactive block min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm hover:border-border-strong hover:bg-surface-raised"
      aria-label={`${summary.headline}: ${job.spec.objective}`}
      data-job-state={job.state}
    >
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="min-w-0 text-base font-medium leading-snug text-foreground">
          {job.spec.objective}
        </p>
        <span className={cn("inline-flex shrink-0 items-center gap-2 text-xs font-medium", TONE_TEXT[state.tone])}>
          <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_DOT[state.tone])} />
          {state.label}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="job-headline">
        {summary.acting ? `${summary.headline} · ` : ""}{job.spec.repo.repoId} · updated {fmtRelative(job.updatedAt)}
      </p>
      {/* One statement per card: the state label above carries the colour; this line only says what to do next. */}
      {waiting && <p className="mt-2 text-sm text-foreground" data-testid="job-waiting">{waiting}</p>}
      {job.state === "needs_owner" && <p className="mt-1 text-xs text-muted-foreground" data-testid="job-next">Next: {codingResumeLabel(job)}</p>}
      <div className="mt-4">
        <PipelineDots steps={steps} quiet={!!waiting} />
      </div>
      {blocked && (
        <p className="mt-3 text-xs text-muted-foreground">
          {blocked.binding.accountSlot} is at its limit:{" "}
          {blocked.error?.message ?? "waiting for its window to reset"}
        </p>
      )}
    </Link>
  );
}

const TONE_DOT: Record<string, string> = { neutral: "bg-muted-foreground", accent: "bg-brand", success: "bg-success", warn: "bg-warn", danger: "bg-danger", info: "bg-info" };
const TONE_TEXT: Record<string, string> = { neutral: "text-muted-foreground", accent: "text-brand", success: "text-success", warn: "text-warn", danger: "text-danger", info: "text-info" };

/** Describe a change → the shaper asks ONE question or drafts a plan → Start (a clear confirmation). */
function NewJob({ text, setText, textareaRef, autoDraft, onDrafted, repos }: { repos?: { id: string; description: string }[] | null; text: string; setText: (s: string) => void; textareaRef: RefObject<HTMLTextAreaElement | null>; autoDraft: string; onDrafted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShapeResponse | null>(null);
  const [answer, setAnswer] = useState("");
  // Optional: name the repo up front. Empty lets the shaper read it from the request.
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const navigate = useNavigate();
  const auto = useRef(false);
  const draftVersion = useRef(0);
  const latestText = useRef(text);
  latestText.current = text;
  const [resultInput, setResultInput] = useState("");
  const [busyInput, setBusyInput] = useState("");
  const [starting, setStarting] = useState(false);
  const currentResult = resultInput === text.trim() ? result : null;
  // The newest draft that was shown and not started: editing the words clears the card but not this, so the next draft can close it.
  const openDraft = useRef<string | null>(null);
  const working = starting || (busy && busyInput === text.trim());

  function editRequest(next: string) {
    draftVersion.current++;
    latestText.current = next;
    setText(next);
    setResult(null);
    setAnswer("");
    setError(null);
    setStarted(null);
    setBusy(false);
  }

  const draft = useCallback(
    async (extra: { draftId?: string; answer?: string; replaces?: string } = {}) => {
      // R4: a request longer than a draft takes is refused with the reason, never cut.
      if (!extra.draftId && text.trim().length > CODING_REQUEST_MAX) {
      setResult(null);
      setError(codingTooLong(CODING_REQUEST_MAX));
      return;
    }
      setBusy(true);
      setBusyInput(text.trim());
      setError(null);
      const version = ++draftVersion.current;
      const input = text.trim();
      try {
        // Drafting again from edited words closes the earlier unstarted draft, so an outdated plan can't be started from a stale card.
        const replaces = !extra.draftId ? openDraft.current ?? undefined : undefined;
        const out = await codingClient.shape(repo && !extra.draftId ? withRepo(repo, text) : text, { ...extra, ...(replaces ? { replaces } : {}) });
        if (version !== draftVersion.current || latestText.current.trim() !== input) {
          // A late result for words that have since changed: it is dropped here, and its draft is closed so it can't linger as startable.
          if (out.kind === "draft") void codingClient.cancel(out.jobId).catch(() => undefined);
          return;
        }
        setResultInput(input);
        setResult(out);
        setAnswer("");
        if (out.kind === "draft") { openDraft.current = out.jobId; onDrafted(); }
      } catch (e) {
        if (version !== draftVersion.current || latestText.current.trim() !== input) return;
        setError((e as Error).message);
      } finally {
        if (version === draftVersion.current) setBusy(false);
      }
    },
    [text, repo, onDrafted],
  );

  // Arriving from the command palette or Jarvis with a request: draft it (nothing starts until Start).
  useEffect(() => {
    if (autoDraft && !auto.current) { auto.current = true; void draft(); }
  }, [autoDraft, draft]);

  /** Before Start: edit the plan's words. A new revision; the old digest can't start (the server refuses it). */
  async function editPlan(patch: { objective?: string; doneWhen?: { id?: string; text: string }[]; nonGoals?: string[] }) {
    if (currentResult?.kind !== "draft" || starting || started) return;
    const input = resultInput;
    setError(null);
    try {
      const out = await codingClient.editPlan(currentResult.jobId, patch);
      if (latestText.current.trim() === input) setResult(out);
    } catch (e) { setError((e as Error).message); }
  }

  /** Before Start: move a role to another account. A new plan revision; the old one can't be started. */
  async function chooseAccount(roleId: string, accountSlot: string, model?: string) {
    if (currentResult?.kind !== "draft" || starting || started) return;
    const input = resultInput;
    setError(null);
    try {
      const out = await codingClient.setRoleAccount(currentResult.jobId, roleId, accountSlot, model ? { model } : {});
      if (latestText.current.trim() === input) setResult(out);
    } catch (e) { setError((e as Error).message); }
  }

  async function start() {
    if (currentResult?.kind !== "draft" || starting || started) return;
    setBusy(true);
    setStarting(true);
    setError(null);
    try {
      await codingClient.start(currentResult.jobId, currentResult.specDigest);
      openDraft.current = null;
      setStarted(currentResult.jobId);
      setText(""); // the request is now a job; do not keep it as an unfinished draft
      void navigate({
        to: "/coding/$jobId",
        params: { jobId: currentResult.jobId },
        search: { tab: "progress" } as never,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStarting(false);
    }
  }

  return (
    <Widget icon={SquareTerminal} span={4} title="Start a job" data-coding="start">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Describe it, pick the repo, accept or change the account, review the plan, then start. Nothing runs until you start it.</p>
        <label htmlFor="coding-request" className="text-base font-medium text-foreground">What should change?</label>
        <textarea
          id="coding-request"
          ref={textareaRef}
          value={text}
          onChange={(e) => editRequest(e.target.value)}
          disabled={starting}
          rows={3}
          placeholder="Fix yesterday's calls showing as today in the receptionist app."
          className="w-full min-w-0 rounded-xl border border-input bg-background px-4 py-3 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        {repos && repos.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="coding-repo" className="text-sm text-muted-foreground">Repo</label>
            <select id="coding-repo" value={repo} onChange={(e) => { setRepo(e.target.value); setResult(null); }} disabled={starting} className="h-10 min-w-0 max-w-full rounded-xl border border-input bg-background px-3 text-sm">
              <option value="">Work it out from the request</option>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="accent"
            className="h-10 rounded-full px-5"
            onClick={() => void draft()}
            disabled={working || !text.trim()}
          >
            {working ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Draft the plan
          </Button>
          <span className="text-sm text-muted-foreground">Review the plan before starting.</span>
        </div>
        {error && (
          <Notice tone="danger" title="That didn't work">
            {error}
          </Notice>
        )}
        {currentResult?.kind === "refused" && (
          <Notice tone="warn" title="Can't draft that">
            {currentResult.reason}
          </Notice>
        )}
        {currentResult?.kind === "ask" && (
          <form
            className="flex flex-col gap-3 rounded-xl bg-inset p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void draft({ draftId: currentResult.draftId, answer });
            }}
          >
            <label htmlFor="coding-answer" className="text-sm font-medium">
              {currentResult.question}
            </label>
            {currentResult.options?.length ? (
              <div className="flex flex-wrap gap-2">
                {currentResult.options.map((o) => (
                  <Button
                    key={o}
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    disabled={working}
                    onClick={() => void draft({ draftId: currentResult.draftId, answer: o })}
                  >
                    {o}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <input id="coding-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <Button
                type="submit"
                variant="outline"
                className="rounded-full"
                disabled={working || !answer.trim()}
              >
                Answer
              </Button>
            </div>
          </form>
        )}
        {currentResult?.kind === "draft" && (
          <DraftCard result={currentResult} busy={working} started={started} onStart={start} onAccount={chooseAccount} onEditPlan={editPlan} />
        )}
      </div>
    </Widget>
  );
}

/** Why a Claude account can't take new work now, or null. Unknown connection or usage never blocks. */
function claudeUnavailable(a: ClaudeCodingAccount): string | null {
  if (a.connection?.state === "signed-out") return a.connection.reason ?? "not signed in";
  if (a.allowance?.limitReached) return "at its plan limit";
  return null;
}

export function DraftCard({ result, busy, started, onStart, onAccount, onEditPlan }: { result: Extract<ShapeResponse, { kind: "draft" }>; busy: boolean; started: string | null; onStart: () => void; onAccount: (roleId: string, accountSlot: string, model?: string) => void; onEditPlan?: (patch: { objective?: string; doneWhen?: { id?: string; text: string }[]; nonGoals?: string[] }) => void }) {
  const spec = result.spec;
  const ok = result.validation.ok;
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeCodingAccount[] | null>(null);
  useEffect(() => {
    let live = true;
    codingClient.accounts().then((a) => { if (live) setClaudeAccounts(a.accounts.filter(isClaudeAccount)); }, () => { if (live) setClaudeAccounts([]); });
    return () => { live = false; };
  }, []);
  const accountOf = (slot: string) => claudeAccounts?.find((a) => a.accountSlot === slot) ?? null;
  const claudeRoles = spec.roles.filter((r) => r.agent?.route === "claude-code-cli");
  // A metered route (OpenRouter) costs money per token: say so plainly and require an explicit acknowledgement before Start.
  const paidModels = [...new Set(spec.roles.filter((r) => isPaidBinding(r.agent)).map((r) => r.agent!.model))];
  const [paidOk, setPaidOk] = useState(false);
  const paidKey = paidModels.join("|");
  useEffect(() => { setPaidOk(false); }, [paidKey]);
  const blocked = claudeRoles.map((r) => ({ r, a: accountOf(r.agent!.accountSlot) })).filter((x) => x.a && claudeUnavailable(x.a));
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
        <li className="rounded-full bg-card px-3 py-1">
          {spec.repo.repoId} at {spec.repo.baseSha.slice(0, 7)} ({spec.repo.baseRef})
        </li>
        <li className="rounded-full bg-card px-3 py-1">branch {spec.repo.jobBranch}</li>
        <li className="rounded-full bg-card px-3 py-1">
          checks: {spec.checks.join(", ") || "none"}
        </li>
      </ul>
      <RunsOnLine />
      {claudeRoles.length > 0 && claudeAccounts && claudeAccounts.length > 0 && (
        <div className="flex flex-col gap-2" aria-label="Claude accounts for this job">
          {claudeRoles.map((r) => (
            <label key={r.roleId} className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <span className="min-w-24 text-muted-foreground">{r.roleId === "builder-1" ? "Builder" : r.role === "reviewer" ? "Reviewer" : r.roleId} runs on</span>
              {claudeAccounts.length > 1 ? <select
                className="h-9 min-w-0 rounded-lg border border-border bg-card px-3 text-sm"
                aria-label={`Claude account for ${r.roleId}`}
                value={r.agent!.accountSlot}
                disabled={busy || !!started}
                onChange={(e) => onAccount(r.roleId, e.target.value)}
              >
                {claudeAccounts.map((a) => {
                  const why = claudeUnavailable(a);
                  const state = why ? ` (unavailable: ${why})` : a.connection?.state === "connected" ? "" : " (connection unknown)";
                  return <option key={a.accountSlot} value={a.accountSlot} disabled={!!why && a.accountSlot !== r.agent!.accountSlot}>{claudeAccountLabel(a)}{state}</option>;
                })}
              </select> : <span className="text-sm">{claudeAccountLabel(claudeAccounts[0])}</span>}
              <select
                className="h-9 min-w-0 rounded-lg border border-border bg-card px-3 text-sm"
                aria-label={`Model for ${r.roleId}`}
                value={r.agent!.model}
                disabled={busy || !!started}
                onChange={(e) => onAccount(r.roleId, r.agent!.accountSlot, e.target.value)}
              >
                {[...new Set([r.agent!.model, ...(accountOf(r.agent!.accountSlot)?.models ?? claudeAccounts[0]?.models ?? [])])].map((m) => (
                  <option key={m} value={m}>{modelLabel({ ...r.agent!, model: m } as AgentBinding)}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {paidModels.length > 0 && (
        <Notice tone="warn" title="This job uses a paid route">
          <span data-testid="paid-notice">{paidModels.join(", ")} costs money per token through OpenRouter. Nothing is charged until you start the job, and only for what the agents use.</span>
          <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-foreground">
            <input type="checkbox" className="size-5" checked={paidOk} disabled={busy || !!started} onChange={(e) => setPaidOk(e.target.checked)} />
            I understand this route is paid
          </label>
        </Notice>
      )}
      {blocked.length > 0 && (
        <Notice tone="warn" title="Pick another account before starting">
          {blocked.map(({ r, a }) => `${claudeAccountLabel(a!)} can't run ${r.roleId}: ${claudeUnavailable(a!)}.`).join(" ")}
        </Notice>
      )}
      <div className="-mx-3">
        <Disclosure summary={<span className="font-medium">Agents</span>} meta={`${spec.roles.length} roles`}>
          <ul className="flex flex-col gap-1 text-sm">
            {spec.roles.map((r) => (
              <li key={r.roleId}>
                {r.roleId}: {r.agent ? `${modelLabel(r.agent)} · ${r.agent.route === "claude-code-cli" ? (accountOf(r.agent.accountSlot) ? claudeAccountLabel(accountOf(r.agent.accountSlot)!) : r.agent.accountSlot) : r.agent.accountSlot}` : "the orchestrator's own test run"}
                {r.owns.globs.length || r.owns.newFiles.length ? ` — may change ${[...r.owns.globs, ...r.owns.newFiles].join(", ")}` : r.access === "read-only" ? " — read-only" : ""}
              </li>
            ))}
          </ul>
        </Disclosure>
        {onEditPlan && (
          <Disclosure summary={<span className="font-medium">Edit the plan</span>} meta={`revision ${spec.revision}`}>
            <PlanEditor key={`${result.jobId}-${spec.revision}`} plan={spec} busy={busy || !!started} onSave={onEditPlan} />
          </Disclosure>
        )}
        <Disclosure summary={<span className="font-medium">Done when</span>} meta={`${spec.doneWhen.length}`}>
          <ul className="list-disc pl-5 text-sm">
            {spec.doneWhen.map((d) => (
              <li key={d.id}>
                {d.text}{" "}
                <span className="text-xs text-muted-foreground">
                  ({d.evidence}
                  {d.ref ? `: ${d.ref}` : ""})
                </span>
              </li>
            ))}
          </ul>
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
      {result.validation.warnings.length > 0 && (
        <p className="text-xs text-muted-foreground">{result.validation.warnings.join(" ")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" className="h-10 rounded-full px-5" onClick={onStart} disabled={!ok || busy || !!started || (paidModels.length > 0 && !paidOk)}>
          <Play aria-hidden="true" />
          Start this job
        </Button>
        <Link to="/coding/$jobId" params={{ jobId: result.jobId }} className="text-sm text-muted-foreground underline underline-offset-4">Open the draft</Link>
      </div>
    </section>
  );
}

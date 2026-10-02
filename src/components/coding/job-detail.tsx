// One coding job (CODING-HARNESS §5.3, Track 3 C5): header with Stop / Pause / Resume, the agents lane,
// pending inputs and approvals, and tabs for the plan, progress, changes, tests, review, usage and
// handoff. Live over SSE from the append-only event store (resumes from the last seq).
//
// Truth rules: "waiting for approval" is never "done"; interrupted says "not replayed"; tests shown are the
// orchestrator's own runs only; unknown usage is "unknown", never 0; a blocked role shows its reset time.
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, CircleSlash, GitBranch, Pause, Play, Square, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Disclosure, EmptyState, Notice, ConnectionState, Section, Segmented, StatusDot, Surface, fmtCount, fmtRelative } from "@/components/ds";
import {
  ACTIVE_STATES,
  codingClient,
  elapsed,
  followJob,
  jobLabel,
  modelLabel,
  runStateLabel,
  testsSummary,
  type CodingAccounts,
  type CodingEvent,
  type JobView,
} from "@/lib/coding-client";
import { glanceOf, nextLabel, reassignChoices } from "@/lib/coding-glance";
import { FailedTests } from "./failed-tests";
import { pipelineFor } from "@/lib/coding-pipeline";
import { PipelineLane } from "./pipeline-lane";
import { JobGlance } from "./job-glance";
import { isPaidBinding } from "../../../scripts/coding/pause-reason";
import { JobSummary } from "./job-summary";
import { SupersedeControl } from "./supersede-control";
import { CodingWorkspace } from "./job-workspace";
import { NotFoundPanel } from "@/components/shell/not-found-panel";
import { fmtTime } from "@/lib/format";
import { ACTIVITY_FILTERS, codingActivity, type ActivityFilter } from "@/lib/coding-activity";

export type CodingTab = "plan" | "progress" | "changes" | "tests" | "review" | "usage" | "handoff";
const TABS: readonly { value: CodingTab; label: string }[] = [
  { value: "progress", label: "Progress" },
  { value: "plan", label: "Plan" },
  { value: "changes", label: "Changes" },
  { value: "tests", label: "Tests" },
  { value: "review", label: "Review" },
  { value: "usage", label: "Usage" },
  { value: "handoff", label: "Handoff" },
];

export function CodingJobDetail({ jobId, tab }: { jobId: string; tab?: string }) {
  return <CodingJobSession key={jobId} jobId={jobId} tab={tab} />;
}

function CodingJobSession({ jobId, tab }: { jobId: string; tab?: string }) {
  const [view, setView] = useState<JobView | null>(null);
  const [events, setEvents] = useState<CodingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"live" | "polling" | "offline">("offline");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Stop is two clicks (REVIEW-T3): it ends every agent, and on a pending merge it withdraws the approval.
  const [confirmStop, setConfirmStop] = useState(false);
  // Accounts for the reassign-on-Resume choice, read only while the job waits on the owner.
  const [accounts, setAccounts] = useState<CodingAccounts | null>(null);
  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  // One click is one request: a double click never starts a second Resume.
  const inFlight = useRef(false);
  const [paidOk, setPaidOk] = useState(false);
  // Events, prompts and diagnostics sit behind Details; a deep link to a tab opens them.
  const [detailsOpen, setDetailsOpen] = useState(!!tab);
  const current = (TABS.some((t) => t.value === tab) ? tab : "progress") as CodingTab;
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    try {
      const v = await codingClient.job(jobId);
      setView(v);
      setEvents((prev) => (prev.length ? prev : v.events));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [jobId]);

  useEffect(() => { void reload(); }, [reload]);

  const waitingState = view?.job.state;
  useEffect(() => {
    if (waitingState !== "needs_owner" && waitingState !== "blocked_allowance") return;
    let live = true;
    codingClient.accounts().then((a) => { if (live) setAccounts(a); }, () => { if (live) setAccounts(null); });
    return () => { live = false; };
  }, [waitingState, jobId]);

  // Live events; each new state/diff/test/review/gate/apply refreshes the job document.
  useEffect(() => {
    if (!view) return;
    const start = view.events.at(-1)?.seq ?? 0;
    return followJob(jobId, start, (e) => {
      setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e].slice(-600)));
      if (["state", "diff", "test", "review", "gate", "apply", "approval_request", "approval_resolved", "input_request", "input_resolved", "usage", "handoff"].includes(e.type)) void reload();
    }, setLive);
    // Only re-subscribe when the job changes, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, !!view]);

  async function act(label: string, fn: () => Promise<unknown>, done?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(label);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  // Unlike act(), a refusal is thrown back to the form so what the owner typed stays put.
  async function supersede(ref: string, reason: string) {
    if (inFlight.current) throw new Error("Another action is still running. Try again in a moment.");
    inFlight.current = true;
    setBusy("supersede");
    setNotice(null);
    try {
      await codingClient.supersede(jobId, ref, reason);
      try {
        setView(await codingClient.job(jobId));
        setError(null);
        setNotice(`Marked superseded by ${ref}. The history is kept.`);
      } catch {
        // The mark is recorded; the page just could not re-read it. Say that, not a success that may be stale.
        setNotice(null);
        setError("It was marked superseded, but this page could not re-read the job. Reload to see it.");
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  if (error && !view && /no such coding job|unknown coding/i.test(error))
    return <NotFoundPanel title="Coding job not found" description="There's no coding job at this link. It may have been removed, or the link is mistyped." backTo="/coding" backLabel="All coding jobs" />;
  if (error && !view) return <Notice tone="danger" title="Couldn't load this coding job">{error}</Notice>;
  if (!view) return <div role="status" aria-busy="true" className="text-sm text-muted-foreground">Loading the coding job…</div>;
  const job = view.job;
  const state = jobLabel(job);
  const running = (ACTIVE_STATES as string[]).includes(job.state);
  const resumable = ["interrupted", "blocked_allowance", "needs_owner"].includes(job.state);
  const pendingInputs = job.runs.filter((r) => r.state === "needs_input" && r.pendingInput);
  const glance = glanceOf(view);
  const paidModels = [...new Set(job.spec.roles.filter((r) => isPaidBinding(r.agent)).map((r) => r.agent!.model))];
  const options = glance.moveRole && accounts ? reassignChoices(job, glance.moveRole, accounts, Date.now(), view.events) : null;
  const chosen = options?.options.find((o) => o.key === choiceKey) ?? options?.options.find((o) => o.key === options.defaultKey) ?? null;
  const resumeText = nextLabel(job, chosen);
  const doResume = () => act("resume", () => (glance.moveRole && chosen && !chosen.same
    ? codingClient.resume(job.id, { roleId: glance.moveRole, reassignTo: { route: chosen.route, model: chosen.model, accountSlot: chosen.accountSlot } })
    : codingClient.resume(job.id)), chosen && !chosen.same ? `Moved to ${chosen.accountLabel}. Continuing from the step that needs work.` : "Continuing from the step that needs work.");
  const setTab = (t: CodingTab) => void navigate({ to: "/coding/$jobId", params: { jobId }, search: { tab: t } as never, replace: true });

  const actions = (
    <>
      {job.state === "awaiting_confirmation" && (
        <Button disabled={!!busy || (paidModels.length > 0 && !paidOk)} onClick={() => act("start", () => codingClient.start(job.id, view.specDigest), "Started.")}>
          <Play className="h-4 w-4" aria-hidden="true" /> Start this job
        </Button>
      )}
      {running && view.liveRoles.length > 0 && (
        <Button variant="outline" disabled={!!busy} onClick={() => act("pause", () => codingClient.interrupt(job.id), "Paused. Resume continues the same agent sessions.")}>
          <Pause className="h-4 w-4" aria-hidden="true" /> Pause to take over
        </Button>
      )}
      {resumable && (
        <Button className="lg:hidden" disabled={!!busy} onClick={doResume}>
          <Play className="h-4 w-4" aria-hidden="true" /> {resumeText}
        </Button>
      )}
      {!["completed", "failed", "cancelled"].includes(job.state) && !confirmStop && (
        <Button variant="outline" disabled={!!busy} onClick={() => setConfirmStop(true)}>
          <Square className="h-4 w-4" aria-hidden="true" /> Stop
        </Button>
      )}
      {!["completed", "failed", "cancelled"].includes(job.state) && confirmStop && (
        <span role="group" aria-label="Confirm stop" className="inline-flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {job.state === "awaiting_approval" ? "Stop it? The merge request is withdrawn and the job can't be resumed." : "Stop every agent on this job? It can't be resumed; the worktrees are kept."}
          </span>
          <Button variant="destructive" disabled={!!busy} onClick={() => { setConfirmStop(false); void act("stop", () => codingClient.cancel(job.id), "Stopped. The worktrees are kept."); }}>
            <Square className="h-4 w-4" aria-hidden="true" /> Yes, stop it
          </Button>
          <Button variant="ghost" disabled={!!busy} onClick={() => setConfirmStop(false)}>Keep it running</Button>
        </span>
      )}
    </>
  );

  return (
    <div className="ds-detail min-w-0 max-w-[1320px] pb-24 [overflow-wrap:anywhere] lg:pb-0">
      <Link to="/coding" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Coding
      </Link>
      <header className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone}>{state.label}</Badge>
          <ConnectionState state={live === "live" || live === "polling" ? "live" : "reconnecting"} label={live === "live" ? "Live" : live === "polling" ? "Updating every 2 s" : "Reconnecting…"} />
          <span className="text-xs text-muted-foreground">Elapsed {elapsed(job.createdAt, ["completed", "failed", "cancelled"].includes(job.state) ? job.updatedAt : null)} · updated {fmtRelative(job.updatedAt)}</span>
        </div>
        <h1 className="text-2xl font-semibold leading-tight tracking-[-0.02em]">{job.spec.objective}</h1>
        <p className="inline-flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <GitBranch className="h-4 w-4" aria-hidden="true" />
          {job.spec.repo.repoId}: {job.spec.repo.baseSha.slice(0, 7)} → {job.spec.repo.jobBranch}
          {job.headSha ? ` @ ${job.headSha.slice(0, 7)}` : ""}
          <span>· asked by {job.spec.requestedBy.personId} ({job.spec.source.channel})</span>
        </p>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label="Results so far">
          <li><button type="button" className="ds-interactive rounded-full bg-inset px-3 py-1 hover:bg-surface-raised" onClick={() => setTab("changes")}>Changes: {job.diff ? `${job.diff.files.length} file${job.diff.files.length === 1 ? "" : "s"}` : "none yet"}</button></li>
          <li><button type="button" className="ds-interactive rounded-full bg-inset px-3 py-1 hover:bg-surface-raised" onClick={() => setTab("tests")}>Tests: {testsSummary(job).text}</button></li>
          <li><button type="button" className="ds-interactive rounded-full bg-inset px-3 py-1 hover:bg-surface-raised" onClick={() => setTab("review")}>Review: {job.review ? (job.review.verdict === "approve" ? "approved" : job.review.verdict === "request-changes" ? "changes requested" : "couldn't assess") : "none yet"}</button></li>
        </ul>
        {notice && <Notice tone="info">{notice}</Notice>}
        {error && <Notice tone="warn" title="Couldn't refresh this job">{error} Showing the last successful read; it retries when you act or the job changes.</Notice>}
        {job.state === "interrupted" && <Notice tone="warn" title="Interrupted: nothing was replayed">The OS restarted or the job was paused. Resume continues on the same agent sessions after they re-read the worktree.</Notice>}
      </header>

      {job.state === "awaiting_confirmation" && paidModels.length > 0 && (
        <Notice tone="warn" title="This job uses a paid route" className="mb-6">
          <span data-testid="paid-notice">{paidModels.join(", ")} costs money per token through OpenRouter.</span>
          <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-foreground">
            <input type="checkbox" className="size-5" checked={paidOk} onChange={(e) => setPaidOk(e.target.checked)} />
            I understand this route is paid
          </label>
        </Notice>
      )}
      {job.supersededBy && (
        <Notice tone="info" title={`Superseded by ${job.supersededBy.ref}`} className="mb-6">
          <span data-testid="superseded-note">{job.supersededBy.reason}. Marked {fmtRelative(job.supersededBy.at)} by {job.supersededBy.by}. The history and worktrees are kept; this job can no longer be resumed or applied.</span>
          <div className="mt-3"><Button variant="outline" disabled={!!busy} onClick={() => act("unsupersede", () => codingClient.unsupersede(job.id), "Took the superseded mark back.")}>Unmark superseded</Button></div>
        </Notice>
      )}
      <JobGlance glance={glance} state={job.state} choices={options ? options.options : glance.moveRole ? null : []} choiceKey={chosen?.key ?? null} onChoice={setChoiceKey} nextLabel={resumeText} onNext={doResume} busy={!!busy} resumable={resumable} />
      <SupersedeControl view={view} busy={!!busy} onSupersede={supersede} />

      <CodingWorkspace view={view} events={events} actions={<span className="hidden flex-wrap gap-2 lg:contents">{actions}</span>} onOpenTab={(t) => { setDetailsOpen(true); setTab(t); }}>
        <JobSummary bare view={view} onOpenTab={(t) => { setDetailsOpen(true); setTab(t); }} />
      </CodingWorkspace>

      {/* The job's lane: draft → plan → builder → tests → independent review → merge approval (W-B). */}
      <section className="mb-6 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-label="Where this job is">
        <PipelineLane steps={pipelineFor(job)} ariaLabel="This job's pipeline" />
      </section>

      {pendingInputs.map((run) => (
        <Surface key={run.id} className="mb-4 flex flex-col gap-2 rounded-2xl border-warn p-5" role="region" aria-label={`${run.roleId} needs you`}>
          <div className="flex flex-wrap items-center gap-2"><Badge tone="warn">{run.roleId} needs you</Badge><span className="text-sm font-medium">{run.pendingInput!.title}</span></div>
          <p className="text-xs text-muted-foreground">Why you're asked: {run.pendingInput!.escalatedBecause}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-2 text-xs">{run.pendingInput!.detail}</pre>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy} onClick={() => act("approve", () => codingClient.input(job.id, run.roleId, run.pendingInput!.id, "approve"))}>Allow once</Button>
            <Button variant="outline" disabled={!!busy} onClick={() => act("deny", () => codingClient.input(job.id, run.roleId, run.pendingInput!.id, "deny"))}>Deny</Button>
          </div>
        </Surface>
      ))}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Disclosure summary={<span className="font-medium">Details: events, prompts and diagnostics</span>} meta={TABS.find((t) => t.value === current)?.label} open={detailsOpen} onOpenChange={setDetailsOpen}>
          <Segmented value={current} options={TABS} onChange={setTab} ariaLabel="Coding job sections" className="mb-4 max-w-full overflow-x-auto" />
          {current === "progress" && <Progress events={events} />}
          {current === "plan" && <Plan view={view} />}
          {current === "changes" && <Changes view={view} />}
          {current === "tests" && <Tests view={view} onRerun={(id) => act("rerun", () => codingClient.rerun(job.id, id), "Re-ran it at the same commit.")} busy={!!busy} />}
          {current === "review" && <Review view={view} />}
          {current === "usage" && <Usage view={view} />}
          {current === "handoff" && <HandoffView view={view} events={events} />}
          </Disclosure>
        </div>
        <aside className="flex min-w-0 flex-col gap-4" aria-label="Agents and approvals">
          <Agents view={view} />
          <Approvals view={view} onMerge={(toRef) => act("merge", () => codingClient.apply(job.id, "git.merge.protected", toRef), "Asked once. Approve it with your spoken yes to Jarvis or the code sent to your Telegram; a click can't approve an agent job's merge.")} busy={!!busy} />
        </aside>
      </div>

      {/* Phone: a sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap justify-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur lg:hidden">{actions}</div>
    </div>
  );
}

export function Progress({ events }: { events: CodingEvent[] }) {
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("milestones");
  const history = useMemo(() => codingActivity(events, filter), [events, filter]);
  const shown = showAll ? history : history.slice(0, 20);
  return (
    <section aria-label="Progress timeline">
      <Segmented ariaLabel="Activity detail" value={filter} options={ACTIVITY_FILTERS} onChange={(value) => { setFilter(value); setShowAll(false); }} className="mb-3 max-w-full overflow-x-auto" />
      <p className="mb-3 text-sm text-muted-foreground" role="status">Newest first · showing {shown.length} of {history.length} matching loaded events</p>
      {!history.length && <EmptyState title={events.length ? "No matching updates" : "No progress yet"} body={events.length ? "Choose All activity to see other recorded events." : "Updates appear here as the job runs."} />}
      <ol className="flex flex-col gap-1.5">
        {shown.map((e) => (
          <li key={e.seq} className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-sm odd:bg-inset/60 sm:flex-row sm:gap-3">
            <span className="shrink-0 text-xs text-muted-foreground sm:w-20">{fmtTime(new Date(e.at), { seconds: true })}<span className="sm:hidden"> · {e.roleId ?? "orchestrator"}</span></span>
            <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground sm:inline">{e.roleId ?? "orchestrator"}</span>
            <span className="min-w-0 flex-1">{describe(e)}</span>
          </li>
        ))}
      </ol>
      {history.length > 20 && (
        <Button variant="outline" className="mt-4" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show recent updates" : `Show all ${history.length} updates`}
        </Button>
      )}
    </section>
  );
}

function describe(e: CodingEvent): string {
  const p = e.payload as any;
  switch (e.type) {
    case "plan": return `Plan revision ${p.revision}: ${p.summary}`;
    case "test": return `Test result recorded. Open Tests for the command and result.`;
    case "review": return "Review recorded. Open Review for the findings.";
    case "approval_resolved": return `Approval ${String(p.state).replace(/_/g, " ")}`;
    case "state": return p.scope === "job" ? `Job moved to ${String(p.to).replace(/_/g, " ")}` : `Agent is ${runStateLabel(String(p.to)).label.toLowerCase()}${p.reason ? ` (${String(p.reason).replace(/_/g, " ")})` : ""}`;
    case "step": return p.detail ? `${p.label} — ${p.detail}` : p.label;
    case "spoken": return `Jarvis: “${p.line}”`;
    case "policy": return `Policy ${p.decision === "auto-allow" ? "allowed" : p.decision === "auto-deny" ? "refused" : "asked you about"} ${p.nativeKind} (${String(p.rule).replace(/-/g, " ")}): ${p.target}`;
    case "input_request": return `Asked you: ${p.title}`;
    case "input_resolved": return `Your answer: ${p.decision}`;
    case "error": return `Problem (${p.code}): ${p.message}`;
    case "recovery": return `Restart recovery: ${p.interruptedRuns.length} agent(s) interrupted, nothing replayed`;
    case "gate": return `Done gate ${p.passed ? "passed" : "failed"} for ${String(p.sha).slice(0, 7)}`;
    case "approval_request": return `Approval asked once: ${p.summary}`;
    case "apply": return `Apply step ${p.state}${p.verification ? `, verified by ${p.verification.method} (${String(p.verification.observed).slice(0, 7)})` : ""}`;
    case "handoff": return `Handoff written; memory ${String(p.memory).replace(/-/g, " ")}`;
    case "text": return p.final ? `Agent summary: ${String(p.text).slice(0, 400)}` : `Agent says: ${String(p.text).slice(-200)}`;
    default: return e.type;
  }
}

function Plan({ view }: { view: JobView }) {
  const s = view.job.spec;
  const evidence = new Map((view.job.gate?.checks ?? []).map((c) => [c.check, c]));
  const done = evidence.get("done-when-evidenced");
  return (
    <div className="flex flex-col gap-4">
      <Surface padding="md">
        <p className="text-xs text-muted-foreground">Plan revision {s.revision} · {s.confirmation.state === "confirmed" ? `confirmed by ${s.confirmation.by.personId} (${s.confirmation.via}) ${fmtRelative(s.confirmation.at)}` : "not confirmed yet"}. Read-only after confirmation.</p>
        <h2 className="mt-2 text-sm font-semibold">Done when</h2>
        <ul className="mt-1 flex flex-col gap-1 text-sm">
          {s.doneWhen.map((d) => {
            const met = done ? !done.detail.includes(d.id) && done.passed : null;
            return (
              <li key={d.id} className="flex items-start gap-2">
                {met === null ? <CircleSlash className="mt-0.5 h-4 w-4 text-muted-foreground" aria-label="not checked yet" /> : met ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" aria-label="evidenced" /> : <XCircle className="mt-0.5 h-4 w-4 text-danger" aria-label="no evidence" />}
                <span>{d.text} <span className="text-xs text-muted-foreground">({d.evidence}{d.ref ? `: ${d.ref}` : ""})</span></span>
              </li>
            );
          })}
        </ul>
        {s.nonGoals.length > 0 && (<><h2 className="mt-3 text-sm font-semibold">Not doing</h2><ul className="list-disc pl-5 text-sm">{s.nonGoals.map((n) => <li key={n}>{n}</li>)}</ul></>)}
        <h2 className="mt-3 text-sm font-semibold">Checks (run by the orchestrator)</h2>
        <p className="text-sm">{s.checks.join(", ") || "none"} · baseline on the base commit: {s.baselineChecks.join(", ") || "none"}</p>
        <h2 className="mt-3 text-sm font-semibold">Approval points</h2>
        <p className="text-sm">{s.approvalPoints.length ? s.approvalPoints.map((a) => a.describe).join("; ") : "None planned. Merge and deploy are only ever offered after completion, behind your approval."}</p>
      </Surface>
      {s.jev && (
        <Surface padding="md">
          <h2 className="text-sm font-semibold">How the request was shaped</h2>
          <ul className="mt-1 text-sm">{s.jev.decisions.map((d, i) => <li key={i}>{d.question}: {d.choice ?? "—"} ({Math.round(d.confidence * 100)}%, {d.policy})</li>)}</ul>
          {s.jev.clarifications.map((c, i) => <p key={i} className="text-sm">Asked “{c.question}”, answered “{c.answer}”.</p>)}
        </Surface>
      )}
    </div>
  );
}

function Changes({ view }: { view: JobView }) {
  const d = view.job.diff;
  const [patch, setPatch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!d) return;
    codingClient.artefact(view.job.id, d.patch).then(setPatch).catch((e) => setErr((e as Error).message));
  }, [d, view.job.id]);
  if (!d) return <EmptyState title="No changes yet" body="The diff appears when the builders' branches are integrated." />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{d.files.length} file(s) changed between {d.baseSha.slice(0, 7)} and {d.headSha.slice(0, 7)}.</p>
      <ul className="flex flex-col gap-1" aria-label="Changed files">
        {d.files.map((f) => (
          <li key={f.path} className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={f.status === "added" ? "success" : f.status === "deleted" ? "danger" : "neutral"}>{f.status}</Badge>
            <code className="min-w-0 break-all">{f.path}</code>
            <span className="text-xs text-muted-foreground">+{f.additions} −{f.deletions}</span>
            {f.ownedBy ? <Badge tone="info">owned by {f.ownedBy}</Badge> : <Badge tone="danger">outside ownership</Badge>}
            {f.eolOnly && <Badge tone="warn">line endings only</Badge>}
          </li>
        ))}
      </ul>
      {err && <Notice tone="danger">{err}</Notice>}
      {patch !== null && <DiffBlock patch={patch} />}
    </div>
  );
}

function DiffBlock({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split("\n").slice(0, 4000), [patch]);
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-xl border border-border bg-inset p-3 text-xs leading-relaxed" aria-label="Unified diff" tabIndex={0}>
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "bg-success-soft" : l.startsWith("-") && !l.startsWith("---") ? "bg-danger-soft" : l.startsWith("@@") ? "text-info" : ""}>{l || " "}</div>
      ))}
    </pre>
  );
}

function Tests({ view, onRerun, busy }: { view: JobView; onRerun: (id: string) => void; busy: boolean }) {
  const job = view.job;
  const [open, setOpen] = useState<string | null>(null);
  const [out, setOut] = useState<string>("");
  if (!job.tests.length) return <EmptyState title="Tests not run yet" body="Only the orchestrator's own runs are shown here; an agent saying tests passed is never shown as a pass." />;
  const summary = testsSummary(job);
  return (
    <div className="flex flex-col gap-3">
      <Badge tone={summary.tone}>{summary.text} (orchestrator's run)</Badge>
      <ul className="flex flex-col gap-2">
        {[...job.tests].reverse().map((t, i) => (
          <li key={`${t.commandId}-${t.sha}-${i}`}>
            <Surface padding="sm" className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={t.exitCode === 0 ? "success" : "danger"}>{t.exitCode === 0 ? "Passed" : t.timedOut ? "Timed out" : `Exit ${t.exitCode ?? "none"}`}</Badge>
                <span className="text-sm font-medium">{t.commandId}</span>
                <span className="text-xs text-muted-foreground">{t.sha === job.spec.repo.baseSha ? "baseline (base commit)" : `at ${t.sha.slice(0, 7)}`} · {(t.durationMs / 1000).toFixed(1)} s</span>
              </div>
              <code className="break-all text-xs text-muted-foreground">{t.argv.join(" ")}</code>
              <p className="text-sm">{t.counts.passed ?? "unknown"} passed · {t.counts.failed ?? "unknown"} failed{t.counts.skipped !== null ? ` · ${t.counts.skipped} skipped` : ""}</p>
              {t.exitCode !== 0 && <FailedTests failures={t.failures} names={t.failedTests} total={t.counts.failed} />}
              {t.baseline && <p className="text-xs text-muted-foreground">Baseline on {t.baseline.sha.slice(0, 7)}: exit {t.baseline.exitCode ?? "none"}, {t.baseline.failed ?? "unknown"} failed.</p>}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={async () => { const k = `${t.output}`; if (open === k) return setOpen(null); setOpen(k); setOut(await codingClient.artefact(job.id, t.output).catch((e) => (e as Error).message)); }}>{open === t.output ? "Hide the full output" : "Show the full output"}</Button>
                {t.sha === job.headSha && <Button variant="outline" size="sm" disabled={busy} onClick={() => onRerun(t.commandId)}>Run again</Button>}
              </div>
              {open === t.output && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-2 text-xs" tabIndex={0}>{out.slice(-20_000)}</pre>}
            </Surface>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Review({ view }: { view: JobView }) {
  const r = view.job.review;
  if (!r) return <EmptyState title="No review yet" body="An independent read-only reviewer checks the exact integrated commit." />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={r.verdict === "approve" ? "success" : r.verdict === "request-changes" ? "danger" : "warn"}>{r.verdict === "approve" ? "Approved" : r.verdict === "request-changes" ? "Changes requested" : "Couldn't assess"}</Badge>
        <span className="text-sm">for {r.sha.slice(0, 7)} by {r.reviewerRoleId} ({modelLabel(r.binding)})</span>
        {view.job.headSha && r.sha !== view.job.headSha && <Badge tone="warn">not the current head</Badge>}
      </div>
      {r.findings.length === 0 ? <p className="text-sm text-muted-foreground">No findings.</p> : (
        <ul className="flex flex-col gap-1.5">
          {r.findings.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-2 text-sm">
              <Badge tone={f.severity === "blocker" ? "danger" : f.severity === "major" ? "warn" : "neutral"}>{f.severity}</Badge>
              <span className="min-w-0 flex-1">{f.file ? <code className="mr-1 break-all">{f.file}{f.line ? `:${f.line}` : ""}</code> : null}{f.message}</span>
              <span className="text-xs text-muted-foreground">{f.status.replace(/-/g, " ")}</span>
            </li>
          ))}
        </ul>
      )}
      {r.criteria.length > 0 && (
        <ul className="text-sm">{r.criteria.map((c) => <li key={c.criterionId}>{c.met ? "✓" : "✗"} {c.criterionId}: {c.note}</li>)}</ul>
      )}
    </div>
  );
}

function Usage({ view }: { view: JobView }) {
  if (!view.receipts.length) return <EmptyState title="No agent turns yet" body="One receipt per role turn: the account and model that actually ran." />;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "unknown" : fmtCount(v));
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Usage receipts (scrolls sideways on small screens)">
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">Usage receipts per role turn</caption>
        <thead className="text-xs text-muted-foreground"><tr><th className="py-1 pr-3 font-medium">Role</th><th className="pr-3 font-medium">Model that ran</th><th className="pr-3 font-medium">Account</th><th className="pr-3 font-medium">Outcome</th><th className="pr-3 font-medium">Tokens in / out</th><th className="pr-3 font-medium">Window start → end</th><th className="font-medium">Cost</th></tr></thead>
        <tbody>
          {view.receipts.map((r) => (
            <tr key={r.requestId} className="border-t border-border align-top">
              <td className="py-1.5 pr-3">{r.coding.roleId} (turn {r.coding.turn})</td>
              <td className="pr-3">{r.model}{r.fallbackFrom ? <span className="block text-xs text-warn">fallback from {r.fallbackFrom}</span> : null}{r.providerModel && r.providerModel !== r.model ? <span className="block text-xs text-muted-foreground">provider said {r.providerModel}</span> : null}</td>
              <td className="pr-3">{r.account}</td>
              <td className="pr-3">{r.outcome.replace(/_/g, " ")}</td>
              <td className="pr-3">{n(r.usage.inputTokens)} / {n(r.usage.outputTokens)}</td>
              <td className="pr-3">{r.allowance ? `${r.allowance.usedPercentAtLastRead ?? "unknown"}% → ${r.allowance.usedPercentAtEnd ?? "unknown"}%` : "n/a"}{r.credits ? <span className="block text-xs">credits {r.credits.before ?? "?"} → {r.credits.after ?? "?"} ({r.credits.scope})</span> : null}</td>
              <td>{r.cost.basis === "subscription_allowance" ? <span className="text-muted-foreground">plan allowance{r.valueUsdEquivalent !== null ? ` (API-equivalent value US$${r.valueUsdEquivalent.toFixed(4)})` : ""}</span> : r.cost.usd !== null ? `US$${r.cost.usd.toFixed(4)} (${r.cost.basis.replace(/_/g, " ")})` : `unknown (${r.cost.basis.replace(/_/g, " ")})`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Agents({ view }: { view: JobView }) {
  const job = view.job;
  return (
    <Section title="Agents" headingLevel={2} className="mb-0">
      <ul className="flex flex-col gap-2">
        {job.spec.roles.map((role) => {
          const run = [...job.runs].reverse().find((r) => r.roleId === role.roleId);
          const s = run ? runStateLabel(run.state) : { label: role.agent ? "Not started" : "Orchestrator step", tone: "neutral" as const };
          const lastStep = [...view.events].reverse().find((e) => e.roleId === role.roleId && e.type === "step");
          return (
            <li key={role.roleId}>
              <Surface padding="sm" className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{role.roleId}</span>
                  <StatusDot tone={s.tone} pulse={run?.state === "running"} label={s.label} />
                </div>
                <p className="text-xs text-muted-foreground">{modelLabel(run?.binding ?? role.agent)}{(run?.binding ?? role.agent) ? ` · ${(run?.binding ?? role.agent)!.accountSlot}` : ""}{run && run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}</p>
                {lastStep && run?.state === "running" && <p className="text-xs">Now: {(lastStep.payload as { label: string }).label}</p>}
                {run?.error && <p className="text-xs text-danger">{run.error.message}</p>}
                <details className="mt-2"><summary className="cursor-pointer text-sm text-muted-foreground">Agent details</summary>
                  {role.owns.globs.length + role.owns.newFiles.length > 0 && <p className="mt-2 text-sm">Owns: <code className="break-all">{[...role.owns.globs, ...role.owns.newFiles].join(", ")}</code></p>}
                  <p className="mt-2 text-sm">{role.access === "read-only" ? "Read-only" : "Can edit its assigned files"}</p>
                  {run?.nativeSessionId && <p className="mt-2 text-sm text-muted-foreground">Session {run.nativeSessionId.slice(0, 8)}…{run.binding.route === "claude-code-cli" ? " (claude --resume)" : run.binding.route === "codex-app-server" ? " (Codex thread)" : ""}</p>}
                </details>
              </Surface>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Approvals({ view, onMerge, busy }: { view: JobView; onMerge: (toRef: string) => void; busy: boolean }) {
  const job = view.job;
  const [toRef, setToRef] = useState("main");
  return (
    <Section title="Approvals" headingLevel={2} className="mb-0">
      {view.approvals.length === 0 && <p className="text-sm text-muted-foreground">Nothing asked. Merging and pushing are never agent actions.</p>}
      <ul className="flex flex-col gap-2">
        {view.approvals.map((a) => (
          <li key={a.approvalId}>
            <Surface padding="sm" className="flex flex-col gap-1">
              <Badge tone={a.applyState === "succeeded" ? "success" : a.applyState === "failed" ? "danger" : a.state === "pending" ? "warn" : "neutral"}>
                {a.applyState === "succeeded" ? "Done and verified" : a.state === "pending" ? "Waiting for your approval" : a.applyState === "running" ? "Applying" : `${a.state}`}
              </Badge>
              <p className="text-sm">{a.summary}</p>
              {a.state === "pending" && <p className="text-xs text-muted-foreground">Answer with your spoken yes to Jarvis, or the code sent to your Telegram. Expires {fmtRelative(a.expiresAt)}.</p>}
              {a.verification && <p className="text-xs">Verified by {a.verification.method}: {a.verification.observed.slice(0, 12)}</p>}
            </Surface>
          </li>
        ))}
      </ul>
      {job.state === "completed" && job.gate?.passed && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); onMerge(toRef); }}>
          <label className="flex flex-col text-xs text-muted-foreground">Merge into
            <input value={toRef} onChange={(e) => setToRef(e.target.value)} className="mt-1 w-32 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <Button type="submit" variant="outline" disabled={busy}>Ask to merge</Button>
        </form>
      )}
    </Section>
  );
}

function HandoffView({ view, events }: { view: JobView; events: CodingEvent[] }) {
  const h = view.handoff;
  const ev = [...events].reverse().find((e) => e.type === "handoff");
  if (!h && !ev) return <EmptyState title="No handoff yet" body="Written when the job ends, honestly: done, needs you, failed or interrupted." />;
  const memory = (ev?.payload as { memory?: string } | undefined)?.memory;
  return (
    <Surface padding="md" className="flex flex-col gap-2 text-sm">
      {h && <p>Outcome: <strong>{h.outcome.replace(/-/g, " ")}</strong>. Branch {h.jobBranch}{h.headSha ? ` @ ${h.headSha.slice(0, 7)}` : ""}. Nothing is merged or deployed.</p>}
      {h?.notDone.length ? <Notice tone="warn" title="Not done">{h.notDone.join("; ")}</Notice> : null}
      {h?.followUps.length ? <><h2 className="font-semibold">Follow-ups</h2><ul className="list-disc pl-5">{h.followUps.map((f) => <li key={f}>{f}</li>)}</ul></> : null}
      <p>Work: <Link className="underline underline-offset-4" to="/coding">Coding jobs for {view.job.spec.repo.repoId}</Link></p>
      <p>Memory: {memory === "saved" ? (h?.links.memory ? <>saved to the vault ({h.links.memory.note_id})</> : "saved to the vault") : memory === "skipped-writes-off" ? "not saved (memory writes are off)" : memory === "failed" ? "the vault save failed" : "unknown"}</p>
    </Surface>
  );
}

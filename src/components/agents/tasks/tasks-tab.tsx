// The Tasks & Files tab: what this bot is doing and did (task, what actually ran it, progress, review and tests, blocker, result), and the
// results it saved. Stop and Resume call the existing job APIs and show the server's answer; "Open result" opens the real saved page.
import { decidedByView, type DecidedByInput } from "@/lib/commands/decided-by";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Badge, Button, EmptyState, Notice, fmtRelative } from "@/components/ds";
import { cancelComputerJob } from "@/lib/agent-workspace";
import { codingClient, elapsed } from "@/lib/coding-client";
import type { Bot } from "../workspace/bots";
import type { WorkspaceTab } from "../workspace/bots";
import { fileHref, fmtBytes, resultButtonText, taskIsOpen, type BlockerAction, type BotTask, type SavedFile } from "./tasks";
import { useBotTasks } from "./use-bot-tasks";
import type { ComputerView } from "@/lib/computers-client";

/** An in-app link that is a real anchor (open in a new tab, copy the address) and navigates without a reload. */
function AppLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const router = useRouter();
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void router.navigate({ href });
  };
  return <a href={href} onClick={go} className={className ?? "underline underline-offset-2 hover:text-foreground"}>{children}</a>;
}

const FACT = "grid gap-x-4 gap-y-0.5 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={FACT}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[15px] leading-relaxed">{children}</dd>
    </div>
  );
}

/** A saved result's summary as plain sentences: the markdown bullets and heading marks it was written with are dropped. */
export const plainSummary = (text: string) => text.replace(/^[ \t>*#-]+/gm, "").replace(/\s*\n+\s*/g, ". ").replace(/\.\s*\./g, ".").replace(/\*\*|__|`/g, "").trim();

/** What "Ran on" says. A task that has not started has not run on anything yet: it says what it is set to use, else that it is chosen at start. */
export function ranText(t: Pick<BotTask, "notStarted" | "ran">): string {
  if (!t.notStarted || t.ran.used) return t.ran.text;
  const set = t.ran.text.replace(/^Nothing has run yet\.\s*/, "");
  return !set || /^No model or account was recorded/.test(set) ? "Chosen when you start it." : set;
}

/** Who decided this task's route (Jev / Rule / Fallback / ...), from the decision record when the task carries one; never guessed. */
export function decidedByText(task: Pick<BotTask, "id" | "kind"> & { decision?: DecidedByInput | null }): string | null {
  if (!task.decision) return null;
  const v = decidedByView(task.decision);
  return `${v.label} · ${v.detail}`;
}

export function timeLine(t: Pick<BotTask, "startedAt" | "endedAt"> & { notStarted?: boolean }): string {
  if (t.notStarted) return t.startedAt ? `Drafted ${fmtRelative(t.startedAt)} · waiting for you to start it` : "Waiting for you to start it";
  if (!t.startedAt) return "Start time not reported";
  const started = `Started ${fmtRelative(t.startedAt)}`;
  return t.endedAt ? `${started} · took ${elapsed(t.startedAt, t.endedAt)}` : `${started} · still going`;
}

export function TaskRow({ task, onTab, onChanged }: { task: BotTask; onTab: (t: WorkspaceTab) => void; onChanged: () => void }) {
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null);
  const run = async (what: "stop" | "resume", accept = false) => {
    if (busy) return;
    setBusy(true);
    try {
      if (what === "stop") {
        if (task.kind === "coding") {
          await codingClient.cancel(task.id);
          setAnswer({ ok: true, message: task.notStarted ? "Discarded. Nothing had run." : "Stopped. The working copies are kept." });
        } else setAnswer(await cancelComputerJob(task.id));
      } else {
        await codingClient.resume(task.id, accept ? { acceptCheckoutChange: true } : {});
        setAnswer({ ok: true, message: "Continuing from the step that needs work." });
      }
    } catch (e) {
      // The server's own refusal, as it said it.
      setAnswer({ ok: false, message: e instanceof Error ? e.message : "That didn't work." });
    }
    setBusy(false);
    onChanged();
  };
  const act = (a: BlockerAction) => {
    if (a.kind === "resume") void run("resume", a.accept === true);
    else if (a.kind === "tab") onTab(a.tab);
  };
  return (
    <li className="flex flex-col gap-2 py-4" data-task={task.id} data-task-state={task.state} data-task-kind={task.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="min-w-0 flex-1 basis-full text-base font-medium leading-snug sm:basis-0">{task.title}</h4>
        <Badge tone={task.tone}>{task.stateWord}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{timeLine(task)}</p>
      {task.blocker && (
        <Notice tone={task.state === "failed" ? "danger" : "warn"} className="!px-4 !py-3" action={task.blocker.action && task.blocker.action.kind !== "link" ? <Button variant="accent" size="sm" disabled={busy} onClick={() => act(task.blocker!.action!)} {...(task.blocker.action.kind === "resume" && task.blocker.action.detail ? { title: `Accepts: ${task.blocker.action.detail}`, "aria-label": `${task.blocker.action.label}. Accepts: ${task.blocker.action.detail}` } : {})}>{task.blocker.action.label}</Button> : task.blocker.action ? <Button asChild variant="outline" size="sm"><AppLink href={task.blocker.action.href} className="no-underline">{task.blocker.action.label}</AppLink></Button> : undefined}>
          <span data-blocker="true">{task.blocker.text}</span>
        </Notice>
      )}
      <dl className="divide-y divide-border">
        <Fact label={task.notStarted ? "Will run on" : "Ran on"}><span data-ran={task.ran.used ? "used" : "none"}>{ranText(task)}</span></Fact>
        {decidedByText(task) && <Fact label="Decided by">{decidedByText(task)}</Fact>}
        {task.progress && <Fact label="Progress">{task.progress}</Fact>}
        {task.review && <Fact label="Review">{task.review}</Fact>}
        {task.tests && <Fact label="Tests">{task.tests}</Fact>}
        {task.outcomeNote && <Fact label="Result">{task.outcomeNote}</Fact>}
      </dl>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Actions for ${task.title}`}>
        {task.result && (task.result.external ? (
          <Button asChild variant="accent" size="sm"><a href={task.result.href} target="_blank" rel="noopener noreferrer">{resultButtonText(task.result.label)}</a></Button>
        ) : (
          <Button asChild variant="accent" size="sm"><AppLink href={task.result.href} className="no-underline">{task.result.label}</AppLink></Button>
        ))}
        {task.can.resume && task.blocker?.action?.kind !== "resume" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("resume")}>Resume</Button>}
        {task.can.cancel && !confirmStop && <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmStop(true)}>{task.notStarted ? "Discard" : "Stop"}</Button>}
        {task.can.cancel && confirmStop && (
          <span role="group" aria-label="Confirm stop" className="inline-flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Escape") setConfirmStop(false); }}>
            <span className="text-sm text-muted-foreground">{task.notStarted ? "Discard this draft? Nothing has run, so nothing is lost." : task.kind === "coding" ? "Stop every agent on this job? It can't be resumed; the working copies are kept." : "Stop this task? The steps that haven't run are skipped."}</span>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => { setConfirmStop(false); void run("stop"); }}>{task.notStarted ? "Yes, discard it" : "Yes, stop it"}</Button>
            <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirmStop(false)}>Keep it</Button>
          </span>
        )}
        {task.links.map((l) => <AppLink key={l.href} href={l.href} className="text-sm underline underline-offset-2 hover:text-foreground">{l.label}</AppLink>)}
        {task.jobHref && !task.links.length && task.blocker?.action?.kind !== "link" && <AppLink href={task.jobHref.href} className="ml-auto text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">{task.jobHref.label}</AppLink>}
      </div>
      {answer && <p role="status" className="text-sm text-muted-foreground" data-testid="task-answer">{answer.ok ? answer.message : `Didn't work: ${answer.message}`}</p>}
    </li>
  );
}

/** A coding job's output: the branch, the commit, the files it changed and where to read them. No download: the files live on the branch, not in a saved copy. */
function CodingFileRow({ f, coding }: { f: SavedFile; coding: NonNullable<SavedFile["coding"]> }) {
  const job = `/coding/${coding.jobId}`;
  return (
    <li className="flex flex-col gap-1.5 py-3" data-file={f.id} data-file-source="coding">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="min-w-0 flex-1 basis-full text-base font-medium leading-snug sm:basis-0">{f.title}</h4>
        <Button asChild variant="outline" size="sm"><AppLink href={`${job}?tab=changes`} className="no-underline">Open the changes</AppLink></Button>
      </div>
      <p className="text-sm text-muted-foreground">{[f.createdAt ? `Saved ${fmtRelative(f.createdAt)}` : null, coding.branch ? `Branch ${coding.branch}` : null, coding.commit ? `commit ${coding.commit.slice(0, 7)}` : null].filter(Boolean).join(" · ")}</p>
      {(coding.tests || coding.review) && <p className="text-[15px]">{[coding.tests ? `Tests: ${coding.tests}` : null, coding.review ? `Review: ${coding.review}` : null].filter(Boolean).join(" · ")}</p>}
      {coding.files.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {coding.files.map((x) => <li key={x.name}><AppLink href={`${job}?tab=changes`} className="underline underline-offset-2">{x.name}</AppLink>{x.status ? <span className="text-muted-foreground"> {x.status}</span> : null}</li>)}
        </ul>
      )}
    </li>
  );
}

export function FileRow({ f }: { f: SavedFile }) {
  if (f.coding) return <CodingFileRow f={f} coding={f.coding} />;
  return (
    <li className="flex flex-col gap-1.5 py-3" data-file={f.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="min-w-0 flex-1 basis-full text-base font-medium leading-snug sm:basis-0">{f.title}</h4>
        <Button asChild variant="outline" size="sm"><a href={fileHref(f.id)} target="_blank" rel="noopener noreferrer">Open</a></Button>
      </div>
      <p className="text-sm text-muted-foreground">{[f.createdAt ? `Saved ${fmtRelative(f.createdAt)}` : null, f.host || null, f.outcome || null].filter(Boolean).join(" · ")}</p>
      {f.summary && <p className="text-[15px]">{plainSummary(f.summary)}</p>}
      {f.files.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {f.files.map((x) => (
            <li key={x.name}>
              <a className="underline underline-offset-2" href={fileHref(f.id, x.name)} target="_blank" rel="noopener noreferrer">{x.name}</a>
              <span className="text-muted-foreground"> {fmtBytes(x.bytes)} · </span>
              <a className="underline underline-offset-2" href={fileHref(f.id, x.name, true)} download={x.name}>Download</a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const PAST_SHOWN = 6;

export function TasksTab({ bot, computer, onTab }: { bot: Bot; computer: ComputerView | null; onTab: (t: WorkspaceTab) => void }) {
  const client = useQueryClient();
  const work = useBotTasks(bot, computer);
  const [allPast, setAllPast] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["agent-tasks"] });
    void client.invalidateQueries({ queryKey: ["agent-jobs"] });
    void client.invalidateQueries({ queryKey: ["agent-coding"] });
    void client.invalidateQueries({ queryKey: ["agent-job-detail"] });
    void client.invalidateQueries({ queryKey: ["agent-coding-view"] });
    void client.invalidateQueries({ queryKey: ["computers"] });
  };
  if (work.status === "loading") return <p className="text-sm text-muted-foreground" role="status" aria-busy="true">Reading {bot.name}'s tasks…</p>;
  if (work.status === "error") return <Notice tone="warn" title="Couldn't read the tasks">{work.reason}</Notice>;
  const current = work.tasks.filter(taskIsOpen);
  const past = work.tasks.filter((t) => !taskIsOpen(t));
  const shownPast = allPast ? past : past.slice(0, PAST_SHOWN);
  return (
    <div className="flex flex-col gap-8" data-tasks-tab={bot.id} data-source={work.source}>
      {work.notice && <Notice tone="warn" title="Part of the list is missing">{work.notice}</Notice>}
      <section aria-labelledby="tasks-current" className="flex flex-col">
        <h3 id="tasks-current" className="text-lg font-medium">Current</h3>
        {current.length ? (
          <ul className="divide-y divide-border" data-list="current">{current.map((t) => <TaskRow key={t.id} task={t} onTab={onTab} onChanged={refresh} />)}</ul>
        ) : (
          <EmptyState variant="row" title="Nothing is running" body={`Ask ${bot.name} for something in Chat and it shows up here with its progress.`} className="mt-3" />
        )}
      </section>
      <section aria-labelledby="tasks-past" className="flex flex-col">
        <h3 id="tasks-past" className="text-lg font-medium">Past work</h3>
        {past.length ? (
          <>
            <ul className="divide-y divide-border" data-list="past">{shownPast.map((t) => <TaskRow key={t.id} task={t} onTab={onTab} onChanged={refresh} />)}</ul>
            {past.length > PAST_SHOWN && (
              <div className="pt-2"><Button variant="ghost" size="sm" onClick={() => setAllPast((v) => !v)}>{allPast ? "Show fewer" : `Show all ${past.length}`}</Button></div>
            )}
          </>
        ) : (
          <p className="pt-2 text-[15px] text-muted-foreground">{work.files.length ? "No finished tasks are listed here; the saved results below are what they produced." : "Nothing has finished since this hub started recording."}</p>
        )}
      </section>
      <section aria-labelledby="tasks-files" className="flex flex-col">
        <h3 id="tasks-files" className="text-lg font-medium">Saved results</h3>
        <p className="text-sm text-muted-foreground">The hub keeps its own copy, so these open even when the computer is off.</p>
        {work.files.length ? (
          <ul className="divide-y divide-border" data-list="files">{work.files.map((f) => <FileRow key={f.id} f={f} />)}</ul>
        ) : (
          <p className="pt-2 text-[15px] text-muted-foreground">No saved results yet. A finished piece of work that produces a report or files appears here.</p>
        )}
      </section>
    </div>
  );
}


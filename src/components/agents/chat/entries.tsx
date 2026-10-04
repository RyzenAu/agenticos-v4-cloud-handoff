// How each kind of entry in a bot conversation looks. Calm and glanceable: the person's request, one concise acknowledgement, ONE card per job
// (state word, what it is doing now, steps folded away, an action when it needs you, the result with its files), nothing decorative.
import type { MouseEvent, ReactNode } from "react";
import { ArrowUpRight, Mic, Monitor, RotateCcw, Square } from "lucide-react";
import { Button, Disclosure, Notice, Surface, TaskWord, type TaskPhaseName } from "@/components/ds";
import { cn } from "@/lib/utils";
import type { Item, RecoveryAction, Run, RunStatus } from "./chat-state";
import { recoveryFor, recoveryOfBlocker, type Recovery } from "./chat-state";

/** Where the buttons go. The workspace shell overrides these when its routes exist; the defaults are the routes that exist today. */
export type ChatLinks = {
  /** The real saved artifact of a finished job, or the coding job itself. */
  result(jobId: string, jobKind: "job" | "coding"): string;
  job(jobId: string, jobKind: "job" | "coding"): string;
  /** The bot's live computer, or null when it has none (the button is then not shown). */
  computer(): string | null;
};
export const defaultLinks = (computerHref: string | null = "/computers"): ChatLinks => ({
  result: (jobId, kind) => (kind === "coding" ? `/coding/${jobId}` : `/__computers/artifacts/${jobId}`),
  job: (jobId, kind) => (kind === "coding" ? `/coding/${jobId}` : `/activity#job-${jobId}`),
  computer: () => computerHref,
});

const PHASE: Record<RunStatus, { phase: TaskPhaseName; word?: string }> = {
  running: { phase: "running", word: "Working" },
  blocked: { phase: "waiting" },
  done: { phase: "done" },
  failed: { phase: "failed" },
  stopped: { phase: "queued", word: "Stopped" },
  unclear: { phase: "waiting", word: "Outcome unclear" },
};
export const statusWord = (s: RunStatus) => PHASE[s].word ?? { running: "Running", blocked: "Needs you", done: "Done", failed: "Failed", stopped: "Stopped", unclear: "Outcome unclear" }[s];

/** The text of a result without its machine line ("Saved result: ... (job abcd1234)"). */
export const resultText = (text: string) => text.replace(/\n?Saved result: [^\n]+\n\(job [0-9a-f]{8}\)\s*$/, "").trim();

const SUMMARY_CHARS = 360;

/** Links open in place for a plain click when the shell gave us a navigator; otherwise the browser follows the href. */
function Link({ href, onNavigate, newTab, children, className }: { href: string; onNavigate?: (href: string) => void; newTab?: boolean; children: ReactNode; className?: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || newTab || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(href);
  };
  return (
    <a
      href={href}
      onClick={click}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn("ds-interactive inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-foreground hover:bg-surface-raised", className)}
    >
      {children}
    </a>
  );
}

const STATE_OF = (s: string) => s.toLowerCase().replace(/_/g, "-");
const ACTION_LABEL: Record<RecoveryAction, string> = { "take-over": "Take over", "return-controls": "Return the controls", approve: "Review and approve", retry: "Try again", reconnect: "Check again", "open-job": "Open job" };

export function RequestBubble({ item }: { item: Item }) {
  return (
    <div className="flex justify-end" data-entry="request">
      <div className="max-w-[88%] rounded-2xl bg-surface-raised px-4 py-2.5 text-[15px] leading-relaxed text-foreground sm:max-w-[75%]">
        {!(item.source === "voice" && /^spoken request\.?$/i.test(item.text.trim())) && <p className="whitespace-pre-wrap break-words">{item.text}</p>}
        {item.source === "voice" && (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Mic className="size-3" aria-hidden="true" /> Spoken
          </p>
        )}
        {item.pending && <p className="mt-1 text-xs text-muted-foreground">Sending…</p>}
      </div>
    </div>
  );
}

/** A recovery as a calm notice: the reason, then the next move (links where one exists, a button where the chat can act). */
function RecoveryNotice({ recovery, actionLink, onNavigate, onAct }: { recovery: Recovery; actionLink: (a: RecoveryAction) => { href: string } | null; onNavigate?: (href: string) => void; onAct: (a: RecoveryAction) => void }) {
  return (
    <Notice tone={recovery.tone} title={recovery.title} className="!px-4 !py-3">
      <span className="block">{recovery.body}</span>
      <span className="mt-2 flex flex-wrap gap-2">
        {recovery.actions.filter((a) => a !== "open-job").map((a) => {
          const link = actionLink(a);
          if (link) return <Link key={a} href={link.href} onNavigate={onNavigate} className="bg-inset">{ACTION_LABEL[a]}</Link>;
          if (a === "take-over" || a === "return-controls") return null;
          return (
            <Button key={a} type="button" variant="outline" className="h-9 text-sm" onClick={() => onAct(a)}>
              {ACTION_LABEL[a]}
            </Button>
          );
        })}
      </span>
    </Notice>
  );
}

export function AckLine({ item, onRetry, onCheck, links, onNavigate, onAction }: { item: Item; onRetry?: () => void; /** An unconfirmed send: look at the hub's conversation now (the request is there if it arrived). */ onCheck?: () => void; links?: ChatLinks; onNavigate?: (href: string) => void; onAction?: (action: RecoveryAction) => void }) {
  // A refused start carries why (the computer is offline, someone is using it): the same recovery a job card would offer.
  const recovery = item.blocker ? recoveryOfBlocker(item.blocker, STATE_OF(item.state)) : null;
  return (
    <div className="max-w-[88%] text-[15px] leading-relaxed text-foreground sm:max-w-[75%]" data-entry="ack" data-ok={item.ok === false ? "false" : "true"}>
      <p className="whitespace-pre-wrap break-words">{item.text}</p>
      {item.ok === false && item.unconfirmed && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="ack-unconfirmed">
          Not confirmed. If it did arrive it shows above in a moment. Sending again sends the same request. A bot's hub recognises it; a request for your own device is only remembered until the hub restarts (or 30 minutes), after which it may run again, so check first.
        </p>
      )}
      {item.ok === false && (onRetry || (item.unconfirmed && onCheck)) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.unconfirmed && onCheck && (
            <Button type="button" variant="outline" className="h-9 text-sm" onClick={onCheck}>
              Check now
            </Button>
          )}
          {onRetry && (
            <Button type="button" variant="outline" className="h-9 text-sm" onClick={onRetry}>
              <RotateCcw aria-hidden="true" /> Send again
            </Button>
          )}
        </div>
      )}
      {recovery && (
        <div className="mt-2" data-testid="ack-recovery">
          <RecoveryNotice recovery={recovery} actionLink={(a) => { const c = a === "take-over" || a === "return-controls" ? links?.computer() : null; return c ? { href: c } : null; }} onNavigate={onNavigate} onAct={(a) => onAction?.(a)} />
        </div>
      )}
    </div>
  );
}

export function NoteLine({ item }: { item: Item }) {
  return (
    <p className="max-w-[88%] whitespace-pre-wrap break-words text-[15px] leading-relaxed text-muted-foreground sm:max-w-[75%]" data-entry="note">
      {item.text}
    </p>
  );
}

export function RunCard({
  run,
  links,
  onNavigate,
  onStop,
  stopNote,
  onAction,
  fresh,
}: {
  run: Run;
  links: ChatLinks;
  onNavigate?: (href: string) => void;
  onStop?: (jobId: string) => void;
  /** Why the last Stop did not work, in one honest line. */
  stopNote?: string;
  onAction?: (action: RecoveryAction, run: Run) => void;
  /** Arrived after the thread was loaded: it eases in (transform only; reduced motion removes it). */
  fresh?: boolean;
}) {
  const word = PHASE[run.status];
  const recovery = recoveryFor(run);
  const latest = run.steps.filter((s) => s.kind === "progress" || s.kind === "update").at(-1);
  const resultBody = run.result ? resultText(run.result.text) : "";
  const finalBody = run.status === "failed" || run.status === "stopped" || run.status === "unclear" ? resultText(run.last.text) : "";
  const computer = links.computer();
  const open = run.status === "running" || run.status === "blocked";
  // The step list: progress and updates only (a result or an ending is shown in its own place, never twice). While the job runs the newest
  // step is the one line above and the list holds the earlier ones; once it ends the list holds them all.
  const progress = run.steps.filter((s) => s.kind === "progress" || s.kind === "update");
  const listed = open ? progress.slice(0, -1) : progress;
  const stepCount = listed.length;

  const actionLink = (a: RecoveryAction): { href: string; newTab?: boolean } | null =>
    a === "take-over" || a === "return-controls" ? (computer ? { href: computer } : null) : a === "approve" || a === "open-job" ? { href: links.job(run.jobId, run.jobKind) } : null;

  return (
    <Surface
      as="article"
      padding="sm"
      className={cn("max-w-[96%] space-y-3 sm:max-w-[82%]", fresh && "mo-enter motion-reduce:animate-none")}
      data-entry="run"
      data-status={run.status}
      data-job={run.jobId}
      aria-label={`${statusWord(run.status)}: ${run.title || "task"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 break-words text-[15px] font-medium text-foreground">{run.title || "Task"}</h3>
        <TaskWord phase={word.phase} word={word.word} />
      </div>

      {/* While a person holds the computer the take-over notice below says so; the hub's pause line ("Paused: usman is taking control ...") above it
          said it a second time, naming the reader in the third person (round 8). */}
      {open && !(recovery?.kind === "take-over" && latest === run.last) && (
        <p className="break-words text-sm text-muted-foreground">{latest ? resultText(latest.text).split("\n")[0] : run.status === "blocked" ? "Paused until you act." : "Started. No steps reported yet."}</p>
      )}

      {run.status === "done" && (resultBody || run.last.text) && <ResultSummary text={resultBody || resultText(run.last.text)} />}
      {run.notes.length > 0 && (
        <div className="space-y-0.5" data-testid="run-notes">
          {run.notes.map((n) => (
            <p key={n.via} className="break-words text-xs text-muted-foreground" data-entry="note-info">
              {resultText(n.text).split("\n")[0]}
            </p>
          ))}
        </div>
      )}
      {finalBody && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{finalBody}</p>}

      {recovery && (
        <RecoveryNotice recovery={recovery} actionLink={actionLink} onNavigate={onNavigate} onAct={(a) => onAction?.(a, run)} />
      )}

      {stepCount > 0 && (
        <Disclosure summary={`${stepCount} ${open ? "earlier " : ""}${stepCount === 1 ? "step" : "steps"}`} className="-mx-1" triggerClassName="min-h-10 py-1.5 text-muted-foreground">
          <ol className="space-y-1.5 px-3 pb-2 text-sm text-muted-foreground" aria-label="Steps">
            {listed.map((s) => (
              <li key={s.via} className="break-words">
                {resultText(s.text).split("\n")[0]}
              </li>
            ))}
          </ol>
        </Disclosure>
      )}

      <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
        {run.status === "done" && (run.hasSavedResult || run.jobKind === "coding") && (
          <Link href={links.result(run.jobId, run.jobKind)} newTab={run.jobKind === "job"} onNavigate={onNavigate}>
            Open result <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
        <Link href={links.job(run.jobId, run.jobKind)} onNavigate={onNavigate} className="text-muted-foreground">
          Open job <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
        {computer && run.jobKind === "job" && (
          <Link href={computer} onNavigate={onNavigate} className="text-muted-foreground">
            <Monitor className="size-3.5" aria-hidden="true" /> Show computer
          </Link>
        )}
        {(run.status === "running" || run.status === "blocked") && onStop && (
          <Button type="button" variant="ghost" className="ml-auto h-9 text-sm" onClick={() => onStop(run.jobId)}>
            <Square aria-hidden="true" /> Stop
          </Button>
        )}
      </div>
      {stopNote && (<p role="status" className="text-sm text-muted-foreground" data-testid="stop-note">{stopNote}</p>)}
    </Surface>
  );
}

function ResultSummary({ text }: { text: string }) {
  const long = text.length > SUMMARY_CHARS;
  const head = long ? `${text.slice(0, SUMMARY_CHARS).replace(/\s+\S*$/, "")}…` : text;
  return long ? (
    <Disclosure summary={<span className="whitespace-pre-wrap break-words text-foreground">{head}</span>} meta="Full result" className="-mx-1" triggerClassName="items-start">
      <p className="whitespace-pre-wrap break-words px-3 pb-2 text-sm text-foreground">{text}</p>
    </Disclosure>
  ) : (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">{text}</p>
  );
}

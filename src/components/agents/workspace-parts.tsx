// Pieces shared by the agent workspaces (a shared computer on Computers, a coding job on Coding): a fact row,
// the "waiting for you" line, the assign form with its target named, and the work/result section of a computer job.
// Independently written for the M&U design system. Open Dot (composio-community/open-dot @ f838e17) was studied for how
// an agent's workspace is organised (chat, computer, setup); nothing is copied from it.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Notice } from "@/components/ds";
import { assignSteps, assignWork, jobFiles, jobResultText, verificationText, JOB_STATE_WORD, type ComputerJobView } from "@/lib/agent-workspace";
import type { ComputerView } from "@/lib/computers-client";
import { controllerText, screenFailing, stateChip } from "@/lib/computers-client";
import { decidedByView } from "@/lib/commands/decided-by";
import { useDraft } from "@/lib/use-draft";
import { cn } from "@/lib/utils";

/** A label and its value on one row. Value text is body size (15 px), the label is meta (14 px). */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]", className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[15px] leading-relaxed">{children}</dd>
    </div>
  );
}

/** The one thing that genuinely waits for this person. Absent when nothing does. */
export function WaitingNotice({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <Notice tone="warn" action={action} className="!px-4 !py-3" role="status">
      <span data-waiting="true" className="font-medium">{text}</span>
    </Notice>
  );
}

const field = "h-11 w-full min-w-0 rounded-xl border border-input bg-background px-3 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Assign work to one computer. The target is named before anything is sent: which computer, its state, who holds it.
 * The work is typed steps (open a page, keep a note); the hub validates them again and refuses risky ones.
 */
export function AssignForm({ c, me, nameOf, onDone }: { c: ComputerView; me: string | null; nameOf: (id: string) => string; onDone: (r: { ok: boolean; message: string; jobId?: string }) => void }) {
  const [title, setTitle] = useDraft(`computer-assign-title-${c.name}`);
  const [url, setUrl] = useDraft(`computer-assign-url-${c.name}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blind = screenFailing(c);
  const idle = c.state === "online" && c.controller.kind === null && !blind;
  const built = assignSteps({ title, url, agent: "assistant" }, c.capabilities);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await assignWork(c.name, { title, url, agent: "assistant" }, c.capabilities);
    setBusy(false);
    if (r.ok) {
      setTitle("");
      setUrl("");
      onDone(r);
    } else setError(r.message);
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl bg-inset p-4" aria-label={`Assign work to ${c.label || c.name}`} data-assign={c.name}>
      <p className="text-[15px]" data-testid="assign-target">
        <span className="text-muted-foreground">It will run on </span>
        <strong className="font-medium">{c.label || c.name}</strong>
        <span className="text-muted-foreground"> · {stateChip(c).word} · controls: {controllerText(c, me, nameOf)}</span>
      </p>
      {!idle && (
        <p className="text-sm text-muted-foreground" role="status">
          {blind ? `Its screen isn't ready, so nothing would run.` : c.state === "online" ? `Someone already holds it, so nothing would run.` : `It is ${stateChip(c).word.toLowerCase()}, so nothing would run.`} The hub never moves work to another computer.
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        What should it do?
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="Check the title of the Example Domain page" maxLength={120} disabled={busy} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        Page to open (optional)
        <input value={url} onChange={(e) => setUrl(e.target.value)} className={field} placeholder="https://example.com" inputMode="url" disabled={busy} />
      </label>
      {error && <Notice tone="danger" title="That didn't start">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="accent" disabled={busy || !idle || !built.ok}>Start the work</Button>
        {title.trim() && !built.ok && <span className="text-sm text-muted-foreground">{built.reason}</span>}
      </div>
    </form>
  );
}

/** What was asked, how it went, what came out. Honest when nothing has run. */
export function ComputerWork({ c, job }: { c: ComputerView; job: ComputerJobView | null }) {
  const ref = c.assigned ?? c.lastJob;
  if (!ref) return <p className="py-2 text-[15px] text-muted-foreground" data-work="none">Nothing has run on this computer since the hub started.</p>;
  const files = jobFiles(job);
  return (
    <dl className="divide-y divide-border" data-work={job?.state ?? "unknown"}>
      <Fact label="You asked">{ref.title || ref.jobId}</Fact>
      <Fact label="State">{job ? JOB_STATE_WORD[job.state] : "Not reported"}{job?.paused ? " (paused: someone has the controls)" : ""}</Fact>
      <Fact label="Progress">
        {job && job.steps.length ? (
          <ol className="flex flex-col gap-1">
            {job.steps.map((s, i) => (
              <li key={s.seq} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0">{s.intent.replace(/^step \d+ [\w.]+: /, "")}</span>
                <span className="text-muted-foreground">· {s.outcome}{verificationText(s.verification) ? ` · ${verificationText(s.verification)}` : ""}{s.jev ? <> · <span title={decidedByView(s.jev).detail} data-decided-by={decidedByView(s.jev).label}>decided by {decidedByView(s.jev).label}</span></> : null}</span>
              </li>
            ))}
          </ol>
        ) : (
          "No steps reported yet"
        )}
      </Fact>
      <Fact label="Latest result"><span data-result="true">{jobResultText(job)}</span></Fact>
      <Fact label="Working files">
        {files.length ? (
          <ul className="flex flex-col gap-1">{files.map((f) => <li key={f.seq}>{f.text}<span className="text-muted-foreground"> · {f.outcome}</span></li>)}</ul>
        ) : (
          "None reported. Files stay in this computer's own working folder."
        )}
      </Fact>
    </dl>
  );
}

/** Who is acting, with what model and account, and which routines belong here. Each one honest when it is none. */
export function ComputerDetails({ c, job }: { c: ComputerView; job: ComputerJobView | null }) {
  const agent = c.assigned?.agent ?? c.paused?.agent ?? job?.agent ?? c.lastJob?.agent ?? null;
  const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)}%` : "not reported");
  const mb = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)} MB` : "not reported");
  return (
    <dl className="divide-y divide-border">
      <Fact label="Agent">{agent ?? "None has worked here since the hub started"}</Fact>
      <Fact label="Model and account">None. Jobs here run typed steps on the computer itself; no model or account is used, so there is nothing asked-for or reported to compare.</Fact>
      <Fact label="Routines">None are tied to this computer. Scheduled routines are in <Link to="/automations" className="underline underline-offset-2">Automations</Link>.</Fact>
      <Fact label="Can">{c.capabilities ? (c.capabilities.length ? c.capabilities.join(", ") : "nothing reported") : "not reported"}</Fact>
      <Fact label="Use"><span className="ds-num">CPU {pct(c.resource?.cpuPct)} · memory {mb(c.resource?.rssMb)} · cost not reported</span></Fact>
    </dl>
  );
}

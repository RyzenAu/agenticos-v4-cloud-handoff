// The five answers about one coding job, at the top of its page: what the task is, who runs each role (asked for vs what
// the receipts report), what has finished, the ONE thing blocking it, and what the next button does. Calm and plain; the
// events, prompts and diagnostics stay behind Details. Nothing here is invented: unreported stays "not reported".
import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ds";
import type { AccountChoice, Glance } from "@/lib/coding-glance";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

export function JobGlance({
  glance, state, choices, choiceKey, onChoice, nextLabel, onNext, busy, resumable, children,
}: {
  glance: Glance;
  state: string;
  /** Accounts the moved role could run on (null while loading, [] when none is available). */
  choices: AccountChoice[] | null;
  choiceKey: string | null;
  onChoice: (key: string) => void;
  nextLabel: string;
  onNext: () => void;
  busy: boolean;
  resumable: boolean;
  children?: ReactNode;
}) {
  const { blocker } = glance;
  const moving = !!glance.moveRole && resumable;
  const noOne = moving && choices !== null && choices.length === 0;
  return (
    <section className="mb-6 rounded-2xl border border-border bg-card px-5 py-1 shadow-sm sm:px-6" aria-label="This job at a glance" data-testid="job-glance">
      <dl className="divide-y divide-border">
        <Row label="The task">{glance.task}</Row>
        <Row label="Who is doing it">
          <ul className="flex flex-col gap-2">
            {glance.roles.map((r) => (
              <li key={r.roleId} className="grid gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
                <span className="text-muted-foreground">{r.role}</span>
                <span className="min-w-0">
                  <span>{r.asked}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.reported ? (r.differs ? `Receipts report ${r.reported}, not what was asked for.` : `Receipts confirm ${r.reported}.`) : "Nothing has run yet, so there is no receipt."}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Row>
        <Row label="Done so far">
          {glance.finished.length ? (
            <ul className="flex flex-col gap-0.5">{glance.finished.map((l) => <li key={l}>{l}</li>)}</ul>
          ) : (
            <span className="text-muted-foreground">Nothing has finished yet.</span>
          )}
        </Row>
        <Row label="Blocked by">
          {blocker ? <span className="text-warn">{blocker.text}</span> : <span className="text-muted-foreground">{state === "completed" ? "Nothing. It is done and verified." : "Nothing is blocking it right now."}</span>}
        </Row>
        {resumable && (
          <Row label="Next">
            <div className="flex flex-col gap-3">
              {moving && choices && choices.length > 0 && (
                <label className="flex max-w-md flex-col gap-1 text-xs text-muted-foreground">
                  Run it on
                  <select
                    className="ds-interactive min-h-11 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
                    value={choiceKey ?? ""}
                    onChange={(e) => onChoice(e.target.value)}
                    disabled={busy}
                  >
                    {choices.map((c) => (
                      <option key={c.key} value={c.key}>{c.accountLabel} · {c.model}{c.same ? " (where it was)" : c.recommended ? " (suggested)" : ""}</option>
                    ))}
                  </select>
                </label>
              )}
              {noOne && <p className="text-muted-foreground">No account can run it right now, so a retry would stop again. Wait for a reset, or resolve what paused it.</p>}
              <div>
                <Button disabled={busy} onClick={onNext}><Play className="h-4 w-4" aria-hidden="true" /> {nextLabel}</Button>
              </div>
            </div>
          </Row>
        )}
      </dl>
      {children}
    </section>
  );
}

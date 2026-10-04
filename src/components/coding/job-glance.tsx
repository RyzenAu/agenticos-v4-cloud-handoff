// The five answers about one coding job, at the top of its page: what the task is, who runs each role (asked for vs what
// the receipts report), what has finished, the ONE thing blocking it, and what the next button does. Calm and plain; the
// events, prompts and diagnostics stay behind Details. Nothing here is invented: unreported stays "not reported".
import { Check, Play } from "lucide-react";
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
  glance, state, choices, choiceKey, onChoice, nextLabel, onNext, busy, resumable, draftAgainHref, children,
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
  /** A stopped or failed job can't be resumed; this is the way on (a new draft of the same request). */
  draftAgainHref?: string;
  children?: ReactNode;
}) {
  const { blocker } = glance;
  const ended = state === "cancelled" || state === "failed";
  const moving = !!glance.moveRole && resumable;
  const noOne = moving && choices !== null && choices.length === 0;
  // The task is the page title; saying it again here was one of four copies (audit F-03). A row with nothing to say is not shown.
  return (
    <section className="mb-6 rounded-2xl border border-border bg-card px-5 py-1 shadow-sm sm:px-6" aria-label="This job at a glance" data-testid="job-glance">
      <dl className="divide-y divide-border">
        {blocker && <Row label={ended ? "Why it stopped" : state === "interrupted" ? "Paused because" : "Waiting on"}><span className={ended ? undefined : "text-warn"}>{blocker.text}</span></Row>}
        <Row label="Who is doing it">
          <ul className="flex flex-col gap-2">
            {glance.roles.map((r) => (
              <li key={r.roleId} className="grid gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
                <span className="text-muted-foreground">{r.role}</span>
                <span className="min-w-0">
                  <span>{r.asked}</span>
                  {/* R11: a receipt that matches says so in two words instead of repeating the account and model; a mismatch still says what ran. */}
                  {r.reported && !r.differs ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-success" title={`Receipts confirm ${r.reported}.`}>
                      <Check aria-hidden="true" className="size-3.5" /> confirmed
                    </span>
                  ) : (
                    <span className={r.differs ? "block text-xs text-warn" : "block text-xs text-muted-foreground"}>
                      {r.reported ? `Receipts report ${r.reported}, not what was asked for.` : "Not run yet."}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Row>
        {glance.finished.length > 0 && (
          <Row label="Done so far">
            <ul className="flex flex-col gap-0.5">{glance.finished.map((l) => <li key={l}>{l}</li>)}</ul>
          </Row>
        )}
        {ended && draftAgainHref && (
          <Row label="Next">
            <Button asChild variant="outline"><a href={draftAgainHref}>{nextLabel}</a></Button>
          </Row>
        )}
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
              {noOne ? (
                // No button here: a Resume that stops at once is not a control (audit F-17).
                <p className="text-muted-foreground" data-testid="no-account-available">No other connected account can take it. Resume appears here once the limit resets.</p>
              ) : (
                <div>
                  <Button disabled={busy} onClick={onNext} aria-label={blocker?.detail ? `${nextLabel}. Accepts: ${blocker.detail}` : undefined}><Play className="h-4 w-4" aria-hidden="true" /> {nextLabel}</Button>
                  {blocker?.detail && <p className="mt-2 text-sm text-muted-foreground" data-accepts="true">Accepting records this on the job: {blocker.detail}</p>}
                </div>
              )}
            </div>
          </Row>
        )}
      </dl>
      {children}
    </section>
  );
}

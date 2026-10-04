// The plain-words summary of one coding job, from the server's `readable` block (scripts/coding/job-view.ts).
// It answers, in order: what it is, where it stands, who is working on it and where, what changed, what the
// tests and review said, and what is left. Events, prompts and diagnostics stay behind the page's Details.
// Nothing here is invented: a field the server didn't send reads "not reported".
import type { ReactNode } from "react";
import { DeviceStatusSlot, Notice } from "@/components/ds";
import { modelLabel, type JobView } from "@/lib/coding-client";
import { accountWords, roleLabel } from "../../../scripts/coding/pause-reason";
import type { CodingTab } from "./job-detail";
import { FailedTests } from "./failed-tests";

type Readable = NonNullable<JobView["readable"]>;
type Run = Readable["progress"]["runs"][number];

const VERDICT: Record<string, string> = { approve: "Approved", changes_requested: "Changes requested", reject: "Rejected", blocked: "Blocked" };
const SKIPPED_WHY = "not reported";

/** Pure: which run to describe as "the current worker": a live one, else the latest that has attempts. */
export function currentRun(readable: Readable, liveRoles: readonly string[]): Run | null {
  const runs = readable.progress.runs;
  return runs.find((r) => liveRoles.includes(r.roleId)) ?? [...runs].reverse().find((r) => r.attempts.length) ?? runs.at(-1) ?? null;
}

/** Pure: a plain sentence when the model that ran is not the model that was asked for; null when they agree or aren't both known. */
export function modelMismatchText(run: Run | null): string | null {
  const a = run?.attempts.filter((t) => t.outcome !== "did_not_run").at(-1);
  if (!a || !a.modelMismatch || !a.requestedModel || !a.reportedModel) return null;
  return `Asked for ${a.requestedModel} but the provider reported ${a.reportedModel}.`;
}

/** Pure: who the location slot should name. A cloud computer is named when a receipt reported its device. */
export function locationSlot(readable: Readable, receipts: JobView["receipts"]) {
  const loc = readable.location;
  if (!loc) return null;
  if (loc === "this-pc") return { isThisPc: true as const, label: null, online: null };
  const device = receipts.find((r) => r.executionLocation === "cloud")?.executionDevice ?? null;
  return { isThisPc: false as const, label: loc === "mixed" ? "This PC and a cloud computer" : device ? `Cloud computer ${device}` : "Cloud computer", online: null };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-xs text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function JobSummary({ view, onOpenTab, bare = false }: { view: JobView; onOpenTab: (tab: CodingTab) => void; bare?: boolean }) {
  const r = view.readable;
  if (!r) return null;
  const run = currentRun(r, view.liveRoles);
  const attempt = run?.attempts.filter((t) => t.outcome !== "did_not_run").at(-1) ?? null;
  const mismatch = modelMismatchText(run);
  const slot = locationSlot(r, view.receipts);
  const criteria = r.plan.doneWhen;
  const metCount = criteria.filter((c) => c.met === true).length;
  const t = r.tests.latest;
  const link = "underline underline-offset-2 hover:text-foreground";
  return (
    <section className={bare ? "" : "mb-6 rounded-2xl border border-border bg-card p-5 sm:p-6"} aria-label="Job summary">
      {!bare && <h2 className="text-lg font-semibold">Where this stands</h2>}
      {!bare && r.progress.needsYou && r.progress.needsYou !== r.progress.stateText && <Notice tone="warn" title="What is blocking it" className="mt-3">{r.progress.needsYou}</Notice>}
      {mismatch && <Notice tone="warn" title="Different model than requested" className="mt-3">{mismatch}</Notice>}
      <dl className="mt-2 divide-y divide-border">
        {!bare && <Row label="Objective">{r.plan.objective}</Row>}
        <Row label="State">{r.progress.stateText}</Row>
        {["preparing", "building", "integrating", "testing", "reviewing", "gating", "applying"].includes(view.job.state) && (
          <Row label="Working now">
            {run ? (
              <>
                {roleLabel(run.roleId)} · {run.who?.route === "model-router" ? "routed model" : accountWords(run.who?.accountSlot)} · {run.who?.model ? modelLabel({ model: run.who.model } as never) : "model not reported"}
                {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
              </>
            ) : (
              "No worker has started"
            )}
          </Row>
        )}
        {!bare && <Row label="Account and model">
          {attempt ? (
            <>
              {attempt.account ?? "account not reported"} · asked for {attempt.requestedModel ?? SKIPPED_WHY}, ran on {attempt.reportedModel ?? SKIPPED_WHY}
            </>
          ) : (
            "Nothing has run yet"
          )}
          {r.progress.fallbacks.length > 0 && <span className="mt-1 block text-muted-foreground">Moved accounts {count(r.progress.fallbacks.length, "time")}: {r.progress.fallbacks.map((f) => `${f.from ?? "?"} to ${f.to ?? "?"}`).join("; ")}.</span>}
        </Row>}
        {!bare && <Row label="Runs on">{slot ? <DeviceStatusSlot device={slot} className="text-sm" /> : <span>Location not reported</span>}</Row>}
        <Row label="Plan">
          {criteria.length ? (
            <>
              {metCount} of {criteria.length} done-when checks met.{" "}
              <button type="button" className={link} onClick={() => onOpenTab("plan")}>
                Open the plan
              </button>
              {r.plan.nonGoals.length > 0 && <span className="mt-1 block text-muted-foreground">Not included: {r.plan.nonGoals.slice(0, 3).join("; ")}.</span>}
            </>
          ) : (
            "No done-when checks recorded"
          )}
        </Row>
        <Row label="Progress">
          {r.progress.phases.map((p) => `${p.label}: ${p.status}`).join(" · ")}
        </Row>
        <Row label="Changes">
          {r.diff ? (
            <>
              {count(r.diff.totals.files, "file")}, <span className="ds-num">+{r.diff.totals.additions} / −{r.diff.totals.deletions}</span>{" "}
              <button type="button" className={link} onClick={() => onOpenTab("changes")}>
                See the changes
              </button>
              {r.diff.outsideOwnership.length > 0 && <span className="mt-1 block text-warn">{count(r.diff.outsideOwnership.length, "file")} outside what the role owns.</span>}
            </>
          ) : (
            "No changes yet"
          )}
        </Row>
        <Row label="Tests">
          {t ? (
            <>
              <span className="ds-num">{t.passed} passed, {t.failed} failed{t.skipped ? `, ${t.skipped} skipped` : ""}</span>
              {t.timedOut ? " · timed out" : ""}
              {(t.failed ?? 0) > 0 && t.matchesHead && <FailedTests failures={t.failures} names={t.failedTests} total={t.failed} />}
              {!t.matchesHead ? " · from an earlier version of the changes" : ""}{" "}
              <button type="button" className={link} onClick={() => onOpenTab("tests")}>
                Test details
              </button>
            </>
          ) : (
            "Not run yet"
          )}
        </Row>
        <Row label="Review">
          {r.review ? (
            <>
              {VERDICT[r.review.verdict] ?? r.review.verdict}
              {!r.review.forCurrentHead ? " (for an earlier version)" : ""}
              {r.review.findings.length ? ` · ${count(r.review.findings.length, "finding")}` : ""}{" "}
              <button type="button" className={link} onClick={() => onOpenTab("review")}>
                Read the review
              </button>
            </>
          ) : (
            "Not reviewed yet"
          )}
        </Row>
        {["completed", "failed", "cancelled", "awaiting_approval", "applying", "needs_owner", "blocked_allowance"].includes(r.progress.state) && (
          <Row label="Result">
            {r.result.nextStep}
            {r.result.gate ? <span className="mt-1 block text-muted-foreground">Final check {r.result.gate.passed ? "passed" : "failed"}.</span> : null}
          </Row>
        )}
        <Row label="Integration">
          {r.result.merged ? `Merged into ${r.result.applies.find((a) => a.state === "succeeded")?.toRef ?? "the protected branch"}.` : r.result.applies.length ? r.result.applies.map((a) => `${a.action === "git.merge.protected" ? `Merge into ${a.toRef}` : `Push to ${a.toRef}`}: ${({ awaiting_approval: "waiting for your yes", running: "in progress", succeeded: "done", failed: "did not happen", outcome_unknown: "outcome not known", cancelled: "not done (the request was withdrawn)" } as Record<string, string>)[a.state] ?? a.state}`).join("; ") : `Nothing merged. Work is on ${r.result.jobBranch}.`}
        </Row>
      </dl>
    </section>
  );
}

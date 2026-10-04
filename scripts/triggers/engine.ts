// The trigger engine: events and routine slots become deduplicated, durable jobs in the EXISTING job
// service, with the EXISTING approval service as the permission gate. There is no queue in this file
// that survives only in memory: a delivery row is written before any job exists, the job is created with
// an idempotent request id, and `tick()` reconciles whatever a crash left half-way.
//
// Safety properties (each has a test in engine.test.ts):
//   dedupe          one (trigger, event identity) is one delivery and one job, however often it arrives
//   feedback loops  an event our own jobs caused (actor "agent", or a ref in the outputs ledger) is ignored
//   permissions     actions only record or draft; sending is an approval request (message.send) that
//                   nothing here executes; "review" triggers hold every job for trigger.review first
//   safe failure    retry limit with backoff, then a visible failed state; an unknown outcome is never
//                   retried automatically (observe before retry), only by the owner's manual retry
//   privacy         only ids, a hash and a short masked projection are stored (see store.safeFields)
import { argsDigest } from "../approvals/canonical";
import type { Principal } from "../approvals/principal";
import type { ApprovalService } from "../approvals/service";
import type { JobService } from "../jobs/service";
import { BUILT_IN_ACTIONS, type ActionDef, type ActionDeps } from "./actions";
import { dedupeKey, safeFields, type DeliveryRecord, type TriggerStore } from "./store";
import type { Condition, DeliveryView, SafeFields, TriggerDef, TriggerEvent } from "./types";

export type EngineOptions = {
  store: TriggerStore;
  jobs: JobService;
  approvals: ApprovalService;
  now?: () => number;
  actions?: ActionDef[];
  deps?: ActionDeps;
  /** Whose jobs these are (the hub's owner). The principal is always a PROCESS: only a spoken yes or the Telegram code can approve. */
  personId?: "usman" | "mehroz";
  deviceId?: string;
  /** Handed a process-approval's one-time code. Left unset, nobody is messaged (no Telegram DM is sent). */
  notifyCode?: (code: string, summary: string) => void;
  retryBackoffMs?: (attempt: number) => number;
  /**
   * Agents workspace: the bot a trigger runs AS, if any, and the founder whose bot conversation its work lands in. Read each time a job is made, so
   * linking or unlinking a routine takes effect at its next run. The job then carries `bot`; `onBotJob` links it to that conversation.
   */
  asBot?: (trig: TriggerDef) => { bot: string; personId: string } | null;
  onBotJob?: (info: { bot: string; personId: string; jobId: string; title: string }) => void;
};

export type IngestResult =
  | { status: "job"; deliveryId: number; jobId: string | null; delivery: DeliveryView }
  | { status: "duplicate"; deliveryId: number; jobId: string | null }
  | { status: "ignored"; reason: string; deliveryId: number | null }
  | { status: "not-active" | "unmatched" };

const defaultBackoff = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 30 * 60_000);

export function matches(conditions: Condition[], safe: SafeFields): boolean {
  return conditions.every((c) => {
    const v = safe[c.field];
    switch (c.op) {
      case "exists": return v !== undefined;
      case "eq": return v === c.value;
      case "in": return v !== undefined && c.value.includes(v);
      case "contains": return typeof v === "string" && v.toLowerCase().includes(c.value.toLowerCase());
    }
  });
}

export class TriggerEngine {
  readonly store: TriggerStore;
  private jobs: JobService;
  private approvals: ApprovalService;
  private now: () => number;
  private actions = new Map<string, ActionDef>();
  private deps: ActionDeps;
  private principal: Principal;
  private deviceId: string;
  private notifyCode?: (code: string, summary: string) => void;
  private backoff: (attempt: number) => number;
  private asBot?: EngineOptions["asBot"];
  private onBotJob?: EngineOptions["onBotJob"];
  /** One run at a time per delivery inside this process. */
  private busy = new Set<number>();

  constructor(o: EngineOptions) {
    this.store = o.store;
    this.jobs = o.jobs;
    this.approvals = o.approvals;
    this.now = o.now ?? Date.now;
    for (const a of o.actions ?? BUILT_IN_ACTIONS) this.actions.set(a.id, a);
    this.deps = o.deps ?? {};
    this.principal = { personId: o.personId ?? "usman", via: "routine", actor: "process" };
    this.deviceId = o.deviceId ?? "hub";
    this.notifyCode = o.notifyCode;
    this.backoff = o.retryBackoffMs ?? defaultBackoff;
    this.asBot = o.asBot;
    this.onBotJob = o.onBotJob;
  }

  actionIds() {
    return [...this.actions.keys()];
  }

  // ---------------------------------------------------------------- intake
  /** An event from a source adapter: offered to every active trigger of that source. */
  async deliver(event: TriggerEvent): Promise<IngestResult[]> {
    const out: IngestResult[] = [];
    for (const trig of this.store.list({ source: event.source, kind: "event" })) out.push(await this.ingest(trig, event));
    return out;
  }

  async ingest(trig: TriggerDef, event: TriggerEvent, options: { hold?: boolean } = {}): Promise<IngestResult> {
    if (trig.state !== "active") {
      this.store.bump(trig.id, "paused");
      return { status: "not-active" };
    }
    if (!event.eventId || typeof event.eventId !== "string" || event.eventId.length > 200) return { status: "unmatched" };
    const safe = safeFields(event.fields);
    if (!matches(trig.conditions, safe)) {
      this.store.bump(trig.id, "unmatched");
      return { status: "unmatched" };
    }
    // Feedback-loop prevention: our own agents' output never starts our own work.
    const ignoredReason =
      event.actor === "agent" ? "agent-actor" : this.store.isOwnOutput(event.originRef) || this.store.isOwnOutput(event.eventId) ? "self-output" : null;
    const claim = this.store.claim(trig.id, dedupeKey(event.source, event.eventId), safe, ignoredReason);
    if (!claim.created) {
      this.store.bump(trig.id, "duplicates");
      return { status: "duplicate", deliveryId: claim.row.id, jobId: claim.row.job_id };
    }
    if (ignoredReason) {
      this.store.bump(trig.id, "ignored");
      return { status: "ignored", reason: ignoredReason, deliveryId: claim.row.id };
    }
    this.store.bump(trig.id, "delivered");
    if (options.hold) this.store.patch(claim.row.id, { stage: "hold" });
    await this.start(claim.row.id);
    const d = this.store.delivery(claim.row.id)!;
    return { status: "job", deliveryId: d.id, jobId: d.job_id, delivery: this.store.view(d) };
  }

  // ---------------------------------------------------------------- running
  private action(trig: TriggerDef): ActionDef | null {
    return this.actions.get(trig.action) ?? null;
  }
  private labelOf(safe: SafeFields) {
    return String(safe.ref ?? safe.callId ?? safe.slot ?? "").slice(0, 40);
  }
  private ensureJob(d: DeliveryRecord, trig: TriggerDef, title: string): string {
    const seq = (this.store.db.query("SELECT COUNT(*) AS n FROM delivery_jobs WHERE delivery_id=?").get(d.id) as { n: number }).n + 1;
    let bound: { bot: string; personId: string } | null = null;
    try {
      bound = this.asBot?.(trig) ?? null;
    } catch {
      /* a lookup that fails leaves the job nobody's bot's, as before */
    }
    const job = this.jobs.create({
      kind: "trigger",
      principal: this.principal,
      targetDeviceId: this.deviceId,
      title: `${title}: ${this.labelOf(JSON.parse(d.safe))}`.trim(),
      requestId: `trg:${trig.id}:${d.dedupe_key.slice(0, 16)}:j${seq}`,
      ...(bound ? { bot: bound.bot } : {}),
    });
    if (bound) {
      try {
        this.onBotJob?.({ ...bound, jobId: job.id, title: job.title });
      } catch {
        /* the conversation link never breaks a routine */
      }
    }
    this.store.link(d.id, seq, job.id);
    this.store.patch(d.id, { jobId: job.id });
    return job.id;
  }
  /** The delivery's job if it can still carry on (awaiting approval / queued), else a fresh one. */
  private liveJob(d: DeliveryRecord, trig: TriggerDef): string {
    const existing = d.job_id ? this.jobs.get(d.job_id) : null;
    if (existing?.state === "awaiting-approval" && this.jobs.resumed(existing.id)) return existing.id;
    if (existing?.state === "queued" && this.jobs.begin(existing.id)) return existing.id;
    const id = this.ensureJob(d, trig, trig.name);
    this.jobs.begin(id);
    return id;
  }
  private ctxFor(jobId: string, trig: TriggerDef, safe: SafeFields) {
    return {
      trigger: trig,
      safe,
      jobId,
      deps: this.deps,
      step: (intent: string, outcome: "ok" | "failed" | "skipped" | "note" = "ok", evidence?: string) =>
        void this.jobs.step(jobId, { intent, executor: "trigger", ms: 0, outcome, ...(evidence ? { verification: { method: "recorded", ok: true, evidence } } : {}) }),
      output: (ref: string, kind: string) => this.store.recordOutput(ref, jobId, trig.id, kind),
    };
  }
  private settleJob(jobId: string, to: "succeeded" | "failed" | "cancelled", note: string) {
    // A job the restart already interrupted can't change state; its note still says what really happened.
    if (!this.jobs.finish(jobId, to, note)) this.jobs.amendNote(jobId, note);
  }
  private requestApproval(d: DeliveryRecord, jobId: string, request: { action: string; args: unknown; summary: string }) {
    const r = this.approvals.request({ ...request, requester: this.principal, origin: "principal", jobId });
    if (!r.ok) return null;
    if (r.telegramCode && this.notifyCode) {
      try {
        this.notifyCode(r.telegramCode, request.summary);
      } catch {
        /* a notifier never breaks the job */
      }
    }
    return r.approval;
  }

  private async start(id: number) {
    const d = this.store.delivery(id)!;
    const trig = this.store.get(d.trigger_id);
    if (!trig) return;
    const held = d.stage === "hold" || (trig.mode === "review" && d.stage === "start");
    if (held) return this.hold(d, trig);
    return this.run(d, trig);
  }

  /** Review mode: nothing runs until trigger.review is approved. */
  private hold(d: DeliveryRecord, trig: TriggerDef) {
    const jobId = this.ensureJob(d, trig, `Review ${trig.name}`);
    this.jobs.begin(jobId);
    const approval = this.requestApproval(d, jobId, {
      action: "trigger.review",
      args: { triggerId: trig.id, key: d.dedupe_key },
      summary: `Review "${trig.name}" ${this.labelOf(JSON.parse(d.safe))}: nothing runs until you approve`.slice(0, 200),
    });
    if (!approval) {
      this.settleJob(jobId, "failed", "The review request was refused.");
      return this.store.patch(d.id, { status: "failed", reason: "approval-refused", stage: "hold" });
    }
    this.jobs.step(jobId, { intent: "Held for the owner's review. Nothing has run", executor: "trigger", ms: 0, outcome: "note" });
    this.jobs.awaitingApproval(jobId, approval.id);
    this.store.patch(d.id, { status: "awaiting-approval", stage: "held", approvalId: approval.id, reason: null });
  }

  private async run(d: DeliveryRecord, trig: TriggerDef) {
    if (this.busy.has(d.id)) return;
    this.busy.add(d.id);
    try {
      const action = this.action(trig);
      const safe = JSON.parse(d.safe) as SafeFields;
      const attempt = d.attempts + 1;
      const jobId = this.liveJob(d, trig);
      this.store.patch(d.id, { status: "running", attempts: attempt, stage: "run", nextRetryAt: null, reason: null });
      if (!action) {
        this.settleJob(jobId, "failed", "This trigger's action isn't available.");
        return this.failed(d.id, trig, attempt, "unknown-action");
      }
      let ok = false;
      let note: string | undefined;
      try {
        const result = await action.run(this.ctxFor(jobId, trig, safe));
        ok = result.ok;
        note = result.note;
      } catch {
        // Never keep the exception text: it can echo a payload or a token.
        note = "The action failed.";
      }
      if (!ok) {
        this.settleJob(jobId, "failed", note ?? "The action failed.");
        return this.failed(d.id, trig, attempt, "action-failed");
      }
      const fu = action.followUp?.(safe);
      if (fu) {
        const approval = this.requestApproval(d, jobId, fu);
        if (approval && this.jobs.awaitingApproval(jobId, approval.id)) {
          this.jobs.step(jobId, { intent: `Asked the owner to approve: ${fu.summary}`, executor: "trigger", ms: 0, outcome: "asked" });
          return this.store.patch(d.id, { status: "awaiting-approval", stage: "send", approvalId: approval.id });
        }
        this.settleJob(jobId, "succeeded", `${note ?? "Done."} The follow-up could not be requested, so nothing will be sent.`);
        return this.store.patch(d.id, { status: "succeeded", reason: "follow-up-refused" });
      }
      this.settleJob(jobId, "succeeded", note ?? "Done.");
      this.store.patch(d.id, { status: "succeeded", reason: null });
    } finally {
      this.busy.delete(d.id);
    }
  }

  private failed(id: number, trig: TriggerDef, attempt: number, reason: string) {
    if (attempt < trig.retryLimit) this.store.patch(id, { status: "retrying", reason, nextRetryAt: this.now() + this.backoff(attempt) });
    else this.store.patch(id, { status: "failed", reason, nextRetryAt: null });
  }

  // ---------------------------------------------------------------- approvals, retries, recovery
  /** Move every delivery whose approval has been answered. */
  async sweep(): Promise<number> {
    let moved = 0;
    for (const d of this.store.byStatus(["awaiting-approval"])) {
      const trig = this.store.get(d.trigger_id);
      const approval = d.approval_id ? this.approvals.get(d.approval_id) : null;
      if (!trig || !approval || approval.state === "pending") continue;
      moved++;
      if (approval.state === "approved" || approval.state === "consumed") {
        if (d.stage === "held") {
          const ok = approval.state === "consumed" || this.approvals.consume(approval.id, argsDigest("trigger.review", { triggerId: trig.id, key: d.dedupe_key }), { jobId: d.job_id ?? undefined }).ok;
          if (ok) await this.run(this.store.delivery(d.id)!, trig);
          else this.store.patch(d.id, { status: "rejected", reason: "approval-not-usable" });
        } else {
          const fu = this.action(trig)?.followUp?.(JSON.parse(d.safe));
          const ok = approval.state === "consumed" || (fu !== undefined && this.approvals.consume(approval.id, argsDigest(fu.action, fu.args), { jobId: d.job_id ?? undefined }).ok);
          if (d.job_id && ok) {
            this.jobs.step(d.job_id, { intent: "Approved by the owner. No sender is connected in this build, so nothing was sent", executor: "trigger", ms: 0, outcome: "note" });
            this.settleJob(d.job_id, "succeeded", "Approved. Nothing was sent: no sender is connected.");
          }
          this.store.patch(d.id, ok ? { status: "succeeded", reason: "approved-not-sent" } : { status: "rejected", reason: "approval-not-usable" });
        }
      } else {
        if (d.job_id) this.settleJob(d.job_id, "cancelled", `Not approved (${approval.state}). Nothing ran.`);
        this.store.patch(d.id, { status: "rejected", reason: `approval-${approval.state}` });
      }
    }
    return moved;
  }

  /** What a crash or restart left half-way: a queued delivery with no job, a running one whose job was interrupted. */
  async reconcile(): Promise<number> {
    let n = 0;
    for (const d of this.store.byStatus(["queued", "running"])) {
      const trig = this.store.get(d.trigger_id);
      if (!trig || this.busy.has(d.id)) continue;
      if (d.status === "queued") {
        n++;
        await this.start(d.id);
        continue;
      }
      const job = d.job_id ? this.jobs.get(d.job_id) : null;
      if (job && (job.state === "running" || job.state === "queued")) continue;
      n++;
      // Unknown = it may have happened. Never retried automatically.
      if (job?.state === "unknown") this.store.patch(d.id, { status: "unknown", reason: "outcome-unknown" });
      else this.failed(d.id, trig, d.attempts, "interrupted");
    }
    return n;
  }

  async retryDue(): Promise<number> {
    let n = 0;
    for (const d of this.store.byStatus(["retrying"])) {
      const trig = this.store.get(d.trigger_id);
      if (!trig || trig.state !== "active" || (d.next_retry_at ?? 0) > this.now()) continue;
      n++;
      await this.run(d, trig);
    }
    return n;
  }

  /** The owner's manual retry: always allowed for a failed, unknown or waiting-to-retry delivery. */
  async retry(deliveryId: number): Promise<DeliveryView | null> {
    const d = this.store.delivery(deliveryId);
    if (!d || !["failed", "unknown", "retrying"].includes(d.status)) return null;
    const trig = this.store.get(d.trigger_id);
    if (!trig || trig.state === "disabled") return null;
    if (d.stage === "hold") this.store.patch(d.id, { status: "queued", reason: null, nextRetryAt: null });
    else await this.run(d, trig);
    if (d.stage === "hold") await this.start(d.id);
    return this.store.view(this.store.delivery(d.id)!);
  }

  async tick(): Promise<{ reconciled: number; retried: number; swept: number }> {
    const reconciled = await this.reconcile();
    const retried = await this.retryDue();
    const swept = await this.sweep();
    return { reconciled, retried, swept };
  }
}

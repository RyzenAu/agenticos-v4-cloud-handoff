import { randomUUID } from "node:crypto";
import type { DeviceRegistry } from "./registry";
import { resolveTarget } from "./route";
import type { DeviceOwner, PersonId } from "./types";

/**
 * Hands a resolved command to the right machine.
 *
 * - Target is the hub (Usman's PC): returns { local: true } and the caller runs it here, as today.
 * - Target is a companion: queued for that device only; the companion collects it by long-poll
 *   (it connects out — no port is ever opened on the other PC), runs it, and posts the result.
 * - Offline, cancelled or timed out: fails closed with a reason. Never re-routed.
 * - Every wire command carries jobId, stepId, deviceId, a commandKey (the companion's idempotency key: the same
 *   key is never run twice) and expiresAt (a companion refuses a command past it). A job's steps are pinned to
 *   the device the job started on (`pinDeviceId`): a step never follows the person to another machine.
 * - A command that was DELIVERED and then lost its device is "uncertain", never "failed" or "done": it may have
 *   run. If the device is still online but the ack is lost (a timeout), the hub asks the companion to OBSERVE
 *   what happened to that commandKey before deciding, and it never sends the action again.
 *
 * Send/pay/delete/publish commands need that same person's own spoken yes (an `approval`
 * from the Jarvis/Jev voice path); the companion checks it again locally.
 */

export const RISKY = /\b(send|pay|payment|delete|remove|publish|post|transfer|purchase|buy)\b/i;
export const APPROVAL_TTL_MS = 2 * 60 * 1000;
export const DEDUPE_WINDOW_MS = 5_000;
/** How long the hub waits for a companion to answer "what happened to that command?" before calling it uncertain. */
export const OBSERVE_WAIT_MS = 6_000;
/** A delivered command still unanswered this long after delivery, while the companion reports nothing running, is asked about (see reviewIdle). Just over one heartbeat. */
export const IDLE_GRACE_MS = 15_000;

export type Risk = "send" | "pay" | "delete" | "publish";
export type Approval = { personId: PersonId; via: "spoken-yes"; at: number };
export type CommandInput = {
  personId: string;
  spokenTarget?: string;
  originDeviceId?: string;
  executor: string;
  args?: Record<string, unknown>;
  risk?: Risk;
  approval?: Approval;
  /**
   * Idempotency: the same key from the same person for the same executor and args, while the command is
   * queued or running, or finished OK within DEDUPE_WINDOW_MS, is the same command (typed + voice echo,
   * a double tap). It returns that command's result and queues nothing new. A failed or cancelled one is retried.
   */
  commandKey?: string;
  /** The job and step this command belongs to (carried on the wire, and the companion's idempotency key). */
  jobId?: string;
  stepId?: string;
  /** The device this job started on: if the person's target now resolves elsewhere, nothing is sent (never re-routed). */
  pinDeviceId?: string;
  /**
   * The control lease a command to a shared cloud computer must carry (scripts/computers): who holds it and its fencing
   * epoch. Checked BEFORE the command is queued; a computer command without a live matching lease is refused and nothing runs.
   */
  lease?: { holder: string; epoch: number };
};
/** What a companion receives. `commandKey` is unique per intended action; `expiresAt` is the hub's clock (ms epoch). */
export type WireCommand = {
  id: string;
  executor: string;
  args: Record<string, unknown>;
  risk?: Risk;
  approval?: Approval;
  /** The device's owner: a person for a personal PC, "shared" for a shared cloud computer. */
  personId: DeviceOwner;
  deviceId: string;
  jobId?: string;
  stepId?: string;
  commandKey: string;
  expiresAt: number;
};
export type CommandStatus = "queued" | "delivered" | "done" | "failed" | "cancelled" | "uncertain";
/** What a companion says it knows about a command it was asked to observe. */
export type Observation =
  | { state: "done"; ok: boolean; output?: unknown; error?: string }
  | { state: "running" }
  | { state: "interrupted" }
  | { state: "cancelled" }
  | { state: "unknown" };
export type CommandRecord = WireCommand & { /** Who asked (the verified person), for a shared computer's audit. */ by?: PersonId; status: CommandStatus; createdAt: number; deliveredAt?: number; result?: unknown; error?: string; observed?: Observation };
export type DispatchResult =
  | { ok: true; local: true; deviceId: string }
  | { ok: true; local: false; deviceId: string; commandId: string; result: unknown }
  | {
      ok: false;
      reason: string;
      deviceId?: string;
      commandId?: string;
      /** It was delivered and may have run: the outcome is not known. */
      uncertain?: boolean;
      /** It never reached the device (or the device says it never received it): nothing ran. */
      notRun?: boolean;
      observed?: Observation;
      /** What the device reported with a failure (its ExecutorResult), e.g. a question it is waiting on. */
      result?: unknown;
    };
/** One sub-step a companion reports while a long command (a screen goal) runs; the hub records it as a job step. */
export type ProgressStep = {
  intent: string;
  executor: string;
  target?: string;
  action?: string;
  outcome: "ok" | "failed" | "skipped" | "refused" | "asked" | "cancelled" | "unknown" | "note";
  verification?: { method: string; ok: boolean | null; evidence?: string };
  ms: number;
};
const OUTCOMES = new Set(["ok", "failed", "skipped", "refused", "asked", "cancelled", "unknown", "note"]);
/** A progress step from the wire, bounded and cleaned; null if it isn't one. Pure. */
export function cleanProgress(raw: unknown): ProgressStep | null {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!s || typeof s.intent !== "string" || typeof s.executor !== "string" || !OUTCOMES.has(String(s.outcome))) return null;
  const v = s.verification && typeof s.verification === "object" ? (s.verification as Record<string, unknown>) : null;
  return {
    intent: s.intent.slice(0, 300),
    executor: s.executor.slice(0, 40),
    ...(typeof s.target === "string" ? { target: s.target.slice(0, 80) } : {}),
    ...(typeof s.action === "string" ? { action: s.action.slice(0, 120) } : {}),
    outcome: s.outcome as ProgressStep["outcome"],
    ...(v && typeof v.method === "string" ? { verification: { method: v.method.slice(0, 40), ok: typeof v.ok === "boolean" ? v.ok : null, ...(typeof v.evidence === "string" ? { evidence: v.evidence.slice(0, 200) } : {}) } } : {}),
    ms: Number.isFinite(Number(s.ms)) ? Math.max(0, Math.min(Number(s.ms), 3_600_000)) : 0,
  };
}
export type NextItem = { type: "command"; command: WireCommand } | { type: "cancel"; commandId: string } | { type: "observe"; commandId: string; commandKey: string };

export function isRisky(executor: string, risk?: Risk) {
  return !!risk || RISKY.test(executor.replace(/[-_.]/g, " "));
}

export function approvalValid(approval: Approval | undefined, personId: DeviceOwner, now: number) {
  return !!approval && approval.via === "spoken-yes" && approval.personId === personId && now - approval.at >= 0 && now - approval.at <= APPROVAL_TTL_MS;
}

type Waiter = { resolve: (r: DispatchResult) => void; timer?: ReturnType<typeof setTimeout> };

export class Dispatcher {
  private commands = new Map<string, CommandRecord>();
  private waiters = new Map<string, Waiter>();
  /** One waiting long-poll per device; call with take=false to release it empty. */
  private pollers = new Map<string, (take: boolean) => void>();
  private cancels = new Map<string, string[]>();
  private observes = new Map<string, { commandId: string; commandKey: string }[]>();
  private observeWaiters = new Map<string, (o: Observation) => void>();
  private progressSinks = new Map<string, { fn: (step: ProgressStep) => void; count: number }>();
  private sweeper?: ReturnType<typeof setInterval>;
  /** person + key → the command it started and its outcome promise (see CommandInput.commandKey). */
  private keyed = new Map<string, { commandId: string; sig: string; done: Promise<DispatchResult>; settledAt?: number; ok?: boolean }>();

  /** Set by the computers service: may this command go to this shared computer now? A string is the refusal. */
  guard?: (device: { id: string; kind: string }, input: CommandInput) => string | null;

  constructor(private readonly registry: DeviceRegistry, private readonly now: () => number = Date.now, private readonly observeWaitMs: number = OBSERVE_WAIT_MS) {}

  /** Periodically fail commands whose device went offline. */
  start(intervalMs = 5_000) {
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweepOffline(), intervalMs);
      (this.sweeper as { unref?: () => void }).unref?.();
    }
    return this;
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const id of [...this.waiters.keys()]) this.finish(id, this.commands.get(id)?.status === "delivered" ? "uncertain" : "failed", { error: "The OS is shutting down." });
    for (const [, resolve] of [...this.observeWaiters]) resolve({ state: "interrupted" });
    this.observeWaiters.clear();
    for (const [, release] of this.pollers) release(false);
    this.pollers.clear();
  }

  /**
   * `signal`: the caller's stop (the job service's abort). A queued or running command is cancelled on the
   * companion and the result is "cancelled", never a late success. `onQueued` hands back the command id.
   */
  async submit(input: CommandInput, opts: { timeoutMs?: number; signal?: AbortSignal; onQueued?: (commandId: string, deviceId: string) => void; onProgress?: (step: ProgressStep) => void } = {}): Promise<DispatchResult> {
    if (opts.signal?.aborted) return { ok: false, reason: "Cancelled." };
    const target = resolveTarget({ personId: input.personId, spokenTarget: input.spokenTarget, originDeviceId: input.originDeviceId }, this.registry);
    if (!target.ok) return input.pinDeviceId ? { ...target, notRun: true } : target;
    // A job's later steps stay on the device the job started on; a target that now resolves elsewhere is a refusal.
    if (input.pinDeviceId && target.deviceId !== input.pinDeviceId)
      return { ok: false, reason: "device changed: this job started on another device, so I did not move it", deviceId: input.pinDeviceId, notRun: true };
    const executor = String(input.executor ?? "").trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(executor)) return { ok: false, reason: "Unknown action." };
    if (isRisky(executor, input.risk) && !approvalValid(input.approval, target.owner, this.now()))
      return { ok: false, reason: "Send, pay, delete and publish need your own spoken yes first.", deviceId: target.deviceId };
    const device = this.registry.get(target.deviceId);
    if (!device) return { ok: false, reason: "device offline", deviceId: target.deviceId };
    if (device.kind === "hub") return { ok: true, local: true, deviceId: device.id };
    // A shared cloud computer: the control lease is checked before anything is queued (one controller at a time).
    if (device.kind === "cloud-computer") {
      const refusal = this.guard ? this.guard(device, input) : "Shared computers need their control lease: no computers service is running.";
      if (refusal) return { ok: false, reason: refusal, deviceId: device.id, notRun: true };
    }
    const keyName = input.commandKey ? `${target.owner}|${input.commandKey.slice(0, 200)}` : null;
    const sig = JSON.stringify([device.id, executor, input.args ?? {}]);
    if (keyName) {
      const prior = this.keyed.get(keyName);
      const fresh = prior && (prior.settledAt === undefined || (prior.ok && this.now() - prior.settledAt <= DEDUPE_WINDOW_MS));
      if (prior && fresh && prior.sig === sig) return prior.done;
      if (prior) this.keyed.delete(keyName);
    }
    const id = randomUUID();
    const createdAt = this.now();
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const record: CommandRecord = {
      id,
      executor,
      args: { ...(input.args ?? {}) },
      risk: input.risk,
      approval: input.approval,
      personId: target.owner,
      ...(device.kind === "cloud-computer" ? { by: input.personId as PersonId } : {}),
      deviceId: device.id,
      ...(input.jobId ? { jobId: input.jobId.slice(0, 80) } : {}),
      ...(input.stepId ? { stepId: input.stepId.slice(0, 80) } : {}),
      // Unique per intended action: a redelivery of THIS command is deduped by it, a later "same words" command is not.
      commandKey: input.jobId && input.stepId ? `${input.jobId}/${input.stepId}`.slice(0, 200) : `c:${id}`,
      expiresAt: createdAt + timeoutMs,
      status: "queued",
      createdAt,
    };
    this.commands.set(record.id, record);
    if (opts.onProgress) this.progressSinks.set(record.id, { fn: opts.onProgress, count: 0 });
    opts.onQueued?.(record.id, device.id);
    const onAbort = () => this.cancel(record.id, record.personId === "shared" ? input.personId as PersonId : record.personId);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = new Promise<DispatchResult>((resolve) => {
      const waiter: Waiter = { resolve };
      waiter.timer = setTimeout(() => void this.expire(record.id), timeoutMs);
      this.waiters.set(record.id, waiter);
    });
    this.wake(device.id);
    const settled = done.finally(() => opts.signal?.removeEventListener("abort", onAbort));
    if (keyName) {
      const entry: { commandId: string; sig: string; done: Promise<DispatchResult>; settledAt?: number; ok?: boolean } = { commandId: record.id, sig, done: settled };
      this.keyed.set(keyName, entry);
      void settled.then((r) => {
        entry.settledAt = this.now();
        entry.ok = r.ok;
        if (!r.ok && this.keyed.get(keyName) === entry) this.keyed.delete(keyName);
        if (this.keyed.size > 200) for (const [k, v] of this.keyed) if (v.settledAt !== undefined && this.now() - v.settledAt > DEDUPE_WINDOW_MS) this.keyed.delete(k);
      });
    }
    return settled;
  }

  /** Cancel a queued or running command. Only the person who owns it may cancel it. */
  cancel(commandId: string, by: PersonId): { ok: boolean; reason?: string } {
    const r = this.commands.get(commandId);
    if (!r) return { ok: false, reason: "No such command." };
    // A shared computer's command may be cancelled by either founder (who holds the lease is enforced where it was queued).
    if (r.personId !== by && r.personId !== "shared") return { ok: false, reason: "You can only cancel your own commands." };
    if (r.status !== "queued" && r.status !== "delivered") return { ok: false, reason: `Already ${r.status}.` };
    if (r.status === "delivered") this.queueCancel(r.deviceId, r.id);
    this.finish(commandId, "cancelled", { error: "Cancelled." });
    return { ok: true };
  }

  /**
   * The wait ran out. Never delivered: nothing ran. Delivered and its device is gone: uncertain. Delivered and
   * the device is still here (a lost ack): ask it to OBSERVE what happened to that key, then decide from its
   * answer. The action is never sent again.
   */
  private async expire(commandId: string) {
    const r = this.commands.get(commandId);
    if (!r || (r.status !== "queued" && r.status !== "delivered")) return;
    if (r.status === "queued") return void this.finish(commandId, "failed", { error: "Timed out waiting for the device: it never picked this up, so nothing ran.", notRun: true });
    const device = this.registry.get(r.deviceId);
    if (!device || !this.registry.isOnline(device)) return void this.finish(commandId, "uncertain", { error: "device offline: it had been delivered, so it may have run" });
    return this.resolveDelivered(commandId, "timeout");
  }

  /**
   * A heartbeat said the companion is IDLE, yet a command was delivered to it a while ago and never answered: its process was
   * restarted (or lost the command) faster than the offline sweep could notice. Ask it what happened instead of waiting out the whole
   * timeout. Only commands delivered more than `graceMs` ago, only while no question is already out; the action is never sent again.
   */
  reviewIdle(deviceId: string, graceMs: number = IDLE_GRACE_MS) {
    for (const r of this.commands.values()) {
      if (r.deviceId !== deviceId || r.status !== "delivered" || this.observeWaiters.has(r.id)) continue;
      if (this.now() - (r.deliveredAt ?? r.createdAt) < graceMs) continue;
      void this.resolveDelivered(r.id, "idle");
    }
  }

  /** Delivered, device online: ask it, then decide from its answer. `idle` = asked because it reports nothing running (not because the time ran out). */
  private async resolveDelivered(commandId: string, why: "timeout" | "idle") {
    const r = this.commands.get(commandId);
    if (!r || r.status !== "delivered") return;
    const seen = await this.observe(r);
    const now = this.commands.get(commandId);
    if (!now || now.status !== "delivered") return; // a late result or a cancel settled it while we asked
    // Idle review only: it says it is busy with it after all (or the heartbeat raced the start), so leave it to run.
    if (why === "idle" && seen.state === "running") return;
    if (seen.state === "done") return void this.finish(commandId, seen.ok ? "done" : "failed", { result: seen.output, error: seen.error, observed: seen });
    if (seen.state === "unknown") return void this.finish(commandId, "failed", { error: `${why === "idle" ? "The device is idle and" : "Timed out: the device"} says it never received this command, so nothing ran.`, notRun: true, observed: seen });
    if (seen.state === "cancelled") return void this.finish(commandId, "cancelled", { error: "The device says it cancelled this command.", observed: seen });
    if (seen.state === "running") this.queueCancel(now.deviceId, now.id);
    this.finish(commandId, "uncertain", {
      error:
        seen.state === "running"
          ? "Timed out while it was still running on the device: I asked it to stop, and its outcome is uncertain."
          : why === "idle"
            ? "The companion was restarted while it had this command, so it may or may not have run."
            : "Timed out waiting for the device: it may or may not have run.",
      observed: seen,
    });
  }

  /** Ask the device what happened to a command it was sent. No answer in time is "interrupted": we do not know, which is not "it never ran". */
  observe(r: CommandRecord, waitMs: number = this.observeWaitMs): Promise<Observation> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.observeWaiters.delete(r.id);
        resolve({ state: "interrupted" });
      }, waitMs);
      (timer as { unref?: () => void }).unref?.();
      this.observeWaiters.set(r.id, (o) => {
        clearTimeout(timer);
        this.observeWaiters.delete(r.id);
        resolve(o);
      });
      this.queueObserve(r.deviceId, r.id, r.commandKey);
    });
  }

  /** A companion reports a sub-step of a command it is running. Only the device it was sent to, only while it is delivered; bounded. */
  progress(deviceId: string, commandId: string, raw: unknown): boolean {
    const r = this.commands.get(commandId);
    const sink = this.progressSinks.get(commandId);
    const step = cleanProgress(raw);
    if (!r || r.deviceId !== deviceId || r.status !== "delivered" || !sink || !step || sink.count >= 300) return false;
    sink.count++;
    try {
      sink.fn(step);
    } catch {
      /* a listener never breaks the dispatcher */
    }
    return true;
  }

  /** A companion answers an observe request. Only the device the command was sent to may. */
  reportObservation(deviceId: string, commandId: string, observation: Observation): boolean {
    const r = this.commands.get(commandId);
    if (!r || r.deviceId !== deviceId) return false;
    r.observed = observation;
    this.observeWaiters.get(commandId)?.(observation);
    return true;
  }

  /**
   * A device came back after being offline: learn what became of any command it was holding when it dropped.
   * Only annotates the record (`observed`); an uncertain job stays uncertain, and nothing is ever re-sent.
   */
  reconcile(deviceId: string) {
    for (const r of this.commands.values()) if (r.deviceId === deviceId && r.status === "uncertain" && !r.observed && this.now() - r.createdAt < 10 * 60_000) this.queueObserve(deviceId, r.id, r.commandKey);
  }

  /**
   * Long-poll for a companion: pending cancels first, then its next command (one at a time).
   * Resolves null after `waitMs` with nothing to do.
   */
  async next(deviceId: string, waitMs = 25_000): Promise<NextItem | null> {
    const immediate = this.take(deviceId);
    if (immediate || waitMs <= 0) return immediate;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pollers.get(deviceId) === wake) this.pollers.delete(deviceId);
        resolve(this.take(deviceId));
      }, waitMs);
      const wake = (take: boolean) => {
        clearTimeout(timer);
        if (this.pollers.get(deviceId) === wake) this.pollers.delete(deviceId);
        resolve(take ? this.take(deviceId) : null);
      };
      // One poller per device. A newer poll (the companion reconnected) releases the older one
      // empty, so no command is ever handed to a connection that has gone away.
      this.pollers.get(deviceId)?.(false);
      this.pollers.set(deviceId, wake);
    });
  }

  /** A companion reports a result. Only the device the command was sent to may report it. */
  complete(deviceId: string, commandId: string, outcome: { ok: boolean; output?: unknown; error?: string }): boolean {
    const r = this.commands.get(commandId);
    if (!r || r.deviceId !== deviceId) return false;
    // Already settled as uncertain (its device dropped, or the ack was lost): the late report is kept as what the
    // device says happened, but the job's outcome is not rewritten as a success.
    if (r.status === "uncertain" && !r.observed) r.observed = { state: "done", ok: outcome.ok, output: outcome.output, error: outcome.error };
    if (r.status !== "delivered") return false;
    this.finish(commandId, outcome.ok ? "done" : "failed", { result: outcome.output, error: outcome.error });
    return true;
  }

  /** Fail everything waiting on a device that is no longer online. */
  sweepOffline() {
    for (const r of this.commands.values()) {
      if (r.status !== "queued" && r.status !== "delivered") continue;
      const device = this.registry.get(r.deviceId);
      if (device && this.registry.isOnline(device)) continue;
      // Never delivered: nothing ran. Delivered: it may have.
      if (r.status === "queued") this.finish(r.id, "failed", { error: "device offline", notRun: true });
      else this.finish(r.id, "uncertain", { error: "device offline" });
    }
  }

  deviceOffline(deviceId: string) {
    this.registry.markOffline(deviceId);
    this.sweepOffline();
    this.pollers.get(deviceId)?.(false);
  }

  /** The long-poll's connection closed before the item was written: put it back. */
  undeliver(deviceId: string, item: NextItem) {
    if (item.type === "cancel") {
      this.cancels.set(deviceId, [item.commandId, ...(this.cancels.get(deviceId) ?? [])]);
      return;
    }
    if (item.type === "observe") {
      this.observes.set(deviceId, [{ commandId: item.commandId, commandKey: item.commandKey }, ...(this.observes.get(deviceId) ?? [])]);
      return;
    }
    const r = this.commands.get(item.command.id);
    if (r && r.deviceId === deviceId && r.status === "delivered") {
      r.status = "queued";
      this.wake(deviceId);
    }
  }

  get(commandId: string) {
    return this.commands.get(commandId);
  }

  /** The most recent commands, newest last, without their args or results' payloads (status, key, job/step, what the device said it knew). For evidence and the device page. */
  recent(limit = 50) {
    return [...this.commands.values()].slice(-limit).map((r) => ({
      id: r.id, executor: r.executor, deviceId: r.deviceId, jobId: r.jobId ?? null, stepId: r.stepId ?? null, commandKey: r.commandKey,
      status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, deliveredAt: r.deliveredAt ?? null, error: r.error ?? null, observed: r.observed?.state ?? null,
    }));
  }

  private take(deviceId: string): NextItem | null {
    const cancels = this.cancels.get(deviceId);
    if (cancels?.length) return { type: "cancel", commandId: cancels.shift()! };
    const observes = this.observes.get(deviceId);
    if (observes?.length) return { type: "observe", ...observes.shift()! };
    // A command past its expiry is never handed out: it fails here, unrun.
    for (const r of [...this.commands.values()])
      if (r.deviceId === deviceId && r.status === "queued" && r.expiresAt <= this.now()) this.finish(r.id, "failed", { error: "expired before the device picked it up, so nothing ran", notRun: true });
    const mine = [...this.commands.values()].filter((r) => r.deviceId === deviceId);
    if (mine.some((r) => r.status === "delivered")) return null;
    const next = mine.find((r) => r.status === "queued");
    if (!next) return null;
    next.status = "delivered";
    next.deliveredAt = this.now();
    return { type: "command", command: wireOf(next) };
  }

  private queueObserve(deviceId: string, commandId: string, commandKey: string) {
    const list = this.observes.get(deviceId) ?? [];
    list.push({ commandId, commandKey });
    this.observes.set(deviceId, list);
    this.wake(deviceId);
  }

  private queueCancel(deviceId: string, commandId: string) {
    const list = this.cancels.get(deviceId) ?? [];
    list.push(commandId);
    this.cancels.set(deviceId, list);
    this.wake(deviceId);
  }

  private wake(deviceId: string) {
    this.pollers.get(deviceId)?.(true);
  }

  private finish(commandId: string, status: CommandStatus, extra: { result?: unknown; error?: string; notRun?: boolean; observed?: Observation }) {
    const r = this.commands.get(commandId);
    if (!r) return;
    this.progressSinks.delete(commandId);
    r.status = status;
    r.result = extra.result;
    r.error = extra.error;
    if (extra.observed) r.observed = extra.observed;
    const waiter = this.waiters.get(commandId);
    this.waiters.delete(commandId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(
        status === "done"
          ? { ok: true, local: false, deviceId: r.deviceId, commandId, result: r.result }
          : {
              ok: false,
              reason: r.error ?? status,
              deviceId: r.deviceId,
              commandId,
              ...(status === "uncertain" ? { uncertain: true } : {}),
              ...(extra.notRun ? { notRun: true } : {}),
              ...(r.observed ? { observed: r.observed } : {}),
              ...(r.result !== undefined ? { result: r.result } : {}),
            },
      );
    }
    // Keep a short history; drop old finished records.
    if (this.commands.size > 500) {
      for (const [id, rec] of this.commands) {
        if (rec.status !== "queued" && rec.status !== "delivered") this.commands.delete(id);
        if (this.commands.size <= 250) break;
      }
    }
    // The device may now take its next command.
    this.wake(r.deviceId);
  }
}

function wireOf(r: CommandRecord): WireCommand {
  const { id, executor, args, risk, approval, personId, deviceId, jobId, stepId, commandKey, expiresAt } = r;
  return { id, executor, args, risk, approval, personId, deviceId, ...(jobId ? { jobId } : {}), ...(stepId ? { stepId } : {}), commandKey, expiresAt };
}

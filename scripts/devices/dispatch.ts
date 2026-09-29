import { randomUUID } from "node:crypto";
import type { DeviceRegistry } from "./registry";
import { resolveTarget } from "./route";
import type { PersonId } from "./types";

/**
 * Hands a resolved command to the right machine.
 *
 * - Target is the hub (Usman's PC): returns { local: true } and the caller runs it here, as today.
 * - Target is a companion: queued for that device only; the companion collects it by long-poll
 *   (it connects out — no port is ever opened on the other PC), runs it, and posts the result.
 * - Offline, cancelled or timed out: fails closed with a reason. Never re-routed.
 *
 * Send/pay/delete/publish commands need that same person's own spoken yes (an `approval`
 * from the Jarvis/Jev voice path); the companion checks it again locally.
 */

export const RISKY = /\b(send|pay|payment|delete|remove|publish|post|transfer|purchase|buy)\b/i;
export const APPROVAL_TTL_MS = 2 * 60 * 1000;
export const DEDUPE_WINDOW_MS = 5_000;

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
};
export type WireCommand = { id: string; executor: string; args: Record<string, unknown>; risk?: Risk; approval?: Approval; personId: PersonId };
export type CommandStatus = "queued" | "delivered" | "done" | "failed" | "cancelled";
export type CommandRecord = WireCommand & { deviceId: string; status: CommandStatus; createdAt: number; result?: unknown; error?: string };
export type DispatchResult =
  | { ok: true; local: true; deviceId: string }
  | { ok: true; local: false; deviceId: string; commandId: string; result: unknown }
  | { ok: false; reason: string; deviceId?: string; commandId?: string };
export type NextItem = { type: "command"; command: WireCommand } | { type: "cancel"; commandId: string };

export function isRisky(executor: string, risk?: Risk) {
  return !!risk || RISKY.test(executor.replace(/[-_.]/g, " "));
}

export function approvalValid(approval: Approval | undefined, personId: PersonId, now: number) {
  return !!approval && approval.via === "spoken-yes" && approval.personId === personId && now - approval.at >= 0 && now - approval.at <= APPROVAL_TTL_MS;
}

type Waiter = { resolve: (r: DispatchResult) => void; timer?: ReturnType<typeof setTimeout> };

export class Dispatcher {
  private commands = new Map<string, CommandRecord>();
  private waiters = new Map<string, Waiter>();
  /** One waiting long-poll per device; call with take=false to release it empty. */
  private pollers = new Map<string, (take: boolean) => void>();
  private cancels = new Map<string, string[]>();
  private sweeper?: ReturnType<typeof setInterval>;
  /** person + key → the command it started and its outcome promise (see CommandInput.commandKey). */
  private keyed = new Map<string, { commandId: string; sig: string; done: Promise<DispatchResult>; settledAt?: number; ok?: boolean }>();

  constructor(private readonly registry: DeviceRegistry, private readonly now: () => number = Date.now) {}

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
    for (const [id] of this.waiters) this.finish(id, "failed", { error: "The OS is shutting down." });
    for (const [, release] of this.pollers) release(false);
    this.pollers.clear();
  }

  /**
   * `signal`: the caller's stop (the job service's abort). A queued or running command is cancelled on the
   * companion and the result is "cancelled", never a late success. `onQueued` hands back the command id.
   */
  async submit(input: CommandInput, opts: { timeoutMs?: number; signal?: AbortSignal; onQueued?: (commandId: string, deviceId: string) => void } = {}): Promise<DispatchResult> {
    if (opts.signal?.aborted) return { ok: false, reason: "Cancelled." };
    const target = resolveTarget({ personId: input.personId, spokenTarget: input.spokenTarget, originDeviceId: input.originDeviceId }, this.registry);
    if (!target.ok) return target;
    const executor = String(input.executor ?? "").trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(executor)) return { ok: false, reason: "Unknown action." };
    if (isRisky(executor, input.risk) && !approvalValid(input.approval, target.owner, this.now()))
      return { ok: false, reason: "Send, pay, delete and publish need your own spoken yes first.", deviceId: target.deviceId };
    const device = this.registry.get(target.deviceId);
    if (!device) return { ok: false, reason: "device offline", deviceId: target.deviceId };
    if (device.kind === "hub") return { ok: true, local: true, deviceId: device.id };
    const keyName = input.commandKey ? `${target.owner}|${input.commandKey.slice(0, 200)}` : null;
    const sig = JSON.stringify([device.id, executor, input.args ?? {}]);
    if (keyName) {
      const prior = this.keyed.get(keyName);
      const fresh = prior && (prior.settledAt === undefined || (prior.ok && this.now() - prior.settledAt <= DEDUPE_WINDOW_MS));
      if (prior && fresh && prior.sig === sig) return prior.done;
      if (prior) this.keyed.delete(keyName);
    }
    const record: CommandRecord = {
      id: randomUUID(),
      executor,
      args: { ...(input.args ?? {}) },
      risk: input.risk,
      approval: input.approval,
      personId: target.owner,
      deviceId: device.id,
      status: "queued",
      createdAt: this.now(),
    };
    this.commands.set(record.id, record);
    opts.onQueued?.(record.id, device.id);
    const onAbort = () => this.cancel(record.id, record.personId);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = new Promise<DispatchResult>((resolve) => {
      const waiter: Waiter = { resolve };
      const timeoutMs = opts.timeoutMs ?? 60_000;
      waiter.timer = setTimeout(() => {
        const r = this.commands.get(record.id);
        if (r && (r.status === "queued" || r.status === "delivered")) {
          if (r.status === "delivered") this.queueCancel(r.deviceId, r.id);
          this.finish(record.id, "failed", { error: "Timed out waiting for the device." });
        }
      }, timeoutMs);
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
    if (r.personId !== by) return { ok: false, reason: "You can only cancel your own commands." };
    if (r.status !== "queued" && r.status !== "delivered") return { ok: false, reason: `Already ${r.status}.` };
    if (r.status === "delivered") this.queueCancel(r.deviceId, r.id);
    this.finish(commandId, "cancelled", { error: "Cancelled." });
    return { ok: true };
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
    if (!r || r.deviceId !== deviceId || r.status !== "delivered") return false;
    this.finish(commandId, outcome.ok ? "done" : "failed", { result: outcome.output, error: outcome.error });
    return true;
  }

  /** Fail everything waiting on a device that is no longer online. */
  sweepOffline() {
    for (const r of this.commands.values()) {
      if (r.status !== "queued" && r.status !== "delivered") continue;
      const device = this.registry.get(r.deviceId);
      if (!device || !this.registry.isOnline(device)) this.finish(r.id, "failed", { error: "device offline" });
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
    const r = this.commands.get(item.command.id);
    if (r && r.deviceId === deviceId && r.status === "delivered") {
      r.status = "queued";
      this.wake(deviceId);
    }
  }

  get(commandId: string) {
    return this.commands.get(commandId);
  }

  private take(deviceId: string): NextItem | null {
    const cancels = this.cancels.get(deviceId);
    if (cancels?.length) return { type: "cancel", commandId: cancels.shift()! };
    const mine = [...this.commands.values()].filter((r) => r.deviceId === deviceId);
    if (mine.some((r) => r.status === "delivered")) return null;
    const next = mine.find((r) => r.status === "queued");
    if (!next) return null;
    next.status = "delivered";
    const { id, executor, args, risk, approval, personId } = next;
    return { type: "command", command: { id, executor, args, risk, approval, personId } };
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

  private finish(commandId: string, status: CommandStatus, extra: { result?: unknown; error?: string }) {
    const r = this.commands.get(commandId);
    if (!r) return;
    r.status = status;
    r.result = extra.result;
    r.error = extra.error;
    const waiter = this.waiters.get(commandId);
    this.waiters.delete(commandId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(
        status === "done"
          ? { ok: true, local: false, deviceId: r.deviceId, commandId, result: r.result }
          : { ok: false, reason: r.error ?? status, deviceId: r.deviceId, commandId },
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

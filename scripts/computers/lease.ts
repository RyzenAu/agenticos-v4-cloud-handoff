import type { PersonId } from "../devices/types";
import { holderKey, type Holder, type Lease } from "./types";

/**
 * The control lease: who may send a shared cloud computer input right now.
 *
 *  - ONE holder per computer: an agent job or a person. Nobody else's command is queued or sent (the dispatcher asks
 *    `valid()` before anything is queued).
 *  - A holder keeps it by renewing (an agent job renews on every step and on a timer; a person's viewer heartbeats).
 *    Not renewed before `expiresAt`, it is free: an abandoned viewer or a dead job never locks a computer.
 *  - Every change of holder bumps a fencing `epoch`. A command carries the epoch it was issued under, so a paused
 *    agent's late command is refused after a person took control.
 *  - A person who asks for a computer an agent holds sets `takeover`. The agent pauses at its next SAFE STEP BOUNDARY
 *    (between two steps, never inside one) by calling `handOver`; only then does the person hold the lease. The agent's
 *    job is remembered (`paused`), and "return to agent" (or the person's lease expiring) gives the lease back to that
 *    same job, which refreshes its view of the computer and carries on without replaying a completed step.
 *
 * Pure and synchronous, with an injected clock. Nothing here touches a device; the service wires it in.
 */

export const AGENT_LEASE_TTL_MS = 60_000;
export const PERSON_LEASE_TTL_MS = 90_000;

export type LeaseEvent =
  | { type: "acquired"; lease: Lease }
  | { type: "released"; computerId: string; was: Holder; why: "released" | "expired" | "destroyed" }
  | { type: "takeover-requested"; lease: Lease }
  | { type: "handed-over"; lease: Lease; jobId: string }
  | { type: "returned"; lease: Lease; jobId: string; why: "returned" | "viewer-expired" }
  /** The same person moved their own controls from one browser window (session) to another: an explicit, recorded takeover, a new epoch. */
  | { type: "moved"; lease: Lease };

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; reason: string; heldBy: Holder };
export type TakeoverResult =
  | { ok: true; state: "held"; lease: Lease }
  | { ok: true; state: "pending"; lease: Lease }
  | { ok: false; reason: string; heldBy: Holder };

export class LeaseManager {
  private leases = new Map<string, Lease>();
  private listeners = new Set<(e: LeaseEvent) => void>();
  private epochs = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    readonly agentTtlMs = AGENT_LEASE_TTL_MS,
    readonly personTtlMs = PERSON_LEASE_TTL_MS,
  ) {}

  subscribe(listener: (e: LeaseEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(e: LeaseEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener never breaks the lease */
      }
    }
  }

  private nextEpoch(computerId: string) {
    const n = (this.epochs.get(computerId) ?? 0) + 1;
    this.epochs.set(computerId, n);
    return n;
  }

  private ttl(holder: Holder) {
    return holder.kind === "agent" ? this.agentTtlMs : this.personTtlMs;
  }

  /** The live lease, or null. An expired one is settled here (a paused job gets the computer back) and is never returned. */
  current(computerId: string): Lease | null {
    this.settleExpiry(computerId);
    const l = this.leases.get(computerId);
    return l ? { ...l, holder: { ...l.holder }, takeover: l.takeover && { ...l.takeover }, paused: l.paused && { ...l.paused } } : null;
  }

  /** Every computer's live lease (settles expiries first). */
  all(): Lease[] {
    for (const id of [...this.leases.keys()]) this.settleExpiry(id);
    return [...this.leases.keys()].map((id) => this.current(id)!).filter(Boolean);
  }

  private settleExpiry(computerId: string) {
    const l = this.leases.get(computerId);
    if (!l || l.expiresAt > this.now()) return;
    // A person's viewer went away while an agent job was paused by it: control returns to that job (it re-reads the computer).
    if (l.holder.kind === "person" && l.paused) {
      const back: Lease = {
        ...l,
        epoch: this.nextEpoch(computerId),
        holder: { kind: "agent", jobId: l.paused.jobId, by: l.paused.by, agent: l.paused.agent },
        acquiredAt: this.now(),
        renewedAt: this.now(),
        expiresAt: this.now() + this.agentTtlMs,
        takeover: null,
        paused: null,
      };
      this.leases.set(computerId, back);
      this.emit({ type: "returned", lease: back, jobId: l.paused.jobId, why: "viewer-expired" });
      return;
    }
    this.leases.delete(computerId);
    this.emit({ type: "released", computerId, was: l.holder, why: "expired" });
  }

  /** An agent job takes a free computer. A held one is refused with who holds it (nothing is queued behind it). */
  acquireAgent(computerId: string, job: { jobId: string; by: PersonId; agent: string }): AcquireResult {
    const held = this.current(computerId);
    if (held) {
      if (held.holder.kind === "agent" && held.holder.jobId === job.jobId) return { ok: true, lease: held };
      return { ok: false, reason: describeHolder(held.holder), heldBy: held.holder };
    }
    const t = this.now();
    const holder: Holder = { kind: "agent", jobId: job.jobId, by: job.by, agent: job.agent };
    const lease: Lease = { computerId, epoch: this.nextEpoch(computerId), holder, acquiredAt: t, renewedAt: t, expiresAt: t + this.agentTtlMs, takeover: null, paused: null };
    this.leases.set(computerId, lease);
    this.emit({ type: "acquired", lease });
    return { ok: true, lease: { ...lease } };
  }

  /** May this holder, under this epoch, send the computer a command right now? Also renews it (activity is liveness). */
  valid(computerId: string, key: string, epoch: number): boolean {
    const l = this.current(computerId) && this.leases.get(computerId);
    if (!l || l.epoch !== epoch || holderKey(l.holder) !== key) return false;
    this.touch(l);
    return true;
  }

  private touch(l: Lease) {
    const t = this.now();
    l.renewedAt = t;
    l.expiresAt = t + this.ttl(l.holder);
  }

  /** Keep the lease: a job's step or timer, a viewer's heartbeat. False when it is no longer this holder's. */
  renew(computerId: string, key: string, epoch?: number): boolean {
    this.settleExpiry(computerId);
    const l = this.leases.get(computerId);
    if (!l || holderKey(l.holder) !== key || (epoch !== undefined && l.epoch !== epoch)) return false;
    this.touch(l);
    return true;
  }

  /** A person asks to take the computer. Free: they hold it now. An agent holds it: the agent pauses at its next step boundary. */
  requestTakeover(computerId: string, who: { personId: PersonId; session: string }): TakeoverResult {
    const held = this.current(computerId);
    const t = this.now();
    if (!held) {
      const lease: Lease = {
        computerId, epoch: this.nextEpoch(computerId), holder: { kind: "person", personId: who.personId, session: who.session },
        acquiredAt: t, renewedAt: t, expiresAt: t + this.personTtlMs, takeover: null, paused: null,
      };
      this.leases.set(computerId, lease);
      this.emit({ type: "acquired", lease });
      return { ok: true, state: "held", lease: { ...lease } };
    }
    if (held.holder.kind === "person") {
      // The same person in the same session just keeps it; anyone else waits for the holder to return it or for it to expire.
      if (held.holder.personId === who.personId && held.holder.session === who.session) {
        this.renew(computerId, holderKey(held.holder));
        return { ok: true, state: "held", lease: this.current(computerId)! };
      }
      return { ok: false, reason: describeHolder(held.holder), heldBy: held.holder };
    }
    const l = this.leases.get(computerId)!;
    l.takeover = { by: who.personId, session: who.session, requestedAt: t };
    const snap = this.current(computerId)!;
    this.emit({ type: "takeover-requested", lease: snap });
    return { ok: true, state: "pending", lease: snap };
  }

  /**
   * The same PERSON, in another window: the controls they hold in one session move to this one (a new epoch, so the old window's late input is refused at once).
   * Only ever for the person who holds them: anyone else's controls, an agent's and a free computer are refused.
   */
  moveToSession(computerId: string, who: { personId: PersonId; session: string }): { ok: true } | { ok: false; reason: string } {
    const l = this.leases.get(computerId);
    const held = this.current(computerId);
    if (!l || !held) return { ok: false, reason: "Nobody has the controls, so there is nothing to move: use Take over" };
    if (held.holder.kind !== "person") return { ok: false, reason: "An agent has this computer: use Take over, which pauses it at a safe step" };
    if (held.holder.personId !== who.personId) return { ok: false, reason: describeHolder(held.holder) };
    if (held.holder.session === who.session) return { ok: true };
    const t = this.now();
    l.holder = { kind: "person", personId: who.personId, session: who.session };
    l.epoch = this.nextEpoch(computerId);
    l.renewedAt = t;
    l.expiresAt = t + this.personTtlMs;
    l.takeover = null;
    this.emit({ type: "moved", lease: this.current(computerId)! });
    return { ok: true };
  }

  /** A person changed their mind before the agent reached a boundary. */
  cancelTakeover(computerId: string, who: { personId: PersonId; session: string }): boolean {
    const l = this.leases.get(computerId);
    if (!l?.takeover || l.takeover.by !== who.personId || l.takeover.session !== who.session) return false;
    l.takeover = null;
    return true;
  }

  /** Is a person waiting for this agent job to reach a step boundary? (The job checks this between steps, never inside one.) */
  takeoverWaiting(computerId: string, jobId: string): boolean {
    const l = this.current(computerId);
    return !!l && l.holder.kind === "agent" && l.holder.jobId === jobId && l.takeover !== null;
  }

  /** The agent job has finished a step and stops here: the lease passes to the person who asked. */
  handOver(computerId: string, jobId: string): { ok: true; lease: Lease } | { ok: false; reason: string } {
    const l = this.leases.get(computerId);
    if (!l || l.holder.kind !== "agent" || l.holder.jobId !== jobId) return { ok: false, reason: "this job doesn't hold the computer" };
    if (!l.takeover) return { ok: false, reason: "nobody asked for the computer" };
    const t = this.now();
    const paused = { jobId, by: l.holder.by, agent: l.holder.agent, pausedAt: t };
    const next: Lease = {
      computerId, epoch: this.nextEpoch(computerId), holder: { kind: "person", personId: l.takeover.by, session: l.takeover.session },
      acquiredAt: t, renewedAt: t, expiresAt: t + this.personTtlMs, takeover: null, paused,
    };
    this.leases.set(computerId, next);
    const snap = this.current(computerId)!;
    this.emit({ type: "handed-over", lease: snap, jobId });
    return { ok: true, lease: snap };
  }

  /**
   * "Return to agent": the person gives the computer back. The paused job (if any) holds it again under a NEW epoch and
   * resumes; with no paused job the computer is simply free.
   */
  returnToAgent(computerId: string, who: { personId: PersonId; session: string }): { ok: true; resumed: string | null } | { ok: false; reason: string } {
    const held = this.current(computerId);
    if (!held) return { ok: true, resumed: null };
    if (held.holder.kind !== "person" || held.holder.personId !== who.personId || held.holder.session !== who.session)
      return { ok: false, reason: held.holder.kind === "person" ? describeHolder(held.holder) : "an agent already has this computer" };
    const t = this.now();
    if (held.paused) {
      const back: Lease = {
        computerId, epoch: this.nextEpoch(computerId), holder: { kind: "agent", jobId: held.paused.jobId, by: held.paused.by, agent: held.paused.agent },
        acquiredAt: t, renewedAt: t, expiresAt: t + this.agentTtlMs, takeover: null, paused: null,
      };
      this.leases.set(computerId, back);
      this.emit({ type: "returned", lease: { ...back }, jobId: held.paused.jobId, why: "returned" });
      return { ok: true, resumed: held.paused.jobId };
    }
    this.leases.delete(computerId);
    this.emit({ type: "released", computerId, was: held.holder, why: "released" });
    return { ok: true, resumed: null };
  }

  /** A paused job will never come back (cancelled while paused): forget it, so "return to agent" doesn't resume a dead job. */
  clearPaused(computerId: string, jobId: string): boolean {
    const l = this.leases.get(computerId);
    if (!l?.paused || l.paused.jobId !== jobId) return false;
    l.paused = null;
    return true;
  }

  /** The holder lets go (a job finished, a person closed the viewer with nothing paused). */
  release(computerId: string, key: string): boolean {
    this.settleExpiry(computerId);
    const l = this.leases.get(computerId);
    if (!l || holderKey(l.holder) !== key) return false;
    this.leases.delete(computerId);
    this.emit({ type: "released", computerId, was: l.holder, why: "released" });
    return true;
  }

  /** The computer is gone: drop its lease whoever holds it. */
  drop(computerId: string) {
    const l = this.leases.get(computerId);
    this.leases.delete(computerId);
    if (l) this.emit({ type: "released", computerId, was: l.holder, why: "destroyed" });
  }

  /** Periodic: settle every expiry (a paused job whose viewer vanished gets its computer back). */
  sweep() {
    for (const id of [...this.leases.keys()]) this.settleExpiry(id);
  }
}

export function describeHolder(h: Holder): string {
  return h.kind === "agent" ? `agent "${h.agent}" is using this computer (job ${h.jobId.slice(0, 8)})` : `${h.personId} is controlling this computer`;
}

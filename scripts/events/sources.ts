// Producers for the activity bus (programme S-stream). Each one turns a change that already happens in the
// OS into a NOTIFICATION; none of them starts, retries or resumes anything.
//
//   jobs        JobService.subscribe (in-process, the same durable log /__jobs/events reads)   -> topic "job"
//   approvals   ApprovalService.subscribe                                                       -> topic "approval"
//   leases      LeaseManager.subscribe (reduced: no viewer session id)                          -> topic "lease"
//   computers   a 2 s sampler over computers.list(), emitting only what changed               -> topic "computer"
//   devices     a 2 s sampler over the registry's online map (heartbeat TTL 30 s => offline    -> topic "device"
//               shows within ~32 s of the last heartbeat, as the old 4 s poll did)
//   agents      agentMessage() from a conversation or agent (builder V's server side)         -> topic "agent"
//   jarvis      jarvisChanged() hints: events, timers, status or a protocol run changed        -> topic "jarvis"
//   threads     threadEntry(): one entry appended to a person's durable Jarvis conversation   -> topic "thread"
//               (PERSON-scoped: it is that person's conversation, so the other founder's stream never receives it)
//   crm         crmChanged(): a committed CRM change, {ref, change, at} only (no field values)      -> topic "crm"
//               (both founders: the CRM is shared business data; a tab refetches, it never trusts the event for content)
//
// Scope: a job or approval is visible to the person it belongs to, to everyone when it is business activity (coding,
// memory, trigger jobs; merge/deploy/provider/trigger approvals) or happened on a SHARED computer, and to its device's
// owner when it targets a personal device. A job or approval with no known device (Jarvis answers, lookups, browser,
// message/publish approvals) is the REQUESTER'S: it fails closed to their person, never to "shared". Computers are
// shared; a device event goes to its owner (shared computers: all).
import { publicView } from "../approvals/principal";
import type { Approval } from "../approvals/service";
import { maskJobText } from "../jobs/service";
import { TERMINAL_STATES, type JobEvent, type JobKind, type JobSummary } from "../jobs/types";
import type { ActivityBus, PersonId, Scope } from "./bus";

const SHARED_KINDS: readonly JobKind[] = ["coding", "memory", "trigger"];
/** Approvals about the business itself (code, deploys, providers, trigger reviews); everything else is the requester's own. */
const SHARED_APPROVAL_ACTIONS: readonly string[] = ["coding.merge", "git.merge.protected", "git.push.production", "db.migrate.production", "provider.config.change", "trigger.review"];

type DeviceLike = { id: string; owner: string; kind: string; label: string; revokedAt?: number };
export type RegistryLike = { all(): DeviceLike[]; isOnline(d: DeviceLike): boolean; presenceOf?(id: string): { busy?: boolean } | undefined };
export type JobsLike = { subscribe(l: (e: JobEvent) => void): () => void; list(f?: { limit?: number }): JobSummary[]; head(): number; get(id: string): { kind: JobKind; targetDeviceId: string; principal?: { personId: string } } | null };
export type ApprovalsLike = { subscribe(l: (e: { type: "approval"; approval: Approval }) => void): () => void; list(f?: { state?: string; limit?: number }): Approval[] };
type LeaseEventLike = { type: string; lease?: Record<string, any>; computerId?: string; was?: Record<string, any> };
export type ComputersLike = {
  list(): Record<string, unknown>[];
  targets(person: PersonId): unknown[];
  leases: { subscribe(l: (e: LeaseEventLike) => void): () => void };
};

export type SourceDeps = {
  bus: ActivityBus;
  registry: () => RegistryLike;
  jobs?: () => JobsLike | null;
  approvals?: () => ApprovalsLike | null;
  computers?: ComputersLike | null;
  sampleMs?: number;
};

const isPerson = (v: unknown): v is PersonId => v === "usman" || v === "mehroz";

export function startActivitySources(deps: SourceDeps) {
  const { bus } = deps;
  const stops: (() => void)[] = [];

  const jobScopes = new Map<string, Scope>();
  /** Known device: its owner (shared computers: shared). Unknown or none: the requester's own person (fail closed). */
  const ownScope = (deviceId: string | undefined, requester: string | undefined): Scope => {
    const d = deviceId ? deps.registry().all().find((x) => x.id === deviceId) : undefined;
    if (d) return isPerson(d.owner) ? d.owner : "shared";
    return isPerson(requester) ? requester : "usman";
  };
  const jobScope = (jobId: string, kind?: JobKind, deviceId?: string, requester?: string): Scope => {
    const cached = jobScopes.get(jobId);
    if (cached) return cached;
    let k = kind;
    let dev = deviceId;
    let who = requester;
    if (!k || !who) {
      const job = deps.jobs?.()?.get(jobId);
      k = k ?? job?.kind;
      dev = dev ?? job?.targetDeviceId;
      who = who ?? job?.principal?.personId;
    }
    const scope: Scope = k && SHARED_KINDS.includes(k) ? "shared" : ownScope(dev, who);
    jobScopes.set(jobId, scope);
    if (jobScopes.size > 400) jobScopes.delete(jobScopes.keys().next().value as string);
    return scope;
  };
  const visible = (scope: Scope, person: PersonId) => scope === "shared" || scope === person;

  // --- jobs
  try {
    const jobs = deps.jobs?.();
    if (jobs)
      stops.push(
        jobs.subscribe((e) => {
          const scope = e.type === "job" ? jobScope(e.jobId, e.job.kind, e.job.targetDeviceId, e.job.principal?.personId) : jobScope(e.jobId);
          const final = e.type === "job" && TERMINAL_STATES.includes(e.job.state);
          bus.publish({ topic: "job", type: e.type, scope, final, data: { jobSeq: e.seq, event: publicView(e) } });
        }),
      );
  } catch {
    /* stores unavailable here (a quiet preview server): no job events, the rest still work */
  }

  const approvalScope = (a: Approval): Scope =>
    SHARED_APPROVAL_ACTIONS.includes(a.action) ? "shared" : ownScope(a.scope?.deviceId, a.requester?.personId);

  // --- approvals
  try {
    const approvals = deps.approvals?.();
    if (approvals)
      stops.push(
        approvals.subscribe(({ approval }) => {
          bus.publish({ topic: "approval", type: approval.state, scope: approvalScope(approval), final: approval.state !== "pending", data: { approval: publicView(approval) } });
        }),
      );
  } catch {
    /* as above */
  }

  // --- samplers: computers and device presence (time-based changes have no event of their own)
  const computerPrints = new Map<string, string>();
  const devicePrints = new Map<string, string>();
  let primed = false;
  function sample() {
    try {
      const seen = new Set<string>();
      for (const view of deps.computers?.list() ?? []) {
        const name = String(view.name);
        seen.add(name);
        // lastSeen and resource change every tick; the page reads them on its own slow refresh.
        const { lastSeen: _l, resource: _r, ...stable } = view as Record<string, unknown>;
        const print = JSON.stringify(stable);
        if (computerPrints.get(name) !== print) {
          computerPrints.set(name, print);
          if (primed) bus.publish({ topic: "computer", type: "changed", scope: "shared", data: { computer: publicView(view) } });
        }
      }
      for (const name of [...computerPrints.keys()])
        if (!seen.has(name)) {
          computerPrints.delete(name);
          if (primed) bus.publish({ topic: "computer", type: "removed", scope: "shared", data: { name } });
        }
      const registry = deps.registry();
      const present = new Set<string>();
      for (const d of registry.all()) {
        present.add(d.id);
        const online = registry.isOnline(d);
        const busy = registry.presenceOf?.(d.id)?.busy === true;
        const print = `${online}|${busy}|${d.label}|${d.revokedAt ?? ""}`;
        if (devicePrints.get(d.id) !== print) {
          devicePrints.set(d.id, print);
          if (primed) bus.publish({ topic: "device", type: online ? "online" : "offline", scope: isPerson(d.owner) ? d.owner : "shared", data: { id: d.id, label: d.label, kind: d.kind, owner: d.owner, online, busy } });
        }
      }
      for (const id of [...devicePrints.keys()]) if (!present.has(id)) devicePrints.delete(id);
    } catch {
      /* a sampling failure never takes the hub down; the next tick tries again */
    }
    primed = true;
  }
  sample();
  const timer = setInterval(sample, deps.sampleMs ?? 2_000);
  timer.unref?.();
  stops.push(() => clearInterval(timer));

  // --- leases (reduced: the viewer's session id never leaves the hub), then sample at once for the full view
  if (deps.computers)
    stops.push(
      deps.computers.leases.subscribe((e) => {
        const l = e.lease;
        const holder = (l?.holder ?? e.was) as { kind?: string; personId?: string; agent?: string } | undefined;
        bus.publish({
          topic: "lease",
          type: e.type,
          scope: "shared",
          data: {
            computerId: l?.computerId ?? e.computerId ?? null,
            holder: holder ? { kind: holder.kind ?? null, who: holder.kind === "person" ? (holder.personId ?? null) : (holder.agent ?? null) } : null,
            takeoverBy: l?.takeover?.by ?? null,
          },
        });
        sample();
      }),
    );

  /** Snapshot for one person: durable (jobs, approvals) plus live (computers, devices); scoped like the stream. */
  function snapshot(person: PersonId) {
    let jobsOut: unknown[] = [];
    let jobsHead = 0;
    let approvalsOut: unknown[] = [];
    let computersOut: unknown[] = [];
    let devicesOut: unknown[] = [];
    try {
      const jobs = deps.jobs?.();
      if (jobs) {
        jobsHead = jobs.head();
        jobsOut = jobs.list({ limit: 40 }).filter((j) => visible(jobScope(j.id, j.kind, j.targetDeviceId, j.principal?.personId), person)).slice(0, 20);
      }
    } catch {
      /* unavailable */
    }
    try {
      approvalsOut = (deps.approvals?.()?.list({ state: "pending", limit: 40 }) ?? []).filter((a) => visible(approvalScope(a), person)).slice(0, 20);
    } catch {
      /* unavailable */
    }
    try {
      computersOut = deps.computers?.list() ?? [];
      devicesOut = deps.computers?.targets(person) ?? [];
    } catch {
      /* unavailable */
    }
    return publicView({ jobs: jobsOut, jobsHead, approvals: approvalsOut, computers: computersOut, devices: devicesOut, at: Date.now() });
  }

  return {
    snapshot,
    /** Something in the Jarvis layer changed (events, timers, status, a protocol run): tell every client to refetch it. */
    jarvisChanged(what: "events" | "timers" | "status" | "protocol") {
      bus.publish({ topic: "jarvis", type: what, scope: "shared", data: { what } });
    },
    /** An agent said something or finished (builder V's conversation results also arrive through the job events). */
    agentMessage(input: { jobId?: string; agent: string; text: string; scope?: Scope; final?: boolean }) {
      bus.publish({ topic: "agent", type: "message", scope: input.scope ?? "shared", final: input.final === true, data: { jobId: input.jobId ?? null, agent: String(input.agent).slice(0, 60), text: maskJobText(input.text, 600) } });
    },
    /**
     * An entry was appended to a person's Jarvis conversation (a progress line, the returned research report, a job's end). The stream carries the
     * entry itself so an open tab shows it at once; `eventId` is stable (conversation + entry key) so a replay, a second tab or a reconnect applies it
     * once. A notification only: the durable conversation is the source of truth, and nothing here starts, resumes or re-runs a job.
     */
    threadEntry(input: { personId: string; conversationId: string; entry: { seq: number; key: string; at: string; jobId: string; state: string; text: string; jobKind?: string; blocker?: unknown } }) {
      if (!isPerson(input.personId)) return; // an unowned conversation is never broadcast
      const e = input.entry;
      const final = ["succeeded", "completed", "failed", "cancelled", "interrupted", "unknown", "report"].includes(e.state);
      bus.publish({
        topic: "thread",
        type: "entry",
        scope: input.personId,
        final,
        data: { conversationId: input.conversationId, eventId: `${input.conversationId}:${e.key}`, entry: { seq: e.seq, key: e.key, at: e.at, jobId: e.jobId, state: e.state, text: e.text, ...(e.jobKind ? { jobKind: e.jobKind } : {}), ...(e.blocker ? { blocker: e.blocker } : {}) } },
      });
    },
    /**
     * A CRM change was committed (scripts/crm/hub-integration.ts calls this from the store's own post-commit notification, once per change).
     * The payload is the record reference and the kind of change, never a field value: a tab refetches what it is allowed to read.
     */
    crmChanged(input: { ref: { kind: string; id: string }; change: string; at: string }) {
      const { ref, change, at } = input;
      if (!ref || typeof ref.kind !== "string" || typeof ref.id !== "string") return;
      bus.publish({ topic: "crm", type: String(change).slice(0, 24), scope: "shared", data: { ref: { kind: ref.kind.slice(0, 24), id: ref.id.slice(0, 160) }, change: String(change).slice(0, 24), at: String(at).slice(0, 40) } });
    },
    sampleNow: sample,
    stop() {
      for (const s of stops.splice(0)) s();
    },
  };
}
export type ActivitySources = ReturnType<typeof startActivitySources>;

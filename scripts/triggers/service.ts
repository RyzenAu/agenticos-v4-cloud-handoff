// The trigger service the OS mounts: seeds the built-in triggers, builds the Automations-page view, runs the
// periodic tick (routines, retries, approval sweep, one read-only poll of the receptionist feed) and answers
// the small HTTP API. Everything durable goes through the existing job and approval stores.
import type { ApprovalService } from "../approvals/service";
import type { JobService } from "../jobs/service";
import type { AgencyFeedState } from "../receptionist/types";
import type { ActionDeps } from "./actions";
import { TriggerEngine, type EngineOptions } from "./engine";
import { nextRunOf, tickRoutines } from "./routines";
import { pollReceptionistFlags, RECEPTIONIST_FLAG, SYNTHETIC_ENQUIRY, syntheticEnquiry, type PollResult } from "./sources";
import { TriggerStore, triggersDbPath } from "./store";
import type { DeliveryView, TriggerDef, TriggerHealth, TriggerState, TriggerView } from "./types";

export type TriggerServiceOptions = {
  root?: string;
  path?: string;
  jobs: JobService;
  approvals: ApprovalService;
  now?: () => number;
  /** Reads the receptionist agency feed (full view: flagged calls are projected to ids and codes). Absent = that source stays unpolled. */
  feed?: (force?: boolean) => Promise<AgencyFeedState>;
  deps?: ActionDeps;
  notifyCode?: (code: string, summary: string) => void;
  retryBackoffMs?: (attempt: number) => number;
  /** Agents workspace hooks (see TriggerEngine): the bot a routine runs as, and what to do with its job. */
  asBot?: EngineOptions["asBot"];
  onBotJob?: EngineOptions["onBotJob"];
};

export const SEED_IDS = { enquiry: "trg-synthetic-enquiry", flags: "trg-receptionist-flags", summary: "trg-morning-summary" } as const;

export class TriggerNotFound extends Error {}

export function createTriggerService(o: TriggerServiceOptions) {
  const now = o.now ?? Date.now;
  const store = new TriggerStore(o.path ?? triggersDbPath(o.root ?? process.cwd()), now);
  const engine = new TriggerEngine({ store, jobs: o.jobs, approvals: o.approvals, now, deps: o.deps, notifyCode: o.notifyCode, retryBackoffMs: o.retryBackoffMs, asBot: o.asBot, onBotJob: o.onBotJob });
  let lastPoll: (PollResult & { at: string }) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<unknown> | null = null;

  function seed() {
    // Insert-only: a restart never overwrites a trigger the owner has edited, paused or disabled.
    const add = (def: Parameters<TriggerStore["upsert"]>[0]) => void (store.get(def.id) ?? store.upsert(def));
    add({
      id: SEED_IDS.enquiry, name: "New enquiry: draft a reply", kind: "event", source: SYNTHETIC_ENQUIRY, action: "lead.process",
      conditions: [{ field: "ref", op: "exists" }], mode: "draft", retryLimit: 3, config: {},
    });
    // The one real source: receptionist QA flags. Review mode (nothing runs without trigger.review) and
    // paused until the owner switches it on: the first read of a real feed should be a decision.
    add({
      id: SEED_IDS.flags, name: "Receptionist QA flag: review task", kind: "event", source: RECEPTIONIST_FLAG, action: "flag.review",
      conditions: [{ field: "callId", op: "exists" }], mode: "review", retryLimit: 3, config: {}, state: "paused",
    });
    // Paused until the owner opts in from Automations: it reads the brief context and makes a job every morning, so it should be a choice.
    add({
      id: SEED_IDS.summary, name: "Morning business summary", kind: "routine", source: "routine.schedule", action: "brief.summary",
      conditions: [], mode: "draft", retryLimit: 2, offlinePolicy: "run-once", schedule: { kind: "daily", at: "07:30", tz: "Australia/Sydney" }, config: {}, state: "paused",
    });
  }

  function health(t: TriggerDef, failed: number): TriggerHealth {
    if (t.state !== "active") return t.state;
    return failed > 0 ? "failing" : "active";
  }
  function view(t: TriggerDef): TriggerView {
    const counts = store.counts(t.id);
    const last = store.deliveries(t.id, 1)[0] ?? null;
    const { config: _config, ...rest } = t;
    return {
      ...rest,
      health: health(t, counts.failed),
      stats: { delivered: store.stat(t.id, "delivered"), duplicates: store.stat(t.id, "duplicates"), ignored: store.stat(t.id, "ignored"), failed: counts.failed, pending: counts.pending },
      lastDelivery: last,
      lastRun: store.runs(t.id, 1)[0] ?? null,
      nextRunAt: t.kind === "routine" && t.state === "active" ? nextRunOf(t.schedule, now()) : null,
    };
  }

  function list(): TriggerView[] {
    return store.list().map(view);
  }
  function detail(id: string): { trigger: TriggerView; deliveries: DeliveryView[]; runs: ReturnType<TriggerStore["runs"]> } {
    const t = store.get(id);
    if (!t) throw new TriggerNotFound("No such trigger.");
    return { trigger: view(t), deliveries: store.deliveries(id, 20), runs: store.runs(id, 10) };
  }
  function setState(id: string, state: TriggerState) {
    if (!store.setState(id, state)) throw new TriggerNotFound("No such trigger.");
    return view(store.get(id)!);
  }

  /** One read-only poll of the receptionist feed now (the trigger must be active). Counts out, never contents. */
  async function pollNow(lookbackHours = 24): Promise<PollResult | { ok: false; reason: string }> {
    if (!o.feed) return { ok: false, reason: "The receptionist feed isn't connected." };
    if (store.get(SEED_IDS.flags)?.state !== "active") return { ok: false, reason: "That trigger is paused. Resume it first." };
    const hours = Math.min(Math.max(1, Math.floor(lookbackHours) || 24), 720);
    const result = await pollReceptionistFlags(engine, o.feed, { now: now(), lookbackMs: hours * 3600_000 });
    lastPoll = { ...result, at: new Date(now()).toISOString() };
    return result;
  }

  async function tick() {
    const at = now();
    const base = await engine.tick();
    const routines = await tickRoutines(engine, at);
    let poll: PollResult | null = null;
    const flagTrigger = store.get(SEED_IDS.flags);
    if (o.feed && flagTrigger?.state === "active") {
      try {
        poll = await pollReceptionistFlags(engine, o.feed, { now: at });
      } catch {
        poll = { ok: false, reason: "poll failed", seen: 0, jobs: 0, duplicates: 0, ignored: 0 };
      }
      lastPoll = { ...poll, at: new Date(at).toISOString() };
    }
    return { ...base, routines, poll };
  }
  /** Overlapping ticks (a slow job, a slow feed) never run at once. */
  function guardedTick() {
    if (ticking) return ticking;
    ticking = tick().finally(() => (ticking = null));
    return ticking;
  }

  /** Start the periodic tick (the owner process only). The first tick also finishes what a crash left half-way. */
  function start(intervalMs = 60_000) {
    if (timer) return;
    void guardedTick().catch(() => undefined);
    timer = setInterval(() => void guardedTick().catch(() => undefined), intervalMs);
    (timer as { unref?: () => void }).unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** The small HTTP API behind the Automations page. `local` = the request came from this PC. */
  async function handle(path: string, method: string, body: Record<string, unknown> | undefined, local: boolean): Promise<{ status: number; body: unknown }> {
    const refuse = () => ({ status: 403, body: { error: "Triggers can only be changed from this PC." } });
    try {
      if (path === "/triggers" && method === "GET") return { status: 200, body: { triggers: list(), poll: lastPoll } };
      const one = /^\/triggers\/(trg-[a-z0-9-]{1,30})$/.exec(path);
      if (one && method === "GET") return { status: 200, body: detail(one[1]) };
      if (method !== "POST") return { status: 404, body: { error: "Unknown triggers endpoint" } };
      if (!local) return refuse();
      const id = String(body?.id ?? "");
      if (path === "/triggers/pause") return { status: 200, body: { trigger: setState(id, "paused") } };
      if (path === "/triggers/resume") return { status: 200, body: { trigger: setState(id, "active") } };
      if (path === "/triggers/disable") return { status: 200, body: { trigger: setState(id, "disabled") } };
      if (path === "/triggers/retry") {
        const result = await engine.retry(Number(body?.deliveryId));
        return result ? { status: 200, body: { delivery: result } } : { status: 409, body: { error: "That delivery can't be retried (it isn't failed or waiting)." } };
      }
      if (path === "/triggers/synthetic") {
        const ref = typeof body?.ref === "string" && /^[A-Za-z0-9-]{3,30}$/.test(body.ref) ? body.ref : `SYN-${now().toString(36).toUpperCase()}`;
        // Only to demonstrate the loop guard: an event that says it came from our own work.
        const originRef = typeof body?.originRef === "string" && /^[A-Za-z0-9:.-]{1,60}$/.test(body.originRef) ? body.originRef : undefined;
        const actor = body?.actor === "agent" ? ("agent" as const) : undefined;
        const topic = typeof body?.topic === "string" ? body.topic.slice(0, 80) : "Check-up";
        return { status: 200, body: { results: await engine.deliver(syntheticEnquiry(ref, topic, { ...(originRef ? { originRef } : {}), ...(actor ? { actor } : {}) })) } };
      }
      if (path === "/triggers/poll") return { status: 200, body: await pollNow(Number(body?.lookbackHours ?? 24)) };
      if (path === "/triggers/tick") return { status: 200, body: await guardedTick() };
      return { status: 404, body: { error: "Unknown triggers endpoint" } };
    } catch (error) {
      if (error instanceof TriggerNotFound) return { status: 404, body: { error: error.message } };
      return { status: 500, body: { error: "The trigger request failed." } };
    }
  }

  seed();
  return { store, engine, pollNow, list, detail, setState, tick: guardedTick, start, stop, handle, seed, lastPoll: () => lastPoll, close: () => (stop(), store.close()) };
}
export type TriggerService = ReturnType<typeof createTriggerService>;

import type { NabStatus, NabSyntheticService, OwnerContext } from "./service";

export type NabTimers = { now: () => number; set: (fn: () => void, delay: number) => unknown; clear: (handle: unknown) => void };
export const browserNabTimers: NabTimers = { now: Date.now, set: (fn, delay) => setTimeout(fn, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/** UI invalidation only: never refreshes/imports/provider-fetches. Handles suspended tabs on focus. */
export function subscribeNabStatus(service: NabSyntheticService, ctx: OwnerContext, emit: (status: NabStatus) => void,
  focus: EventTarget, visibility: EventTarget, timers: NabTimers = browserNabTimers) {
  let handle: unknown, stopped = false;
  const update = () => {
    if (stopped) return;
    if (handle !== undefined) timers.clear(handle);
    const status = service.status(ctx); emit(status);
    const deadlines = [status.consentExpiresAt, status.lastSyncAt ? new Date(Date.parse(status.lastSyncAt) + 86400000).toISOString() : null]
      .filter((value): value is string => value !== null).map(Date.parse).filter(time => time > timers.now());
    const delay = Math.min(60000, ...deadlines.map(time => time - timers.now()));
    handle = timers.set(update, Math.max(1, delay));
  };
  focus.addEventListener("focus", update); visibility.addEventListener("visibilitychange", update); update();
  return () => { stopped = true; if (handle !== undefined) timers.clear(handle); focus.removeEventListener("focus", update); visibility.removeEventListener("visibilitychange", update); };
}

/** Optional memory-only synthetic scheduler. Constructing does nothing; start requires explicit opt-in. */
export function createNabSyntheticScheduler(service: NabSyntheticService, owner: OwnerContext, timers: NabTimers = browserNabTimers) {
  const ctx = { ...owner }; let handle: unknown, running = false, generation = -1;
  function stop() { running = false; if (handle !== undefined) timers.clear(handle); handle = undefined; }
  function tick() {
    if (!running) return;
    const status = service.status(ctx);
    if (status.generation !== generation || !status.nextRefreshAt || ["expired", "revoked"].includes(status.phase)) { stop(); return; }
    if (Date.parse(status.nextRefreshAt) <= timers.now()) {
      try { service.refresh(ctx, { generation }); } catch { stop(); return; }
    }
    const next = service.status(ctx);
    const deadline = Math.min(Date.parse(next.nextRefreshAt!), Date.parse(next.consentExpiresAt!));
    handle = timers.set(tick, Math.max(1, Math.min(60000, deadline - timers.now())));
  }
  return {
    start(input: { acknowledgement: "synthetic-only"; generation: number }) {
      if (input.acknowledgement !== "synthetic-only") throw new Error("SYNTHETIC_OPT_IN_REQUIRED");
      const status = service.status(ctx);
      if (!status.nextRefreshAt || status.generation !== input.generation) throw new Error("CONSENT_REQUIRED");
      stop(); running = true; generation = input.generation; tick();
    }, stop,
    running: () => running,
  };
}

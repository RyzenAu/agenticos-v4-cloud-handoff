import type { NextItem, WireCommand } from "../scripts/devices/dispatch";
import { isExecutorResult, type ExecutorResult } from "../scripts/jarvis-command/contracts";
import type { PersonId } from "../scripts/devices/types";
import { defaultExecutors, gate, type Executor } from "./executors";
import type { MicLock } from "./mic-lock";

/**
 * The companion worker: runs on a person's own PC, connects OUT to the OS over the tailnet
 * (Tailscale Serve, https://<hub>.ts.net:8443) and never opens a port of its own.
 *
 * - heartbeat every 10 s (device id, mic ownership, busy);
 * - long-polls for commands addressed to this device only (the hub routes; the bearer token
 *   and the Tailscale login both have to match this device's owner);
 * - runs one command at a time through the local allow-list (executors.ts), and cancels it
 *   when the hub says so; the result goes back as an ExecutorResult (ok, said, verified, evidence);
 * - two missed heartbeats → "offline": stops taking commands and aborts anything running (fail
 *   closed: the hub has already failed it), then reconnects with backoff (up to 30 s). A command
 *   that arrives while the hub counts as lost never runs; nothing queued runs later by surprise;
 * - microphone: claimMic()/releaseMic() report the change at once; the heartbeat always says
 *   whether this process holds the mic right now (a free lock is re-claimed unless released on purpose);
 * - a revoked/expired pairing → "unpaired": stops for good (onState tells main to exit).
 */

export type CompanionState = "starting" | "online" | "offline" | "unpaired" | "stopped";
export type HistoryEntry = { id: string; executor: string; outcome: "done" | "refused" | "failed" | "cancelled"; detail?: string };

export type WorkerOptions = {
  hubUrl: string;
  token: string;
  deviceId: string;
  owner: PersonId;
  executors?: Record<string, Executor>;
  micLock?: MicLock | null;
  heartbeatMs?: number;
  pollWaitMs?: number;
  offlineAfterMisses?: number;
  /** Tests only: pose as the Serve-relayed tailnet host on a loopback hub. */
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  version?: string;
  /** Re-claim the mic on a heartbeat when its lock is free (default true when a lock is given). */
  micAutoClaim?: boolean;
  /** Every state change (main exits on "unpaired"). */
  onState?: (state: CompanionState) => void;
};

/** What a finished command posts back to the hub: always an ExecutorResult. Pure. */
export function resultPost(commandId: string, output: unknown): { commandId: string; ok: boolean; output: ExecutorResult; error?: string } {
  const result: ExecutorResult = isExecutorResult(output)
    ? output
    : { ok: true, said: "Done.", verified: null, data: output && typeof output === "object" ? (output as Record<string, unknown>) : { value: output ?? null } };
  return result.ok ? { commandId, ok: true, output: result } : { commandId, ok: false, output: result, error: result.said.slice(0, 500) };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class CompanionWorker {
  private _state: CompanionState = "starting";
  get state(): CompanionState {
    return this._state;
  }
  set state(next: CompanionState) {
    if (next === this._state) return;
    this._state = next;
    try {
      this.opts.onState?.(next);
    } catch {
      /* a listener's problem, not the worker's */
    }
  }
  readonly history: HistoryEntry[] = [];
  private stopper = new AbortController();
  private running?: { id: string; controller: AbortController };
  private misses = 0;
  private micReleased = false;
  private loops: Promise<void>[] = [];
  private onlineWaiters: (() => void)[] = [];
  private readonly executors: Record<string, Executor>;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly heartbeatMs: number;
  private readonly pollWaitMs: number;
  private readonly offlineAfter: number;

  constructor(private readonly opts: WorkerOptions) {
    this.executors = opts.executors ?? defaultExecutors();
    this.fetch = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((line) => console.log(`[companion] ${line}`));
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.pollWaitMs = opts.pollWaitMs ?? 25_000;
    this.offlineAfter = opts.offlineAfterMisses ?? 2;
  }

  status() {
    return { state: this.state, deviceId: this.opts.deviceId, owner: this.opts.owner, micOwned: this.opts.micLock?.owned() ?? false, micHolder: this.opts.micLock?.holder() ?? null, busy: !!this.running, runningCommand: this.running?.id ?? null };
  }

  start() {
    const mic = this.opts.micLock;
    if (mic && !mic.claim()) this.log(`microphone is held by another process (pid ${mic.holder() ?? "?"}); voice stays with it`);
    this.loops = [this.heartbeatLoop(), this.pollLoop()];
    return this;
  }

  /** Take the mic for Jarvis on this PC (if free) and tell the hub now. */
  async claimMic() {
    this.micReleased = false;
    const owned = this.opts.micLock ? this.opts.micLock.claim() : false;
    if (this.state === "online") await this.beat().catch(() => undefined);
    return owned;
  }

  /** Give the mic back and tell the hub now (it stops counting this PC as the mic owner). */
  async releaseMic() {
    this.micReleased = true;
    this.opts.micLock?.release();
    if (this.state === "online") await this.beat().catch(() => undefined);
  }

  /** Whether this process holds the mic right now (re-claims a free lock unless released on purpose). */
  private micNow() {
    const mic = this.opts.micLock;
    if (!mic) return false;
    if (mic.owned()) return true;
    if (this.opts.micAutoClaim !== false && !this.micReleased && mic.holder() === null) return mic.claim();
    return false;
  }

  private beat() {
    return this.call("POST", "/companion/heartbeat", { micOwned: this.micNow(), busy: !!this.running, version: this.opts.version ?? "0.1.0" }, AbortSignal.timeout(8_000));
  }

  async stop() {
    if (this.state === "stopped") return;
    const wasOnline = this.state === "online";
    this.state = "stopped";
    this.running?.controller.abort();
    this.stopper.abort();
    this.wakeOnline();
    if (wasOnline) await this.call("POST", "/companion/goodbye", {}).catch(() => undefined);
    this.opts.micLock?.release();
    await Promise.allSettled(this.loops);
  }

  /** Resolves once the first heartbeat succeeds (or the worker stops). */
  async waitOnline(timeoutMs = 5_000) {
    if (this.state === "online") return true;
    await Promise.race([new Promise<void>((r) => this.onlineWaiters.push(r)), sleep(timeoutMs)]);
    return (this.state as CompanionState) === "online"; // may have changed while waiting
  }

  private wakeOnline() {
    const waiters = this.onlineWaiters.splice(0);
    for (const w of waiters) w();
  }

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const res = await this.fetch(new URL(`/__devices${path}`, this.opts.hubUrl).href, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.opts.extraHeaders ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return { status: res.status, json };
  }

  private unpaired(reason: string) {
    if (this.state === "unpaired" || this.state === "stopped") return;
    this.state = "unpaired";
    this.log(`pairing no longer valid (${reason}); run "pair" again with a new code`);
    this.running?.controller.abort();
    this.stopper.abort();
    this.wakeOnline();
  }

  private goOffline(reason: string) {
    if (this.state === "offline" || this.state === "stopped" || this.state === "unpaired") return;
    this.state = "offline";
    this.log(`hub unreachable (${reason}); not taking commands until it's back`);
    // Fail closed: the hub has already failed anything in flight for an offline device.
    this.running?.controller.abort();
  }

  private async heartbeatLoop() {
    while (!this.stopper.signal.aborted) {
      try {
        const { status, json } = await this.beat();
        if (status === 401 || status === 403) {
          this.unpaired(json?.error ?? `HTTP ${status}`);
          return;
        }
        if (status !== 200) throw new Error(`HTTP ${status}`);
        this.misses = 0;
        if (this.state !== "online" && this.state !== "stopped") {
          this.state = "online";
          this.log(`online as ${this.opts.deviceId} (${this.opts.owner})`);
          this.wakeOnline();
        }
      } catch (error: any) {
        if (this.stopper.signal.aborted) return;
        this.misses++;
        if (this.misses >= this.offlineAfter) this.goOffline(error?.message ?? "no answer");
      }
      // Offline: back off 1x, 2x, then 4x the heartbeat interval (10 s, 20 s, 30 s cap in production).
      const backoff = this.state === "offline" ? Math.min(this.heartbeatMs * 2 ** Math.min(Math.max(this.misses - this.offlineAfter, 0), 2), 30_000) : this.heartbeatMs;
      await sleep(backoff, this.stopper.signal);
    }
  }

  private async pollLoop() {
    while (!this.stopper.signal.aborted) {
      if (this.state !== "online") {
        await Promise.race([new Promise<void>((r) => this.onlineWaiters.push(r)), sleep(this.heartbeatMs, this.stopper.signal)]);
        continue;
      }
      try {
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.stopper.signal.addEventListener("abort", abort, { once: true });
        const { status, json } = await this.call("GET", `/companion/next?wait=${this.pollWaitMs}`, undefined, controller.signal).finally(() =>
          this.stopper.signal.removeEventListener("abort", abort),
        );
        if (status === 401 || status === 403) {
          this.unpaired(json?.error ?? `HTTP ${status}`);
          return;
        }
        if (status !== 200) throw new Error(`HTTP ${status}`);
        const item = json?.item as NextItem | null;
        if (item?.type === "cancel") this.cancel(item.commandId);
        else if (item?.type === "command") {
          // Arrived while this PC counts the hub as lost (a long-poll answering across the drop): the hub
          // fails anything in flight for an offline device, so it never runs late; say so if the hub can hear.
          // (Online again, a delivery is current: the hub only hands out commands it is still waiting on.)
          if (this.state !== "online") {
            this.history.push({ id: item.command.id, executor: item.command.executor, outcome: "failed", detail: "arrived across a disconnect; not run" });
            this.log(`not running ${item.command.executor}: it arrived across a disconnect`);
            const said = "This PC was offline when that arrived, so it didn't run.";
            void this.call("POST", "/companion/result", { commandId: item.command.id, ok: false, error: said, output: { ok: false, said, verified: false } }).catch(() => undefined);
          } else void this.execute(item.command);
        }
      } catch {
        if (this.stopper.signal.aborted) return;
        await sleep(Math.min(this.heartbeatMs, 2_000), this.stopper.signal);
      }
    }
  }

  private cancel(commandId: string) {
    if (this.running?.id === commandId) {
      this.log(`cancelling ${commandId}`);
      this.running.controller.abort();
    }
  }

  private async refuse(command: WireCommand, reason: string) {
    this.history.push({ id: command.id, executor: command.executor, outcome: "refused", detail: reason });
    this.log(`refused ${command.executor}: ${reason}`);
    const output: ExecutorResult = { ok: false, said: reason, verified: false, data: { refused: true } };
    await this.call("POST", "/companion/result", { commandId: command.id, ok: false, error: reason, output }).catch(() => undefined);
  }

  private async execute(command: WireCommand) {
    const decision = gate(command, this.opts.owner, this.executors);
    if (!decision.ok) return this.refuse(command, decision.reason);
    // One at a time: never two actions on this PC's screen at once.
    if (this.running) return this.refuse(command, "This PC is still finishing another command.");
    const controller = new AbortController();
    this.running = { id: command.id, controller };
    try {
      const output = await decision.run(command.args ?? {}, { signal: controller.signal, owner: this.opts.owner, log: this.log });
      if (controller.signal.aborted) throw new Error("Cancelled.");
      const post = resultPost(command.id, output);
      this.history.push({ id: command.id, executor: command.executor, outcome: post.ok ? "done" : "failed", ...(post.ok ? {} : { detail: post.output.said }) });
      if (this.state === "online") await this.call("POST", "/companion/result", post).catch(() => undefined);
    } catch (error: any) {
      const cancelled = controller.signal.aborted;
      this.history.push({ id: command.id, executor: command.executor, outcome: cancelled ? "cancelled" : "failed", detail: error?.message });
      const said = cancelled ? "Cancelled." : String(error?.message ?? "Failed").slice(0, 500);
      const output: ExecutorResult = { ok: false, said, verified: false, ...(cancelled ? { data: { cancelled: true } } : {}) };
      if (this.state === "online") await this.call("POST", "/companion/result", { commandId: command.id, ok: false, error: said, output }).catch(() => undefined);
    } finally {
      if (this.running?.id === command.id) this.running = undefined;
    }
  }
}

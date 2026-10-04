import { gate, type Executor } from "../../companion/executors";
import type { ExecutorResult } from "../jarvis-command/contracts";
import { Dispatcher } from "./dispatch";
import { DeviceRegistry } from "./registry";
import type { PersonId, TargetDevice } from "./types";

/**
 * SYNTHETIC devices for tests only. Nothing here is a real machine, pairing, token, Tailscale login or
 * Windows app: ids and labels say SYNTHETIC on purpose so a fixture can never be mistaken for a paired PC.
 *
 *   Usman's hub      the PC that runs the OS (kind "hub"; always online while the server runs)
 *   Mehroz's PC      a companion owned by Mehroz (kind "companion"), answered by SyntheticCompanion below
 *
 * SyntheticCompanion is the whole companion loop in process: it heartbeats, takes commands from the real
 * Dispatcher for ITS device only, checks them with the REAL companion allow-list gate (companion/executors.ts
 * gate), runs fake executors and posts a result. It proves routing, ownership and fail-closed behaviour; it
 * does not prove Windows, PowerPoint, the pairing HTTP flow or Tailscale (docs/DEVICE-TARGET-CONTRACT.md).
 */

export const SYNTHETIC = true as const;
export const SYNTHETIC_USMAN_HUB_ID = "synthetic-usman-hub";
export const SYNTHETIC_MEHROZ_PC_ID = "synthetic-mehroz-pc";

export function syntheticDevices(): TargetDevice[] {
  return [
    { id: SYNTHETIC_USMAN_HUB_ID, owner: "usman", kind: "hub", label: "Usman's PC [SYNTHETIC hub]", aliases: ["pc", "desktop", "computer", "main pc"], primary: true },
    { id: SYNTHETIC_MEHROZ_PC_ID, owner: "mehroz", kind: "companion", label: "Mehroz's PC [SYNTHETIC companion]", aliases: ["pc", "computer", "windows pc", "desktop"], primary: true, pairedAt: 0 },
  ];
}

/** A fake clock the tests move by hand (presence and approvals read it). */
export function syntheticClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export type RanCall = { executor: string; args: Record<string, unknown>; personId: PersonId };

/** Fake executors: each says SYNTHETIC in its result and reports a passed check, like the real ones do after a real action. */
export function syntheticExecutors(ran: RanCall[], owner: PersonId): Record<string, Executor> {
  const done = (said: string, data: Record<string, unknown>): ExecutorResult => ({ ok: true, said: `${said} (SYNTHETIC: nothing was launched)`, verified: true, evidence: "synthetic check", data });
  const record = (executor: string, args: Record<string, unknown>) => void ran.push({ executor, args: { ...args }, personId: owner });
  return {
    echo: async (args) => (record("echo", args), done("Echoed.", { echoed: String(args.text ?? "") })),
    "app.open": async (args) => (record("app.open", args), done(`Opened ${String(args.name ?? "the app")}.`, { app: String(args.name ?? "") })),
    "deck.blank": async (args) => (record("deck.blank", args), done(`Started a new presentation titled "${String(args.title ?? "")}".`, { title: String(args.title ?? "") })),
    "open-url": async (args) => (record("open-url", args), done("Opened the page.", { url: String(args.url ?? "") })),
    wait: async (args, ctx) => {
      record("wait", args);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(Number(args.ms) || 0, 5_000));
        ctx.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
      return ctx.signal.aborted ? { ok: false, said: "Stopped (SYNTHETIC).", verified: false } : done("Waited.", {});
    },
  };
}

/** The in-process companion loop for one synthetic companion device. */
export class SyntheticCompanion {
  readonly ran: RanCall[] = [];
  readonly refused: string[] = [];
  private up = true;
  private running = false;
  private current?: AbortController;
  private loopDone?: Promise<void>;

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly registry: DeviceRegistry,
    readonly deviceId: string,
    readonly owner: PersonId,
    private readonly executors: Record<string, Executor> = syntheticExecutors(this.ran, owner),
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    if (this.running) return this;
    this.running = true;
    this.loopDone = this.loop();
    return this;
  }

  async stop() {
    this.running = false;
    this.current?.abort();
    this.dispatcher.deviceOffline(this.deviceId);
    await this.loopDone;
  }

  /** The PC went away (sleep, network loss): no heartbeats, no commands taken; the hub marks it offline at once. */
  goOffline() {
    this.up = false;
    this.current?.abort();
    this.dispatcher.deviceOffline(this.deviceId);
  }

  goOnline() {
    this.up = true;
    this.registry.heartbeat(this.deviceId, { version: "synthetic" });
  }

  private async loop() {
    this.registry.heartbeat(this.deviceId, { version: "synthetic" });
    while (this.running) {
      if (!this.up) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      this.registry.heartbeat(this.deviceId, { version: "synthetic" });
      const item = await this.dispatcher.next(this.deviceId, 10);
      if (!item) continue;
      if (item.type === "cancel") {
        this.current?.abort();
        continue;
      }
      // The synthetic PC keeps no ledger, so it can't answer "did that happen?": leaving the hub's observe request
      // unanswered lets it settle the outcome as unknown, which is the honest answer (never a replay).
      if (item.type === "observe") continue;
      const cmd = item.command;
      const allowed = gate(cmd, this.owner, this.executors, this.now());
      if (!allowed.ok) {
        this.refused.push(allowed.reason);
        this.dispatcher.complete(this.deviceId, cmd.id, { ok: false, error: allowed.reason });
        continue;
      }
      const controller = (this.current = new AbortController());
      try {
        const output = (await allowed.run(cmd.args, { signal: controller.signal, owner: this.owner, log: () => undefined })) as ExecutorResult;
        this.dispatcher.complete(this.deviceId, cmd.id, output.ok ? { ok: true, output } : { ok: false, output, error: output.said });
      } catch (error) {
        this.dispatcher.complete(this.deviceId, cmd.id, { ok: false, error: String((error as Error)?.message ?? error) });
      } finally {
        this.current = undefined;
      }
    }
  }
}

/** The whole synthetic world: registry, dispatcher, Mehroz's companion, on one fake clock. */
export function syntheticWorld(opts: { start?: boolean } = {}) {
  const clock = syntheticClock();
  const devices = syntheticDevices();
  const registry = new DeviceRegistry(() => devices, clock.now);
  const dispatcher = new Dispatcher(registry, clock.now);
  const mehroz = new SyntheticCompanion(dispatcher, registry, SYNTHETIC_MEHROZ_PC_ID, "mehroz", undefined, clock.now);
  if (opts.start !== false) mehroz.start();
  return {
    SYNTHETIC,
    clock,
    devices,
    registry,
    dispatcher,
    mehroz,
    async close() {
      await mehroz.stop();
      dispatcher.close();
    },
  };
}

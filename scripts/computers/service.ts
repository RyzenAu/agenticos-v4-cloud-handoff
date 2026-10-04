import { randomUUID } from "node:crypto";
import { isRisky } from "../devices/dispatch";
import type { DevicesService } from "../devices/service";
import { isPersonId, isSharedComputer, type PersonId, type TargetDevice } from "../devices/types";
import type { ExecutorResult } from "../jarvis-command/contracts";
import { isExecutorResult } from "../jarvis-command/contracts";
import type { ExecutorContext, JobService } from "../jobs/service";
import type { Principal as JobPrincipal } from "../approvals/principal";
import { LeaseManager, type LeaseEvent } from "./lease";
import { runGoalLoop, type ActOutcome, type ControlAsk, type PageObservation } from "./goal-loop";
import { RESEARCH_EXECUTOR, runResearch, type CallResult, type Delegate, type SearchFn } from "./research";
import type { ArtifactStore } from "./artifacts";
import { NEEDS, isWorkflowExecutor, researchArtifact, runWorkflow, validateWorkflowStep } from "./workflows";
import { WORKFLOW_LABEL, type WorkflowIO } from "./workflows/common";
import { mayControl, mayTakeOver, permittedTargets } from "./permissions";
import { NEXT_LABEL, SCREEN_OK_RESET_MS, diagnoseScreen, screenRetryDelayMs, screenRetryDue, type ScreenEvidence, type ScreenFault, type ScreenView } from "./screen";
import { ComputerStore, validComputerName, type ComputerRecord } from "./store";
import { createTerminals, type TerminalPerson } from "./terminal";
import { holderKey, type AdapterHandle, type ComputerSpec, type ComputerState, type ComputerView, type HubComputerView, type DesiredState, type HostCheck, type ProbeResult, type ProvisioningAdapter, type Snapshot, type VncStream } from "./types";

/**
 * The computers service: shared agent cloud computers as devices in the ONE registry, their lifecycle through a
 * provisioning adapter, and every command to one through a control lease.
 *
 *  - provision: a founder (a confirmed session) asks for a computer by name. The hub makes a one-time pairing code bound to
 *    that name, the adapter creates the isolated desktop (own display, browser profile, working folder) and its companion
 *    pairs with the code: a device of kind "cloud-computer", owner "shared".
 *  - jobs: an agent job holds the computer's lease, dispatches its steps through the same dispatcher every PC uses
 *    (commandKey jobId/stepId, expiry, cancel, observe-before-retry), and is paused at a step boundary by a takeover.
 *  - lifecycle: start / stop / suspend / resume / recover / destroy, and a monitor that notices a dead companion (state
 *    `failed`) and restarts it without re-pairing and without replaying a step.
 *
 * Permissions are not re-invented here: who may target what is scripts/devices/route.ts (resolveTarget), and this service only
 * asks it, through the dispatcher, for every command it sends.
 */

export type ComputersOptions = {
  root: string;
  devices: Pick<DevicesService, "registry" | "dispatcher" | "store">;
  jobs: () => JobService;
  adapters: Record<string, ProvisioningAdapter & { installBundle?: (localPath: string) => Promise<void> }>;
  /** The address a computer's companion uses to reach the hub (the bridge, for WSL). */
  hubUrlFor: (adapterKind: string, adapter: ProvisioningAdapter) => string | Promise<string>;
  /** Where the built companion bundle is (built on demand by `buildBundle`, then installed on each host). */
  bundlePath?: string;
  buildBundle?: (outfile: string) => Promise<void>;
  now?: () => number;
  agentLeaseTtlMs?: number;
  personLeaseTtlMs?: number;
  monitorMs?: number;
  autoRecover?: boolean;
  maxAutoRecoveries?: number;
  /** How long a recovered computer must stay healthy before its automatic-recovery allowance is restored (default 120 s). */
  recoveryHealthyMs?: number;
  /** How long a failed computer stays failed before the monitor restarts it (default 2 s: no thrashing, and the state is visible). */
  recoverDelayMs?: number;
  /** Suspend a computer that has been idle (no lease held, no job) this long. 0 or unset: never (the default: an owner decision, as it costs a wake-up). */
  idleSuspendMs?: number;
  startGraceMs?: number;
  /** After a person's last viewer socket on a computer closes, how long to wait for it to come back before their control is released (default 5 s). */
  viewerCloseGraceMs?: number;
  stepTimeoutMs?: number;
  /** How long a finished workflow waits for its result to be posted to the conversation before the job settles anyway (default 20 s): a slow or stuck conversation store never leaves a finished job "working". */
  deliverTimeoutMs?: number;
  store?: ComputerStore;
  /**
   * Jev, asked ON THE HUB (the key never reaches a computer), for the open-ended goal loop (a step with executor "goal"). Null/absent:
   * a goal step is refused up front with that reason.
   */
  goalAsk?: ControlAsk | null;
  /**
   * Bounded research (a step with executor "research", research.ts): `search` finds candidate pages (the hub's SearXNG), `delegate` is a connected
   * model for what Jev can't do or isn't sure of, `deliver` appends the finished report to the conversation the job came from. Absent: refused up front.
   */
  research?: {
    search: SearchFn | null;
    delegate: Delegate | null;
    deliver(input: { jobId: string; by: PersonId; title: string; report: string; file?: string | null; /** The saved result's title when the hub kept one (the entry then says it opens from the OS). */ artifact?: string | null; /** What kind of result this is, for the entry's heading. */ label?: string; /** Text read from public pages (research, a site audit) is labelled as data, not instructions. */ web?: boolean }): Promise<{ delivered: boolean; where: string }>;
  };
  /**
   * Saved results (research, builder, website audit, business preparation): one artifact per job on the hub, opened from the OS. Absent: workflow
   * steps other than research are refused up front, and research keeps its report on the computer and in the conversation only.
   */
  artifacts?: ArtifactStore;
  /** How long after the first delivery gave up it is tried once more (default 60 s; it is replay-safe, so a late original and the retry never post twice). */
  deliverRetryMs?: number;
  /** The workflows' model (a connected model on the free route) and the sites a website audit may open: exact host names (default: M&U's own demo site). */
  /**
   * The model for ONE job whose bot has a model preference (Agents workspace): "free-only" or a catalogue model id. Called when the job reaches a step that
   * uses a model (research, builder, business preparation); `note` writes a masked line on the job (which model answered, or that none did). Absent, or a
   * route of "auto": the default `delegate`, exactly as before.
   */
  routeDelegate?: (route: string, note: (text: string) => void) => Delegate | null;
  workflows?: { delegate: Delegate | null; allowedAuditHosts?: string[]; /** Plain words for where a computer runs ("Ryzen-PC (LAN host, WSL)"), shown on its saved results. */ hostLabel?: (adapter: string, computer: string) => string };
};

export type JobStepInput = { executor: string; args?: Record<string, unknown>; timeoutMs?: number };
export type ComputerEvent = { at: number; computer: string; type: string; detail?: string };

export const MAX_COMPUTER_STEPS = 40;
/** A hub-side step: an open-ended goal, run as observe, Jev decides on the hub, act, verify (goal-loop.ts). */
export const GOAL_EXECUTOR = "goal";
export { RESEARCH_EXECUTOR };
const MAX_ARG_BYTES = 8_000;
const EXECUTOR = /^[a-z][a-z0-9._-]{0,63}$/i;

export function createComputersService(options: ComputersOptions) {
  const now = options.now ?? Date.now;
  const { devices } = options;
  const registry = devices.registry;
  const dispatcher = devices.dispatcher;
  const store = options.store ?? new ComputerStore(options.root);
  const leases = new LeaseManager(now, options.agentLeaseTtlMs, options.personLeaseTtlMs);
  const startGraceMs = options.startGraceMs ?? 120_000;
  const autoRecover = options.autoRecover ?? true;
  const maxAuto = options.maxAutoRecoveries ?? 3;
  const events: ComputerEvent[] = [];
  const probes = new Map<string, ProbeResult>();
  const recovering = new Set<string>();
  const active = new Map<string, { promise: Promise<unknown>; computer: string }>();
  const prepared = new Set<string>();
  /** What proves a computer's screen: the last real frame through the viewer, the last screenshot that came back, the viewer's own failures. In memory: a restarted hub re-proves it. */
  const evidence = new Map<string, ScreenEvidence & { live?: number }>();
  /** Automatic restarts of the display layers: how many, when the next is due, and when the screen was last seen working. */
  const screenRetries = new Map<string, { used: number; nextAt: number | null; lastAt: number; history: number[] }>();
  /** When a screen layer was first seen down (the first automatic restart waits from here). */
  const screenFirst = new Map<string, { layer: string; since: number }>();
  /** What the computer's companion was last told about a person holding it (so the host is only asked on a change). */
  const holdSent = new Map<string, boolean>();
  /** Consecutive failed sends of the same hold state (bounded: a host that stays unreachable is not asked on every tick for ever). */
  const holdFails = new Map<string, { held: boolean; n: number }>();
  const shotInFlight = new Set<string>();
  /** Which screen layers each computer has been seen with working (from the host's probe): only a layer that DIED is restarted automatically. */
  const layersSeen = new Map<string, Set<string>>();
  const deliverMs = options.deliverTimeoutMs ?? 20_000;
  /** The conversation delivery is a courtesy after the work is saved: it never holds the job open. */
  const deliverRetryMs = options.deliverRetryMs ?? 60_000;
  /**
   * The delivery is tried; after `deliverMs` the job settles anyway ("didn't answer in time"). If that attempt lands LATER, the job's note is corrected (it said the result
   * was not delivered); if it never does, it is tried ONCE more after `deliverRetryMs` (the conversation store's key makes a repeat harmless) and a landing then corrects
   * the note the same way.
   */
  const deliveryRetries = new Set<ReturnType<typeof setTimeout>>();
  const boundedDelivery = <T extends { delivered: boolean; where: string }>(jobId: string, call: () => Promise<T>, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      let timedOut = false;
      let corrected = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const landed = (v: T) => {
        if (!timedOut || corrected || !v.delivered) return;
        corrected = true;
        if (retry) { clearTimeout(retry); deliveryRetries.delete(retry); }
        try {
          const jobs = options.jobs();
          const was = jobs.get(jobId)?.note ?? "";
          jobs.amendNote(jobId, `${was ? was.replace(/\s*\(?the conversation didn't answer in time\)?\.?$/i, "") + " " : ""}The result reached your conversation after the job ended (${v.where}).`.trim());
        } catch {
          /* the job store is unavailable: the saved result is still listed */
        }
      };
      const t = setTimeout(() => {
        timedOut = true;
        resolve(fallback);
        // Promise.resolve().then(call): a synchronous throw inside call() (e.g. the job store closing) stays inside the promise, never
        // an uncaught exception in a timer; and close() clears pending retries.
        retry = setTimeout(() => {
          if (retry) deliveryRetries.delete(retry);
          if (closed) return;
          void Promise.resolve().then(call).then(landed, () => undefined);
        }, deliverRetryMs);
        deliveryRetries.add(retry);
        (retry as { unref?: () => void }).unref?.();
      }, deliverMs);
      (t as { unref?: () => void }).unref?.();
      call().then(
        (v) => (timedOut ? landed(v) : (clearTimeout(t), resolve(v))),
        () => (timedOut ? undefined : (clearTimeout(t), resolve(fallback))),
      );
    });
  const jobMeta = new Map<string, { computer: string; title: string; agent: string; by: PersonId; /** The bot's model route for this job ("auto", "free-only", a catalogue model id). */ route?: string; /** The bot's standing instructions and recalled background, added to every model prompt of this job. */ context?: string }>();
  /** When each computer was last used (a lease taken, held or released): idle suspend counts from here. */
  const lastActive = new Map<string, number>();
  let monitor: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  function log(computer: string, type: string, detail?: string) {
    events.push({ at: now(), computer, type, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    if (events.length > 500) events.splice(0, events.length - 500);
  }

  // ---------------------------------------------------------------- the lease is enforced where a command is queued
  dispatcher.guard = (device, input) => {
    if (!input.lease) return "A shared computer needs its control lease first: start a computer job, or take control of it.";
    return leases.valid(device.id, input.lease.holder, input.lease.epoch) ? null : "You don't hold this computer's control right now (someone else does, or your lease ended), so nothing was sent.";
  };

  leases.subscribe((e: LeaseEvent) => {
    const name = nameOfDevice(e.type === "released" ? e.computerId : e.lease.computerId);
    if (!name) return;
    lastActive.set(name, now());
    queueMicrotask(() => syncHold(name));
    if (e.type === "acquired") log(name, "lease-acquired", e.lease.holder.kind === "agent" ? `agent ${e.lease.holder.agent}` : `person ${e.lease.holder.personId}`);
    else if (e.type === "released") log(name, "lease-released", `${e.was.kind} (${e.why})`);
    else if (e.type === "takeover-requested") log(name, "takeover-requested", e.lease.takeover?.by);
    else if (e.type === "handed-over") log(name, "handed-over", `job ${e.jobId.slice(0, 8)} paused`);
    else if (e.type === "returned") log(name, "returned-to-agent", `job ${e.jobId.slice(0, 8)} (${e.why})`);
    else if (e.type === "moved") log(name, "controls-moved", "the same person took their controls to another window");
    // A terminal lives only while its person holds the controls in that window: returned, expired, moved or released, it closes (round 10).
    if (e.type !== "acquired" && e.type !== "takeover-requested") queueMicrotask(() => terminals.leaseChanged(name));
  });

  // ---------------------------------------------------------------- a person's terminal (round 10): the same lease as the viewer's input
  const terminals = createTerminals({
    holds(name, who) {
      let device: TargetDevice;
      try {
        device = deviceOfName(name).device;
      } catch (e) {
        return (e as Error).message;
      }
      const d = mayTakeOver(who.personId as PersonId, device);
      if (!d.allowed) return d.reason;
      const held = leases.current(device.id);
      if (!held || holderKey(held.holder) !== holderKey({ kind: "person", personId: who.personId as PersonId, session: who.session })) return held ? `${name2(held)} holds ${name} right now; take control first (the agent pauses at its next safe step), then open the terminal.` : `Take control of ${name} first (the agent pauses at its next safe step), then open the terminal.`;
      return null;
    },
    async open(name, size) {
      const record = recordOf(name);
      const adapter = adapterOf(record);
      if (!adapter.openTerminal) return { refused: `${name}'s host has no terminal support, so no terminal was opened.` };
      if (record.desired !== "running") return { refused: `${name} isn't running, so there is no environment to open a terminal in. Start it first.` };
      return adapter.openTerminal(handleOf(record), size);
    },
    log(name, kind, text, _who, job) {
      log(name, kind, text);
      // The paused job's own history says what the person did while it waited (masked command lines, never output).
      if (job) try { options.jobs().step(job, { intent: text.slice(0, 280), executor: "computer.terminal", ms: 0, outcome: "note" }); } catch { /* the job store is unavailable: the computer's log still has the line */ }
    },
    pausedJob(name) {
      try {
        const device = deviceFor(recordOf(name));
        return (device ? leases.current(device.id)?.paused?.jobId : null) ?? null;
      } catch {
        return null;
      }
    },
    now,
  });

  // ---------------------------------------------------------------- lookups
  function deviceFor(record: ComputerRecord): TargetDevice | undefined {
    const row = devices.store.companions().find((c) => c.kind === "cloud-computer" && c.computer?.name === record.name && !c.revokedAt);
    return row ? registry.all().find((d) => d.id === row.id) : undefined;
  }

  function nameOfDevice(deviceId: string): string | undefined {
    return store.list().find((r) => r.deviceId === deviceId)?.name ?? devices.store.companions().find((c) => c.id === deviceId)?.computer?.name;
  }

  function adapterOf(record: ComputerRecord) {
    const a = options.adapters[record.adapter];
    if (!a) throw new Error(`The "${record.adapter}" host isn't configured on this hub.`);
    return a;
  }

  function recordOf(name: string) {
    const r = store.get(name);
    if (!r) throw Object.assign(new Error(`No computer called "${name}".`), { status: 404 });
    return r;
  }

  // ---------------------------------------------------------------- state and the view
  function stateOf(record: ComputerRecord, device: TargetDevice | undefined): ComputerState {
    if (record.failure && !recovering.has(record.name)) return "failed";
    if (record.desired === "suspended") return "asleep";
    if (record.desired === "stopped") return "offline";
    // Being restarted (a crash recovery, or the display layers): not "online", so no job is handed to it half way through.
    if (recovering.has(record.name)) return "starting";
    const online = !!device && registry.isOnline(device);
    if (!online) {
      const since = record.startedAt ?? record.createdAt;
      return recovering.has(record.name) || !device || now() - since < startGraceMs ? "starting" : "offline";
    }
    const lease = device ? leases.current(device.id) : null;
    // Busy is the lease (authoritative, instant), not the companion's heartbeat flag, which can lag by a whole heartbeat.
    return lease ? "busy" : "online";
  }

  /** The screen's truth: the failing layer (or none), from the host's probe and the viewer's evidence. A computer that is not running has no screen to judge. */
  function screenOf(record: ComputerRecord): ScreenView {
    const adapter = options.adapters[record.adapter];
    const ev = evidence.get(record.name) ?? {};
    const r = screenRetries.get(record.name);
    const live = (ev.live ?? 0) > 0;
    const idle = (reason: string, next: ScreenView["next"]): ScreenView => ({ ...diagnoseScreen({ desktop: record.desktop, browser: record.browser ?? record.desktop, snapshot: false, probe: null, evidence: {}, now: now() }), checking: false, layer: "computer", reason, next, nextLabel: next ? NEXT_LABEL[next] : null, at: record.failure?.at ?? null });
    if (record.desired !== "running") return idle(`${record.name} is ${record.desired === "stopped" ? "stopped" : "asleep"}, so there is no screen.`, null);
    if (record.failure) return idle(`${record.failure.reason}.`, "restart-display");
    return diagnoseScreen({
      desktop: record.desktop,
      browser: record.browser ?? record.desktop,
      snapshot: typeof adapter?.snapshot === "function",
      probe: probes.get(record.name) ?? null,
      evidence: live ? { ...ev, frameAt: now() } : ev,
      now: now(),
      retry: r ? { used: r.used, nextAt: r.nextAt } : undefined,
    });
  }

  function lastJobOn(computer: string): ComputerView["lastJob"] {
    for (const [jobId, m] of [...jobMeta.entries()].reverse()) if (m.computer === computer) return { jobId, title: m.title, agent: m.agent, by: m.by };
    return null;
  }

  function viewOf(record: ComputerRecord): HubComputerView {
    const device = deviceFor(record);
    const lease = device ? leases.current(device.id) : null;
    const presence = device ? registry.presenceOf(device.id) : undefined;
    const meta = lease?.holder.kind === "agent" ? jobMeta.get(lease.holder.jobId) : lease?.paused ? jobMeta.get(lease.paused.jobId) : undefined;
    const probe = probes.get(record.name);
    const adapter = options.adapters[record.adapter];
    const state = stateOf(record, device);
    const screen = screenOf(record);
    return {
      name: record.name,
      id: device?.id ?? null,
      label: device?.label ?? record.label,
      kind: "cloud-computer",
      owner: "shared",
      adapter: record.adapter,
      state,
      desired: record.desired,
      desktop: record.desktop,
      browser: record.browser ?? record.desktop,
      capabilities: presence?.capabilities ?? null,
      assigned: meta && lease ? { agent: meta.agent, jobId: lease.holder.kind === "agent" ? lease.holder.jobId : lease.paused!.jobId, by: meta.by, title: meta.title } : null,
      controller: lease
        ? { kind: lease.holder.kind, who: lease.holder.kind === "person" ? lease.holder.personId : lease.holder.agent, jobId: lease.holder.kind === "agent" ? lease.holder.jobId : null, expiresAt: lease.expiresAt, epoch: lease.epoch }
        : { kind: null, who: null, jobId: null, expiresAt: null, epoch: null },
      takeoverPending: lease?.takeover ? { by: lease.takeover.by, requestedAt: lease.takeover.requestedAt } : null,
      paused: lease?.paused ? { jobId: lease.paused.jobId, agent: lease.paused.agent } : null,
      lastJob: lastJobOn(record.name),
      resource: probe?.resource ?? null,
      lastSeen: presence?.lastSeen ?? null,
      failure: record.failure ?? null,
      recoveries: record.recoveries,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      viewer: { snapshot: (record.desktop || (record.browser ?? false)) && typeof adapter?.snapshot === "function", vnc: probe?.vncAlive === true && typeof adapter?.openVnc === "function" },
      screen,
      usable: (state === "online" || state === "busy") && (!screen.applicable || screen.ok),
    };
  }

  function list(): HubComputerView[] {
    return store.list().map(viewOf);
  }

  function view(name: string): HubComputerView {
    return viewOf(recordOf(name));
  }

  /** Every device this person (and any agent they start) may target: their own PC(s) and every shared computer. */
  function targets(person: PersonId) {
    return permittedTargets(person, registry.targets()).map((d) => ({ id: d.id, label: d.label, kind: d.kind, owner: d.owner, online: registry.isOnline(d), shared: isSharedComputer(d) }));
  }

  // ---------------------------------------------------------------- provisioning and lifecycle
  async function ensurePrepared(adapter: ComputersOptions["adapters"][string]) {
    if (prepared.has(adapter.kind) || !adapter.installBundle || !options.bundlePath) return;
    if (options.buildBundle) await options.buildBundle(options.bundlePath);
    await adapter.installBundle(options.bundlePath);
    prepared.add(adapter.kind);
  }

  async function host(adapterKind?: string): Promise<{ adapters: { kind: string; check: HostCheck }[]; goalLoop: boolean }> {
    const kinds = adapterKind ? [adapterKind] : Object.keys(options.adapters);
    return { adapters: await Promise.all(kinds.map(async (kind) => ({ kind, check: await options.adapters[kind].check() }))), goalLoop: !!options.goalAsk };
  }

  /** The owner asked for a browser on this host (user-level, no root, a download): only when called. */
  async function installBrowser(adapterKind?: string) {
    const kind = adapterKind ?? Object.keys(options.adapters)[0];
    const adapter = kind ? options.adapters[kind] : undefined;
    if (!adapter?.installBrowser) throw Object.assign(new Error("This host can't install a browser that way."), { status: 409 });
    await adapter.installBrowser();
    return host(kind);
  }

  async function provision(input: { name: string; by: PersonId; adapter?: string; resolution?: string; label?: string }): Promise<HubComputerView> {
    const { name, by } = input;
    if (!isPersonId(by)) throw Object.assign(new Error("Sign in as Usman or Mehroz first."), { status: 401 });
    if (!validComputerName(name)) throw Object.assign(new Error("A computer's name is 1 to 32 lowercase letters, digits or dashes."), { status: 400 });
    const kind = input.adapter ?? Object.keys(options.adapters)[0];
    const adapter = kind ? options.adapters[kind] : undefined;
    if (!adapter) throw Object.assign(new Error("No computer host is configured on this hub."), { status: 409 });
    if (store.get(name)) throw Object.assign(new Error(`A computer called "${name}" already exists.`), { status: 409 });
    const check = await adapter.check();
    if (!check.ok) throw Object.assign(new Error(`This host can't run a computer: ${check.notes.join("; ") || "it did not answer"}.`), { status: 409 });
    await ensurePrepared(adapter);
    const made = devices.store.createComputerCode(by, { name, adapter: adapter.kind });
    if ("error" in made) throw Object.assign(new Error(made.error), { status: 409 });
    const display = store.nextDisplay();
    const resolution = /^\d{3,4}x\d{3,4}x(24|32)$/.test(input.resolution ?? "") ? input.resolution! : "1280x800x24";
    const record: ComputerRecord = { name, adapter: adapter.kind, createdBy: by, createdAt: now(), label: input.label?.trim().slice(0, 48) || `${name} computer`, display, resolution, desired: "running", desktop: false, handle: {}, startedAt: now(), recoveries: 0 };
    store.put(record);
    log(name, "provisioning", `${adapter.kind}, display :${display}`);
    try {
      // Inside the try: a tunnel that will not come up must fail THIS provisioning (record marked failed, destroyable), not leave a record with no failure and a live code.
      const spec: ComputerSpec = { name, display, resolution, hubUrl: await options.hubUrlFor(adapter.kind, adapter), pairingCode: made.code, label: record.label };
      const { handle, desktop, browser } = await adapter.provision(spec);
      store.patch(name, (r) => void ((r.handle = handle), (typeof handle.display === "number" && (r.display = handle.display)), (r.desktop = desktop), (r.browser = browser ?? desktop)));
    } catch (error) {
      const reason = `provisioning failed: ${(error as Error).message}`.slice(0, 200);
      store.patch(name, (r) => void (r.failure = { at: now(), reason }));
      log(name, "failed", reason);
      throw Object.assign(new Error(reason), { status: 502 });
    }
    const device = deviceFor(store.get(name)!);
    if (device) store.patch(name, (r) => void ((r.deviceId = device.id), (r.everOnline = registry.isOnline(device) || r.everOnline)));
    const first = await adapter.probe(handleOf(store.get(name)!)).catch(() => null);
    if (first) probes.set(name, first);
    log(name, "provisioned", device?.id);
    startMonitor();
    return view(name);
  }

  /**
   * What the adapter needs to act on a computer. A computer whose provisioning failed part-way has an empty stored handle (the adapter never
   * returned one), and every later start, stop or destroy then threw "bad computer name": it could not even be cleaned up through the API.
   * The name and display are always known, so the handle is rebuilt from the record.
   */
  function handleOf(record: ComputerRecord): AdapterHandle {
    if (typeof record.handle?.name === "string") return record.handle;
    return { ...record.handle, name: record.name, display: record.display, vncPort: 5900 + record.display, resolution: record.resolution };
  }

  function busyRefusal(record: ComputerRecord): string | null {
    const device = deviceFor(record);
    const lease = device ? leases.current(device.id) : null;
    return lease ? `${name2(lease)} is using ${record.name} right now; wait, or cancel the job first` : null;
  }
  const name2 = (l: NonNullable<ReturnType<LeaseManager["current"]>>) => (l.holder.kind === "agent" ? `agent "${l.holder.agent}"` : l.holder.personId);

  async function lifecycle(name: string, action: "start" | "stop" | "suspend" | "resume" | "recover", opts: { force?: boolean } = {}): Promise<HubComputerView> {
    const record = recordOf(name);
    const adapter = adapterOf(record);
    const device = deviceFor(record);
    // A computer that has FAILED (its process died) is restarted whoever holds it, as crash recovery always was; a healthy one is never restarted under its holder.
    if ((action === "stop" || action === "suspend" || (action === "recover" && !record.failure)) && !opts.force) {
      const busy = busyRefusal(record);
      if (busy) throw Object.assign(new Error(busy), { status: 409 });
    }
    // Stop, sleep or recovery ends any terminal on this computer (round 10): its environment is going away.
    if (action !== "start" && action !== "resume") terminals.computerStopped(name, action === "recover" ? "the computer is being recovered" : `the computer was ${action === "stop" ? "stopped" : "put to sleep"}`);
    if ((action === "stop" || action === "suspend") && device) {
      const lease = leases.current(device.id);
      if (lease?.holder.kind === "agent") await cancelJob(lease.holder.jobId);
      leases.drop(device.id);
    }
    try {
      if (action === "start" || action === "resume") {
        await ensurePrepared(adapter);
        // A browser may have been installed since this computer was made.
        const fresh = await adapter.check().catch(() => null);
        if (fresh) store.patch(name, (r) => void (r.browser = fresh.present.some((p) => p.startsWith("chromium"))));
        await (action === "start" ? adapter.start(handleOf(record)) : adapter.resume(handleOf(record)));
        store.patch(name, (r) => void ((r.desired = "running"), (r.startedAt = now()), delete r.failure));
      } else if (action === "stop" || action === "suspend") {
        // The intent is recorded BEFORE the processes are stopped: the monitor must not see a companion that is being stopped on purpose as one that died
        // (found on the LAN host: a forced Stop read "failed" because a probe landed in the second the ssh call took).
        const wasDesired = record.desired;
        store.patch(name, (r) => void (r.desired = action === "stop" ? "stopped" : "suspended"));
        try {
          await (action === "stop" ? adapter.stop(handleOf(record)) : adapter.suspend(handleOf(record)));
        } catch (e) {
          store.patch(name, (r) => void (r.desired = wasDesired));
          throw e;
        }
        store.patch(name, (r) => void delete r.failure);
        if (device) dispatcher.deviceOffline(device.id);
        probes.delete(name);
      } else {
        // Display and VNC down: restart only those (the browser, the companion and the job's computer are left alone); anything else is a full restart.
        const layer = screenOf(store.get(name)!).layer;
        if (!record.failure && (layer === "display" || layer === "vnc")) await restartLayers(name, { manual: true });
        else await recover(name, { manual: true });
      }
    } catch (error) {
      const reason = `${action} failed: ${(error as Error).message}`.slice(0, 200);
      store.patch(name, (r) => void (r.failure = { at: now(), reason }));
      log(name, "failed", reason);
      throw Object.assign(new Error(reason), { status: 502 });
    }
    // What proved the screen before a stop, start, suspend or restart proves nothing about the screen after it.
    evidence.delete(name);
    holdSent.delete(name); // the script clears the marker on start, stop and restart: whether a person holds the computer is told again
    log(name, action);
    return view(name);
  }

  /**
   * Restart ONLY the display layers that are not running (Xvfb, VNC): what is alive, the companion and its browser included, is left alone, and no crash recovery is
   * counted. An automatic one is refused while a job or a person holds the computer (that would pull the screen out from under them); a person's own request is not.
   */
  async function restartLayers(name: string, opts: { manual?: boolean } = {}) {
    const record = recordOf(name);
    if (recovering.has(name)) return;
    const device = deviceFor(record);
    if (!opts.manual && device && leases.current(device.id)) {
      log(name, "screen-restart-deferred", "a job or a person holds it; not restarting its display under them");
      return;
    }
    const adapter = adapterOf(record);
    recovering.add(name);
    log(name, "restarting-display", opts.manual ? "asked" : "automatic");
    try {
      await (adapter.restartLayers ? adapter.restartLayers(handleOf(record)) : adapter.start(handleOf(record)));
      evidence.delete(name);
    holdSent.delete(name); // the script clears the marker on start, stop and restart: whether a person holds the computer is told again
      probes.delete(name);
    } finally {
      recovering.delete(name);
    }
  }

  /** Restart what died. Same pairing, same profile, same command ledger: a step already delivered is observed, never replayed. */
  async function recover(name: string, opts: { manual?: boolean } = {}) {
    const record = recordOf(name);
    if (recovering.has(name)) return;
    // An automatic recovery never starts what the owner has stopped.
    if (!opts.manual && store.get(name)?.desired !== "running") return;
    recovering.add(name);
    log(name, "recovering", opts.manual ? "asked" : "automatic");
    try {
      await adapterOf(record).recover(handleOf(record));
      // The owner pressed Stop while this recovery was restarting the processes: stop them again rather than leave a computer running that was stopped.
      if (!opts.manual && store.get(name)?.desired !== "running") {
        await adapterOf(record).stop(handleOf(record)).catch(() => undefined);
        log(name, "recover-cancelled", "stopped by the owner during the recovery");
        return;
      }
      store.patch(name, (r) => void ((r.recoveries += 1), (r.recoveryStreak = (r.recoveryStreak ?? 0) + 1), (r.desired = "running"), (r.startedAt = now())));
      evidence.delete(name);
    holdSent.delete(name); // the script clears the marker on start, stop and restart: whether a person holds the computer is told again
      probes.delete(name);
      // Recovered means it is back and heard from, not merely that the processes were started.
      const device = deviceFor(store.get(name)!);
      for (let i = 0; i < 150 && device; i++) {
        if (registry.isOnline(device)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (device && registry.isOnline(device)) {
        store.patch(name, (r) => void ((r.lastRecoveredAt = now()), delete r.failure));
        log(name, "recovered", "back online with the same pairing");
      } else {
        const reason = "restarted, but it did not come back online";
        store.patch(name, (r) => void (r.failure = { at: now(), reason }));
        log(name, "failed", reason);
      }
    } finally {
      recovering.delete(name);
    }
  }

  async function destroy(name: string): Promise<void> {
    const record = recordOf(name);
    const device = deviceFor(record);
    if (device) {
      const lease = leases.current(device.id);
      if (lease?.holder.kind === "agent") await cancelJob(lease.holder.jobId);
      leases.drop(device.id);
      devices.store.revokeCompanion(device.id);
      dispatcher.deviceOffline(device.id);
    }
    terminals.computerStopped(name, "the computer was removed");
    await adapterOf(record).destroy(handleOf(record));
    store.patch(name, (r) => void (r.destroyedAt = now()));
    probes.delete(name);
    log(name, "destroyed");
  }

  // ---------------------------------------------------------------- the monitor
  function startMonitor() {
    if (monitor || closed) return;
    monitor = setInterval(() => void tick().catch(() => undefined), options.monitorMs ?? 10_000);
    (monitor as { unref?: () => void }).unref?.();
  }

  let ticking = false;
  async function tick() {
    terminals.sweep(); // idle terminals close
    // One tick at a time, and every computer probed at once: an unreachable host (a probe can take its whole timeout) must not delay the others' health checks.
    if (ticking) return;
    ticking = true;
    try {
      leases.sweep();
      await Promise.all(store.list().map((record) => tickOne(record).catch((e) => log(record.name, "monitor-failed", (e as Error).message))));
    } finally {
      ticking = false;
    }
  }

  async function tickOne(record: ComputerRecord) {
    {
      if (record.desired !== "running" || recovering.has(record.name)) return;
      syncHold(record.name);
      // Idle suspend: nothing holds it, nothing has touched it for the configured time, and it is healthy. It sleeps; a job wakes it.
      const idleFor = options.idleSuspendMs ?? 0;
      const dev = deviceFor(record);
      if (idleFor > 0 && dev && !record.failure && !leases.current(dev.id) && now() - (lastActive.get(record.name) ?? record.startedAt ?? record.createdAt) >= idleFor) {
        log(record.name, "idle-suspend", `idle for ${Math.round(idleFor / 1000)} s`);
        await lifecycle(record.name, "suspend").catch((e) => log(record.name, "suspend-failed", (e as Error).message));
        return;
      }
      const adapter = options.adapters[record.adapter];
      if (!adapter) return;
      const probe = await adapter.probe(handleOf(record));
      // The owner may have stopped it while the probe was out (a probe over ssh takes a moment): what is read below is judged against the intent NOW.
      if (store.get(record.name)?.desired !== "running") return;
      probes.set(record.name, probe);
      const device = deviceFor(record);
      const online = !!device && registry.isOnline(device);
      if (online && !record.everOnline) store.patch(record.name, (r) => void ((r.everOnline = true), (r.deviceId = device!.id)));
      if (online && record.failure && probe.companionAlive) {
        store.patch(record.name, (r) => void ((r.lastRecoveredAt = now()), delete r.failure));
        log(record.name, "recovered", `companion alive again after ${record.recoveries} recoveries`);
        return;
      }
      // Healthy for a while since its last recovery: the next failure gets its full allowance of automatic recoveries again (a hub restart, or a host
      // that idled out, three times over a day must not leave it failed for good). A computer that dies straight after each recovery still runs out.
      if (!record.failure && (record.recoveryStreak ?? 0) > 0 && probe.companionAlive && now() - (record.lastRecoveredAt ?? 0) >= (options.recoveryHealthyMs ?? 120_000)) store.patch(record.name, (r) => void (r.recoveryStreak = 0));
      const dead = probe.hostUp && !probe.companionAlive && (record.everOnline || now() - (record.startedAt ?? record.createdAt) > startGraceMs);
      if (dead && !record.failure) {
        store.patch(record.name, (r) => void (r.failure = { at: now(), reason: "the companion process is not running" }));
        log(record.name, "failed", "the companion process is not running");
        // A process that was killed said no goodbye. Whatever it was handed is now "it may have run" at once, instead of waiting
        // out the presence window; the restarted companion then answers from its ledger (observe), and nothing is replayed.
        if (device) dispatcher.deviceOffline(device.id);
      }
      if (!store.get(record.name)?.failure) screenTick(store.get(record.name) ?? record, device, probe, online);
      const failing = store.get(record.name)?.failure;
      if (failing && autoRecover && (record.recoveryStreak ?? 0) < maxAuto && now() - failing.at >= (options.recoverDelayMs ?? 2_000)) void recover(record.name).catch((e) => log(record.name, "recover-failed", (e as Error).message));
    }
  }

  /** Tell the computer's companion whether a PERSON holds it (it then leaves the browser alone), only when that changes. */
  function syncHold(name: string) {
    const record = store.get(name);
    const adapter = record ? options.adapters[record.adapter] : undefined;
    if (!record || !adapter?.setHold) return;
    const device = deviceFor(record);
    const held = !!device && leases.current(device.id)?.holder.kind === "person";
    // Unknown until the first send: after a hub restart, or after a failed send, the computer's actual marker is not assumed to be "off".
    if (holdSent.get(name) === held) return;
    const fails = holdFails.get(name);
    if (fails && fails.held === held && fails.n >= 5) return;
    holdSent.set(name, held);
    void adapter.setHold(handleOf(record), held).then(
      () => void holdFails.delete(name),
      () => {
        holdSent.delete(name); // tried again on the next tick or lease change
        holdFails.set(name, { held, n: fails && fails.held === held ? fails.n + 1 : 1 });
      },
    );
  }

  /**
   * The screen, each monitor tick: keep evidence fresh with a real screenshot when nothing else proves the screen (a live viewer already does), and restart the
   * display layers a restart can fix. Bounded (3 tries, growing pauses), only while autoRecover is on, and NEVER while a job or a person holds the computer.
   */
  function screenTick(record: ComputerRecord, device: TargetDevice | undefined, probe: ProbeResult, online: boolean) {
    const name = record.name;
    const seen = layersSeen.get(name) ?? new Set<string>();
    if (probe.displayAlive === true) seen.add("display");
    if (probe.vncAlive === true) seen.add("vnc");
    if (probe.browserAlive === true) seen.add("blank");
    layersSeen.set(name, seen);
    const ev = evidence.get(name) ?? {};
    const stamp = Math.max(ev.frameAt ?? 0, ev.shotAt ?? 0);
    const screenable = record.desktop || (record.browser ?? false);
    if (screenable && online && probe.companionAlive && probe.browserAlive !== false && probe.displayAlive !== false && !(ev.live ?? 0) && now() - stamp > 30_000 && !shotInFlight.has(name)) void snapshot(name).catch(() => undefined);
    const sc = screenOf(store.get(name) ?? record);
    const r = screenRetries.get(name) ?? { used: 0, nextAt: null, lastAt: 0, history: [] };
    if (sc.ok || !sc.layer) screenFirst.delete(name);
    else if (screenFirst.get(name)?.layer !== sc.layer) screenFirst.set(name, { layer: sc.layer, since: now() });
    if (sc.ok) {
      // The allowance comes back only after the screen has been ready for a good while: a layer that keeps dying does not get a fresh one every minute.
      if (r.used > 0 && now() - r.lastAt > SCREEN_OK_RESET_MS) screenRetries.set(name, { ...r, used: 0, nextAt: null });
      return;
    }
    if (!autoRecover || !online) return;
    const held = !!device && !!leases.current(device.id);
    const day = r.history.filter((t) => now() - t < 86_400_000);
    if (screenRetryDue({ layer: sc.layer, held, recovering: recovering.has(name), running: store.get(name)?.desired === "running", used: r.used, nextAt: r.nextAt, now: now(), wasUp: !!sc.layer && seen.has(sc.layer), failingSince: screenFirst.get(name)?.since ?? null, restartsToday: day.length })) {
      screenRetries.set(name, { used: r.used + 1, nextAt: now() + screenRetryDelayMs(r.used), lastAt: now(), history: [...day, now()] });
      log(name, "screen-restart", `${sc.layer}: ${sc.reason} (automatic try ${r.used + 1} of ${sc.retry.max})`);
      void restartLayers(name).catch((e) => log(name, "screen-restart-failed", (e as Error).message));
    }
  }

  // ---------------------------------------------------------------- agent jobs
  function validateSteps(steps: unknown, presenceCaps: string[] | null | undefined): { ok: true; steps: Required<JobStepInput>[] } | { ok: false; reason: string } {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_COMPUTER_STEPS) return { ok: false, reason: `A computer job has 1 to ${MAX_COMPUTER_STEPS} steps.` };
    const out: Required<JobStepInput>[] = [];
    for (const raw of steps) {
      const s = raw as JobStepInput;
      if (!s || typeof s.executor !== "string" || !EXECUTOR.test(s.executor)) return { ok: false, reason: "Every step needs an executor name." };
      if (s.executor === GOAL_EXECUTOR) {
        const goal = String((s.args as Record<string, unknown> | undefined)?.goal ?? "").trim().slice(0, 600);
        if (!goal) return { ok: false, reason: "A goal step needs a goal." };
        if (!options.goalAsk) return { ok: false, reason: "The hub has no Jev key, so an open-ended goal can't be planned. Give typed steps instead." };
        for (const need of ["observe.page", "input.click"]) if (presenceCaps && !presenceCaps.includes(need)) return { ok: false, reason: `This computer has no browser to work in (it doesn't run "${need}"): ${presenceCaps.join(", ") || "nothing yet"}.` };
        out.push({ executor: GOAL_EXECUTOR, args: { goal }, timeoutMs: 30_000 });
        continue;
      }
      if (s.executor === RESEARCH_EXECUTOR) {
        const goal = String((s.args as Record<string, unknown> | undefined)?.goal ?? "").trim().slice(0, 600);
        if (!goal) return { ok: false, reason: "A research step needs a goal." };
        if (!options.research?.search) return { ok: false, reason: "The hub has no web search configured, so research can't find sources. Nothing was opened." };
        for (const need of ["browser.navigate", "page.text", "file.write"]) if (presenceCaps && !presenceCaps.includes(need)) return { ok: false, reason: `This computer can't research yet (it doesn't run "${need}"; restart its companion to update it): ${presenceCaps.join(", ") || "nothing yet"}.` };
        out.push({ executor: RESEARCH_EXECUTOR, args: { goal }, timeoutMs: 30_000 });
        continue;
      }
      if (isWorkflowExecutor(s.executor)) {
        if (!options.artifacts) return { ok: false, reason: "This hub keeps no saved results, so a workflow can't run. Nothing was started." };
        const v = validateWorkflowStep(s.executor, s.args as Record<string, unknown> | undefined, { allowedAuditHosts: options.workflows?.allowedAuditHosts });
        if (!v.ok) return { ok: false, reason: v.reason };
        const kind = s.executor;
        // `file.chunk` and the others only exist on a computer whose companion was built after the workflows; say which is missing, before anything runs.
        for (const need of NEEDS[kind]) if (presenceCaps && !presenceCaps.includes(need)) return { ok: false, reason: `This computer can't run a ${WORKFLOW_LABEL[kind].toLowerCase()} yet (it doesn't run "${need}"; restart its companion to update it).` };
        out.push({ executor: kind, args: v.args, timeoutMs: 30_000 });
        continue;
      }
      if (isRisky(s.executor)) return { ok: false, reason: `"${s.executor}" is a send, pay, delete or publish action: a computer never does those on its own.` };
      const args = s.args && typeof s.args === "object" && !Array.isArray(s.args) ? s.args : {};
      if (JSON.stringify(args).length > MAX_ARG_BYTES) return { ok: false, reason: "A step's arguments are too large." };
      if (presenceCaps && !presenceCaps.includes(s.executor)) return { ok: false, reason: `This computer doesn't run "${s.executor}" (it runs: ${presenceCaps.join(", ") || "nothing yet"}).` };
      out.push({ executor: s.executor, args, timeoutMs: Math.min(Math.max(Number(s.timeoutMs) || options.stepTimeoutMs || 60_000, 1_000), 300_000) });
    }
    return { ok: true, steps: out };
  }

  async function startJob(input: { computer: string; by: PersonId; principal: JobPrincipal; agent?: string; title?: string; steps: unknown; wake?: boolean; /** The agent bot this job is for (Agents workspace) and the CRM records it is about: recorded on the job, filterable at /__jobs. */ bot?: string; subjects?: readonly string[]; /** The bot's model route, and the instructions and background its model prompts carry (Setup: they take effect on the next job). */ route?: string; context?: string }): Promise<{ ok: true; jobId: string } | { ok: false; reason: string; status: number }> {
    const record = store.get(input.computer);
    if (!record) return { ok: false, reason: `No computer called "${input.computer}".`, status: 404 };
    let device = deviceFor(record);
    const allowed = device ? mayControl(input.by, device) : ({ allowed: true } as const);
    if (!allowed.allowed) return { ok: false, reason: allowed.reason, status: 403 };
    if (record.desired === "suspended" && input.wake !== false) await lifecycle(record.name, "resume").catch(() => undefined);
    const again = store.get(record.name)!;
    device = deviceFor(again);
    if (!device) return { ok: false, reason: `${record.name} hasn't paired yet, so nothing ran.`, status: 409 };
    const state = stateOf(again, device);
    if (state !== "online") {
      // busy is a lease answer below; every other state is "not ready": nothing was sent anywhere else.
      if (state !== "busy") return { ok: false, reason: `${record.name} is ${state}, so nothing ran. I never run it on another machine.`, status: 409 };
    }
    const checked = validateSteps(input.steps, registry.presenceOf(device.id)?.capabilities);
    if (!checked.ok) return { ok: false, reason: checked.reason, status: 400 };
    const held = leases.current(device.id);
    if (held) return { ok: false, reason: `${name2(held)} is using ${record.name}; one controller at a time, so nothing ran.`, status: 409 };
    const jobs = options.jobs();
    const agent = (input.agent ?? "agent").trim().slice(0, 40) || "agent";
    const title = (input.title?.trim() || `${agent} on ${record.name}`).slice(0, 120);
    const job = jobs.create({ kind: "control", principal: input.principal, targetDeviceId: device.id, title, ...(input.bot ? { bot: input.bot } : {}), ...(input.subjects?.length ? { subjects: input.subjects } : {}) });
    const got = leases.acquireAgent(device.id, { jobId: job.id, by: input.by, agent });
    if (!got.ok) {
      jobs.begin(job.id);
      jobs.finish(job.id, "failed", got.reason);
      return { ok: false, reason: `${got.reason}; one controller at a time, so nothing ran.`, status: 409 };
    }
    jobMeta.set(job.id, { computer: record.name, title, agent, by: input.by, ...(input.route && input.route !== "auto" ? { route: input.route } : {}), ...(input.context ? { context: input.context.slice(0, 8000) } : {}) });
    const promise = jobs
      .run(job.id, (ctx) => runSteps(ctx, { record: again, device: device!, by: input.by, agent, steps: checked.steps }))
      .catch(() => undefined)
      .finally(() => {
        active.delete(job.id);
        leases.release(device!.id, `agent:${job.id}`);
        leases.clearPaused(device!.id, job.id);
      });
    active.set(job.id, { promise, computer: record.name });
    log(record.name, "job-started", `${agent} (${job.id.slice(0, 8)})`);
    return { ok: true, jobId: job.id };
  }

  async function cancelJob(jobId: string) {
    const r = await options.jobs().cancel(jobId);
    await active.get(jobId)?.promise;
    return r;
  }

  /** Wait until control comes back to this job (a person returned it, or their viewer expired), or it is stopped. */
  function waitRegain(deviceId: string, jobId: string, signal: AbortSignal): Promise<"returned" | "gone" | "aborted"> {
    return new Promise((resolve) => {
      const done = (v: "returned" | "gone" | "aborted") => {
        unsub();
        signal.removeEventListener("abort", onAbort);
        clearInterval(poll);
        resolve(v);
      };
      const onAbort = () => done("aborted");
      const unsub = leases.subscribe((e) => {
        if (e.type === "returned" && e.lease.computerId === deviceId && e.jobId === jobId) done("returned");
        else if (e.type === "released" && e.computerId === deviceId && e.why === "destroyed") done("gone");
      });
      // A lease that expired while nobody was asking is settled lazily; poll so a vanished viewer returns control promptly.
      const poll = setInterval(() => void leases.current(deviceId), 500);
      (poll as { unref?: () => void }).unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async function runSteps(
    ctx: ExecutorContext,
    job: { record: ComputerRecord; device: TargetDevice; by: PersonId; agent: string; steps: Required<JobStepInput>[] },
  ) {
    const { device, by } = job;
    const key = `agent:${ctx.jobId}`;
    const renew = setInterval(() => leases.renew(device.id, key), Math.max(1_000, Math.floor(leases.agentTtlMs / 3)));
    (renew as { unref?: () => void }).unref?.();
    const results: string[] = [];
    const send = async (executor: string, args: Record<string, unknown>, stepId: string, timeoutMs: number) => {
      const held = leases.current(device.id);
      if (!held || held.holder.kind !== "agent" || held.holder.jobId !== ctx.jobId) return { lost: true as const };
      const started = Date.now();
      const r = await dispatcher.submit(
        { personId: by, spokenTarget: `computer:${device.id}`, executor, args, jobId: ctx.jobId, stepId, pinDeviceId: device.id, lease: { holder: key, epoch: held.epoch } },
        {
          timeoutMs,
          signal: ctx.signal,
          onProgress: (p) => void ctx.step({ intent: p.intent, executor: "companion", target: device.id, ...(p.action ? { action: p.action } : {}), ...(p.verification ? { verification: p.verification } : {}), ms: p.ms, outcome: p.outcome }),
        },
      );
      return { lost: false as const, r, ms: Date.now() - started };
    };
    // A safe step boundary: the previous step has finished and been checked; nothing is in flight.
    let refreshes = 0;
    let pageStale = false;
    /** After a hand-back that found no page, a move that needs a page first re-reads it; if there is still none it does not run (an honest failure, not a blind move). */
    const pageGate = async (executor: string, run: () => ReturnType<typeof send>): ReturnType<typeof send> => {
      if (!pageStale || ["observe.page", "browser.navigate", "computer.info", "echo", "wait"].includes(executor)) {
        const r = await run();
        if (pageStale && executor === "browser.navigate" && !r.lost && r.r.ok) pageStale = false;
        return r;
      }
      const look = await send("observe.page", {}, `refresh-${++refreshes}`, 30_000);
      const seen = !look.lost && look.r.ok && !look.r.local && isExecutorResult(look.r.result) ? look.r.result : null;
      if (!seen?.ok) return look.lost ? look : ({ lost: false as const, r: { ok: false as const, reason: "No page is open on this computer after the hand-back, so the next move did not run." }, ms: 0 } as never);
      pageStale = false;
      return run();
    };
    const boundary = async (what: string): Promise<null | { ok: false; note: string }> => {
        if (leases.takeoverWaiting(device.id, ctx.jobId)) {
          const who = leases.current(device.id)?.takeover?.by ?? "a person";
          ctx.step({ intent: `paused before ${what}: ${who} is taking control`, executor: "computer.lease", target: device.id, ms: 0, outcome: "note" });
          const handed = leases.handOver(device.id, ctx.jobId);
          if (!handed.ok) return { ok: false, note: `Couldn't hand over the computer: ${handed.reason}.` };
          const back = await waitRegain(device.id, ctx.jobId, ctx.signal);
          if (back !== "returned") {
            leases.clearPaused(device.id, ctx.jobId);
            return back === "aborted" ? { ok: false, note: "Stopped on request." } : { ok: false, note: "The computer was removed while paused." };
          }
          ctx.step({ intent: `control returned to the agent; re-reading the computer before ${what}`, executor: "computer.lease", target: device.id, ms: 0, outcome: "note" });
          const caps = registry.presenceOf(device.id)?.capabilities ?? [];
          const probes = ["observe.page", "computer.info", "echo"].filter((c) => caps.includes(c));
          if (probes.length) {
            const read = (r: Awaited<ReturnType<typeof send>>) => (!r.lost && r.r.ok && !r.r.local && isExecutorResult(r.r.result) ? r.r.result : null);
            let probe = probes[0];
            let fresh = await send(probe, {}, `refresh-${++refreshes}`, 30_000);
            let x = read(fresh);
            // Only the computer's own statement that NO PAGE IS OPEN lets the re-read ask the computer itself instead. A crash, a timeout, a lost lease or
            // any other failure is not that: the job stops rather than carry on without having looked.
            const failedSaying = x && !x.ok ? x.said : !fresh.lost && !fresh.r.ok && !fresh.r.uncertain ? fresh.r.reason : "";
            if (probe === "observe.page" && /no page is open/i.test(failedSaying) && probes.includes("computer.info")) {
              probe = "computer.info";
              fresh = await send(probe, {}, `refresh-${++refreshes}`, 30_000);
              x = read(fresh);
              // The page the work was on is gone: the next page move must re-read (and so re-open) its page first, see pageGate.
              if (x?.ok) pageStale = true;
            }
            ctx.step({
              intent: `refreshed state after the handover: ${x ? x.said.slice(0, 160) : fresh.lost ? "the lease was lost" : fresh.r.ok ? "no readable result" : fresh.r.reason.slice(0, 160)}`,
              executor: "companion", target: device.id, action: probe, ms: fresh.lost ? 0 : fresh.ms,
              verification: { method: "companion-check", ok: x ? x.verified : null, ...(x?.evidence ? { evidence: x.evidence.slice(0, 160) } : {}) }, outcome: x?.ok ? "ok" : "failed",
            });
            if (!x?.ok) return { ok: false, note: `Couldn't re-read the computer after the handover, so I did not continue (${what} and what follows did not run).` };
          }
        }
        return null;
    };

    try {
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i];
        if (ctx.signal.aborted || ctx.cancelRequested()) return { ok: false, note: "Stopped on request." };

        const paused = await boundary(`step ${i + 1} (${step.executor})`);
        if (paused) return paused;

        if (step.executor === GOAL_EXECUTOR || step.executor === RESEARCH_EXECUTOR || isWorkflowExecutor(step.executor)) {
          let n = 0;
          const after = (r: Awaited<ReturnType<typeof send>>, executor: string, label: string, quiet = false): ActOutcome => {
            if (r.lost) return { kind: "lost" };
            const res = r.r;
            if (!res.ok) {
              const stopped = ctx.signal.aborted || /cancel/i.test(res.reason);
              ctx.step({ intent: `move ${label}: ${res.reason}`.slice(0, 280), executor: "companion", target: device.id, action: executor, ms: r.ms, outcome: stopped ? "cancelled" : res.uncertain ? "unknown" : "failed", verification: { method: "companion-report", ok: res.uncertain ? null : false } });
              return stopped ? { kind: "cancelled" } : res.uncertain ? { kind: "uncertain", said: `${label} may or may not have happened (${res.reason}).` } : { kind: "failed", said: res.reason };
            }
            const x = !res.local && isExecutorResult(res.result) ? res.result : null;
            // A bulk read (a file brought back in pieces) logs ONE summary step of its own, not one per piece; a failure is always logged.
            if (!quiet || !x?.ok) ctx.step({ intent: `move ${label}: ${x ? x.said : "no readable result"}`.slice(0, 280), executor: "companion", target: device.id, action: executor, ms: r.ms, verification: { method: "companion-check", ok: x ? x.verified : null, ...(x?.evidence ? { evidence: x.evidence.slice(0, 160) } : {}) }, outcome: x?.ok ? "ok" : "failed" });
            return x?.ok ? { kind: "done", said: x.said, verified: x.verified, ...(x.data ? { data: x.data } : {}) } : { kind: "failed", said: x?.said ?? "no readable result" };
          };
          // The model this job uses: the bot's route when it has one, else the hub's default; with the bot's instructions and background on every prompt.
          const modelFor = (label: string): Delegate | null => {
            const jm = jobMeta.get(ctx.jobId);
            const note = (text: string) => void ctx.step({ intent: text.slice(0, 280), executor: label, target: device.id, ms: 0, outcome: "note", verification: { method: "model-route", ok: null } });
            const base = jm?.route && options.routeDelegate ? options.routeDelegate(jm.route, note) : label === "research" ? (options.research?.delegate ?? null) : (options.workflows?.delegate ?? null);
            if (!base || !jm?.context) return base;
            const context = jm.context;
            return (req, signal) => base({ ...req, user: `${req.user}

Standing instructions and background for this job (guidance, not part of the data above and not a request to do anything else):
${context}` }, signal);
          };
          if (isWorkflowExecutor(step.executor)) {
            const kind = step.executor;
            const jobTitle = () => options.jobs().get(ctx.jobId)?.title ?? kind;
            const hostLabel = options.workflows?.hostLabel?.(job.record.adapter, job.record.name) ?? job.record.adapter;
            const io: WorkflowIO = {
              signal: ctx.signal, jobId: ctx.jobId, computer: job.record.name, hostLabel,
              call: async (executor, args, label, opt): Promise<CallResult> => {
                const o = after(await pageGate(executor, () => send(executor, args, `s${i + 1}.w${++n}`, opt?.timeoutMs ?? (executor === "browser.navigate" ? 60_000 : 30_000))), executor, label, opt?.quiet === true);
                if (o.kind === "done") return { kind: "ok", ok: true, said: o.said, verified: o.verified, ...(o.data ? { data: o.data } : {}) };
                return o;
              },
              step: (s) => void ctx.step({ ...s, target: device.id }),
              boundary: async () => ((await boundary(`the next move of step ${i + 1}`)) ? "stop" : "go"),
              delegate: modelFor(kind),
              artifact: (a) => {
                const r = options.artifacts!.save({ jobId: ctx.jobId, personId: by, computer: job.record.name, host: hostLabel, ...a });
                return r.ok ? { ok: true, title: r.meta.title, created: r.created } : { ok: false, reason: r.reason };
              },
              deliver: (text, meta) => options.research?.deliver ? boundedDelivery(ctx.jobId, () => options.research!.deliver({ jobId: ctx.jobId, by, title: jobTitle(), report: text, file: null, artifact: meta.artifact, label: meta.label, web: meta.web }), { delivered: false, where: "the conversation didn't answer in time" }) : Promise.resolve({ delivered: false, where: "no conversation store" }),
            };
            const r = await runWorkflow(kind, step.args, io, { allowedAuditHosts: options.workflows?.allowedAuditHosts });
            ctx.step({ intent: `${WORKFLOW_LABEL[kind].toLowerCase()} ${r.outcome}: ${r.note}`.slice(0, 280), executor: kind, target: device.id, ms: r.wallMs, outcome: r.ok ? "ok" : r.settle === "unknown" ? "unknown" : "failed", verification: { method: "workflow", ok: r.ok ? true : r.settle === "unknown" ? null : false, evidence: r.outcome } });
            if (!r.ok) {
              for (let j = i + 1; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: the ${kind} before it didn't finish`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
              return { ok: false, ...(r.settle ? { settle: r.settle } : {}), note: r.note.slice(0, 180) };
            }
            results.push(r.note);
            leases.renew(device.id, key);
            continue;
          }
          if (step.executor === RESEARCH_EXECUTOR) {
            const research = options.research!;
            const r = await runResearch({
              goal: String(step.args.goal),
              io: {
                signal: ctx.signal,
                step: (s) => void ctx.step(s),
                boundary: async () => ((await boundary(`the next move of step ${i + 1}`)) ? "stop" : "go"),
                search: research.search,
                ask: options.goalAsk ?? null,
                delegate: modelFor("research"),
                call: async (executor, args, label): Promise<CallResult> => {
                  const o = after(await pageGate(executor, () => send(executor, args, `s${i + 1}.r${++n}`, executor === "browser.navigate" ? 60_000 : 30_000)), executor, label);
                  if (o.kind === "done") return { kind: "ok", ok: true, said: o.said, verified: o.verified, ...(o.data ? { data: o.data } : {}) };
                  if (o.kind === "failed" || o.kind === "uncertain") return o;
                  return o;
                },
                deliver: (report, meta) => boundedDelivery(ctx.jobId, () => research.deliver({ jobId: ctx.jobId, by, title: options.jobs().get(ctx.jobId)?.title ?? "research", report, file: meta?.file ?? null, artifact: meta?.artifact ?? null, label: "Research", web: true }), { delivered: false, where: "the conversation didn't answer in time" }),
                artifact: options.artifacts
                  ? (a) => {
                      const hostLabel = options.workflows?.hostLabel?.(job.record.adapter, job.record.name) ?? job.record.adapter;
                      const saved = options.artifacts!.save({ jobId: ctx.jobId, personId: by, computer: job.record.name, host: hostLabel, ...researchArtifact(a) });
                      return saved.ok ? { saved: true, title: saved.meta.title } : { saved: false, title: "" };
                    }
                  : undefined,
              },
            });
            ctx.step({ intent: `research ${r.outcome}: ${r.note}`.slice(0, 280), executor: "research", target: device.id, ms: r.metrics.wallMs, outcome: r.ok ? "ok" : r.settle === "unknown" ? "unknown" : "failed", verification: { method: "research", ok: r.ok ? true : r.settle === "unknown" ? null : false, evidence: `${r.facts} facts, ${r.sources.length} sources, ${r.metrics.searches} searches, ${r.metrics.delegateCalls} model calls` } });
            if (!r.ok) {
              for (let j = i + 1; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: the research before it didn't finish`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
              return { ok: false, ...(r.settle ? { settle: r.settle } : {}), note: r.note.slice(0, 180) };
            }
            results.push(r.report?.concise ?? "");
            leases.renew(device.id, key);
            continue;
          }
          const g = await runGoalLoop({
            goal: String(step.args.goal),
            ask: options.goalAsk ?? null,
            // Context he added by voice while this ran (a "context" note step written by the command service) joins the goal at the next decision.
            extraContext: () => options.jobs().get(ctx.jobId)?.steps.filter((s) => s.executor === "context" && s.intent.startsWith("added context: ")).map((s) => s.intent.slice(15)) ?? [],
            io: {
              signal: ctx.signal,
              step: (s) => void ctx.step(s),
              boundary: async () => ((await boundary(`the next move of step ${i + 1}`)) ? "stop" : "go"),
              observe: async () => {
                const r = await send("observe.page", { elements: true }, `s${i + 1}.o${++n}`, 30_000);
                if (r.lost) return { ok: false as const, said: "the job lost the computer", uncertain: false };
                if (r.r.ok) pageStale = false; // the page was just read again
                if (!r.r.ok) return { ok: false as const, said: r.r.reason, uncertain: r.r.uncertain === true };
                const x = !r.r.local && isExecutorResult(r.r.result) ? r.r.result : null;
                const d = (x?.data ?? {}) as Partial<PageObservation> & { viewport?: { w: number; h: number } };
                if (!x?.ok || !Array.isArray(d.elements) || !d.viewport) return { ok: false as const, said: x?.said ?? "no readable page", uncertain: false };
                return { ok: true as const, obs: { title: String(d.title ?? ""), url: String(d.url ?? ""), viewport: d.viewport, elements: d.elements } };
              },
              act: async (executor, args, label) => after(await pageGate(executor, () => send(executor, args, `s${i + 1}.a${++n}`, 30_000)), executor, label),
            },
          });
          ctx.step({ intent: `goal ${g.ok ? "done" : "ended"} after ${g.moves} move${g.moves === 1 ? "" : "s"}: ${g.note}`.slice(0, 280), executor: "goal", target: device.id, ms: 0, outcome: g.ok ? "ok" : g.settle === "unknown" ? "unknown" : "failed", verification: { method: "goal-loop", ok: g.ok ? true : g.settle === "unknown" ? null : false } });
          if (!g.ok) {
            for (let j = i + 1; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: the goal before it didn't finish`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
            return { ok: false, ...(g.settle ? { settle: g.settle } : {}), note: g.note.slice(0, 180) };
          }
          leases.renew(device.id, key);
          continue;
        }

        const sent = await send(step.executor, step.args, `s${i + 1}`, step.timeoutMs);
        if (sent.lost) {
          for (let j = i; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: the job no longer holds the computer`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
          return { ok: false, note: "The job lost the computer's control lease, so the rest did not run." };
        }
        const { r, ms } = sent;
        if (!r.ok) {
          const stopped = ctx.signal.aborted || /cancel/i.test(r.reason);
          const uncertain = !stopped && r.uncertain === true;
          ctx.step({
            intent: `step ${i + 1} ${step.executor}: ${r.reason}`.slice(0, 280), executor: "companion", target: device.id, action: step.executor, ms,
            outcome: stopped ? "cancelled" : uncertain ? "unknown" : "failed",
            verification: { method: "companion-report", ok: uncertain ? null : false, ...(r.observed ? { evidence: `the computer says: ${r.observed.state}` } : {}) },
          });
          for (let j = i + 1; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: ${stopped ? "it was stopped first" : "the step before it didn't complete"}`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
          if (stopped) return { ok: false, note: "Stopped on request." };
          if (uncertain) return { ok: false, settle: "unknown" as const, note: `Step ${i + 1} (${step.executor}) may or may not have happened; I did not run it again or run the later steps.` };
          return { ok: false, note: `Stopped at step ${i + 1} of ${job.steps.length} (${step.executor}): ${r.reason.slice(0, 120)}` };
        }
        const x: ExecutorResult | null = !r.local && isExecutorResult(r.result) ? r.result : null;
        const ok = !!x && x.ok && x.verified === true;
        ctx.step({
          intent: `step ${i + 1} ${step.executor}: ${x ? x.said : "no readable result"}`.slice(0, 280), executor: "companion", target: device.id, action: step.executor, ms,
          verification: { method: "companion-check", ok: x ? x.verified : null, ...(x?.evidence ? { evidence: x.evidence.slice(0, 200) } : {}) },
          outcome: ok ? "ok" : x && x.verified === null ? "unknown" : "failed",
        });
        results.push(x?.said ?? "");
        if (!ok) {
          for (let j = i + 1; j < job.steps.length; j++) ctx.step({ intent: `step ${j + 1} ${job.steps[j].executor} not run: the step before it wasn't confirmed`, executor: "companion", target: device.id, outcome: "skipped", ms: 0 });
          return { ok: false, note: `Stopped at step ${i + 1} of ${job.steps.length} (${step.executor}): ${x ? (x.ok ? "done but not confirmed" : x.said) : "no readable result"}`.slice(0, 180) };
        }
        leases.renew(device.id, key);
      }
      return { ok: true, note: `Done on ${job.record.name}: ${job.steps.length} step${job.steps.length === 1 ? "" : "s"}, each checked.` };
    } finally {
      clearInterval(renew);
      // Free the computer BEFORE the job's terminal state is written, so "succeeded" never coexists with a held lease.
      leases.release(device.id, key);
      leases.clearPaused(device.id, ctx.jobId);
    }
  }

  // ---------------------------------------------------------------- a person takes control
  type Person = { personId: PersonId; session: string };

  function deviceOfName(name: string) {
    const record = recordOf(name);
    const device = deviceFor(record);
    if (!device) throw Object.assign(new Error(`${name} hasn't paired yet.`), { status: 409 });
    return { record, device };
  }

  function takeover(name: string, who: Person) {
    const { device } = deviceOfName(name);
    const d = mayTakeOver(who.personId, device);
    if (!d.allowed) throw Object.assign(new Error(d.reason), { status: 403 });
    const r = leases.requestTakeover(device.id, who);
    if (!r.ok) throw Object.assign(new Error(`${r.reason}; it is one controller at a time.`), { status: 409 });
    return { state: r.state, view: view(name) };
  }

  function viewerHeartbeat(name: string, who: Person) {
    const { device } = deviceOfName(name);
    const ok = leases.renew(device.id, holderKey({ kind: "person", personId: who.personId, session: who.session }));
    if (ok) lastBeat.set(keyFor(device.id, who), now());
    return { ok, view: view(name) };
  }

  // ---- viewer presence: leaving the viewer gives the computer back promptly, not after the lease expires.
  //
  // A person's viewer socket is their presence. When the LAST socket they have open on a computer closes, they get `viewerCloseGraceMs` (5 s) to come
  // back (a network blip, a page reload, noVNC reconnecting); then their control is released exactly as "Return to agent" would (a paused job resumes
  // after re-reading the computer, otherwise the computer is free) and a pending takeover request is withdrawn. It is kept if a socket reopened, or if
  // a lease heartbeat arrived after the close (a page that is still open and holding the lease the snapshot way). A person who never opened a socket
  // (a snapshot-only page) is unaffected: only expiry applies to them. Expiry (60 to 90 s) stays as the fallback for a hub that never saw the close.
  const viewerGraceMs = options.viewerCloseGraceMs ?? 5_000;
  const viewerSockets = new Map<string, number>();
  const lastBeat = new Map<string, number>();
  const keyFor = (deviceId: string, who: Person) => `${deviceId}|${holderKey({ kind: "person", personId: who.personId, session: who.session })}`;
  function viewerOpened(name: string, who: Person) {
    const { device } = deviceOfName(name);
    const k = keyFor(device.id, who);
    viewerSockets.set(k, (viewerSockets.get(k) ?? 0) + 1);
  }
  function viewerClosed(name: string, who: Person) {
    let device: TargetDevice;
    try {
      device = deviceOfName(name).device;
    } catch {
      return; // the computer is gone: its lease was dropped with it
    }
    const k = keyFor(device.id, who);
    const left = (viewerSockets.get(k) ?? 1) - 1;
    if (left > 0) return void viewerSockets.set(k, left);
    viewerSockets.delete(k);
    const closedAt = now();
    const timer = setTimeout(() => {
      if ((viewerSockets.get(k) ?? 0) > 0) return; // they came back
      if ((lastBeat.get(k) ?? 0) > closedAt) return; // their page is still open and holding the lease
      lastBeat.delete(k); // settled: the map must not grow by one entry per person-session for ever
      const held = leases.current(device.id);
      const mine = !!held && held.holder.kind === "person" && holderKey(held.holder) === holderKey({ kind: "person", personId: who.personId, session: who.session });
      const withdrew = leases.cancelTakeover(device.id, who);
      if (!mine && !withdrew) return;
      const r = mine ? leases.returnToAgent(device.id, who) : { ok: true as const, resumed: null };
      if (r.ok) log(name, "viewer-left", r.resumed ? `${who.personId} left; job ${r.resumed.slice(0, 8)} resumes` : `${who.personId} left; the computer is free`);
    }, viewerGraceMs);
    timer.unref?.();
  }

  /** For the viewer: the computer, and whether THIS person holds its lease right now (the page's view-only switch; the hub enforces it regardless). */
  function viewerState(name: string, who: Person) {
    return { view: view(name), ...sessionFlags(name, who), me: who.personId };
  }

  /** Whether THIS window holds the controls, and whether the same person holds them in ANOTHER window (the lease is per person AND session). */
  function sessionFlags(name: string, who: Person) {
    const { device } = deviceOfName(name);
    const held = leases.current(device.id);
    const mine = !!held && holderKey(held.holder) === holderKey({ kind: "person", personId: who.personId, session: who.session });
    return { canControl: mine, heldByThisSession: mine, heldByYouElsewhere: !!held && held.holder.kind === "person" && held.holder.personId === who.personId && !mine };
  }

  /** The same person moves their own controls to this window: explicit, recorded, a new epoch (the other window's input stops at once). */
  function takeHere(name: string, who: Person) {
    const { device } = deviceOfName(name);
    const d = mayTakeOver(who.personId, device);
    if (!d.allowed) throw Object.assign(new Error(d.reason), { status: 403 });
    const r = leases.moveToSession(device.id, who);
    if (!r.ok) throw Object.assign(new Error(`${r.reason}.`), { status: 409 });
    return { state: "held" as const, view: view(name) };
  }

  function returnToAgent(name: string, who: Person) {
    const { device } = deviceOfName(name);
    // A person who had only asked (the agent has not reached a boundary yet) simply withdraws the request.
    leases.cancelTakeover(device.id, who);
    const r = leases.returnToAgent(device.id, who);
    if (!r.ok) throw Object.assign(new Error(r.reason), { status: 409 });
    return { resumed: r.resumed, view: view(name) };
  }

  /** A person who holds the computer sends it one input (click, type, key). Refused unless they hold the lease. */
  async function input(name: string, who: Person, event: { executor: string; args: Record<string, unknown> }) {
    const { device } = deviceOfName(name);
    const held = leases.current(device.id);
    const key = holderKey({ kind: "person", personId: who.personId, session: who.session });
    if (!held || holderKey(held.holder) !== key) return { ok: false as const, status: 409, reason: held ? `${name2(held)} holds ${name} right now; take control first.` : `Take control of ${name} first.` };
    const r = await dispatcher.submit({ personId: who.personId, spokenTarget: `computer:${device.id}`, executor: event.executor, args: event.args, lease: { holder: key, epoch: held.epoch } }, { timeoutMs: 20_000 });
    return r.ok && !r.local ? { ok: true as const, result: r.result } : { ok: false as const, status: 409, reason: r.ok ? "that resolved to the hub itself, so nothing was sent" : r.reason };
  }

  // ---------------------------------------------------------------- viewing (read-only, any founder)
  const lastShot = new Map<string, { at: number; shot: Promise<Snapshot | null> }>();
  async function snapshot(name: string): Promise<Snapshot | null> {
    const record = recordOf(name);
    const adapter = adapterOf(record);
    if (!adapter.snapshot || !(record.desktop || record.browser)) return null;
    const prior = lastShot.get(name);
    if (prior && now() - prior.at < 400) return prior.shot;
    shotInFlight.add(name);
    const shot = adapter
      .snapshot(handleOf(record))
      .catch(() => null)
      .then((s) => {
        shotInFlight.delete(name);
        // A screenshot that really came back is evidence; one that did not is a failure of the frame layer, said as such.
        if (s) noteEvidence(name, (e) => void (e.shotAt = now()));
        else noteFault(name, { layer: "frame", reason: "The computer's browser didn't return a screenshot.", at: now() });
        return s;
      });
    lastShot.set(name, { at: now(), shot });
    return shot;
  }

  // ---- screen evidence: what the viewer and the screenshots actually showed.
  function noteEvidence(name: string, fn: (e: ScreenEvidence & { live?: number }) => void) {
    const e = evidence.get(name) ?? {};
    fn(e);
    evidence.set(name, e);
  }
  function noteFault(name: string, fault: ScreenFault) {
    noteEvidence(name, (e) => void (e.fault = fault));
    log(name, "screen-fault", `${fault.layer}: ${fault.reason}`);
  }
  /** A real frame reached a viewer through the hub: the transport, the handshake and the display all work. Counts as live until that viewer closes. */
  function screenFrame(name: string, opts: { first?: boolean } = {}) {
    noteEvidence(name, (e) => {
      e.frameAt = now();
      if (opts.first) e.live = (e.live ?? 0) + 1;
      if (e.fault && e.fault.layer !== "blank") delete e.fault;
    });
  }
  function screenGone(name: string) {
    noteEvidence(name, (e) => void (e.live = Math.max(0, (e.live ?? 0) - 1)));
  }
  /** What the person's own viewer drew: a frame that is all black is a blank screen, whatever the processes say; a drawn one clears it. */
  function screenReport(name: string, report: { blank: boolean | null; frame: boolean }) {
    recordOf(name);
    if (report.blank === true) {
      // One black sample proves nothing (a page still loading, a fade): the second report within 30 s, from a viewer that has seen the same black twice, is believed.
      const e = evidence.get(name) ?? {};
      const first = (e as { blankSeenAt?: number }).blankSeenAt;
      noteEvidence(name, (x) => void ((x as { blankSeenAt?: number }).blankSeenAt = now()));
      if (first !== undefined && now() - first <= 30_000) {
        if (e.fault?.layer === "blank") noteEvidence(name, (x) => void (x.fault = { ...x.fault!, at: now() })); // still blank: keep it from lapsing
        else noteFault(name, { layer: "blank", reason: "The viewer drew an all-black screen: nothing is open on the display.", at: now() });
      }
    } else if (report.frame) noteEvidence(name, (e) => void ((e.frameAt = now()), delete (e as { blankSeenAt?: number }).blankSeenAt, e.fault?.layer === "blank" && delete e.fault));
  }
  /** A fresh answer for "is the screen ready": probe the layers now, then take a real screenshot if they are all up. Cached for 2 s per computer. */
  const verifying = new Map<string, { at: number; p: Promise<ScreenView> }>();
  function verifyScreen(name: string): Promise<ScreenView> {
    const prior = verifying.get(name);
    if (prior && now() - prior.at < 2_000) return prior.p;
    const p = (async () => {
      const record = recordOf(name);
      if (record.desired === "running" && !record.failure) {
        const probe = await adapterOf(record).probe(handleOf(record)).catch(() => null);
        if (probe && store.get(name)?.desired === "running") probes.set(name, probe);
        const up = probe && probe.hostUp && probe.companionAlive && probe.displayAlive !== false && probe.browserAlive !== false;
        if (up && (record.desktop || record.browser)) await snapshot(name).catch(() => null);
      }
      return view(name).screen;
    })();
    verifying.set(name, { at: now(), p });
    return p;
  }

  async function openVnc(name: string): Promise<VncStream | null> {
    const record = recordOf(name);
    const adapter = adapterOf(record);
    return adapter.openVnc ? adapter.openVnc(handleOf(record)) : null;
  }

  async function close() {
    closed = true;
    terminals.closeAll();
    for (const r of deliveryRetries) clearTimeout(r);
    deliveryRetries.clear();
    if (monitor) clearInterval(monitor);
    monitor = undefined;
    for (const jobId of [...active.keys()]) await options.jobs().cancel(jobId).catch(() => undefined);
    await Promise.allSettled([...active.values()].map((a) => a.promise));
    for (const a of Object.values(options.adapters)) await a.close?.();
  }

  return {
    store, leases, events: () => events.slice(), list, view, targets, host, installBrowser, provision, lifecycle, recover, destroy, startJob, cancelJob,
    /** A person's terminal on a computer they hold (start / input / resize / events / close), see scripts/computers/terminal.ts. */
    terminals: { ...terminals, start: (name: string, who: TerminalPerson, size?: { cols?: number; rows?: number }) => terminals.start(name, who, size) },
    takeover, takeHere, sessionFlags, viewerHeartbeat, viewerOpened, viewerClosed, viewerState, returnToAgent, input, snapshot, openVnc, tick, verifyScreen, screenFrame, screenGone, screenFault: noteFault, screenReport, startMonitor, close, deviceFor,
    permittedTargets: (person: PersonId) => targets(person),
    jobView: (jobId: string) => {
      const job = options.jobs().get(jobId);
      const meta = jobMeta.get(jobId);
      if (!job) return null;
      const device = meta ? deviceFor(recordOf(meta.computer)) : undefined;
      const lease = device ? leases.current(device.id) : null;
      return { id: job.id, state: job.state, note: job.note ?? null, title: job.title, computer: meta?.computer ?? null, agent: meta?.agent ?? null, paused: !!lease?.paused && lease.paused.jobId === jobId, steps: job.steps.map((s) => ({ seq: s.seq, executor: s.executor, action: s.action ?? null, outcome: s.outcome, ms: s.ms, intent: s.intent, verification: s.verification ?? null })) };
    },
    /** Whether an open-ended goal can be planned (the hub holds a Jev key). */
    canPlanGoals: !!options.goalAsk,
    /** Whether bounded research can run (the hub has web search). */
    canResearch: !!options.research?.search,
    /** Whether the builder, website audit and business preparation workflows can run (the hub keeps saved results). */
    canWorkflows: !!options.artifacts,
    /** The latest computer job this person started (optionally on one computer), newest first. */
    lastJob: (person: PersonId, computer?: string): string | null => {
      const ids = [...jobMeta.keys()].reverse();
      return ids.find((id) => jobMeta.get(id)!.by === person && (!computer || jobMeta.get(id)!.computer === computer)) ?? null;
    },
    desiredOf: (name: string): DesiredState | null => store.get(name)?.desired ?? null,
    newId: randomUUID,
  };
}

export type ComputersService = ReturnType<typeof createComputersService>;

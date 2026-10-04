import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLedger } from "../../companion/ledger";
import type { Executor } from "../../companion/executors";
import { CompanionWorker } from "../../companion/worker";
import { createDevicesService, type DevicesService } from "../devices/service";
import { LOGINS, PAGE_TOKEN, SIMULATED_SERVE, SIMULATED_TAILNET, TAILNET } from "../devices/test-harness";
import { pageTokenFor } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createArtifactStore } from "./artifacts";
import { createComputersRoutes } from "./routes";
import { createComputersService, type ComputersOptions, type ComputersService } from "./service";
import type { AdapterHandle, ComputerSpec, HostCheck, ProbeResult, ProvisioningAdapter, VncStream } from "./types";
import { attachViewer } from "./viewer";
import { messageLength } from "./rfb";
import type { ControlAsk } from "./goal-loop";

/**
 * A real hub in a box for the computers tests: the devices service (cloud role, real HTTP), the job store, the computers service and
 * routes, with synthetic people and one simulated host. The "computers" it provisions run the REAL CompanionWorker in this process,
 * paired over HTTP with a real one-time code, with executors the test supplies. Nothing touches a real machine or the network.
 */

export type HostCalls = { provision: string[]; start: string[]; stop: string[]; suspend: string[]; resume: string[]; recover: string[]; destroy: string[] };

export class InProcessHost implements ProvisioningAdapter {
  readonly kind = "test-host";
  readonly workers = new Map<string, CompanionWorker>();
  readonly tokens = new Map<string, { token: string; deviceId: string; hubUrl: string }>();
  readonly ledgers = new Map<string, CommandLedger>();
  /** Computers whose process was killed: nothing they try to send reaches the hub (no goodbye, like kill -9). */
  readonly dead = new Set<string>();
  readonly calls: HostCalls = { provision: [], start: [], stop: [], suspend: [], resume: [], recover: [], destroy: [] };
  check: () => Promise<HostCheck> = async () => ({ ok: true, host: "test", present: ["node"], missing: [], installCommand: null, notes: [] });
  desktop = true;
  vncUp = false;
  rssMb = 180;
  /** Layers a test wants the host's probe to report differently (a dead VNC server, no browser, an unreachable host). */
  probeOverride: Partial<ProbeResult> = {};
  /** The computer's browser returns no screenshot. */
  snapshotFails = false;
  /** Per computer: the executors it runs (tests override). */
  executorsFor: (name: string) => Record<string, Executor> = () => ({ echo: async () => ({ ok: true, said: "Echoed.", verified: true }) });

  async provision(spec: ComputerSpec) {
    this.calls.provision.push(spec.name);
    const res = await fetch(`${spec.hubUrl}/__devices/companion/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: spec.pairingCode, label: spec.label }) });
    const json: any = await res.json();
    if (res.status !== 200) throw new Error(`pairing refused: ${json.error}`);
    this.tokens.set(spec.name, { token: json.token, deviceId: json.deviceId, hubUrl: spec.hubUrl });
    this.ledgers.set(spec.name, new CommandLedger());
    await this.launch(spec.name);
    return { handle: { name: spec.name, display: spec.display } as AdapterHandle, desktop: this.desktop };
  }

  private async launch(name: string) {
    const t = this.tokens.get(name)!;
    const worker = new CompanionWorker({
      hubUrl: t.hubUrl, token: t.token, deviceId: t.deviceId, owner: "shared",
      executors: this.executorsFor(name), ledger: this.ledgers.get(name), heartbeatMs: 100, pollWaitMs: 400, interactive: async () => true,
      fetchImpl: ((input: any, init?: any) => (this.dead.has(name) ? Promise.reject(new Error("killed")) : fetch(input, init))) as typeof fetch,
      log: () => undefined,
    }).start();
    this.workers.set(name, worker);
    await worker.waitOnline(3_000);
  }

  async start(h: AdapterHandle) {
    this.calls.start.push(String(h.name));
    if (!this.alive(String(h.name))) await this.launch(String(h.name));
  }
  async stop(h: AdapterHandle) {
    this.calls.stop.push(String(h.name));
    await this.workers.get(String(h.name))?.stop();
  }
  /** What the computer was last told about a person holding it. */
  holds: Record<string, boolean> = {};
  async setHold(h: AdapterHandle, held: boolean) {
    this.holds[String(h.name)] = held;
  }
  async suspend(h: AdapterHandle) {
    this.calls.suspend.push(String(h.name));
    await this.workers.get(String(h.name))?.stop();
  }
  async resume(h: AdapterHandle) {
    this.calls.resume.push(String(h.name));
    await this.launch(String(h.name));
  }
  async recover(h: AdapterHandle) {
    this.calls.recover.push(String(h.name));
    await this.workers.get(String(h.name))?.stop().catch(() => undefined);
    this.dead.delete(String(h.name));
    await this.launch(String(h.name)); // same token, same ledger: the pairing and the record of what ran survive
  }
  async destroy(h: AdapterHandle) {
    this.calls.destroy.push(String(h.name));
    await this.workers.get(String(h.name))?.stop();
    this.workers.delete(String(h.name));
  }
  alive(name: string) {
    const w = this.workers.get(name);
    return !!w && w.state !== "stopped" && w.state !== "unpaired";
  }
  /** Simulate a crash: the process is gone, nothing said goodbye (kill -9). */
  crash(name: string) {
    this.dead.add(name);
    const w = this.workers.get(name);
    if (w) void w.stop();
  }
  async probe(h: AdapterHandle): Promise<ProbeResult> {
    const name = String(h.name);
    return { hostUp: true, companionAlive: this.alive(name), displayAlive: this.desktop ? this.alive(name) : null, vncAlive: this.vncUp, browserAlive: false, resource: { rssMb: this.rssMb, cpuPct: 3, procs: 4, sampledAt: Date.now() }, at: Date.now(), ...this.probeOverride };
  }
  async snapshot() {
    return this.desktop && !this.snapshotFails ? { mime: "image/jpeg" as const, data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) } : null;
  }
  /** What a viewer's bytes looked like when they reached this computer's VNC server (after the hub's filter). */
  vncInput: Buffer[] = [];
  /** "real": a small but proper RFB server (ordered handshake, answers framebuffer requests with a solid-colour frame), for a real noVNC client. */
  rfb: "canned" | "real" = "canned";
  /** What the real-mode server saw from the viewer after its filter: pointer and key events, and framebuffer requests. */
  rfbSeen = { pointer: 0, key: 0, updateRequests: 0 };
  async openVnc(): Promise<VncStream | null> {
    if (!this.vncUp) return null;
    const server = new TransformStream<Uint8Array, Uint8Array>();
    const w = server.writable.getWriter();
    if (this.rfb === "real") {
      let buf = Buffer.alloc(0);
      let stage = 0;
      let shifts = { r: 16, g: 8, b: 0 }; // until the client sends SetPixelFormat (noVNC does, with its own)
      const W = 64, H = 48;
      const init = Buffer.alloc(24 + 1);
      init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2);
      Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
      init.writeUInt32BE(1, 20); init.write("x", 24);
      void w.write(Buffer.from("RFB 003.008\n", "latin1"));
      const seen = this.rfbSeen;
      return {
        read: server.readable,
        write: new WritableStream<Uint8Array>({
          write: (chunk) => {
            this.vncInput.push(Buffer.from(chunk));
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
              if (stage === 0 && buf.length >= 12) { buf = buf.subarray(12); stage = 1; void w.write(Buffer.from([1, 1])); continue; }
              if (stage === 1 && buf.length >= 1) { buf = buf.subarray(1); stage = 2; void w.write(Buffer.alloc(4)); continue; }
              if (stage === 2 && buf.length >= 1) { buf = buf.subarray(1); stage = 3; void w.write(init); continue; }
              if (stage < 3 || !buf.length) break;
              const n = messageLength(buf);
              if (n <= 0 || buf.length < n) break;
              const t = buf[0];
              if (t === 0) shifts = { r: buf[14], g: buf[15], b: buf[16] };
              else if (t === 3 && buf[1] === 0) {
                // a full (non-incremental) request is answered; incremental ones are left waiting, like an idle screen
                seen.updateRequests++;
                const rect = Buffer.alloc(4 + 12 + W * H * 4);
                rect.writeUInt16BE(1, 2);
                rect.writeUInt16BE(W, 8); rect.writeUInt16BE(H, 10);
                for (let i = 0; i < W * H; i++) rect.writeUInt32LE(((0xc8 << shifts.r) | (0x1e << shifts.g) | (0x1e << shifts.b)) >>> 0, 16 + i * 4); // R=0xc8 G=0x1e B=0x1e
                void w.write(rect);
              } else if (t === 5) seen.pointer++;
              else if (t === 4) seen.key++;
              buf = buf.subarray(n);
            }
          },
        }),
        close: () => void w.close().catch(() => undefined),
      };
    }
    const serverInit = Buffer.concat([Buffer.alloc(20), Buffer.from([0, 0, 0, 1]), Buffer.from("x")]);
    // The server's whole side of the handshake, as a real x11vnc -nopw would send it: version, security types (None), result, ServerInit.
    void w.write(Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"),Buffer.from([1, 1]), Buffer.alloc(4), serverInit]));
    return {
      read: server.readable,
      write: new WritableStream<Uint8Array>({ write: (chunk) => void this.vncInput.push(Buffer.from(chunk)) }),
      close: () => void w.close().catch(() => undefined),
    };
  }
  async closeAll() {
    for (const w of this.workers.values()) await w.stop().catch(() => undefined);
  }
}

export type Who = "usman" | "mehroz";

export async function startComputersHub(opts: { /** Reuse an earlier hub's data folder and port: a hub restart. */ restart?: { root: string; port: number }; goalAsk?: ControlAsk | null; research?: ComputersOptions["research"]; /** Keep saved workflow results (builder, audit, business preparation, and research reports) in the hub's data folder; `workflows` sets their model and the audit's allowed hosts. */ artifacts?: boolean; workflows?: ComputersOptions["workflows"]; routeDelegate?: ComputersOptions["routeDelegate"]; idleSuspendMs?: number; host?: InProcessHost; clock?: { now: () => number }; leaseOptions?: { agentLeaseTtlMs?: number; personLeaseTtlMs?: number; viewerCloseGraceMs?: number }; autoRecover?: boolean; /** How long a finished workflow waits for the conversation before the job settles anyway. */ deliverTimeoutMs?: number; deliverRetryMs?: number; /** How long a connected viewer waits for a first frame before the screen reads "no picture". */ viewerNoFrameMs?: number; hubUrlFor?: ComputersOptions["hubUrlFor"]; maxAutoRecoveries?: number; recoveryHealthyMs?: number; /** The Dot gateway's hub-side trust, handed to the viewer (scripts/gateway tests). */ gateway?: import("../gateway/hub").GatewayTrust } = {}) {
  const root = opts.restart?.root ?? mkdtempSync(join(tmpdir(), "computers-hub-"));
  if (!opts.restart) mkdirSync(join(root, ".operator-data"));
  if (!opts.restart) writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGINS.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz] }] }));
  const host = opts.host ?? new InProcessHost();
  const devices: DevicesService = createDevicesService({ root, token: PAGE_TOKEN, tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET, maxWaitMs: 400, observeWaitMs: 500, hubRole: "cloud" });
  const jobs = new JobService({ path: join(root, ".operator-data", "jobs.sqlite"), stopGraceMs: 1500, snapshotMs: 0 });
  // A restarted hub runs the same startup recovery the real runtime does (scripts/jobs/runtime.ts): running jobs become unknown, queued ones interrupted, nothing re-run.
  if (opts.restart) jobs.recover();
  let base = "";
  const artifacts = opts.artifacts ? createArtifactStore(join(root, ".operator-data", "artifacts")) : undefined;
  const computers: ComputersService = createComputersService({
    root, devices, artifacts, workflows: opts.workflows, routeDelegate: opts.routeDelegate, jobs: () => jobs, adapters: { "test-host": host }, hubUrlFor: opts.hubUrlFor ?? (() => base), maxAutoRecoveries: opts.maxAutoRecoveries, recoveryHealthyMs: opts.recoveryHealthyMs,
    now: opts.clock?.now, agentLeaseTtlMs: opts.leaseOptions?.agentLeaseTtlMs, personLeaseTtlMs: opts.leaseOptions?.personLeaseTtlMs, viewerCloseGraceMs: opts.leaseOptions?.viewerCloseGraceMs,
    monitorMs: 60_000, deliverTimeoutMs: opts.deliverTimeoutMs, deliverRetryMs: opts.deliverRetryMs, autoRecover: opts.autoRecover ?? false, recoverDelayMs: 0, startGraceMs: 5_000, idleSuspendMs: opts.idleSuspendMs, goalAsk: opts.goalAsk, research: opts.research,
  });
  const routes = createComputersRoutes({ devices, computers, artifacts, root: process.cwd(), isBotResult: (id) => !!jobs.get(id)?.bot });
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/__token") {
      // What the real gate serves an owner's browser: the page token for writes.
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ token: PAGE_TOKEN }));
    }
    if (path.startsWith("/__computers")) return void routes.handle(req, res);
    void devices.handle(req, res);
  });
  const detach = attachViewer(server, { devices, computers, noFrameMs: opts.viewerNoFrameMs, ...(opts.gateway ? { gateway: opts.gateway } : {}) });
  await new Promise<void>((r) => server.listen(opts.restart?.port ?? 0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;

  // Each founder's own confirmed session (a human at a browser): Usman at the hub, Mehroz over the simulated tailnet.
  const usmanCookie = encodeURIComponent(devices.store.mintSession("usman", "Usman's browser", "hub").cookie);
  const mehrozCookie = encodeURIComponent(devices.store.mintSession("mehroz", "Mehroz's browser", "code").cookie);

  function headers(who: Who | "program", write: boolean): Record<string, string> {
    if (who === "usman") return { host: `127.0.0.1:${port}`, cookie: `mu_session=${usmanCookie}`, ...(write ? { "x-claude-os-token": PAGE_TOKEN, "content-type": "application/json" } : {}) };
    if (who === "program") return { host: `127.0.0.1:${port}`, ...(write ? { "x-claude-os-token": PAGE_TOKEN, "content-type": "application/json" } : {}) };
    return {
      host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS.mehroz, "x-forwarded-for": "100.64.0.12", cookie: `mu_session=${mehrozCookie}`,
      ...(write ? { "x-claude-os-token": pageTokenFor({ personId: "mehroz", via: "tailnet-person" }, PAGE_TOKEN), "content-type": "application/json" } : {}),
    };
  }

  async function api(who: Who | "program", method: string, path: string, body?: unknown, prefix = "/__computers") {
    const res = await fetch(`${base}${prefix}${path}`, { method, headers: headers(who, method !== "GET"), body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, json: type.includes("json") ? ((await res.json().catch(() => ({}))) as any) : null, bytes: type.includes("json") ? null : new Uint8Array(await res.arrayBuffer()) };
  }

  async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 8_000): Promise<NonNullable<T>> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** `abrupt`: the hub process is killed (kill -9): nothing is cancelled gracefully and the old job runner can write nothing more (its store handle is gone), so a running job stays `running` in the store for the next hub to find. */
  async function close(keep: { root?: boolean; host?: boolean; abrupt?: boolean } = {}) {
    // abrupt: the DB handle goes first, with the "process" (JobService.close refuses while a job runs), so nothing the old runner does from here can be written
    if (keep.abrupt) (jobs as unknown as { db: { close(): void } }).db.close();
    detach();
    if (!keep.abrupt) await computers.close();
    if (!keep.host) await host.closeAll();
    devices.close();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    try {
      if (!keep.abrupt) jobs.close();
    } catch {
      /* a job was still running */
    }
    if (!keep.root) rmSync(root, { recursive: true, force: true });
  }

  return { root, base, port, host, devices, jobs, computers, artifacts, api, headers, waitFor, close };
}

export type ComputersHub = Awaited<ReturnType<typeof startComputersHub>>;

/** Register a personal PC (a companion for a person) that is online, with the executors the test wants it to have. */
export async function pairPersonalPc(hub: ComputersHub, person: Who, executors: Record<string, Executor> = { echo: async () => ({ ok: true, said: "Echoed.", verified: true }) }) {
  const code = hub.devices.store.createCode(person, "companion", person).code;
  const headers: Record<string, string> = person === "usman" ? { host: `127.0.0.1:${hub.port}` } : { host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS.mehroz, "x-forwarded-for": "100.64.0.12" };
  const res = await fetch(`${hub.base}/__devices/companion/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ code, label: `${person}'s PC` }) });
  const json: any = await res.json();
  if (res.status !== 200) throw new Error(`personal pairing refused: ${JSON.stringify(json)}`);
  const ran: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(executors).map(([k, fn]) => [k, (async (a: any, c: any) => (ran.push(k), fn(a, c))) as Executor]));
  const worker = new CompanionWorker({ hubUrl: hub.base, token: json.token, deviceId: json.deviceId, owner: person, executors: wrapped, heartbeatMs: 100, pollWaitMs: 400, interactive: async () => true, extraHeaders: person === "usman" ? {} : { host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS.mehroz, "x-forwarded-for": "100.64.0.12" }, log: () => undefined }).start();
  await worker.waitOnline(3_000);
  return { deviceId: json.deviceId as string, worker, ran };
}

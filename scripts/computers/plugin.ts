import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite";
import { dataDirFor } from "../cloud/data-dir";
import { providerKey } from "../provider-config";
import { createControlAsk } from "../screen-hands/jev-control";
import type { DevicesService } from "../devices/service";
import type { JobService } from "../jobs/service";
import { createComputersRoutes } from "./routes";
import { createArtifactStore } from "./artifacts";
import { DEFAULT_AUDIT_SITES } from "./workflows";
import { routedDelegate, searxngSearch, threadDeliver } from "./research-wiring";
import type { ThreadStore } from "../jarvis-command/threads";
import { createComputersService, type ComputersOptions, type ComputersService } from "./service";
import { attachViewer } from "./viewer";
import { hubRole } from "../cloud/hub-role";
import { createLocalOwnerProof } from "../identity/local-owner-token";
import { defaultSshBin, VpsSshAdapter } from "./vps-ssh";
import { WslLocalAdapter } from "./wsl-local";

/**
 * Mount shared agent cloud computers on the dev/cloud hub. Nothing starts until a computer is provisioned: with no host configured
 * the routes answer, the list is empty and provisioning says "No computer host is configured on this hub."
 *
 * Hosts come from the hub's environment (names only; none of these is a secret):
 *   MU_COMPUTERS_WSL_DISTRO=kali-linux     the WSL2 stand-in (this PC)
 *   MU_COMPUTERS_BRIDGE_PORT=8113          pin the WSL bridge's port (default: the host allocator gives this hub its own, stable across restarts)
 *   MU_COMPUTERS_SSH_ALIAS=ryzen-bots      a Linux host over SSH, through a Host block in the hub's own ssh config (the LAN PC; or a Sydney VPS)
 *   MU_COMPUTERS_SSH_WSL_DISTRO=kali-linux the host is Windows: run the script inside that WSL distro (wsl.exe -d <distro> -u root --exec ...); unset = plain Linux host
 *   MU_COMPUTERS_SSH_RUN_AS_PREFIX=mu-      one Linux user per computer (<prefix><name>), so the browser keeps its sandbox and files are separate (script runs as root)
 *   MU_COMPUTERS_SSH_COMPUTERS_HOME=/var/lib/mu-computers   where computers live on the host (must be readable by those users)
 *   MU_COMPUTERS_SSH_WSL_USER=root         the WSL user the script runs as (default root; an unprivileged user keeps the browser sandbox)
 *   MU_COMPUTERS_SSH_REMOTE_PORT=18091     loopback port ON the host that the reverse tunnel points at this hub's bridge
 *   MU_COMPUTERS_SSH_TUNNEL=off            the hub runs ON the host: skip the tunnel, companions use the hub's loopback
 *   MU_COMPUTERS_SSH_BIN=<path>            the ssh program (default: C:/Windows/System32/OpenSSH/ssh.exe on Windows, else ssh)
 *   MU_COMPUTERS_HOST_LABEL_SSH=<words>    how saved results name the SSH host (default: "Linux host over SSH"); MU_COMPUTERS_HOST_LABEL_WSL for the local WSL
 *   MU_AUDIT_SITES=a.example,b.example     the exact hosts a website audit may open (default: M&U's own dental demo site)
 *   MU_COMPUTERS_AGENT_LEASE_MS / MU_COMPUTERS_PERSON_LEASE_MS / MU_COMPUTERS_MONITOR_MS   lease lengths (default 60 s / 90 s) and probe interval (10 s)
 *   MU_COMPUTERS_DISPLAY_BASE=101          first X display number handed out (default 101; give a second hub on the same host its own range, e.g. 201)
 *   MU_COMPUTERS_IDLE_SUSPEND_MS=900000    suspend a computer idle this long (default: never; a job wakes it)
 */

export type MountComputersOptions = {
  root: string;
  devices: DevicesService;
  jobs: () => JobService;
  env?: Record<string, string | undefined>;
  /** The conversation store: a research job's report is returned to the conversation it was started from. Absent: the report stays in the job and on the computer. */
  conversations?: ThreadStore;
  /** Where the companion bundle is built to (default: <data dir>/computers/companion.mjs). */
  bundlePath?: string;
};

export function mountComputers(server: ViteDevServer, options: MountComputersOptions): ComputersService {
  const env = options.env ?? process.env;
  const adapters: ComputersOptions["adapters"] = {};
  let hubPort = 0;
  // Who owns this hub's computers in the host allocator: stable for this data folder, different for every other hub on the host.
  const hubId = createHash("sha1").update(resolve(dataDirFor(options.root))).digest("hex").slice(0, 10);
  const bundlePath = options.bundlePath ?? join(dataDirFor(options.root), "computers", "companion.mjs");
  const artifacts = createArtifactStore(join(dataDirFor(options.root), "computers", "artifacts"));
  const sshLabel = env.MU_COMPUTERS_HOST_LABEL_SSH?.trim() || "Linux host over SSH";
  const wslLabel = env.MU_COMPUTERS_HOST_LABEL_WSL?.trim() || "WSL on the hub PC";
  const delegate = env.MU_RESEARCH_MODEL === "off" ? null : routedDelegate({ root: options.root });
  const computers = createComputersService({
    root: options.root,
    artifacts,
    workflows: {
      delegate,
      allowedAuditHosts: env.MU_AUDIT_SITES?.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) ?? DEFAULT_AUDIT_SITES,
      hostLabel: (adapter) => (adapter === "vps-ssh" ? sshLabel : adapter === "wsl-local" ? wslLabel : adapter),
    },
    devices: options.devices,
    jobs: options.jobs,
    adapters,
    bundlePath,
    // Jev is asked HERE, on the hub, for open-ended goals; the key is read by name and never leaves this process. No key: goal steps are refused up front.
    goalAsk: providerKey(options.root, "TYPESAFE_API_KEY", { env }) || providerKey(options.root, "JEV_API_KEY", { env })
      ? createControlAsk({ key: () => providerKey(options.root, "TYPESAFE_API_KEY", { env }) || providerKey(options.root, "JEV_API_KEY", { env }) })
      : null,
    // Research: the hub's own SearXNG, a connected model on the free text route, and the way back to the conversation.
    research: {
      search: env.MU_RESEARCH === "off" ? null : searxngSearch(),
      delegate,
      deliver: async (i) => (options.conversations ? threadDeliver(options.conversations)(i) : { delivered: false, where: "no conversation store" }),
    },
    agentLeaseTtlMs: Number(env.MU_COMPUTERS_AGENT_LEASE_MS) || undefined,
    personLeaseTtlMs: Number(env.MU_COMPUTERS_PERSON_LEASE_MS) || undefined,
    monitorMs: Number(env.MU_COMPUTERS_MONITOR_MS) || undefined,
    idleSuspendMs: Number(env.MU_COMPUTERS_IDLE_SUSPEND_MS) || undefined,
    buildBundle: async (outfile) => {
      // A variable specifier keeps this out of the dev server's module graph and the root type-check (it uses Bun's build API).
      const builder = resolve(options.root, "deploy", "computers", "build-companion.ts");
      const mod = (await import(/* @vite-ignore */ pathToFileURL(builder).href)) as { buildCompanion(outfile: string): Promise<unknown> };
      await mod.buildCompanion(outfile);
    },
    hubUrlFor: async (kind, adapter) => {
      if (kind === "wsl-local") return (adapter as WslLocalAdapter).hubUrl();
      // A vps-ssh host reaches the hub through its one supervised reverse tunnel (or the hub's loopback when the hub runs on that host).
      if (kind === "vps-ssh") return (adapter as VpsSshAdapter).hubUrl();
      return `http://127.0.0.1:${hubPort}`;
    },
  });
  const routes = createComputersRoutes({ devices: options.devices, computers, artifacts, root: options.root });
  server.middlewares.use("/__computers", (req, res, next) => void routes.handle(req, res, next));

  const configure = () => {
    const address = server.httpServer?.address();
    hubPort = typeof address === "object" && address ? address.port : Number(server.config?.server?.port ?? 0);
    const distro = env.MU_COMPUTERS_WSL_DISTRO?.trim();
    if (distro) {
      const wsl = new WslLocalAdapter(distro);
      wsl.hubPort = hubPort;
      wsl.bridgePort = Number(env.MU_COMPUTERS_BRIDGE_PORT) || 0; // 0: the host allocator picks this hub's port
      wsl.hubId = hubId;
      adapters["wsl-local"] = wsl;
    }
    const alias = env.MU_COMPUTERS_SSH_ALIAS?.trim();
    if (alias) {
      const vps = new VpsSshAdapter(alias, undefined, undefined, undefined, {
        wslDistro: env.MU_COMPUTERS_SSH_WSL_DISTRO?.trim() || undefined,
        wslUser: env.MU_COMPUTERS_SSH_WSL_USER?.trim() || undefined,
        runAsPrefix: env.MU_COMPUTERS_SSH_RUN_AS_PREFIX?.trim() || undefined,
        computersHome: env.MU_COMPUTERS_SSH_COMPUTERS_HOME?.trim() || undefined,
        remotePort: Number(env.MU_COMPUTERS_SSH_REMOTE_PORT) || undefined,
        tunnel: env.MU_COMPUTERS_SSH_TUNNEL?.trim().toLowerCase() === "off" ? false : true,
        sshBin: defaultSshBin(env),
        tunnelPidFile: join(dataDirFor(options.root), "computers", `ssh-tunnel-${alias}.pid`),
      });
      vps.hubPort = hubPort;
      vps.hubId = hubId;
      adapters["vps-ssh"] = vps;
    }
    // Computers already provisioned before a restart keep being watched, and the bridge they connect through is brought back up FIRST:
    // their companions dial the bridge's address, so without it a restarted hub would never hear from them again.
    const existing = computers.store.list();
    for (const r of existing) {
      const a = adapters[r.adapter] as { hubUrl?: () => Promise<string> } | undefined;
      void a?.hubUrl?.().catch((e: Error) => console.error("[computers] couldn't restore the bridge:", e.message));
    }
    if (existing.length) computers.startMonitor();
  };
  if (server.httpServer?.listening) configure();
  else server.httpServer?.once("listening", configure);

  if (server.httpServer) {
    const detach = attachViewer(server.httpServer as unknown as Server, { devices: options.devices, computers, ...(hubRole() === "server" ? { localOwnerProof: createLocalOwnerProof(options.root) } : {}) });
    server.httpServer.once("close", () => {
      detach();
      void computers.close();
    });
  }
  return computers;
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { createBridge } from "./bridge";
import { defaultRunner } from "./wsl-local";
import { ScriptAdapter, type HostRunner } from "./script-adapter";
import { SshTunnel, type TunnelSpawn, type TunnelStatus } from "./ssh-tunnel";
import type { AdapterHandle, HostCheck, VncStream } from "./types";

/**
 * "vps-ssh": any Linux host reached over SSH with the SAME script the WSL stand-in runs (deploy/computers/linux/computer-ctl.sh):
 * a Sydney VPS, or the second Windows PC on the LAN ("Ryzen-PC": Windows OpenSSH Server, computers inside its WSL2 distro).
 * docs/programme-20261001/LAN-BOT-HOST.md has the topology and the runbook.
 *
 *  - `sshAlias` is a Host block in the hub's own ~/.ssh/config (key auth, `BatchMode yes`, StrictHostKeyChecking yes). This code
 *    never sees a key or password and never accepts a host key it has not been shown.
 *  - Every action is `ssh <alias> [<wsl prefix>] bash -s -- <action> <args>` with the script on stdin. Windows sshd's shell is cmd,
 *    so for a WSL host the prefix is `wsl.exe -d <distro> -u <user> --exec` (MU_COMPUTERS_SSH_WSL_DISTRO); unset means a plain Linux host.
 *  - The companion runs INSIDE the host and reaches the hub through ONE supervised reverse tunnel (`ssh -R`): the host's loopback
 *    port <remotePort> is the hub's bridge (bridge.ts: only the seven companion routes, bound to this PC's loopback). The hub opens
 *    no port on the LAN. With `tunnel: false` (the hub runs ON the VM) the companion simply uses the hub's loopback.
 *  - VNC: x11vnc binds 127.0.0.1 on the host (WSL2 mirrored networking shares loopback with Windows); the hub reaches it with
 *    `ssh -W 127.0.0.1:<port>` (stdio forwarding), so there is never a VNC port on the LAN.
 *  - suspend = stop the services. A stronger "sleep" (a provider snapshot) is a provider API call this adapter does not make.
 */

export type VpsSshOptions = {
  /** Run the script inside this WSL distro on a Windows host. Unset: the host itself is Linux. */
  wslDistro?: string;
  wslUser?: string;
  /** Loopback port on the HOST that reaches the hub's bridge. */
  remotePort?: number;
  /** Reverse-tunnel the hub to the host (default true). False when the hub runs on the host itself. */
  tunnel?: boolean;
  /** The ssh program. Default: Windows OpenSSH on Windows (Git's bundled ssh is first on PATH there), else `ssh`. */
  sshBin?: string;
  /** Where computers live on the host (default: the host user's ~/mu-computers). With per-computer users it must be readable by them (e.g. /var/lib/mu-computers). */
  computersHome?: string;
  /** Run each computer as its own Linux user named <prefix><name> (needs the script to run as root). Chromium then keeps its sandbox. */
  runAsPrefix?: string;
  /** Local loopback port for the bridge (0: any free port; the tunnel is told which). */
  bridgePort?: number;
  spawnTunnel?: TunnelSpawn;
  tunnelSettleMs?: number;
  tunnelBackoffMs?: number[];
  /** Where the tunnel keeps its ssh pid (so a hub restarted after a hard kill can stop the orphan). */
  tunnelPidFile?: string;
};

const WINDOWS_SSH = "C:/Windows/System32/OpenSSH/ssh.exe";
export function defaultSshBin(env: Record<string, string | undefined> = process.env): string {
  const set = env.MU_COMPUTERS_SSH_BIN?.trim();
  if (set) return set;
  return process.platform === "win32" && existsSync(WINDOWS_SSH) ? WINDOWS_SSH : "ssh";
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/; // never starts with "-": it would read as an ssh/wsl option
const READY_MARKER = "mu-tunnel-ready";

export class VpsSshAdapter extends ScriptAdapter {
  readonly kind = "vps-ssh";
  /** The hub's own port (set by the plugin once it is listening). */
  hubPort = 0;
  readonly sshBin: string;
  readonly wslDistro: string | null;
  readonly wslUser: string;
  readonly remotePort: number;
  readonly useTunnel: boolean;
  private bridgePort: number;
  private bridge: ReturnType<typeof createBridge> | null = null;
  private bridgeStarting: Promise<number> | null = null;
  private tunnel: SshTunnel | null = null;
  private bridgeLocalPort = 0;

  constructor(readonly sshAlias: string, runner: HostRunner = defaultRunner, script?: string, now?: () => number, private readonly opts: VpsSshOptions = {}) {
    super(runner, script, now);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(sshAlias)) throw new Error("bad ssh alias");
    this.wslDistro = opts.wslDistro?.trim() || null;
    if (this.wslDistro && !NAME_OK.test(this.wslDistro)) throw new Error("bad distro name");
    this.wslUser = opts.wslUser?.trim() || "root";
    if (!NAME_OK.test(this.wslUser)) throw new Error("bad wsl user");
    if (opts.runAsPrefix && !/^[a-z][a-z0-9]{0,7}-$/.test(opts.runAsPrefix)) throw new Error("bad run-as prefix");
    if (opts.computersHome && !/^\/[A-Za-z0-9._\/-]{1,100}$/.test(opts.computersHome)) throw new Error("bad computers home");
    this.remotePort = opts.remotePort ?? 18091;
    if (!Number.isInteger(this.remotePort) || this.remotePort < 1024 || this.remotePort > 65535) throw new Error("bad remote port");
    this.useTunnel = opts.tunnel !== false;
    this.bridgePort = opts.bridgePort ?? 0;
    this.sshBin = opts.sshBin ?? defaultSshBin();
  }

  /** `ssh` options every call shares: key auth only, never a prompt, a bounded connect. */
  private sshBase(): string[] {
    return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"];
  }

  /** What runs the Linux side: on a Windows host, wsl.exe inside the distro (the sshd cmd shell cannot run bash itself). */
  private remotePrefix(): string[] {
    return this.wslDistro ? ["wsl.exe", "-d", this.wslDistro, "-u", this.wslUser, "--exec"] : [];
  }

  private remote(...cmd: string[]): string[] {
    return [this.sshBin, ...this.sshBase(), this.sshAlias, ...this.remotePrefix(), ...cmd];
  }

  protected override hostEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.opts.runAsPrefix) env.MU_RUN_AS_PREFIX = this.opts.runAsPrefix;
    if (this.opts.computersHome) env.MU_COMPUTERS_HOME = this.opts.computersHome;
    return env;
  }

  protected shell(args: string[]): string[] {
    return this.remote("bash", "-s", "--", ...args);
  }

  /** Where computers live on the host (computer-ctl.sh's $MU_COMPUTERS_HOME default): never a shared, world-writable folder such as /tmp. */
  private computersHome(): string {
    if (this.opts.computersHome) return this.opts.computersHome;
    if (!this.wslDistro) return "$HOME/mu-computers"; // a Linux host's login shell expands it
    return `${this.wslUser === "root" ? "/root" : `/home/${this.wslUser}`}/mu-computers`;
  }
  /** The staged bundle's name inside the computers home; hub-specific so two hubs never share a file. */
  private stageName() {
    return `bundle-${this.hubId}.mjs`;
  }

  /** computer-ctl.sh resolves this relative name against its own computers home. */
  protected bundlePathOnHost(_localPath: string): string {
    return this.stageName();
  }

  /**
   * Push the companion bundle through ssh stdin with `dd` (no shell on the Windows side, so no quoting), as raw bytes, into the computers home
   * (owned by the host user, not /tmp). dd reads exactly the byte count, so a stdin that does not signal EOF cannot hang it. The sha256 is
   * checked on the host, then computer-ctl.sh copies it into place. Chosen over scp (into WSL it needs \wsl$ or a staging folder and a second
   * tool) and over `sh -c 'cat > x'` (cmd quotes differently from sh).
   */
  async installBundle(localPath: string) {
    const data = readFileSync(localPath);
    const sum = createHash("sha256").update(data).digest("hex");
    const stage = `${this.computersHome()}/${this.stageName()}`;
    const cleanup = () => this.run(this.remote("rm", "-f", `${stage}.new`, stage), { timeoutMs: 30_000 }).catch(() => undefined);
    try {
      const mk = await this.run(this.remote("mkdir", "-p", this.computersHome()), { timeoutMs: 30_000 });
      if (mk.code !== 0) throw new Error(`couldn't prepare the host's computers folder: ${mk.stderr.replace(/\s+/g, " ").slice(0, 160) || `exit ${mk.code}`}`);
      const push = await this.run(this.remote("dd", `of=${stage}.new`, "bs=65536", "iflag=fullblock,count_bytes", `count=${data.length}`, "status=none"), { stdin: data, timeoutMs: 180_000 });
      if (push.code !== 0) throw new Error(`couldn't copy the companion to the host: ${push.stderr.replace(/\s+/g, " ").slice(0, 160) || `exit ${push.code}`}`);
      const verify = await this.run(this.remote("sha256sum", `${stage}.new`), { timeoutMs: 30_000 });
      const got = /^([0-9a-f]{64})/.exec(verify.stdout.trim())?.[1];
      if (verify.code !== 0 || got !== sum) throw new Error("the companion arrived damaged on the host (checksum differs); nothing was installed");
      const mv = await this.run(this.remote("mv", "-f", `${stage}.new`, stage), { timeoutMs: 30_000 });
      if (mv.code !== 0) throw new Error("couldn't place the companion on the host");
      await super.installBundle(localPath);
    } finally {
      await cleanup();
    }
  }

  /** The reverse tunnel's ssh arguments (exported shape for tests and the runbook). */
  tunnelArgs(localBridgePort: number): string[] {
    const forward = `127.0.0.1:${this.remotePort}:127.0.0.1:${localBridgePort}`;
    const common = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-R", forward];
    // The remote command is `cat`: the hub writes a marker to its stdin and the tunnel is "up" when it comes back; cat also ends when the hub's
    // end closes (hub gone), and on a WSL host it keeps the distro from idling out while the hub is connected. (-N would run no remote command.)
    return [...common, this.sshAlias, ...this.remotePrefix(), "cat"];
  }

  /**
   * The address a computer's companion (inside the host) uses to reach the hub. With the tunnel: the host's own loopback port, which
   * the supervised reverse tunnel carries to the bridge here. Resolves once the tunnel has stayed up; a failure leaves it retrying.
   */
  async hubUrl(): Promise<string> {
    if (!this.hubPort) throw new Error("the hub's ports aren't known yet");
    if (!this.useTunnel) return `http://127.0.0.1:${this.hubPort}`;
    const port = await (this.bridgeStarting ??= this.startBridge().finally(() => (this.bridgeStarting = null)));
    this.tunnel ??= new SshTunnel({
      command: this.sshBin,
      args: this.tunnelArgs(port),
      spawnFn: this.opts.spawnTunnel,
      readyMarker: READY_MARKER,
      settleMs: this.opts.tunnelSettleMs,
      matchArgs: [`-R 127.0.0.1:${this.remotePort}:`, this.sshAlias],
      backoffMs: this.opts.tunnelBackoffMs,
      pidFile: this.opts.tunnelPidFile,
      onLog: (l) => console.error(`[computers] ${this.sshAlias}: ${l}`),
    });
    await this.tunnel.ensure();
    return `http://127.0.0.1:${this.remotePort}`;
  }

  private async startBridge(): Promise<number> {
    if (this.bridge) return this.bridgeLocalPort;
    // Loopback only: the bridge is reachable by this PC alone, and only through the tunnel's local end.
    const bridge = createBridge({ listenHost: "127.0.0.1", listenPort: this.bridgePort, targetPort: this.hubPort });
    const addr = await bridge.start();
    this.bridge = bridge;
    return (this.bridgeLocalPort = addr.port);
  }

  tunnelStatus(): TunnelStatus | null {
    return this.tunnel?.status() ?? null;
  }

  override async check(): Promise<HostCheck> {
    const c = await super.check();
    const t = this.tunnelStatus();
    if (this.useTunnel && t && t.state !== "up") c.notes.push(`the SSH tunnel to the hub is ${t.state}${t.lastExit?.stderr ? ` (${t.lastExit.stderr})` : ""}: computers on this host cannot reach the hub until it is up`);
    if (this.useTunnel && this.wslDistro) c.notes.push("computers on this host run only while WSL is awake: it idles out when nothing runs in it and this hub's tunnel is down (an owner-side keep-alive on that PC makes that durable; LAN-BOT-HOST.md)");
    return c;
  }

  async close() {
    this.tunnel?.close();
    this.tunnel = null;
    await this.bridge?.close();
    this.bridge = null;
    this.bridgeLocalPort = 0;
  }

  async openVnc(handle: AdapterHandle): Promise<VncStream | null> {
    const port = Number(handle.vncPort);
    if (!Number.isInteger(port) || port < 5901 || port > 6999) return null;
    const probe = await this.probe(handle);
    if (!probe.vncAlive) return null;
    const child = spawn(this.sshBin, ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-W", `127.0.0.1:${port}`, this.sshAlias], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return {
      read: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      write: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      close: () => void child.kill(),
    };
  }
}

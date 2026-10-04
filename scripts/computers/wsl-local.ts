import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { Readable, Writable } from "node:stream";
import { createBridge } from "./bridge";
import { ScriptAdapter, type ExecResult, type HostRunner } from "./script-adapter";
import type { AdapterHandle, VncStream } from "./types";

/**
 * "wsl-local": one WSL2 distro standing in for a cloud VM. Each computer is a folder plus a few processes inside the
 * distro (own X display, own Chromium profile, own working folder, its own companion); the hub reaches them only by running
 * `wsl.exe -d <distro> -- bash -s -- <action>` with deploy/computers/linux/computer-ctl.sh on stdin. Nothing listens on the
 * Windows side for the desktop: the VNC server binds 127.0.0.1 inside the distro and the hub gets to it through a
 * `wsl.exe ... /dev/tcp` byte pipe, so there is no Windows port to find.
 *
 * What it is not: isolation as strong as a VM. The distro shares the owner's PC (kernel, disk, interop with Windows). It
 * proves the design and the code paths; a real VM (vps-ssh.ts) replaces it without changing anything above the adapter.
 */

export const defaultRunner: HostRunner = (argv, opts = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr: stderr.replace(/\u0000/g, "") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
  });

/** `D:\x\y.mjs` -> `/mnt/d/x/y.mjs` (the path WSL sees the Windows file at). */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

export class WslLocalAdapter extends ScriptAdapter {
  readonly kind = "wsl-local";
  private bridge: ReturnType<typeof createBridge> | null = null;
  private bridgeUrl: string | null = null;
  /** The bridge being started right now: two computers provisioned at once must share ONE bridge, not race to bind its port. */
  private bridgeStarting: Promise<string> | null = null;
  /** The hub's own port and the bridge's (WSL2's NAT network cannot see the hub's loopback). */
  hubPort = 0;
  /** 0 = ask the host allocator (the default). */
  bridgePort = 0;
  bridgeUrlPort = 0;

  constructor(readonly distro: string, runner: HostRunner = defaultRunner, script?: string, now?: () => number) {
    super(runner, script, now);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(distro)) throw new Error("bad distro name");
  }

  protected shell(args: string[]): string[] {
    return ["wsl.exe", "-d", this.distro, "--", "bash", "-s", "--", ...args];
  }

  protected bundlePathOnHost(localPath: string): string {
    return toWslPath(localPath);
  }

  /** The Windows side of the WSL virtual switch: the default gateway inside the distro, which is how the distro sees this PC. */
  async hostAddress(): Promise<string> {
    const r = await this.run(["wsl.exe", "-d", this.distro, "--", "ip", "route", "show", "default"], { timeoutMs: 15_000 });
    const m = /default via (\d+\.\d+\.\d+\.\d+)/.exec(r.stdout);
    if (!m) throw new Error("couldn't find the address this PC has on the WSL network");
    return m[1];
  }

  /**
   * The address a computer's companion uses to reach the hub: the bridge on that one interface (scripts/computers/bridge.ts), started
   * on first use. The computers never see the hub's loopback, and nothing but the companion wire routes goes through.
   */
  async hubUrl(): Promise<string> {
    if (this.bridgeUrl) return this.bridgeUrl;
    if (!this.hubPort) throw new Error("the hub's ports aren't known yet");
    // Concurrent callers await the same start (found in the round-3 real run: two computers provisioned together both tried to bind the port).
    this.bridgeStarting ??= this.startBridge().finally(() => (this.bridgeStarting = null)); // a failure leaves nothing half-made: the next call tries again
    return this.bridgeStarting;
  }

  /**
   * The bridge's port: the one the owner pinned (MU_COMPUTERS_BRIDGE_PORT), else the host allocator's per-hub port (stable across this hub's restarts, so
   * running companions still find it, and never another hub's). If the PC refuses a port the allocator chose, ask for another.
   */
  private async startBridge(): Promise<string> {
    const host = await this.hostAddress();
    const avoid: number[] = [];
    for (let attempt = 0; ; attempt++) {
      const port = this.bridgePort || (await this.allocBridgePort(avoid));
      const bridge = createBridge({ listenHost: host, listenPort: port, targetPort: this.hubPort });
      try {
        await bridge.start();
      } catch (e) {
        if (this.bridgePort || attempt >= 5) throw e;
        avoid.push(port);
        continue;
      }
      this.bridge = bridge;
      this.bridgeUrlPort = port;
      return (this.bridgeUrl = `http://${host}:${port}`);
    }
  }
  async close() {
    await this.bridge?.close();
    this.bridge = null;
    this.bridgeUrl = null;
  }

  /** A byte pipe to this computer's VNC server: `wsl.exe` running bash's /dev/tcp inside the distro. No Windows port is opened. */
  async openVnc(handle: AdapterHandle): Promise<VncStream | null> {
    const port = Number(handle.vncPort);
    if (!Number.isInteger(port) || port < 5901 || port > 6999) return null;
    const probe = await this.probe(handle);
    if (!probe.vncAlive) return null;
    const child = spawn("wsl.exe", ["-d", this.distro, "--", "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3`], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return {
      read: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      write: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      close: () => void child.kill(),
    };
  }
}

// Kept for tests that want a raw loopback probe of a host port without a process.
export function portOpen(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    const done = (ok: boolean) => (s.destroy(), resolve(ok));
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

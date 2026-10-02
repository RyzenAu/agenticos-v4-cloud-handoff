import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventEmitter } from "node:events";

/**
 * One supervised `ssh -R` reverse tunnel to a host: the host's loopback port <remotePort> reaches a loopback port on this hub PC
 * (the bridge, scripts/computers/bridge.ts). It is how a computer's companion on another machine reaches the hub without the hub
 * opening any port on the LAN. If ssh dies (network blip, host reboot, port already taken) it is started again with a growing
 * delay; nothing here ever gives up until close().
 *
 * "Up" is a positive signal, not a timer: the remote command is `cat`, the hub writes a marker line to ssh's stdin, and the tunnel is up
 * only when `cat` echoes it back (so authentication, the session and, with ExitOnForwardFailure, the forward all worked). Because `cat`
 * ends when its stdin closes, a hub that dies takes its remote session (and the ssh) with it. Without a marker (tests, odd hosts) it falls back
 * to "ssh has stayed alive for settleMs".
 */

export type TunnelChild = EventEmitter & {
  kill(signal?: NodeJS.Signals | number): boolean;
  stderr?: EventEmitter | null;
  stdout?: EventEmitter | null;
  stdin?: { write(chunk: string): unknown; on?(ev: string, cb: () => void): unknown } | null;
  pid?: number;
};
export type TunnelSpawn = (command: string, args: string[]) => TunnelChild;

export type TunnelOptions = {
  command: string;
  args: string[];
  spawnFn?: TunnelSpawn;
  /** Delays between restarts; the last one repeats. */
  backoffMs?: number[];
  /** Positive readiness signal: written to ssh's stdin, and expected back on its stdout. */
  readyMarker?: string;
  /** Fallback when there is no marker: how long ssh must stay alive. With a marker, the longest to wait for the echo before the attempt is abandoned. */
  settleMs?: number;
  /** The backoff only restarts from its first step after the tunnel has stayed up this long (default 60 s), so a flapping tunnel keeps backing off. */
  healthyMs?: number;
  onLog?: (line: string) => void;
  /**
   * Where the running ssh's pid is kept. A hub killed hard leaves its ssh behind, still holding the host's remote port, so the next
   * hub's tunnel would be refused for good; on the first start the leftover is stopped, but only if its command line is this tunnel's.
   */
  pidFile?: string;
  /** Strings that must ALL appear in a leftover process's command line before it is killed (e.g. `-R 127.0.0.1:18091:` and the alias). */
  matchArgs?: string[];
  /** Is this pid our tunnel's ssh? (Injected in tests.) */
  isOurTunnel?: (pid: number, needles: string[]) => boolean;
};

export type TunnelStatus = { state: "idle" | "starting" | "up" | "backoff" | "closed"; restarts: number; lastExit: { code: number | null; at: number; stderr: string } | null };

/** The command line of a process, or "" when it is gone. */
export function commandLineOf(pid: number): string {
  try {
    const r =
      process.platform === "win32"
        ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
        : spawnSync("ps", ["-p", String(Math.trunc(pid)), "-o", "args="], { encoding: "utf8" });
    return String(r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/** Only an ssh whose command line carries every needle is ours: an image name alone could be an unrelated ssh after the pid was reused. */
export function isOurTunnel(pid: number, needles: string[]): boolean {
  const line = commandLineOf(pid);
  return /(^|[\\/"\s])ssh(\.exe)?\b/i.test(line.split(/\s-/)[0] ?? "") && needles.length > 0 && needles.every((n) => line.includes(n));
}

const defaultSpawn: TunnelSpawn = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as TunnelChild;

export class SshTunnel {
  private child: TunnelChild | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reaped = false;
  private attempt = 0;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private errTail = "";
  private info: TunnelStatus = { state: "idle", restarts: 0, lastExit: null };

  constructor(private readonly o: TunnelOptions) {}

  status(): TunnelStatus {
    return { ...this.info };
  }

  /** Start supervising (idempotent). Resolves when the tunnel is up; rejects after `timeoutMs`, but keeps retrying in the background. */
  ensure(timeoutMs = 20_000): Promise<void> {
    if (this.closed) return Promise.reject(new Error("the tunnel is closed"));
    if (this.info.state === "up") return Promise.resolve();
    if (!this.child && !this.timer) this.launch();
    return new Promise<void>((resolve, reject) => {
      const w = {
        resolve: () => (clearTimeout(t), resolve()),
        reject: (e: Error) => (clearTimeout(t), reject(e)),
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`the SSH tunnel to the host did not come up${this.info.lastExit ? `: ${this.info.lastExit.stderr || `ssh exited ${this.info.lastExit.code}`}` : ""}`.slice(0, 300)));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  private reapStale() {
    const f = this.o.pidFile;
    if (!f) return;
    try {
      const pid = Number(readFileSync(f, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && (this.o.isOurTunnel ?? isOurTunnel)(pid, this.o.matchArgs ?? [])) {
        process.kill(pid);
        this.o.onLog?.(`stopped a leftover tunnel (pid ${pid}) from an earlier hub`);
      }
    } catch {
      /* no pid file, or the process is gone */
    }
    rmSync(f, { force: true });
  }

  private markUp(child: TunnelChild) {
    if (this.child !== child || this.closed || this.info.state === "up") return;
    if (this.settleTimer) clearTimeout(this.settleTimer), (this.settleTimer = null);
    this.info.state = "up";
    this.o.onLog?.("tunnel up");
    this.healthyTimer = setTimeout(() => (this.attempt = 0), this.o.healthyMs ?? 60_000);
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  private launch() {
    if (this.closed) return;
    if (!this.reaped) (this.reaped = true), this.reapStale();
    this.timer = null;
    this.info.state = "starting";
    this.errTail = "";
    let child: TunnelChild;
    try {
      child = (this.o.spawnFn ?? defaultSpawn)(this.o.command, this.o.args);
    } catch (e) {
      this.exited(null, (e as Error).message);
      return;
    }
    this.child = child;
    if (this.o.pidFile && child.pid) {
      try {
        mkdirSync(dirname(this.o.pidFile), { recursive: true });
        writeFileSync(this.o.pidFile, String(child.pid));
      } catch {
        /* best effort */
      }
    }
    child.stderr?.on("data", (d: Buffer | string) => {
      this.errTail = (this.errTail + String(d)).slice(-300);
    });
    child.on("error", (e: Error) => this.onGone(child, null, e.message));
    child.on("close", (code: number | null) => this.onGone(child, code, this.errTail));
    const marker = this.o.readyMarker;
    if (marker && child.stdout && child.stdin) {
      let seen = "";
      child.stdout.on("data", (d: Buffer | string) => {
        seen = (seen + String(d)).slice(-200);
        if (seen.includes(marker)) this.markUp(child);
      });
      child.stdin.on?.("error", () => undefined);
      try {
        child.stdin.write(`${marker}\n`);
      } catch {
        /* ssh already gone: the close handler restarts it */
      }
      // No echo within the window: this attempt is dead (a stuck connect, a host that accepted but ran nothing). Kill it so it backs off and retries.
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        if (this.child === child && this.info.state !== "up") {
          this.errTail ||= "no answer from the remote command";
          try {
            child.kill();
          } catch {
            /* gone */
          }
        }
      }, Math.max(this.o.settleMs ?? 20_000, 1));
    } else {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.markUp(child);
      }, this.o.settleMs ?? 2_000);
    }
  }

  private onGone(child: TunnelChild, code: number | null, stderr: string) {
    if (this.child !== child) return; // already handled (error then close)
    this.child = null;
    if (this.settleTimer) clearTimeout(this.settleTimer), (this.settleTimer = null);
    if (this.healthyTimer) clearTimeout(this.healthyTimer), (this.healthyTimer = null);
    this.exited(code, stderr);
  }

  private exited(code: number | null, stderr: string) {
    this.info.lastExit = { code, at: Date.now(), stderr: stderr.replace(/\s+/g, " ").trim().slice(0, 200) };
    if (this.closed) return;
    this.info.restarts++;
    this.info.state = "backoff";
    const steps = this.o.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = steps[Math.min(this.attempt++, steps.length - 1)];
    this.o.onLog?.(`tunnel down (${this.info.lastExit.stderr || `exit ${code}`}); retry in ${delay} ms`);
    this.timer = setTimeout(() => this.launch(), delay);
  }

  close() {
    this.closed = true;
    this.info.state = "closed";
    for (const t of [this.timer, this.settleTimer, this.healthyTimer]) if (t) clearTimeout(t);
    this.timer = this.settleTimer = this.healthyTimer = null;
    const c = this.child;
    this.child = null;
    if (this.o.pidFile) rmSync(this.o.pidFile, { force: true });
    try {
      c?.kill();
    } catch {
      /* already gone */
    }
    for (const w of this.waiters.splice(0)) w.reject(new Error("the tunnel was closed"));
  }
}

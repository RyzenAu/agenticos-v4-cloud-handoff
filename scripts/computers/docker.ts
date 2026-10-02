import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ScriptAdapter, validName, type HostRunner } from "./script-adapter";
import { defaultRunner } from "./wsl-local";
import type { AdapterHandle, ComputerSpec, ProbeResult, VncStream } from "./types";

/**
 * "docker": one container per computer, for a host that has Docker (the owner's spare laptop, or a VM). NOT RUN ANYWHERE: Docker is not
 * installed on this PC and is not to be, so every test drives a fake `docker` CLI and proves the commands this would issue.
 *
 * It is the same adapter shape as wsl-local and vps-ssh: a container is created once, and the SAME deploy/computers/linux/computer-ctl.sh
 * runs inside it (`docker exec -i <container> bash -s -- <action>`), so provisioning, pairing, probing, snapshots and recovery behave as
 * they do everywhere else. What Docker adds is isolation and limits:
 *
 *  - NO published ports, ever (there is no `-p`): the VNC server and DevTools bind 127.0.0.1 inside the container and the hub reaches VNC
 *    through `docker exec` byte pipe, exactly as it does through wsl.exe and ssh -W;
 *  - `--cap-drop ALL`, `no-new-privileges`, a pids limit, memory and CPU limits (they hold even if a browser misbehaves);
 *  - one named volume per computer for its whole home (working folder, browser profile, ledger, pairing): stop, start and recreate keep
 *    the files; only `destroy` removes it, because a founder asked;
 *  - the image must be pinned by digest (`name@sha256:...`): a moving tag is refused;
 *  - the companion reaches the hub through the bridge (scripts/computers/bridge.ts) on the docker host's gateway address, not the hub's
 *    loopback.
 */

export type DockerOptions = {
  /** `repo/name@sha256:<64 hex>`. A tag alone is refused. */
  image: string;
  /** Memory limit, e.g. "1g" (a desktop browser needs about 0.6 GB; see COMPUTERS-ARCHITECTURE). */
  memory?: string;
  cpus?: string;
  pids?: number;
  /** The address a container uses to reach the hub's bridge. */
  hubUrl?: () => Promise<string>;
};

const PINNED = /^[a-z0-9][a-z0-9._/-]{0,100}@sha256:[0-9a-f]{64}$/;
const LIMIT = /^\d+(\.\d+)?[kmg]?$/i;

export const containerName = (computer: string) => `mu-computer-${computer}`;
export const volumeName = (computer: string) => `mu-computer-${computer}-home`;

export class DockerAdapter extends ScriptAdapter {
  readonly kind = "docker";

  constructor(readonly opts: DockerOptions, private readonly docker: HostRunner = defaultRunner, script?: string, now?: () => number) {
    // Commands that run the script go through `docker exec`; the base class's runner is told which container via the argv built in shell().
    super((argv, o) => docker(argv, o), script, now);
    if (!PINNED.test(opts.image)) throw new Error("The image must be pinned by digest (name@sha256:<64 hex>); a moving tag is refused.");
    if (opts.memory && !LIMIT.test(opts.memory)) throw new Error("bad memory limit");
    if (opts.cpus && !LIMIT.test(opts.cpus)) throw new Error("bad cpu limit");
  }

  private current = "";
  protected shell(args: string[]): string[] {
    if (!validName(this.current)) throw new Error("no computer selected");
    return ["docker", "exec", "-i", containerName(this.current), "bash", "-s", "--", ...args];
  }
  protected bundlePathOnHost(localPath: string): string {
    return localPath; // copied into the container with `docker cp` by installBundle below
  }

  /** The docker CLI itself (not the script): argv[0] is always "docker". */
  private async cli(args: string[], timeoutMs = 60_000) {
    const r = await this.docker(["docker", ...args], { timeoutMs });
    if (r.code !== 0) throw new Error(`docker ${args[0]}: ${r.stderr.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    return r.stdout.trim();
  }

  /** Is Docker there at all? Read-only. */
  async check() {
    try {
      await this.cli(["version", "--format", "{{.Server.Version}}"], 15_000);
    } catch (error) {
      return { ok: false, host: "docker", present: [], missing: ["docker"], installCommand: null, notes: [`Docker isn't reachable: ${(error as Error).message}`] };
    }
    return { ok: true, host: "docker", present: ["docker", "node (in the image)", "chromium (in the image)"], missing: [], installCommand: null, notes: [`image ${this.opts.image.slice(0, 40)}...`] };
  }

  private runArgs(name: string): string[] {
    return [
      "run", "-d", "--name", containerName(name), "--hostname", name,
      "--restart", "unless-stopped",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", this.opts.memory ?? "1g", "--cpus", this.opts.cpus ?? "1.5", "--pids-limit", String(this.opts.pids ?? 512),
      "--shm-size", "512m", // Chromium needs /dev/shm
      "--mount", `type=volume,source=${volumeName(name)},target=/home/mu`,
      "--label", "com.mu.computer=1", "--label", `com.mu.computer.name=${name}`,
      this.opts.image, "sleep", "infinity",
    ];
  }

  async provision(spec: ComputerSpec): Promise<{ handle: AdapterHandle; desktop: boolean; browser: boolean }> {
    if (!validName(spec.name)) throw new Error("bad computer name");
    await this.cli(["volume", "create", "--label", "com.mu.computer=1", volumeName(spec.name)]);
    await this.cli(this.runArgs(spec.name), 120_000);
    this.current = spec.name;
    if (this.pendingBundle) {
      await this.cli(["cp", this.pendingBundle, `${containerName(spec.name)}:/tmp/companion.mjs`]);
      await this.ctlPlain("install-bundle", ["/tmp/companion.mjs"]);
    }
    // The script, the bundle and the pairing all happen inside the container, through the same entry points as everywhere else.
    const r = await super.provision(spec);
    return { ...r, browser: true };
  }

  private select(h: AdapterHandle) {
    const name = String(h.name ?? "");
    if (!validName(name)) throw new Error("bad computer name");
    this.current = name;
    return name;
  }

  async installBundle(localPath: string) {
    // The bundle is installed per container (each has its own home volume): done on provision's first start.
    this.pendingBundle = localPath;
  }
  private pendingBundle = "";

  async start(h: AdapterHandle) {
    const name = this.select(h);
    const state = await this.cli(["inspect", "--format", "{{.State.Running}}", containerName(name)]).catch(() => "false");
    if (state !== "true") await this.cli(["start", containerName(name)]);
    if (this.pendingBundle) {
      await this.cli(["cp", this.pendingBundle, `${containerName(name)}:/tmp/companion.mjs`]);
      await this.ctlPlain("install-bundle", ["/tmp/companion.mjs"]);
    }
    await super.start(h);
  }
  private async ctlPlain(action: string, args: string[]) {
    const r = await this.ctl(action, args);
    if (r.code !== 0 || !r.json?.ok) throw new Error(`${action}: ${String(r.json?.error ?? r.stderr).slice(0, 120)}`);
  }

  async stop(h: AdapterHandle) {
    const name = this.select(h);
    await super.stop(h).catch(() => undefined);
    await this.cli(["stop", "-t", "10", containerName(name)]);
  }
  async suspend(h: AdapterHandle) {
    await this.stop(h); // the volume keeps every file; the container stops using memory and CPU
  }
  async resume(h: AdapterHandle) {
    await this.start(h);
  }
  async recover(h: AdapterHandle) {
    const name = this.select(h);
    await this.cli(["restart", "-t", "5", containerName(name)]);
    await super.start(h);
  }
  async destroy(h: AdapterHandle) {
    const name = this.select(h);
    await this.cli(["rm", "-f", containerName(name)]).catch(() => undefined);
    await this.cli(["volume", "rm", "-f", volumeName(name)]); // the one place files are deleted, and only because a founder asked
  }

  async probe(h: AdapterHandle): Promise<ProbeResult> {
    const name = this.select(h);
    const base = await super.probe(h);
    // The container's own view of its memory, from docker (covers everything in it, not just the script's sessions).
    const stats = await this.docker(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", containerName(name)], { timeoutMs: 15_000 }).catch(() => null);
    const m = stats && stats.code === 0 ? /^([\d.]+)\s*(B|KiB|MiB|GiB)\s*\/.*\|([\d.]+)%/.exec(stats.stdout.trim()) : null;
    if (m && base.resource) {
      const mult = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2] as "B"] ?? 1;
      return { ...base, resource: { ...base.resource, rssMb: Math.round(Number(m[1]) * mult), cpuPct: Number(m[3]) } };
    }
    return base;
  }

  async openVnc(handle: AdapterHandle): Promise<VncStream | null> {
    const name = this.select(handle);
    const port = Number(handle.vncPort);
    if (!Number.isInteger(port) || port < 5901 || port > 6999) return null;
    if (!(await this.probe(handle)).vncAlive) return null;
    const child = spawn("docker", ["exec", "-i", containerName(name), "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3`], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    return { read: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, write: Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>, close: () => void child.kill() };
  }

  /** The address a container uses to reach the hub (the bridge on this docker host's gateway). */
  async hubUrl(): Promise<string> {
    if (!this.opts.hubUrl) throw new Error("the docker host's bridge address isn't configured");
    return this.opts.hubUrl();
  }
}

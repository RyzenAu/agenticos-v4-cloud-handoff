import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterHandle, ComputerSpec, HostCheck, ProbeResult, ProvisioningAdapter, Snapshot, VncStream } from "./types";

/**
 * The shared half of every adapter that runs deploy/computers/linux/computer-ctl.sh on a Linux host: WSL here, a Sydney VPS
 * over SSH later. A subclass only says HOW to run that script there (`exec`) and how to open a byte stream to a loopback port
 * (`tunnel`). Lifecycle, probing, snapshots and the package check are identical on both.
 *
 * Nothing here installs anything or asks for a password. The script takes its arguments from a fixed alphabet; anything
 * with spaces or secrets (the pairing code, the hub address, the label) goes through the environment header on stdin.
 */

export type ExecResult = { code: number; stdout: string; stderr: string };
/** Run a command on the host, feeding `stdin`. Injected so the tests never start a process. */
export type HostRunner = (argv: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }) => Promise<ExecResult>;

export const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "computers", "linux", "computer-ctl.sh");
/** The packages a computer's desktop needs, and the one command that installs them on Debian, Ubuntu or Kali. */
export const DESKTOP_PACKAGES = ["xvfb", "chromium", "x11vnc", "xdotool"] as const;
const BINARY_TO_PACKAGE: Record<string, string> = { Xvfb: "xvfb", chromium: "chromium", x11vnc: "x11vnc", xdotool: "xdotool", node: "nodejs" };
// Fonts: a bare Kali with only fonts-liberation has no sans-serif default and Chromium draws page text as empty boxes (found on the LAN host); the check reports it.
export const FONT_PACKAGES = ["fonts-liberation", "fonts-dejavu-core", "fonts-noto-core", "fonts-noto-color-emoji"] as const;
export const INSTALL_COMMAND = `sudo apt-get install -y --no-install-recommends ${DESKTOP_PACKAGES.join(" ")} ${FONT_PACKAGES.join(" ")}`;

const ARG = /^[A-Za-z0-9._:/=@+-]{0,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validName(name: string) {
  return NAME.test(name);
}

export const HOST_IDENTITY_REFUSAL = "This host's identity changed or is unknown — not connecting. Check the fingerprint before trusting it.";
/** ssh refused because it does not trust the host's key (unknown or CHANGED): not a timeout, and never to be squashed into one. */
export const isHostKeyFailure = (text: string) => /host key verification failed|remote host identification has changed|offending (?:ecdsa|rsa|ed25519|dsa) key|man-in-the-middle/i.test(text);

export abstract class ScriptAdapter implements ProvisioningAdapter {
  abstract readonly kind: string;
  protected readonly script: string;
  /** Which hub owns this adapter's computers in the host's allocator (letters, digits, dashes). The plugin sets it from the hub's data folder. */
  hubId = "hub";
  /** First display number this hub asks the allocator for (the allocator still skips anything taken on the host). */
  displayBase = Number(process.env.MU_COMPUTERS_DISPLAY_BASE) || 101;

  constructor(protected readonly run: HostRunner, script?: string, protected readonly now: () => number = Date.now) {
    // A checkout with CRLF conversion must not hand bash carriage returns.
    this.script = (script ?? readFileSync(SCRIPT_PATH, "utf8")).replace(/\r\n/g, "\n");
  }

  /** The command line that runs `bash -s -- <args>` on this host. */
  protected abstract shell(args: string[]): string[];
  /** Extra environment every script action runs with (names only, never secrets): a host's computers folder, the per-computer user prefix. */
  protected hostEnv(): Record<string, string> {
    return {};
  }
  /** Where the companion bundle can be read from on the host (a path the host itself understands). */
  protected abstract bundlePathOnHost(localPath: string): string;
  abstract openVnc(handle: AdapterHandle): Promise<VncStream | null>;

  /** One script action. `env` (strings only) is exported at the top of the script, never put on a command line. */
  protected async ctl(action: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000) {
    for (const a of [action, ...args]) if (!ARG.test(a)) throw new Error(`refused an argument the script doesn't accept: ${JSON.stringify(a).slice(0, 40)}`);
    const header = Object.entries({ MU_HUB_ID: this.hubId, ...this.hostEnv(), ...env })
      .map(([k, v]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error("bad environment name");
        return `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`;
      })
      .join("\n");
    const r = await this.run(this.shell([action, ...args]), { stdin: `${header}\n${this.script}`, timeoutMs });
    let json: any = null;
    const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    try {
      json = JSON.parse(line);
    } catch {
      /* not JSON (a host error): reported below */
    }
    return { ...r, json };
  }

  private must(r: { code: number; stderr: string; json: any }, what: string) {
    if (r.code !== 0 || !r.json?.ok) throw new Error(`${what}: ${String(r.json?.error ?? r.stderr ?? "failed").replace(/\s+/g, " ").slice(0, 200)}`);
  }

  /** This hub's bridge port from the host allocator (stable per hub; never another hub's). `avoid` lists ports the caller found busy on its own side. */
  async allocBridgePort(avoid: number[] = []): Promise<number> {
    const r = await this.ctl("alloc-bridge", [], avoid.length ? { MU_AVOID_PORTS: avoid.join(",") } : {}, 30_000);
    this.must(r, "couldn't allocate a bridge port");
    return Number(r.json.port);
  }

  async check(): Promise<HostCheck> {
    try {
      const r = await this.ctl("check", [], {}, 30_000);
      // No answer is not "packages missing": the host was never asked, so nothing is claimed about what it has.
      if (!r.json?.ok && isHostKeyFailure(r.stderr)) return { ok: false, host: this.kind, present: [], missing: [], installCommand: null, notes: [HOST_IDENTITY_REFUSAL] };
      if (!r.json?.ok) return { ok: false, host: this.kind, present: [], missing: [], installCommand: null, notes: [`the host did not answer: ${r.stderr.replace(/\s+/g, " ").trim().slice(0, 160)}`] };
      const present: string[] = r.json.present ?? [];
      const missing: string[] = r.json.missing ?? [];
      const fontsMissing = missing.includes("fonts");
      const need = missing.filter((m) => m !== "node" && m !== "fonts").map((m) => BINARY_TO_PACKAGE[m] ?? m);
      return {
        ok: !missing.includes("node"),
        host: String(r.json.host ?? this.kind),
        present,
        missing,
        installCommand: need.length || fontsMissing ? INSTALL_COMMAND : null,
        notes: [
          ...(missing.includes("node") ? ["node is missing: the companion cannot run here"] : []),
          ...(need.length ? [`without ${need.join(", ")} this computer runs headless: files and commands, no browser or desktop`] : []),
          ...(fontsMissing ? ["this host has no usable fonts (no sans-serif family, or fontconfig is missing so it cannot be checked): page text would draw as empty boxes; install the fonts in the install command"] : []),
          ...(r.json.runAsIgnored === true ? ["a per-computer user prefix is set but the script is not running as root, so it is ignored and every computer runs as the control user"] : []),
          ...(r.json.uid === 0 && r.json.runAs !== true && !missing.includes("chromium") ? ["the script runs as root without a per-computer user: Chromium will not start with its sandbox on (use an unprivileged WSL user or MU_COMPUTERS_SSH_RUN_AS_PREFIX)"] : []),
        ],
      };
    } catch (error) {
      if (isHostKeyFailure((error as Error).message)) return { ok: false, host: this.kind, present: [], missing: [], installCommand: null, notes: [HOST_IDENTITY_REFUSAL] };
      return { ok: false, host: this.kind, present: [], missing: [...DESKTOP_PACKAGES], installCommand: INSTALL_COMMAND, notes: [`the host is unreachable: ${(error as Error).message.slice(0, 120)}`] };
    }
  }

  /** A headless Chromium for this host, installed without root into the host's computers folder (Playwright's chromium-headless-shell, about 270 MB). Only when asked. */
  async installBrowser() {
    this.must(await this.ctl("install-browser", [], {}, 540_000), "couldn't install a browser");
  }

  /** Copy the companion bundle onto the host (once per build; every computer runs that one file). */
  async installBundle(localPath: string) {
    this.must(await this.ctl("install-bundle", [this.bundlePathOnHost(localPath)]), "couldn't install the companion");
  }

  async provision(spec: ComputerSpec): Promise<{ handle: AdapterHandle; desktop: boolean; browser: boolean }> {
    if (!validName(spec.name)) throw new Error("bad computer name");
    for (const a of [spec.name, spec.resolution]) if (!ARG.test(a)) throw new Error(`refused an argument the script doesn't accept: ${JSON.stringify(a).slice(0, 40)}`); // before anything is allocated
    const host = await this.check();
    // The host's allocator hands out the display and ports (unique across every hub on this host); spec.display is only the hub's own suggestion.
    const got = await this.ctl("alloc", [spec.name], { MU_DISPLAY_BASE: String(this.displayBase || spec.display) }, 30_000);
    this.must(got, "couldn't allocate a display");
    const display = Number(got.json.display);
    const vncPort = Number(got.json.vncPort);
    const cdpPort = Number(got.json.cdpPort);
    const r = await this.ctl(
      "provision",
      [spec.name, String(display), spec.resolution, String(vncPort), String(cdpPort)],
      { MU_HUB_URL: spec.hubUrl, MU_PAIR_CODE: spec.pairingCode, MU_LABEL: spec.label },
      90_000,
    );
    this.must(r, "couldn't provision");
    const desktop = host.missing.every((m) => m !== "Xvfb" && m !== "chromium");
    const handle: AdapterHandle = { name: spec.name, display, vncPort, cdpPort, resolution: spec.resolution };
    await this.start(handle);
    return { handle, desktop, browser: host.present.some((p) => p.startsWith("chromium")) };
  }

  private nameOf(h: AdapterHandle) {
    const name = String(h.name ?? "");
    if (!validName(name)) throw new Error("bad computer name");
    return name;
  }

  async start(h: AdapterHandle) {
    this.must(await this.ctl("start", [this.nameOf(h)]), "couldn't start");
  }
  async stop(h: AdapterHandle) {
    this.must(await this.ctl("stop", [this.nameOf(h)], {}, 45_000), "couldn't stop");
  }
  async suspend(h: AdapterHandle) {
    // Sleep = stop the processes, keep the disk (profile, working folder, ledger, pairing). Nothing is snapshotted here: a VPS
    // adapter may power the VM off instead (deploy/computers/README.md).
    await this.stop(h);
  }
  async resume(h: AdapterHandle) {
    await this.start(h);
  }
  async recover(h: AdapterHandle) {
    // Stop first so a half-dead set of processes is cleared, then start: the same pairing, profile and command ledger.
    await this.ctl("stop", [this.nameOf(h)], {}, 45_000).catch(() => undefined);
    await this.start(h);
  }
  async destroy(h: AdapterHandle) {
    this.must(await this.ctl("destroy", [this.nameOf(h)], {}, 45_000), "couldn't remove");
  }

  async probe(h: AdapterHandle): Promise<ProbeResult> {
    const at = this.now();
    try {
      const r = await this.ctl("probe", [this.nameOf(h)], {}, 20_000);
      if (r.code !== 0 || !r.json?.ok) return { hostUp: false, companionAlive: false, displayAlive: null, vncAlive: null, browserAlive: null, resource: null, at, error: String(r.stderr || r.json?.error || "no answer").slice(0, 120) };
      const j = r.json;
      return {
        hostUp: true,
        companionAlive: j.companion === true,
        displayAlive: typeof j.xvfb === "boolean" ? j.xvfb : null,
        vncAlive: typeof j.vnc === "boolean" ? j.vnc : null,
        browserAlive: j.browser === true,
        resource: { rssMb: Math.round((Number(j.rssKb) || 0) / 1024), cpuPct: typeof j.cpu === "number" ? j.cpu : null, procs: Number(j.procs) || 0, sampledAt: at },
        at,
      };
    } catch (error) {
      return { hostUp: false, companionAlive: false, displayAlive: null, vncAlive: null, browserAlive: null, resource: null, at, error: (error as Error).message.slice(0, 120) };
    }
  }

  /** One frame of the computer's browser, in memory only (the companion captures it over the browser's own debugging port and prints it as base64). */
  async snapshot(h: AdapterHandle): Promise<Snapshot | null> {
    const r = await this.ctl("shot", [this.nameOf(h)], {}, 30_000);
    const text = r.stdout.trim();
    if (r.code !== 0 || !text || text.startsWith("{")) return null;
    const data = Uint8Array.from(Buffer.from(text, "base64"));
    if (!data.length) return null;
    const png = data[0] === 0x89;
    // A frame cut short in transit (found on the LAN host: 64 KiB of base64) is no frame: better none than a half-drawn screen.
    const complete = png ? Buffer.from(data.subarray(-8)).toString("hex") === "49454e44ae426082" || Buffer.from(data.subarray(-12)).toString("hex").endsWith("49454e44ae426082") : data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
    return complete ? { mime: png ? "image/png" : "image/jpeg", data } : null;
  }
}

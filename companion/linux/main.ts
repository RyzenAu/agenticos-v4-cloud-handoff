#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CommandLedger } from "../ledger";
import { COMPANION_VERSION, CompanionWorker } from "../worker";
import { CdpSession, browserUp, clearStaleHold, displayReady, findChromium, keepBrowserOpen, screenshot, tabs, type CdpConfig } from "./cdp";
import { createLinuxExecutors, liveBrowserBackend } from "./executors-linux";
import { checkComputerHubUrl, readComputerConfig, writeComputerConfig, type ComputerConfig } from "./config";

/**
 * The companion of a shared cloud computer (Linux). The same CompanionWorker a PC runs, with Linux executors and a config that
 * says which computer this is. Built to one file for node (`bun build companion/linux/main.ts --target=node`, see
 * deploy/computers/build-companion.ts) and started by deploy/computers/linux/computer-ctl.sh.
 *
 *   companion.mjs pair --hub <url> --code <code> --name <computer> --config <dir> [--label ..] [--display N] [--resolution WxHxD]
 *                      [--vnc-port N] [--browser-port N] [--workdir <dir>] [--profile <dir>]
 *   companion.mjs run --config <dir>
 *   companion.mjs status --config <dir>
 *   companion.mjs shot --config <dir>          (one JPEG frame of the browser on stdout as base64)
 *
 * The hub address must be the same host (loopback), a tailnet address, or a private address of the bridge the host provides: a
 * computer never sends its token to the public internet. The token is written to <dir>/computer.json (mode 0600), never printed.
 */

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    else if (!cmd) cmd = a;
  }
  return { cmd, flags };
}

const fail = (message: string): undefined => {
  console.error(message);
  process.exitCode = 1;
  return undefined;
};

const cdpOf = (c: ComputerConfig): CdpConfig => ({
  port: c.browserPort,
  profileDir: c.profileDir,
  ...(process.env.DISPLAY && displayReady(c.display) ? { display: `:${c.display}` } : {}),
  windowSize: c.resolution.split("x").slice(0, 2).join(","),
  ...(process.env.MU_COMPUTER_NO_SANDBOX === "1" ? { noSandbox: true } : {}),
});

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2));
  const dir = flags.config;
  if (!dir) return fail("Give --config <folder>.");
  if (cmd === "pair") {
    const hub = checkComputerHubUrl(flags.hub ?? "");
    if (!hub.ok) return fail(hub.reason);
    const name = flags.name ?? "";
    const display = String(Number(flags.display) || 0);
    const code = flags.code ?? process.env.MU_PAIR_CODE ?? ""; // the host script passes it in the environment: a command line is readable by every user on the host
    if (!name || !code || display === "0") return fail("Give --name, --code and --display.");
    const res = await fetch(`${hub.url}/__devices/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: flags.label ?? name }),
    }).catch((e) => fail(`Couldn't reach the hub at ${hub.url} (${e?.message ?? e}).`));
    if (!res) return;
    const json: any = await res.json().catch(() => ({}));
    if (res.status !== 200 || json.owner !== "shared") return fail(json?.error ?? `Pairing refused (HTTP ${res.status}).`);
    const workdir = flags.workdir ?? join(dir, "..", "work");
    const profileDir = flags.profile ?? join(dir, "..", "profile");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeComputerConfig(dir, {
      name, hubUrl: hub.url, deviceId: json.deviceId, token: json.token, expiresAt: json.expiresAt, pairedAt: Date.now(), label: json.label,
      display, resolution: flags.resolution ?? "1280x800x24", vncPort: Number(flags["vnc-port"]) || 5900 + Number(display), workdir, profileDir, browserPort: Number(flags["browser-port"]) || 9300 + Number(display),
    });
    console.log(`Paired computer "${name}" (${json.deviceId}) as shared.`);
    return;
  }
  const config = readComputerConfig(dir);
  if (!config) return fail("This computer isn't paired.");
  if (cmd === "status") {
    console.log(`Computer "${config.name}" (${config.deviceId}) → ${config.hubUrl}; worker ${COMPANION_VERSION}; browser ${findChromium() ? "installed" : "not installed"}.`);
    return;
  }
  if (cmd === "shot") {
    if (!(await browserUp(config.browserPort))) return void process.exit(3);
    const list = await tabs(config.browserPort).catch(() => []);
    const tab = list[0]; // the most recently used tab (the initial about:blank is listed last)
    if (!tab?.webSocketDebuggerUrl) return void process.exit(3);
    const s = await CdpSession.connect(tab.webSocketDebuggerUrl);
    // Wait for the write to finish: through ssh stdout is a socket, and exiting right after a large write cut the frame at 64 KiB of base64 (a half-drawn screenshot on the LAN host).
    const frame = Buffer.from(await screenshot(s)).toString("base64");
    await new Promise<void>((done) => process.stdout.write(frame, () => done()));
    s.close();
    process.exit(0);
  }
  if (cmd === "run") {
    if (config.expiresAt <= Date.now()) return fail("This computer's pairing has expired. Destroy and provision it again.");
    const hub = checkComputerHubUrl(config.hubUrl);
    if (!hub.ok) return fail(hub.reason);
    const cdp = cdpOf(config);
    const backend = liveBrowserBackend(cdp, (l) => console.log(`[browser] ${l}`));
    const executors = createLinuxExecutors({ name: config.name, workdir: config.workdir, display: cdp.display, resolution: config.resolution, browser: backend });
    // A step in flight pauses the browser watchdog (see keepBrowserOpen below).
    let inflight = 0;
    for (const key of Object.keys(executors)) {
      const run = executors[key];
      executors[key] = async (args, ctx) => {
        inflight++;
        try {
          return await run(args, ctx);
        } finally {
          inflight--;
        }
      };
    }
    const worker = new CompanionWorker({
      hubUrl: hub.url,
      token: config.token,
      deviceId: config.deviceId,
      owner: "shared",
      executors,
      ledger: new CommandLedger(join(dir, "command-ledger.json")),
      version: `${COMPANION_VERSION}-linux`,
      micAutoClaim: false,
      // A computer has no lock screen. "true" when a browser can run here (a display, or headless), else "can't tell".
      interactive: async () => (findChromium() ? true : null),
      onState: (state) => {
        if (state === "unpaired") {
          console.error("This computer's pairing was revoked or has expired. Stopped.");
          void worker.stop().finally(() => process.exit(3));
        }
      },
    }).start();
    // A computer with a display has its browser open from the start, and back if it dies: an idle desktop with no window is a black screen on the viewer
    // ("online, but blank"). about:blank is a white page, which is a working screen. Headless computers keep opening it on first use.
    // It leaves the browser alone while a job step is running (the step may be mid-navigation) and while a person holds the computer (the hub puts a "hold" marker in the
    // computer's config folder; a browser the person closed stays closed until they let go).
    const holdFile = join(dir, "hold");
    clearStaleHold(dir);
    const stopKeeping = cdp.display && findChromium() && backend.ensure
      ? keepBrowserOpen({ ensure: () => backend.ensure!(), alive: () => browserUp(cdp.port, 3_000), paused: () => inflight > 0 || existsSync(holdFile), log: (l) => console.log(`[browser] ${l}`) })
      : undefined;
    const shutdown = async () => {
      stopKeeping?.();
      await worker.stop();
      await backend.close?.();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`Computer "${config.name}" starting (${cdp.display ? `display ${cdp.display}` : "headless"}; ${Object.keys(executors).length} executors).`);
    return;
  }
  console.log("Usage: companion.mjs pair|run|status|shot --config <dir> ...");
}

void main();

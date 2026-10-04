#!/usr/bin/env bun
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { checkHubUrl, checkRoot, configDir, configFile, defaultRoots, ledgerFile, micLockFile, readConfig, rootsOf, writeConfig } from "./config";
import { CommandLedger } from "./ledger";
import { defaultExecutors, runCleanups } from "./executors";
import { MicLock } from "./mic-lock";
import { COMPANION_VERSION, CompanionWorker } from "./worker";

/**
 * M&U companion — lets Jarvis act on YOUR PC when you ask it to, and on no one else's.
 *
 *   mu-companion pair --hub https://<os>.ts.net:8443 --code ABCD-EFGH [--label "Mehroz's PC"] [--alias pc --alias desktop] [--root <folder>]...
 *   mu-companion run
 *   mu-companion status
 *   mu-companion forget
 *
 * Connects out over Tailscale only; opens no ports on this PC. "open the file X" only looks inside the
 * authorised folders (default Documents\MU-Jarvis; --root at pair time, or "roots" in companion.json).
 */

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      (out[key] ??= []).push(value);
    } else if (!cmd) cmd = a;
  }
  return { cmd, flags: out, one: (k: string) => out[k]?.[0] };
}

async function main() {
  const { cmd, flags, one } = args(process.argv.slice(2));
  const dir = configDir(one("config"));
  if (cmd === "pair") {
    const hub = checkHubUrl(one("hub") ?? "");
    if (!hub.ok) return fail(hub.reason);
    const roots: string[] = [];
    for (const r of flags.root ?? []) {
      const checked = checkRoot(r);
      if (!checked.ok) return fail(checked.reason);
      roots.push(checked.path);
    }
    const code = one("code");
    if (!code) return fail("Add --code with the pairing code shown in the OS (Profile → Pair a companion).");
    const res = await fetch(`${hub.url}/__devices/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: one("label") ?? "", aliases: flags.alias ?? [] }),
    }).catch((e) => fail(`Couldn't reach the OS at ${hub.url} (${e?.message ?? e}). Is Tailscale connected?`));
    if (!res) return;
    const json: any = await res.json().catch(() => ({}));
    if (res.status !== 200) return fail(json?.error ?? `Pairing refused (HTTP ${res.status}).`);
    writeConfig(dir, { hubUrl: hub.url, deviceId: json.deviceId, owner: json.owner, label: json.label, token: json.token, expiresAt: json.expiresAt, pairedAt: Date.now(), ...(roots.length ? { roots } : {}) });
    const useRoots = roots.length ? roots : defaultRoots();
    for (const r of useRoots) mkdirSync(r, { recursive: true });
    console.log(`Paired "${json.label}" (${json.deviceId}) for ${json.owner}. Valid until ${new Date(json.expiresAt).toLocaleString()}.`);
    console.log(`Files Jarvis may open on this PC: ${useRoots.join("; ")}`);
    console.log(`Next: mu-companion run`);
    return;
  }
  if (cmd === "status") {
    const c = readConfig(dir);
    if (!c) return console.log(`Not paired. Config folder: ${dir}`);
    const days = Math.ceil((c.expiresAt - Date.now()) / 86_400_000);
    console.log(`Paired "${c.label}" (${c.deviceId}) for ${c.owner} → ${c.hubUrl}. ${days >= 0 ? `${days} days left` : "EXPIRED — pair again"}.`);
    console.log(`Files Jarvis may open: ${rootsOf(c).join("; ")}`);
    console.log(`Worker version ${COMPANION_VERSION}.`);
    const holder = new MicLock(micLockFile(dir)).holder();
    console.log(holder ? `Microphone held by pid ${holder}${holder === process.pid ? "" : " (the running companion or another Jarvis voice process)"}.` : "Microphone free.");
    return;
  }
  if (cmd === "forget") {
    const file = configFile(dir);
    if (existsSync(file)) unlinkSync(file);
    console.log("Forgot this PC's pairing. Also revoke it in the OS: Profile → Paired devices.");
    return;
  }
  if (cmd === "run") {
    const c = readConfig(dir);
    if (!c) return fail(`Not paired yet. Run: mu-companion pair --hub <OS Tailscale address> --code <code>`);
    if (c.expiresAt <= Date.now()) return fail("This pairing has expired (30 days). Make a new code in the OS and pair again.");
    const hub = checkHubUrl(c.hubUrl);
    if (!hub.ok) return fail(hub.reason);
    const roots = rootsOf(c);
    for (const r of roots) mkdirSync(r, { recursive: true });
    const worker = new CompanionWorker({
      hubUrl: hub.url,
      token: c.token,
      deviceId: c.deviceId,
      owner: c.owner,
      micLock: new MicLock(micLockFile(dir)),
      executors: defaultExecutors({ roots, browser: { ...(c.browser ?? {}), session: c.browser?.session ?? `companion-${c.deviceId}` } }),
      ledger: new CommandLedger(ledgerFile(dir)),
      onState: (state) => {
        // A revoked or expired pairing stops for good: nothing more runs until he pairs again.
        if (state === "unpaired") {
          console.error("This PC's pairing was revoked or has expired. Stopped. Make a new code in the OS and pair again.");
          void worker.stop().finally(() => process.exit(3));
        }
      },
    }).start();
    const shutdown = async () => {
      await worker.stop();
      await runCleanups();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`Companion for ${c.owner} starting. Files it may open: ${roots.join("; ")}. Press Ctrl+C to stop.`);
    return;
  }
  console.log("Usage: mu-companion pair --hub <url> --code <code> [--label <name>] [--alias <word>] [--root <folder>] | run | status | forget");
}

function fail(message: string): undefined {
  console.error(message);
  process.exitCode = 1;
  return undefined;
}

void main();

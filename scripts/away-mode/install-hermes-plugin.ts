#!/usr/bin/env bun
// Installs the away-mode relay into the Hermes gateway:
//   %LOCALAPPDATA%\hermes\plugins\away-mode\{plugin.yaml,__init__.py,relay.json}
// relay.json names the OS's loopback relay URL and the token FILE (the token itself is never
// copied). Then: `hermes plugins enable away-mode` (already enabled on this PC) and a gateway restart.
//
// WHICH plugin (Track 6, REVIEW-T6 R2): the INSTALLED variant, scripts/away-mode/hermes-plugin-installed/:
// the plugin that was installed before (f334ab7) plus the relay pattern for 8-character approval codes
// ("approve K7PQ-M4XZ"), plus S2d's narrow free-text money-ORDER relay (lead decision 29 Sep): only free text
// with money words is put to the OS, whose shared classifier refuses ORDERS; questions, reminders and all other
// text go to Hermes as before (docs/AWAY-MODE-MONEY.md). Not installed until the owner says so. S2's broader
// pre-check (scripts/away-mode/hermes-plugin/) stays in the repo with its tests.
//
// Before copying, the folder that is installed now is copied aside to
// .operator-data/away-mode/plugin-backups/<timestamp>/ (git-ignored); roll back with --restore <that folder>.
//
//   bun scripts/away-mode/install-hermes-plugin.ts [--port 8081]
//   bun scripts/away-mode/install-hermes-plugin.ts --restore <backup folder>
//   bun scripts/away-mode/install-hermes-plugin.ts --verify   (what the installed plugin can do; changes nothing)
// Run it from a normal shell (or via WMI from a Claude session: new folders under %LOCALAPPDATA%
// made inside the desktop app's sandbox are redirected and Hermes wouldn't see them).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { relayToken, relayTokenFile } from "./service";
import { readPeople } from "../remote-access";

const here = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SOURCE = join(here, "hermes-plugin-installed");
const FILES = ["plugin.yaml", "__init__.py", "relay.json"] as const;

export function pluginTarget(env: Record<string, string | undefined> = process.env) {
  const hermesHome = env.HERMES_HOME || join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes");
  return join(hermesHome, "plugins", "away-mode");
}

/** Copy what is installed now (if anything) aside; returns the backup folder, or null if nothing was installed. */
export function backupInstalled(root: string, target: string, stamp = new Date().toISOString().replace(/[:.]/g, "-")): string | null {
  if (!FILES.some((f) => existsSync(join(target, f)))) return null;
  const dir = join(root, ".operator-data", "away-mode", "plugin-backups", stamp);
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) if (existsSync(join(target, f))) copyFileSync(join(target, f), join(dir, f));
  return dir;
}

export function installPlugin(opts: { root: string; target: string; port: number; source?: string; stamp?: string }) {
  const source = opts.source ?? PLUGIN_SOURCE;
  const backup = backupInstalled(opts.root, opts.target, opts.stamp);
  relayToken(opts.root); // made once, kept in .operator-data (git-ignored)
  mkdirSync(opts.target, { recursive: true });
  for (const f of ["plugin.yaml", "__init__.py"]) copyFileSync(join(source, f), join(opts.target, f));
  // The first names of the people in his chats (.operator-data/people.json): a line addressed to one of them
  // ("Mehroz, can you buy milk?") isn't an order to Jarvis. Names only; nothing else from people.json.
  const people = readPeople(opts.root).map((p) => String(p.name ?? "").trim().split(/\s+/)[0]).filter(Boolean);
  writeFileSync(join(opts.target, "relay.json"), JSON.stringify({ url: `http://127.0.0.1:${opts.port}/__away/telegram`, tokenFile: relayTokenFile(opts.root), people }, null, 2));
  const ok = FILES.every((f) => existsSync(join(opts.target, f)));
  const same = readFileSync(join(opts.target, "__init__.py"), "utf8") === readFileSync(join(source, "__init__.py"), "utf8");
  // The verify step (S2e): what was just installed must relay approval codes (XXXX-XXXX) as the repo's does.
  const check = verifyInstalled(opts.target, source);
  const codes = !verifyInstalled(source, source).approvalCodes || check.approvalCodes;
  return { ok: ok && same && codes, backup, check };
}

/**
 * What the plugin installed in Hermes can do, read from its file (S2e): the 8-character approval-code relay
 * (XXXX-XXXX, docs/APPROVAL-CODES.md), the free-text money-ORDER relay, the pre_tool_call tool guard, and whether
 * it is byte-identical to this repo's installed variant. The live plugin of 25 Sep has none of the three.
 */
export function verifyInstalled(target: string, source = PLUGIN_SOURCE) {
  const file = join(target, "__init__.py");
  if (!existsSync(file)) return { installed: false, approvalCodes: false, moneyOrderRelay: false, toolGuard: false, matchesRepo: false };
  const text = readFileSync(file, "utf8");
  return {
    installed: true,
    approvalCodes: /\[A-Za-z0-9\]\{4\}\[-\\s\]\[A-Za-z0-9\]\{4\}/.test(text) || text.includes("XXXX-XXXX"),
    moneyOrderRelay: text.includes("_money_order_check"),
    toolGuard: /register_hook\(\s*["']pre_tool_call["']/.test(text),
    matchesRepo: existsSync(join(source, "__init__.py")) && text === readFileSync(join(source, "__init__.py"), "utf8"),
  };
}

export function restorePlugin(backup: string, target: string) {
  if (!existsSync(join(backup, "__init__.py"))) throw new Error(`Not a plugin backup: ${backup}`);
  mkdirSync(target, { recursive: true });
  for (const f of FILES) if (existsSync(join(backup, f))) copyFileSync(join(backup, f), join(target, f));
  return FILES.every((f) => !existsSync(join(backup, f)) || readFileSync(join(backup, f), "utf8") === readFileSync(join(target, f), "utf8"));
}

if (import.meta.main) {
  const root = join(here, "..", "..");
  const target = pluginTarget();
  const r = process.argv.indexOf("--restore");
  if (process.argv.includes("--verify")) {
    const v = verifyInstalled(target);
    console.log(`Installed plugin in ${target}: ${v.installed ? "present" : "NOT installed"}`);
    if (v.installed) {
      console.log(`  approval codes (XXXX-XXXX) relayed: ${v.approvalCodes ? "yes" : "NO (codes typed in Telegram go to Hermes, not the OS)"}`);
      console.log(`  free-text money-order relay: ${v.moneyOrderRelay ? "yes" : "no"}`);
      console.log(`  tool guard (pre_tool_call): ${v.toolGuard ? "yes" : "no (Hermes' browser and computer_use have no money gate)"}`);
      console.log(`  same as this repo's installed variant: ${v.matchesRepo ? "yes" : "no"}`);
    }
  } else if (r > 0) {
    const ok = restorePlugin(process.argv[r + 1] ?? "", target);
    console.log(`${ok ? "Restored" : "FAILED to restore"} the away-mode plugin in ${target} from ${process.argv[r + 1]}`);
    console.log("Next: restart the gateway (hermes gateway restart).");
  } else {
    const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8081;
    const res = installPlugin({ root, target, port });
    console.log(`${res.ok ? "Installed" : "FAILED to install"} the away-mode plugin (approval codes, money ORDERS in free text refused by the OS, and the pre_tool_call tool guard) in ${target}`);
    console.log(`Verify: approval codes ${res.check.approvalCodes ? "yes" : "NO"}, money-order relay ${res.check.moneyOrderRelay ? "yes" : "no"}, tool guard ${res.check.toolGuard ? "yes" : "no"}.`);
    console.log(res.backup ? `The previous plugin was copied to ${res.backup} (roll back: --restore "${res.backup}")` : "Nothing was installed before.");
    console.log("Next: hermes plugins enable away-mode (if it isn't), then restart the gateway (hermes gateway restart).");
  }
}

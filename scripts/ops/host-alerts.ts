#!/usr/bin/env bun
// Host alerts for the always-on Windows hub (R9 ops). Run by deploy/windows/mu-health-check.ps1 every 5 minutes, right after it writes
// <data dir>/ops/host-health.json:
//
//   bun --no-env-file scripts/ops/host-alerts.ts evaluate [--data-dir D] [--host NAME] [--no-send]
//        reads the facts, updates <data dir>/ops/host-alerts.json (dedupe: one alert per condition, a reminder every 6 h, one "resolved"),
//        sends ONE Telegram DM per run with that run's events to the OWNER ONLY (people.json's owner, through `hermes send`, the same
//        path away mode uses: this code never reads a token), and prints the events as JSON for the Event Log.
//   bun --no-env-file scripts/ops/host-alerts.ts telegram on|off|show [--data-dir D]
//        the switch (<data dir>/ops/alert-settings.json). MU_OPS_ALERTS_TELEGRAM=off also turns it off.
//
// It never adds a recipient: the only target is ownerTelegram(root). With --no-send, or the switch off, nothing is sent.
import { hermesNotifier, ownerTelegram, type Notifier } from "../away-mode/notify";
import { dataDirFor } from "../cloud/data-dir";
import {
  alertSettingsFile,
  alertStateFile,
  emptyAlertState,
  evaluate,
  healthFile,
  messageFor,
  readAlertSettings,
  readHealth,
  readJson,
  writeJsonAtomic,
  type AlertEvent,
  type AlertState,
} from "./host-health";

export type EvaluationResult = {
  ok: boolean;
  reason?: string;
  events: AlertEvent[];
  active: string[];
  telegram: "sent" | "off" | "not-sent" | "nothing-to-send" | "failed";
  telegramDetail?: string;
};

export async function runEvaluation(opts: {
  dataDir: string;
  /** Repo root for ownerTelegram() (people.json is found through dataDirFor(root), so MU_DATA_DIR must name dataDir). */
  root?: string;
  now?: Date;
  host?: string;
  send: boolean;
  notifier?: Notifier;
  env?: Record<string, string | undefined>;
}): Promise<EvaluationResult> {
  const health = readHealth(healthFile(opts.dataDir));
  if (!health) return { ok: false, reason: "host-health.json is missing or unreadable", events: [], active: [], telegram: "not-sent" };
  const prev = readJson<AlertState>(alertStateFile(opts.dataDir)) ?? emptyAlertState();
  const { state, events } = evaluate(health, prev, opts.now ?? new Date());
  // Save before sending: a slow or failed send must never cause a second alert for the same condition on the next run.
  writeJsonAtomic(alertStateFile(opts.dataDir), state);
  const active = Object.entries(state.conditions).filter(([, c]) => c.alertedAt).map(([id]) => id);
  if (!events.length) return { ok: true, events, active, telegram: "nothing-to-send" };
  if (!opts.send) return { ok: true, events, active, telegram: "not-sent" };
  if (!readAlertSettings(opts.dataDir, opts.env).telegram) return { ok: true, events, active, telegram: "off" };
  const notifier = opts.notifier ?? hermesNotifier(() => ownerTelegram(opts.root ?? process.cwd()));
  const r = await notifier({ text: messageFor(events, opts.host ?? health.host ?? "hub") });
  return { ok: true, events, active, telegram: r.ok ? "sent" : "failed", telegramDetail: r.detail };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const root = process.cwd();
  const dataDir = opt("data-dir") ?? dataDirFor(root);
  const cmd = argv[0];
  if (cmd === "evaluate") {
    // ownerTelegram() reads people.json from the data dir through dataDirFor(root): make it the same folder.
    process.env.MU_DATA_DIR = dataDir;
    const result = await runEvaluation({ dataDir, root, host: opt("host"), send: !argv.includes("--no-send") });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } else if (cmd === "telegram") {
    const v = argv[1];
    if (v === "on" || v === "off") writeJsonAtomic(alertSettingsFile(dataDir), { telegram: v === "on" });
    else if (v !== "show") {
      console.error("usage: host-alerts.ts telegram on|off|show [--data-dir D]");
      process.exit(2);
    }
    console.log(`host alerts to the owner's Telegram: ${readAlertSettings(dataDir).telegram ? "on" : "off"}`);
  } else {
    console.error("usage: host-alerts.ts evaluate [--data-dir D] [--host NAME] [--no-send] | telegram on|off|show [--data-dir D]");
    process.exit(2);
  }
}

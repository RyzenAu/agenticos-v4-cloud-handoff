#!/usr/bin/env bun
// Health watch for a cloud hub: one run = one check, then (only on a CHANGE of state) one alert. Free: no new service.
//
//   bun scripts/cloud/health-watch.ts [--hub http://127.0.0.1:8081] [--backups /var/backups/mu-hub/production]
//        [--state /var/lib/mu-hub/production-home/health-watch.json] [--data-dir D] [--max-backup-hours 26] [--min-free-gb 5]
//        [--instance production] [--dry-run]
//
// What it checks (each is "ok" or a one-line problem):
//   * GET <hub>/__health answers 200 and status is ok or degraded (degraded is reported, not a page);
//   * the newest backup folder in --backups is younger than --max-backup-hours and has a manifest;
//   * free disk on the data directory's volume is at least --min-free-gb.
// Alert routes, all free: (1) the journal (always: the line printed here), (2) Telegram DM through the bot the OS already has:
// TELEGRAM_BOT_TOKEN plus MU_ALERT_TELEGRAM_CHAT_ID in /etc/mu-hub/<instance>.env (names only here, never values), (3) a plain
// file `<state>.alert` a person or the PC's own proactive job can read. The unit exits 1 on a bad state so `systemctl --failed`
// and `journalctl -p err` show it with no extra tooling. It alerts on ok->bad and bad->ok only: a two-minute timer must not
// send a message every two minutes.
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localOwnerHeaders } from "../identity/local-owner-token";

export type Finding = { check: "hub" | "backup" | "disk"; level: "ok" | "degraded" | "bad"; line: string };
export type WatchState = { level: "ok" | "bad"; since: string; lastLines: string[] };

export type WatchInput = {
  hub: string;
  backupsDir?: string;
  dataDir?: string;
  maxBackupHours: number;
  minFreeGb: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  freeBytes?: (dir: string) => number | null;
};

/** Newest `backup-*` folder that holds a manifest, with its age in hours. */
export function newestBackup(dir: string, now: Date): { name: string; ageHours: number } | null {
  if (!existsSync(dir)) return null;
  let best: { name: string; mtime: number } | null = null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !existsSync(join(dir, e.name, "manifest.json"))) continue;
    const m = statSync(join(dir, e.name, "manifest.json")).mtimeMs;
    if (!best || m > best.mtime) best = { name: e.name, mtime: m };
  }
  return best ? { name: best.name, ageHours: (now.getTime() - best.mtime) / 3_600_000 } : null;
}

function defaultFree(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function runChecks(i: WatchInput): Promise<Finding[]> {
  const out: Finding[] = [];
  const now = (i.now ?? (() => new Date()))();
  const f = i.fetchImpl ?? fetch;
  try {
    const res = await f(`${i.hub.replace(/\/$/, "")}/__health`, { signal: AbortSignal.timeout(8000), headers: localOwnerHeaders() });
    const body = (await res.json().catch(() => ({}))) as { status?: string; failed?: Array<{ component: string; detail: string }> };
    if (res.status !== 200 || (body.status !== "ok" && body.status !== "degraded")) {
      const why = (body.failed ?? []).map((x) => `${x.component}: ${x.detail}`).join("; ") || `HTTP ${res.status}`;
      out.push({ check: "hub", level: "bad", line: `hub unhealthy (${body.status ?? "no status"}): ${why}`.slice(0, 300) });
    } else if (body.status === "degraded") {
      out.push({ check: "hub", level: "degraded", line: `hub degraded: ${(body.failed ?? []).map((x) => x.component).join(", ") || "see /__health"}` });
    } else out.push({ check: "hub", level: "ok", line: "hub ok" });
  } catch (e) {
    out.push({ check: "hub", level: "bad", line: `hub unreachable at ${i.hub}: ${(e as Error).name}` });
  }
  if (i.backupsDir) {
    const nb = newestBackup(i.backupsDir, now);
    if (!nb) out.push({ check: "backup", level: "bad", line: `no backup with a manifest in ${i.backupsDir}` });
    else if (nb.ageHours > i.maxBackupHours) out.push({ check: "backup", level: "bad", line: `newest backup ${nb.name} is ${nb.ageHours.toFixed(1)} h old (limit ${i.maxBackupHours} h)` });
    else out.push({ check: "backup", level: "ok", line: `backup fresh (${nb.ageHours.toFixed(1)} h)` });
  }
  if (i.dataDir) {
    const free = (i.freeBytes ?? defaultFree)(i.dataDir);
    if (free === null) out.push({ check: "disk", level: "bad", line: `cannot read free space for ${i.dataDir}` });
    else if (free < i.minFreeGb * 1e9) out.push({ check: "disk", level: "bad", line: `only ${(free / 1e9).toFixed(1)} GB free (limit ${i.minFreeGb} GB)` });
    else out.push({ check: "disk", level: "ok", line: `disk ${(free / 1e9).toFixed(1)} GB free` });
  }
  return out;
}

/** Decide whether this run alerts. Alerts only when the overall level flips (ok -> bad, bad -> ok); degraded counts as ok. */
export function decide(findings: Finding[], prev: WatchState | null, now: Date): { state: WatchState; alert: string | null } {
  const bad = findings.filter((x) => x.level === "bad");
  const level: "ok" | "bad" = bad.length ? "bad" : "ok";
  const lines = (bad.length ? bad : findings).map((x) => x.line);
  const state: WatchState = { level, since: prev && prev.level === level ? prev.since : now.toISOString(), lastLines: lines };
  const before = prev?.level ?? "ok";
  if (level === "bad" && before !== "bad") return { state, alert: `ALERT cloud hub: ${lines.join(" | ")}` };
  if (level === "ok" && before === "bad") return { state, alert: `RECOVERED cloud hub: ${lines.join(" | ")}` };
  return { state, alert: null };
}

export async function sendTelegram(text: string, env: Record<string, string | undefined>, f: typeof fetch = fetch): Promise<"sent" | "not-configured" | "failed"> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.MU_ALERT_TELEGRAM_CHAT_ID;
  if (!token || !chat) return "not-configured";
  try {
    const r = await f(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 900) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

function readState(path: string): WatchState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WatchState;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string, d?: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const instance = opt("instance", "production")!;
  const statePath = opt("state", join(process.env.HOME ?? ".", "health-watch.json"))!;
  const dry = argv.includes("--dry-run");
  const findings = await runChecks({
    hub: opt("hub", "http://127.0.0.1:8081")!,
    backupsDir: opt("backups"),
    dataDir: opt("data-dir") ?? process.env.MU_DATA_DIR,
    maxBackupHours: Number(opt("max-backup-hours", "26")),
    minFreeGb: Number(opt("min-free-gb", "5")),
  });
  const { state, alert } = decide(findings, readState(statePath), new Date());
  for (const x of findings) console.log(`${x.level.toUpperCase().padEnd(8)} ${x.check}: ${x.line}`);
  if (!dry) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  if (alert && !dry) {
    const text = `[${instance}] ${alert}`;
    console.error(text);
    console.error(`telegram: ${await sendTelegram(text, process.env)}`);
    writeFileSync(`${statePath}.alert`, `${new Date().toISOString()} ${text}\n`);
  }
  process.exit(state.level === "bad" ? 1 : 0);
}

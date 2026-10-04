/**
 * Host health for an always-on Windows hub (R9 ops, 3 Oct 2026).
 *
 * `deploy/windows/mu-health-check.ps1` runs every 5 minutes (task `\MU\MU Health Check`) and writes the FACTS it can only see from Windows
 * (scheduled tasks, ports, the supervisor log, last-backup.json, disk free, the sign-in records file) to `<data dir>/ops/host-health.json`.
 * Everything that turns facts into words, alerts and reminders lives here, so the System page, /__health, the Windows Event Log and the
 * owner's Telegram DM all say the same thing:
 *
 *   describeChecks(facts)          plain lines for the page ("Hub: answering on port 8081")
 *   conditionsFrom(facts, active)  the alert conditions (supervisor gave up, hub down, Hindsight down, backup, disk, sign-in records)
 *   evaluate(health, prev, now)    which conditions alert now, which get a 6-hourly reminder, which are resolved (dedupe state in
 *                                  `<data dir>/ops/host-alerts.json`)
 *   hostComponent(dir, now)        the `host` component of GET /__health
 *
 * Two kinds of text: `detail` + `recovery` (with paths and commands) go to the Event Log and Telegram, where the person fixing it needs
 * them; `plain` is what the Home and System pages show: plain words only, no paths, commands, script or document names.
 *
 * No secrets: the facts hold ports, states, times, sizes and a backup error line; never an env value, a row or a file's contents.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DOWN_GRACE_MINUTES = 10;
export const REMIND_HOURS = 6;
export const BACKUP_MAX_AGE_HOURS = 26;
export const DISK_MIN_FREE_PERCENT = 10;
export const DISK_MIN_FREE_GB = 20;
/** Hysteresis: an active disk alert clears only above these, so free space hovering at the limit doesn't flap. */
export const DISK_RESOLVE_FREE_PERCENT = 12;
export const DISK_RESOLVE_FREE_GB = 25;
/** Hysteresis: an alerted condition must be absent this many runs in a row (15 minutes) before it is "resolved". */
export const CLEAR_RUNS_TO_RESOLVE = 3;
/** The task runs every 5 minutes; three missed runs is a stale report. */
export const STALE_AFTER_MINUTES = 15;

export type HostFacts = {
  hub?: { answering?: boolean; port?: number; gaveUp?: boolean; gaveUpAt?: string | null; supervisorTask?: string | null };
  hindsight?: { answering?: boolean; proxyAnswering?: boolean; state?: string | null; crashloopLock?: boolean; supervisorTask?: string | null };
  searxng?: { answering?: boolean };
  hermes?: { answering?: boolean };
  wsl?: { running?: boolean | null; keepAliveTask?: string | null };
  staging?: { gateway?: boolean; hub?: boolean };
  backup?: { present?: boolean; ok?: boolean; verified?: boolean; time?: string | null; ageHours?: number | null; error?: string | null };
  disks?: Array<{ drive: string; freeGb: number; sizeGb: number; freePct: number }>;
  sessionStore?: { readable?: boolean; problem?: string | null } | null;
};

export type HostHealthFile = { version: 1; checkedAt: string; host?: string; bootedAt?: string | null; facts: HostFacts };

export type CheckState = "ok" | "problem" | "info";
export type HostCheck = { id: string; label: string; state: CheckState; detail: string };

export type Condition = { id: string; title: string; detail: string; recovery: string; plain: string; immediate: boolean };

export type ConditionState = {
  since: string;
  alertedAt: string | null;
  notifiedAt: string | null;
  /** Consecutive runs the condition has been absent while alerted (0 while present). */
  clearRuns: number;
  title: string;
  detail: string;
  recovery: string;
  plain: string;
};
export type AlertState = { version: 1; evaluatedAt: string | null; conditions: Record<string, ConditionState> };
export type AlertEvent = { kind: "alert" | "reminder" | "resolved"; id: string; title: string; detail: string; recovery: string; since: string };

export const opsDir = (dataDir: string) => join(dataDir, "ops");
export const healthFile = (dataDir: string) => join(opsDir(dataDir), "host-health.json");
export const alertStateFile = (dataDir: string) => join(opsDir(dataDir), "host-alerts.json");
export const alertSettingsFile = (dataDir: string) => join(opsDir(dataDir), "alert-settings.json");

const gb = (n: number) => `${n >= 100 ? Math.round(n) : n.toFixed(1)} GB`;
const hoursText = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} h`);
const answered = (v: boolean | undefined, port: number, name: string): HostCheck["detail"] =>
  v ? `Answering on port ${port}.` : `${name} is not answering on port ${port}.`;
const letterOf = (drive: string) => drive.replace(/[^A-Za-z]/g, "").toUpperCase();

/** Plain lines for the System page (no paths, commands or file names). Missing facts are left out rather than guessed. */
export function describeChecks(f: HostFacts): HostCheck[] {
  const out: HostCheck[] = [];
  if (f.hub) {
    const port = f.hub.port ?? 8081;
    if (f.hub.gaveUp) out.push({ id: "hub", label: "Hub", state: "problem", detail: `Stopped restarting itself${f.hub.gaveUpAt ? ` at ${f.hub.gaveUpAt}` : ""} after repeated failures; it stays down until someone starts it again.` });
    else out.push({ id: "hub", label: "Hub", state: f.hub.answering ? "ok" : "problem", detail: answered(f.hub.answering, port, "The hub") });
  }
  if (f.hindsight) {
    const h = f.hindsight;
    const detail = h.crashloopLock
      ? "Stopped restarting itself after repeated failures. New memories wait in the queue."
      : h.answering
        ? `Answering on port 8888${h.proxyAnswering === false ? ", but its gatekeeper on 8878 is not" : ""}.`
        : "Not answering on port 8888. New memories wait in the queue; the vault still works.";
    const ok = h.answering && !h.crashloopLock && h.proxyAnswering !== false;
    out.push({ id: "hindsight", label: "Memory (Hindsight)", state: ok ? "ok" : "problem", detail });
  }
  if (f.searxng) out.push({ id: "searxng", label: "Search (SearXNG)", state: f.searxng.answering ? "ok" : "problem", detail: answered(f.searxng.answering, 18888, "Search") });
  if (f.hermes) out.push({ id: "hermes", label: "Hermes gateway", state: f.hermes.answering ? "ok" : "problem", detail: answered(f.hermes.answering, 8642, "The Hermes gateway") });
  if (f.wsl) {
    const r = f.wsl.running;
    out.push({ id: "wsl", label: "Linux (WSL) for search", state: r === false ? "problem" : r ? "ok" : "info", detail: r === false ? "The Linux system that runs search is not running." : r ? "Running." : "Could not tell whether it is running." });
  }
  if (f.staging) {
    const g = f.staging.gateway, s = f.staging.hub;
    out.push({ id: "staging", label: "Dot's staging gateway", state: "info", detail: `Shown for information only: gateway ${g ? "answering" : "not answering"}, staging hub ${s ? "answering" : "not answering"}.` });
  }
  if (f.backup) {
    const b = f.backup;
    if (!b.present) out.push({ id: "backup", label: "Last backup", state: "problem", detail: "No backup has been recorded yet." });
    else if (!b.ok || !b.verified) out.push({ id: "backup", label: "Last backup", state: "problem", detail: b.ok ? "The last backup could not be checked." : "The last backup failed." });
    else if ((b.ageHours ?? 0) > BACKUP_MAX_AGE_HOURS) out.push({ id: "backup", label: "Last backup", state: "problem", detail: `The newest checked backup is ${hoursText(b.ageHours ?? 0)} old (limit ${BACKUP_MAX_AGE_HOURS} h).` });
    else out.push({ id: "backup", label: "Last backup", state: "ok", detail: `Checked, ${hoursText(b.ageHours ?? 0)} ago.` });
  }
  for (const d of f.disks ?? []) {
    const low = diskBelow(d, DISK_MIN_FREE_PERCENT, DISK_MIN_FREE_GB);
    out.push({ id: `disk_${letterOf(d.drive)}`, label: `Disk ${d.drive}`, state: low ? "problem" : "ok", detail: `${gb(d.freeGb)} free of ${gb(d.sizeGb)} (${Math.round(d.freePct)}%).${low ? ` Below the limit (${DISK_MIN_FREE_PERCENT}% or ${DISK_MIN_FREE_GB} GB).` : ""}` });
  }
  if (f.sessionStore) out.push({ id: "sign_in_records", label: "Sign-in records", state: f.sessionStore.readable === false ? "problem" : "ok", detail: f.sessionStore.readable === false ? "Can't be read, so new sign-ins and pairing are paused. Nothing has been overwritten." : "Readable." });
  return out;
}

const diskBelow = (d: { freeGb: number; freePct: number }, pct: number, gbMin: number) => d.freePct < pct || d.freeGb < gbMin;

/**
 * The alert conditions present in these facts. `immediate` ones alert on the first run; the others only after DOWN_GRACE_MINUTES.
 * `active` = condition ids already in the alert state: an active disk condition holds until free space is back above the resolve margin.
 */
export function conditionsFrom(f: HostFacts, active: ReadonlySet<string> = new Set()): Condition[] {
  const out: Condition[] = [];
  if (f.hub?.gaveUp) {
    out.push({
      id: "hub_gave_up",
      immediate: true,
      title: "The hub supervisor gave up",
      detail: `It stopped after 6 failures in 10 minutes${f.hub.gaveUpAt ? ` (${f.hub.gaveUpAt})` : ""}; the hub stays down until the task is started again.`,
      recovery: "Read C:\\mu-hub\\logs\\hub-stderr.log.1 and mu-hub-supervisor.log, fix the cause, then Start-ScheduledTask -TaskPath '\\MU\\' -TaskName 'MU Hub Supervisor'.",
      plain: "The hub stopped restarting itself after repeated failures. Someone needs to check the hub computer and start it again.",
    });
  } else if (f.hub && f.hub.answering === false) {
    out.push({
      id: "hub_down",
      immediate: false,
      title: "The hub is not answering",
      detail: `Nothing answers on port ${f.hub.port ?? 8081}${f.hub.supervisorTask ? ` (supervisor task: ${f.hub.supervisorTask})` : ""}.`,
      recovery: "Check the \\MU\\MU Hub Supervisor task and C:\\mu-hub\\logs\\mu-hub-supervisor.log.",
      plain: "The hub hasn't answered for more than 10 minutes.",
    });
  }
  if (f.hindsight && (f.hindsight.answering === false || f.hindsight.crashloopLock)) {
    const lock = !!f.hindsight.crashloopLock;
    out.push({
      id: "hindsight_down",
      immediate: lock,
      title: "Memory (Hindsight) is down",
      detail: lock ? "Its supervisor stopped after too many restarts (crash-loop lock)." : `Nothing answers on port 8888${f.hindsight.supervisorTask ? ` (supervisor task: ${f.hindsight.supervisorTask})` : ""}. Memory saves wait in the queue.`,
      recovery: lock
        ? "Read the api-*.err.log files under D:\\hindsight\\logs, then (over ssh) supervisor.py clear-alert --profile pilot and start the \\Hindsight\\Hindsight pilot supervisor task."
        : "Start-ScheduledTask -TaskPath '\\Hindsight\\' -TaskName 'Hindsight pilot supervisor' (it exits at once if a supervisor already runs); status over ssh: supervisor.py status --profile pilot.",
      plain: lock ? "Memory stopped restarting itself after repeated failures. New memories wait in the queue until someone checks it." : "Memory hasn't answered for more than 10 minutes. New memories wait in the queue; the vault still works.",
    });
  }
  const b = f.backup;
  if (b && (!b.present || !b.ok || !b.verified || (b.ageHours ?? 0) > BACKUP_MAX_AGE_HOURS)) {
    const detail = !b.present ? "No backup has been recorded." : !b.ok ? `The last backup failed${b.error ? `: ${b.error.slice(0, 160)}` : "."}` : !b.verified ? "The last backup was not verified." : `The newest verified backup is ${hoursText(b.ageHours ?? 0)} old (limit ${BACKUP_MAX_AGE_HOURS} h).`;
    const plain = !b.present ? "No backup has been recorded." : !b.ok ? "The last backup failed." : !b.verified ? "The last backup could not be checked." : `The newest checked backup is ${hoursText(b.ageHours ?? 0)} old.`;
    out.push({ id: "backup", immediate: true, title: "Backups need attention", detail, plain, recovery: "Read C:\\mu-hub\\logs\\mu-hub-backup.log; run the \\MU\\MU Hub Backup task once it is fixed (it verifies before it prunes)." });
  }
  for (const d of f.disks ?? []) {
    const letter = letterOf(d.drive);
    const id = `disk_${letter}`;
    const low = active.has(id) ? diskBelow(d, DISK_RESOLVE_FREE_PERCENT, DISK_RESOLVE_FREE_GB) : diskBelow(d, DISK_MIN_FREE_PERCENT, DISK_MIN_FREE_GB);
    if (!low) continue;
    out.push({
      id,
      immediate: true,
      title: `Disk ${letter}: is low on space`,
      detail: `${gb(d.freeGb)} free (${Math.round(d.freePct)}%); the limit is ${DISK_MIN_FREE_PERCENT}% or ${DISK_MIN_FREE_GB} GB (clears above ${DISK_RESOLVE_FREE_PERCENT}% and ${DISK_RESOLVE_FREE_GB} GB).`,
      recovery: letter === "D" ? "Backups keep the newest 14 folders; remove old cutover copies under D:\\mu-hub-backups when the owner agrees." : "See R8-F-OPS.md section 7 for the folders that can go (staging copies, incoming, rehearsals) when the owner agrees.",
      plain: `Disk ${letter} has ${gb(d.freeGb)} free (${Math.round(d.freePct)}%).`,
    });
  }
  if (f.sessionStore?.readable === false) {
    out.push({
      id: "sign_in_records",
      immediate: true,
      title: "Sign-in records can't be read",
      detail: `${f.sessionStore.problem ?? "Unknown reason"}. Nothing will be overwritten; pairing and sign-in are refused.`,
      recovery: "R8-F-OPS.md section 4: stop the hub, restore devices.json from the newest verified backup or move it aside, start the hub.",
      plain: "The sign-in records can't be read, so new sign-ins and pairing are paused. Nothing has been overwritten.",
    });
  }
  return out;
}

export const emptyAlertState = (): AlertState => ({ version: 1, evaluatedAt: null, conditions: {} });

const isoOrNull = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

/** A state file of the wrong shape (hand-edited, truncated, older version) is cleaned rather than trusted: bad entries are dropped. */
export function sanitizeAlertState(raw: unknown): AlertState {
  const out = emptyAlertState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as { evaluatedAt?: unknown; conditions?: unknown };
  out.evaluatedAt = isoOrNull(r.evaluatedAt);
  if (!r.conditions || typeof r.conditions !== "object" || Array.isArray(r.conditions)) return out;
  for (const [id, v] of Object.entries(r.conditions as Record<string, unknown>)) {
    if (!/^[a-z_A-Z0-9]{1,40}$/.test(id) || !v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    const since = isoOrNull(c.since);
    if (!since) continue;
    const text = (x: unknown) => (typeof x === "string" ? x.slice(0, 600) : "");
    out.conditions[id] = {
      since,
      alertedAt: isoOrNull(c.alertedAt),
      notifiedAt: isoOrNull(c.notifiedAt),
      clearRuns: Number.isInteger(c.clearRuns) && (c.clearRuns as number) >= 0 ? (c.clearRuns as number) : 0,
      title: text(c.title),
      detail: text(c.detail),
      recovery: text(c.recovery),
      plain: text(c.plain) || text(c.title),
    };
  }
  return out;
}

/**
 * One evaluation. A condition alerts once when it becomes due (at once, or after DOWN_GRACE_MINUTES for "down" ones), then reminds at most
 * every REMIND_HOURS while it lasts. Once alerted it must be absent CLEAR_RUNS_TO_RESOLVE runs in a row before one "resolved"; coming back
 * inside that window continues the same alert (no second alert). One that clears inside its grace period says nothing.
 */
export function evaluate(health: HostHealthFile, prev: AlertState | null, now: Date): { state: AlertState; events: AlertEvent[] } {
  const before = sanitizeAlertState(prev).conditions;
  const at = now.toISOString();
  const next: Record<string, ConditionState> = {};
  const events: AlertEvent[] = [];
  const present = conditionsFrom(health.facts, new Set(Object.keys(before)));
  for (const c of present) {
    const old = before[c.id];
    const cs: ConditionState = { since: old?.since ?? at, alertedAt: old?.alertedAt ?? null, notifiedAt: old?.notifiedAt ?? null, clearRuns: 0, title: c.title, detail: c.detail, recovery: c.recovery, plain: c.plain };
    const due = c.immediate || now.getTime() - Date.parse(cs.since) >= DOWN_GRACE_MINUTES * 60_000;
    if (due && !cs.alertedAt) {
      cs.alertedAt = cs.notifiedAt = at;
      events.push({ kind: "alert", id: c.id, title: c.title, detail: c.detail, recovery: c.recovery, since: cs.since });
    } else if (due && cs.notifiedAt && now.getTime() - Date.parse(cs.notifiedAt) >= REMIND_HOURS * 3_600_000) {
      cs.notifiedAt = at;
      events.push({ kind: "reminder", id: c.id, title: c.title, detail: c.detail, recovery: c.recovery, since: cs.since });
    }
    next[c.id] = cs;
  }
  for (const [id, old] of Object.entries(before)) {
    if (next[id] || !old.alertedAt) continue;
    const clearRuns = old.clearRuns + 1;
    if (clearRuns >= CLEAR_RUNS_TO_RESOLVE) events.push({ kind: "resolved", id, title: old.title, detail: `Resolved (it began ${old.since}).`, recovery: "", since: old.since });
    else next[id] = { ...old, clearRuns };
  }
  return { state: { version: 1, evaluatedAt: at, conditions: next }, events };
}

/** The Telegram text for one run's events (one message per run, never one per condition). */
export function messageFor(events: AlertEvent[], host = "hub"): string {
  const lines = events.map((e) =>
    e.kind === "resolved" ? `RESOLVED: ${e.title}.` : `${e.kind === "reminder" ? "STILL" : "ALERT"}: ${e.title}. ${e.detail}${e.recovery ? ` Fix: ${e.recovery}` : ""}`,
  );
  return `M&U ${host}: ${lines.join("\n")}`.slice(0, 3500);
}

// ---- files ---------------------------------------------------------------------------------------------------------------------------

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function readHealth(path: string): HostHealthFile | null {
  const h = readJson<HostHealthFile>(path);
  return h && h.version === 1 && typeof h.checkedAt === "string" && h.facts && typeof h.facts === "object" ? h : null;
}

export type AlertSettings = { telegram: boolean };
/** Telegram is on unless switched off with `bun scripts/ops/host-alerts.ts telegram off` (the file below). MU_OPS_ALERTS_TELEGRAM=off
 *  works for a hand run only: the scheduled task does not load hub.env, so the file is the switch. */
export function readAlertSettings(dataDir: string, env: Record<string, string | undefined> = process.env): AlertSettings {
  if (/^(off|0|false|no)$/i.test((env.MU_OPS_ALERTS_TELEGRAM ?? "").trim())) return { telegram: false };
  const s = readJson<Partial<AlertSettings>>(alertSettingsFile(dataDir));
  return { telegram: s?.telegram !== false };
}

// ---- /__health -----------------------------------------------------------------------------------------------------------------------

export type HostComponent = {
  status: "ok" | "degraded";
  /** Plain words (shown on the pages). */
  detail: string;
  /** For operators reading /__health: may name a task or path. The pages never show it. */
  recovery?: string;
  checkedAt: string | null;
  host: string | null;
  /** True when host-health.json exists but can't be read. */
  reportUnreadable: boolean;
  checks: HostCheck[];
  /** Active alerts: `plain` is for the pages; detail and recovery (paths, commands) are for /__health readers, the Event Log and Telegram. */
  alerts: Array<{ id: string; title: string; plain: string; detail: string; recovery: string; since: string }>;
  telegram: boolean;
};

/** The `host` component: absent files are "not set up here" (a PC hub), a stale or unreadable report or an active alert is degraded, never failed. */
export function hostComponent(dataDir: string, now: Date = new Date(), env: Record<string, string | undefined> = process.env): HostComponent {
  const telegram = readAlertSettings(dataDir, env).telegram;
  const empty = { checkedAt: null, host: null, checks: [], alerts: [], telegram };
  if (!existsSync(healthFile(dataDir))) return { ...empty, status: "ok", reportUnreadable: false, detail: "The host check isn't set up on this machine (it runs on the always-on hub)." };
  const h = readHealth(healthFile(dataDir));
  if (!h) return { ...empty, status: "degraded", reportUnreadable: true, detail: "The hub computer's health report can't be read.", recovery: "Run the \\MU\\MU Health Check task once; it rewrites the report." };
  const st = sanitizeAlertState(readJson<unknown>(alertStateFile(dataDir)));
  const alerts = Object.entries(st.conditions)
    .filter(([, c]) => c.alertedAt)
    .map(([id, c]) => ({ id, title: c.title, plain: c.plain, detail: c.detail, recovery: c.recovery, since: c.since }));
  const checks = describeChecks(h.facts);
  const ageMin = (now.getTime() - Date.parse(h.checkedAt)) / 60_000;
  const base = { checkedAt: h.checkedAt, host: h.host ?? null, reportUnreadable: false, checks, alerts, telegram };
  if (!(ageMin <= STALE_AFTER_MINUTES)) {
    return { ...base, status: "degraded", detail: `The hub computer's health check last ran ${Number.isFinite(ageMin) ? `${Math.round(ageMin)} min` : "an unknown time"} ago, so this may be out of date.`, recovery: "Check the \\MU\\MU Health Check task (every 5 minutes) on the hub." };
  }
  if (alerts.length) return { ...base, status: "degraded", detail: alerts.map((a) => a.title).join("; ") + ".", recovery: alerts[0].recovery };
  const problems = checks.filter((c) => c.state === "problem").length;
  return { ...base, status: "ok", detail: problems ? `${problems} check(s) not ok yet (alerts wait ${DOWN_GRACE_MINUTES} min for a service to come back).` : "Every service on the hub host is answering." };
}

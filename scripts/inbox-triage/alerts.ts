// Inbox triage: settings, alert rate limits and the three owner-only channels.
//
//   telegram — a DM from Jarvis (@MnUJarvis_bot) through Hermes' own `hermes send`, which reuses
//              the gateway's credentials: this code never reads a token. The target is fixed to
//              the owner's own chat; nothing here can message anyone else.
//   voice    — the Jarvis interjection gate (/jarvis/events): spoken when he's at the PC and the
//              voice panel is open, a Windows toast otherwise; quiet hours and call mode apply.
//   call     — rings his own mobile through Retell. OFF by default and inert until a number,
//              an agent and his phone are configured (see callReadiness()).
//
// Everything is armed-but-off until `alerts.enabled` is switched on (cli.ts alerts on).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RANK, maskSecrets, type Importance } from "./rules";
import type { JevMode } from "./jev";
import type { TriageRow, TriageStore } from "./store";

/** The only Telegram chat these alerts may ever go to: Usman's own DM with @MnUJarvis_bot. */
export const OWNER_TELEGRAM = "telegram:8550678495";

export type TriageSettings = {
  version: 1;
  alerts: {
    /** The master switch. Off: every would-be alert is logged as "armed-off" and nothing is sent. */
    enabled: boolean;
    telegram: boolean;
    voice: boolean;
    /** Also DM for replies from CRM leads (off: they go to the digest). */
    leadReplies: boolean;
    maxPerHour: number;
    maxPerDay: number;
    /** Older emails are logged but never alerted (a backlog must not become a flood of DMs). */
    maxAgeHours: number;
    senderCooldownMinutes: number;
    threadCooldownMinutes: number;
  };
  call: { enabled: boolean; fromNumber: string; agentId: string; toNumber: string; maxPerDay: number };
  jev: { mode: JevMode; shadowTarget: number };
  /** His personal mailboxes (a stranger there is "personal", not a business enquiry). */
  personalAccounts: string[];
};

export const DEFAULT_SETTINGS: TriageSettings = {
  version: 1,
  alerts: { enabled: false, telegram: true, voice: true, leadReplies: false, maxPerHour: 6, maxPerDay: 25, maxAgeHours: 6, senderCooldownMinutes: 30, threadCooldownMinutes: 120 },
  call: { enabled: false, fromNumber: "", agentId: "", toNumber: "", maxPerDay: 2 },
  jev: { mode: "shadow", shadowTarget: 100 },
  personalAccounts: [],
};

export const settingsPath = (root: string) => join(root, ".operator-data", "inbox-triage.json");

export function readSettings(root: string): TriageSettings {
  try {
    const file = settingsPath(root);
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const s: TriageSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...saved,
      alerts: { ...DEFAULT_SETTINGS.alerts, ...(saved.alerts ?? {}) },
      call: { ...DEFAULT_SETTINGS.call, ...(saved.call ?? {}) },
      jev: { ...DEFAULT_SETTINGS.jev, ...(saved.jev ?? {}) },
    };
    s.alerts.enabled = saved.alerts?.enabled === true;
    s.call.enabled = saved.call?.enabled === true;
    s.jev.mode = s.jev.mode === "advisory" ? "advisory" : "shadow";
    s.personalAccounts = Array.isArray(saved.personalAccounts) ? saved.personalAccounts.filter((a: unknown) => typeof a === "string").map((a: string) => a.toLowerCase()) : [];
    return s;
  } catch {
    // A corrupt settings file must fail safe: alerts off.
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function writeSettings(root: string, settings: TriageSettings) {
  const file = settingsPath(root);
  mkdirSync(join(root, ".operator-data"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  return settings;
}

// --- rate limits ---------------------------------------------------------------------------------
export type Gate = { allowed: true } | { allowed: false; why: string };

/** Dedupe and rate limits for one channel. Urgent skips the per-hour and cooldown limits, not the daily cap. */
/** Same sender, same subject (numbers and case ignored): "Security alert" ×5 from one service is one alert. */
export const subjectKey = (row: Pick<TriageRow, "senderAddress" | "subject">) => `${row.senderAddress}|${row.subject.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim()}`.slice(0, 160);

export function rateGate(row: Pick<TriageRow, "messageId" | "threadId" | "senderAddress" | "subject" | "importance">, sent: Array<{ messageId: string; threadKey: string; senderKey: string; subjectKey?: string; importance: Importance; at: string }>, settings: TriageSettings, now: number): Gate {
  const a = settings.alerts;
  if (sent.some((s) => s.messageId === row.messageId)) return { allowed: false, why: "duplicate" };
  const within = (minutes: number) => sent.filter((s) => now - Date.parse(s.at) < minutes * 60_000);
  const urgent = row.importance === "urgent";
  const thread = within(a.threadCooldownMinutes).find((s) => s.threadKey === row.threadId);
  if (thread && !(urgent && RANK[thread.importance] < RANK.urgent)) return { allowed: false, why: "same thread alerted recently" };
  if (within(a.threadCooldownMinutes).some((s) => s.subjectKey && s.subjectKey === subjectKey(row))) return { allowed: false, why: "repeat of an alert already sent" };
  if (!urgent && within(a.senderCooldownMinutes).some((s) => s.senderKey === row.senderAddress)) return { allowed: false, why: "same sender alerted recently" };
  if (within(24 * 60).length >= a.maxPerDay) return { allowed: false, why: "daily alert cap reached" };
  if (!urgent && within(60).length >= a.maxPerHour) return { allowed: false, why: "hourly alert cap reached" };
  return { allowed: true };
}

// --- text ----------------------------------------------------------------------------------------
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const plain = (text: string) => maskSecrets(text).replace(/[`*_[\]<>]/g, "");

export function telegramText(row: TriageRow, test = false) {
  const tag = row.importance === "urgent" ? "URGENT" : row.category === "client" ? "Client" : row.category === "lead-reply" ? "Lead" : "Inbox";
  const lines = [
    `${test ? "[test] inbox triage alert\n" : ""}Jarvis · ${tag} email`,
    `From: ${clip(plain(row.senderName), 60)} (${row.senderDomain || "unknown domain"})`,
    `Subject: ${clip(plain(row.subject), 140)}`,
    ...(row.summary ? [`Gist: ${clip(plain(row.summary), 160)}`] : []),
    `Why: ${clip(plain(row.alertReason || row.reason), 220)}`,
    ...(row.flags.noAutoAction ? ["Nothing was clicked or actioned. Check it in the provider's own app."] : []),
  ];
  return lines.join("\n").slice(0, 900);
}

export function spokenText(row: TriageRow) {
  const who = clip(plain(row.senderName), 40);
  const lead = row.importance === "urgent" ? "Urgent email, sir" : row.category === "client" ? "A client email, sir" : "An email you'll want, sir";
  return clip(`${lead}: ${who}, "${clip(plain(row.subject), 90)}". ${clip(plain(row.alertReason || row.reason), 120)}`, 300);
}

// --- channels ------------------------------------------------------------------------------------
export type Channels = {
  telegram: (text: string) => Promise<{ ok: boolean; detail: string }>;
  voice: (event: { source: string; text: string; priority: "normal" | "urgent"; dedupeKey: string }) => Promise<{ ok: boolean; detail: string }>;
  call: (row: TriageRow) => Promise<{ ok: boolean; detail: string }>;
};

export function hermesBinary() {
  const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes", "bin", process.platform === "win32" ? "hermes.exe" : "hermes") : "";
  for (const candidate of [local, join(homedir(), ".local", "bin", "hermes")]) if (candidate && existsSync(candidate)) return candidate;
  return "hermes";
}

/** One DM to the owner via `hermes send` (text on stdin, so nothing lands in a process list). */
export function hermesTelegram(options: { binary?: string; timeoutMs?: number; launch?: typeof spawn } = {}) {
  return (text: string) =>
    new Promise<{ ok: boolean; detail: string }>((resolve) => {
      let settled = false;
      const done = (value: { ok: boolean; detail: string }) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const child = (options.launch ?? spawn)(options.binary ?? hermesBinary(), ["send", "--to", OWNER_TELEGRAM, "--quiet", "--file", "-"], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        let err = "";
        child.stderr?.on("data", (chunk) => { err = (err + String(chunk)).slice(-400); });
        const timer = setTimeout(() => { child.kill(); done({ ok: false, detail: "hermes send timed out" }); }, options.timeoutMs ?? 30_000);
        child.on("error", () => { clearTimeout(timer); done({ ok: false, detail: "hermes could not be started" }); });
        child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true, detail: "sent" } : { ok: false, detail: `hermes send exit ${code}: ${err.trim().split("\n").pop()?.slice(0, 120) ?? ""}` }); });
        child.stdin?.end(text, "utf8");
      } catch {
        done({ ok: false, detail: "hermes could not be started" });
      }
    });
}

/** Why the phone call hook can't ring yet (empty = ready). Never reveals a key. */
export function callReadiness(settings: TriageSettings, hasRetellKey: boolean) {
  const missing: string[] = [];
  if (!settings.call.enabled) missing.push("call.enabled is off");
  if (!/^\+61\d{9}$/.test(settings.call.fromNumber)) missing.push("call.fromNumber: an M&U AU number imported into Retell (the Twilio number isn't bought yet)");
  if (!settings.call.agentId) missing.push("call.agentId: a Retell agent that reads {{sender}}, {{subject}} and {{why}}");
  if (!/^\+61\d{9}$/.test(settings.call.toNumber)) missing.push("call.toNumber: his own mobile, +61 format");
  if (!hasRetellKey) missing.push("RETELL_API_KEY in ~/.config/agentic-os.env");
  return missing;
}

/** Retell create-phone-call to his own mobile. Only ever called when callReadiness() is empty. */
export function retellCall(settings: () => TriageSettings, key: () => string, request: typeof fetch = fetch) {
  return async (row: TriageRow) => {
    const s = settings();
    const apiKey = key();
    const missing = callReadiness(s, !!apiKey);
    if (missing.length) return { ok: false, detail: `call hook off: ${missing[0]}` };
    try {
      const response = await request("https://api.retellai.com/v2/create-phone-call", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from_number: s.call.fromNumber,
          to_number: s.call.toNumber,
          override_agent_id: s.call.agentId,
          retell_llm_dynamic_variables: { sender: clip(plain(row.senderName), 60), subject: clip(plain(row.subject), 120), why: clip(plain(row.alertReason || row.reason), 160) },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return response.ok ? { ok: true, detail: `rang (Retell ${response.status})` } : { ok: false, detail: `Retell refused (${response.status})` };
    } catch {
      return { ok: false, detail: "Retell unreachable" };
    }
  };
}

/**
 * Send the alerts for freshly logged rows. Never throws; every outcome is written to the ledger
 * and the row's alert_status. With alerts disabled nothing leaves the PC.
 */
export async function dispatchAlerts(rows: TriageRow[], ctx: { store: TriageStore; settings: TriageSettings; channels: Channels; now: number }) {
  const { store, settings, channels, now } = ctx;
  const results: Array<{ messageId: string; status: string }> = [];
  const iso = new Date(now).toISOString();
  for (const row of rows) {
    if (!row.wouldAlert) continue;
    if (row.backfill || now - Date.parse(row.receivedAt) > settings.alerts.maxAgeHours * 3_600_000) {
      store.setAlertStatus(row.messageId, "stale");
      results.push({ messageId: row.messageId, status: "stale" });
      continue;
    }
    if (!settings.alerts.enabled) {
      store.setAlertStatus(row.messageId, "armed-off");
      results.push({ messageId: row.messageId, status: "armed-off" });
      continue;
    }
    const statuses: string[] = [];
    const base = { messageId: row.messageId, threadKey: row.threadId, senderKey: row.senderAddress, subjectKey: subjectKey(row), importance: row.importance, at: iso };
    if (settings.alerts.telegram) {
      const gate = rateGate(row, store.ledger.sentSince("telegram", new Date(now - 24 * 3_600_000).toISOString()), settings, now);
      if (!gate.allowed) {
        store.ledger.record({ ...base, channel: "telegram", status: "suppressed", detail: gate.why });
        statuses.push(`telegram suppressed: ${gate.why}`);
      } else {
        const sent = await channels.telegram(telegramText(row)).catch(() => ({ ok: false, detail: "send failed" }));
        store.ledger.record({ ...base, channel: "telegram", status: sent.ok ? "sent" : "failed", detail: sent.detail });
        statuses.push(sent.ok ? "telegram sent" : `telegram failed: ${sent.detail}`);
      }
    }
    if (settings.alerts.voice) {
      const spoken = await channels.voice({ source: "inbox", text: spokenText(row), priority: row.importance === "urgent" ? "urgent" : "normal", dedupeKey: `inbox:${row.messageId}`.slice(0, 120) }).catch(() => ({ ok: false, detail: "gate unavailable" }));
      store.ledger.record({ ...base, channel: "voice", status: spoken.ok ? "sent" : "failed", detail: spoken.detail });
      statuses.push(spoken.ok ? `voice ${spoken.detail}` : `voice failed: ${spoken.detail}`);
    }
    if (settings.call.enabled && row.importance === "urgent" && (row.category === "client" || row.flags.security || row.flags.payment)) {
      const today = store.ledger.sentSince("call", new Date(now - 24 * 3_600_000).toISOString());
      if (today.length >= settings.call.maxPerDay || today.some((c) => c.threadKey === row.threadId)) {
        store.ledger.record({ ...base, channel: "call", status: "suppressed", detail: "call cap" });
      } else {
        const rang = await channels.call(row).catch(() => ({ ok: false, detail: "call failed" }));
        store.ledger.record({ ...base, channel: "call", status: rang.ok ? "sent" : "failed", detail: rang.detail });
        statuses.push(rang.ok ? "call placed" : `call: ${rang.detail}`);
      }
    }
    const status = statuses.join("; ") || "no channel on";
    store.setAlertStatus(row.messageId, status);
    results.push({ messageId: row.messageId, status });
  }
  return results;
}

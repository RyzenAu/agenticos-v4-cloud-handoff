// Thin read-only glue for the Jarvis HUD (src/components/operator/agent-live-panel.tsx and the
// status ring): the live steps of the Hermes run Jarvis just handed work to, and a health dot per
// connected service. Nothing here starts, sends or changes anything, and no `claude -p` probe is
// added: Hermes and the two local HTTP services are asked with a 1.5 s GET, the rest comes from
// the capability registry that already exists (.operator-data/capabilities.json).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrub } from "./away-mode/store";
import { hermesApiUp } from "./hermes-api";

/** Keys, tokens, long numbers (the away-mode scrubber) plus anything pointing into a .env file. */
export function redact(text: unknown, max = 220): string {
  let s = scrub(String(text ?? ""))
    // Any path or word that names a .env file: hide the whole path, never the contents.
    .replace(/(?:[A-Za-z]:)?[^\s"'`]*[\\/]?\.env(?:\.[A-Za-z0-9_-]+)?\b[^\s"'`]*/g, "[.env hidden]")
    // KEY=value / "api_key": "value" pairs.
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[hidden]")
    // Long opaque blobs (API keys without a known prefix).
    .replace(/\b[A-Za-z0-9_\-+/]{40,}={0,2}/g, "[hidden]")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

export type FeedStep = { at: string; kind: "tool" | "result" | "say" | "error"; name?: string; text: string };
export type HermesRun = {
  id: string;
  model: string | null;
  source: string;
  startedAt: string;
  endedAt: string | null;
  activity: string | null;
  toolCalls: number;
  steps: FeedStep[];
};

type Row = Record<string, unknown>;
const iso = (sec: unknown) => (typeof sec === "number" ? new Date(sec * 1000).toISOString() : null);

/** Short, human description of one tool call's arguments. */
function describeArgs(raw: unknown) {
  let args: Record<string, unknown> = {};
  try {
    args = typeof raw === "string" ? JSON.parse(raw) : ((raw as Record<string, unknown>) ?? {});
  } catch {
    return redact(raw, 140);
  }
  const pick = ["command", "action", "url", "query", "path", "text", "app", "target", "name"].find((k) => typeof args[k] === "string");
  return redact(pick ? args[pick] : JSON.stringify(args), 140);
}

/** A tool result as a person would read it: the output (or error) text, lines joined with " · ". */
export function toolOutput(content: string) {
  let text = content;
  try {
    const data = JSON.parse(content);
    if (data && typeof data === "object") {
      const pick = ["output", "error", "result", "description", "content", "message"].find((k) => typeof data[k] === "string" && data[k].trim());
      if (pick) text = data[pick];
    }
  } catch {
    /* plain text */
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
}

/** Map state.db message rows (oldest first) to feed steps. Pure; unit tested. */
export function stepsFromMessages(rows: Row[]): FeedStep[] {
  const steps: FeedStep[] = [];
  for (const row of rows) {
    const at = iso(row.timestamp) ?? new Date(0).toISOString();
    if (row.role === "assistant") {
      let calls: Array<{ function?: { name?: string; arguments?: unknown } }> = [];
      try {
        calls = typeof row.tool_calls === "string" && row.tool_calls ? JSON.parse(row.tool_calls) : [];
      } catch {
        calls = [];
      }
      for (const call of Array.isArray(calls) ? calls : [])
        steps.push({ at, kind: "tool", name: redact(call.function?.name ?? "tool", 40), text: describeArgs(call.function?.arguments) });
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if (content) steps.push({ at, kind: "say", text: redact(content, 320) });
    } else if (row.role === "tool") {
      const content = typeof row.content === "string" ? row.content : "";
      const failed = /"(?:error|success)"\s*:\s*(?:"[^"]+"|false)|\bTraceback\b|\berror:/i.test(content.slice(0, 400));
      steps.push({ at, kind: failed ? "error" : "result", name: typeof row.tool_name === "string" ? redact(row.tool_name, 40) : undefined, text: redact(toolOutput(content), 160) });
    }
  }
  return steps;
}

function hermesDb() {
  const home = process.env.HERMES_HOME || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes");
  for (const path of [join(home, "state.db"), join(homedir(), ".hermes", "state.db")]) if (existsSync(path)) return path;
  return null;
}

/**
 * The newest Hermes run that was active at or after `sinceMs` (the moment Jarvis handed it the
 * task), with its last 40 steps. Null when none. Only runs Jarvis starts (API server, one-shot CLI).
 */
export async function hermesRun(sinceMs: number): Promise<HermesRun | null> {
  const path = hermesDb();
  if (!path) return null;
  const since = Math.floor(sinceMs / 1000) - 5;
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    const session = db
      .query(
        "SELECT id, model, source, started_at, ended_at, last_activity_description, tool_call_count FROM sessions WHERE source IN ('api_server','oneshot') AND COALESCE(last_activity_at, ended_at, started_at) >= ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(since) as Row | null;
    if (!session) return null;
    const rows = (
      db
        .query(
          "SELECT role, content, tool_calls, tool_name, timestamp FROM messages WHERE session_id = ? AND role IN ('assistant','tool') AND timestamp >= ? ORDER BY id DESC LIMIT 40",
        )
        .all(String(session.id), since) as Row[]
    ).reverse();
    return {
      id: String(session.id),
      model: typeof session.model === "string" ? session.model : null,
      source: String(session.source),
      startedAt: iso(session.started_at) ?? new Date().toISOString(),
      endedAt: iso(session.ended_at),
      activity: session.last_activity_description ? redact(session.last_activity_description, 140) : null,
      toolCalls: Number(session.tool_call_count) || 0,
      steps: stepsFromMessages(rows),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// --- status ring --------------------------------------------------------------------------------

export type ServiceDot = { id: string; label: string; state: "up" | "warn" | "down" | "unknown"; detail: string };
type Capability = { id: string; status: "working" | "available" | "setup-required" | "broken"; evidence?: string };

/**
 * A registry entry as a dot (UI-truth M4). Only "working" (an end-to-end acceptance test passed)
 * is up; "available" means configured (a key or install is present) but not verified, so it's
 * unknown, never green; setup-required is warn; broken is down.
 */
export const fromRegistry = (caps: Capability[], id: string, label: string): ServiceDot => {
  const cap = caps.find((c) => c.id === id);
  if (!cap) return { id, label, state: "unknown", detail: "Not in the capability registry yet" };
  const state = cap.status === "working" ? "up" : cap.status === "available" ? "unknown" : cap.status === "setup-required" ? "warn" : "down";
  const word = cap.status === "available" ? "configured, not verified" : cap.status === "working" ? "verified working" : cap.status.replace("-", " ");
  return { id, label, state, detail: redact(`${word} · ${cap.evidence ?? ""}`, 140) };
};

/** A local health ping: 2xx/3xx is up; a 4xx (refused, not found, unauthorised) or 5xx is failed. */
export type Ping = { up: boolean; status: number | null };
export async function httpPing(url: string, request: typeof fetch): Promise<Ping> {
  try {
    const r = await request(url, { signal: AbortSignal.timeout(1500) });
    return { up: r.status >= 200 && r.status < 400, status: r.status };
  } catch {
    return { up: false, status: null };
  }
}

const pingDetail = (ping: Ping, okText: string, what: string) =>
  ping.up ? okText : ping.status === null ? `Not answering on ${what}` : `Answered HTTP ${ping.status} on ${what}`;

/** One dot per service the HUD ring shows. Pure over its inputs so it can be tested. */
export async function serviceDots(caps: Capability[], request: typeof fetch = fetch): Promise<ServiceDot[]> {
  const [hermes, hindsight, searxng] = await Promise.all([
    hermesApiUp(request),
    httpPing("http://127.0.0.1:8888/health", request),
    httpPing("http://127.0.0.1:18888/healthz", request),
  ]);
  const jev = fromRegistry(caps, "voice.jev-reflex", "Jev");
  const telegram = fromRegistry(caps, "channel.telegram", "Telegram");
  return [
    { id: "hermes", label: "Hermes", state: hermes ? "up" : "down", detail: hermes ? "Gateway answering on :8642" : "Gateway not answering on :8642" },
    { ...jev, id: "jev" },
    { id: "hindsight", label: "Hindsight", state: hindsight.up ? "up" : "down", detail: pingDetail(hindsight, "Memory service on :8888", ":8888") },
    { id: "searxng", label: "SearXNG", state: searxng.up ? "up" : "down", detail: pingDetail(searxng, "Search on :18888", ":18888") },
    { ...telegram, id: "telegram" },
  ];
}

let cached: { at: number; value: { checkedAt: string; services: ServiceDot[] } } | null = null;
/** Cached for 20 s so every open HUD polling doesn't multiply the checks. */
export async function hudServices(root: string) {
  if (cached && Date.now() - cached.at < 20_000) return cached.value;
  let caps: Capability[] = [];
  try {
    caps = JSON.parse(readFileSync(join(root, ".operator-data", "capabilities.json"), "utf8")).capabilities ?? [];
  } catch {
    caps = [];
  }
  const value = { checkedAt: new Date().toISOString(), services: await serviceDots(caps) };
  cached = { at: Date.now(), value };
  return value;
}

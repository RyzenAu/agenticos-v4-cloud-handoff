// Quick actions on /business: the pinned set, a small run log (who pressed what, and how it went),
// the viewer's name, plus the read-only HUD feeds (scripts/hud-feed.ts). Thin glue only — every
// button calls an endpoint that already exists; this file just remembers pins and outcomes in
// .operator-data/quick-actions.json and never runs an action itself.
//
//   GET  /quick-actions                → { pinned, log, viewer }
//   POST /quick-actions/pins           { pinned: string[] }
//   POST /quick-actions/log            { action, ok, summary, ms, by? }
//   GET  /quick-actions/receptionist   → is the MU-Receptionist app up on :3000, which client orgs
//   GET  /hud/services                 → status-ring dots
//   GET  /hud/hermes?since=<ms>        → the Hermes run Jarvis handed work to, step by step
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermesRun, hudServices, redact } from "./hud-feed";
import { dataDirFor } from "./cloud/data-dir";

/** Every action the rail knows. The client holds the wiring; the server only validates ids. */
export const QUICK_ACTION_IDS = [
  "plan-today",
  "todays-calls",
  "morning-brief",
  "find-phones",
  "generate-preview",
  "inbox-important",
  "seo-audit",
  "receptionist-report",
  "daily-review",
  "end-day",
] as const;
export type QuickActionId = (typeof QUICK_ACTION_IDS)[number];
export const DEFAULT_PINNED: QuickActionId[] = [
  "plan-today",
  "todays-calls",
  "morning-brief",
  "find-phones",
  "generate-preview",
  "inbox-important",
  "seo-audit",
  "receptionist-report",
  "daily-review",
];

export type LogEntry = { id: string; at: string; action: QuickActionId; by: string; ok: boolean; summary: string; ms: number };
type Stored = { version: 1; pinned: QuickActionId[]; log: LogEntry[] };
const KEEP = 200;
const isAction = (value: unknown): value is QuickActionId => typeof value === "string" && (QUICK_ACTION_IDS as readonly string[]).includes(value);

export function normalisePins(value: unknown): QuickActionId[] {
  if (!Array.isArray(value)) throw new Error("Send the pinned actions as a list.");
  const pins = [...new Set(value.filter(isAction))];
  if (pins.length !== value.length) throw new Error("That list has an unknown or repeated action.");
  return pins;
}

/** Who pressed it: a Tailscale visitor is who people.json says they are; at this PC it's the picker. */
export function resolveBy(remote: { name: string } | null, requested: unknown) {
  if (remote) return remote.name;
  return requested === "mehroz" ? "Mehroz" : "Usman";
}

export function quickActionStore(root: string) {
  const dir = join(dataDirFor(root));
  const file = join(dir, "quick-actions.json");
  const read = (): Stored => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return {
        version: 1,
        pinned: Array.isArray(data.pinned) ? data.pinned.filter(isAction) : [...DEFAULT_PINNED],
        log: Array.isArray(data.log) ? data.log.slice(-KEEP) : [],
      };
    } catch {
      return { version: 1, pinned: [...DEFAULT_PINNED], log: [] };
    }
  };
  const write = (state: Stored) => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };
  return {
    read,
    setPins(value: unknown) {
      const state = read();
      state.pinned = normalisePins(value);
      write(state);
      return state.pinned;
    },
    log(body: Record<string, unknown>, by: string, now = new Date()) {
      if (!isAction(body.action)) throw new Error("Unknown action.");
      const entry: LogEntry = {
        id: `qa_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: now.toISOString(),
        action: body.action,
        by,
        ok: body.ok === true,
        summary: redact(body.summary, 200),
        ms: Number.isFinite(body.ms) ? Math.max(0, Math.round(Number(body.ms))) : 0,
      };
      const state = read();
      state.log = [...state.log, entry].slice(-KEEP);
      write(state);
      return entry;
    },
  };
}

const RECEPTIONIST = "D:\\MU-Receptionist";
async function receptionist() {
  let running = false;
  try {
    const r = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(1500), redirect: "manual" });
    running = r.status > 0;
  } catch {
    running = false;
  }
  let orgs: string[] = [];
  try {
    const clients = join(RECEPTIONIST, "clients");
    if (existsSync(clients))
      orgs = readdirSync(clients, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^[a-z0-9-]{2,60}$/.test(d.name))
        .map((d) => d.name);
  } catch {
    orgs = [];
  }
  return { running, base: "http://localhost:3000", orgs };
}

type RouteInput = {
  root: string;
  path: string;
  method: string;
  body: any;
  url: URL;
  remote: { name: string; role?: string } | null;
  send: (value: unknown, status?: number) => void;
};

export async function quickActionsRoute({ root, path, method, body, url, remote, send }: RouteInput): Promise<boolean> {
  if (path.startsWith("/hud/")) {
    if (method === "GET" && path === "/hud/services") return send(await hudServices(root)), true;
    if (method === "GET" && path === "/hud/hermes") {
      const since = Number(url.searchParams.get("since"));
      if (!Number.isFinite(since) || since <= 0) return send({ error: "since (ms) is required" }, 400), true;
      return send({ run: await hermesRun(since) }), true;
    }
    return false;
  }
  if (path !== "/quick-actions" && !path.startsWith("/quick-actions/")) return false;
  const store = quickActionStore(root);
  try {
    if (method === "GET" && path === "/quick-actions") {
      const state = store.read();
      send({ pinned: state.pinned, log: state.log.slice(-12).reverse(), viewer: remote ? { name: remote.name, remote: true } : { name: null, remote: false } });
    } else if (method === "GET" && path === "/quick-actions/receptionist") {
      send(remote ? { running: false, base: null, orgs: [], note: "The receptionist report opens on the PC only." } : await receptionist());
    } else if (method === "POST" && path === "/quick-actions/pins") {
      send({ pinned: store.setPins(body?.pinned) });
    } else if (method === "POST" && path === "/quick-actions/log") {
      send({ entry: store.log(body ?? {}, resolveBy(remote, body?.by)) });
    } else send({ error: "Unknown quick-actions route." }, 404);
  } catch (error) {
    send({ error: (error as Error).message }, 400);
  }
  return true;
}

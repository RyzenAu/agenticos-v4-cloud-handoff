import { execFileSync } from "node:child_process";
import { runFileText } from "./nonblocking-exec";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { createRateLimitedWarn, relayedByTailscaleServe, type ServePeerCheck } from "./identity/serve-peer";

/**
 * Who is who, and signing in to Agentic OS from other devices over Tailscale.
 *
 * One file, `.operator-data/people.json`, lists the people who may use Jarvis and how
 * each is recognised: their Tailscale login (for the web app and voice on their phone or
 * PC) and their Telegram user ID (for the bot). Tailscale Serve relays browser requests
 * from this machine and stamps a verified `Tailscale-User-Login` header, so the login is
 * the person's Tailscale account — no extra passwords. Anyone not in the file is refused,
 * including every other device on the tailnet.
 */

export type Person = { name: string; role?: string; tailscale?: string[]; telegram?: string[]; notes?: string };

export function peopleFile(root: string) {
  return join(root, ".operator-data", "people.json");
}

export function readPeople(root: string): Person[] {
  try {
    const data = JSON.parse(readFileSync(peopleFile(root), "utf8"));
    return Array.isArray(data?.people) ? (data.people as Person[]).filter((p) => p && typeof p.name === "string") : [];
  } catch {
    return [];
  }
}

const TAILSCALE_EXES = ["C:\\Program Files\\Tailscale\\tailscale.exe", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
type StatusRunner = (exe: string) => Promise<string>;
const runStatus: StatusRunner = (exe) => runFileText(exe, ["status", "--json"], { timeout: 8000 });
const dnsNameOf = (json: string) => String(JSON.parse(json)?.Self?.DNSName || "").replace(/\.$/, "").toLowerCase();

/** This machine's own tailnet name (e.g. desktop-d8qctmg.tail572fa0.ts.net), or "". Blocking: CLIs and tests only. */
function detectTailnetName() {
  const exe = TAILSCALE_EXES.find((p) => existsSync(p));
  if (!exe) return "";
  try {
    const json = execFileSync(exe, ["status", "--json"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    recordStatus(json);
    return dnsNameOf(json);
  } catch {
    return "";
  }
}

let tailnetName: string | undefined;
let priming: Promise<string> | null = null;
export function ownTailnetName() {
  if (tailnetName === undefined) tailnetName = process.env.AGENTIC_OS_TAILNET_NAME?.toLowerCase() || detectTailnetName();
  return tailnetName;
}

/**
 * Fill ownTailnetName() without blocking (T8b, review T8 S-6). The server calls this at startup and
 * holds requests until it settles: `tailscale status` could take its full 8 s timeout (Tailscale
 * offline) inside the FIRST request's identity check, with every other request stalled behind it.
 * The same status output is this node's tailnet snapshot (REVIEW-S1 R2-1).
 */
export function primeOwnTailnetName(run: StatusRunner = runStatus, exes: string[] = TAILSCALE_EXES): Promise<string> {
  if (tailnetName !== undefined) return Promise.resolve(tailnetName);
  const fromEnv = process.env.AGENTIC_OS_TAILNET_NAME?.toLowerCase();
  if (fromEnv) {
    // The name is configured, but which node is this one still comes from Tailscale (in the background).
    void refreshTailnetSnapshot(run, exes);
    return Promise.resolve((tailnetName = fromEnv));
  }
  return (priming ??= (async () => {
    const exe = exes.find((p) => existsSync(p));
    let name = "";
    if (exe) {
      try {
        const json = await run(exe);
        recordStatus(json);
        name = dnsNameOf(json);
      } catch {
        name = "";
      }
    }
    tailnetName ??= name;
    return tailnetName;
  })());
}

// ---------------------------------------------------------------------------------------------
// REVIEW-S1 R2-1: which tailnet NODE a Serve request came from (the Serve self-loop)
//
// The hub is itself a tailnet node signed in as Usman. A program on the hub that connects to the hub's
// own Serve address (https://<hub>.ts.net:8443, or `tailscale nc`) arrives through the REAL tailscaled,
// so the socket peer check passes, and tailscaled's WhoIs answers for its own node too, so the request
// carries a GENUINE Tailscale-User-Login for Usman. That must never make a local program "Usman remote".
//
// Serve's proxy stamps X-Forwarded-For with the tailnet source address (only the address, no port) in
// the same step as the login, replacing any incoming value, so once the socket's peer is verified as
// tailscaled that header names the source. The source is then resolved to a NODE, by its stable node ID,
// in a `tailscale status` snapshot (Self.ID and Self.TailscaleIPs, each Peer's ID and TailscaleIPs): an
// address of this node, or of a peer whose ID is this node's, is the self-loop. Only a source that is
// positively another node passes. Anything else is refused (fail closed, never remote-human): no header,
// an empty one, a chain, a port, a non-tailnet address, an address the snapshot doesn't know, or no
// usable snapshot (Tailscale offline, `status` failed, or older than the hard limit).
//
// Freshness: the identity gate awaits a refresh (one `tailscale status`, ~150 ms, shared by concurrent
// requests) before believing a Serve login when the snapshot is older than 30 s or doesn't know the
// source; everything else reads the cached snapshot and, past 2 minutes, treats it as unknown. A node
// rename or a changed address is picked up by the next refresh; the node IDs don't change with either.

export type TailnetSnapshot = {
  /** This node's MagicDNS name (no trailing dot). */
  name: string;
  /** This node's stable node ID (status Self.ID). */
  selfId: string;
  /** The stable node ID that owns a tailnet address, or null if the snapshot doesn't know it. */
  nodeOf: (ip: string) => string | null;
  at: number;
};
/** Where the identity layer gets the current snapshot (null = unknown: every Serve login refused). */
export type TailnetSource = () => TailnetSnapshot | null;

const SNAPSHOT_SOFT_MS = 30_000;
const SNAPSHOT_HARD_MS = 2 * 60_000;
const UNKNOWN_SOURCE_RETRY_MS = 5_000;
const REFRESH_TIMEOUT_MS = 4_000;

/** Parse `tailscale status --json` into a snapshot, or null when it doesn't identify this node. */
export function snapshotFromStatus(json: string, at = Date.now()): TailnetSnapshot | null {
  const status = JSON.parse(json);
  const self = status?.Self;
  const selfId = String(self?.ID ?? "").trim();
  const ipsOf = (list: unknown) => (Array.isArray(list) ? list.map((ip) => canonicalIp(String(ip))).filter((ip): ip is string => !!ip) : []);
  const selfIps = ipsOf(self?.TailscaleIPs);
  if (!selfId || !selfIps.length) return null;
  const byIp = new Map<string, string>(selfIps.map((ip) => [ip, selfId]));
  for (const peer of Object.values<any>(status?.Peer ?? {})) {
    const id = String(peer?.ID ?? "").trim();
    if (!id) continue;
    for (const ip of ipsOf(peer?.TailscaleIPs)) if (!byIp.has(ip)) byIp.set(ip, id);
  }
  return { name: String(self?.DNSName ?? "").replace(/\.$/, "").toLowerCase(), selfId, nodeOf: (ip) => byIp.get(ip) ?? null, at };
}

let snapshot: TailnetSnapshot | undefined;
let refreshing: Promise<void> | null = null;
let lastRefreshAt = -Infinity;
let statusRunner: StatusRunner = runStatus;
let statusExes: string[] = TAILSCALE_EXES;

function recordStatus(json: string) {
  try {
    const next = snapshotFromStatus(json);
    if (!next) return;
    snapshot = next;
    // A renamed hub: the Host Serve forwards changes with it (an env-configured name stays as configured).
    if (next.name && !process.env.AGENTIC_OS_TAILNET_NAME && tailnetName !== undefined && tailnetName !== next.name) tailnetName = next.name;
  } catch {
    /* unparsable: keep what we had; it ages out */
  }
}

/** Re-read the snapshot without blocking the event loop; concurrent callers share one run. */
export function refreshTailnetSnapshot(run: StatusRunner = statusRunner, exes: string[] = statusExes): Promise<void> {
  if (refreshing) return refreshing;
  lastRefreshAt = Date.now();
  const exe = exes.find((p) => existsSync(p));
  if (!exe) return Promise.resolve();
  const running = (async () => {
    try {
      recordStatus(await run(exe));
    } catch {
      /* Tailscale offline: keep what we had until it ages out (then every Serve login is refused) */
    } finally {
      refreshing = null;
    }
  })();
  refreshing = running;
  return running;
}

/** The current snapshot, or null past the hard limit (then no Serve login is believed). Refreshes in the background when stale. */
export function currentTailnetSnapshot(): TailnetSnapshot | null {
  const age = snapshot ? Date.now() - snapshot.at : Infinity;
  if (age > SNAPSHOT_SOFT_MS && Date.now() - lastRefreshAt > UNKNOWN_SOURCE_RETRY_MS) void refreshTailnetSnapshot();
  return snapshot && age <= SNAPSHOT_HARD_MS ? snapshot : null;
}

/**
 * For the identity gate: a refresh to wait for before believing this Serve request's login, or null when
 * the cached snapshot is fresh and knows the source. Bounded (4 s), and an unknown source re-asks at most
 * every 5 s. Only the default (live) snapshot is refreshed; an injected source is used as it is.
 */
export function tailnetSnapshotWait(req: Req): Promise<void> | null {
  const source = serveSourceAddress(req);
  if (!source) return null; // refused whatever the snapshot says
  const now = Date.now();
  if (snapshot && now - snapshot.at <= SNAPSHOT_SOFT_MS && snapshot.nodeOf(source)) return null;
  if (!refreshing && now - lastRefreshAt < UNKNOWN_SOURCE_RETRY_MS) return null; // just asked: answer from what we have
  const wait = refreshTailnetSnapshot();
  return Promise.race([
    wait,
    new Promise<void>((r) => {
      const t = setTimeout(r, REFRESH_TIMEOUT_MS) as { unref?: () => void };
      t.unref?.();
    }),
  ]);
}

/** Tests only: forget the cached name and snapshot. */
export function resetOwnTailnetNameForTests() {
  tailnetName = undefined;
  priming = null;
  snapshot = undefined;
  refreshing = null;
  lastRefreshAt = -Infinity;
  statusRunner = runStatus;
  statusExes = TAILSCALE_EXES;
}

/** Tests only: the `tailscale status` the live snapshot refreshes from (null: the real CLI again). */
export function setTailnetStatusForTests(run: StatusRunner | null, exes: string[] = [process.execPath]) {
  statusRunner = run ?? runStatus;
  statusExes = run ? exes : TAILSCALE_EXES;
}

/** Tests only: make the cached snapshot (and the last refresh) this much older. */
export function ageTailnetSnapshotForTests(ms: number) {
  if (snapshot) snapshot = { ...snapshot, at: snapshot.at - ms };
  lastRefreshAt -= ms;
}

/**
 * Tests only: a synthetic tailnet where this node owns `selfIps` (id "hub-node") and every other tailnet
 * address is some other node. Simulates `tailscale status`; never used by the server.
 */
export function syntheticTailnetForTests(name: string, selfIps: string[], peers?: Record<string, string>): TailnetSource {
  const self = new Set(selfIps.map((ip) => canonicalIp(ip)).filter(Boolean) as string[]);
  const snap: TailnetSnapshot = {
    name,
    selfId: "hub-node",
    nodeOf: (ip) => {
      const c = canonicalIp(ip);
      if (!c) return null;
      if (self.has(c)) return "hub-node";
      if (peers) return peers[c] ?? null;
      return isTailnetAddress(c) ? `node-${c}` : null;
    },
    at: Date.now(),
  };
  return () => ({ ...snap, at: Date.now() });
}

/** An IP address in one canonical spelling (IPv4 dotted, IPv6 compressed lower-case, v4-mapped unwrapped), or null. */
export function canonicalIp(value: string): string | null {
  let ip = String(value ?? "").trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.includes("%")) return null;
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return null;
  try {
    const canon = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(canon);
    if (dotted) return dotted[1];
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return canon;
  } catch {
    return null;
  }
}

/** Tailscale's own address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. Only these carry a WhoIs login. */
function isTailnetAddress(ip: string) {
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return ip.startsWith("fd7a:115c:a1e0:");
}

/** The single tailnet source address Serve stamped (X-Forwarded-For), canonical; null if it isn't exactly that. */
export function serveSourceAddress(req: Req): string | null {
  const raw = req.headers?.["x-forwarded-for"];
  if (typeof raw !== "string" || !raw.trim() || raw.includes(",")) return null;
  const source = canonicalIp(raw);
  return source && isTailnetAddress(source) ? source : null;
}

export type ServeSource = { ok: true; nodeId: string } | { ok: false; why: string };

/**
 * Did this Serve-relayed request come from ANOTHER tailnet node, by stable node ID? Asked only once the
 * socket's peer is verified as tailscaled. Anything that doesn't positively name another node is refused.
 */
export function serveSourceNode(req: Req, tailnet: TailnetSource = currentTailnetSnapshot): ServeSource {
  const source = serveSourceAddress(req);
  if (!source) return { ok: false, why: "the Serve request carried no single tailnet source address" };
  const snap = tailnet();
  if (!snap || !snap.selfId) return { ok: false, why: "this PC's own tailnet node isn't known right now (tailscale status failed or is stale)" };
  const node = snap.nodeOf(source);
  if (!node) return { ok: false, why: `the tailnet source ${source} isn't a node this PC knows` };
  if (node === snap.selfId) return { ok: false, why: `the Serve request came from this PC's own tailnet node (${source}); at this PC, open Agentic OS on 127.0.0.1 instead` };
  return { ok: true, nodeId: node };
}

/** One line a minute at most; a held-back count is flushed a minute later (REVIEW-S1 N9). */
const warnServeSource = createRateLimitedWarn("[identity] Tailscale sign-in ignored:");

type Req = { socket?: { remoteAddress?: string | null }; headers?: Record<string, any> };

/**
 * The person behind a request that came through Tailscale Serve, or null.
 * All five must hold: the socket is loopback (Serve proxies from this machine), the Host
 * is this machine's own tailnet name, the Serve-stamped login belongs to someone in
 * people.json, (AUDIT-A1-3 R3b) the socket's peer really is Tailscale's daemon, and (REVIEW-S1
 * R2-1) the tailnet source it stamped is ANOTHER node, by stable node ID, never this PC's own.
 * The first three are only headers and an address, which any local program can send (the tailnet
 * name and people.json are not secret); the fourth asks the OS who owns the other end of the
 * connection (identity/serve-peer.ts); the fifth resolves the source through `tailscale status`
 * (a program on the hub reaching the hub's own Serve address carries a real login for Usman). A web
 * page can't forge the header either: it's a custom header, so a cross-origin request would need a
 * CORS preflight this server never grants. `tailnet`: the snapshot source (tests inject a synthetic one).
 */
export function tailnetPerson(
  req: Req,
  root = process.cwd(),
  expectedName = ownTailnetName(),
  viaServe: ServePeerCheck = relayedByTailscaleServe,
  tailnet: TailnetSource = currentTailnetSnapshot,
): Person | null {
  const address = req.socket?.remoteAddress ?? "";
  if (!(address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1")) return null;
  if (!expectedName) return null;
  const host = String(req.headers?.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host !== expectedName) return null;
  const login = String(req.headers?.["tailscale-user-login"] ?? "").trim().toLowerCase();
  if (!login) return null;
  if (!viaServe(req as any)) return null;
  const source = serveSourceNode(req, tailnet);
  if (!source.ok) {
    warnServeSource(source.why);
    return null;
  }
  return readPeople(root).find((person) => (person.tailscale ?? []).some((l) => l.toLowerCase() === login)) ?? null;
}

/** "Usman (owner, Telegram 8550678495)"-style lines for Jarvis's own instructions. */
export function describePeople(people: Person[]) {
  return people.map((p) => {
    const bits = [p.role, p.telegram?.length ? `Telegram ${p.telegram.join("/")}` : "", p.tailscale?.length ? `Tailscale ${p.tailscale.join("/")}` : ""].filter(Boolean);
    return `- **${p.name}**${bits.length ? ` — ${bits.join("; ")}` : ""}${p.notes ? `. ${p.notes}` : ""}`;
  });
}

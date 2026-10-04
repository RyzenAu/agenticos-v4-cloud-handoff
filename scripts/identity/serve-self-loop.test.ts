import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicesService, type DevicesService } from "../devices/service";
import { setActiveRegistry } from "../devices/registry";
import { DeviceStore } from "../devices/store";
import {
  ageTailnetSnapshotForTests,
  canonicalIp,
  currentTailnetSnapshot,
  ownTailnetName,
  primeOwnTailnetName,
  resetOwnTailnetNameForTests,
  serveSourceAddress,
  serveSourceNode,
  setTailnetStatusForTests,
  snapshotFromStatus,
  syntheticTailnetForTests,
} from "../remote-access";
import { createPrincipalGate, under } from "./gate";

/**
 * REVIEW-S1 R2-1: the Serve self-loop, reproduced SYNTHETICALLY (no real Serve URL, no Tailscale config).
 *
 * The hub PC is itself a tailnet node signed in as Usman. A program on the hub that connects to the hub's
 * own Serve address arrives through the REAL tailscaled (so the socket peer check passes) with a GENUINE
 * Tailscale-User-Login for Usman, because tailscaled's WhoIs answers for its own node too. Here a fake
 * tailscaled stands in for that: an HTTP reverse proxy that does what Serve's proxy does (strips any
 * incoming Tailscale-* and X-Forwarded-* headers, stamps the login its netmap gives the tailnet source
 * address, sets X-Forwarded-For to that source, and pools its connections to the backend like Go's
 * transport). The hub believes a socket only when its peer is that proxy (the peer-check contract), and
 * learns which node is which the production way, from a (fake) `tailscale status --json`.
 *
 * Not reproducible on loopback: the tailnet source itself. A client tells the fake proxy which tailnet
 * address it "came from" (x-sim-tailnet-src), and the bypass rows can make the proxy stamp an exact
 * X-Forwarded-For (x-sim-xff; "<none>" omits it) or login (x-sim-login). The proxy strips all three.
 *
 * On jarvis-voice 045d3f8 every self-loop row here is Usman over the tailnet (tailnet-person, pairable).
 */

const TAILNET = "hub-selfloop.tail-test.ts.net";
const RENAMED = "hub-renamed.tail-test.ts.net";
const INTERNAL = "selfloop-internal-page-token";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
/** The hub's own tailnet addresses, and other nodes. */
const HUB_V4 = "100.101.1.1";
const HUB_V6 = "fd7a:115c:a1e0::1";
const HUB_EXTRA = "100.101.1.77"; // listed under a peer entry, but with the hub's own node ID
const MEHROZ_PHONE = "100.101.2.2";
const USMAN_PHONE = "100.101.3.3";
const LATER_REASSIGNED = "100.101.6.6";
const IDS = { hub: "nHubStable1CNTRL", mehroz: "nMehrozPhoneCNTRL", usmanPhone: "nUsmanPhoneCNTRL", other: "nOtherNodeCNTRL" };
/** The fake tailscaled's netmap: WhoIs(source) → login. The hub's own node answers too, as tailscaled's does. */
const WHOIS: Record<string, string> = { [HUB_V4]: LOGIN.usman, [HUB_V6]: LOGIN.usman, [HUB_EXTRA]: LOGIN.usman, [MEHROZ_PHONE]: LOGIN.mehroz, [USMAN_PHONE]: LOGIN.usman, [LATER_REASSIGNED]: LOGIN.usman };

type Status = { name: string; selfIps: string[]; peers: { id: string; ips: string[] }[] };
const NORMAL: Status = {
  name: TAILNET,
  selfIps: [HUB_V4, HUB_V6],
  peers: [
    { id: IDS.mehroz, ips: [MEHROZ_PHONE] },
    { id: IDS.usmanPhone, ips: [USMAN_PHONE] },
    { id: IDS.other, ips: [LATER_REASSIGNED] },
    { id: IDS.hub, ips: [HUB_EXTRA] },
  ],
};
const statusJson = (s: Status) =>
  JSON.stringify({
    Self: { ID: IDS.hub, DNSName: `${s.name}.`, TailscaleIPs: s.selfIps },
    Peer: Object.fromEntries(s.peers.map((p, i) => [`nodekey:${i}`, { ID: p.id, TailscaleIPs: p.ips }])),
  });
/** What the fake `tailscale status` answers (null: it fails, like Tailscale being offline). */
let status: Status | null = NORMAL;
let statusRuns = 0;

let root: string;
let hub: Server;
let serve: Server;
let serveBase: string;
let store: DeviceStore;
let devices: DevicesService;
let savedEnvName: string | undefined;
let hadEnvName = false;
const tailscaledPorts = new Set<number>();
let backendConnections = 0;

type Mount = { path: string | null; fn: (req: IncomingMessage, res: ServerResponse, next: () => unknown) => unknown };

beforeAll(async () => {
  hadEnvName = "AGENTIC_OS_TAILNET_NAME" in process.env;
  savedEnvName = process.env.AGENTIC_OS_TAILNET_NAME;
  delete process.env.AGENTIC_OS_TAILNET_NAME;
  resetOwnTailnetNameForTests();
  const run = async () => {
    statusRuns++;
    if (!status) throw new Error("tailscale status failed (synthetic)");
    return statusJson(status);
  };
  setTailnetStatusForTests(run);
  // The hub learns who it is the production way: `tailscale status --json` at start-up (faked output).
  expect(await primeOwnTailnetName(run, [process.execPath])).toBe(TAILNET);

  root = mkdtempSync(join(tmpdir(), "serve-selfloop-"));
  mkdirSync(join(root, ".operator-data"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }),
  );
  store = new DeviceStore(root);
  // Production wiring: no tailnet name or snapshot override; only the socket-peer check is simulated
  // (the peer is the fake tailscaled).
  const servePeer = (req: { socket?: { remotePort?: number } | null }) => tailscaledPorts.has(Number(req.socket?.remotePort));
  const mounts: Mount[] = [];
  mounts.push({ path: null, fn: createPrincipalGate({ root, internalToken: () => INTERNAL, store, servePeer }) });
  devices = createDevicesService({ root, token: INTERNAL, store, servePeer });
  mounts.push({ path: "/__devices", fn: (r, s, n) => void devices.handle(r, s, n) });
  mounts.push({ path: null, fn: (_r, s) => void s.end("served") });
  hub = createServer((r, s) => {
    let i = 0;
    const original = r.url || "/";
    const next = (): unknown => {
      r.url = original;
      const m = mounts[i++];
      if (!m) return s.end();
      if (m.path === null) return m.fn(r, s, next);
      if (!under(original.split("?")[0], m.path)) return next();
      r.url = original.slice(m.path.length) || "/";
      return m.fn(r, s, next);
    };
    next();
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
  const hubPort = (hub.address() as { port: number }).port;

  // The fake tailscaled (Serve's HTTPS proxy, minus TLS): one pooled keep-alive connection to the backend.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  serve = createServer((inReq, inRes) => {
    const src = String(inReq.headers["x-sim-tailnet-src"] ?? "");
    const rawXff = inReq.headers["x-sim-xff"];
    const loginOverride = inReq.headers["x-sim-login"];
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(inReq.headers)) {
      if (v === undefined || /^(tailscale-|x-forwarded-|x-sim-)/i.test(k) || k === "connection") continue;
      headers[k] = v;
    }
    headers.host = String(inReq.headers["x-sim-host"] ?? `${ownTailnetName()}:8443`);
    const login = typeof loginOverride === "string" ? loginOverride : WHOIS[src];
    if (login) headers["tailscale-user-login"] = login;
    if (rawXff === undefined) headers["x-forwarded-for"] = src;
    else if (rawXff !== "<none>") headers["x-forwarded-for"] = String(rawXff);
    headers["x-forwarded-proto"] = "https";
    const out = httpRequest({ host: "127.0.0.1", port: hubPort, method: inReq.method, path: inReq.url, headers, agent }, (backRes) => {
      inRes.writeHead(backRes.statusCode ?? 502, backRes.headers);
      backRes.pipe(inRes);
    });
    out.on("socket", (s) => {
      const note = () => {
        if (s.localPort && !tailscaledPorts.has(s.localPort)) {
          tailscaledPorts.add(s.localPort);
          backendConnections++;
        }
      };
      if (s.localPort) note();
      else s.once("connect", note);
    });
    out.on("error", () => {
      inRes.statusCode = 502;
      inRes.end();
    });
    inReq.pipe(out);
  });
  await new Promise<void>((r) => serve.listen(0, "127.0.0.1", () => r()));
  serveBase = `http://127.0.0.1:${(serve.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  devices?.close();
  setActiveRegistry(undefined);
  for (const s of [serve, hub]) {
    s?.closeAllConnections?.();
    await new Promise<void>((r) => (s ? s.close(() => r()) : r()));
  }
  resetOwnTailnetNameForTests();
  if (hadEnvName) process.env.AGENTIC_OS_TAILNET_NAME = savedEnvName;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

let warn: typeof console.warn;
beforeEach(() => {
  status = NORMAL;
});

/** A request through the fake Serve, from the given tailnet source address. */
async function viaServe(src: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = { "x-sim-tailnet-src": src, ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(serveBase + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text, cookies: res.headers.getSetCookie() };
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  warn = console.warn;
  console.warn = () => {};
  return fn().finally(() => (console.warn = warn));
}

/** Pairs a browser through Serve and returns its principal afterwards (null when it can't pair). */
async function pairAndCheck(src: string, extra: Record<string, string> = {}) {
  const token = await viaServe(src, "GET", "/__token", { headers: extra });
  const pair = await viaServe(src, "POST", "/__devices/pair/tailnet", { body: {}, headers: { ...extra, "x-claude-os-token": String(token.json?.token ?? INTERNAL) } });
  const cookie = pair.cookies.find((c) => c.startsWith("mu_session=") && !/Max-Age=0/.test(c))?.split(";")[0];
  const me = await viaServe(src, "GET", "/__devices/me", { headers: extra, cookie });
  return { tokenStatus: token.status, pairStatus: pair.status, cookie: !!cookie, me };
}

describe("R2-1: which node a Serve request came from, by stable node ID", () => {
  test("snapshotFromStatus reads Self.ID/TailscaleIPs and every peer's; source addresses are canonical", () => {
    const snap = snapshotFromStatus(statusJson(NORMAL))!;
    expect([snap.name, snap.selfId]).toEqual([TAILNET, IDS.hub]);
    expect([HUB_V4, HUB_V6, "FD7A:115C:A1E0:0:0:0:0:1", HUB_EXTRA].map((ip) => snap.nodeOf(canonicalIp(ip)!))).toEqual([IDS.hub, IDS.hub, IDS.hub, IDS.hub]);
    expect([snap.nodeOf(MEHROZ_PHONE), snap.nodeOf("100.101.9.9")]).toEqual([IDS.mehroz, null]);
    // No node ID or no address for Self: not a snapshot at all.
    expect(snapshotFromStatus(JSON.stringify({ Self: { TailscaleIPs: [HUB_V4] } }))).toBeNull();
    expect(snapshotFromStatus(JSON.stringify({ Self: { ID: IDS.hub, TailscaleIPs: [] } }))).toBeNull();
    const src = (xff: string | undefined) => serveSourceAddress({ headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    expect([src(HUB_V4), src(`::ffff:${HUB_V4}`), src(`[${HUB_V6}]`), src(" 100.101.2.2 ")]).toEqual([HUB_V4, HUB_V4, HUB_V6, MEHROZ_PHONE]);
    for (const bad of [undefined, "", " ", `${HUB_V4}:443`, `[${HUB_V6}]:443`, `${MEHROZ_PHONE}, ${HUB_V4}`, `${HUB_V4},${MEHROZ_PHONE}`, "192.168.1.5", "127.0.0.1", "::1", `${HUB_V6}%3`, "unknown"])
      expect([bad, src(bad)]).toEqual([bad, null]);
  });

  test("serveSourceNode: only a source that is positively ANOTHER node passes; unknown fails closed", () => {
    const live = () => snapshotFromStatus(statusJson(NORMAL));
    const at = (xff: string) => serveSourceNode({ headers: { "x-forwarded-for": xff } }, live);
    expect(at(MEHROZ_PHONE)).toEqual({ ok: true, nodeId: IDS.mehroz });
    for (const self of [HUB_V4, HUB_V6, `::ffff:${HUB_V4}`, HUB_EXTRA]) expect([self, at(self).ok]).toEqual([self, false]);
    expect(at("100.101.9.9").ok).toBe(false); // a node this PC doesn't know
    expect(serveSourceNode({ headers: { "x-forwarded-for": MEHROZ_PHONE } }, () => null).ok).toBe(false); // no snapshot
    expect(serveSourceNode({ headers: {} }, live).ok).toBe(false);
  });

  test("baseline: Mehroz's phone and Usman's own phone through Serve sign in, and pair into HUMAN sessions", async () => {
    const m = await pairAndCheck(MEHROZ_PHONE);
    expect([m.pairStatus, m.cookie, m.me.json.principal]).toEqual([200, true, expect.objectContaining({ personId: "mehroz", via: "paired-session", actor: "human" })]);
    const u = await pairAndCheck(USMAN_PHONE);
    expect([u.pairStatus, u.cookie, u.me.json.principal]).toEqual([200, true, expect.objectContaining({ personId: "usman", via: "paired-session", actor: "human" })]);
  });

  test("the self-loop bypass matrix: every row gets no principal, no token, no pairing, no app", async () => {
    const rows: [string, string, Record<string, string>][] = [
      ["own IPv4", HUB_V4, {}],
      ["own IPv6", HUB_V6, {}],
      ["own IPv6, long form", HUB_V6, { "x-sim-xff": "fd7a:115c:a1e0:0:0:0:0:1" }],
      ["IPv4-mapped IPv6", HUB_V4, { "x-sim-xff": `::ffff:${HUB_V4}` }],
      ["own IPv4 with a port", HUB_V4, { "x-sim-xff": `${HUB_V4}:443` }],
      ["own IPv6 with a port", HUB_V6, { "x-sim-xff": `[${HUB_V6}]:443` }],
      ["own IP first in a chain", HUB_V4, { "x-sim-xff": `${HUB_V4}, ${MEHROZ_PHONE}` }],
      ["own IP last in a chain", HUB_V4, { "x-sim-xff": `${MEHROZ_PHONE}, ${HUB_V4}` }],
      ["no X-Forwarded-For", HUB_V4, { "x-sim-xff": "<none>" }],
      ["empty X-Forwarded-For", HUB_V4, { "x-sim-xff": "" }],
      ["upper-case login", HUB_V4, { "x-sim-login": LOGIN.usman.toUpperCase() }],
      ["another address of the hub's own node ID", HUB_EXTRA, {}],
      ["a tailnet node this PC doesn't know", "100.101.9.9", { "x-sim-login": LOGIN.usman }],
      ["not a tailnet address", "192.168.1.5", { "x-sim-login": LOGIN.usman }],
      ["loopback as the source", "127.0.0.1", { "x-sim-login": LOGIN.usman }],
    ];
    await quiet(async () => {
      for (const [label, src, extra] of rows) {
        const r = await pairAndCheck(src, extra);
        const me = r.me;
        const meRefused = me.status === 200 ? me.json.authorised === false && me.json.principal === null && me.json.canSelfPair === false : [401, 403].includes(me.status);
        expect([label, r.tokenStatus, [401, 403].includes(r.pairStatus), r.cookie, meRefused]).toEqual([label, 401, true, false, true]);
        expect([label, (await viaServe(src, "GET", "/", { headers: extra })).status]).toEqual([label, 401]);
      }
    });
    // Nothing was paired for Usman from the hub: only the two legitimate phones' sessions exist.
    expect(store.sessions().filter((s) => s.via === "tailnet").map((s) => s.personId).sort()).toEqual(["mehroz", "usman"]);
  });

  test("the verdict is per request, not per socket: Mehroz right after a self-loop request on the same pooled connection", async () => {
    await quiet(async () => {
      const before = backendConnections;
      for (let i = 0; i < 3; i++) {
        expect((await viaServe(HUB_V4, "GET", "/__token")).status).toBe(401);
        expect((await viaServe(MEHROZ_PHONE, "GET", "/__token")).json.token).toMatch(/^p1\./);
      }
      expect(backendConnections - before).toBeLessThanOrEqual(1);
    });
  });
});

describe("R2-1: a failed, stale or changed `tailscale status` never makes a remote founder", () => {
  test("status failing (Tailscale offline) with an expired snapshot: even Mehroz is refused; back when it recovers", async () => {
    status = null;
    ageTailnetSnapshotForTests(3 * 60_000);
    await quiet(async () => {
      expect((await viaServe(MEHROZ_PHONE, "GET", "/__token")).status).toBe(401);
      expect((await viaServe(HUB_V4, "GET", "/__token")).status).toBe(401);
    });
    expect(currentTailnetSnapshot()).toBeNull();
    status = NORMAL;
    ageTailnetSnapshotForTests(10_000); // past the 5 s re-ask pause
    expect((await viaServe(MEHROZ_PHONE, "GET", "/__token")).json.token).toMatch(/^p1\./);
  });

  test("a stale snapshot is refreshed before it is believed: an address reassigned to the hub is the self-loop at once", async () => {
    // In the cached snapshot LATER_REASSIGNED belongs to another node; now the hub has it.
    expect(currentTailnetSnapshot()!.nodeOf(LATER_REASSIGNED)).toBe(IDS.other);
    status = { ...NORMAL, selfIps: [HUB_V4, HUB_V6, LATER_REASSIGNED], peers: NORMAL.peers.filter((p) => p.id !== IDS.other) };
    ageTailnetSnapshotForTests(31_000); // older than the 30 s the gate trusts without asking again
    const runs = statusRuns;
    await quiet(async () => expect((await viaServe(LATER_REASSIGNED, "GET", "/__token")).status).toBe(401));
    expect(statusRuns).toBe(runs + 1);
    expect(currentTailnetSnapshot()!.nodeOf(LATER_REASSIGNED)).toBe(IDS.hub);
  });

  test("a hub rename: the new name is followed, the node ID isn't fooled, and the self-loop stays refused", async () => {
    status = { ...NORMAL, name: RENAMED };
    ageTailnetSnapshotForTests(31_000);
    // Serve now forwards with the new name; this request's wait picks the rename up.
    expect((await viaServe(MEHROZ_PHONE, "GET", "/__token", { headers: { "x-sim-host": `${RENAMED}:8443` } })).json.token).toMatch(/^p1\./);
    expect(ownTailnetName()).toBe(RENAMED);
    // The old name is no longer this PC's.
    expect((await viaServe(MEHROZ_PHONE, "GET", "/__token", { headers: { "x-sim-host": `${TAILNET}:8443` } })).status).toBe(401);
    await quiet(async () => {
      for (const host of [`${RENAMED}:8443`, `${TAILNET}:8443`]) expect([host, (await viaServe(HUB_V4, "GET", "/__token", { headers: { "x-sim-host": host } })).status]).toEqual([host, 401]);
    });
    status = NORMAL;
    ageTailnetSnapshotForTests(31_000);
    await viaServe(MEHROZ_PHONE, "GET", "/__token", { headers: { "x-sim-host": `${RENAMED}:8443` } });
    expect(ownTailnetName()).toBe(TAILNET);
  });

  test("the gate's wait is one shared refresh for a burst of requests", async () => {
    ageTailnetSnapshotForTests(31_000);
    const runs = statusRuns;
    const all = await Promise.all(Array.from({ length: 8 }, () => viaServe(MEHROZ_PHONE, "GET", "/__token")));
    expect(all.every((r) => /^p1\./.test(r.json.token))).toBe(true);
    expect(statusRuns - runs).toBe(1);
  });
});

describe("R2-1: production always uses the live snapshot", () => {
  test("neither the server's gate nor its /__devices is given a tailnet name, snapshot or peer override", () => {
    const vite = readFileSync(join(import.meta.dir, "..", "..", "vite.config.ts"), "utf8");
    const gateCall = /identityGatePlugin\(\{([^}]*)\}\)/.exec(vite)?.[1] ?? "";
    expect(gateCall).toContain("root");
    expect(gateCall).not.toMatch(/tailnet|servePeer/);
    const op = readFileSync(join(import.meta.dir, "..", "operator-plugin.ts"), "utf8");
    const devCall = /createDevicesService\(\{([^}]*)\}\)/.exec(op)?.[1] ?? "";
    expect(devCall).toContain("root");
    expect(devCall).not.toMatch(/tailnet|servePeer/);
  });

  test("the synthetic tailnet helper treats only its own addresses as the hub", () => {
    const snap = syntheticTailnetForTests(TAILNET, [HUB_V4])()!;
    expect([snap.nodeOf(HUB_V4), snap.nodeOf(`::ffff:${HUB_V4}`), snap.selfId]).toEqual(["hub-node", "hub-node", "hub-node"]);
    expect(snap.nodeOf(MEHROZ_PHONE)).not.toBe("hub-node");
    expect(snap.nodeOf("192.168.1.5")).toBeNull();
  });
});

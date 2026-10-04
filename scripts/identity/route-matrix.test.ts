import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVED_TOOLS } from "../memory/mcp-tools";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicesService, type DevicesService } from "../devices/service";
import { activeRegistry, setActiveRegistry } from "../devices/registry";
import { DeviceStore } from "../devices/store";
import { manualFinancePlugin } from "../finance/manual-plugin";
import { memoryPlugin, memoryPrincipalFrom } from "../memory/plugin";
import { operatorPlugin } from "../operator-plugin";
import { receptionistMiddleware } from "../receptionist/plugin";
import { syntheticTailnetForTests, tailnetPerson } from "../remote-access";
import { workspaceMiddleware } from "../workspace/plugin";
import { createPrincipalGate, pageTokenMatches, requestPrincipal, under } from "./gate";
import { pageTokenFor } from "./principal";
import { scanMounts } from "./mount-scan";
import { ROUTES as ROUTE_TABLE } from "./routes";

/**
 * Stage B1 route matrix: every caller against every action route, through the identity gate and
 * the REAL route handlers (operator, Claude bridge, devices, finance, memory, receptionist,
 * workspace), mounted the way connect mounts them. Synthetic people, logins and data only.
 *
 * Callers: the owner at this PC; Usman and Mehroz over Tailscale (and Mehroz with a paired
 * session); an unknown tailnet login; forged relay headers from loopback (X-Forwarded-For,
 * Tailscale-User-Login, Via, a Funnel visitor, the review's H1 repro); no identity (a DNS-rebound
 * Host); and a typed name in the body, cookie and headers.
 */

process.env.AGENTIC_OS_NO_CODEX = "1";
const TAILNET = "matrix-hub.tail-test.ts.net";
const INTERNAL = "matrix-internal-page-token";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test", stranger: "stranger@example.test" };
const TG = { usman: "1000001", mehroz: "2000002" }; // synthetic Telegram ids

let root: string;
let server: Server;
let base: string;
let store: DeviceStore;
let devices: DevicesService;
let mehrozCookie = "";
let usmanCookie = "";
const tokens: Record<string, string | null> = {};

type Mount = { path: string | null; fn: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => unknown };
const mounts: Mount[] = [];
const fakeServer = {
  middlewares: { use: (a: string | Mount["fn"], b?: Mount["fn"]) => void mounts.push(typeof a === "function" ? { path: null, fn: a } : { path: a, fn: b! }) },
  config: { server: { port: 0 } },
};

/** connect's dispatch: prefix mounts (case-insensitive, "/" "." or end), prefix stripped for the handler. */
function dispatch(req: IncomingMessage, res: ServerResponse) {
  const original = req.url || "/";
  const path = original.split("?")[0];
  let i = 0;
  const next = (): unknown => {
    req.url = original;
    const m = mounts[i++];
    if (!m) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "no route" }));
    }
    if (m.path === null) return m.fn(req, res, next);
    if (!under(path, m.path)) return next();
    const rest = original.slice(m.path.length);
    req.url = rest.startsWith("/") ? rest : `/${rest}`;
    return m.fn(req, res, next);
  };
  next();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "route-matrix-"));
  mkdirSync(join(root, ".operator-data"));
  mkdirSync(join(root, "fake-home"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({
      people: [
        { name: "Usman", role: "owner", tailscale: [LOGIN.usman], telegram: [TG.usman] },
        { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz], telegram: [TG.mehroz] },
      ],
    }),
  );
  cpSync(join(import.meta.dir, "..", "memory", "fixtures", "mini-wiki"), join(root, "wiki"), { recursive: true });
  store = new DeviceStore(root);
  mehrozCookie = store.mintSession("mehroz", "Mehroz's phone", "tailnet").cookie;
  // Remote founders are CONFIRMED sessions (acceptance #18): a bare tailnet login is a separate caller below.
  usmanCookie = store.mintSession("usman", "Usman's laptop", "tailnet").cookie;

  // 1. The identity gate, first (after the dev-restart coalescer in the real config).
  mounts.push({ path: null, fn: createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: () => true, tailnet: syntheticTailnetForTests(TAILNET, ["100.64.0.1"]) }) });
  // 2. /__devices with this test's tailnet name (shadows the operator plugin's own mount).
  devices = createDevicesService({ root, token: INTERNAL, tailnetName: TAILNET, store, servePeer: () => true, tailnet: syntheticTailnetForTests(TAILNET, ["100.64.0.1"]) });
  mounts.push({ path: "/__devices", fn: (req, res, next) => void devices.handle(req, res, next) });
  // 3. The real plugins, quiet (no schedulers, no agent launches).
  const quiet = process.env.AGENTIC_OS_NO_BACKGROUND;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    (operatorPlugin({ root, token: INTERNAL, memoryHome: join(root, "fake-home") }).configureServer as any)(fakeServer);
  } finally {
    if (quiet === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
    else process.env.AGENTIC_OS_NO_BACKGROUND = quiet;
  }
  (manualFinancePlugin({ root, token: INTERNAL }).configureServer as any)(fakeServer);
  // The memory connector (Stage D): the verified principal as provenance, the caller's own page token
  // on every POST, writes off, a TEMP copy of the synthetic vault, Hindsight not contacted.
  (memoryPlugin({
    root,
    principalFor: (req) => memoryPrincipalFrom(requestPrincipal(req as never)),
    tokenOk: (req) => pageTokenMatches(requestPrincipal(req as never), req.headers["x-claude-os-token"], INTERNAL),
    env: { MU_MEMORY_WRITES: "off", MU_WIKI_ROOT: join(root, "wiki"), MEMORY_STATE_DIR: join(root, ".operator-data", "memory"), AGENTIC_OS_NO_BACKGROUND: "1" },
  }).configureServer as any)(fakeServer);
  const receptionist = { get: async () => ({ sentence: "Synthetic receptionist status." }), getDashboard: async () => ({ synthetic: true }), refreshDashboard: async () => ({ synthetic: true }) };
  mounts.push({ path: "/__receptionist", fn: receptionistMiddleware(receptionist as any, INTERNAL, (req) => requestPrincipal(req)) as Mount["fn"] });
  const workspace = { all: async () => ({ synthetic: true }), panel: async () => ({ synthetic: true }) };
  mounts.push({ path: "/__workspace", fn: workspaceMiddleware(workspace as any, (req) => requestPrincipal(req)) as Mount["fn"] });
  // Every other REAL mount path in the app (scanned from vite.config.ts and the plugins) gets a
  // recorder in place of its handler: whatever reaches it got past the gate, and it echoes the page
  // token it received (the gate must never swap in the internal one for a remote caller).
  const real = new Set(mounts.map((m) => m.path).filter(Boolean) as string[]);
  for (const path of scanMounts(join(import.meta.dir, "..", ".."), ).keys()) {
    if (real.has(path) || path === "/__devices") continue;
    mounts.push({ path, fn: (req, res) => { res.statusCode = 200; res.end(JSON.stringify({ reached: true, token: req.headers["x-claude-os-token"] ?? null })); } });
  }
  // The app shell and Vite's source/static serving (every non-/__ path) behind the gate.
  mounts.push({ path: null, fn: (req, res, next) => ((req.url || "").startsWith("/__") ? next() : res.end(`served ${req.url}`)) });

  server = createServer((req, res) => dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  devices?.close();
  setActiveRegistry(undefined);
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a SQLite handle briefly; the OS reclaims the temp dir */
  }
});

// ------------------------------------------------------------------------------------------------
type Caller =
  | "owner"
  | "tsUsman"
  | "tsMehroz"
  | "pairedMehroz"
  | "bareUsman"
  | "bareMehroz"
  | "strangerTs"
  | "forgedXff"
  | "forgedTsLogin"
  | "forgedVia"
  | "funnel"
  | "h1Repro"
  | "noIdentity"
  | "typedName";
const VERIFIED: Caller[] = ["owner", "tsUsman", "tsMehroz", "pairedMehroz"];
const UNVERIFIED: Caller[] = ["strangerTs", "forgedXff", "forgedTsLogin", "forgedVia", "funnel", "h1Repro", "noIdentity", "typedName"];
const ALL: Caller[] = [...VERIFIED, ...UNVERIFIED];
/** A founder's Tailscale login in a browser nobody confirmed (unpaired, revoked): no shared data at all (acceptance #18). */
const BARE: Caller[] = ["bareUsman", "bareMehroz"];

function headersFor(who: Caller): Record<string, string> {
  const port = new URL(base).port;
  const serve = (login: string) => ({ host: `${TAILNET}:8443`, "tailscale-user-login": login, "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" });
  switch (who) {
    case "owner":
      return { host: `127.0.0.1:${port}` };
    case "tsUsman":
      return { ...serve(LOGIN.usman), cookie: `mu_session=${encodeURIComponent(usmanCookie)}` };
    case "tsMehroz":
      return { ...serve(LOGIN.mehroz), cookie: `mu_session=${encodeURIComponent(mehrozCookie)}` };
    case "bareUsman":
      return serve(LOGIN.usman);
    case "bareMehroz":
      return serve(LOGIN.mehroz);
    case "pairedMehroz":
      return { ...serve(LOGIN.mehroz), cookie: `mu_session=${encodeURIComponent(mehrozCookie)}` };
    case "strangerTs":
      return serve(LOGIN.stranger);
    case "forgedXff":
      return { host: "localhost:8081", "x-forwarded-for": "100.64.0.3" };
    case "forgedTsLogin":
      return { host: "localhost:8081", "tailscale-user-login": LOGIN.usman };
    case "forgedVia":
      return { host: "localhost:8081", via: "1.1 relay" };
    case "funnel":
      return { host: TAILNET, "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.5" };
    case "h1Repro":
      return { host: `${TAILNET}`, "tailscale-user-login": "nobody@evil.test", "x-forwarded-for": "100.64.0.3" };
    case "noIdentity":
      return { host: `evil.example:${port}` };
    case "typedName":
      return { ...serve(LOGIN.stranger), cookie: "mu_name=usman", "x-person": "usman", "x-user": "Usman" };
  }
}

async function call(who: Caller, method: string, path: string, body?: unknown, token?: string | null) {
  const headers: Record<string, string> = { ...headersFor(who) };
  if (body !== undefined) headers["content-type"] = "application/json";
  // An unverified caller presents the real internal token, as if it had leaked; it must not help.
  const t = token === undefined ? tokens[who] ?? INTERNAL : token;
  if (method !== "GET" && t) headers["x-claude-os-token"] = t;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const typedClaims = { by: "usman", personId: "usman", person: "usman", name: "Usman", displayName: "Usman", user: "usman" };

// ------------------------------------------------------------------------------------------------
describe("GET /__token: the internal token never reaches a remote principal", () => {
  test("matrix", async () => {
    for (const who of ALL) {
      const r = await call(who, "GET", "/__token");
      tokens[who] = r.status === 200 ? r.json.token : null;
      if (who === "owner") expect(r).toEqual({ status: 200, json: { token: INTERNAL } });
      else if (VERIFIED.includes(who)) {
        expect(r.status).toBe(200);
        expect(r.json.token).not.toBe(INTERNAL);
        expect(r.json.token).not.toContain(INTERNAL);
      } else expect([who, r.status]).toEqual([who, 401]);
    }
    expect(tokens.tsMehroz).toBe(tokens.pairedMehroz); // person-bound: pairing keeps the page's token
    expect(tokens.tsMehroz).not.toBe(tokens.tsUsman);
  });
});

/** [method, path, body, expected status per verified caller; every unverified caller expects 401]. */
const ROUTES: Array<[string, string, unknown, Partial<Record<Caller, number>>]> = [
  // C1: delegated agents run on the hub's own Claude/Codex logins, so every agent-jobs path is the
  // hub owner's at the gate, reads included. (Bad request id: nothing launches.)
  ["GET", "/__operator/agent-jobs", undefined, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__operator/agent-jobs", { requestId: "x", prompt: "synthetic", targets: ["codex"], workflow: "improve-os" }, { owner: 400, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__operator/agent-jobs", { requestId: "x", prompt: "synthetic", targets: ["codex"], workflow: "build" }, { owner: 400, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  // Screen control: the owner at this PC only. (No goal: nothing is touched.)
  ["POST", "/__operator/screen/act", {}, { owner: 400, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__operator/open-url", { url: "notaurl" }, { owner: 400, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__operator/voice/free/configure", { tts: "groq" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["GET", "/__claude/v1/models", undefined, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["GET", "/__finance_manual/status", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__memory/buckets", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__memory/approvals", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__receptionist/", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__receptionist/dashboard", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__workspace", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__hermes_status", undefined, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  // W-C: Hermes customisation (skills sync, owner profile) is the owner at this PC only.
  ["GET", "/__hermes_owner_profile", undefined, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__hermes_skill_sync", { dryRun: true }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["GET", "/__version", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/__ai_usage", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["POST", "/__ai_usage/settings", {}, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  // REVIEW-B1 B1-1: the executor and approval routes. B1-2: hub config and keys. Remote founders are
  // refused at the gate even with their own valid page token.
  ["POST", "/__claude_chat", { prompt: "synthetic" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__hermes_chat", { prompt: "synthetic" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__trigger_dream", {}, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__permission_decision", { id: "x", decision: "always" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__question_answer", { id: "x" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__start_voice", { key: "synthetic" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__design_set_key", { key: "synthetic" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__hermes_cmd", { cmd: "update" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__graphify_ingest", { path: "C:/" }, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["GET", "/__memory_note", undefined, { owner: 200, tsUsman: 403, tsMehroz: 403, pairedMehroz: 403 }],
  ["POST", "/__design_cost", {}, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
  ["GET", "/", undefined, { owner: 200, tsUsman: 200, tsMehroz: 200, pairedMehroz: 200 }],
];

describe("route matrix: verified callers get their answer; everyone else gets 401", () => {
  for (const [method, path, body, verified] of ROUTES) {
    test(`${method} ${path}`, async () => {
      for (const who of ALL) {
        const b = who === "typedName" && body && typeof body === "object" ? { ...(body as object), ...typedClaims } : body;
        const r = await call(who, method, path, b);
        const want = VERIFIED.includes(who) ? verified[who] ?? 404 : 401;
        expect([who, r.status]).toEqual([who, want]);
      }
      // A bare tailnet login reaches no /__ route except the data-free status ones; the app shell still loads (to show "Confirm this browser").
      const open = !path.startsWith("/__") || /^\/__(version|health)\b/.test(path);
      for (const who of BARE) {
        const r = await call(who, method, path, body);
        expect([who, r.status]).toEqual([who, open ? verified.tsMehroz ?? 404 : 403]);
        if (!open && verified.tsMehroz !== 403) expect(String(r.json?.error ?? "")).toContain("Confirm this browser first");
      }
    });
  }
});

describe("who the request is: from the principal, never from the body", () => {
  test("finance and memory see the verified person (L4: one person-id rule)", async () => {
    // Finance is ONE shared business ledger (V7); the verified person is the actor (provenance only).
    expect((await call("owner", "GET", "/__finance_manual/status")).json).toMatchObject({ ledger: "shared", actor: "usman" });
    expect((await call("tsMehroz", "GET", "/__finance_manual/status")).json).toMatchObject({ ledger: "shared", actor: "mehroz" });
    // One shared pool (V7): the person is provenance ("saved by"), shown as the verified name.
    expect((await call("tsMehroz", "GET", "/__memory/buckets")).json).toMatchObject({ writes: "off" }); // L2
    expect((await call("tsMehroz", "GET", "/__memory/status")).json.principal).toMatchObject({ name: "Mehroz" });
    expect((await call("owner", "GET", "/__memory/status")).json.principal).toMatchObject({ name: "Usman", via: "local" });
  });

  test("a remote principal's activity is logged as them, whatever `by` says", async () => {
    const m = await call("tsMehroz", "POST", "/__operator/leads/goal", { by: "usman", calls: 3 });
    expect(m).toMatchObject({ status: 200, json: { by: "mehroz" } });
    // At this PC the owner's own "log as" choice stands (one shared machine).
    expect((await call("owner", "POST", "/__operator/leads/goal", { by: "mehroz", calls: 2 })).json.by).toBe("mehroz");
  });

  test("quote workbooks: only a confirmed human session writes, and the author is the verified person", async () => {
    const { seedDeals } = await import("../../src/lib/deal-desk/deal");
    const deal = seedDeals()[0];
    const save = (who: Caller, baseRev: number, by?: string) => call(who, "POST", "/__operator/leads/deal-desk/save", { deal, baseRev, by });
    // A confirmed remote session: saved, and credited to the signer whatever `by` claims.
    const paired = await save("pairedMehroz", 0, "usman");
    expect([paired.status, paired.json.record?.updatedBy, paired.json.record?.rev]).toEqual([200, "mehroz", 1]);
    // A bare Tailscale login (a process, not a confirmed person) cannot write a workbook.
    const bare = await save("bareMehroz", 1);
    expect(bare.status).toBe(403);
    expect(String(bare.json.error)).toContain("Confirm this browser first");
    for (const path of ["archive", "link", "attach"]) expect((await call("bareUsman", "POST", `/__operator/leads/deal-desk/${path}`, { id: deal.id, baseRev: 1, crmDealRef: null, lead: 1 })).status).toBe(403);
    // At this PC a caller without a confirmed browser session is a program (it may hold the page token): refused, like an owner decision.
    expect((await save("owner", 1, "mehroz")).status).toBe(403);
    // A stale revision is refused with the current record, so nothing is overwritten.
    const stale = await save("pairedMehroz", 0);
    expect([stale.status, stale.json.current?.rev, stale.json.current?.updatedBy]).toEqual([409, 1, "mehroz"]);
    expect((await save("pairedMehroz", 1)).json.record?.rev).toBe(2);
    // Reading the list is open to both founders; nobody unverified gets in.
    expect((await call("tsMehroz", "GET", "/__operator/leads/deal-desk/list")).status).toBe(200);
    for (const who of BARE) expect([who, (await call(who, "GET", "/__operator/leads/deal-desk/list")).status]).toEqual([who, 403]);
    for (const who of UNVERIFIED) expect([who, (await save(who, 2)).status >= 401]).toEqual([who, true]);
  });

  test("quote workbooks: reading a quote body needs a confirmed human session; others get names and dates and a withheld flag", async () => {
    const { seedDeals } = await import("../../src/lib/deal-desk/deal");
    const deal = { ...seedDeals()[0], id: "withheld-read-1", name: "SECRET quote name" };
    const saved = await call("pairedMehroz", "POST", "/__operator/leads/deal-desk/save", { deal, baseRev: 0 });
    expect(saved.status).toBe(200);
    // A confirmed founder gets the whole workbook.
    const full = await call("pairedMehroz", "GET", "/__operator/leads/deal-desk/get?id=withheld-read-1");
    expect([full.status, full.json.deal?.id, full.json.withheld]).toEqual([200, "withheld-read-1", undefined]);
    const fullList = await call("pairedMehroz", "GET", "/__operator/leads/deal-desk/list");
    expect(fullList.json.deals.find((d: any) => d.id === "withheld-read-1")).toMatchObject({ status: "ready", leadId: null });
    // A bare tailnet login (an unconfirmed browser) is refused at the gate (acceptance #18), so it reads not even the metadata.
    for (const who of BARE) {
      const one = await call(who, "GET", "/__operator/leads/deal-desk/get?id=withheld-read-1");
      expect([who, one.status, JSON.stringify(one.json).includes("SECRET")]).toEqual([who, 403, false]);
    }
    // A program at this PC (no confirmed browser session) gets no bodies, only metadata.
    for (const who of ["owner"] as const) {
      const one = await call(who, "GET", "/__operator/leads/deal-desk/get?id=withheld-read-1");
      expect([who, one.status, one.json.withheld, one.json.deal, one.json.draft]).toEqual([who, 200, true, undefined, undefined]);
      expect(Object.keys(one.json).sort()).toEqual(["archived", "id", "name", "rev", "status", "updatedAt", "updatedBy", "withheld"]);
      expect(JSON.stringify(one.json)).not.toContain("scenarios");
      const list = await call(who, "GET", "/__operator/leads/deal-desk/list");
      const row = list.json.deals.find((d: any) => d.id === "withheld-read-1");
      expect([who, list.status, row?.withheld, row?.name, row?.updatedBy]).toEqual([who, 200, true, "SECRET quote name", "mehroz"]);
      expect(row).not.toHaveProperty("problem");
      expect(row).not.toHaveProperty("leadId");
    }
    // Nobody unverified gets in at all.
    for (const who of UNVERIFIED) expect([who, (await call(who, "GET", "/__operator/leads/deal-desk/get?id=withheld-read-1")).status >= 401]).toEqual([who, true]);
  });

  test("the devices view shows the signed-in person's display name", async () => {
    expect((await call("owner", "GET", "/__devices/me")).json).toMatchObject({ authorised: true, principal: { personId: "usman", displayName: "Usman", via: "loopback-owner" } });
    expect((await call("tsMehroz", "GET", "/__devices/me")).json).toMatchObject({ authorised: true, principal: { personId: "mehroz", displayName: "Mehroz", via: "paired-session" } });
    expect((await call("bareMehroz", "GET", "/__devices/me")).json).toMatchObject({ principal: { personId: "mehroz", displayName: "Mehroz", via: "tailnet-person" } });
    expect((await call("pairedMehroz", "GET", "/__devices/me")).json).toMatchObject({ authorised: true, principal: { via: "paired-session" } });
    // M4: Via / X-Forwarded-For with Host: localhost is not the owner at this PC.
    for (const who of ["forgedXff", "forgedVia", "forgedTsLogin", "strangerTs"] as const) expect((await call(who, "GET", "/__devices/me")).status).toBe(403);
  });
});

describe("page tokens and CSRF", () => {
  // Reconciled from codex/b1-jobs-route (46ade21): the classification is live (routes.ts), this pins it at
  // the gate. /__jobs and /__approvals are scanned from B2's regex middleware and reach a recorder here.
  test("B2's shared /__jobs and /__approvals pass the gate for either founder, only with their own token", async () => {
    for (const path of ["/__jobs", "/__approvals"]) {
      expect((await call("owner", "GET", path)).status).toBe(200);
      expect((await call("tsMehroz", "GET", path)).status).toBe(200);
      expect((await call("pairedMehroz", "GET", path)).status).toBe(200);
      for (const who of UNVERIFIED) expect((await call(who, "GET", path)).status).toBe(401);
      expect((await call("tsMehroz", "POST", path, {}, tokens.tsMehroz)).json.token).toBe(tokens.tsMehroz);
      expect((await call("tsMehroz", "POST", path, {}, INTERNAL)).json.token).toBeNull();
    }
  });

  test("a remote founder's token is never swapped for the internal one (REVIEW-B1 B1-1)", async () => {
    // /__design_cost is a shared write whose recorder echoes the token that reached it.
    const own = await call("tsMehroz", "POST", "/__design_cost", {}, tokens.tsMehroz);
    expect(own).toEqual({ status: 200, json: { reached: true, token: tokens.tsMehroz } });
    const leaked = await call("tsMehroz", "POST", "/__design_cost", {}, INTERNAL);
    expect(leaked.json.token).toBeNull(); // the internal token is removed, never passed on
    expect((await call("owner", "POST", "/__design_cost", {}, INTERNAL)).json.token).toBe(INTERNAL);
    expect(tokens.tsMehroz).toBe(pageTokenFor({ personId: "mehroz", via: "paired-session" }, INTERNAL));
  });

  test("a remote principal's own token works; the raw internal token from the tailnet is stripped", async () => {
    expect((await call("tsMehroz", "POST", "/__operator/leads/goal", { by: "mehroz", calls: 1 }, tokens.tsMehroz)).status).toBe(200);
    const leaked = await call("tsMehroz", "POST", "/__operator/leads/goal", { by: "mehroz", calls: 1 }, INTERNAL);
    expect(leaked).toMatchObject({ status: 403, json: { error: "Refresh this page and try again." } });
    // Another person's token doesn't work either.
    expect((await call("tsMehroz", "POST", "/__operator/leads/goal", { calls: 1 }, tokens.tsUsman)).status).toBe(403);
  });

  test("M2: memory mutations need the page token", async () => {
    const save = { text: "Synthetic matrix note.", bucket: "business" };
    for (const [path, body] of [
      ["/__memory/remember", save],
      ["/__memory/vault/save", save],
      ["/__memory/correct", { id: "mf-00000000a1", text: "x" }],
      ["/__memory/forget", { kind: "unindex", target: "n-proposal-terms" }],
      ["/__memory/approvals/grant", { approval_id: "apr-0000000000000000" }],
      ["/__memory/recall", { query: "anything" }],
    ] as const) {
      // From the app's own page (a browser: its own Origin and Sec-Fetch-Site) with no token.
      const own = headersFor("owner");
      const res = await fetch(base + path, {
        method: "POST",
        headers: { ...own, origin: `http://${own.host}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect([path, res.status]).toEqual([path, 403]);
    }
    // An agent process (no browser markers) gets no token-less path to forget, correct or grant.
    for (const path of ["/__memory/forget", "/__memory/correct", "/__memory/approvals/grant"] as const)
      expect([path, (await call("owner", "POST", path, {}, null)).status]).toEqual([path, 403]);
    expect((await call("tsMehroz", "POST", "/__memory/remember", save, INTERNAL)).status).toBe(403);
    // With the caller's own token the request reaches memory (writes are off here, so it is refused as such).
    expect((await call("owner", "POST", "/__memory/remember", save)).json).toMatchObject({ code: "writes-disabled" });
    expect((await call("tsMehroz", "POST", "/__memory/remember", save)).json).toMatchObject({ code: "writes-disabled" });
  });

  test("REVIEW-STAGE-D B1: another localhost origin can't read memory, write it, or get the page token", async () => {
    const other = { origin: "http://localhost:5173", "sec-fetch-site": "same-site" };
    for (const [method, path, body] of [
      ["GET", "/__token", undefined],
      ["GET", "/__memory/items", undefined],
      ["GET", "/__memory/status", undefined],
      ["POST", "/__memory/remember", { text: "Cross-origin synthetic note." }],
      ["POST", "/__memory/forget", { kind: "unindex", target: "n-proposal-terms" }],
      ["POST", "/__memory/approvals/grant", { approval_id: "apr-0000000000000000" }],
    ] as const) {
      // The page token itself would be valid: the origin alone decides.
      const res = await fetch(base + path, {
        method,
        headers: { ...headersFor("owner"), ...other, ...(body ? { "content-type": "application/json", "x-claude-os-token": INTERNAL } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect([path, res.status, res.headers.get("access-control-allow-origin")]).toEqual([path, 403, null]);
    }
    // Without Sec-Fetch-Site (an old browser, a script) a foreign Origin is refused too.
    const plainOrigin = await fetch(base + "/__memory/items", { headers: { ...headersFor("owner"), origin: "http://localhost:5173" } });
    expect(plainOrigin.status).toBe(403);
    // The app's own origin still works.
    expect((await fetch(base + "/__memory/items", { headers: { ...headersFor("owner"), origin: `http://${headersFor("owner").host}`, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  test("REVIEW-STAGE-D B3: an agent process at this PC saves through /__memory/mcp; a browser origin can't", async () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const agent = await fetch(base + "/__memory/mcp", { method: "POST", headers: { ...headersFor("owner"), "content-type": "application/json" }, body: rpc });
    expect(agent.status).toBe(200);
    expect((await agent.json()).result.tools.map((t: { name: string }) => t.name)).toEqual([...SERVED_TOOLS]); // the four memory tools, then the read-only ones (L7)
    const page = await fetch(base + "/__memory/mcp", { method: "POST", headers: { ...headersFor("owner"), "content-type": "application/json", origin: "http://localhost:5173", "sec-fetch-site": "same-site" }, body: rpc });
    expect(page.status).toBe(403);
    // Remote callers have no agent path: a tailnet process still needs its page token.
    const remote = await fetch(base + "/__memory/mcp", { method: "POST", headers: { ...headersFor("tsMehroz"), "content-type": "application/json" }, body: rpc });
    expect(remote.status).toBe(403);
    // Forget is never token-less.
    const forget = await fetch(base + "/__memory/forget", { method: "POST", headers: { ...headersFor("owner"), "content-type": "application/json" }, body: JSON.stringify({ kind: "unindex", target: "n-proposal-terms" }) });
    expect(forget.status).toBe(403);
  });

  test("L1: bad JSON to memory is 400, not 500", async () => {
    const res = await fetch(base + "/__memory/recall", { method: "POST", headers: { ...headersFor("owner"), "content-type": "application/json", "x-claude-os-token": INTERNAL }, body: "{not json" });
    expect(res.status).toBe(400);
  });
});

describe("Stage A review repros (regressions)", () => {
  test("H1: the receptionist refuses an unknown login, a Funnel visitor and a bare tailnet Host", async () => {
    for (const path of ["/__receptionist/", "/__receptionist/ask", "/__receptionist/dashboard"]) {
      expect((await call("h1Repro", "GET", path)).status).toBe(401);
      expect((await call("funnel", "GET", path)).status).toBe(401);
      const bare = await fetch(base + path, { headers: { host: TAILNET, "x-forwarded-for": "100.64.0.3" } });
      expect(bare.status).toBe(401);
    }
    expect((await call("h1Repro", "POST", "/__receptionist/dashboard/refresh", {})).status).toBe(401);
  });

  test("M1: Host: localhost plus a Mehroz login writes nothing to memory as Usman", async () => {
    const r = await call("forgedTsLogin", "POST", "/__memory/remember", { text: "Forged synthetic note." }, INTERNAL);
    expect(r.status).toBe(401);
    const forged = await fetch(base + "/__memory/remember", {
      method: "POST",
      headers: { host: "localhost:8081", "tailscale-user-login": LOGIN.mehroz, "content-type": "application/json", "x-claude-os-token": INTERNAL },
      body: JSON.stringify({ text: "Forged synthetic note." }),
    });
    expect(forged.status).toBe(401);
    for (const path of ["/__finance_manual/status", "/__workspace", "/__receptionist/"]) {
      expect((await call("forgedXff", "GET", path)).status).toBe(401);
      expect((await call("forgedTsLogin", "GET", path)).status).toBe(401);
    }
  });

  test("M4: Via, X-Forwarded-* and X-Real-IP are relay markers everywhere", async () => {
    for (const relay of [{ via: "1.1 x" }, { "x-forwarded-proto": "https" }, { "x-real-ip": "100.64.0.3" }, { forwarded: "for=100.64.0.3" }]) {
      for (const path of ["/__token", "/__graphify_list", "/__version", "/__devices/me"]) {
        const r = await fetch(base + path, { headers: { host: "localhost:8081", ...relay } });
        expect([path, Object.keys(relay)[0], r.status]).toEqual([path, Object.keys(relay)[0], path === "/__devices/me" ? 403 : 401]);
      }
    }
  });

  test("M4: the Hermes gateway relay (/__away) treats every relay marker as not-this-PC", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(base + "/__away/telegram", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-the-relay-token", ...headers }, body: "{}" });
    for (const relay of [{ via: "1.1 x" }, { "x-forwarded-for": "100.64.0.3" }, { "x-real-ip": "100.64.0.3" }, { "tailscale-user-login": LOGIN.usman }])
      expect((await post({ host: "localhost:8081", ...relay })).status).toBe(403);
    expect((await post({ host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN.usman })).status).toBe(403);
    // At this PC the bearer is the proof; a wrong one is refused.
    expect((await post(headersFor("owner"))).status).toBe(401);
  });

  test("L3: pending deletions need a principal", async () => {
    expect((await call("forgedXff", "GET", "/__memory/approvals")).status).toBe(401);
    expect((await call("owner", "GET", "/__memory/approvals")).status).toBe(200);
  });

  test("L5: an empty Host is refused", async () => {
    // HTTP clients fill Host in themselves; write the request by hand to send an empty one.
    const { connect } = await import("node:net");
    const head = await new Promise<string>((resolve, reject) => {
      const raw = ["GET /__token HTTP/1.1", "Host: ", "Connection: close", "", ""].join("\r\n");
      const socket = connect(Number(new URL(base).port), "127.0.0.1", () => socket.write(raw));
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    const status = Number(head.split(" ")[1]);
    // 401 from the gate, or 400 if the HTTP layer rejects the empty Host first; never the token.
    expect([400, 401]).toContain(status);
    expect(head).not.toContain(INTERNAL);
  });
});

describe("device control routes to the requester's own device", () => {
  test("Mehroz with no device: refused with resolveTarget's reason; the hub is never the fallback", async () => {
    for (const who of ["tsMehroz", "pairedMehroz"] as const) {
      const r = await call(who, "POST", "/__operator/screen/act", { goal: "click the synthetic button" });
      expect(r.status).toBe(403);
      expect(r.json.error).toContain("no device registered for mehroz");
      expect(r.json.error).toContain("Nothing ran on Usman's PC");
    }
    const spoken = await call("tsMehroz", "POST", "/__operator/voice/free/turn", { messages: [{ role: "user", content: "away mode on" }] });
    expect(spoken.status).toBe(200);
    expect(spoken.json.model).toBe("rules");
    expect(spoken.json.content).toContain("no device registered for mehroz");
  });

  test("Mehroz with his own companion online: the command is his device's, never run on the hub", async () => {
    const { device } = store.registerCompanion("mehroz", { label: "Mehroz's laptop", aliases: ["laptop"] });
    activeRegistry().heartbeat(device.id);
    const r = await call("tsMehroz", "POST", "/__operator/screen/act", { goal: "click the synthetic button" });
    expect(r.status).toBe(403);
    expect(r.json.error).toContain(device.id);
    expect(r.json.error).toContain("not Usman's PC");
    // Asking for Usman's PC by name is refused too.
    const agent = await call("tsMehroz", "POST", "/__operator/agent-jobs", { requestId: "x", prompt: "synthetic", targets: ["codex"], workflow: "improve-os" });
    expect(agent.status).toBe(403);
    store.revokeCompanion(device.id);
  });

  test("Usman away from the PC: his own device, but screen actions need him at it", async () => {
    const r = await call("tsUsman", "POST", "/__operator/screen/act", { goal: "click the synthetic button" });
    expect(r.status).toBe(403);
    expect(r.json.error).toContain("someone at the PC");
    const away = await call("tsUsman", "POST", "/__operator/voice/free/turn", { messages: [{ role: "user", content: "away mode on" }] });
    expect(away.json.content).toContain("someone at the PC");
  });
});

describe("B2 conditions: the session key is cookie-only; human vs process is on the Principal", () => {
  test("a page navigation at this PC mints an HttpOnly, SameSite=Strict hub session; API calls and processes don't", async () => {
    const nav = await fetch(base + "/", { headers: { ...headersFor("owner"), "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
    const set = nav.headers.getSetCookie().find((c) => c.startsWith("mu_session="))!;
    expect(set).toBeDefined();
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    // A fetch or a script's GET mints nothing.
    for (const h of [{}, { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }])
      expect((await fetch(base + "/", { headers: { ...headersFor("owner"), ...h } })).headers.getSetCookie().some((c) => c.startsWith("mu_session="))).toBe(false);
    expect((await fetch(base + "/__token", { headers: { ...headersFor("owner"), "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } })).headers.getSetCookie()).toEqual([]);

    const cookie = set.split(";")[0];
    const human = { ...headersFor("owner"), cookie };
    const me = await (await fetch(base + "/__devices/me", { headers: human })).json();
    expect(me.principal).toEqual({ personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" });
    expect((await (await fetch(base + "/__devices/me", { headers: headersFor("owner") })).json()).principal.actor).toBe("process");

    // The server-only key never appears in /__token, /me, /sessions or any other JSON.
    const secret = decodeURIComponent(cookie.slice("mu_session=".length));
    const row = store.sessions("usman").find((s) => s.via === "hub" && !s.revokedAt && secret.length > 0)!;
    const key = store.sessionKey(row.id);
    for (const path of ["/__token", "/__devices/me", "/__devices/sessions", "/__operator/agent-jobs", "/__memory/buckets"]) {
      const text = await (await fetch(base + path, { headers: human })).text();
      expect([path, text.includes(key), text.includes(secret)]).toEqual([path, false, false]);
    }
  });

  test("a paired remote session's cookie is Secure over Serve, and only a human session carries a session key", async () => {
    const pair = await fetch(base + "/__devices/pair/tailnet", {
      method: "POST",
      headers: { ...headersFor("bareUsman"), "content-type": "application/json", "x-claude-os-token": tokens.tsUsman ?? "" },
      body: JSON.stringify({ label: "Usman's phone" }),
    });
    expect(pair.status).toBe(200);
    const set = pair.headers.getSetCookie().find((c) => c.startsWith("mu_session="))!;
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure"]) expect(set).toContain(flag);
    const me = await (await fetch(base + "/__devices/me", { headers: { ...headersFor("bareUsman"), cookie: set.split(";")[0] } })).json();
    expect(me.principal).toMatchObject({ via: "paired-session", actor: "human" });
    expect(JSON.stringify(me)).not.toContain("sk1.");
  });
});

describe("T3c: /__operator/agent-jobs through the real gate can't start Codex or Claude", () => {
  const task = { requestId: "7c1d9e20-5a4b-4c3d-8e2f-1a2b3c4d5e6f", prompt: "fix the login bug in the dental site", targets: ["codex"] };
  test("a page-token-only POST (a program at this PC, e.g. Hermes) gets a coding draft; no run exists afterwards", async () => {
    expect((await (await fetch(base + "/__devices/me", { headers: headersFor("owner") })).json()).principal.actor).toBe("process");
    const r = await call("owner", "POST", "/__operator/agent-jobs", task);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ started: false });
    expect(r.json.draft.path).toStartWith("/coding?request=");
    expect(r.json.job).toBeUndefined();
    const list = await call("owner", "GET", "/__operator/agent-jobs");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(task.requestId);
  });
  test("a page-token-only program can't run the check, answer an agent or stop one", async () => {
    for (const path of ["/__operator/agent-jobs/check", "/__operator/agent-jobs/respond", "/__operator/agent-jobs/cancel"]) {
      const r = await call("owner", "POST", path, { requestId: task.requestId, targets: ["codex"] });
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.json.error).toContain("signed in");
    }
    // A signed-in person passes this check (agent-jobs-route.test.ts); which navigation becomes a human
    // session depends on the PC's trusted sessions (AUDIT-A1-3), so it isn't exercised here.
  });
});

describe("every real mount at the gate (REVIEW-B1 B1-1/B1-2, no stand-ins)", () => {
  test("remote founders reach exactly the shared routes; the owner at the PC reaches all; strangers none", async () => {
    const table = Object.entries(ROUTE_TABLE).filter(([p, r]) => r.read !== "self" && !r.expectedFrom && !r.within && !["/__operator", "/__receptionist", "/__workspace", "/__memory", "/__finance_manual", "/__ai_usage", "/__claude", "/__cline", "/__jev", "/__computers", "/__events", "/__agents"].includes(p));
    expect(table.length).toBeGreaterThan(90);
    for (const [path, rule] of table) {
      for (const method of ["GET", "POST"] as const) {
        const cls = method === "GET" ? rule.read : rule.write;
        const body = method === "POST" ? {} : undefined;
        expect([path, method, "owner", (await call("owner", method, path, body)).status]).toEqual([path, method, "owner", 200]);
        const remote = (await call("tsMehroz", method, path, body)).status;
        expect([path, method, "tsMehroz", remote]).toEqual([path, method, "tsMehroz", cls === "shared" ? 200 : 403]);
        expect([path, method, "tsUsman", (await call("tsUsman", method, path, body)).status]).toEqual([path, method, "tsUsman", cls === "shared" ? 200 : 403]);
        expect([path, method, "strangerTs", (await call("strangerTs", method, path, body)).status]).toEqual([path, method, "strangerTs", 401]);
      }
    }
  }, 120_000);

  test("/__events (a stream that never ends) at the real gate: verified founders get an SSE stream; everyone else is refused; no writes", async () => {
    // Read only the status and headers, then hang up: the body never finishes by design.
    const open = async (who: Caller, method = "GET") => {
      const ctl = new AbortController();
      const res = await fetch(base + "/__events", { method, headers: headersFor(who), signal: ctl.signal });
      const out = { status: res.status, type: res.headers.get("content-type") ?? "" };
      ctl.abort();
      return out;
    };
    for (const who of VERIFIED) expect([who, await open(who)]).toEqual([who, { status: 200, type: "text/event-stream; charset=utf-8" }]);
    for (const who of UNVERIFIED) expect([who, [401, 403].includes((await open(who)).status)]).toEqual([who, true]);
    for (const who of ["owner", "tsMehroz"] as const) expect([who, (await open(who, "POST")).status === 200]).toEqual([who, false]);
  });

  test("a shell on the hub can't be had: the _variant of /__claude is not under the /__claude rule's exceptions", async () => {
    for (const p of ["/__claude_chat", "/__claude_attach", "/__claude_abort_all", "/__claude_session", "/__claude_file"])
      expect((await call("pairedMehroz", "POST", p, {})).status).toBe(403);
  });
});

describe("B1-3: away mode from the OS card", () => {
  test("Usman over Tailscale can stop away mode; Mehroz can't change it", async () => {
    const usman = await call("tsUsman", "POST", "/__operator/away", { action: "stop" });
    expect(usman.status).not.toBe(403);
    expect(JSON.stringify(usman.json)).not.toContain("Only Usman");
    const mehroz = await call("tsMehroz", "POST", "/__operator/away", { action: "stop" });
    expect(mehroz.status).toBe(403);
    expect((await call("owner", "POST", "/__operator/away", { action: "stop" })).status).not.toBe(403);
  });
});

describe("H-1: no other origin can read the token or send a write", () => {
  const owner = () => headersFor("owner");
  test("another localhost port gets nothing (Origin or Sec-Fetch-Site), and no CORS header is ever sent", async () => {
    for (const extra of [{ origin: "http://localhost:3000" }, { origin: "http://127.0.0.1:8091" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }]) {
      const r = await fetch(base + "/__token", { headers: { ...owner(), ...extra } });
      expect([JSON.stringify(extra), r.status]).toEqual([JSON.stringify(extra), 403]);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(await r.text()).not.toContain(INTERNAL);
      const w = await fetch(base + "/__operator/leads/goal", { method: "POST", headers: { ...owner(), ...extra, "content-type": "application/json", "x-claude-os-token": INTERNAL }, body: JSON.stringify({ by: "usman", calls: 1 }) });
      expect(w.status).toBe(403);
      const pre = await fetch(base + "/__claude_chat", { method: "OPTIONS", headers: { ...owner(), ...extra, "access-control-request-method": "POST", "access-control-request-headers": "x-claude-os-token" } });
      expect(pre.status).toBe(403);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  test("the app's own origin still works, at the PC and over Serve", async () => {
    const port = new URL(base).port;
    expect((await fetch(base + "/__token", { headers: { ...owner(), origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect((await fetch(base + "/__token", { headers: { ...headersFor("tsMehroz"), origin: `https://${TAILNET}:8443`, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });
});

describe("H-2: a login with no principal gets the pairing page, never the app's files", () => {
  test("revoked session and 'require a code' can't read live-data.json, vite.config.ts or source", async () => {
    const { cookie, session } = store.mintSession("mehroz", "Lost laptop", "tailnet");
    store.revokeSession(session.id);
    const dead = { ...headersFor("tsMehroz"), cookie: `mu_session=${encodeURIComponent(cookie)}` };
    for (const path of ["/src/data/live-data.json", "/vite.config.ts", "/package.json", "/AGENTS.md", "/src/main.tsx", "/", "/@fs/C:/anything"]) {
      const r = await fetch(base + path, { headers: dead });
      const text = await r.text();
      expect([path, r.status, r.headers.get("content-type")]).toEqual([path, 200, "text/html; charset=utf-8"]);
      expect(text).toContain("Pair this device");
      expect(text).not.toContain("served ");
    }
    expect((await fetch(base + "/src/data/live-data.json", { method: "POST", headers: dead })).status).toBe(401);
    // It can still pair again (its pairing-only token), which is the point of the page.
    const t = await (await fetch(base + "/__token", { headers: dead })).json();
    expect(t.scope).toBe("pairing");
    // A verified founder is served the app; a stranger gets 401.
    expect(await (await fetch(base + "/src/data/live-data.json", { headers: headersFor("tsMehroz") })).text()).toBe("served /src/data/live-data.json");
    expect((await fetch(base + "/src/data/live-data.json", { headers: headersFor("strangerTs") })).status).toBe(401);
  });
});

describe("R2: non-canonical request targets are refused before anything else (dot segments etc.)", () => {
  /** A raw HTTP/1.1 request: no client normalises the target. */
  async function rawStatus(target: string, headers: Record<string, string>, method = "GET") {
    const { connect } = await import("node:net");
    const lines = [`${method} ${target} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "Connection: close"];
    if (method !== "GET") lines.push("Content-Type: application/json", "Content-Length: 2");
    const raw = lines.join("\r\n") + "\r\n\r\n" + (method !== "GET" ? "{}" : "");
    const head = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(base).port), "127.0.0.1", () => socket.write(raw));
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    return { status: Number(head.split(" ")[1]), head };
  }

  const tricks = [
    "/x/../__jobs",
    "/x/../__claude_chat",
    "/./__claude_chat",
    "/__operator/../__claude_chat",
    "/__devices/../__claude_chat",
    "/__jobs/./abc",
    "//__claude_chat",
    "/__operator//leads",
    "/%2e%2e/__claude_chat",
    "/__devices/%2E%2E/__claude_chat",
    "/__devices%2f..%2f__claude_chat",
    "/__devices%5c..%5c__claude_chat",
    "/__devices/%252e%252e/__claude_chat",
    "/__devices\x5c..\x5c__claude_chat", // literal backslashes
    "/__claude_chat\x5c",
    "/src/../vite.config.ts",
    "/src/data/./live-data.json",
    "http://matrix-hub.tail-test.ts.net/__claude_chat",
    "http://127.0.0.1/__claude_chat",
  ];

  test("every trick gets 400 from every caller, the owner included, for GET and POST", async () => {
    for (const target of tricks)
      for (const who of ["owner", "tsMehroz", "pairedMehroz", "strangerTs"] as const)
        for (const method of ["GET", "POST"]) {
          const h: Record<string, string> = { ...headersFor(who) };
          if (tokens[who]) h["x-claude-os-token"] = tokens[who]!;
          const r = await rawStatus(target, h, method);
          expect([target, who, method, r.status]).toEqual([target, who, method, 400]);
          expect(r.head).not.toContain('"reached":true');
        }
  });

  test("canonical paths still work, and dots in the query are fine", async () => {
    expect((await rawStatus("/__token?next=../x", headersFor("owner"))).status).toBe(200);
    expect((await rawStatus("/__jobs", headersFor("tsMehroz"))).status).not.toBe(400);
    expect((await rawStatus("/node_modules/.vite/deps/react.js?v=1", headersFor("owner"))).status).toBe(200);
    expect((await rawStatus("/src/some%20file.tsx", headersFor("owner"))).status).toBe(200);
  });
});

describe("Telegram: the relay resolves the sender with resolveTelegramPrincipal (B2 migration)", () => {
  async function relay(from: { user: string; chat: string; type?: string }, text: string, bearer?: string) {
    const token = bearer ?? readFileSync(join(root, ".operator-data", "away-mode", "relay.token"), "utf8").trim();
    const r = await fetch(base + "/__away/telegram", {
      method: "POST",
      headers: { ...headersFor("owner"), "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ platform: "telegram", user_id: from.user, chat_id: from.chat, chat_type: from.type ?? "dm", text }),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  }

  test("the hub owner's own DM is obeyed; Mehroz, a stranger, a group or a wrong bearer is not", async () => {
    await relay({ user: TG.usman, chat: TG.usman }, "/status", "not-the-token"); // makes the relay token file
    const owner = await relay({ user: TG.usman, chat: TG.usman }, "/status");
    expect(owner.status).toBe(200);
    expect(owner.json.handled).toBe(true);
    expect(String(owner.json.reply)).not.toContain("only takes orders");
    for (const from of [
      { user: TG.mehroz, chat: TG.mehroz }, // verified, but away mode runs on Usman's PC
      { user: "9999999", chat: "9999999" }, // not listed: no fallback owner id
      { user: TG.usman, chat: "-1001234567", type: "group" }, // a group, even from Usman
    ]) {
      const r = await relay(from, "/status");
      expect([from.user, r.status]).toEqual([from.user, 200]);
      expect(String(r.json.reply ?? "")).not.toContain("Away mode is");
    }
    const mehroz = await relay({ user: TG.mehroz, chat: TG.mehroz }, "/status");
    expect(mehroz.json.reply).toContain("only takes orders from Usman");
    // An approval code from anyone but the owner's own DM is refused before any code is looked at.
    const approve = await relay({ user: TG.mehroz, chat: TG.mehroz }, "yes AB23");
    expect(String(approve.json.reply)).toContain("Only Usman's own chat");
    expect((await relay({ user: TG.usman, chat: TG.usman }, "/status", "wrong-bearer")).status).toBe(401);
  });
});

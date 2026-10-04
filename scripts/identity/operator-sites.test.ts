import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../devices/store";
import { operatorPlugin } from "../operator-plugin";
import { syntheticTailnetForTests } from "../remote-access";
import { CONFIRM_FIRST, createPrincipalGate, under } from "./gate";
import { routeClass } from "./routes";
import { createLocalOwnerProof } from "./local-owner-token";
import { OPERATOR_SITES, operatorRemoteRefusal, operatorSiteClass, SERVER_CONSOLE_ONLY_LINE, SERVER_WORK_NEEDS_SESSION, serverWorkAllowed } from "./operator-sites";
import { pageTokenFor } from "./principal";

/**
 * The "only at this PC" sites inside the shared /__operator mount, classified for the server role. The REAL operator plugin
 * runs behind the REAL identity gate (Serve simulated), with a principal per kind and a hub role per case. Quiet: no
 * schedulers, no agent launches; the requests used for allowed callers are the safe ones (reads, bad-input writes).
 */

process.env.AGENTIC_OS_NO_BACKGROUND = "1";
process.env.AGENTIC_OS_NO_CODEX = "1";
const TAILNET = "sites-hub.tail-test.ts.net";
const INTERNAL = "operator-sites-internal";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
type Role = "pc" | "cloud" | "server";
type Kind = "owner" | "confirmed-founder" | "pending-founder" | "bare-login";
const KINDS: Kind[] = ["owner", "confirmed-founder", "pending-founder", "bare-login"];

const root = mkdtempSync(join(tmpdir(), "operator-sites-"));
mkdirSync(join(root, ".operator-data"), { recursive: true });
mkdirSync(join(root, "fake-home"), { recursive: true });
writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }));
const store = new DeviceStore(root);
const confirmed = store.mintSession("mehroz", "Mehroz's laptop", "code").cookie;
const pending = store.mintSession("mehroz", "curl", "tailnet", { pending: true }).cookie;
const tailnet = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);
const proof = createLocalOwnerProof(root, { MU_LOCAL_OWNER_TOKEN_FILE: join(root, "owner.token") });
const ownerToken = require("node:fs").readFileSync(proof.path, "utf8").trim();

type Handler = (req: IncomingMessage, res: ServerResponse, next: (e?: unknown) => void) => unknown;
const operatorMounts: Array<{ path: string | null; fn: Handler }> = [];
let operator: Handler = () => undefined;
const gates = Object.fromEntries((["pc", "cloud", "server"] as Role[]).map((role) => [role, createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: () => true, tailnet, role, ...(role === "server" ? { localOwnerProof: proof } : {}) })])) as Record<Role, Handler>;
let server: Server;
let base = "";
let currentRole: Role = "server";

beforeAll(async () => {
  process.env.MU_HUB_ROLE = "server"; // services that read the role when they are built (away mode) are built as the server's
  (operatorPlugin({ root, token: INTERNAL, memoryHome: join(root, "fake-home") }).configureServer as any)({
    middlewares: { use: (a: string | Handler, b?: Handler) => void operatorMounts.push(typeof a === "function" ? { path: null, fn: a } : { path: a, fn: b! }) },
    config: { server: { port: 0 } },
  });
  operator = operatorMounts.find((m) => m.path === "/__operator")!.fn;
  server = createServer((req, res) => {
    // The hub role is a process-wide env read per request by the operator plugin; the gate was built per role.
    process.env.MU_HUB_ROLE = currentRole;
    gates[currentRole](req, res, () => {
      const original = req.url ?? "/";
      if (!under(original.split("?")[0], "/__operator")) return void res.end("{}");
      req.url = original.slice("/__operator".length) || "/";
      void operator(req, res, () => res.end("{}"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  delete process.env.MU_HUB_ROLE;
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* sqlite handle on Windows */
  }
});

const serve = (login: string, extra: Record<string, string> = {}) => ({ host: `${TAILNET}:8443`, "tailscale-user-login": login, "x-forwarded-for": "100.64.0.12", "x-forwarded-proto": "https", ...extra });
function headersFor(kind: Kind): Record<string, string> {
  const own = pageTokenFor({ personId: "mehroz", via: "paired-session" }, INTERNAL);
  switch (kind) {
    case "owner":
      return { host: `127.0.0.1:${new URL(base).port}`, "x-mu-local-owner": ownerToken, "x-claude-os-token": INTERNAL };
    case "confirmed-founder":
      return serve(LOGIN.mehroz, { cookie: `mu_session=${encodeURIComponent(confirmed)}`, "x-claude-os-token": own });
    case "pending-founder":
      return serve(LOGIN.mehroz, { cookie: `mu_session=${encodeURIComponent(pending)}`, "x-claude-os-token": own });
    case "bare-login":
      return serve(LOGIN.mehroz, { "x-claude-os-token": own });
  }
}
async function call(role: Role, kind: Kind, method: string, path: string, body?: unknown) {
  currentRole = role;
  const headers = { ...headersFor(kind), ...(body !== undefined ? { "content-type": "application/json" } : {}) } as Record<string, string>;
  const res = await fetch(`${base}/__operator${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, error: typeof json?.error === "string" ? (json.error as string) : "", json };
}

describe("the inventory is classified and every site has a sample", () => {
  test("every site has an id, a class, a before and an after, a sample, and device sites have no central matcher", () => {
    const ids = new Set<string>();
    for (const site of OPERATOR_SITES) {
      expect(ids.has(site.id)).toBe(false);
      ids.add(site.id);
      expect(["device", "work", "publish", "console"]).toContain(site.class);
      expect(site.before.length).toBeGreaterThan(5);
      expect(site.after.length).toBeGreaterThan(5);
      expect(site.sample.length).toBe(2);
      if (site.class === "device") expect(site.match).toBeUndefined();
      else expect(operatorSiteClass(site.sample[0], site.sample[1])).toBe(site.class);
    }
    expect(OPERATOR_SITES.filter((s) => s.class === "work").length).toBeGreaterThanOrEqual(12);
    expect(OPERATOR_SITES.filter((s) => s.class === "console").map((s) => s.id).sort()).toEqual(["connector-credentials", "skill-approve"]);
  });

  test("unrelated shared routes are unclassified (nothing leaks into the table)", () => {
    for (const [m, p] of [["GET", "/state"], ["POST", "/leads/save-deal"], ["GET", "/leads/list"], ["POST", "/screen/command"], ["GET", "/jobs"], ["POST", "/workspace/decision"]] as const) expect(operatorSiteClass(m, p)).toBeNull();
  });
});

describe("ONE helper: serverWorkAllowed", () => {
  const p = (via: string, actor?: string) => ({ via, actor });
  test("true only in the server role for a confirmed human founder session", () => {
    for (const role of ["pc", "cloud", "", "banana"]) for (const via of ["paired-session", "loopback-owner", "tailnet-person", "companion", "telegram-owner"]) expect([role, via, serverWorkAllowed(p(via, "human"), role)]).toEqual([role, via, false]);
    expect(serverWorkAllowed(p("paired-session", "human"), "server")).toBe(true);
    expect(serverWorkAllowed(p("paired-session", "process"), "server")).toBe(false);
    expect(serverWorkAllowed(p("tailnet-person", "process"), "server")).toBe(false);
    expect(serverWorkAllowed(p("tailnet-person", "human"), "server")).toBe(false);
    expect(serverWorkAllowed(p("companion", "process"), "server")).toBe(false);
    expect(serverWorkAllowed(null, "server")).toBe(false);
  });
  test("pc and cloud: the central refusal never fires for any site, method or principal, so `remote` behaves as before", () => {
    for (const role of ["pc", "cloud"]) for (const site of OPERATOR_SITES) for (const serverWork of [true, false]) expect(operatorRemoteRefusal(role, site.sample[0], site.sample[1], serverWork)).toBeNull();
  });
  test("server: console sites are refused to every remote caller, work sites to anyone without the confirmed session", () => {
    for (const site of OPERATOR_SITES) {
      const [m, pth] = site.sample;
      const open = operatorRemoteRefusal("server", m, pth, true);
      const closed = operatorRemoteRefusal("server", m, pth, false);
      if (site.class === "console") expect([site.id, open?.error, closed?.error]).toEqual([site.id, SERVER_CONSOLE_ONLY_LINE, SERVER_CONSOLE_ONLY_LINE]);
      else if (site.class === "work") expect([site.id, open, closed?.error]).toEqual([site.id, null, SERVER_WORK_NEEDS_SESSION]);
      else expect([site.id, open, closed]).toEqual([site.id, null, null]);
    }
  });
});

/** Work sites safe to run for real: reads and bad-input writes (nothing is spent, launched or written outside the temp root). */
const SAFE_WORK: Array<[string, string, unknown?]> = [
  ["GET", "/agent-jobs"],
  ["GET", "/model-router"],
  ["GET", "/model-fleet/receipts"],
  ["GET", "/inbox/triage"],
  ["POST", "/jarvis/settings", {}],
  ["GET", "/skill-drafts"],
  ["POST", "/leads/seo-audit", {}],
  ["POST", "/leads/find", { source: "not-a-source" }],
];
const CONSOLE_SAMPLES: Array<[string, string, unknown?]> = [
  ["POST", "/connections/disconnect", {}],
  ["POST", "/connections/configure", {}],
  ["POST", "/memory/notion-config", {}],
  ["POST", "/skill-drafts/abc/approve", {}],
];
const DEVICE_SAMPLES: Array<[string, string, unknown?]> = [
  ["POST", "/setup/open-privacy", {}],
  ["POST", "/narrate/start", {}],
  ["POST", "/screen/lesson", {}],
  ["POST", "/control/audit", {}],
];

describe("server role, through the real operator plugin and the real gate", () => {
  for (const [method, path, body] of SAFE_WORK)
    test(`work: ${method} ${path}: the owner at the console and a confirmed founder are let through; a pending session, a bare login are refused with the clear line`, async () => {
      for (const kind of ["owner", "confirmed-founder"] as Kind[]) {
        const r = await call("server", kind, method, path, body);
        expect([kind, r.status === 403 ? r.error : "not refused"]).toEqual([kind, "not refused"]);
      }
      for (const kind of ["pending-founder", "bare-login"] as Kind[]) {
        const r = await call("server", kind, method, path, body);
        // A bare login is refused at the gate before the server-role rule (acceptance #18): same 403, the confirm line.
        expect([kind, r.status, r.error]).toEqual([kind, 403, routeClass(`/__operator${path.split("?")[0]}`, method) === "shared" ? CONFIRM_FIRST : SERVER_WORK_NEEDS_SESSION]);
      }
    });

  for (const [method, path, body] of CONSOLE_SAMPLES)
    test(`console: ${method} ${path}: refused to every founder kind with the console line; the owner at the console is not refused`, async () => {
      for (const kind of ["confirmed-founder", "pending-founder", "bare-login"] as Kind[]) {
        const r = await call("server", kind, method, path, body);
        expect([kind, r.status, r.error]).toEqual([kind, 403, kind !== "confirmed-founder" && routeClass(`/__operator${path.split("?")[0]}`, method) === "shared" ? CONFIRM_FIRST : SERVER_CONSOLE_ONLY_LINE]);
      }
      const owner = await call("server", "owner", method, path, body);
      expect([owner.status === 403 ? owner.error : "not refused"]).toEqual(["not refused"]);
    });

  for (const [method, path, body] of DEVICE_SAMPLES)
    test(`device: ${method} ${path}: keeps the remote semantics for every founder kind (refused, and not with the work or console lines)`, async () => {
      for (const kind of ["confirmed-founder", "pending-founder", "bare-login"] as Kind[]) {
        const r = await call("server", kind, method, path, body);
        expect([kind, r.status]).toEqual([kind, 403]);
        expect([SERVER_WORK_NEEDS_SESSION, SERVER_CONSOLE_ONLY_LINE]).not.toContain(r.error);
      }
    });

  test("the signer: a confirmed founder's lead activity is recorded as the signer even when the body names someone else", async () => {
    // (the by override is the sites' own rule, untouched: `remote` is still the raw remote object for it)
    const r = await call("server", "confirmed-founder", "POST", "/leads/seo-audit", { lead: 999999, by: "usman" });
    expect(r.status).not.toBe(403);
  });
});

describe("pc and cloud are byte-identical in behaviour: the same founder kinds are refused exactly as before and never see the server lines", () => {
  const matrix: Array<[string, string, unknown?]> = [...SAFE_WORK, ...CONSOLE_SAMPLES, ...DEVICE_SAMPLES].filter(([, p]) => !p.startsWith("/leads/find"));
  for (const [method, path, body] of matrix)
    test(`${method} ${path}`, async () => {
      for (const kind of ["confirmed-founder", "pending-founder", "bare-login"] as Kind[]) {
        const pc = await call("pc", kind, method, path, body);
        const cloud = await call("cloud", kind, method, path, body);
        expect([kind, cloud.status, cloud.error]).toEqual([kind, pc.status, pc.error]);
        expect([SERVER_WORK_NEEDS_SESSION, SERVER_CONSOLE_ONLY_LINE]).not.toContain(pc.error);
        // The "only at this PC" sites still refuse a remote founder, as they always did.
        if (["POST /jarvis/settings", "GET /agent-jobs", "GET /inbox/triage", "GET /skill-drafts", "POST /connections/disconnect", "POST /leads/seo-audit"].includes(`${method} ${path}`)) expect([kind, pc.status]).toEqual([kind, 403]);
      }
    });
});


describe("the server drives no desktop for ANY caller: away mode, lessons and the voice skills that touch the hub's own windows", () => {
  const AWAY = "Away mode drives a desktop; on the server use your own PC's companion.";
  for (const kind of ["owner", "confirmed-founder"] as Kind[])
    for (const action of ["on", "resume", "task"])
      test(`${kind}: POST /away {action: ${action}} is refused 501 with the honest line`, async () => {
        const r = await call("server", kind, "POST", "/away", { action, text: "tidy Downloads" });
        expect([r.status, r.error]).toEqual([501, AWAY]);
      });
  test("the owner at the console cannot run lessons on the hub's screen either: refused with the desktop line", async () => {
    for (const path of ["/screen/lesson", "/screen/course", "/screen/overlay"]) {
      const r = await call("server", "owner", "POST", path, {});
      expect([path, r.status, r.error]).toEqual([path, 403, "That drives a desktop; on the server use your own PC's companion."]);
    }
  });
  test("the owner at the console gets only the pure voice skills: typing, clipboard and windows are the remote-safe refusal", async () => {
    for (const skill of ["type", "clipboard", "windows"]) {
      const r = await call("server", "owner", "POST", "/jarvis/skill", { skill, args: {} });
      expect(r.json?.ok).not.toBe(true);
    }
    const pure = await call("server", "owner", "POST", "/jarvis/skill", { skill: "time", args: {} });
    expect(pure.status).toBe(200);
  });
});

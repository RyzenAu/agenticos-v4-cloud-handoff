import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { createDevicesService, type DevicesService } from "../devices/service";
import { setActiveRegistry } from "../devices/registry";
import { CODE_LOCK_MS, DeviceStore } from "../devices/store";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { jobsApprovalsMiddleware } from "../jobs/plugin";
import { JobService } from "../jobs/service";
import { memoryPlugin, memoryPrincipalFrom } from "../memory/plugin";
import { operatorPlugin } from "../operator-plugin";
import { createPrincipalGate, pageTokenMatches, requestPrincipal, under } from "./gate";
import { routeRule } from "./routes";
import { syntheticTailnetForTests } from "../remote-access";

/**
 * S1 security hotfix regressions (AUDIT-A1 1, 2, 3, 4 and 7), end to end through the identity gate and
 * the REAL /__devices, /__jobs + /__approvals, /__memory and /__operator handlers, on a synthetic root
 * (fake people.json: Usman + Mehroz; own SQLite stores; own home). The auditor's harness scenarios:
 *   S1  a local program's forged page navigation mints a session: it must NOT be a human session
 *   S2  forged navigations evict the owner's real browser session (hub cap 8)
 *   S4  that forged session requests a quarantine release, gets a card and approves it with uiConfirm
 *   S5  tailnet Mehroz reads Usman's server-only session key (sk1.) in GET /__approvals
 *   S6  a page-token process rejects or cancels a human's pending approval
 * plus A1-2 (hub guards mean "at the hub") and A1-4 (hub connector syncs refuse a remote founder).
 * Written to fail on jarvis-voice f334ab7 and pass on f/s1-security-20260928.
 */

process.env.AGENTIC_OS_NO_CODEX = "1";
const TAILNET = "s1-hub.tail-test.ts.net";
const INTERNAL = "s1-internal-page-token";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
/** Tailscale Serve simulated over this test's plain loopback socket (the real peer check has its own tests below). */
const SIMULATED = () => true;
/** `tailscale status` simulated: this hub owns 100.64.0.1; every other tailnet address is another node (REVIEW-S1 R2-1). */
const TAILNET_STATUS = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);

let root: string;
let server: Server;
let base: string;
let store: DeviceStore;
let devices: DevicesService;
let jobs: JobService;
let approvals: ApprovalService;
let ownerCookie = "";
let mehrozToken = "";
// Mehroz as a remote founder is a CONFIRMED session (acceptance #18: a bare tailnet login sees no shared data).
let mehrozCookie = "";

type Mount = { path: string | null; fn: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => unknown };
const mounts: Mount[] = [];
const fakeServer = {
  middlewares: { use: (a: string | Mount["fn"], b?: Mount["fn"]) => void mounts.push(typeof a === "function" ? { path: null, fn: a } : { path: a, fn: b! }) },
  config: { server: { port: 0 } },
};

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

const local = () => ({ host: `127.0.0.1:${new URL(base).port}` });
const nav = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
const serve = (login: string) => ({ host: `${TAILNET}:8443`, "tailscale-user-login": login, "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" });
const cookieOf = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith("mu_session=")) ?? "").split(";")[0];

async function req(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}
/** A local program: loopback, the page token any local caller can read from /__token, and maybe a cookie. */
const program = (cookie = "") => ({ ...local(), "x-claude-os-token": INTERNAL, ...(cookie ? { cookie } : {}) });
const owner = () => program(ownerCookie);
const mehroz = () => ({ ...serve(LOGIN.mehroz), cookie: `mu_session=${encodeURIComponent(mehrozCookie)}`, "x-claude-os-token": mehrozToken });
/** Mehroz's browser before it is confirmed (a bare tailnet login). */
const mehrozBare = () => ({ ...serve(LOGIN.mehroz), "x-claude-os-token": mehrozToken });

/**
 * A job that ignored its stop and finished after the grace period, so its kind is quarantined. A held kind
 * blocks new runs of that kind, so each test that leaves one held uses its own kind.
 */
async function quarantinedJob(kind: "control" | "voice" | "screen" | "away" | "coding" | "memory" | "lesson") {
  const job = jobs.create({ kind, principal: { personId: "usman", via: "loopback-owner" }, targetDeviceId: "usman-pc", title: "Open Notepad (synthetic)" });
  const running = jobs.run(job.id, async () => {
    await Bun.sleep(80);
    return { ok: true };
  });
  await Bun.sleep(5);
  await jobs.cancel(job.id);
  await running;
  expect(jobs.get(job.id)!.quarantined).toBe(true);
  return job.id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "s1-security-"));
  mkdirSync(join(root, ".operator-data"));
  mkdirSync(join(root, "fake-home"));
  mkdirSync(join(root, "wiki"));
  writeFileSync(
    join(root, ".operator-data", "people.json"),
    JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }),
  );
  store = new DeviceStore(root);
  mehrozCookie = store.mintSession("mehroz", "Mehroz's phone", "tailnet").cookie;
  jobs = new JobService({ path: join(root, ".operator-data", "jobs.sqlite"), kill: async () => true, stopGraceMs: 20, accounting: async () => [{ pid: process.pid, ppid: 0, created: 0 }] });
  approvals = new ApprovalService({ path: join(root, ".operator-data", "approvals.sqlite"), spoken: new SpokenConfirmationLedger(), code: () => "AB3D" });

  mounts.push({ path: null, fn: createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: SIMULATED, tailnet: TAILNET_STATUS }) });
  devices = createDevicesService({ root, token: INTERNAL, tailnetName: TAILNET, store, servePeer: SIMULATED, tailnet: TAILNET_STATUS });
  mounts.push({ path: "/__devices", fn: (r, s, n) => void devices.handle(r, s, n) });
  const jobsMw = jobsApprovalsMiddleware({ root, token: () => INTERNAL, resolvePrincipal: (r) => requestPrincipal(r as never), deps: { jobs: () => jobs, approvals: () => approvals } });
  mounts.push({ path: null, fn: jobsMw as Mount["fn"] });
  const quiet = process.env.AGENTIC_OS_NO_BACKGROUND;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    (operatorPlugin({ root, token: INTERNAL, memoryHome: join(root, "fake-home") }).configureServer as any)(fakeServer);
  } finally {
    if (quiet === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
    else process.env.AGENTIC_OS_NO_BACKGROUND = quiet;
  }
  (memoryPlugin({
    root,
    principalFor: (r) => memoryPrincipalFrom(requestPrincipal(r as never)),
    tokenOk: (r) => pageTokenMatches(requestPrincipal(r as never), r.headers["x-claude-os-token"], INTERNAL),
    env: { MU_MEMORY_WRITES: "off", MU_WIKI_ROOT: join(root, "wiki"), MEMORY_STATE_DIR: join(root, ".operator-data", "memory"), AGENTIC_OS_NO_BACKGROUND: "1" },
  }).configureServer as any)(fakeServer);
  mounts.push({ path: null, fn: (r, s, n) => ((r.url || "").startsWith("/__") ? n() : s.end(`served ${r.url}`)) });

  server = createServer((r, s) => dispatch(r, s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The owner already uses the OS: his browser's first page load at this PC (trusted on first use).
  ownerCookie = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
  mehrozToken = (await req("GET", "/__token", serve(LOGIN.mehroz))).json.token;
}, 60_000);

afterAll(async () => {
  devices?.close();
  setActiveRegistry(undefined);
  jobs?.close();
  approvals?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold a SQLite handle briefly */
  }
});

describe("baseline: the owner's real browser session", () => {
  test("his first page load at this PC is a human session; Mehroz holds a person-bound token", async () => {
    expect(ownerCookie.startsWith("mu_session=")).toBe(true);
    expect((await req("GET", "/__devices/me", owner())).json.principal).toMatchObject({ personId: "usman", via: "loopback-owner", actor: "human" });
    expect(mehrozToken.startsWith("p1.")).toBe(true);
  });

  test("a genuine human session can still request and grant a consequential approval by card", async () => {
    const jobId = await quarantinedJob("control");
    const ask = await req("POST", `/__jobs/${jobId}/release`, owner(), {});
    expect(ask.status).toBe(202);
    const id = ask.json.approval.id;
    const card = await req("POST", `/__approvals/${id}/card`, owner(), {});
    expect(card.status).toBe(200);
    const yes = await req("POST", `/__approvals/${id}/decide`, owner(), { decision: "approve", evidence: { uiConfirm: true, cardNonce: card.json.cardNonce } });
    expect([yes.status, yes.json.approval?.state]).toEqual([200, "approved"]);
    const release = await req("POST", `/__jobs/${jobId}/release`, owner(), { approvalId: id });
    expect([release.status, release.json.job?.quarantined]).toEqual([200, false]);
  });
});

describe("A1-3 (harness S1, S4): a forged navigation is not a human session", () => {
  test("S1: a local program's two navigation headers mint only a PENDING session, which is a process", async () => {
    const forged = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    expect(forged.startsWith("mu_session=")).toBe(true);
    const me = (await req("GET", "/__devices/me", program(forged))).json;
    expect(me.principal).toMatchObject({ personId: "usman", via: "loopback-owner", actor: "process" });
    // REVIEW-S1 F2b: the pending browser is never handed a confirm code (the program would read it).
    expect(me.hubSession).toEqual({ pending: true });
    // The owner's own browser is untouched and still human.
    expect((await req("GET", "/__devices/me", owner())).json.principal.actor).toBe("human");
  });

  test("S4: with the forged session a program can't self-approve a quarantine release by card", async () => {
    const forged = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    const jobId = await quarantinedJob("screen");
    const ask = await req("POST", `/__jobs/${jobId}/release`, program(forged), {});
    expect(ask.status).toBe(202);
    const id = ask.json.approval.id;
    expect(ask.json.approval.requester.actor).toBe("process");
    const card = await req("POST", `/__approvals/${id}/card`, program(forged), {});
    expect(card.status).toBe(403);
    const yes = await req("POST", `/__approvals/${id}/decide`, program(forged), { decision: "approve", evidence: { uiConfirm: true, cardNonce: "00000000-0000-4000-8000-000000000000" } });
    expect(yes.status).toBe(409);
    expect(approvals.get(id)!.state).toBe("pending");
    // A process's request can't be clicked through even by the owner's real session: a spoken yes or the Telegram code.
    const ownerCard = await req("POST", `/__approvals/${id}/card`, owner(), {});
    const ownerYes = await req("POST", `/__approvals/${id}/decide`, owner(), { decision: "approve", evidence: { uiConfirm: true, cardNonce: ownerCard.json.cardNonce ?? "00000000-0000-4000-8000-000000000000" } });
    expect(ownerYes.json.code).toBe("evidence-required");
  });

  test("REVIEW-S1 F2b: only a human context makes a confirm code; the pending browser confirms itself with it", async () => {
    const pendingCookie = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    // Nobody but Usman acting now can make a code: not a plain program, not the pending browser, not Mehroz.
    expect((await req("POST", "/__devices/sessions/confirm-code", program(), {})).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm-code", program(pendingCookie), {})).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm-code", mehroz(), {})).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm-code", mehrozBare(), {})).status).toBe(403);
    const made = await req("POST", "/__devices/sessions/confirm-code", owner(), {});
    expect([made.status, made.json.code]).toEqual([200, expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)]);
    const code = made.json.code;
    // It confirms only a pending browser at this PC, and only the one that types it in.
    expect((await req("POST", "/__devices/sessions/confirm", program(), { code })).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm", mehroz(), { code })).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm", mehrozBare(), { code })).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm", owner(), { code })).status).toBe(409);
    expect((await req("POST", "/__devices/sessions/confirm", program(pendingCookie), { code: "AAAA-AAAA" })).status).toBe(403);
    const ok = await req("POST", "/__devices/sessions/confirm", program(pendingCookie), { code });
    expect([ok.status, ok.json.confirmed?.pending]).toEqual([200, false]);
    const me = (await req("GET", "/__devices/me", program(pendingCookie))).json;
    expect(me.principal.actor).toBe("human");
    expect(me.hubSession).toEqual({ pending: false });
    // One use only.
    const other = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    expect((await req("POST", "/__devices/sessions/confirm", program(other), { code })).status).toBe(403);
    expect((await req("GET", "/__devices/me", program(other))).json.principal.actor).toBe("process");
  });

  test("REVIEW-S1 R3c: a program that forged a navigation finds no code to redeem, and the command won't run for it", async () => {
    const forged = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    const me = await req("GET", "/__devices/me", program(forged));
    expect(me.text).not.toMatch(/"[A-Z2-9]{4}-[A-Z2-9]{4}"/);
    expect(me.json.hubSession).toEqual({ pending: true });
    // The confirm-browser command refuses without an interactive terminal (an agent's shell tool pipes
    // its stdin and stdout), and never prints a code there.
    const cmd = join(import.meta.dir, "confirm-browser.ts");
    const piped = Bun.spawnSync([process.execPath, "--no-env-file", cmd, "--root", root], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(piped.exitCode).toBe(3);
    expect(piped.stdout.toString() + piped.stderr.toString()).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    // The old form (a code read from the pending browser) is gone.
    const old = Bun.spawnSync([process.execPath, "--no-env-file", cmd, "ABCD-EFGH", "--root", root], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(old.exitCode).toBe(2);
    expect((await req("GET", "/__devices/me", program(forged))).json.principal.actor).toBe("process");
    const { interactive } = await import("./confirm-browser");
    expect(interactive({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
    expect(interactive({ stdin: { isTTY: true }, stdout: {} })).toBe(false);
    expect(interactive({ stdin: {}, stdout: { isTTY: true } })).toBe(false);
  }, 30_000);

  test("a code the command writes to this PC's store confirms the browser it is typed into (recovery path)", async () => {
    const pendingCookie = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    // What confirm-browser.ts does after its interactive checks: a one-time "hub" code in the local store.
    const { code } = new DeviceStore(root).createCode("usman", "hub", "usman");
    // A hub code is not a pairing code.
    expect((await req("POST", "/__devices/pair/redeem", mehrozBare(), { code })).status).toBe(403);
    expect((await req("POST", "/__devices/sessions/confirm", program(pendingCookie), { code })).status).toBe(200);
    expect((await req("GET", "/__devices/me", program(pendingCookie))).json.principal.actor).toBe("human");
  });
});

describe("acceptance #18: a bare tailnet login drives no device and lists nothing (review of 712f04eb, M1)", () => {
  test("commands, cancel, devices and sessions are refused to a bare login; it can still read /me to pair", async () => {
    expect((await req("POST", "/__devices/commands", mehrozBare(), { executor: "observe.window" })).status).toBe(403);
    expect((await req("POST", "/__devices/commands/cancel", mehrozBare(), { commandId: "x" })).status).toBe(403);
    expect((await req("GET", "/__devices/devices", mehrozBare())).status).toBe(403);
    expect((await req("GET", "/__devices/sessions", mehrozBare())).status).toBe(403);
    expect((await req("GET", "/__devices/me", mehrozBare())).status).toBe(200);
    // The confirmed founder still lists devices.
    expect((await req("GET", "/__devices/devices", mehroz())).status).toBe(200);
  });
  test("a bare login gets the pairing page, never the app's files (review M2)", async () => {
    for (const path of ["/", "/jarvis", "/src/data/live-data.json", "/vite.config.ts", "/docs/programme-20261001/R9-OPS.md"]) {
      const r = await fetch(base + path, { headers: { ...serve(LOGIN.mehroz), ...nav } });
      const text = await r.text();
      expect([path, r.status, text.includes("Pair this device")]).toEqual([path, 200, true]);
    }
  });
});

describe("REVIEW-S1 F1: session and device administration needs a person acting now", () => {
  test("a local program can list sessions but can't revoke the owner's confirmed one (or change devices)", async () => {
    const ownerId = (await req("GET", "/__devices/me", owner())).json.session.id;
    const pendingCookie = cookieOf(await fetch(base + "/", { headers: { ...local(), ...nav } }));
    // R7a: the listing is still readable, but the owner's confirmed session can't be revoked from it.
    expect((await req("GET", "/__devices/sessions", program())).json.sessions.some((x: { id: string }) => x.id === ownerId)).toBe(true);
    for (const who of [program(), program(pendingCookie), mehroz(), mehrozBare()]) {
      const r = await req("POST", "/__devices/sessions/revoke", who, { sessionId: ownerId });
      expect(r.status).toBe(403);
    }
    const writes: [string, unknown][] = [
      ["/__devices/sessions/revoke", { sessionId: ownerId, requireCode: true }],
      ["/__devices/devices/revoke", { deviceId: "usman-anything" }],
      ["/__devices/policy/self-pair", { personId: "usman", allowed: false }],
      ["/__devices/policy/finance", { personId: "mehroz", granted: true }],
      ["/__devices/pair/code", { purpose: "browser" }],
      ["/__devices/pair/code", { purpose: "companion" }],
    ];
    for (const [path, body] of writes) expect([path, (await req("POST", path, program(), body)).status]).toEqual([path, 403]);
    // Nothing changed: the owner is still a human session, and self-pairing is still on.
    expect((await req("GET", "/__devices/me", owner())).json.principal.actor).toBe("human");
    expect(store.policy().selfPair.usman).not.toBe(false);
    expect(store.policy().financeGrants).toEqual([]);
    // The owner's own session still administers: he revokes the pending one and can make a pairing code.
    const pendingId = (await req("GET", "/__devices/me", program(pendingCookie))).json.session.id;
    const r = await req("POST", "/__devices/sessions/revoke", owner(), { sessionId: pendingId });
    expect([r.status, r.json.revoked]).toEqual([200, pendingId]);
    expect((await req("POST", "/__devices/pair/code", owner(), { purpose: "browser" })).status).toBe(200);
  });
});

describe("REVIEW-S1 F2a (R3b): forged Tailscale Serve headers from a local program are not a tailnet login", () => {
  test("with the real peer check, a local program sending Usman's tailnet Host and login gets no principal and can't pair", async () => {
    // A second gate + /__devices on the same root, WITHOUT the test's simulated Serve: the default check
    // asks Windows who owns the other end of the socket (this test process, not tailscaled).
    const realMounts: Mount[] = [];
    realMounts.push({ path: null, fn: createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET }) });
    const realDevices = createDevicesService({ root, token: INTERNAL, tailnetName: TAILNET, store });
    realMounts.push({ path: "/__devices", fn: (r, s, n) => void realDevices.handle(r, s, n) });
    realMounts.push({ path: null, fn: (_r, s) => void s.end("served") });
    const realServer = createServer((r, s) => {
      let i = 0;
      const original = r.url || "/";
      const next = (): unknown => {
        r.url = original;
        const m = realMounts[i++];
        if (!m) return s.end();
        if (m.path === null) return m.fn(r, s, next);
        if (!under(original.split("?")[0], m.path)) return next();
        r.url = original.slice(m.path.length) || "/";
        return m.fn(r, s, next);
      };
      next();
    });
    await new Promise<void>((r) => realServer.listen(0, "127.0.0.1", () => r()));
    const realBase = `http://127.0.0.1:${(realServer.address() as { port: number }).port}`;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const forged = serve(LOGIN.usman);
      const token = await fetch(realBase + "/__token", { headers: forged });
      expect(token.status).toBe(401);
      const meRes = await fetch(realBase + "/__devices/me", { headers: forged });
      const me = await meRes.json();
      // Refused outright (not a tailnet login and not at this PC), or at most an unauthorised view.
      if (meRes.status === 200) expect([me.authorised, me.principal, me.canSelfPair]).toEqual([false, null, false]);
      else expect([401, 403]).toContain(meRes.status);
      // The same request with the simulated Serve check is Usman over the tailnet: the peer check is what refuses it.
      expect(requestPrincipal({ socket: { remoteAddress: "127.0.0.1" }, headers: { ...forged, host: `${TAILNET}:8443` } } as never, { root, store, tailnetName: TAILNET, servePeer: SIMULATED, tailnet: TAILNET_STATUS })?.personId).toBe("usman");
      const pair = await fetch(realBase + "/__devices/pair/tailnet", { method: "POST", headers: { ...forged, "content-type": "application/json", "x-claude-os-token": INTERNAL }, body: "{}" });
      expect([401, 403]).toContain(pair.status);
      expect(pair.headers.getSetCookie().some((c) => c.startsWith("mu_session=") && !/Max-Age=0/.test(c))).toBe(false);
    } finally {
      console.warn = warn;
      realDevices.close();
      realServer.closeAllConnections?.();
      await new Promise<void>((r) => realServer.close(() => r()));
    }
  });

  test.if(process.platform === "win32")("the peer check really identifies the process on the other end of a loopback socket", async () => {
    const { peerProcess, relayedByTailscaleServe } = await import("./serve-peer");
    const seen: unknown[] = [];
    const probe = createServer((r, s) => {
      seen.push(peerProcess(r), relayedByTailscaleServe(r));
      s.end("ok");
    });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await (await fetch(`http://127.0.0.1:${(probe.address() as { port: number }).port}/`)).text();
    } finally {
      console.warn = warn;
      probe.closeAllConnections?.();
      await new Promise<void>((r) => probe.close(() => r()));
    }
    // This test process connected, so the OS names it: our own pid, not tailscaled, not in session 0.
    expect(seen[0]).toMatchObject({ pid: process.pid, name: expect.stringMatching(/^bun/i) });
    expect((seen[0] as { sessionId: number }).sessionId).not.toBe(0);
    expect(seen[1]).toBe(false);
  });
});

describe("A1-7 (harness S6): a process can't void a person's pending approval", () => {
  async function ownersPending(kind: "away" | "coding") {
    const jobId = await quarantinedJob(kind);
    const ask = await req("POST", `/__jobs/${jobId}/release`, owner(), {});
    expect(ask.json.approval.requester.actor).toBe("human");
    return ask.json.approval.id as string;
  }

  test("S6: reject and cancel by a page-token process are refused; the person can still do both", async () => {
    const id = await ownersPending("away");
    const reject = await req("POST", `/__approvals/${id}/decide`, program(), { decision: "reject" });
    expect(reject.status).not.toBe(200);
    const cancel = await req("POST", `/__approvals/${id}/cancel`, program(), {});
    expect(cancel.status).toBe(403);
    expect(approvals.get(id)!.state).toBe("pending");
    expect((await req("POST", `/__approvals/${id}/decide`, owner(), { decision: "reject" })).json.approval.state).toBe("rejected");
    const id2 = await ownersPending("coding");
    expect((await req("POST", `/__approvals/${id2}/cancel`, owner(), {})).json.approval.state).toBe("cancelled");
  });

  test("a process may still withdraw the request it made itself", async () => {
    const jobId = await quarantinedJob("memory");
    const ask = await req("POST", `/__jobs/${jobId}/release`, program(), {});
    const id = ask.json.approval.id;
    expect(ask.json.approval.requester.actor).toBe("process");
    expect((await req("POST", `/__approvals/${id}/cancel`, program(), {})).json.approval.state).toBe("cancelled");
  });
});

describe("A1-1 (harness S5): the server-only session key never leaves in JSON", () => {
  test("S5: tailnet Mehroz reads no sk1. key in /__approvals, /__jobs or /__memory; neither does anyone", async () => {
    const jobId = await quarantinedJob("voice");
    const ask = await req("POST", `/__jobs/${jobId}/release`, owner(), {});
    const id = ask.json.approval.id;
    const card = await req("POST", `/__approvals/${id}/card`, owner(), {});
    await req("POST", `/__approvals/${id}/decide`, owner(), { decision: "approve", evidence: { uiConfirm: true, cardNonce: card.json.cardNonce } });
    const paths = ["/__approvals?limit=50", `/__approvals/${id}`, "/__jobs?limit=50", `/__jobs/${jobId}`, "/__jobs/events?after=0", "/__memory/status", "/__memory/approvals", "/__memory/buckets"];
    for (const who of [mehroz(), owner(), program()])
      for (const path of paths) {
        const r = await req("GET", path, who);
        expect([path, r.status < 500, r.text.includes("sk1."), r.text.includes('"sessionId"'), r.text.includes('"deviceId"')]).toEqual([path, true, false, false, false]);
      }
    // The owner's real approval still names who asked and who approved (person, channel, actor).
    const a = (await req("GET", `/__approvals/${id}`, mehroz())).json.approval;
    expect(Object.keys(a.requester).sort()).toEqual(["actor", "personId", "via"]);
    expect(a.requester).toMatchObject({ personId: "usman", via: "loopback-owner", actor: "human" });
    expect(a.approver).toMatchObject({ personId: "usman", actor: "human" });
  });

  test("rows written before the fix (sessionId stored) are served without it", async () => {
    const legacy = new (await import("bun:sqlite")).Database(join(root, ".operator-data", "approvals.sqlite"));
    const r = approvals.request({ action: "file.delete", args: { path: "D:/tmp/legacy.txt" }, requester: { personId: "usman", via: "loopback-owner", actor: "human" }, summary: "Delete legacy.txt", origin: "principal" });
    if (!r.ok) throw new Error("request refused");
    legacy.query("UPDATE approvals SET requester=? WHERE id=?").run(JSON.stringify({ personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sk1.legacyLeakedKey000000" }), r.approval.id);
    legacy.close();
    const text = (await req("GET", "/__approvals?limit=200", mehroz())).text;
    expect(text).toContain(r.approval.id);
    expect(text).not.toContain("sk1.");
  });
});

describe("A1-2: the inline hub guards mean 'at the hub', not 'any verified founder'", () => {
  const vite = readFileSync(join(import.meta.dir, "..", "..", "vite.config.ts"), "utf8");

  test("isLoopback no longer resolves to 'any verified founder'", () => {
    const body = vite.slice(vite.indexOf("function isLoopback("), vite.indexOf("function isLoopback(") + 400);
    expect(body).not.toContain("isBrowserPrincipal");
    expect(body).toContain("isAtHub(req)");
  });

  test("every inline guard matches the B1 table: hub guards on local-owner routes, founder reads on READ_SHARED ones", () => {
    const mount = /server\.middlewares\.use\("(\/__[^"]+)",/g;
    const found: { path: string; guard: string }[] = [];
    for (const m of vite.matchAll(mount)) {
      const after = vite.slice(m.index!, m.index! + 900);
      const next = after.indexOf("server.middlewares.use(", 10);
      const block = next > 0 ? after.slice(0, next) : after;
      const g = /if \(!(isLoopback|isAtHub|founderMayRead)\(req\)/.exec(block);
      if (g) found.push({ path: m[1], guard: g[1] });
    }
    expect(found.length).toBeGreaterThan(80);
    for (const { path, guard } of found) {
      const rule = routeRule(path);
      if (guard === "founderMayRead") expect([path, rule.read, rule.write]).toEqual([path, "shared", "local-owner"]);
      // /__design_cost is SHARED in the table but has always also required the internal token (unchanged).
      else if (path !== "/__design_cost") expect([path, rule.read, rule.write]).toEqual([path, "local-owner", "local-owner"]);
    }
  });

  test("requestAtHub: only the owner at this PC; founderMayRead: founders read, only the hub writes", async () => {
    const gate: Record<string, any> = await import("./gate");
    expect(typeof gate.requestAtHub).toBe("function");
    expect(typeof gate.founderMayRead).toBe("function");
    const ctx = { root, store, tailnetName: TAILNET, servePeer: SIMULATED, tailnet: TAILNET_STATUS };
    const sock = { remoteAddress: "127.0.0.1" };
    const at = (headers: Record<string, string>, method = "GET") => ({ socket: sock, headers, method, url: "/" });
    const hub = at({ host: "127.0.0.1:8081" });
    const remote = at({ host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN.mehroz, "x-forwarded-for": "100.64.0.9" });
    const remoteUsman = at({ host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN.usman, "x-forwarded-for": "100.64.0.9" });
    expect(gate.requestAtHub(hub, ctx)).toBe(true);
    expect(gate.requestAtHub(remote, ctx)).toBe(false);
    expect(gate.requestAtHub(remoteUsman, ctx)).toBe(false);
    expect(gate.founderMayRead(remote, ctx)).toBe(true);
    expect(gate.founderMayRead({ ...remote, method: "POST" }, ctx)).toBe(false);
    expect(gate.founderMayRead({ ...hub, method: "POST" }, ctx)).toBe(true);
  });
});

describe("A1-4: /__operator connector syncs and hub sign-ins run only at the hub", () => {
  const hubOnly = ["/connections/start", "/connections/disconnect", "/connections/configure", "/connections/skool/connect", "/memory/apps/sync-all", "/memory/apps/refresh-settings", "/memory/apps/gmail/sync", "/memory/apps/gmail", "/memory/import-local", "/memory/import-notion", "/memory/notion-config", "/memory/granola-config", "/native-connections/sync", "/calendar/native/sync", "/calendar/native/disconnect", "/setup/open-privacy", "/models/refresh", "/mail-archive/sync", "/mail-archive/pause", "/mail-archive/provider-search"];

  test("a remote founder is refused every hub-side spawn and sign-in route, with nothing run", async () => {
    for (const path of hubOnly) {
      const r = await req("POST", `/__operator${path}`, mehroz(), {});
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.json.error).toContain("only for Usman at the PC");
    }
  });

  test("T8c: no GET starts a provider check: ?refresh=1 is ignored, whoever asks (a check would say checking:true)", async () => {
    for (const path of ["/models?refresh=1", "/models?snapshot=1&refresh=1"]) {
      for (const who of [owner(), mehroz()]) {
        const r = await req("GET", `/__operator${path}`, who);
        expect([path, r.status, r.json.checking]).toEqual([path, 200, false]);
      }
    }
  });

  test("the owner at this PC still reaches them; Mehroz keeps the shared operator routes", async () => {
    const r = await req("POST", "/__operator/memory/apps/refresh-settings", owner(), { enabled: false });
    expect(r.status).not.toBe(403);
    expect((await req("GET", "/__operator/memory/apps", mehroz())).status).toBe(200);
    expect((await req("GET", "/__operator/state", mehroz())).status).toBe(200);
  });

  test("REVIEW-S1 F4: syncing a connected account stays shared (only connect/configure/disconnect are hub-only)", async () => {
    for (const path of ["/connections/sync", "/connections/skool/sync"]) {
      const r = await req("POST", `/__operator${path}`, mehroz(), { provider: "google" });
      expect([path, r.status === 403 && String(r.json?.error ?? "").includes("only for Usman at the PC")]).toEqual([path, false]);
    }
  });
});

// Last: S2 logs the owner's browser out on the unfixed build, which would mask the scenarios above.
describe("A1-7 (harness S2): forged navigations can't evict the owner's real session", () => {
  test("S2: twelve forged navigations later, the owner's browser is still a human session", async () => {
    for (let i = 0; i < 12; i++) await fetch(base + "/", { headers: { ...local(), ...nav } });
    expect((await req("GET", "/__devices/me", owner())).json.principal.actor).toBe("human");
  });

  test("store: pending and confirmed hub sessions are capped apart; first use is trusted once; renewal near the end", () => {
    let t = 1_000_000;
    const dir = mkdtempSync(join(tmpdir(), "s1-store-"));
    try {
      const s = new DeviceStore(dir, { now: () => t });
      const first = s.mintHubSession("This PC's browser");
      expect(first.session.pending).toBeUndefined(); // a fresh install: trusted on first use
      for (let i = 0; i < 20; i++) expect(s.mintHubSession("This PC's browser").session.pending).toBe(true);
      const live = s.sessions("usman").filter((x) => x.via === "hub" && !x.revokedAt);
      expect(live.filter((x) => x.pending).length).toBe(4);
      expect(live.filter((x) => !x.pending).map((x) => x.id)).toEqual([first.session.id]);
      // Not yet near its end: no renewal. Within the last 10 days: a fresh confirmed session replaces it.
      expect(s.renewHubSession(first.session)).toBeNull();
      t += 25 * 24 * 60 * 60 * 1000;
      const renewed = s.renewHubSession(s.verifySession(first.cookie)!)!;
      expect(renewed.session.pending).toBeUndefined();
      expect(s.verifySession(first.cookie)).toBeNull();
      expect(s.verifySession(renewed.cookie)?.id).toBe(renewed.session.id);
      // A pending session is never renewed into a confirmed one.
      const p = s.mintHubSession("This PC's browser");
      t += 25 * 24 * 60 * 60 * 1000;
      expect(s.renewHubSession(s.verifySession(p.cookie)!)).toBeNull();
      // A store from before the fix (confirmed hub rows, no trust flag): the next navigation is pending, and
      // trust is recorded so pruning those rows later can't re-arm trust on first use.
      const legacyDir = join(dir, "legacy");
      mkdirSync(join(legacyDir, ".operator-data"), { recursive: true });
      const old = new DeviceStore(legacyDir, { now: () => t });
      old.mintSession("usman", "This PC's browser", "hub");
      const file = JSON.parse(readFileSync(old.file, "utf8"));
      delete file.hubTrustedAt;
      writeFileSync(old.file, JSON.stringify(file));
      expect(old.mintHubSession("This PC's browser").session.pending).toBe(true);
      expect(typeof JSON.parse(readFileSync(old.file, "utf8")).hubTrustedAt).toBe("number");
      // Wrong confirm codes count against this pending session (REVIEW-S1 R2-2): the third revokes it, so
      // even a good code can't confirm it afterwards.
      const good = s.createCode("usman", "hub", "usman").code;
      expect(s.confirmHubSession(p.session.id, "AAAA-AAAA").ok).toBe(false);
      expect(s.confirmHubSession(p.session.id, "AAAA-AAAA").ok).toBe(false);
      expect(s.confirmHubSession(p.session.id, "AAAA-AAAA")).toMatchObject({ ok: false, reason: expect.stringContaining("Too many") });
      for (let i = 0; i < 2; i++) expect(s.confirmHubSession(p.session.id, "AAAA-AAAA").ok).toBe(false);
      expect(s.confirmHubSession(p.session.id, good)).toMatchObject({ ok: false, reason: expect.stringContaining("ended") });
      expect(s.verifySession(p.cookie)).toBeNull();
      // A pairing code for a browser or companion never confirms a hub session.
      t += CODE_LOCK_MS + 1;
      expect(s.confirmHubSession(p.session.id, s.createCode("usman", "browser", "usman").code).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

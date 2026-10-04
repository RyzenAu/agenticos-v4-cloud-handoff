import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { signAssertion } from "./assertion";
import { readAudit } from "./audit";
import { runCli } from "./cli";
import { ASSERTION_HEADER, FILES, LIMITS, SESSION_COOKIE_NAME, VIA_VALUE } from "./config";
import { NEVER } from "./policy";
import { freePort, startRigHub, type RigHub } from "./test-rig";
import { writeUiManifest } from "./ui";

/**
 * End to end: the REAL gateway (a spawned `bun scripts/gateway/main.ts`) in front of a throwaway hub built from the hub's
 * real identity gate, gateway trust, /__gateway routes and /__events stream (test-rig.ts). Ephemeral loopback ports, torn
 * down at the end. Nothing here touches a real hub, a tailnet or the internet.
 */

const REPO = resolve(import.meta.dir, "..", "..");
let hub: RigHub;
let port = 0;
let origin = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
const output: string[] = [];
/** Everything secret this run handled, to prove none of it is ever written down. */
const secrets: string[] = [];
let ipCounter = 10;
const nextIp = () => `203.0.113.${ipCounter++}`;
let uiDir = "";
const SHELL = "<!doctype html><title>RIG-SHELL-MARKER</title><script type=\"module\">import(\"/assets/app-abc123.js\")</script>";

/** A small built-UI bundle in the shape build-ui.ts produces: a shell, hashed assets, a public file, a map and a dot file. */
function makeUiFixture(dir: string) {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "_shell.html"), SHELL);
  writeFileSync(join(dir, "assets", "app-abc123.js"), "export const RIG_ASSET = 1;\nfetch('/__version');\n");
  writeFileSync(join(dir, "assets", "app-abc123.js.map"), '{"sources":["SOURCE-MAP-MARKER"]}');
  writeFileSync(join(dir, "assets", "app-abc123.css"), "body{color:red}");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, ".hidden"), "HIDDEN-MARKER");
  writeUiManifest(dir, null, ["/", "/leads", "/memory", "/skills", "/coding/$jobId"]);
  // Written AFTER the manifest: on disk, inside the bundle, but not listed, so never served.
  writeFileSync(join(dir, "assets", "unlisted.js"), "UNLISTED-MARKER");
}

async function startGatewayProcess() {
  proc = Bun.spawn([process.execPath, "scripts/gateway/main.ts"], {
    cwd: REPO,
    env: { ...process.env, MU_DATA_DIR: hub.dataDir, MU_GATEWAY_PORT: String(port), MU_GATEWAY_UPSTREAM: hub.origin, MU_GATEWAY_PUBLIC_ORIGIN: origin, MU_GATEWAY_FORWARDED_FOR: "1", MU_GATEWAY_RECHECK_MS: "100", MU_GATEWAY_TRUST: "", MU_GATEWAY_UI_DIR: uiDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const s of [proc.stdout, proc.stderr])
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of s as ReadableStream<Uint8Array>) output.push(decoder.decode(chunk));
    })();
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${origin}/gw/health`);
      if (r.status === 200 || r.status === 503) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  throw new Error("the gateway did not start");
}
async function stopGatewayProcess() {
  proc?.kill();
  await proc?.exited;
  proc = null;
}

const cli = (...argv: string[]) => {
  const lines: string[] = [];
  const code = runCli(argv, hub.dir, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
};
function mintCode(...extra: string[]) {
  const out = cli("enrol-code", "--by", "usman", ...extra).text;
  const code = /code for Dot: ([A-Z0-9-]+)/.exec(out)![1];
  secrets.push(code, code.replace(/-/g, ""));
  return code;
}

type Call = { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown; ip?: string; raw?: string };
async function gw(path: string, call: Call = {}) {
  const headers: Record<string, string> = { "X-Forwarded-For": call.ip ?? "203.0.113.5", ...(call.cookie ? { Cookie: `${SESSION_COOKIE_NAME}=${call.cookie}` } : {}), ...(call.headers ?? {}) };
  let body: string | undefined;
  if (call.raw !== undefined) body = call.raw;
  else if (call.body !== undefined) {
    body = JSON.stringify(call.body);
    headers["Content-Type"] ??= "application/json";
  }
  return await fetch(origin + path, { method: call.method ?? "GET", headers, body, redirect: "manual" });
}
const cookieFrom = (res: Response) => {
  const m = new RegExp(`${SESSION_COOKIE_NAME}=([A-Za-z0-9_-]{43})`).exec(res.headers.getSetCookie().join("\n"));
  if (m) secrets.push(m[1]);
  return m ? m[1] : null;
};
async function enrolWith(code: string, ip = nextIp()) {
  return await gw("/gw/enrol", { method: "POST", ip, headers: { Origin: origin, "X-MU-Gateway-Enrol": "1" }, body: { code } });
}
async function signIn(...codeFlags: string[]): Promise<string> {
  const res = await enrolWith(mintCode(...codeFlags));
  expect(res.status).toBe(200);
  return cookieFrom(res)!;
}
async function csrf(cookie: string) {
  const token = ((await (await gw("/__token", { cookie })).json()) as { token: string }).token;
  secrets.push(token);
  return token;
}
/** A same-origin write as the page would send it. May return a rotated cookie. */
async function write(cookie: string, method: string, path: string, body?: unknown, token?: string) {
  return await gw(path, { method, cookie, headers: { Origin: origin, "X-Claude-OS-Token": token ?? (await csrf(cookie)) }, body });
}

/** One raw HTTP/1.1 exchange, for request lines and headers `fetch` will not send. */
async function raw(request: string): Promise<{ status: number; head: string; body: string }> {
  return await new Promise((resolvePromise) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    const done = () => {
      socket.destroy();
      const [head, ...rest] = text.split("\r\n\r\n");
      resolvePromise({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), head, body: rest.join("\r\n\r\n") });
    };
    socket.setTimeout(1500, done);
    socket.on("data", (d) => (text += d.toString()));
    socket.on("end", done);
    socket.on("error", done);
    socket.on("connect", () => socket.write(request));
  });
}
const host = () => `127.0.0.1:${port}`;
const upgradeRequest = (path: string, extra: string[] = []) =>
  [`GET ${path} HTTP/1.1`, `Host: ${host()}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "X-Forwarded-For: 203.0.113.5", ...extra, "", ""].join("\r\n");

/** Read an SSE response as parsed frames until `until` says stop, the stream ends, or the time runs out. */
async function readSse(res: Response, until: (frames: Array<{ id?: string; event?: string; data?: string }>) => boolean, ms = 4000) {
  const frames: Array<{ id?: string; event?: string; data?: string }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(frames)) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (next === null) break;
    if (next.done) {
      ended = true;
      break;
    }
    buffer += decoder.decode(next.value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut < 0) break;
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const frame: { id?: string; event?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      if (frame.event || frame.data) frames.push({ event: frame.event ?? "message", ...frame });
    }
  }
  return { frames, ended, reader };
}
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return false;
};
const hubSaw = (predicate: (url: string) => boolean) => hub.seen.filter((s) => predicate(s.url));

beforeAll(async () => {
  hub = await startRigHub();
  uiDir = join(hub.root, "ui");
  makeUiFixture(uiDir);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  await startGatewayProcess();
}, 60_000);

afterAll(async () => {
  await stopGatewayProcess();
  await hub.close();
}, 30_000);

describe("anonymous and expired sessions are denied everywhere", () => {
  test("anonymous: a page, an API, an asset, the event stream and a WebSocket all get 401, and nothing reaches the hub", async () => {
    const before = hub.seen.length;
    const pageRes = await gw("/leads", { headers: { Accept: "text/html" } });
    expect(pageRes.status).toBe(401);
    expect(await pageRes.text()).toContain("Sign in to Agentic OS");
    expect(pageRes.headers.get("content-security-policy")).toContain("default-src 'none'");
    for (const p of ["/__operator/leads/list", "/assets/app-abc123.js", "/src/main.tsx", "/__events", "/__gateway/me", "/__token", "/gw/me", "/gw/test-update", "/__version"]) {
      const r = await gw(p);
      expect([p, r.status]).toEqual([p, 401]);
      expect(((await r.json()) as { signIn?: string }).signIn).toBe("/gw/enrol");
    }
    expect((await raw(upgradeRequest("/__computers/bot-1/vnc", [`Origin: ${origin}`]))).status).toBe(401);
    for (const cookie of ["garbage", "A".repeat(43)]) expect((await gw("/__version", { cookie })).status).toBe(401);
    expect(hub.seen.length).toBe(before);
  });

  test("an expired session is denied for a page, an API, an asset, the stream and a WebSocket; its open stream is closed", async () => {
    const cookie = await signIn("--session-minutes", "0.05"); // three seconds, absolute
    expect((await gw("/__version", { cookie })).status).toBe(200);
    const stream = await gw("/__events", { cookie });
    expect(stream.status).toBe(200);
    const first = await readSse(stream, (f) => f.some((x) => x.event === "snapshot"));
    expect(first.frames.map((f) => f.event)).toEqual(["hello", "snapshot"]);
    // The stream is ended from the gateway's side when the session lapses.
    const rest = await readSse({ body: { getReader: () => first.reader } } as unknown as Response, () => false, 5000);
    expect(rest.ended).toBe(true);
    await Bun.sleep(200);
    const before = hub.seen.length;
    const pageRes = await gw("/leads", { cookie, headers: { Accept: "text/html" } });
    expect(pageRes.status).toBe(401);
    expect(pageRes.headers.getSetCookie().join()).toContain("Max-Age=0");
    for (const p of ["/__operator/leads/list", "/assets/app-abc123.js", "/__events", "/__token"]) expect([p, (await gw(p, { cookie })).status]).toEqual([p, 401]);
    expect((await raw(upgradeRequest("/__computers/bot-1/vnc", [`Origin: ${origin}`, `Cookie: ${SESSION_COOKIE_NAME}=${cookie}`]))).status).toBe(401);
    expect(hub.seen.length).toBe(before);
    expect(readAudit(hub.dir).some((e) => e.event === "stream-closed" && e.reason === "session-ended")).toBe(true);
  }, 20_000);

  test("an idle session lapses too", async () => {
    const cookie = await signIn("--idle-minutes", "0.03");
    expect((await gw("/__version", { cookie })).status).toBe(200);
    await Bun.sleep(2100);
    expect((await gw("/__version", { cookie })).status).toBe(401);
  }, 15_000);
});

describe("enrolment", () => {
  test("a code signs in once, sets a locked-down cookie, and cannot be used again", async () => {
    const code = mintCode();
    const res = await enrolWith(code);
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict$`));
    expect(await res.text()).not.toContain(cookieFrom(res)!);
    const again = await enrolWith(code);
    expect(again.status).toBe(401);
    expect(cookieFrom(again)).toBeNull();
    // Lower case and without dashes is the same code, and just as spent.
    expect((await enrolWith(code.toLowerCase().replace(/-/g, ""))).status).toBe(401);
  });

  test("an expired code is refused", async () => {
    const code = mintCode("--minutes", "0.02");
    await Bun.sleep(1400);
    expect((await enrolWith(code)).status).toBe(401);
  });

  test("the sign-in endpoint refuses a request that is not from its own page", async () => {
    const code = mintCode();
    const ip = nextIp();
    expect((await gw("/gw/enrol", { method: "POST", ip, headers: { "X-MU-Gateway-Enrol": "1" }, body: { code } })).status).toBe(403); // no Origin
    expect((await gw("/gw/enrol", { method: "POST", ip, headers: { Origin: "https://evil.example", "X-MU-Gateway-Enrol": "1" }, body: { code } })).status).toBe(403);
    expect((await gw("/gw/enrol", { method: "POST", ip, headers: { Origin: origin }, body: { code } })).status).toBe(403); // no custom header (a plain form post)
    expect((await gw("/gw/enrol", { method: "POST", ip, headers: { Origin: origin, "X-MU-Gateway-Enrol": "1", "Content-Type": "text/plain" }, raw: JSON.stringify({ code }) })).status).toBe(403);
    // None of those spent the code.
    expect((await enrolWith(code)).status).toBe(200);
  });

  test("lockout: five wrong codes from one address lock that address out, even for a right code; another address is unaffected", async () => {
    const ip = nextIp();
    for (let i = 0; i < LIMITS.enrolFailuresPerIp; i++) expect((await enrolWith(`WRONG-WRONG-WRONG-${i}${i}${i}${i}${i}`, ip)).status).toBe(401);
    const good = mintCode();
    const locked = await enrolWith(good, ip);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(cookieFrom(locked)).toBeNull();
    // The locked-out attempt did not spend the code; a different address signs in with it.
    expect((await enrolWith(good)).status).toBe(200);
    expect(readAudit(hub.dir).filter((e) => e.event === "enrol-failed" && e.reason === "locked-out").length).toBeGreaterThan(0);
  }, 15_000);

  test("per code: enough wrong guesses from ANY addresses burn the unused code, without locking the gateway", async () => {
    const victim = mintCode();
    // One wrong guess each from many addresses: no address is locked out, but the code has absorbed them all.
    for (let i = 0; i < LIMITS.enrolFailuresPerCode; i++) expect((await enrolWith(`WRONG-GUESS-NUMBR-${String(i).padStart(5, "0")}`, `198.51.100.${i + 1}`)).status).toBe(401);
    expect((await enrolWith(victim)).status).toBe(401);
    expect(readAudit(hub.dir).some((e) => e.event === "enrol-failed" && (e.reason ?? "").startsWith("code-burned"))).toBe(true);
    // A code made afterwards works at once: nothing is locked.
    expect((await enrolWith(mintCode())).status).toBe(200);
  }, 30_000);

  test("the sign-in endpoint is rate limited per address", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.enrolAttemptsPerIpPerMinute + 2; i++) statuses.push((await gw("/gw/enrol", { method: "POST", ip, headers: { Origin: origin, "X-MU-Gateway-Enrol": "1" }, body: {} })).status);
    expect(statuses.slice(-1)[0]).toBe(429);
  }, 15_000);
});

describe("a signed-in, read-only session", () => {
  let cookie = "";
  beforeAll(async () => {
    cookie = await signIn();
  });

  test("reads work: a page, a source module, a read API, who-am-I; the hub sees Dot and none of the browser's headers", async () => {
    const pageRes = await gw("/leads", { cookie, headers: { Accept: "text/html" } });
    expect(pageRes.status).toBe(200);
    // The page is the built SPA shell, served by the gateway itself: the hub is never asked for it.
    expect(await pageRes.text()).toBe(SHELL);
    expect(pageRes.headers.get("cache-control")).toBe("private, no-cache");
    const asset = await gw("/assets/app-abc123.js", { cookie });
    expect([asset.status, asset.headers.get("content-type"), asset.headers.get("cache-control")]).toEqual([200, "text/javascript; charset=utf-8", "private, max-age=31536000, immutable"]);
    expect(await asset.text()).toContain("RIG_ASSET");
    expect(hub.seen.some((s) => !s.url.startsWith("/__"))).toBe(false);
    const api = await gw("/__operator/leads/list?q=1", { cookie });
    expect(await api.json()).toEqual({ reached: "/__operator/leads/list?q=1", who: "dot", via: "gateway" });
    const me = (await (await gw("/gw/me", { cookie })).json()) as { person: string; capabilities: Array<{ name: string }> };
    expect(me.person).toBe("dot");
    expect(me.capabilities.map((c) => c.name)).toEqual(["view"]);
    const hubMe = await (await gw("/__gateway/me", { cookie })).json();
    expect(hubMe).toEqual({ person: "dot", via: "gateway", actor: "process", capabilities: ["view"], founder: false });
    // The principal the hub's handlers saw: Dot, a process, never the owner, never at the hub, never a human session.
    const last = hub.reached.at(-1)!;
    expect(last.principal).toMatchObject({ personId: "dot", via: "gateway", actor: "process", displayName: "Dot" });
    expect([last.atHub, last.human]).toEqual([false, false]);
  });

  test("Workspace: only the pipeline, websites and groups panels; the mail, call, enquiry, today and needs-you panels never reach the hub", async () => {
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("grant", cap, "--by", "usman");
    const mine = await signIn();
    for (const panel of ["pipeline", "websites", "groups"]) {
      const r = await gw(`/__workspace/${panel}`, { cookie: mine });
      expect([panel, r.status, await r.json()]).toEqual([panel, 200, { reached: `/__workspace/${panel}`, who: "dot", via: "gateway" }]);
    }
    const before = hub.seen.length;
    for (const path of ["/__workspace", "/__workspace/", "/__workspace/email", "/__workspace/receptionist", "/__workspace/enquiries", "/__workspace/call-queue", "/__workspace/today", "/__workspace/needs-you",
      "/__workspace/email/", "/__workspace/EMAIL", "/__workspace/email?fresh=1", "/__workspace/pipeline/../email", "/__workspace/pipeline%2f..%2femail", "/__workspace/email.", "/__workspace/email::$DATA", "/__workspace/anything-new"]) {
      const r = await gw(path, { cookie: mine });
      expect([path, [400, 403].includes(r.status)]).toEqual([path, true]);
    }
    expect(hub.seen.length).toBe(before);
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("revoke-grant", cap);
  });

  test("forged identity and forwarding headers from the browser never reach the hub, and change nothing", async () => {
    const forged = {
      "Tailscale-User-Login": "owner@example.test",
      "Tailscale-User-Name": "Usman",
      "X-MU-Local-Owner": "A".repeat(43),
      "X-MU-Person": "usman",
      "X-MU-Bridge": "1",
      "X-Forwarded-Host": "rig-hub.tail-test.ts.net",
      "X-Forwarded-Proto": "https",
      "X-Real-IP": "127.0.0.1",
      Forwarded: "for=127.0.0.1;host=localhost",
      Via: "1.1 someone-else",
      Authorization: "Bearer FORGED-BEARER",
      [ASSERTION_HEADER]: "v1.forged.forged",
      "X-Claude-OS-Token": "FORGED-PAGE-TOKEN",
    };
    const res = await gw("/__operator/leads/list?forged=1", { cookie, headers: forged });
    expect(await res.json()).toEqual({ reached: "/__operator/leads/list?forged=1", who: "dot", via: "gateway" });
    const arrived = hub.seen.filter((s) => s.url === "/__operator/leads/list?forged=1").at(-1)!.headers;
    expect(Object.keys(arrived).filter((h) => /^(tailscale-|x-forwarded-|x-real-ip|forwarded|authorization|cookie|x-mu-(?!gateway-assertion)|x-claude-os-token|origin|referer)/.test(h))).toEqual([]);
    expect(arrived.via).toBe(VIA_VALUE);
    expect(arrived[ASSERTION_HEADER]).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(arrived[ASSERTION_HEADER]).not.toContain("forged");
    // And what a handler could read after the gate: no assertion, no cookie, no credential.
    const handler = hub.reached.filter((r) => r.url === "/__operator/leads/list?forged=1").at(-1)!.headers;
    expect(Object.keys(handler).filter((h) => h === ASSERTION_HEADER || h === "cookie" || h === "authorization")).toEqual([]);
  });

  test("every mutation is refused while read-only, on every route, and none reaches the hub", async () => {
    const before = hub.seen.length;
    const targets = ["/__gateway/crm/activity", "/__gateway/crm/activity/gwact_0123456789abcdef", "/__operator/leads/edit", "/__operator/leads/log", "/__operator/coding/jobs", "/__computers/bot-1/takeover", "/__computers/bot-1/input", "/__agents/research", "/__jobs/abc/cancel", "/__approvals/abc/decide", "/__memory/save", "/__workspace/x", "/__events", "/", "/leads", "/assets/app-abc123.js", "/src/main.tsx", "/__brand_new"];
    // (A fresh session per route: one session's writes are rate limited to LIMITS.perSessionWritesPerMinute.)
    for (const path of targets) {
      const mine = await signIn();
      const token = await csrf(mine);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await write(mine, method, path, { any: "thing" }, token);
        // A /__ route without the capability: 403. The UI's own paths are GET-only files: 404.
        expect([method, path, r.status]).toEqual([method, path, path.startsWith("/__") ? 403 : 404]);
      }
    }
    expect(hub.seen.length).toBe(before);
    // The refusal names the capability a founder would have to grant, where there is one.
    expect(((await (await write(cookie, "POST", "/__gateway/crm/activity", {})).json()) as { error: string }).error).toContain("crm.write");
  }, 30_000);

  test("the NEVER list is refused with EVERY capability granted", async () => {
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("grant", cap, "--by", "usman");
    const before = hub.seen.length;
    let mine = await signIn();
    let token = await csrf(mine);
    let writes = 0;
    for (const n of NEVER) {
      if (n.path === "/__token") continue; // answered by the gateway itself with its own CSRF token, never forwarded
      if (n.method !== "GET" && ++writes % 40 === 0) {
        mine = await signIn();
        token = await csrf(mine);
      }
      const r = n.method === "GET" ? await gw(n.path, { cookie: mine }) : await write(mine, n.method, n.path, {}, token);
      expect([n.method, n.path, r.status]).toEqual([n.method, n.path, 403]);
    }
    expect(hub.seen.length).toBe(before);
    expect(hubSaw((u) => u.startsWith("/__token")).length).toBe(0);
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("revoke-grant", cap);
  }, 20_000);

  test("CSRF and Origin: a write without the token, with a wrong token, or from another origin is refused before anything else", async () => {
    cookie = await signIn();
    cli("grant", "crm.write", "--by", "usman");
    const rotated = cookieFrom(await gw("/gw/me", { cookie }));
    expect(rotated).not.toBeNull();
    cookie = rotated!;
    const token = await csrf(cookie);
    const body = { ref: { kind: "company", id: "csrf-test" }, eventId: "csrf-test:1", kind: "note", title: "should never be written" };
    const before = hub.seen.length;
    const attempts: Array<[string, Record<string, string>]> = [
      ["no token", { Origin: origin }],
      ["wrong token", { Origin: origin, "X-Claude-OS-Token": "x".repeat(43) }],
      ["another session's token is not this one's", { Origin: origin, "X-Claude-OS-Token": token.split("").reverse().join("") }],
      ["no Origin", { "X-Claude-OS-Token": token }],
      ["foreign Origin", { Origin: "https://evil.example", "X-Claude-OS-Token": token }],
      ["cross-site fetch metadata", { Origin: origin, "X-Claude-OS-Token": token, "Sec-Fetch-Site": "cross-site" }],
      ["same-site (another port or subdomain)", { Origin: origin, "X-Claude-OS-Token": token, "Sec-Fetch-Site": "same-site" }],
    ];
    for (const [label, headers] of attempts) expect([label, (await gw("/__gateway/crm/activity", { method: "POST", cookie, headers, body })).status]).toEqual([label, 403]);
    // A cross-site GET is refused too (no reading through a foreign page).
    expect((await gw("/__version", { cookie, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await gw("/__version", { cookie, headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(hub.seen.length).toBe(before);
    cli("revoke-grant", "crm.write");
    const back = cookieFrom(await gw("/gw/me", { cookie }));
    expect(back).not.toBeNull();
    cookie = back!;
  });

  test("body size limit", async () => {
    cli("grant", "crm.write", "--by", "usman");
    try {
      const fresh = await signIn();
      const before = hub.seen.length;
      const big = await gw("/__gateway/crm/activity", { method: "POST", cookie: fresh, headers: { Origin: origin, "X-Claude-OS-Token": await csrf(fresh), "Content-Type": "application/json" }, raw: JSON.stringify({ pad: "x".repeat(LIMITS.maxBodyBytes + 10_000) }) });
      expect(big.status).toBe(413);
      expect(hub.seen.length).toBe(before);
    } finally {
      cli("revoke-grant", "crm.write");
    }
  });

  test("responses: the hub's cookies and banners are dropped, redirects never name the hub, security headers are set", async () => {
    const res = await gw("/__version", { cookie });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("server")).not.toBe("rig-hub");
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("permissions-policy")).toContain("microphone=()");
    const redirect = await gw("/__agents/redirect", { cookie });
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, "/__agents/landing?x=1"]);
    expect(redirect.headers.getSetCookie()).toEqual([]);
    expect((await gw("/__agents/redirect-relative", { cookie })).headers.get("location")).toBe("/__agents/landing");
    const out = await gw("/__agents/redirect-out", { cookie });
    expect([out.status, out.headers.get("location")]).toEqual([502, null]);
    for (const r of [res, redirect, out]) expect(JSON.stringify([...r.headers])).not.toContain(String(hub.port));
  });

  test("logout ends the session at once", async () => {
    const mine = await signIn();
    expect((await gw("/gw/logout", { method: "POST", cookie: mine })).status).toBe(403); // logout is a write: Origin and CSRF
    const out = await write(mine, "POST", "/gw/logout");
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join()).toContain("Max-Age=0");
    expect((await gw("/__version", { cookie: mine })).status).toBe(401);
  });
});

describe("the hub's own trust boundary", () => {
  test("an unsigned or forged call straight to the hub is nobody: a person header, the gateway's Via, or a made-up assertion are useless", async () => {
    const direct = (headers: Record<string, string>, path = "/__operator/leads/list") => fetch(hub.origin + path, { headers: { ...headers, "X-Test-Direct": "1" } });
    for (const headers of [
      {},
      { "X-MU-Person": "dot" },
      { "X-Gateway-User": "dot", Via: VIA_VALUE },
      { Via: VIA_VALUE, "X-Forwarded-User": "dot" },
      { Via: VIA_VALUE, [ASSERTION_HEADER]: "v1.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { Via: VIA_VALUE, [ASSERTION_HEADER]: signAssertion("not-the-real-key".repeat(4), { method: "GET", target: "/__operator/leads/list", sessionId: "ab".repeat(12), caps: ["view"] }) },
      { [ASSERTION_HEADER]: "junk" },
    ] as Array<Record<string, string>>) {
      const r = await direct(headers);
      expect([JSON.stringify(Object.keys(headers)), r.status]).toEqual([JSON.stringify(Object.keys(headers)), 401]);
    }
    for (const p of ["/__gateway/me", "/__events", "/__workspace"]) expect([p, (await direct({ "X-MU-Person": "dot", Via: VIA_VALUE }, p)).status]).toEqual([p, 401]);
  });

  test("a replayed assertion is rejected, on the same request and on any other", async () => {
    const cookie = await signIn();
    expect((await gw("/__operator/leads/list?replay=1", { cookie })).status).toBe(200);
    const captured = hub.seen.filter((s) => s.url === "/__operator/leads/list?replay=1").at(-1)!.headers[ASSERTION_HEADER];
    secrets.push(captured);
    const replay = (path: string, method = "GET") => fetch(hub.origin + path, { method, headers: { Via: VIA_VALUE, [ASSERTION_HEADER]: captured, "X-Test-Direct": "1" } });
    expect((await replay("/__operator/leads/list?replay=1")).status).toBe(401); // the nonce is spent
    expect((await replay("/__operator/leads/list?replay=2")).status).toBe(401); // bound to the target
    expect((await replay("/__gateway/crm/activity", "POST")).status).toBe(401); // and to the method
    expect((await replay("/__hermes_cmd", "POST")).status).toBe(401);
  });
});

describe("streams and sockets", () => {
  test("SSE passes through, resumes from Last-Event-ID without duplicates, and is closed on revocation", async () => {
    const cookie = await signIn();
    const sessionId = ((await (await gw("/gw/me", { cookie })).json()) as { session: { id: string } }).session.id;
    const first = await gw("/__events", { cookie, headers: { Accept: "text/event-stream" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const opening = await readSse(first, (f) => f.some((x) => x.event === "snapshot"));
    expect(JSON.parse(opening.frames[0].data!).mode).toBe("snapshot");
    // Dot's snapshot is cut to coding jobs: no memory or trigger jobs, no approvals, computers or devices.
    const snap = JSON.parse(opening.frames.find((f) => f.event === "snapshot")!.data!);
    expect([snap.jobs, snap.approvals, snap.computers, snap.devices]).toEqual([[{ id: "j-coding", kind: "coding" }], [], [], []]);
    expect(await (await gw("/__events/snapshot", { cookie })).json()).toMatchObject({ jobs: [{ id: "j-coding", kind: "coding" }], approvals: [], computers: [], devices: [] });
    const coding = (n: unknown, scope: "shared" | "usman" = "shared") => hub.bus.publish({ topic: "job", type: "step", scope, tag: "coding", data: { n } });
    coding(1);
    coding("a founder's own event", "usman");
    // Shared events Dot's topic allow-list leaves out: other job kinds, approvals (merge, deploy), computers, leases, agent and Jarvis chatter.
    hub.bus.publish({ topic: "job", type: "step", scope: "shared", tag: "memory", data: { n: "memory job" } });
    hub.bus.publish({ topic: "job", type: "step", scope: "shared", tag: "trigger", data: { n: "trigger job" } });
    hub.bus.publish({ topic: "job", type: "step", scope: "shared", data: { n: "a job of unknown kind" } });
    hub.bus.publish({ topic: "approval", type: "pending", scope: "shared", data: { n: "deploy approval" } });
    hub.bus.publish({ topic: "computer", type: "changed", scope: "shared", data: { n: "computer" } });
    hub.bus.publish({ topic: "lease", type: "taken", scope: "shared", data: { n: "lease" } });
    hub.bus.publish({ topic: "agent", type: "message", scope: "shared", data: { n: "agent message" } });
    hub.bus.publish({ topic: "jarvis", type: "status", scope: "shared", data: { n: "jarvis" } });
    coding(2);
    const live = await readSse({ body: { getReader: () => opening.reader } } as unknown as Response, (f) => f.length >= 2);
    await Bun.sleep(150);
    // Dot receives shared CODING job events only: never a founder's own, never another topic.
    expect(live.frames.map((f) => JSON.parse(f.data!).data.n)).toEqual([1, 2]);
    const lastId = live.frames[1].id!;
    await opening.reader.cancel();
    expect(await waitFor(() => hub.openStreams() === 0)).toBe(true);

    coding(3);
    hub.bus.publish({ topic: "approval", type: "pending", scope: "shared", data: { n: "missed while away, and still not Dot's" } });
    coding(4);
    const second = await gw("/__events", { cookie, headers: { "Last-Event-ID": lastId } });
    const resumed = await readSse(second, (f) => f.filter((x) => x.event !== "hello").length >= 2);
    expect(JSON.parse(resumed.frames[0].data!).mode).toBe("replay");
    // Exactly the two missed events: nothing before the resume point is sent again.
    expect(resumed.frames.filter((f) => f.event !== "hello").map((f) => JSON.parse(f.data!).data.n)).toEqual([3, 4]);
    // The `?last=` form (a client that reconnects by hand) resumes the same way.
    const third = await gw(`/__events?last=${encodeURIComponent(lastId)}`, { cookie });
    const viaQuery = await readSse(third, (f) => f.filter((x) => x.event !== "hello").length >= 2);
    expect(viaQuery.frames.filter((f) => f.event !== "hello").map((f) => JSON.parse(f.data!).data.n)).toEqual([3, 4]);
    await viaQuery.reader.cancel();

    // Revocation: the open stream ends within about a second, the hub's side is released, and the cookie is dead.
    const t0 = Date.now();
    expect(cli("revoke-session", sessionId).code).toBe(0);
    const after = await readSse({ body: { getReader: () => resumed.reader } } as unknown as Response, () => false, 3000);
    expect(after.ended).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitFor(() => hub.openStreams() === 0)).toBe(true);
    expect((await gw("/__events", { cookie })).status).toBe(401);
    expect((await gw("/__version", { cookie })).status).toBe(401);
  }, 30_000);

  test("WebSocket: there is none for the gateway. Every upgrade is refused at the gateway, with every capability, and none reaches the hub", async () => {
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("grant", cap, "--by", "mehroz");
    const cookie = await signIn();
    const before = hub.seen.length;
    for (const p of ["/__computers/bot-1/vnc", "/__events", "/__computers/bot-1/viewer", "/__gateway/me", "/", "/leads"]) {
      const r = await raw(upgradeRequest(p, [`Origin: ${origin}`, `Cookie: ${SESSION_COOKIE_NAME}=${cookie}`]));
      // (A UI path is never a socket: 404. A /__ route: no WebSocket rule exists, 403.)
      expect([p, r.status]).toEqual([p, p.startsWith("/__") ? 403 : 404]);
    }
    // And a client library sees a refused connection, not an open socket.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__computers/bot-1/vnc`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}`, Origin: origin } } as never);
    let opened = false;
    ws.onopen = () => (opened = true);
    await waitFor(() => ws.readyState === WebSocket.CLOSED, 3000);
    expect(opened).toBe(false);
    expect(hub.seen.length).toBe(before);
    expect(hub.socketPrincipals.length).toBe(0);
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("revoke-grant", cap);
  }, 30_000);
});

describe("crm.write, end to end", () => {
  test("the reversible test update: create, verify, create again (no duplicate), remove, verify gone; recorded as Dot", async () => {
    let cookie = await signIn();
    const sessionId = ((await (await gw("/gw/me", { cookie })).json()) as { session: { id: string } }).session.id;
    const body = { ref: { kind: "company", id: "gateway-test" }, eventId: "dot-gateway-test:e2e-1", kind: "note", title: "Gateway test note (safe to remove) BODY-MARKER-7f3a" };
    // Read-only: refused, nothing written.
    expect((await write(cookie, "POST", "/__gateway/crm/activity", body)).status).toBe(403);
    expect(existsSync(join(hub.dir, FILES.activities))).toBe(false);

    cli("grant", "crm.write", "--by", "usman", "--hours", "1");
    // Privilege changed: the very next response rotates the cookie.
    const me = await gw("/gw/me", { cookie });
    const rotated = cookieFrom(me);
    expect(rotated).not.toBeNull();
    expect(rotated).not.toBe(cookie);
    expect(((await me.json()) as { capabilities: Array<{ name: string; grantedBy: string | null }> }).capabilities).toContainEqual(expect.objectContaining({ name: "crm.write", grantedBy: "usman" }));
    cookie = rotated!;

    const created = await write(cookie, "POST", "/__gateway/crm/activity", body);
    expect(created.status).toBe(200);
    const receipt = (await created.json()) as { ok: boolean; activityId: string; href: string; created: boolean };
    expect(receipt).toMatchObject({ ok: true, created: true });
    expect(created.headers.get("x-mu-record-ids")).toBeNull(); // the hub's audit hint is not passed to the browser

    const verify = (await (await gw(`/__gateway/crm/activity?eventId=${encodeURIComponent(body.eventId)}`, { cookie })).json()) as { activity: Record<string, unknown> };
    expect(verify.activity).toMatchObject({ activityId: receipt.activityId, eventId: body.eventId, test: true, store: "gateway-test", by: { agent: "dot", session: sessionId, delegatedBy: "usman" } });
    // The hub's own record attributes it to Dot, not to a founder.
    const stored = JSON.parse(readFileSync(join(hub.dir, FILES.activities), "utf8")) as Array<{ by: Record<string, string> }>;
    expect(stored.map((r) => r.by.agent)).toEqual(["dot"]);
    expect(JSON.stringify(stored)).not.toMatch(/"personId":"(usman|mehroz)"/);

    const again = (await (await write(cookie, "POST", "/__gateway/crm/activity", body)).json()) as { activityId: string; created: boolean };
    expect(again).toMatchObject({ activityId: receipt.activityId, created: false });
    expect((JSON.parse(readFileSync(join(hub.dir, FILES.activities), "utf8")) as unknown[]).length).toBe(1);

    // crm.write is CRM mutations only: it opens no other write.
    for (const [m, p] of [["POST", "/__operator/coding/jobs"], ["POST", "/__computers/bot-1/takeover"], ["POST", "/__memory/save"], ["POST", "/__approvals/abc/decide"], ["PUT", "/__gateway/crm/activity"]] as const)
      expect([m, p, (await write(cookie, m, p, {})).status]).toEqual([m, p, 403]);
    expect((await write(cookie, "POST", "/__gateway/crm/activity", { ref: { kind: "nonsense", id: "x" }, eventId: "bad", kind: "note", title: "x" })).status).toBe(400);

    const removed = await write(cookie, "DELETE", `/__gateway/crm/activity/${receipt.activityId}`);
    expect(removed.status).toBe(200);
    expect(((await (await gw(`/__gateway/crm/activity?eventId=${encodeURIComponent(body.eventId)}`, { cookie })).json()) as { activity: unknown }).activity).toBeNull();
    expect(JSON.parse(readFileSync(join(hub.dir, FILES.activities), "utf8"))).toEqual([]);

    // The audit: every line is Dot's, with the capability, the route template, the record id and who delegated.
    const mine = readAudit(hub.dir).filter((e) => e.session === sessionId);
    expect(mine.every((e) => e.person === "dot")).toBe(true);
    const writes = mine.filter((e) => e.event === "request" && e.capability === "crm.write" && e.outcome === "allowed");
    expect(writes.map((e) => [e.method, e.route, e.status, e.recordIds, e.delegatedBy])).toEqual([
      ["POST", "/__gateway/crm/activity", 200, [receipt.activityId], "usman"],
      ["POST", "/__gateway/crm/activity", 200, [receipt.activityId], "usman"],
      ["POST", "/__gateway/crm/activity", 400, undefined, "usman"],
      ["DELETE", "/__gateway/crm/activity/*", 200, [receipt.activityId], "usman"],
    ]);
    expect(mine.some((e) => e.event === "session-rotated" && e.reason === "privilege-change")).toBe(true);
    expect(mine.filter((e) => e.outcome === "denied" && e.reason === "capability").length).toBeGreaterThan(0);

    // Revoking the grant takes effect on the next request.
    cli("revoke-grant", "crm.write");
    expect((await write(cookie, "POST", "/__gateway/crm/activity", { ...body, eventId: "dot-gateway-test:e2e-2" })).status).toBe(403);
    expect(JSON.parse(readFileSync(join(hub.dir, FILES.activities), "utf8"))).toEqual([]);
  }, 30_000);
});

describe("not a proxy", () => {
  test("absolute-form targets, foreign Hosts, traversal and encoded tricks never choose a destination or reach a forbidden path", async () => {
    const cookie = await signIn();
    const withCookie = [`Cookie: ${SESSION_COOKIE_NAME}=${cookie}`, "X-Forwarded-For: 203.0.113.5", "Connection: close"];
    const req = (line: string, hostHeader: string, extra: string[] = withCookie) => raw([line, `Host: ${hostHeader}`, ...extra, "", ""].join("\r\n"));
    const before = hub.seen.length;
    const refused: Array<[string, number]> = [];
    const attempt = async (label: string, line: string, hostHeader = host(), harmless?: string) => {
      const r = await req(line, hostHeader);
      refused.push([label, r.status]);
      // Refused, or (only where `harmless` says so) answered from the one fixed upstream with the plain path of the request.
      if (harmless && r.status === 200) expect([label, r.body]).toEqual([label, expect.stringContaining(harmless)]);
      else {
        expect([label, r.status >= 400 && r.status < 500, r.head.split("\r\n")[0]]).toEqual([label, true, expect.any(String)]);
        expect(r.body).not.toContain("rig page");
        expect(r.body).not.toContain("RIG-SHELL-MARKER");
        expect(r.body).not.toContain("reached");
      }
    };
    await attempt("absolute-form to another site", "GET http://example.com/ HTTP/1.1", "example.com");
    // Bun builds the request URL from the Host header, so this is "GET /" at the gateway: the hub's own page, never example.com.
    await attempt("absolute-form to another site, our Host", "GET http://example.com/ HTTP/1.1", host(), "RIG-SHELL-MARKER");
    await attempt("absolute-form to the hub itself", `GET http://127.0.0.1:${hub.port}/__hermes_cmd HTTP/1.1`, `127.0.0.1:${hub.port}`);
    await attempt("absolute-form to the hub itself, our Host", `GET http://127.0.0.1:${hub.port}/__hermes_cmd HTTP/1.1`);
    await attempt("foreign Host", "GET /leads HTTP/1.1", "evil.example");
    await attempt("the hub's Host", "GET /leads HTTP/1.1", `127.0.0.1:${hub.port}`);
    await attempt("localhost alias", "GET /leads HTTP/1.1", `localhost:${port}`);
    await attempt("scheme-relative", "GET //evil.example/ HTTP/1.1");
    await attempt("dot segments to the data folder", "GET /src/../.operator-data/gateway/control.json HTTP/1.1");
    await attempt("dot segments to a console-only route", "GET /__operator/leads/../../__hermes_cmd HTTP/1.1");
    await attempt("encoded dot segments", "GET /src/%2e%2e/.operator-data/devices.json HTTP/1.1");
    await attempt("encoded slash", "GET /__operator/leads%2f..%2f..%2f__hermes_cmd HTTP/1.1");
    await attempt("double-encoded", "GET /src/%252e%252e/.env HTTP/1.1");
    await attempt("backslash", "GET /src\\..\\.env HTTP/1.1");
    await attempt("Vite's file-system route", "GET /@fs/C:/Windows/win.ini HTTP/1.1");
    await attempt("a dot file", "GET /.env HTTP/1.1");
    await attempt("the data folder", "GET /.operator-data/gateway/hub-assertion.key HTTP/1.1");
    await attempt("the machine scan", "GET /src/data/live-data.json HTTP/1.1");
    await attempt("a raw import of a document", "GET /docs/programme-20261001/HANDOFF.md?raw HTTP/1.1");
    await attempt("case variant of a hub route", "GET /__OPERATOR/leads/list HTTP/1.1");
    await attempt("dot variant of a hub route", "GET /__hermes_cmd.json HTTP/1.1");
    await attempt("CONNECT", `CONNECT 127.0.0.1:${hub.port} HTTP/1.1`);
    await attempt("OPTIONS", "OPTIONS /__version HTTP/1.1");
    await attempt("TRACE", "TRACE /__version HTTP/1.1");
    // A destination in a query, a header or a body is just data.
    const q = await gw(`/__version?url=http://example.com/&target=${encodeURIComponent(hub.origin + "/__hermes_cmd")}`, { cookie, headers: { "X-Forwarded-Host": "example.com", "X-Original-URL": "/__hermes_cmd", "X-Rewrite-URL": "/__hermes_cmd" } });
    expect(await q.json()).toEqual({ version: "rig" });
    // What the hub received in this whole test: only that one allowed read, at the one fixed upstream.
    const arrived = hub.seen.slice(before).map((s) => s.url);
    expect(arrived.filter((u) => !u.startsWith("/__version?url="))).toEqual([]);
    expect(arrived.some((u) => u.includes("example.com") && !u.startsWith("/__version?url="))).toBe(false);
    expect(refused.length).toBe(24);
  }, 60_000);

  test("the security review's bypasses: every one is 403 or 404 through the real gateway, and none reaches the hub", async () => {
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("grant", cap, "--by", "usman");
    const cookie = await signIn();
    const before = hub.seen.length;
    const shell = readFileSync(join(uiDir, "_shell.html"), "utf8");
    const abs = hub.root.split("\\").join("/");
    const bypasses = [
      // NTFS alternate data streams and Windows name tricks
      "/src/data/live-data.json::$DATA", "/src/data/live-data.json:stream", "/src/data/live-data.json.", "/src/data/live-data.json%20", "/src/data/live-data.JSON",
      "/assets/app-abc123.js::$DATA", "/assets/app-abc123.js.", "/assets/app-abc123.js%20", "/_shell.html::$DATA", "/favicon.svg:x", "/memory/notes.md::$DATA", "/notes/PRIVATE::$DATA",
      "/__workspace::$DATA", "/__workspace.", "/__events%3a", "/leads::$DATA", "/leads.",
      // Vite's /@id, /@fs, /@vite and transform queries
      `/@id/${abs}/secret.txt?raw`, `/@id/${abs}/memory/notes.md?import&raw`, `/@id/${abs}/memory/notes.md?url&import`, `/@id/${abs}/memory/notes.md?inline&import`,
      `/@id/${abs}/src/data/live-data.json?import`, "/@id/__x00__virtual:thing", `/@fs/${abs}/secret.txt`, "/@vite/client", "/@vite/env", "/@react-refresh",
      "/src/main.ts?raw", "/src/data/live-data.json?url", "/assets/app-abc123.js?raw", "/assets/app-abc123.js?import", "/assets/app-abc123.js?url", "/_shell.html?raw", "/leads?raw", "/?import",
      // node_modules, dot folders and dot files
      "/node_modules/.vite/deps/_metadata.json", "/node_modules/.cache/x", "/node_modules/.bin/vite", "/node_modules/react/package.json", "/.hidden", "/.env", "/.operator-data/gateway/control.json",
      // media and files in checkout folders, extensionless files, source and maps
      "/docs/x.png", "/memory/pic.png", "/deploy/a.svg", "/config/settings", "/skills/x/SKILL", "/desktop/x", "/voice-lab/x", "/notes/PRIVATE", "/secret.txt", "/package.json",
      "/src/main.tsx", "/src/routes/leads.tsx", "/scripts/gateway/policy.ts", "/assets/app-abc123.js.map", "/assets/unlisted.js", "/assets/", "/assets",
      // encoded variants
      "/assets/app-abc123%2ejs", "/assets%2fapp-abc123.js", "/src/%2e%2e/secret.txt", "/%2e%2e/secret.txt", "/assets/app-abc123.js%00", "/leads%00", "/leads%2f", "/%41ssets/app-abc123.js",
    ];
    const results: Array<[string, number]> = [];
    for (const path of bypasses) {
      const r = await gw(path, { cookie });
      const body = await r.text();
      results.push([path, r.status]);
      expect([path, r.status === 403 || r.status === 404 || r.status === 400]).toEqual([path, true]);
      for (const marker of ["HIDDEN-MARKER", "UNLISTED-MARKER", "SOURCE-MAP-MARKER", "RIG_ASSET"]) expect([path, body.includes(marker)]).toEqual([path, false]);
      expect([path, body === shell]).toEqual([path, false]);
    }
    expect(hub.seen.length).toBe(before);
    // Only the exact files and the app's own routes are served.
    for (const ok of ["/", "/leads", "/leads/", "/memory", "/skills", "/coding/abc-123", "/assets/app-abc123.js", "/assets/app-abc123.css", "/favicon.svg", "/_shell.html"]) expect([ok, (await gw(ok, { cookie })).status]).toEqual([ok, 200]);
    for (const nope of ["/memory/x", "/skills/x", "/coding", "/coding/a/b", "/inbox", "/nope"]) expect([nope, (await gw(nope, { cookie })).status]).toEqual([nope, 404]);
    for (const cap of ["crm.write", "coding.start", "bots.operate"]) cli("revoke-grant", cap);
  }, 60_000);

  test("across the whole run, the hub was only ever asked for allow-listed routes", () => {
    // Everything that reached the hub without the tests' own "direct call" marker came through the gateway (which never forwards that header).
    const fromGateway = hub.seen.filter((s) => !s.headers["x-test-direct"]);
    expect(fromGateway.length).toBeGreaterThan(15);
    expect(fromGateway.every((s) => s.headers.via === VIA_VALUE && /^v1\./.test(s.headers[ASSERTION_HEADER] ?? ""))).toBe(true);
    const paths = new Set(fromGateway.map((s) => s.url.split("?")[0].replace(/gwact_[a-f0-9]{16}/, "gwact_*")));
    for (const p of paths) expect(/^\/(__version|__events(\/snapshot)?|__operator\/leads\/list|__gateway\/(me|crm\/activity(\/gwact_\*)?)|__agents\/redirect(-relative|-out)?|__workspace\/(pipeline|websites|groups))$/.test(p) ? "ok" : p).toBe("ok");
  });
});

describe("kill switch and restart", () => {
  test("the kill switch refuses everything at once, closes open streams, and the hub refuses too; off restores service", async () => {
    const cookie = await signIn();
    const stream = await gw("/__events", { cookie });
    const opening = await readSse(stream, (f) => f.some((x) => x.event === "snapshot"));
    // An assertion captured while the gateway was on is no use once the hub sees the switch either.
    const key = readFileSync(join(hub.dir, FILES.secret), "utf8").trim();
    secrets.push(key);

    expect(cli("kill", "on").code).toBe(0);
    const t0 = Date.now();
    const after = await readSse({ body: { getReader: () => opening.reader } } as unknown as Response, () => false, 3000);
    expect(after.ended).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    const before = hub.seen.length;
    for (const p of ["/", "/leads", "/__version", "/__events", "/gw/enrol", "/gw/me", "/__token"]) expect([p, (await gw(p, { cookie })).status]).toEqual([p, 503]);
    expect((await enrolWith(mintCode())).status).toBe(503);
    expect((await gw("/gw/health")).status).toBe(503);
    expect((await raw(upgradeRequest("/__computers/bot-1/vnc", [`Origin: ${origin}`, `Cookie: ${SESSION_COOKIE_NAME}=${cookie}`]))).status).toBe(503);
    expect(hub.seen.length).toBe(before);
    // The hub's side of the switch: even a correctly signed assertion is refused.
    const signed = signAssertion(key, { method: "GET", target: "/__version", sessionId: "ab".repeat(12), caps: ["view"] });
    expect((await fetch(`${hub.origin}/__version`, { headers: { Via: VIA_VALUE, [ASSERTION_HEADER]: signed, "X-Test-Direct": "1" } })).status).toBe(503);

    expect(cli("kill", "off").code).toBe(0);
    expect((await gw("/__version", { cookie })).status).toBe(200);
    expect((await gw("/gw/health")).status).toBe(200);
  }, 20_000);

  test("a restart keeps a valid session valid, a revoked one revoked, a logged-out one out, and a spent code spent", async () => {
    const keep = await signIn();
    const revoke = await signIn();
    const leave = await signIn();
    const code = mintCode();
    expect((await enrolWith(code)).status).toBe(200);
    const revokeId = ((await (await gw("/gw/me", { cookie: revoke })).json()) as { session: { id: string } }).session.id;
    cli("revoke-session", revokeId);
    expect((await gw("/__version", { cookie: revoke })).status).toBe(401);
    expect((await write(leave, "POST", "/gw/logout")).status).toBe(200);

    await stopGatewayProcess();
    await expect(fetch(`${origin}/gw/health`)).rejects.toThrow();
    await startGatewayProcess();

    expect((await gw("/__version", { cookie: keep })).status).toBe(200);
    expect(((await (await gw("/__gateway/me", { cookie: keep })).json()) as { person: string }).person).toBe("dot");
    expect((await gw("/__version", { cookie: revoke })).status).toBe(401);
    expect((await gw("/__version", { cookie: leave })).status).toBe(401);
    expect((await enrolWith(code)).status).toBe(401);
    // "Revoke everything" also survives.
    cli("revoke-session", "--all");
    expect((await gw("/__version", { cookie: keep })).status).toBe(401);
    await stopGatewayProcess();
    await startGatewayProcess();
    expect((await gw("/__version", { cookie: keep })).status).toBe(401);
  }, 60_000);
});

describe("what is written down", () => {
  test("no cookie, code, CSRF token, assertion, key, query or body content is in the gateway's output, its audit or its state", async () => {
    // One more request with a recognisable query, so its absence means something.
    const cookie = await signIn();
    await gw("/__operator/leads/list?q=QUERY-MARKER-91c2", { cookie });
    // A refused, unlisted route with an id in its path and a query: audited by its template only.
    await gw("/__crm/record/3f2c9a51-0b7e-4d2a-9c1e-7a6b5c4d3e2f/notes?ref=REF-MARKER-55e1", { cookie });
    await Bun.sleep(200);
    const files = readdirSync(hub.dir).filter((n) => n !== FILES.secret);
    expect(files).toEqual(expect.arrayContaining([FILES.control, FILES.sessions]));
    const written = [output.join(""), ...files.map((n) => readFileSync(join(hub.dir, n), "utf8"))].join("\n");
    expect(secrets.length).toBeGreaterThan(20);
    for (const secret of new Set(secrets)) expect(written.includes(secret) ? `leaked a ${secret.length}-character secret` : "clean").toBe("clean");
    // (The test activity's title lived in the hub's activity store while it existed; it was removed, so it is nowhere now.)
    for (const marker of ["BODY-MARKER-7f3a", "QUERY-MARKER-91c2", "HUB-COOKIE-VALUE", "HUB-SESSION-VALUE", "FORGED-BEARER", "FORGED-PAGE-TOKEN", "should never be written", "WRONG-WRONG", "REF-MARKER-55e1", "3f2c9a51-0b7e-4d2a-9c1e-7a6b5c4d3e2f"])
      expect([marker, written.includes(marker)]).toEqual([marker, false]);
    expect(readFileSync(join(hub.dir, FILES.activities), "utf8")).toBe("[]");
    // The process output is a handful of fixed lines.
    expect(output.join("").split("\n").filter((l) => l.trim()).every((l) => /^\[gateway\] (listening on 127\.0\.0\.1:\d+ for http:\/\/127\.0\.0\.1:\d+; upstream http:\/\/127\.0\.0\.1:\d+|kill switch is ON: refusing everything)$/.test(l))).toBe(true);
  });

  test("audit entries attribute to Dot or to nobody, never to a founder, and name a route template rather than a URL", () => {
    const entries = readAudit(hub.dir);
    expect(entries.length).toBeGreaterThan(100);
    for (const e of entries) {
      expect([null, "dot"]).toContain(e.person);
      expect(e.person === "dot" ? typeof e.session : "string").toBe("string");
      if (e.route) expect(e.route.includes("?") || /gwact_[a-f0-9]{16}/.test(e.route)).toBe(false);
      expect(Object.keys(e).every((k) => ["at", "event", "person", "session", "identity", "ip", "method", "route", "capability", "status", "outcome", "reason", "recordIds", "delegatedBy", "ms"].includes(k))).toBe(true);
    }
    const allowed = entries.filter((e) => e.event === "request" && e.outcome === "allowed");
    expect(allowed.every((e) => e.person === "dot" && !!e.session && !!e.capability && !!e.method && !!e.route && typeof e.status === "number")).toBe(true);
    expect(new Set(allowed.map((e) => e.route))).toEqual(new Set(["page", "ui-file", "/__version", "/__events", "/__events/snapshot", "/__operator/leads/**", "/__gateway/me", "/__gateway/crm/activity", "/__gateway/crm/activity/*", "/__agents/**", "/__workspace/pipeline", "/__workspace/websites", "/__workspace/groups"]));
    // A refused route the policy does not list is audited by its path TEMPLATE (ids as *, never a query, id or body).
    expect(entries.some((e) => e.outcome !== "allowed" && e.route === "unlisted /__crm/record/*/notes")).toBe(true);
    for (const e of entries.filter((x) => x.route?.startsWith("unlisted "))) expect(/[0-9a-f]{8}-[0-9a-f]{4}|\?/.test(e.route!)).toBe(false);
    // The client address is the edge's X-Forwarded-For entry, used for the audit and rate limits only.
    expect(entries.some((e) => e.ip.startsWith("203.0.113."))).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startComputersHub, type ComputersHub } from "../computers/test-harness";
import { signAssertion } from "./assertion";
import { runCli } from "./cli";
import { ASSERTION_HEADER, FILES, SESSION_COOKIE_NAME, VIA_VALUE } from "./config";
import { createGatewayTrust } from "./hub";
import { freePort } from "./test-rig";

/**
 * The REAL bot viewer (scripts/computers/viewer.ts, via the computers test harness that mounts it exactly as the plugin does)
 * with the Dot gateway's trust wired in, and a REAL spawned gateway in front. bots.operate is out of scope on the hub, so
 * every gateway upgrade must be refused by the viewer, before any byte moves, while founders keep their viewer.
 */

const REPO = resolve(import.meta.dir, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "gw-viewer-"));
const gwDir = join(dataDir, "gateway");
let hub: ComputersHub;
let port = 0;
let origin = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const cli = (...argv: string[]) => {
  const lines: string[] = [];
  runCli(argv, gwDir, (l) => lines.push(l));
  return lines.join("\n");
};

/** One raw upgrade request; resolves with the status line's code. */
function rawUpgrade(targetPort: number, path: string, headers: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const socket = connect(targetPort, "127.0.0.1");
    let text = "";
    const done = () => {
      socket.destroy();
      resolvePromise(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0));
    };
    socket.setTimeout(3000, done);
    socket.on("data", (d) => {
      text += d.toString();
      if (text.includes("\r\n\r\n")) done();
    });
    socket.on("error", done);
    socket.on("end", done);
    socket.on("connect", () =>
      socket.write([`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${targetPort}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...headers, "", ""].join("\r\n")),
    );
  });
}

beforeAll(async () => {
  hub = await startComputersHub({ gateway: createGatewayTrust({ root: dataDir, internalToken: () => "", enabled: true, dir: gwDir }) });
  hub.host.vncUp = true;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub.computers.view("research").state === "online");
  await hub.computers.tick();
  expect(hub.computers.view("research").viewer.vnc).toBe(true);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, "scripts/gateway/main.ts"], {
    cwd: REPO,
    env: { ...process.env, MU_DATA_DIR: dataDir, MU_GATEWAY_PORT: String(port), MU_GATEWAY_UPSTREAM: hub.base, MU_GATEWAY_PUBLIC_ORIGIN: origin, MU_GATEWAY_RECHECK_MS: "100" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${origin}/gw/health`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
}, 60_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await hub.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
}, 30_000);

describe("the real viewer with gateway trust", () => {
  test("straight to the hub: a forged assertion is 401, a validly signed one is still refused (403); a founder still watches", async () => {
    const path = "/__computers/research/vnc";
    expect(await rawUpgrade(hub.port, path, [`Via: ${VIA_VALUE}`, `${ASSERTION_HEADER}: v1.forged.forged`])).toBe(401);
    const key = readFileSync(join(gwDir, FILES.secret), "utf8").trim();
    const signed = (upgrade: boolean) => signAssertion(key, { method: "GET", target: path, sessionId: "ef".repeat(12), caps: ["view", "bots.operate"], upgrade });
    // An ordinary request's assertion is not accepted for an upgrade.
    expect(await rawUpgrade(hub.port, path, [`Via: ${VIA_VALUE}`, `${ASSERTION_HEADER}: ${signed(false)}`])).toBe(401);
    expect(await rawUpgrade(hub.port, path, [`Via: ${VIA_VALUE}`, `${ASSERTION_HEADER}: ${signed(true)}`])).toBe(403);
    // A founder's own confirmed session still opens the viewer.
    const { host, ...rest } = hub.headers("usman", false) as Record<string, string>;
    const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(`ws://127.0.0.1:${hub.port}${path}`, { headers: { ...rest, host } });
    const opened = await new Promise<boolean>((r) => {
      ws.addEventListener("open", () => r(true));
      ws.addEventListener("error", () => r(false));
      setTimeout(() => r(false), 5000);
    });
    expect(opened).toBe(true);
    ws.close();
  }, 30_000);

  test("through the real gateway, even with bots.operate granted: no WebSocket rule exists, so the upgrade is refused before the hub is asked", async () => {
    const code = /code for Dot: ([A-Z0-9-]+)/.exec(cli("enrol-code", "--by", "usman"))![1];
    cli("grant", "bots.operate", "--by", "usman");
    const res = await fetch(`${origin}/gw/enrol`, { method: "POST", headers: { Origin: origin, "X-MU-Gateway-Enrol": "1", "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    const cookie = new RegExp(`${SESSION_COOKIE_NAME}=([A-Za-z0-9_-]{43})`).exec(res.headers.getSetCookie().join("\n"))![1];
    const status = await rawUpgrade(port, "/__computers/research/vnc", [`Origin: ${origin}`, `Cookie: ${SESSION_COOKIE_NAME}=${cookie}`]);
    expect(status).toBe(403);
    const audit = readFileSync(join(gwDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
    expect(audit).toContain('"reason":"not-listed"');
    cli("revoke-grant", "bots.operate");
  }, 30_000);
});

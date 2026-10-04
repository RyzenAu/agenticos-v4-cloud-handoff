import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAudit } from "./audit";
import { runCli } from "./cli";
import { LIMITS, SESSION_COOKIE_NAME } from "./config";
import { freePort, startRigHub, type RigHub } from "./test-rig";
import { UI_MANIFEST, type UiManifest } from "./ui";

/**
 * The REAL built UI (scripts/gateway/build-ui.ts: an SPA-mode client build of this checkout, dist/client) served by a REAL
 * spawned gateway, with the client address left at its default (X-Forwarded-For NOT trusted, as behind Funnel).
 * The build is made once when dist/client has no gateway manifest (about a minute); otherwise the existing one is used.
 */

const REPO = resolve(import.meta.dir, "..", "..");
const UI_DIR = join(REPO, "dist", "client");
let hub: RigHub;
let port = 0;
let origin = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let manifest: UiManifest;
let cookie = "";

const cli = (...argv: string[]) => {
  const lines: string[] = [];
  runCli(argv, hub.dir, (l) => lines.push(l));
  return lines.join("\n");
};
const mintCode = () => /code for Dot: ([A-Z0-9-]+)/.exec(cli("enrol-code", "--by", "usman"))![1];
const gw = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, withCookie = true) =>
  fetch(origin + path, { method: init.method ?? "GET", headers: { ...(withCookie && cookie ? { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}), ...(init.headers ?? {}) }, body: init.body, redirect: "manual" });
const enrol = (code: string, forwardedFor: string) =>
  gw("/gw/enrol", { method: "POST", headers: { Origin: origin, "X-MU-Gateway-Enrol": "1", "Content-Type": "application/json", "X-Forwarded-For": forwardedFor }, body: JSON.stringify({ code }) }, false);

beforeAll(async () => {
  if (!existsSync(join(UI_DIR, UI_MANIFEST))) {
    const build = Bun.spawnSync([process.execPath, "scripts/gateway/build-ui.ts"], { cwd: REPO, stdout: "ignore", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`the UI build failed: ${build.stderr.toString().slice(-600)}`);
  }
  manifest = JSON.parse(readFileSync(join(UI_DIR, UI_MANIFEST), "utf8")) as UiManifest;
  hub = await startRigHub();
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  // MU_GATEWAY_FORWARDED_FOR is deliberately not set: the default.
  const env: Record<string, string | undefined> = { ...process.env, MU_DATA_DIR: hub.dataDir, MU_GATEWAY_PORT: String(port), MU_GATEWAY_UPSTREAM: hub.origin, MU_GATEWAY_PUBLIC_ORIGIN: origin, MU_GATEWAY_RECHECK_MS: "100", MU_GATEWAY_UI_DIR: UI_DIR };
  delete env.MU_GATEWAY_FORWARDED_FOR;
  proc = Bun.spawn([process.execPath, "scripts/gateway/main.ts"], { cwd: REPO, env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${origin}/gw/health`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50);
  }
  const res = await enrol(mintCode(), "198.51.100.1");
  expect(res.status).toBe(200);
  cookie = new RegExp(`${SESSION_COOKIE_NAME}=([A-Za-z0-9_-]{43})`).exec(res.headers.getSetCookie().join("\n"))![1];
}, 600_000);

afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  await hub.close();
}, 30_000);

describe("the built UI through the gateway", () => {
  test("the manifest is an exact list: hashed assets and public files, a shell, the app's routes, no maps, no dot files", () => {
    const keys = Object.keys(manifest.files);
    expect(keys.length).toBeGreaterThan(100);
    expect(manifest.shell).toBe("/_shell.html");
    expect(manifest.pages).toEqual(expect.arrayContaining(["/", "/leads", "/memory", "/agents/workspace/$botId"]));
    expect(keys.filter((k) => /\.map$/i.test(k) || /\/\./.test(k) || k.includes(":") || k.includes("%"))).toEqual([]);
    expect(keys.filter((k) => k.startsWith("/assets/") && k.endsWith(".js")).length).toBeGreaterThan(50);
  });

  test("the index: the shell loads at / with the gateway's headers, and everything it references loads from the same origin", async () => {
    const res = await gw("/", { headers: { Accept: "text/html" } });
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const html = await res.text();
    expect(html).toBe(readFileSync(join(UI_DIR, "_shell.html"), "utf8"));
    // Every URL the shell names is root-relative (base path "/"), so it resolves on the gateway's origin, and is in the manifest.
    const refs = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g), ...html.matchAll(/import\(\\?"(\/[^"\\]+)\\?"\)/g)].map((m) => m[1]))];
    expect(refs.length).toBeGreaterThan(3);
    expect(refs.some((r) => /^\/assets\/index-[\w-]+\.js$/.test(r))).toBe(true);
    expect(html).not.toMatch(/(?:href|src)="(?:https?:)?\/\//);
    for (const ref of refs) {
      const r = await gw(ref);
      // A file of the bundle (stylesheet, script, font, image) by its own type, or a link to one of the app's pages (the shell).
      expect([ref, r.status, r.headers.get("content-type")]).toEqual([ref, 200, manifest.files[ref]?.type ?? "text/html; charset=utf-8"]);
      await r.arrayBuffer();
    }
    expect(refs.filter((r) => manifest.files[r]).length).toBeGreaterThan(5);
    // Nothing above was asked of the hub.
    expect(hub.seen.filter((s) => !s.url.startsWith("/__"))).toEqual([]);
  });

  test("every file in the manifest is served, byte for byte; nothing else in the folder is", async () => {
    for (const [key, f] of Object.entries(manifest.files)) {
      const r = await gw(key);
      const body = Buffer.from(await r.arrayBuffer());
      expect([key, r.status, body.length]).toEqual([key, 200, f.size]);
      if (f.size < 2_000_000) expect([key, createHash("sha256").update(body).digest("hex")]).toEqual([key, f.sha256]);
    }
    expect((await gw(`/${UI_MANIFEST}`)).status).toBe(404);
    // The excluded folder (unapproved creative material) is in the build output but not in the manifest, so it is not served.
    expect(Object.keys(manifest.files).filter((k) => k.startsWith("/mu-creative-20261001"))).toEqual([]);
    if (existsSync(join(UI_DIR, "mu-creative-20261001"))) {
      const some = readdirSync(join(UI_DIR, "mu-creative-20261001"), { recursive: true }).map(String).filter((n) => /\.[a-z0-9]+$/i.test(n)).slice(0, 5);
      expect(some.length).toBeGreaterThan(0);
      for (const name of some) expect([name, (await gw(`/mu-creative-20261001/${name.split("\\").join("/")}`)).status]).toEqual([name, 404]);
    }
    for (const name of readdirSync(UI_DIR).filter((n) => n.startsWith("."))) expect([name, (await gw(`/${name}`)).status]).toEqual([name, 404]);
  }, 120_000);

  test("SPA routing: every app route (and a deep link with a parameter) gets the shell; anything else is 404", async () => {
    const shell = readFileSync(join(UI_DIR, "_shell.html"), "utf8");
    for (const page of manifest.pages) {
      const path = page.replace(/\$[A-Za-z0-9]+/g, "abc-123");
      const r = await gw(path, { headers: { Accept: "text/html" } });
      expect([path, r.status, (await r.text()) === shell]).toEqual([path, 200, true]);
    }
    for (const path of ["/not-a-route", "/leads/extra/deep", "/skills/x/SKILL", "/config/settings", "/src/main.tsx", "/src/routes/leads.tsx"]) expect([path, (await gw(path)).status]).toEqual([path, 404]);
  });

  test("the client talks to the API on its own origin: /__token is answered, an allow-listed /__ read reaches the hub as Dot, nothing is hard-wired to another origin", async () => {
    const js = Object.keys(manifest.files).filter((k) => k.endsWith(".js")).map((k) => readFileSync(join(UI_DIR, k), "utf8")).join("\n");
    // The bundle asks for its page token and its APIs by root-relative path, and never names the hub's own address as a URL.
    expect(js).toContain('"/__token"');
    expect(js).toContain("/__events");
    // Literal request targets in the bundle that are NOT root-relative: the only local one is the voice sidecar on the
    // VIEWER's own machine (localhost:8099), which Dot does not have, so in-browser voice is unavailable through the gateway
    // (documented). Nothing addresses the hub by its own address; prose mentioning "localhost:8081" is just text.
    const targets = [...js.matchAll(/(?:fetch|EventSource|WebSocket)\(\s*["'`]([^"'`$]{1,80})/g)].map((m) => m[1]).filter((t) => !t.startsWith("/"));
    const local = targets.filter((t) => /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])/.test(t));
    expect(local.length).toBeGreaterThan(0);
    expect(local.every((t) => t.startsWith("http://localhost:8099/"))).toBe(true);
    expect(((await (await gw("/__token")).json()) as { token: string }).token.length).toBeGreaterThan(20);
    expect(await (await gw("/__operator/leads/list")).json()).toEqual({ reached: "/__operator/leads/list", who: "dot", via: "gateway" });
    // A hub answer with no caching rule of its own is never stored.
    expect((await gw("/__operator/leads/list")).headers.get("cache-control")).toBe("private, no-store");
  });

  test("the review's bypasses against the real bundle: stream suffixes, transform queries, maps, source, dev-server paths", async () => {
    const real = Object.keys(manifest.files).find((k) => /^\/assets\/index-[\w-]+\.js$/.test(k))!;
    const before = hub.seen.length;
    for (const path of [
      `${real}::$DATA`, `${real}:x`, `${real}.`, `${real}%20`, `${real}?raw`, `${real}?import`, `${real}?url`, `${real}.map`, `${real.replace(".js", "%2ejs")}`,
      "/_shell.html::$DATA", "/_shell.html?raw", "/src/data/live-data.json", "/src/data/live-data.json::$DATA", "/src/data/live-data.json?import",
      `/@id/${REPO.split("\\").join("/")}/memory/current-strategy.md?raw`, `/@id/${REPO.split("\\").join("/")}/package.json?import&raw`, `/@fs/${REPO.split("\\").join("/")}/package.json`,
      "/@vite/client", "/node_modules/.vite/deps/_metadata.json", "/node_modules/.cache/x", "/docs/IDENTITY-ROUTES.md", "/docs/IDENTITY-ROUTES.md?raw", "/package.json", "/vite.config.ts", "/.env",
      "/memory/pic.png", "/scripts/gateway/policy.ts", "/dist/server/server.js", "/public/favicon.svg",
    ]) {
      const r = await gw(path);
      expect([path, [400, 403, 404].includes(r.status)]).toEqual([path, true]);
    }
    expect(hub.seen.length).toBe(before);
  });
});

describe("sign-in with the client address at its default (not trusted)", () => {
  test("X-Forwarded-For is ignored: wrong codes do not lock out by address, the audit records the socket's address", async () => {
    // More wrong codes than the per-address lockout, each claiming a different (and then the same) forwarded address.
    for (let i = 0; i < LIMITS.enrolFailuresPerIp + 2; i++) expect((await enrol(`WRONG-${i}WRNG-WRONG-WRONG`, i < 4 ? `203.0.113.${i}` : "203.0.113.200")).status).toBe(401);
    const good = await enrol(mintCode(), "203.0.113.200");
    expect(good.status).toBe(200);
    const failures = readAudit(hub.dir).filter((e) => e.event === "enrol-failed");
    expect(failures.length).toBeGreaterThanOrEqual(LIMITS.enrolFailuresPerIp + 2);
    expect(failures.every((e) => e.ip === "127.0.0.1" || e.ip === "::1" || e.ip === "-")).toBe(true);
    expect(failures.some((e) => e.reason === "locked-out")).toBe(false);
  }, 30_000);
});

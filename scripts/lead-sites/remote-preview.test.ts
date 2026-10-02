// Remote lead-site previews (preview-origin.ts), the /__lead-sites access rules (access.ts) and the URL a
// preview opens at. Everything is synthetic: temp folders, a temp people.json with example.test logins, and
// Tailscale Serve simulated the way scripts/identity/principal.test.ts does it (servePeer + a synthetic tailnet
// snapshot). No real Tailscale, people, tokens or previews are read.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../devices/store";
import { configureIdentity, pageTokenFor } from "../identity/principal";
import { syntheticTailnetForTests } from "../remote-access";
import { previewHrefFor, localPreviewHref } from "../../src/lib/leads";
import { actingFounder, expectedOrigin, gateAdmitted, leadSitesCaller, needsOwnerAtPc, previewLinkFor, writeTokenOk } from "./access";
import { isPreviewOriginHost, previewOriginHandler, previewOriginPort, remotePreviewUrl } from "./preview-origin";
import { leadSitesPlugin } from "./plugin";
import { isPlainFileInside, previewPortFromEnv, resolvePreviewFile, resolvePreviewName } from "./preview-server";

const TAILNET = "hub.tail-test.ts.net";
const LOGINS = { usman: "owner@example.test", mehroz: "partner@example.test", stranger: "stranger@example.test" };
const PORT = 8445;
const INTERNAL = "internal-token-for-tests";

const base = mkdtempSync(join(tmpdir(), "mu-remote-preview-"));
const root = join(base, "os");
const drafts = join(base, "drafts");
const leadDir = join(drafts, "harbour-realty", "flagship-preview");
const put = (file: string, body = "x") => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
};

// A small Next-export-shaped site: root-absolute assets, clean page URLs, RSC text payloads.
put(join(leadDir, "index.html"), '<link rel="stylesheet" href="/_next/static/chunks/a.css"><img src="/_img/1080/hero.webp"><a href="/buy">Buy</a>');
put(join(leadDir, "buy.html"), "<h1>buy</h1>");
put(join(leadDir, "buy.txt"), "rsc");
put(join(leadDir, "__next.__PAGE__.txt"), "segment");
put(join(leadDir, "_next", "static", "chunks", "a.css"), "body{}");
put(join(leadDir, "_img", "1080", "hero.webp"), "webp");
put(join(leadDir, "404.html"), "<h1>not found</h1>");
put(join(drafts, "harbour-realty", "secret.txt"), "outside the preview");
put(join(drafts, "_templates", "real-estate", "index.html"), "<h1>template</h1>");
put(join(drafts, "wish-draft", "index.html"), "<h1>draft</h1>");
put(join(drafts, "no-index-draft", "readme.md"), "no index");
put(join(root, ".operator-data", "lead-sites.json"), JSON.stringify({ version: 1, previews: [{ leadId: 7, slug: "harbour-realty", dir: leadDir, status: "generated", business: "Harbour Realty", vertical: "real-estate" }] }));
put(
  join(root, ".operator-data", "people.json"),
  JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGINS.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz] }] }),
);

const store = new DeviceStore(root);
const identity = (over: Record<string, unknown> = {}) => ({ root, store, tailnetName: TAILNET, servePeer: () => true, tailnet: syntheticTailnetForTests(TAILNET, ["100.64.0.1"]), ...over });

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** A raw request (no URL normalisation), so traversal paths reach the server exactly as written. */
function call(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const founder = (who: "usman" | "mehroz", extra: Record<string, string> = {}) => ({
  host: `${TAILNET}:${PORT}`,
  "tailscale-user-login": LOGINS[who],
  "x-forwarded-for": "100.64.0.7",
  ...extra,
});
const hubFounder = (who: "usman" | "mehroz", extra: Record<string, string> = {}) => founder(who, { host: `${TAILNET}:8443`, ...extra });

describe("preview origin: names and URLs", () => {
  test("the Serve port is 8445 unless MU_PREVIEW_ORIGIN_PORT says otherwise", () => {
    expect(previewOriginPort({})).toBe(8445);
    expect(previewOriginPort({ MU_PREVIEW_ORIGIN_PORT: "8470" })).toBe(8470);
    for (const bad of ["", "0", "abc", "70000", "-5", "80.5"]) expect(previewOriginPort({ MU_PREVIEW_ORIGIN_PORT: bad })).toBe(8445);
  });
  test("the loopback preview port is configurable by MU_PREVIEW_PORT, default 8091", () => {
    expect(previewPortFromEnv({})).toBe(8091);
    expect(previewPortFromEnv({ MU_PREVIEW_PORT: "8121" })).toBe(8121);
    for (const bad of ["", "0", "x", "99999"]) expect(previewPortFromEnv({ MU_PREVIEW_PORT: bad })).toBe(8091);
  });
  test("only the tailnet name WITH the preview port is a preview origin", () => {
    expect(isPreviewOriginHost(`${TAILNET}:8445`, 8445)).toBe(true);
    expect(isPreviewOriginHost(`HUB.tail-test.ts.net:8445`, 8445)).toBe(true);
    for (const host of [`${TAILNET}:8443`, TAILNET, `${TAILNET}:8445x`, "localhost:8445", "127.0.0.1:8445", "evil.example:8445", `evil.example.ts.net.evil.com:8445`, ".ts.net:8445", "", undefined])
      expect(isPreviewOriginHost(host, 8445)).toBe(false);
  });
  test("the remote URL is built from the hub's own host, and only for a tailnet name and a plain site name", () => {
    expect(remotePreviewUrl(`${TAILNET}:8443`, "harbour-realty", 8445)).toBe(`https://${TAILNET}:8445/_mu-preview/open/harbour-realty`);
    expect(remotePreviewUrl(TAILNET, "tpl--real-estate", 8445)).toBe(`https://${TAILNET}:8445/_mu-preview/open/tpl--real-estate`);
    expect(remotePreviewUrl("localhost:8081", "x", 8445)).toBeNull();
    expect(remotePreviewUrl("evil.example:8081", "x", 8445)).toBeNull();
    expect(remotePreviewUrl(undefined, "x", 8445)).toBeNull();
    expect(remotePreviewUrl(`${TAILNET}:8443`, "../x", 8445)).toBeNull();
    expect(remotePreviewUrl(`${TAILNET}:8443`, "A b", 8445)).toBeNull();
  });
  test("resolvePreviewName: a registered lead, an existing template, a draft with a root index, nothing else", () => {
    const o = { root, draftsRoot: drafts };
    expect(resolvePreviewName("harbour-realty", o)).toEqual({ kind: "lead", name: "harbour-realty", dir: leadDir });
    expect(resolvePreviewName("tpl--real-estate", o)?.kind).toBe("template");
    expect(resolvePreviewName("draft--wish-draft", o)?.kind).toBe("draft");
    for (const bad of ["unknown-lead", "tpl--legal", "draft--no-index-draft", "draft--_templates", "tpl--..", "draft--..", "Harbour-Realty", "harbour-realty.localhost", "../x", "", undefined, "a/b", "a\\b", "harbour realty"])
      expect([bad, resolvePreviewName(bad as string, o)]).toEqual([bad, null]);
  });
});

describe("preview origin: the authenticated route", () => {
  let server: Server;
  let port = 0;
  let passedThrough = 0;
  beforeAll(async () => {
    const handler = previewOriginHandler({ root, draftsRoot: drafts, port: PORT, identity: identity() });
    server = createServer((req, res) =>
      void handler(req, res, () => {
        passedThrough++;
        res.statusCode = 599;
        res.end("next");
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    passedThrough = 0;
  });
  const cookie = (name: string) => ({ cookie: `mu_pv=${name}` });

  test("a Host that isn't the preview origin goes straight on (the hub's own origin, loopback)", async () => {
    for (const host of [`${TAILNET}:8443`, "127.0.0.1:8081", "localhost:8081", `${TAILNET}`]) {
      expect((await call(port, "/", { host })).status).toBe(599);
    }
    expect(passedThrough).toBe(4);
  });

  test("a verified founder enters a preview, then loads its page, root-absolute assets and RSC files", async () => {
    const entry = await call(port, "/_mu-preview/open/harbour-realty", founder("mehroz"));
    expect(entry.status).toBe(302);
    expect(entry.headers.location).toBe("/");
    const set = String(entry.headers["set-cookie"]);
    expect(set).toContain("mu_pv=harbour-realty");
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(set).toContain(flag);
    expect(entry.headers["clear-site-data"]).toBeUndefined();

    const c = cookie("harbour-realty");
    const home = await call(port, "/", founder("mehroz", c));
    expect(home.status).toBe(200);
    expect(home.body).toContain('href="/_next/static/chunks/a.css"');
    expect(home.headers["x-robots-tag"]).toContain("noindex");
    expect(home.headers["cache-control"]).toBe("private, no-cache");
    expect(home.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const css = await call(port, "/_next/static/chunks/a.css", founder("mehroz", c));
    expect([css.status, css.headers["content-type"]]).toEqual([200, "text/css; charset=utf-8"]);
    const img = await call(port, "/_img/1080/hero.webp", founder("usman", c));
    expect([img.status, img.headers["content-type"]]).toEqual([200, "image/webp"]);
    expect((await call(port, "/buy", founder("usman", c))).body).toBe("<h1>buy</h1>");
    expect((await call(port, "/buy.txt?_rsc=abc", founder("usman", c))).body).toBe("rsc");
    // Next's segment prefetch files start with /__ and must reach the site, not a hub route.
    expect((await call(port, "/__next.__PAGE__.txt", founder("usman", c))).body).toBe("segment");
    expect((await call(port, "/nope", founder("usman", c))).status).toBe(404);
    expect(passedThrough).toBe(0);
  });

  test("switching to a different site clears the origin's storage; re-entering the same one does not", async () => {
    const other = await call(port, "/_mu-preview/open/tpl--real-estate", founder("usman", cookie("harbour-realty")));
    expect(other.status).toBe(302);
    expect(other.headers["clear-site-data"]).toBe('"storage"');
    expect(String(other.headers["set-cookie"])).toContain("mu_pv=tpl--real-estate");
    const same = await call(port, "/_mu-preview/open/tpl--real-estate", founder("usman", cookie("tpl--real-estate")));
    expect(same.headers["clear-site-data"]).toBeUndefined();
  });

  test("an unauthenticated or unknown caller gets 401/403, never a preview file", async () => {
    const c = cookie("harbour-realty");
    const refusals: [string, Record<string, string>][] = [
      ["no login at all", { host: `${TAILNET}:${PORT}`, ...c }],
      ["a login people.json doesn't list", founder("usman", { "tailscale-user-login": LOGINS.stranger, ...c })],
      ["another tailnet name", founder("usman", { host: `other.tail-test.ts.net:${PORT}`, ...c })],
      ["no tailnet source address", { host: `${TAILNET}:${PORT}`, "tailscale-user-login": LOGINS.usman, ...c }],
      ["the hub's own node (the self-loop)", founder("usman", { "x-forwarded-for": "100.64.0.1", ...c })],
      ["a bearer token and no login", { host: `${TAILNET}:${PORT}`, authorization: "Bearer made-up", ...c }],
    ];
    for (const [why, headers] of refusals) {
      for (const path of ["/", "/_next/static/chunks/a.css", "/_mu-preview/open/harbour-realty", "/__token", "/buy.txt"]) {
        const r = await call(port, path, headers);
        expect([why, path, r.status === 401 || r.status === 403, r.body.includes("body{}"), r.headers["set-cookie"]]).toEqual([why, path, true, false, undefined]);
      }
    }
    expect(passedThrough).toBe(0);
  });

  test("a relay that is not the local tailscaled (servePeer false) is nobody, even with a listed login", async () => {
    const handler = previewOriginHandler({ root, draftsRoot: drafts, port: PORT, identity: identity({ servePeer: () => false }) });
    const s = createServer((req, res) => void handler(req, res, () => res.end("next")));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    try {
      const r = await call((s.address() as { port: number }).port, "/", founder("usman", cookie("harbour-realty")));
      expect(r.status).toBe(401);
    } finally {
      s.close();
    }
  });

  test("a site the registry doesn't know, or nothing selected, is a 404; the cookie can't name a path", async () => {
    expect((await call(port, "/", founder("usman"))).status).toBe(404); // no cookie
    for (const bad of ["unknown-lead", "tpl--legal", "draft--no-index-draft", "draft--..", "..", "harbour-realty/../x", "%2e%2e", "HARBOUR-REALTY", "harbour-realty.localhost"])
      expect([bad, (await call(port, "/", founder("usman", cookie(bad)))).status]).toEqual([bad, 404]);
    for (const bad of ["unknown-lead", "tpl--legal", "draft--no-index-draft", "x.y", "UPPER", "a b"])
      expect([bad, (await call(port, `/_mu-preview/open/${bad.replace(" ", "%20")}`, founder("usman"))).status]).toEqual([bad, 404]);
  });

  test("path traversal and non-canonical targets are refused before any file lookup", async () => {
    const h = founder("usman", cookie("harbour-realty"));
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/_next/../../secret.txt",
      "/_next/%2e%2e/%2e%2e/secret.txt",
      "//secret.txt",
      "/_mu-preview/open/..%2fharbour-realty",
      "/_mu-preview/open/../open/harbour-realty",
      "/a\\b",
      "/%00",
      "/%25",
    ]) {
      const r = await call(port, path, h);
      expect([path, r.status, r.body.includes("outside the preview")]).toEqual([path, 400, false]);
    }
    // Dotfiles and deploy config inside the site are not served either (same guard as the loopback listener).
    put(join(leadDir, ".vercel", "project.json"), "{}");
    put(join(leadDir, "vercel.json"), "{}");
    expect((await call(port, "/.vercel/project.json", h)).status).toBe(404);
    expect((await call(port, "/vercel.json", h)).status).toBe(404);
    expect(passedThrough).toBe(0);
  });

  test("it only reads, and none of the hub is reachable on this origin", async () => {
    const h = founder("usman", cookie("harbour-realty"));
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await call(port, "/", h, method)).status).toBe(405);
    expect((await call(port, "/", { host: `${TAILNET}:${PORT}` }, "POST")).status).toBe(401);
    for (const path of ["/__token", "/__operator/status", "/@vite/client", "/src/main.tsx", "/node_modules/.vite/deps/x.js", "/.env", "/__lead-sites/status"]) {
      const r = await call(port, path, h);
      expect([path, r.status]).toEqual([path, 404]);
      expect(r.body).not.toContain("token");
    }
    expect(passedThrough).toBe(0);
  });
});

describe("/__lead-sites: who may call, what they get", () => {
  const owner = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8081" } };
  const viaServe = (who: keyof typeof LOGINS, extra: Record<string, string> = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: hubFounder(who as "usman", { "tailscale-user-login": LOGINS[who], ...extra }) });

  test("the owner at this PC and a verified founder over Serve pass; everyone else is refused", () => {
    const ctx = identity();
    expect(leadSitesCaller(owner, ctx)).toMatchObject({ ok: true, caller: { atPc: true, principal: { via: "loopback-owner" } } });
    expect(leadSitesCaller(viaServe("mehroz"), ctx)).toMatchObject({ ok: true, caller: { atPc: false, principal: { personId: "mehroz", via: "tailnet-person" } } });
    expect(leadSitesCaller(viaServe("usman"), ctx)).toMatchObject({ ok: true, caller: { atPc: false } });
    expect(leadSitesCaller(viaServe("stranger"), ctx)).toMatchObject({ ok: false, status: 401 });
    expect(leadSitesCaller({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: `${TAILNET}:8443` } }, ctx)).toMatchObject({ ok: false, status: 401 });
    expect(leadSitesCaller({ socket: { remoteAddress: "192.168.1.9" }, headers: { host: "127.0.0.1:8081" } }, ctx)).toMatchObject({ ok: false, status: 401 });
    expect(leadSitesCaller(viaServe("usman", { "x-forwarded-for": "100.64.0.1" }), ctx)).toMatchObject({ ok: false, status: 401 }); // the hub's own node
    expect(leadSitesCaller(viaServe("usman"), identity({ servePeer: () => false }))).toMatchObject({ ok: false, status: 401 });
  });

  test("deploy and take-down stay with the owner at this PC; the rest is open to a founder", () => {
    for (const p of ["/deploy", "/takedown"]) expect(needsOwnerAtPc(p)).toBe(true);
    for (const p of ["/generate", "/thumb", "/status", "/qa", "/local/7"]) expect(needsOwnerAtPc(p)).toBe(false);
  });

  test("a write needs the caller's OWN page token; the raw internal token is useless over Serve", () => {
    const ctx = identity();
    const usman = (leadSitesCaller(viaServe("usman"), ctx) as { ok: true; caller: Parameters<typeof writeTokenOk>[0] }).caller;
    const mehroz = (leadSitesCaller(viaServe("mehroz"), ctx) as { ok: true; caller: Parameters<typeof writeTokenOk>[0] }).caller;
    const atPc = (leadSitesCaller(owner, ctx) as { ok: true; caller: Parameters<typeof writeTokenOk>[0] }).caller;
    expect(writeTokenOk(usman, pageTokenFor(usman.principal, INTERNAL), INTERNAL)).toBe(true);
    expect(writeTokenOk(usman, pageTokenFor(mehroz.principal, INTERNAL), INTERNAL)).toBe(false); // the other founder's
    expect(writeTokenOk(usman, INTERNAL, INTERNAL)).toBe(false);
    expect(writeTokenOk(usman, undefined, INTERNAL)).toBe(false);
    expect(writeTokenOk(usman, "", INTERNAL)).toBe(false);
    expect(writeTokenOk(atPc, INTERNAL, INTERNAL)).toBe(true); // the owner at this PC, unchanged
    expect(writeTokenOk(atPc, "wrong", INTERNAL)).toBe(false);
  });

  test("a remote founder acts as themselves, never as the name in the body; the owner at the PC still picks", () => {
    const ctx = identity();
    const usman = (leadSitesCaller(viaServe("usman"), ctx) as { ok: true; caller: Parameters<typeof actingFounder>[0] }).caller;
    const atPc = (leadSitesCaller(owner, ctx) as { ok: true; caller: Parameters<typeof actingFounder>[0] }).caller;
    expect(actingFounder(usman, "mehroz")).toBe("usman");
    expect(actingFounder(atPc, "mehroz")).toBe("mehroz");
    expect(expectedOrigin(usman, `${TAILNET}:8443`)).toBe(`https://${TAILNET}:8443`);
    expect(expectedOrigin(atPc, "127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
  });

  test("the preview link is chosen by how the page was reached", () => {
    const ctx = identity();
    const usman = (leadSitesCaller(viaServe("usman"), ctx) as { ok: true; caller: Parameters<typeof previewLinkFor>[0] }).caller;
    const atPc = (leadSitesCaller(owner, ctx) as { ok: true; caller: Parameters<typeof previewLinkFor>[0] }).caller;
    expect(previewLinkFor(atPc, "127.0.0.1:8081", "harbour-realty", { local: 8091 })).toBe("http://harbour-realty.localhost:8091/");
    expect(previewLinkFor(usman, `${TAILNET}:8443`, "harbour-realty", { remote: 8445 })).toBe(`https://${TAILNET}:8445/_mu-preview/open/harbour-realty`);
    expect(previewLinkFor(usman, "localhost:8081", "harbour-realty")).toBeNull();
  });

  describe("through the real plugin", () => {
    let mw: ((req: any, res: any) => unknown) | undefined;
    let srv: Server;
    let p = 0;
    const saved = process.env.AGENTIC_OS_NO_BACKGROUND;
    beforeAll(async () => {
      process.env.AGENTIC_OS_NO_BACKGROUND = "1"; // never start the 8091 listener from a test
      configureIdentity({ root, store, tailnetName: TAILNET, servePeer: () => true, tailnet: syntheticTailnetForTests(TAILNET, ["100.64.0.1"]) });
      const plugin = leadSitesPlugin({ root, token: INTERNAL, draftsRoot: drafts });
      (plugin.configureServer as (s: unknown) => void)({
        middlewares: { use: (path: string, fn: (req: any, res: any) => unknown) => void (path === "/__lead-sites" && (mw = fn)) },
      });
      srv = createServer((req, res) => {
        req.url = (req.url || "").replace(/^\/__lead-sites/, "") || "/";
        mw!(req, res);
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      p = (srv.address() as { port: number }).port;
    });
    afterAll(() => {
      srv.close();
      configureIdentity(undefined);
      if (saved === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
      else process.env.AGENTIC_OS_NO_BACKGROUND = saved;
    });
    const mehrozToken = pageTokenFor({ personId: "mehroz", via: "tailnet-person" }, INTERNAL);
    const json = (token: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-claude-os-token": token, ...extra });

    test("/status and /local: the owner is sent to *.localhost, a founder to the preview origin", async () => {
      const own = await call(p, "/__lead-sites/local/7", { host: "127.0.0.1:8081" });
      expect([own.status, own.headers.location]).toEqual([302, `http://harbour-realty.localhost:${previewPortFromEnv()}/`]);
      const remote = await call(p, "/__lead-sites/local/7", hubFounder("mehroz"));
      expect([remote.status, remote.headers.location]).toEqual([302, `https://${TAILNET}:${previewOriginPort()}/_mu-preview/open/harbour-realty`]);
      const status = JSON.parse((await call(p, "/__lead-sites/status", hubFounder("usman"))).body);
      expect(status.previews[0]).toMatchObject({ slug: "harbour-realty", previewUrl: `https://${TAILNET}:${previewOriginPort()}/_mu-preview/open/harbour-realty` });
      expect(status.previewOrigin).toEqual({ port: previewOriginPort() });
      const local = JSON.parse((await call(p, "/__lead-sites/status", { host: "127.0.0.1:8081" })).body);
      expect(local.previews[0].previewUrl).toBe(`http://harbour-realty.localhost:${previewPortFromEnv()}/`);
      expect((await call(p, "/__lead-sites/local/999", hubFounder("mehroz"))).status).toBe(404);
    });

    test("anything else is refused: no login, a stranger, a non-loopback address, a cross-origin page", async () => {
      expect((await call(p, "/__lead-sites/status", { host: `${TAILNET}:8443` })).status).toBe(401);
      expect((await call(p, "/__lead-sites/status", hubFounder("usman", { "tailscale-user-login": LOGINS.stranger }))).status).toBe(401);
      expect((await call(p, "/__lead-sites/status", hubFounder("usman", { origin: "https://evil.example" }))).status).toBe(403);
      expect((await call(p, "/__lead-sites/status", hubFounder("usman", { origin: `http://${TAILNET}:8443` }))).status).toBe(403); // http, not the Serve https origin
      expect((await call(p, "/__lead-sites/status", hubFounder("usman", { origin: `https://${TAILNET}:8443` }))).status).toBe(200);
    });

    test("writes: a founder's own token works, the internal token and a deploy do not", async () => {
      const body = JSON.stringify({ lead: 424242, by: "usman" });
      const h = (token: string) => hubFounder("mehroz", json(token));
      expect((await call(p, "/__lead-sites/deploy", h(mehrozToken), "POST", JSON.stringify({ lead: 7, by: "mehroz", confirm: "x" }))).status).toBe(403);
      expect((await call(p, "/__lead-sites/takedown", h(mehrozToken), "POST", JSON.stringify({ lead: 7, by: "mehroz" }))).status).toBe(403);
      const noToken = await call(p, "/__lead-sites/thumb", hubFounder("mehroz", { "content-type": "application/json" }), "POST", body);
      expect(noToken.status).toBe(403);
      const raw = await call(p, "/__lead-sites/thumb", h(INTERNAL), "POST", body);
      expect(raw.status).toBe(403); // never substituted for a remote token
      // A good token gets past the checks and fails only on the lead (404), proving the founder reached the route.
      const ok = await call(p, "/__lead-sites/thumb", h(mehrozToken), "POST", body);
      expect([ok.status, JSON.parse(ok.body).error]).toEqual([404, "Lead not found."]);
      // The owner at this PC keeps the internal token.
      const own = await call(p, "/__lead-sites/thumb", json(INTERNAL, { host: "127.0.0.1:8081" }), "POST", body);
      expect(own.status).toBe(404);
    });
  });
});

describe("review fixes: short names, links, and the server-role token swap", () => {
  const site = join(base, "hardening", "site");
  const outside = join(base, "hardening", "outside");
  put(join(site, "index.html"), "<h1>ok</h1>");
  put(join(site, "ordinary.css"), "a{}");
  put(join(site, ".envprobe"), "SECRET=1");
  put(join(site, ".git", "config"), "[core]");
  put(join(outside, "secret.txt"), "outside");

  /** The 8.3 short name Windows gave a dotfile or folder, or null where the volume has none (non-Windows, 8dot3 off). */
  const shortName = (name: string): string | null => {
    if (process.platform !== "win32") return null;
    try {
      const out = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a", site], { encoding: "utf8" });
      const m = out.split("\n").map((l) => l.trimEnd().match(new RegExp(`(\\S+~\\d\\S*)\\s+${name.replace(".", "\\.")}$`, "i"))).find(Boolean);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };

  test("an 8.3 short name never reaches a dotfile or dot-folder", () => {
    for (const [dot, probe] of [[".envprobe", "/ENVPRO~1"], [".git", "/GIT~1/config"]] as const) {
      const real = shortName(dot);
      if (real) expect([dot, resolvePreviewFile(site, `/${real}`)]).toEqual([dot, null]);
      expect([probe, resolvePreviewFile(site, probe)]).toEqual([probe, null]);
    }
    for (const bad of ["/a~1.css", "/ordinary~2", "/x~", "/index.html::$DATA", "/index.html:stream"]) expect([bad, resolvePreviewFile(site, bad)]).toEqual([bad, null]);
    expect(resolvePreviewFile(site, "/ordinary.css")).toBe(join(site, "ordinary.css"));
    expect(resolvePreviewFile(site, "/")).toBe(join(site, "index.html"));
  });

  test("a junction or symlink inside a site is never followed, for files or folders", () => {
    try {
      symlinkSync(outside, join(site, "linked"), "junction");
      symlinkSync(join(outside, "secret.txt"), join(site, "linked-file.txt"), "file");
    } catch {
      return; // this account may not create links here; the isPlainFileInside rows below still run
    }
    expect(resolvePreviewFile(site, "/linked/secret.txt")).toBeNull();
    expect(resolvePreviewFile(site, "/linked-file.txt")).toBeNull();
    expect(isPlainFileInside(site, join(site, "linked", "secret.txt"))).toBe(false);
  });

  test("isPlainFileInside: plain files pass, dotted real components and outside files do not", () => {
    expect(isPlainFileInside(site, join(site, "ordinary.css"))).toBe(true);
    expect(isPlainFileInside(site, join(site, ".envprobe"))).toBe(false);
    expect(isPlainFileInside(site, join(site, ".git", "config"))).toBe(false);
    expect(isPlainFileInside(site, join(outside, "secret.txt"))).toBe(false);
    expect(isPlainFileInside(site, join(site, "missing.css"))).toBe(false);
    expect(isPlainFileInside(site, site)).toBe(false);
  });

  test("server role: the internal token is accepted from a founder only when the gate admitted the request", () => {
    const ctx = identity();
    const viaServe = { socket: { remoteAddress: "127.0.0.1" }, headers: hubFounder("mehroz") };
    const caller = (leadSitesCaller(viaServe, ctx) as { ok: true; caller: Parameters<typeof writeTokenOk>[0] }).caller;
    const atPc = (leadSitesCaller({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8081" } }, ctx) as { ok: true; caller: Parameters<typeof writeTokenOk>[0] }).caller;
    expect(writeTokenOk(caller, INTERNAL, INTERNAL)).toBe(false); // not admitted: a raw internal token from a remote caller
    expect(writeTokenOk(caller, INTERNAL, INTERNAL, false)).toBe(false);
    expect(writeTokenOk(caller, INTERNAL, INTERNAL, true)).toBe(true); // the gate swapped the founder's own token for it
    expect(writeTokenOk(caller, "something-else", INTERNAL, true)).toBe(false);
    expect(writeTokenOk(caller, undefined, INTERNAL, true)).toBe(false);
    expect(writeTokenOk(caller, pageTokenFor(caller.principal, INTERNAL), INTERNAL)).toBe(true); // own token still works
    expect(writeTokenOk(atPc, INTERNAL, INTERNAL)).toBe(true);
    // Without the server-role gate nothing is ever admitted for a founder.
    expect(gateAdmitted(viaServe, root)).toBe(false);
  });
});

describe("the link the UI opens", () => {
  const local = "http://harbour-realty.localhost:8091/";
  test("on the hub's own loopback it is the local copy", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "hub.localhost"]) expect(previewHrefFor(local, { hostname }, 8445)).toBe(local);
    expect(previewHrefFor(local, null, 8445)).toBe(local);
  });
  test("from any other origin it is the hub's preview origin on the same host", () => {
    expect(previewHrefFor(local, { hostname: TAILNET }, 8445)).toBe(`https://${TAILNET}:8445/_mu-preview/open/harbour-realty`);
    expect(previewHrefFor("http://tpl--real-estate.localhost:8091/", { hostname: TAILNET }, 8470)).toBe(`https://${TAILNET}:8470/_mu-preview/open/tpl--real-estate`);
  });
  test("a URL that isn't a *.localhost preview is left alone", () => {
    for (const url of ["https://harbour.muventures.com.au/", "http://127.0.0.1:8123", ""]) expect(previewHrefFor(url, { hostname: TAILNET }, 8445)).toBe(url);
  });
  test("localPreviewHref uses the page's own host (none in a test runner = the local copy)", () => {
    expect(localPreviewHref({ slug: "harbour-realty", localUrl: undefined })).toBe(local);
    expect(localPreviewHref({ slug: "harbour-realty", localUrl: "http://harbour-realty.localhost:8123/" })).toBe("http://harbour-realty.localhost:8123/");
  });
});

describe("design assets: every URL the UI uses is hub-relative", () => {
  const src = (file: string) => readFileSync(join(import.meta.dir, "..", "..", file), "utf8");
  test("no absolute loopback or file URL in the Design room or the memory file search", () => {
    for (const file of ["src/routes/design.tsx", "src/components/operator/mac-memory-search.tsx", "src/components/shell/pages/studio-page.tsx"])
      expect([file, /(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])|file:\/\/)/i.test(src(file))]).toEqual([file, false]);
  });
  test("the URL builders are plain /__design_* paths on the page's own origin", () => {
    const design = src("src/routes/design.tsx");
    expect(design).toContain("const fileUrl = (id: string) => `/__design_file?id=${encodeURIComponent(id)}`;");
    expect(design).toContain("const projectUrl = (id: string) => `/__design_project_asset/${encodeURIComponent(id)}/index.html`;");
    for (const m of design.matchAll(/(?:src|href)=\{?[`"](\/__design_[a-z_]+)/g)) expect(m[1].startsWith("/__design_")).toBe(true);
  });
  test("the server side of those routes lets any verified founder read, and refuses by path not by address", () => {
    const vite = src("vite.config.ts");
    for (const route of ["__design_file", "__design_project_asset", "__design_system_asset", "__design_media"])
      expect(vite).toMatch(new RegExp(`middlewares\\.use\\("/${route}"[\\s\\S]{0,400}founderMayRead\\(req\\)`));
  });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

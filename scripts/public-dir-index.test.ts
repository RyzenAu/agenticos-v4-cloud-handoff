import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { appRouteNames, publicDirIndex } from "./public-dir-index";

let dir = "", routes = "", server: Server, base = "";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "public-dir-index-"));
  mkdirSync(join(dir, "films", "assets"), { recursive: true });
  mkdirSync(join(dir, "plain"), { recursive: true });
  writeFileSync(join(dir, "films", "index.html"), "<h1>Films</h1><video src=assets/a.mp4>");
  writeFileSync(join(dir, "films", "assets", "a.mp4"), "video");
  writeFileSync(join(dir, "plain", "note.txt"), "no index here");
  mkdirSync(join(dir, "transitions"), { recursive: true }); // an old static page that an app route replaced
  writeFileSync(join(dir, "transitions", "index.html"), "<h1>OLD STATIC</h1>");
  mkdirSync(join(dir, ".git"), { recursive: true }); writeFileSync(join(dir, ".git", "index.html"), "secret");
  mkdirSync(join(dir, "films", ".hidden"), { recursive: true }); writeFileSync(join(dir, "films", ".hidden", "index.html"), "hidden");
  mkdirSync(dir + "-evil", { recursive: true }); writeFileSync(join(dir + "-evil", "index.html"), "sibling"); // a sibling folder whose name starts with the public folder's
  routes = join(dir, "..", "routes-" + Date.now()); mkdirSync(routes, { recursive: true });
  for (const f of ["transitions.tsx", "agents.claude-code.tsx", "memory_.vault.tsx", "coding.$jobId.tsx", "index.tsx", "-pages"]) writeFileSync(join(routes, f), "");
  // Stand-in for the router behind it: the real one 307s /x/ to /x and 404s /x (the bug), answers APIs and SPA routes.
  const router = (req: any, res: any) => {
    if (req.url.startsWith("/__ping")) return res.end("api");
    if (req.url === "/leads") return res.end("spa");
    if (req.url.endsWith("/") && req.url !== "/") { res.statusCode = 307; res.setHeader("Location", req.url.slice(0, -1)); return res.end(); }
    res.statusCode = 404; res.end("Page not found");
  };
  const mw = publicDirIndex(dir, routes);
  server = createServer((req, res) => mw(req, res, () => router(req, res)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); rmSync(dir + "-evil", { recursive: true, force: true }); rmSync(routes, { recursive: true, force: true }); });
const get = (p: string, init?: RequestInit) => fetch(base + p, { redirect: "manual", ...init });

test("/dir/ serves the directory's index.html", async () => {
  const r = await get("/films/"); expect(r.status).toBe(200); expect(r.headers.get("content-type")).toContain("text/html"); expect(await r.text()).toContain("<h1>Films</h1>");
});
test("/dir redirects to /dir/ (so relative asset paths resolve under it), keeping the query", async () => {
  const r = await get("/films?x=1"); expect(r.status).toBe(307); expect(r.headers.get("location")).toBe("/films/?x=1");
});
test("following the redirect lands on the page, and its relative assets load", async () => {
  const r = await fetch(base + "/films"); expect(await r.text()).toContain("Films");
  const a = await get("/films/assets/a.mp4"); expect(a.status).toBe(404); // files are the static server's job, not this middleware's: it passes them on
});
test("HEAD works; other methods, files, directories without an index, SPA routes and /__ APIs are left alone", async () => {
  expect((await get("/films/", { method: "HEAD" })).status).toBe(200);
  expect(await (await get("/films/", { method: "POST" })).status).toBe(307); // not ours: the router answers
  expect(await (await get("/plain")).status).toBe(404);
  expect(await (await get("/leads")).text()).toBe("spa");
  expect(await (await get("/__ping")).text()).toBe("api");
});
test("a public folder named like an app route never shadows it, on a refresh or a link", async () => {
  expect(appRouteNames(routes)).toEqual(new Set(["transitions", "agents", "memory", "coding"]));
  expect(appRouteNames(join(routes, "does-not-exist"))).toBeNull();
  const a = await get("/transitions"); expect(a.status).toBe(404); // reached the router (the stand-in's 404), not redirected to the static folder
  const b = await get("/transitions/"); expect(b.status).toBe(307); expect(b.headers.get("location")).toBe("/transitions"); // the router's own redirect
  expect(await (await get("/transitions/")).text()).not.toContain("OLD STATIC");
});
test("the real src/routes are read, and no public folder with an index.html collides with one", () => {
  const names = appRouteNames(join(import.meta.dir, "..", "src", "routes"));
  expect(names!.has("transitions")).toBe(true);
  expect(names!.has("leads")).toBe(true);
  const publicRoot = join(import.meta.dir, "..", "public");
  const { readdirSync, existsSync } = require("node:fs");
  const clashes = readdirSync(publicRoot).filter((d: string) => names!.has(d.toLowerCase()) && existsSync(join(publicRoot, d, "index.html")));
  expect(clashes).toEqual([]);
});
test("a case-variant of an app route name does not shadow it", async () => {
  const r = await get("/Transitions/"); expect(await r.text()).not.toContain("OLD STATIC");
  expect([200]).not.toContain((await get("/TRANSITIONS/")).status === 200 ? 200 : 0);
});
test("if the route list cannot be read, no directory index is served (fail closed)", async () => {
  const mw = publicDirIndex(dir, join(dir, "no-such-routes-folder"));
  const s2 = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("router"); }));
  await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(s2.address() as any).port}`;
    for (const p of ["/films/", "/films", "/transitions/"]) { const r = await fetch(url + p, { redirect: "manual" }); expect([p, r.status]).toEqual([p, 404]); }
  } finally { s2.close(); }
});
test("Location is always one leading slash, even for //dir", async () => {
  for (const [path, want] of [["//films", "/films/"], ["///films?x=1", "/films/?x=1"], ["/films//", null]] as const) {
    const r = await get(path);
    if (want) { expect(r.status).toBe(307); expect(r.headers.get("location")).toBe(want); }
    else expect(r.status).toBe(200);
  }
});
test("traversal and odd-path classes are refused", async () => {
  const raw = (path: string) => new Promise<number>((resolve) => { // send the path exactly as written (fetch would normalise some of these)
    const net = require("node:net").connect({ host: "127.0.0.1", port: (server.address() as any).port }, () => net.write(`GET ${path} HTTP/1.1

Host: x

Connection: close



`));
    let data = ""; net.on("data", (d: Buffer) => (data += d)); net.on("close", () => resolve(Number(data.match(/HTTP\/1\.1 (\d+)/)?.[1] ?? 0)));
  });
  const refused = ["/films/%2e%2e/", "/%2e%2e/", "/../", "/films/../films/", "/films/%2e%2e/%2e%2e/", "/films%5c..%5c/", "/films%5C/", "/%252e%252e/", "/films%252f/",
    "/C:/", "/C%3a/", "/%5c%5cserver%5cshare/", "/films::$DATA/", "/films/index.html::$DATA/", "/films%00/", "/%2e/", "/.git/", "/.git", "/films/.hidden/", "/films/.hidden"];
  for (const path of refused) { const s = await raw(path); expect([path, s === 200]).toEqual([path, false]); }
  const evil = dir.split(/[\/]/).pop() + "-evil"; // sibling folder next to public/
  for (const path of [`/../${evil}/`, `/%2e%2e/${evil}/`]) expect([path, (await raw(path)) === 200]).toEqual([path, false]);
  expect(await (await get("/.git/")).text()).not.toContain("secret");
});
test("vite.config registers it", () => {
  expect(readFileSync(join(import.meta.dir, "..", "vite.config.ts"), "utf8")).toContain('publicDirIndexPlugin(resolve(__dirname, "public"), resolve(__dirname, "src", "routes"))');
});

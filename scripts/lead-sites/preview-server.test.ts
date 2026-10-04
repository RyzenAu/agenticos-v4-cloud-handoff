// The loopback preview server: Host -> folder mapping, clean-URL routes and the traversal guard —
// against a synthetic registry and drafts folder in a temp dir (never the real previews).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, listLocalSites, localPreviewUrl, previewHandler, resolvePreviewFile, resolvePreviewHost } from "./preview-server";

const base = mkdtempSync(join(tmpdir(), "mu-preview-server-"));
const root = join(base, "os");
const drafts = join(base, "drafts");
const leadDir = join(drafts, "harbour-dental", "flagship-preview");
const put = (file: string, body = "x") => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
};

put(join(leadDir, "index.html"), "<h1>home</h1>");
put(join(leadDir, "about.html"), "<h1>about</h1>");
put(join(leadDir, "team", "index.html"), "<h1>team</h1>");
put(join(leadDir, "index.txt"), "rsc");
put(join(leadDir, "_next", "static", "chunks", "a.css"), "body{}");
put(join(leadDir, "404.html"), "<h1>not found</h1>");
put(join(leadDir, "vercel.json"), JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "default-src 'self'" }, { key: "Set-Cookie", value: "no" }] }] }));
put(join(leadDir, ".vercel", "project.json"), "{}");
put(join(drafts, "harbour-dental", "secret.txt"), "sibling file, outside the preview");
put(join(drafts, "harbour-dental", "flagship-preview-evil", "x.html"), "prefix sibling");
put(join(drafts, "_templates", "dental", "index.html"), "<h1>template</h1>");
put(join(drafts, "_templates", "empty", "readme.md"), "no index");
put(join(drafts, "wish-real-estate", "index.html"), "<h1>draft</h1>");
put(join(root, ".operator-data", "lead-sites.json"), JSON.stringify({ version: 1, previews: [{ leadId: 7, slug: "harbour-dental", dir: leadDir, status: "generated" }] }));

const opts = { root, draftsRoot: drafts, port: 8091 };

// The shared fixture is removed once, after every test in this file, so no describe block can delete what another still reads (the order of blocks may vary).
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("host -> preview folder", () => {
  test("a lead slug maps to its registry folder", () => {
    expect(resolvePreviewHost("harbour-dental.localhost:8091", opts)).toEqual({ kind: "lead", name: "harbour-dental", dir: leadDir });
    expect(resolvePreviewHost("HARBOUR-DENTAL.localhost:8091", opts)?.dir).toBe(leadDir);
  });
  test("templates and drafts use their prefixes", () => {
    expect(resolvePreviewHost("tpl--dental.localhost:8091", opts)).toEqual({ kind: "template", name: "tpl--dental", dir: join(drafts, "_templates", "dental") });
    expect(resolvePreviewHost("draft--wish-real-estate.localhost:8091", opts)?.dir).toBe(join(drafts, "wish-real-estate"));
    expect(resolvePreviewHost("tpl--empty.localhost:8091", opts)).toBeNull(); // no index.html
    expect(resolvePreviewHost("draft--harbour-dental.localhost:8091", opts)).toBeNull(); // lead folder, no root index
  });
  test("anything else is refused", () => {
    for (const host of [
      "unknown-business.localhost:8091",
      "harbour-dental.localhost:8081", // wrong port
      "harbour-dental.localhost",
      "harbour-dental.example.com:8091", // DNS rebinding
      "127.0.0.1:8091",
      "localhost:8091",
      "draft--..localhost:8091",
      "tpl--...localhost:8091",
      "draft--_templates.localhost:8091",
      "",
      undefined,
    ])
      expect(resolvePreviewHost(host, opts)).toBeNull();
  });
  test("local URLs are the root of the preview's own origin", () => {
    expect(localPreviewUrl("harbour-dental")).toBe("http://harbour-dental.localhost:8091/");
  });
  test("lists templates and drafts that have an index.html", () => {
    expect(listLocalSites(drafts)).toEqual({ templates: ["dental"], drafts: ["wish-real-estate"] });
  });
});

describe("path -> file", () => {
  test("clean URLs resolve the way a Next export expects", () => {
    expect(resolvePreviewFile(leadDir, "/")).toBe(join(leadDir, "index.html"));
    expect(resolvePreviewFile(leadDir, "/about")).toBe(join(leadDir, "about.html"));
    expect(resolvePreviewFile(leadDir, "/about/")).toBe(join(leadDir, "about.html"));
    expect(resolvePreviewFile(leadDir, "/team")).toBe(join(leadDir, "team", "index.html"));
    expect(resolvePreviewFile(leadDir, "/team/")).toBe(join(leadDir, "team", "index.html"));
    expect(resolvePreviewFile(leadDir, "/index.txt?_rsc=abc")).toBe(join(leadDir, "index.txt"));
    expect(resolvePreviewFile(leadDir, "/_next/static/chunks/a.css")).toBe(join(leadDir, "_next", "static", "chunks", "a.css"));
    expect(resolvePreviewFile(leadDir, "/missing")).toBeNull();
  });
  test("the traversal guard holds for raw, encoded and backslash paths", () => {
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E%2Fsecret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/_next/../../secret.txt",
      "/%2e%2e/flagship-preview-evil/x.html",
      "/..\\secret.txt",
      "/%00index.html",
      "/%E0%A4%A", // malformed encoding
      "/.vercel/project.json",
      "/vercel.json",
    ])
      expect(resolvePreviewFile(leadDir, path)).toBeNull();
  });
  test("isInside rejects the folder's prefix-sharing sibling", () => {
    expect(isInside(leadDir, join(leadDir, "a.html"))).toBe(true);
    expect(isInside(leadDir, `${leadDir}-evil/x.html`)).toBe(false);
    expect(isInside(leadDir, leadDir)).toBe(false);
  });
});

describe("the server", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => previewHandler({ ...opts, port: 8091 })(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
  });
  const get = (path: string, host: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: host } });

  test("serves a preview at the root with noindex and its own CSP", async () => {
    const res = await get("/", "harbour-dental.localhost:8091");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("set-cookie")).toBeNull(); // only allowlisted headers are copied
    const css = await get("/_next/static/chunks/a.css", "harbour-dental.localhost:8091");
    expect(css.headers.get("content-type")).toContain("text/css");
  });
  test("404s: unknown preview, unknown page (with the export's 404.html), traversal", async () => {
    expect((await get("/", "nobody.localhost:8091")).status).toBe(404);
    const page = await get("/nope", "harbour-dental.localhost:8091");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("not found");
    expect((await get("/%2e%2e/secret.txt", "harbour-dental.localhost:8091")).status).toBe(404);
  });
  test("read-only", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { Host: "harbour-dental.localhost:8091" } });
    expect(res.status).toBe(405);
  });
});

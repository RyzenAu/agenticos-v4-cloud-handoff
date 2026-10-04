import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { under } from "../identity/gate";

/**
 * Audit F5 regressions, through the REAL /__* handlers in vite.config.ts (the "claude-os-live-data"
 * plugin) and the API fallback, mounted the way connect mounts them, in a synthetic home.
 * Deliberately imports nothing new from this branch: the same file runs against f334ab7 and
 * fails there, which is the point.
 *
 * Nothing here reaches a provider, spawns an agent or touches the real home: HOME, USERPROFILE,
 * APPDATA and LOCALAPPDATA point at a temp folder and the OneDrive variables are cleared (the
 * Design routes would otherwise resolve the real OneDrive Desktop). Requests that could spend or
 * spawn are only ever sent malformed, so they stop at the body check.
 */

// Some Design routes look for CLIs with a synchronous `where` (Audit F5 P2-4, not this branch's).
setDefaultTimeout(30_000);

const ENV = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "OneDrive", "OneDriveConsumer", "OneDriveCommercial", "AGENTIC_OS_NO_BACKGROUND", "HERMES_HOME", "CLAUDE_BRIDGE_BIN", "ARGENTIC_PREVIEW"];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

type Fn = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => unknown;
const mounts: Array<{ path: string | null; fn: Fn }> = [];
const fakeServer = {
  middlewares: { use: (a: string | Fn, b?: Fn) => void mounts.push(typeof a === "function" ? { path: null, fn: a } : { path: a, fn: b! }) },
  config: { server: { port: 0 } },
  httpServer: null,
};

/** connect's dispatch: prefix mounts ("/" "." or end), prefix stripped for the handler; the end is the app's HTML 404. */
function dispatch(req: IncomingMessage, res: ServerResponse) {
  const original = req.url || "/";
  const path = original.split("?")[0];
  let i = 0;
  const next = (): unknown => {
    req.url = original;
    const m = mounts[i++];
    if (!m) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html");
      return res.end("<!DOCTYPE html><html><body>app 404</body></html>");
    }
    if (m.path === null) return m.fn(req, res, next);
    if (!under(path, m.path.replace(/\/+$/, "") || "/")) return next();
    const rest = original.slice(m.path.replace(/\/+$/, "").length);
    req.url = rest.startsWith("/") ? rest : `/${rest}`;
    return m.fn(req, res, next);
  };
  next();
}

/** While the handlers run: fetch refuses anything not loopback, and the live OS on 8081. */
const realFetch = globalThis.fetch;
function guardNetwork() {
  globalThis.fetch = Object.assign(((input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? ""), "http://127.0.0.1");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port === "8081")
      return Promise.reject(new Error(`test network guard: blocked ${url.origin}`));
    return realFetch(input, init);
  }) as typeof fetch, realFetch);
}

let scratch = "";
let home = "";
let base = "";
let token = "";
let server: Server;
const designs = () => join(home, "Desktop", "designs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function call(method: string, path: string, init: { body?: string | Buffer; headers?: Record<string, string>; token?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== false) headers["X-Claude-OS-Token"] = token;
  if (typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(base + path, { method, headers, body: init.body as any });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, type: res.headers.get("content-type") ?? "", allow: res.headers.get("allow") ?? "", text, json };
  } catch (error) {
    // A dropped connection (the old req.destroy()) is a result too.
    return { status: 0, type: "", allow: "", text: String(error), json: null };
  }
}

beforeAll(async () => {
  guardNetwork();
  scratch = mkdtempSync(join(tmpdir(), "s3-f5-"));
  home = join(scratch, "home");
  for (const dir of [home, join(home, "AppData", "Roaming"), join(home, "AppData", "Local"), join(scratch, "home-evil")]) mkdirSync(dir, { recursive: true });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.HERMES_HOME = join(home, ".hermes");
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial", "CLAUDE_BRIDGE_BIN", "ARGENTIC_PREVIEW"]) delete process.env[k];

  // Fixtures: two design projects (and a page at the designs root itself, the audit's condition for
  // "." deleting everything), a persona, and a zip beside home that only shares its prefix.
  mkdirSync(designs(), { recursive: true });
  writeFileSync(join(designs(), "index.html"), "<html>designs root</html>");
  for (const id of ["alpha-project", "beta-project"]) {
    mkdirSync(join(designs(), id), { recursive: true });
    writeFileSync(join(designs(), id, "index.html"), `<html>${id}</html>`);
  }
  mkdirSync(join(home, ".hermes", "pantheon", "personas"), { recursive: true });
  writeFileSync(join(home, ".hermes", "pantheon", "personas", "oracle.yaml"), "id: oracle\nname: Oracle\nmodel:\n  name: synthetic/x\n");
  writeFileSync(join(scratch, "home-evil", "system.zip"), Buffer.from("PK\u0005\u0006" + "\0".repeat(18), "binary"));

  const mod = await import("../../vite.config.ts");
  const cfg: any = await (mod.default as any)({ command: "serve", mode: "development" });
  const plugins: any[] = (cfg.plugins ?? []).flat(Infinity).filter(Boolean);
  const run = async (name: string) => {
    const p = plugins.find((x) => x.name === name);
    if (!p?.configureServer) return;
    const hook = typeof p.configureServer === "function" ? p.configureServer : p.configureServer.handler;
    await hook.call(p, fakeServer);
  };
  await run("agentic-os-api-json-default"); // pre (this branch only)
  await run("claude-os-live-data");
  await run("agentic-os-api-fallback"); // post (this branch only)
  token = readFileSync(join(home, ".claude-os", "dev-token"), "utf8").trim();

  server = createServer((req, res) => dispatch(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle */
  }
});

describe("P1-1: /__design_project remove", () => {
  test('"." and "..." are refused and every project survives', async () => {
    for (const remove of [".", "...", "", "..", "ALPHA-PROJECT", "alpha-project/..", "../designs", "alpha-project.", "alpha-project ", "alpha-project\u0000", "C:\\", "/", 5, null, ["alpha-project"]]) {
      const r = await call("POST", "/__design_project", { body: JSON.stringify({ remove }) });
      expect([remove, r.status]).toEqual([remove, r.status >= 400 && r.status < 500 ? r.status : -1]);
    }
    expect(existsSync(join(designs(), "index.html"))).toBe(true);
    expect(existsSync(join(designs(), "alpha-project", "index.html"))).toBe(true);
    expect(existsSync(join(designs(), "beta-project", "index.html"))).toBe(true);
  });

  test("a real project goes to the Design trash, recoverable, not deleted", async () => {
    const r = await call("POST", "/__design_project", { body: JSON.stringify({ remove: "beta-project" }) });
    expect(r.status).toBe(200);
    expect(existsSync(join(designs(), "beta-project"))).toBe(false);
    expect(existsSync(join(designs(), "alpha-project", "index.html"))).toBe(true);
    const trash = join(home, ".claude-os", "design", "trash");
    const moved = readdirSync(trash).find((n) => n.endsWith("-beta-project"));
    expect(moved).toBeTruthy();
    expect(readFileSync(join(trash, moved!, "index.html"), "utf8")).toBe("<html>beta-project</html>");
  });

  test("hand-made folders and app ids from non-Latin names can be removed (review S3)", async () => {
    for (const id of ["Acme.Site", "My Project", "Q3_Deck", "-mukt51gi"]) {
      mkdirSync(join(designs(), id), { recursive: true });
      writeFileSync(join(designs(), id, "index.html"), `<html>${id}</html>`);
      const r = await call("POST", "/__design_project", { body: JSON.stringify({ remove: id }) });
      expect([id, r.status]).toEqual([id, 200]);
      expect(existsSync(join(designs(), id))).toBe(false);
    }
    expect(existsSync(join(designs(), "alpha-project", "index.html"))).toBe(true);
  });

  test("an unknown project is 404", async () => {
    expect((await call("POST", "/__design_project", { body: JSON.stringify({ remove: "zz-none" }) })).status).toBe(404);
  });
});

describe("P1-2: /__hermes_image_upload", () => {
  const cache = () => join(home, ".hermes", "image_cache");
  const upload = (body: string | Buffer, type: string, name?: string) =>
    call("POST", "/__hermes_image_upload", { body, headers: { "Content-Type": type, ...(name ? { "X-File-Name": name } : {}) } });

  test("HTML, SVG, non-UTF-8 text and bytes that aren't what they claim are refused, and nothing is written", async () => {
    const cases: Array<[string | Buffer, string, string?]> = [
      ["<html><script>x</script></html>", "text/html", "page.html"],
      ["<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", "logo.svg"],
      ["hello", "image/png"],
      [Buffer.from([0x68, 0x00, 0x69]), "text/plain", "nul.txt"],
      [Buffer.from([0xff, 0xfe, 0xc3, 0x28]), "text/plain", "bad.txt"],
      ["<b>x</b>", "text/plain", "notes.html"],
    ];
    for (const [body, type, name] of cases) {
      const r = await upload(body, type, name);
      expect([name ?? type, r.status]).toEqual([name ?? type, 415]);
      expect(r.json?.error).toBeTruthy(); // the composer shows this
    }
    expect(existsSync(cache()) ? readdirSync(cache()).length : 0).toBe(0);
  });

  test("UTF-8 .txt, .md, .csv and .json attach as text (lead decision after review S3)", async () => {
    for (const [body, type, name, ext] of [
      ["Meeting notes: call Synthetic Dental — ✓", "text/plain", "notes.txt", "txt"],
      ["# Plan\n- one", "text/markdown", "plan.md", "md"],
      ["a,b\n1,2", "text/csv", "rows.csv", "csv"],
      ['{"k":"v"}', "application/json", "data.json", "json"],
    ] as const) {
      const r = await upload(body, type, name);
      expect([name, r.status]).toEqual([name, 200]);
      expect(String(r.json.path).endsWith(`.${ext}`)).toBe(true);
    }
  });

  test("images over 10 MB are 413; PDFs and Office files may be up to 25 MB", async () => {
    const before = existsSync(cache()) ? readdirSync(cache()).length : 0;
    const bigPng = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    expect((await upload(bigPng, "image/png")).status).toBe(413);
    const pdf = (bytes: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(bytes)]);
    expect((await upload(pdf(12 * 1024 * 1024), "application/pdf", "brief.pdf")).status).toBe(200);
    const tooBig = await upload(pdf(25 * 1024 * 1024), "application/pdf", "huge.pdf");
    expect(tooBig.status).toBe(413);
    expect(tooBig.json?.error).toContain("25 MB");
    expect(readdirSync(cache()).length).toBe(before + 1);
  });

  test("a real PNG is saved; the bytes decide the type, not the header", async () => {
    const r = await upload(PNG, "application/octet-stream");
    expect(r.status).toBe(200);
    expect(r.json.type).toBe("image/png");
    expect(String(r.json.path)).toMatch(/\.png$/);
    expect(existsSync(r.json.path)).toBe(true);
  });

  test("the cache is pruned to a bounded size", async () => {
    mkdirSync(cache(), { recursive: true });
    for (let i = 0; i < 230; i++) writeFileSync(join(cache(), `dashboard-${1000 + i}-${i.toString(16).padStart(16, "0")}.png`), PNG);
    writeFileSync(join(cache(), "hermes-own-file.png"), PNG); // not ours: must survive
    expect((await upload(PNG, "image/png")).status).toBe(200);
    const left = readdirSync(cache());
    expect(left.filter((n) => n.startsWith("dashboard-")).length).toBeLessThanOrEqual(200);
    expect(left).toContain("hermes-own-file.png");
  });
});

describe("P2-1: malformed or oversize input is 4xx, never 500", () => {
  const MALFORMED = [
    "/__hermes_moa_save", "/__design_mode", "/__design_carousel", "/__design_publish", "/__design_system", "/__design_project",
    "/__design_export", "/__design_set_key", "/__design_remove_key", "/__design_trash", "/__design_generate", "/__design_index_start",
  ];
  for (const path of MALFORMED)
    test(`${path}: malformed JSON is 400`, async () => {
      const r = await call("POST", path, { body: "{{{not json" });
      expect(r.status).toBe(400);
      expect(r.type).toContain("application/json");
    });

  test("a JSON array or string body is 400, not a destructuring 500", async () => {
    for (const body of ["[]", '"x"', "null"]) expect((await call("POST", "/__design_project", { body })).status).toBe(400);
  });

  test("oversize bodies are 413 with a JSON answer, not a dropped connection", async () => {
    for (const [path, size] of [["/__design_trash", 10_000], ["/__design_set_key", 10_000], ["/__design_author", 40_000], ["/__hermes_moa_save", 300_000]] as const) {
      const r = await call("POST", path, { body: JSON.stringify({ x: "a".repeat(size) }) });
      expect([path, r.status]).toEqual([path, 413]);
      expect(r.json?.error).toBeTruthy();
    }
  });

  test("/__design_schema: an unknown engine is 400 and an unknown model 404", async () => {
    expect((await call("GET", "/__design_schema?engine=zz&model=x")).status).toBe(400);
    for (const engine of ["constructor", "__proto__", "toString"]) expect((await call("GET", `/__design_schema?engine=${engine}&model=x`)).status).toBe(400);
    expect((await call("GET", "/__design_schema")).json).toEqual({ ok: true, params: [] }); // no model chosen yet
    const r = await call("GET", "/__design_schema?engine=higgsfield&model=zz");
    expect(r.status).toBe(404);
  });

  test("/__hermes_effort with no config.yaml: a JSON error without the absolute path", async () => {
    const r = await call("POST", "/__hermes_effort", { body: JSON.stringify({ effort: "low" }) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.type).toContain("application/json");
    expect(r.text).not.toContain(home.replace(/\\/g, "\\\\"));
    expect(r.text).not.toContain("ENOENT");
  });
});

describe("P2-2: unmatched /__* requests get a JSON 404 or 405, never the app's HTML", () => {
  test("an unknown /__ path is a JSON 404", async () => {
    const r = await call("GET", "/__zz-not-a-route");
    expect(r.status).toBe(404);
    expect(r.type).toContain("application/json");
  });

  test("a wrong method on a mounted route is 405 with Allow", async () => {
    const del = await call("DELETE", "/__hermes_moa_save");
    expect(del.status).toBe(405);
    expect(del.allow).toBe("POST, OPTIONS");
    const post = await call("POST", "/__design_makers", { body: "{}" });
    expect(post.status).toBe(405);
    expect(post.allow.split(", ").sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
    const put = await call("PUT", "/__design_project", { body: "{}" });
    expect(put.status).toBe(405);
    expect(put.allow.split(", ").sort()).toEqual(["GET", "HEAD", "OPTIONS", "POST"]);
    // HEAD is answered wherever GET is, with no body; OPTIONS lists the methods.
    const head = await fetch(base + "/__design_makers", { method: "HEAD", headers: { "X-Claude-OS-Token": token } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const options = await call("OPTIONS", "/__hermes_moa_save");
    expect([options.status, options.allow]).toEqual([204, "POST, OPTIONS"]);
  });

  test("Vite's own paths and ordinary pages pass through untouched", async () => {
    for (const path of ["/__vite_ping", "/@vite/client", "/@fs/C:/x", "/some/page"]) {
      const r = await call("GET", path);
      expect([path, r.text]).toEqual([path, "<!DOCTYPE html><html><body>app 404</body></html>"]);
    }
  });
});

describe("P2-3: input that used to be saved or ignored with a 200", () => {
  test("a persona patch with an unknown field or wrong type is 400 and the YAML is unchanged", async () => {
    const file = join(home, ".hermes", "pantheon", "personas", "oracle.yaml");
    const before = readFileSync(file, "utf8");
    for (const patch of [{ persona: "x" }, { name: { x: 1 } }, { skills: "memory" }, { model: "x" }]) {
      const r = await call("PUT", "/__hermes_pantheon/oracle", { body: JSON.stringify(patch) });
      expect([patch, r.status]).toEqual([patch, 400]);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await call("PUT", "/__hermes_pantheon/oracle", { body: JSON.stringify({ job: "Memory" }) })).status).toBe(200);
  });

  test("/__dream_action for an id no Dream ever produced is 404, and nothing is recorded", async () => {
    const r = await call("POST", "/__dream_action", { body: JSON.stringify({ id: "zz-none", action: "dismissed" }) });
    expect(r.status).toBe(404);
    expect(existsSync(join(home, ".claude-os", "dreams", "state.json"))).toBe(false);
  });

  test("/__dream_action for a prescription in a dream file still works", async () => {
    mkdirSync(join(home, ".claude-os", "dreams"), { recursive: true });
    writeFileSync(join(home, ".claude-os", "dreams", "dream-2026-09-28.json"), JSON.stringify({ prescriptions: [{ id: "call-back-lead", title: "x" }] }));
    const r = await call("POST", "/__dream_action", { body: JSON.stringify({ id: "call-back-lead", action: "dismissed" }) });
    expect(r.status).toBe(200);
  });

  test("/__graphify_remove for an unknown id is 404 and the index is untouched", async () => {
    const index = join(import.meta.dir, "..", "..", "src", "data", "graphs", "index.json");
    const before = readFileSync(index);
    try {
      const r = await call("DELETE", "/__graphify_remove?id=zz-none");
      expect(r.status).toBe(404);
    } finally {
      // Whatever the code under test did, the tracked seed index goes back byte for byte.
      writeFileSync(index, before);
    }
  });
});

describe("P2-7, P2-8, P2-10, P3", () => {
  test("P2-7: a sibling folder that only shares home's prefix is refused", async () => {
    const r = await call("POST", "/__design_system", { body: JSON.stringify({ name: "F5 prefix", importPath: join(scratch, "home-evil", "system.zip") }) });
    expect(r.status).toBe(403);
  });

  test("P2-8: Claude is not reported ready without a signed-in Claude Code", async () => {
    const r = await call("GET", "/__design_makers");
    expect(r.status).toBe(200);
    if (process.platform !== "darwin") expect(r.json.makers.claude.ok).toBe(false);
  });

  test("P2-10: two untitled carousels export to two different, safe folders", async () => {
    const carousels = [{ id: "car-one", slides: [] }, { id: "car-two", slides: [] }];
    expect((await call("POST", "/__design_carousel", { body: JSON.stringify({ carousels }) })).status).toBe(200);
    const dirs: string[] = [];
    for (const c of carousels) {
      const r = await call("POST", "/__design_export", { body: JSON.stringify({ carouselId: c.id, html: "<html>deck</html>" }) });
      expect(r.status).toBe(200);
      dirs.push(String(r.json.dir));
    }
    expect(new Set(dirs).size).toBe(2);
    for (const d of dirs) expect(d).not.toContain("undefined");
  });

  test("P3: /__chat_title needs the page token like its siblings", async () => {
    const r = await call("POST", "/__chat_title", { body: JSON.stringify({ user: "", assistant: "" }), token: false });
    expect(r.status).toBe(403);
  });

  test("P3: an early JSON refusal is labelled application/json", async () => {
    const r = await call("DELETE", "/__graphify_remove?id=zz-none", { token: false });
    expect(r.status).toBe(403);
    expect(r.type).toContain("application/json");
  });
});

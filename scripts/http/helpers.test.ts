import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonObject, withBody, withJsonBody } from "./body";
import { apiFallback, apiJsonDefault, scanRouteMethods } from "./not-found";
import { operatorErrorStatus, operatorSettingsError, PayloadTooLarge, ServiceUnavailable } from "./operator-checks";
import {
  designProjectFolder,
  exportFolderName,
  isDesignProjectIdShape,
  hideHomePaths,
  isInside,
  knownDreamIds,
  moveIntoTrash,
  personaPatchError,
  sharedView,
} from "./route-checks";
import { DOCUMENT_LIMIT, IMAGE_LIMIT, pruneUploadCache, sniffUpload, TEXT_LIMIT } from "./upload";

/** A one-route server around a handler, for the body readers. */
async function serve(handler: Parameters<typeof createServer>[1], run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("body readers (P2-1, P3)", () => {
  test("withJsonBody: 400 for malformed or non-object JSON, 413 over the limit, the text otherwise", async () => {
    const seen: string[] = [];
    await serve(
      (req, res) => withJsonBody(req, res, 1000, (body) => { seen.push(body); res.end("ok"); }),
      async (url) => {
        const post = (body: string) => fetch(url, { method: "POST", body }).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), text: await r.text() }));
        expect((await post("{{{")).status).toBe(400);
        expect((await post("[1]")).status).toBe(400);
        expect((await post("null")).status).toBe(400);
        const big = await post(JSON.stringify({ x: "a".repeat(5000) }));
        expect(big.status).toBe(413);
        expect(big.type).toContain("application/json");
        expect(JSON.parse(big.text).error).toContain("too large");
        expect((await post("")).text).toBe("ok");
        expect((await post('{"a":1}')).text).toBe("ok");
      },
    );
    expect(seen).toEqual(["", '{"a":1}']);
  });

  test("a declared Content-Length over the limit is refused without buffering, and the sender reads the 413", async () => {
    let called = false;
    await serve(
      (req, res) => withBody(req, res, 100, () => { called = true; res.end("ok"); }),
      async (url) => {
        const r = await fetch(url, { method: "POST", body: Buffer.alloc(3 * 1024 * 1024, 97) });
        expect(r.status).toBe(413);
      },
    );
    expect(called).toBe(false);
  });

  test("readJsonObject resolves {} for an empty body and the object otherwise", async () => {
    const got: unknown[] = [];
    await serve(
      async (req, res) => {
        const v = await readJsonObject(req, res, 1000);
        got.push(v);
        if (v) res.end("ok");
      },
      async (url) => {
        await fetch(url, { method: "POST", body: "" });
        await fetch(url, { method: "POST", body: '{"k":"v"}' });
        expect((await fetch(url, { method: "POST", body: "{" })).status).toBe(400);
      },
    );
    expect(got).toEqual([{}, { k: "v" }, null]);
  });
});

describe("the /__* fallback (P2-2)", () => {
  const SOURCE = `
    server.middlewares.use("/__only_get", (req, res, next) => { if (req.method !== "GET") return next(); });
    server.middlewares.use("/__get_post", (req, res, next) => { if (req.method === "GET") {} if (req.method !== "POST") return next(); });
    server.middlewares.use("/__put_delete/", (req, res, next) => { if (req.method !== "PUT" && req.method !== "DELETE") return next(); });
    server.middlewares.use("/__any", (req, res) => { res.end(); });
    server.middlewares.use("/__listed", (req, res, next) => { if (!["GET", "HEAD"].includes(req.method || "GET")) return next(); });
  `;
  test("scanRouteMethods reads each route's methods; prefix mounts and method-blind routes are left out", () => {
    const m = scanRouteMethods(SOURCE);
    expect(m.get("/__only_get")).toEqual(["GET"]);
    expect(m.get("/__get_post")).toEqual(["GET", "POST"]);
    expect(m.get("/__listed")).toEqual(["GET", "HEAD"]);
    expect(m.has("/__put_delete/")).toBe(false);
    expect(m.has("/__any")).toBe(false);
  });

  test("the real vite.config.ts gives the audit's wrong-method rows an Allow", () => {
    const m = scanRouteMethods(readFileSync(join(import.meta.dir, "..", "..", "vite.config.ts"), "utf8"));
    expect(m.get("/__hermes_moa_save")).toEqual(["POST"]);
    expect(m.get("/__design_makers")).toEqual(["GET"]);
    expect(m.get("/__design_project")).toEqual(["GET", "POST"]);
    expect(m.size).toBeGreaterThan(60);
  });

  test("404 JSON for unknown, 405 + Allow for a wrong method, and Vite/dev-tool paths pass through", async () => {
    const fallback = apiFallback(() => scanRouteMethods(SOURCE));
    await serve(
      (req, res) => fallback(req, res, () => { res.statusCode = 299; res.end("passed"); }),
      async (url) => {
        const r = (method: string, path: string) => fetch(url.replace(/\/$/, "") + path, { method }).then(async (x) => ({ status: x.status, allow: x.headers.get("allow"), type: x.headers.get("content-type"), text: await x.text() }));
        const unknown = await r("GET", "/__nope");
        expect([unknown.status, unknown.type]).toEqual([404, "application/json"]);
        const wrong = await r("POST", "/__only_get");
        expect([wrong.status, wrong.allow]).toEqual([405, "GET, HEAD, OPTIONS"]);
        const options = await r("OPTIONS", "/__only_get");
        expect([options.status, options.allow, options.type]).toEqual([204, "GET, HEAD, OPTIONS", null]);
        // A method the route takes but that still fell through (e.g. an unknown sub-path) is a 404.
        expect((await r("GET", "/__only_get")).status).toBe(404);
        for (const path of ["/__vite_ping", "/__open-in-editor?file=x", "/__lovable/restart-announce", "/__hmr_gate", "/@vite/client", "/@fs/x", "/", "/business"])
          expect([path, (await r("GET", path)).status]).toEqual([path, 299]);
      },
    );
  });

  test("apiJsonDefault labels an unlabelled JSON answer and leaves typed or non-JSON answers alone", async () => {
    const label = apiJsonDefault();
    await serve(
      (req, res) =>
        label(req, res, () => {
          if (req.url === "/__json") return res.end('{"error":"x"}');
          if (req.url === "/__text") return res.end("plain");
          if (req.url === "/__typed") { res.setHeader("Content-Type", "text/html"); return res.end("{html}"); }
          res.end('{"page":1}');
        }),
      async (url) => {
        const type = (p: string) => fetch(url.replace(/\/$/, "") + p).then((x) => x.headers.get("content-type") ?? "");
        expect(await type("/__json")).toBe("application/json");
        expect(await type("/__text")).not.toContain("json");
        expect(await type("/__typed")).toBe("text/html");
        expect(await type("/page")).not.toContain("json"); // not an API path
      },
    );
  });

  test("HEAD on an API path is handled as a GET, with no body", async () => {
    const label = apiJsonDefault();
    const seen: string[] = [];
    await serve(
      (req, res) =>
        label(req, res, () => {
          seen.push(String(req.method));
          if (req.method !== "GET") { res.statusCode = 404; return res.end(); }
          res.write('{"a":');
          res.end("1}");
        }),
      async (url) => {
        const r = await fetch(url.replace(/\/$/, "") + "/__only_get", { method: "HEAD" });
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/json");
        expect(await r.text()).toBe("");
      },
    );
    expect(seen).toEqual(["GET"]);
  });
});

describe("uploads (P1-2)", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  test("the bytes decide: images by magic number, PDFs, and Office files only with their part", () => {
    expect(sniffUpload(PNG)?.ext).toBe("png");
    expect(sniffUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext).toBe("jpg");
    expect(sniffUpload(Buffer.from("GIF89a....."))?.ext).toBe("gif");
    expect(sniffUpload(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.ext).toBe("webp");
    expect(sniffUpload(Buffer.from("%PDF-1.7\n..."))?.ext).toBe("pdf");
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml")]);
    expect(sniffUpload(docx, "", "Plan.docx")?.ext).toBe("docx");
    expect(sniffUpload(docx, "", "Plan.xlsx")).toBeNull(); // claims xlsx, holds a Word part
    for (const junk of ["{}", "{{{not json", "<svg/>", "hello", ""]) expect(sniffUpload(Buffer.from(junk), "image/png", "x.png")).toBeNull();
  });

  test("text: .txt/.md/.csv/.json when valid UTF-8 with no NUL; never HTML or SVG; per-kind limits", () => {
    expect(sniffUpload(Buffer.from("notes ✓"), "text/plain", "a.txt")).toMatchObject({ ext: "txt", limit: TEXT_LIMIT });
    expect(sniffUpload(Buffer.from("# x"), "", "a.MD")?.ext).toBe("md");
    expect(sniffUpload(Buffer.from("a,b"), "text/csv", "")?.ext).toBe("csv"); // no name: the type decides
    expect(sniffUpload(Buffer.from("{}"), "application/json", "")?.ext).toBe("json");
    expect(sniffUpload(Buffer.from("<p>x</p>"), "text/html", "a.html")).toBeNull();
    expect(sniffUpload(Buffer.from("<svg/>"), "image/svg+xml", "a.svg")).toBeNull();
    expect(sniffUpload(Buffer.from("<p>x</p>"), "text/plain", "a.html")).toBeNull(); // a named non-text extension wins
    expect(sniffUpload(Buffer.from([0x61, 0x00]), "text/plain", "a.txt")).toBeNull();
    expect(sniffUpload(Buffer.from([0xc3, 0x28]), "text/plain", "a.txt")).toBeNull();
    expect(sniffUpload(PNG)?.limit).toBe(IMAGE_LIMIT);
    expect(sniffUpload(Buffer.from("%PDF-1.4"))?.limit).toBe(DOCUMENT_LIMIT);
    expect(DOCUMENT_LIMIT).toBe(25 * 1024 * 1024);
    expect(IMAGE_LIMIT).toBe(10 * 1024 * 1024);
  });

  test("pruning keeps the newest of OUR uploads within the limits and never touches other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-prune-"));
    try {
      const now = Date.now();
      for (let i = 0; i < 12; i++) {
        const f = join(dir, `dashboard-${now - i}-${i.toString(16).padStart(16, "0")}.png`);
        writeFileSync(f, Buffer.alloc(10));
        utimesSync(f, (now - i * 1000) / 1000, (now - i * 1000) / 1000);
      }
      const old = join(dir, `dashboard-1-${"f".repeat(16)}.png`);
      writeFileSync(old, Buffer.alloc(10));
      utimesSync(old, 1, 1);
      writeFileSync(join(dir, "hermes-telegram-photo.jpg"), Buffer.alloc(10));
      expect(pruneUploadCache(dir, { maxFiles: 5, now })).toBe(8);
      const left = readdirSync(dir);
      expect(left).toContain("hermes-telegram-photo.jpg");
      expect(left.filter((n) => n.startsWith("dashboard-")).length).toBe(5);
      expect(existsSync(old)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("route checks", () => {
  test("P1-1: only the exact name of a folder directly inside the designs root", () => {
    const root = mkdtempSync(join(tmpdir(), "s3-designs-"));
    try {
      const listed = ["alpha-mn3k2", "my deck_2", "Acme.Site", "My Project", "Q3_Deck", "-mukt51gi", "ملف"];
      for (const id of listed) mkdirSync(join(root, id));
      writeFileSync(join(root, "loose-file"), "x");
      for (const id of listed) expect([id, designProjectFolder(root, id)]).toEqual([id, join(root, id)]);
      for (const shape of ["Acme.Site", "-x", " x", "a.b"]) expect(isDesignProjectIdShape(shape)).toBe(true);
      const bad = [".", "..", "...", "", "a/b", "a\\b", "../x", "x.", "x ", "Acme.Site.", "a\u0000b", "C:", "C:\\x", "/abs", 5, null, undefined, "a".repeat(201)];
      for (const id of bad) expect([id, isDesignProjectIdShape(id), designProjectFolder(root, id)]).toEqual([id, false, null]);
      // Shape-valid but not an exact directory entry: another case, a file, a missing folder.
      for (const id of ["ACME.SITE", "loose-file", "nope"]) expect([id, designProjectFolder(root, id)]).toEqual([id, null]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P1-1: moveIntoTrash keeps the folder whole, under a unique name", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-trash-"));
    try {
      mkdirSync(join(dir, "p", "images"), { recursive: true });
      writeFileSync(join(dir, "p", "index.html"), "x");
      const moved = moveIntoTrash(join(dir, "p"), join(dir, "trash"));
      expect(existsSync(join(dir, "p"))).toBe(false);
      expect(readFileSync(join(moved, "index.html"), "utf8")).toBe("x");
      expect(existsSync(join(moved, "images"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("P2-7: inside home, never a sibling that shares its prefix", () => {
    const home = join("C:", "Users", "Synth");
    expect(isInside(home, home)).toBe(true);
    expect(isInside(home, join(home, "Downloads", "x.zip"))).toBe(true);
    expect(isInside(home, `${home}-evil${join("/", "x.zip")}`)).toBe(false);
    expect(isInside(home, join("C:", "Users", "Synthetic", "x.zip"))).toBe(false);
  });

  test("P2-10: untitled decks get their own folder; titled ones keep their old name", () => {
    expect(exportFolderName(undefined, "car-one")).toBe("carousel-car-one-deck");
    expect(exportFolderName("", "car-two")).toBe("carousel-car-two-deck");
    expect(exportFolderName("Launch Week!", "x")).toBe("launch-week-deck");
    expect(exportFolderName(undefined, undefined, 1_700_000_000_000)).toBe(`carousel-${(1_700_000_000_000).toString(36)}-deck`);
    expect(exportFolderName("../../etc", "../x")).toBe("etc-deck");
  });

  test("P2-3: persona patches", () => {
    expect(personaPatchError({ persona: "x" })).toContain("Unknown persona field");
    expect(personaPatchError("x")).toBeTruthy();
    expect(personaPatchError({})).toBeTruthy();
    expect(personaPatchError({ skills: ["a", 1] })).toBeTruthy();
    expect(personaPatchError({ model: { name: "x", effort: null } })).toBeNull();
    expect(personaPatchError({ job: "Memory", behavior: { system_prompt: "x" } })).toBeNull();
  });

  test("P2-3: Dream ids come from live data, dream files and state", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3-dream-"));
    try {
      writeFileSync(join(dir, "live.json"), JSON.stringify({ dream: { prescriptions: [{ id: "a" }] } }));
      mkdirSync(join(dir, "dreams"));
      writeFileSync(join(dir, "dreams", "dream-2026-09-27.json"), JSON.stringify({ prescriptions: [{ id: "b" }, { id: 7 }] }));
      writeFileSync(join(dir, "dreams", "state.json"), JSON.stringify({ actions: { c: {} } }));
      expect([...knownDreamIds(join(dir, "live.json"), join(dir, "dreams"))].sort()).toEqual(["7", "a", "b", "c"]);
      expect(knownDreamIds(join(dir, "missing.json"), join(dir, "none")).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("P3: a remote caller's shared view has home paths as ~, the owner's has them real", () => {
    const home = "C:\\Users\\Synth";
    const body = { dir: "C:\\Users\\Synth\\Desktop\\designs", items: [{ path: "c:/users/synth/x.png", id: "b64" }], other: "D:\\data", home };
    expect(hideHomePaths(body, home)).toEqual({ dir: "~/Desktop/designs", items: [{ path: "~/x.png", id: "b64" }], other: "D:\\data", home: "~" });
    expect(sharedView(true, body, home)).toBe(body);
    expect(JSON.stringify(sharedView(false, body, home))).not.toContain("Synth");
  });
});

describe("operator checks (P2-3, P3)", () => {
  test("settings: known switches as booleans only", () => {
    expect(operatorSettingsError({ news: true, inboxAccounts: { gmail: false } })).toBeNull();
    expect(operatorSettingsError({ news: "yes" })).toContain("true or false");
    expect(operatorSettingsError({ zz: 1 })).toContain("Unknown setting");
    expect(operatorSettingsError({ inboxAccounts: { fax: true } })).toContain("Unknown inbox account");
    expect(operatorSettingsError([])).toBeTruthy();
    expect(operatorSettingsError({})).toBeTruthy();
  });

  test("error status: 413, 503, the plugin's 409/403, else 400", () => {
    class Conflict extends Error {}
    class Local extends Error {}
    expect(operatorErrorStatus(new PayloadTooLarge("x"))).toBe(413);
    expect(operatorErrorStatus(new ServiceUnavailable("x"))).toBe(503);
    expect(operatorErrorStatus(new Conflict("x"), { conflict: Conflict, localOnly: Local })).toBe(409);
    expect(operatorErrorStatus(new Local("x"), { conflict: Conflict, localOnly: Local })).toBe(403);
    expect(operatorErrorStatus(new Error("bad input"))).toBe(400);
  });
});

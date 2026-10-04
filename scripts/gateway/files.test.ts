import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedRoots, cleanRelative, createGatewayFiles, deniedName, FILE_LIMITS, FileRefusal, rootRefusal } from "./files";

/** Files through the gateway: the approved roots and nothing else. Real folders under a temp dir; no network. */

const base = mkdtempSync(join(tmpdir(), "gw-files-"));
afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});
const hubRoot = join(base, "hub");
const dataDir = join(base, "hub-data");
const designs = join(base, "designs");
const projects = join(base, "client-projects");
const readonlyRoot = join(base, "reference");
const outside = join(base, "outside");
for (const d of [hubRoot, dataDir, designs, projects, readonlyRoot, outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(designs, "index.html"), "<h1>Synthetic design</h1>");
mkdirSync(join(designs, "dental-concept", "assets"), { recursive: true });
writeFileSync(join(designs, "dental-concept", "index.html"), "<p>synthetic concept</p>");
writeFileSync(join(designs, "dental-concept", "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
writeFileSync(join(designs, ".env"), "SECRET=never-read");
writeFileSync(join(designs, "credentials.json"), "{}");
writeFileSync(join(designs, "site.sqlite"), "db");
writeFileSync(join(designs, "notes.md.bak-20261001"), "old");
writeFileSync(join(readonlyRoot, "brand.md"), "# Brand\n");
writeFileSync(join(outside, "private.txt"), "OUTSIDE-MARKER");

const env = { MU_DATA_DIR: dataDir, MU_DESIGN_PROJECTS_DIR: designs, MU_GATEWAY_FILE_ROOTS: `projects=${projects};reference=${readonlyRoot}|ro` };
const files = createGatewayFiles({ root: hubRoot, env });
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const refusal = (run: () => unknown): { status: number; message: string } | null => {
  try {
    run();
    return null;
  } catch (e) {
    if (e instanceof FileRefusal) return { status: e.status, message: e.message };
    throw e;
  }
};

describe("the approved roots", () => {
  test("drafts is always there; designs and the owner's listed roots only when the hub sets them", () => {
    expect(files.roots().roots.map((r) => [r.name, r.writable, r.ready])).toEqual([["drafts", true, true], ["designs", true, true], ["projects", true, true], ["reference", false, true]]);
    const bare = createGatewayFiles({ root: hubRoot, env: { MU_DATA_DIR: dataDir } });
    // No MU_DESIGN_PROJECTS_DIR: the default design folder is a founder's Desktop, which is never opened to the gateway.
    expect(bare.roots().roots.map((r) => r.name)).toEqual(["drafts"]);
    expect(refusal(() => bare.list("designs", ""))).toMatchObject({ status: 404 });
    // The answer never carries a path.
    expect(JSON.stringify(files.roots())).not.toContain(base);
  });

  test("a root that is the data folder, a home, a drive, a vault or a backup folder is refused", () => {
    const home = join(base, "home", "someone");
    expect(rootRefusal(dataDir, dataDir, home)).toContain("data folder");
    expect(rootRefusal(join(dataDir, "designs"), dataDir, home)).toContain("data folder");
    expect(rootRefusal(base, dataDir, home)).not.toBeNull(); // a folder around the data folder (and around a home)
    expect(rootRefusal(join(base, "hub-data-parent"), join(base, "hub-data-parent", "data"), home)).toContain("data folder");
    expect(rootRefusal(home, dataDir, home)).toContain("home");
    expect(rootRefusal(join(base, "home"), dataDir, home)).toContain("home");
    expect(rootRefusal(process.platform === "win32" ? "C:\\" : "/", dataDir, home)).toContain("root");
    expect(rootRefusal("relative/path", dataDir, home)).toContain("absolute");
    for (const bad of ["mu-ventures-obsidian-wiki-vault", "backups", "hub-backup-2026", "Obsidian Vault", ".config", ".ssh", "node_modules"]) expect([bad, rootRefusal(join(outside, bad, "x"), dataDir, home) !== null]).toEqual([bad, true]);
    expect(rootRefusal(projects, dataDir, home)).toBeNull();
    const listed = approvedRoots(hubRoot, { MU_DATA_DIR: dataDir, MU_GATEWAY_FILE_ROOTS: `data=${dataDir};Bad Name=${projects};projects=${projects};projects=${outside};novalue` });
    expect(listed.roots.map((r) => r.name)).toEqual(["drafts", "projects"]);
    expect(listed.refused.length).toBe(4);
  });
});

describe("reading", () => {
  test("list and read inside a root; text as utf8, anything else as base64, with a hash", () => {
    const top = files.list("designs", "");
    // The secret-bearing, database and backup files are simply not there.
    expect(top.entries.map((e) => [e.name, e.kind])).toEqual([["dental-concept", "folder"], ["index.html", "file"]]);
    expect(files.list("designs", "dental-concept/assets").entries.map((e) => e.name)).toEqual(["logo.png"]);
    const page = files.read("designs", "dental-concept/index.html");
    expect(page).toMatchObject({ root: "designs", path: "dental-concept/index.html", encoding: "utf8", content: "<p>synthetic concept</p>", sha256: sha("<p>synthetic concept</p>") });
    const logo = files.read("designs", "dental-concept/assets/logo.png");
    expect(logo.encoding).toBe("base64");
    expect(Buffer.from(logo.content, "base64").length).toBe(8);
    expect(JSON.stringify([top, page])).not.toContain(base);
    expect(refusal(() => files.read("designs", "nope.html"))).toMatchObject({ status: 404 });
    expect(refusal(() => files.read("designs", "dental-concept"))).toMatchObject({ status: 400 });
    expect(refusal(() => files.read("nowhere", "index.html"))).toMatchObject({ status: 404 });
  });

  test("no traversal, absolute path, drive, stream, encoded or odd name ever leaves the root", () => {
    for (const p of ["../outside/private.txt", "..", "dental-concept/../../outside/private.txt", "/etc/passwd", "C:/Windows/win.ini", "C:\\Windows\\win.ini", "\\\\server\\share\\x", "index.html::$DATA", "index.html:stream", "a\u0000b", "%2e%2e/outside/private.txt", "dental-concept/./index.html", "dental-concept//index.html", "index.html.", "dental-concept /index.html", "con", "nul.txt", "~/x", "a/".repeat(13) + "x.md", "x".repeat(700)]) {
      const r = refusal(() => files.read("designs", p));
      expect([p.slice(0, 40), r !== null && r.status >= 400 && r.status < 500]).toEqual([p.slice(0, 40), true]);
      expect(refusal(() => files.list("designs", p)) !== null || p === "..").toBe(true);
      expect(refusal(() => files.write("designs", p, { content: "x" })) !== null).toBe(true);
    }
    expect(existsSync(join(outside, "private.txt"))).toBe(true);
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("OUTSIDE-MARKER");
  });

  test("secrets, credentials, databases, backups and dot files are never read, listed or written", () => {
    for (const name of [".env", ".env.local", "prod.env", "credentials.json", "credentials", "secrets.json", "api-key.txt", "apikey.md", "private-key.txt", "id_rsa", "server.pem", "cert.pfx", "auth.json", "oauth_creds.json", "tokens.json", "session-store.json", "config.yaml", "site.sqlite", "crm.sqlite-wal", "data.db", "hub.log", "notes.md.bak-20261001", "x.bak", "backups", "backup", "node_modules", "refresh-token.txt", "passwords.txt"])
      expect([name, deniedName(name)]).toEqual([name, true]);
    for (const name of ["index.html", "monkey.html", "keynote.md", "keyboard.css", "hockey-club.json", "design-tokens-palette.md".replace("tokens", "swatches"), "environment.md", "session-notes.md"]) expect([name, deniedName(name)]).toEqual([name, false]);
    expect(refusal(() => files.read("designs", "credentials.json"))).toMatchObject({ status: 403 });
    expect(refusal(() => files.read("designs", "site.sqlite"))).toMatchObject({ status: 403 });
    expect(refusal(() => files.read("designs", ".env"))).toMatchObject({ status: 400 }); // a dot name is not a plain name at all
    expect(refusal(() => files.write("designs", "dental-concept/secrets.json", { content: "{}" }))).toMatchObject({ status: 403 });
    expect(refusal(() => cleanRelative("a/backups/x.md"))).toMatchObject({ status: 403 });
  });

  test("a link or junction inside a root is never followed, listed, read or written through", () => {
    const linkDir = join(designs, "linked-out");
    let made = false;
    try {
      symlinkSync(outside, linkDir, "junction");
      made = true;
    } catch {
      /* no permission to make links here: the hard-link case below still runs */
    }
    if (made) {
      expect(files.list("designs", "").entries.map((e) => e.name)).not.toContain("linked-out");
      expect(refusal(() => files.read("designs", "linked-out/private.txt"))).toMatchObject({ status: 403 });
      expect(refusal(() => files.list("designs", "linked-out"))).toMatchObject({ status: 403 });
      expect(refusal(() => files.write("designs", "linked-out/new.md", { content: "x" }))).toMatchObject({ status: 403 });
      expect(readdirSync(outside)).toEqual(["private.txt"]);
    }
    // A hard link: a second name for a file outside the root.
    try {
      linkSync(join(outside, "private.txt"), join(designs, "alias.txt"));
      expect(refusal(() => files.read("designs", "alias.txt"))).toMatchObject({ status: 403 });
      expect(refusal(() => files.write("designs", "alias.txt", { content: "overwrite" }))).toMatchObject({ status: 403 });
      expect(files.list("designs", "").entries.map((e) => e.name)).not.toContain("alias.txt");
      expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("OUTSIDE-MARKER");
      rmSync(join(designs, "alias.txt"));
    } catch (e) {
      if (e instanceof Error && /expect/.test(e.stack ?? "")) throw e;
    }
  });

  test("a file over the read limit is refused, not truncated", () => {
    writeFileSync(join(projects, "big.txt"), Buffer.alloc(FILE_LIMITS.readBytes + 1, 97));
    expect(refusal(() => files.read("projects", "big.txt"))).toMatchObject({ status: 413 });
    rmSync(join(projects, "big.txt"));
  });
});

describe("writing", () => {
  test("write, read back, overwrite and reverse: the previous hash comes back, and a stale write is refused", () => {
    const first = files.write("drafts", "proposals/synthetic-dental.md", { content: "# Draft\nv1\n", expectedSha256: "absent" });
    expect(first).toMatchObject({ root: "drafts", path: "proposals/synthetic-dental.md", created: true, previousSha256: null, sha256: sha("# Draft\nv1\n") });
    expect(files.read("drafts", "proposals/synthetic-dental.md").content).toBe("# Draft\nv1\n");
    // "It must not exist yet" now fails; so does a hash that is not the current one. Nothing is written either time.
    expect(refusal(() => files.write("drafts", "proposals/synthetic-dental.md", { content: "clobber", expectedSha256: "absent" }))).toMatchObject({ status: 409 });
    expect(refusal(() => files.write("drafts", "proposals/synthetic-dental.md", { content: "clobber", expectedSha256: sha("something else") }))).toMatchObject({ status: 409 });
    const second = files.write("drafts", "proposals/synthetic-dental.md", { content: "# Draft\nv2\n", expectedSha256: first.sha256 });
    expect(second).toMatchObject({ created: false, previousSha256: first.sha256 });
    // Reverse it: write the earlier content again, guarded by the current hash.
    const back = files.write("drafts", "proposals/synthetic-dental.md", { content: "# Draft\nv1\n", expectedSha256: second.sha256 });
    expect(back.sha256).toBe(first.sha256);
    // No temp file is left behind, and the drafts root lives in the hub's data folder under gateway/files.
    expect(readdirSync(join(dataDir, "gateway", "files", "drafts", "proposals"))).toEqual(["synthetic-dental.md"]);
  });

  test("only documents and web assets, within the size cap; base64 for binary; read-only roots refuse", () => {
    for (const name of ["run.ps1", "run.sh", "tool.exe", "macro.bat", "script.py", "archive.zip", "server.ts", "noext", "page.php"]) expect([name, refusal(() => files.write("projects", name, { content: "x" }))?.status]).toEqual([name, 403]);
    expect(refusal(() => files.write("projects", "big.md", { content: "x".repeat(FILE_LIMITS.writeBytes + 1) }))).toMatchObject({ status: 413 });
    expect(refusal(() => files.write("projects", "a.md", { content: 42 }))).toMatchObject({ status: 400 });
    expect(refusal(() => files.write("projects", "a.png", { content: "not base64!!", encoding: "base64" }))).toMatchObject({ status: 400 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    expect(files.write("projects", "brand/mark.png", { content: png.toString("base64"), encoding: "base64" })).toMatchObject({ bytes: 6, sha256: sha(png) });
    expect(Buffer.from(files.read("projects", "brand/mark.png").content, "base64").equals(png)).toBe(true);
    expect(refusal(() => files.write("reference", "brand.md", { content: "changed" }))).toMatchObject({ status: 403 });
    expect(readFileSync(join(readonlyRoot, "brand.md"), "utf8")).toBe("# Brand\n");
    expect(refusal(() => files.write("projects", "brand", { content: "x" }))).not.toBeNull(); // a folder has that name (and no extension)
    expect(refusal(() => files.write("projects", "", { content: "x" }))).toMatchObject({ status: 400 });
  });
});

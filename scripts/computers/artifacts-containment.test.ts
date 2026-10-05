// Only temporary, synthetic artifacts. These checks do not exercise a hostile concurrent filesystem or Windows itself.
import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore, type ArtifactInput } from "./artifacts";

const JOB = "abcdefab-2222-4333-8444-555555555555";
const OTHER = "abcdefab-2222-4333-8444-555555555556";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = (over: Partial<ArtifactInput> = {}): ArtifactInput => ({ jobId: JOB, personId: "founder", kind: "research", title: "Synthetic", summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "inside" }], ...over });
function fixture(saved = true) {
  const root = mkdtempSync(join(tmpdir(), "artifact-containment-")); dirs.push(root);
  const dir = join(root, "artifacts");
  const store = createArtifactStore(dir);
  if (saved) expect(store.save(input())).toMatchObject({ ok: true, created: true });
  const job = join(dir, JOB), meta = join(job, "meta.json"), file = join(job, "report.md");
  const outside = join(root, "outside.txt"); writeFileSync(outside, "outside marker");
  return { root, dir, store, job, meta, file, outside };
}
function hidden(store: ReturnType<typeof createArtifactStore>) {
  expect(store.get(JOB, "founder")).toBeNull();
  expect(store.ownerOf(JOB)).toBeNull();
  expect(store.listAll()).toEqual([]);
  expect(store.list("founder")).toEqual([]);
  expect(store.file(JOB, "founder", "report.md")).toBeNull();
}
function editMeta(meta: string, change: (value: any) => unknown) {
  writeFileSync(meta, JSON.stringify(change(JSON.parse(readFileSync(meta, "utf8")))));
}
const directoryLink = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

describe("artifact containment and saved metadata", () => {
  test("ordinary results survive restart, preserve first-save-wins and remain available to the routes' authorized owner lookup", () => {
    const f = fixture(); const first = f.store.get(JOB, "founder");
    const store = createArtifactStore(f.dir);
    expect(store.get(JOB.toUpperCase(), "founder")).toEqual(first);
    expect(store.save(input({ title: "Changed", files: [] }))).toEqual({ ok: true, meta: first!, created: false });
    expect(store.listAll()).toEqual([first!]);
    expect(store.file(JOB, store.ownerOf(JOB)!, "report.md")?.data.toString()).toBe("inside");
    expect(store.file(JOB, "other founder", "report.md")).toBeNull();
    expect(store.save(input({ jobId: OTHER, main: "empty.txt", files: [{ name: "empty.txt", data: "" }, { name: "a", data: "one" }, { name: "a.tmp", data: "two" }] }))).toMatchObject({ ok: true });
    expect(store.file(OTHER, "founder", "empty.txt")?.data.length).toBe(0);
    expect(store.file(OTHER, "founder", "a")?.data.toString()).toBe("one");
    expect(store.file(OTHER, "founder", "a.tmp")?.data.toString()).toBe("two");
  });

  for (const target of ["outside", "inside", "dangling"] as const) test(`a ${target} file symlink cannot be read, including after restart`, () => {
    const f = fixture(); unlinkSync(f.file);
    const destination = target === "outside" ? f.outside : join(f.job, target === "inside" ? "notes.md" : "missing.md");
    if (target === "inside") writeFileSync(destination, "inside");
    symlinkSync(destination, f.file, "file");
    expect(f.store.file(JOB, "founder", "report.md")).toBeNull();
    expect(createArtifactStore(f.dir).file(JOB, "founder", "report.md")).toBeNull();
    expect(readFileSync(f.outside, "utf8")).toBe("outside marker");
  });

  test("a hard-linked file is refused too", () => {
    const f = fixture(); unlinkSync(f.file); linkSync(f.outside, f.file);
    expect(f.store.file(JOB, "founder", "report.md")).toBeNull();
  });

  test("linked metadata never supplies an owner or a listed result", () => {
    const f = fixture(); const meta = join(f.root, "outside-meta.json"); renameSync(f.meta, meta); symlinkSync(meta, f.meta, "file");
    hidden(f.store); hidden(createArtifactStore(f.dir));
    expect(f.store.save(input())).toMatchObject({ ok: false });
  });

  for (const part of ["job", "root"] as const) test(`a linked ${part} directory is refused before and after restart`, () => {
    const f = fixture(); const path = part === "job" ? f.job : f.dir;
    const moved = join(f.root, "moved"); renameSync(path, moved); directoryLink(moved, path);
    hidden(f.store); const restarted = createArtifactStore(f.dir); hidden(restarted);
    expect(restarted.save(input())).toMatchObject({ ok: false });
    expect(readFileSync(join(moved, ...(part === "job" ? [] : [JOB]), "report.md"), "utf8")).toBe("inside");
  });

  test("an alias above the configured root is allowed but redirecting it after construction is refused", () => {
    const f = fixture(); const real = join(f.root, "real-parent"); mkdirSync(real); renameSync(f.dir, join(real, "artifacts"));
    const alias = join(f.root, "parent-alias"); directoryLink(real, alias);
    const store = createArtifactStore(join(alias, "artifacts"));
    expect(store.file(JOB, "founder", "report.md")?.data.toString()).toBe("inside");
    const second = join(f.root, "second-parent"); mkdirSync(second);
    createArtifactStore(join(second, "artifacts")).save(input({ files: [{ name: "report.md", data: "second" }] }));
    rmSync(alias); directoryLink(second, alias); hidden(store);
  });

  test("missing metadata and corrupt JSON fail closed without exceptions", () => {
    const f = fixture(); unlinkSync(f.meta); hidden(f.store);
    // A crash before metadata was committed can be retried using the existing regular file.
    expect(f.store.save(input())).toMatchObject({ ok: true, created: true });
    writeFileSync(f.meta, "{broken"); hidden(f.store);
    expect(f.store.save(input())).toMatchObject({ ok: false });
    expect(readFileSync(f.file, "utf8")).toBe("inside");
  });

  const malformed: [string, (m: any) => unknown][] = [
    ["null", () => null], ["array", () => []], ["missing fields", () => ({ personId: "founder" })],
    ["mismatched id", (m) => ({ ...m, id: OTHER })], ["invalid kind", (m) => ({ ...m, kind: "invalid" })],
    ["non-string owner", (m) => ({ ...m, personId: {} })], ["non-string title", (m) => ({ ...m, title: {} })],
    ["invalid timestamp", (m) => ({ ...m, createdAt: "nope" })], ["missing main", (m) => ({ ...m, main: "missing.md" })],
    ["non-array files", (m) => ({ ...m, files: {} })], ["empty files", (m) => ({ ...m, files: [] })],
    ["too many files", (m) => ({ ...m, files: Array.from({ length: 25 }, (_, i) => ({ ...m.files[0], name: `file${i}.md` })) })],
    ["duplicate names", (m) => ({ ...m, files: [m.files[0], m.files[0]] })],
    ["case aliases", (m) => ({ ...m, files: [m.files[0], { ...m.files[0], name: "REPORT.MD" }] })],
    ["negative bytes", (m) => ({ ...m, files: [{ ...m.files[0], bytes: -1 }] })],
    ["fractional bytes", (m) => ({ ...m, files: [{ ...m.files[0], bytes: 0.5 }] })],
    ["oversized bytes", (m) => ({ ...m, files: [{ ...m.files[0], bytes: 12 * 1024 * 1024 + 1 }] })],
    ["oversized total", (m) => ({ ...m, files: [{ ...m.files[0], bytes: 7 * 1024 * 1024 }, { ...m.files[0], name: "notes.md", bytes: 7 * 1024 * 1024 }] })],
    ["unsafe MIME", (m) => ({ ...m, files: [{ ...m.files[0], mime: "text/html\r\nX-Test: bad" }] })],
  ];
  for (const [label, change] of malformed) test(`${label} metadata is ignored by get, owner lookup, lists and file reads`, () => {
    const f = fixture(); editMeta(f.meta, change); hidden(f.store);
  });

  for (const name of ["../outside.txt", "sub/report.md", "sub\\report.md", "report.md:stream", "report.md.", "CON", "nul.txt", "COM1.md", "LPT9.txt", "META.JSON", "meta.json.", "report.md\u0000"]) test(`unsafe or Windows-aliased name ${JSON.stringify(name)} is rejected on save and read`, () => {
    const f = fixture();
    expect(f.store.save(input({ jobId: OTHER, main: name, files: [{ name, data: "x" }] }))).toMatchObject({ ok: false });
    editMeta(f.meta, (m) => ({ ...m, main: name, files: [{ ...m.files[0], name }] })); hidden(f.store);
  });

  test("case-colliding save names cannot overwrite each other on Windows", () => {
    const f = fixture(false);
    expect(f.store.save(input({ files: [{ name: "report.md", data: "one" }, { name: "REPORT.MD", data: "two" }] }))).toMatchObject({ ok: false });
  });

  test("metadata reads are bounded independently of the artifact payload limit", () => {
    const f = fixture(); editMeta(f.meta, (m) => ({ ...m, extra: "x".repeat(64 * 1024) })); hidden(f.store);
  });

  test("missing, non-regular, changed-length and oversized files fail closed", () => {
    const f = fixture(); unlinkSync(f.file); expect(f.store.file(JOB, "founder", "report.md")).toBeNull();
    mkdirSync(f.file); expect(f.store.file(JOB, "founder", "report.md")).toBeNull(); rmSync(f.file, { recursive: true });
    writeFileSync(f.file, "short"); expect(f.store.file(JOB, "founder", "report.md")).toBeNull();
    truncateSync(f.file, 12 * 1024 * 1024 + 1); expect(f.store.file(JOB, "founder", "report.md")).toBeNull();
  });

  test("predictable temporary links cannot redirect a save", () => {
    const f = fixture(false); mkdirSync(f.job);
    symlinkSync(f.outside, join(f.job, "report.md.tmp"), "file"); symlinkSync(f.outside, join(f.job, "meta.json.tmp"), "file");
    // The store may safely refuse or use a fresh exclusive temporary name. Neither outside byte may change.
    f.store.save(input()); expect(readFileSync(f.outside, "utf8")).toBe("outside marker");
  });

  test("a linked final file in an interrupted save is refused without changing its target", () => {
    const f = fixture(false); mkdirSync(f.job); symlinkSync(f.outside, f.file, "file");
    expect(f.store.save(input())).toMatchObject({ ok: false });
    expect(readFileSync(f.outside, "utf8")).toBe("outside marker"); hidden(f.store);
  });
});

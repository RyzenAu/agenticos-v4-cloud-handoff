import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { build, denyRule, readTar, verify } from "./release-package";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>, secretMode = false) {
  const root = mkdtempSync(join(tmpdir(), "mu-release-"));
  roots.push(root);
  const run = (...a: string[]) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  run("init", "-q");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  run("add", "-A", "-f");
  if (secretMode) run("update-index", "--chmod=+x", "deploy/bin/rollout.sh");
  run("commit", "-q", "-m", "synthetic release test");
  return { root, sha: run("rev-parse", "HEAD").trim() };
}

const FILES: Record<string, string> = {
  "package.json": '{"name":"synthetic"}',
  "bun.lock": "# lock",
  "src/app.ts": "export const a = 1;\n",
  "src/assets/logo.png": "png-bytes",
  "deploy/bin/rollout.sh": "#!/usr/bin/env bash\nexit 0\n",
  "deploy/bin/install.sh": 'BUN_VERSION="${BUN_VERSION:-1.4.2}"\n',
  "deploy/env/production.env.example": "MU_HUB_ROLE=cloud\n",
  ".env": "SYNTHETIC_ONLY=1\n",
  ".env.local": "SYNTHETIC_ONLY=2\n",
  "config/server.pem": "not a real key",
  "config/credentials.json": "{}",
  "src/data/.operator-data/crm.sqlite": "db",
  "data/mail.sqlite": "db",
  "logs/hub.log": "log",
  "docs/shot.png": "png",
  "docs/programme/screens/a.txt": "x",
  "docs/notes.md": "# notes\n",
  "node_modules/x/index.js": "x",
  "dist/bundle.js": "x",
};

describe("deny rules", () => {
  test("every private or bulky class is left out, app assets and deploy examples are kept", () => {
    for (const p of [".env", ".env.production", "a/.env.local", "x/id_rsa", "k/server.pem", "credentials.json", "secrets.yaml", "a.token", ".operator-data/x", "src/.operator-data/y", "m.sqlite", "m.sqlite-wal", "a.log", "logs/x.txt", "docs/a.png", "docs/x/y.mp4", "docs/r/screens/z.txt", "node_modules/a/b.js", "dist/x.js", ".git/config", ".claude/settings.json", "transcripts/a.txt"])
      expect(denyRule(p), p).not.toBeNull();
    for (const p of ["src/assets/logo.png", "public/onboarding/a.mp4", "deploy/env/production.env.example", "deploy/env/staging.env.example", "docs/notes.md", "scripts/memory/secrets-screen.test.ts", "src/lib/credentials-ui.ts", "package.json", "bun.lock"])
      expect(denyRule(p), p).toBeNull();
  });
});

describe("build and verify", () => {
  test("builds from the commit only, drops the deny list, records everything, and verifies", () => {
    const { root, sha } = repoWith(FILES, true);
    // An uncommitted file and an untracked secret are never in the package (it is the commit, not the working tree).
    writeFileSync(join(root, "UNTRACKED-SECRET.txt"), "never");
    writeFileSync(join(root, "src/app.ts"), "export const a = 2; // uncommitted edit\n");
    const out = join(root, "..", `out-${Date.now()}`);
    roots.push(out);
    const r = build({ repo: root, rev: "HEAD", outDir: out });
    expect(r.sha).toBe(sha);
    const paths = r.manifest.files.map((f) => f.path);
    expect(paths).toEqual(["bun.lock", "deploy/bin/install.sh", "deploy/bin/rollout.sh", "deploy/env/production.env.example", "docs/notes.md", "package.json", "src/app.ts", "src/assets/logo.png"]);
    expect(r.manifest.excluded.byRule).toMatchObject({ "env-file": 2, "key-material": 1, "credential-name": 1, database: 1, "docs-media": 1, "directory:logs": 1, "directory:screens": 1, "directory:node_modules": 1, "directory:dist": 1, "directory:.operator-data": 1 });
    expect(r.manifest.bun.pinnedInInstallScript).toBe("1.4.2");
    expect(r.manifest.lockfile?.name).toBe("bun.lock");
    // The committed content, not the working-tree edit.
    const entries = readTar(gunzipSync(readFileSync(join(out, r.name))));
    expect(JSON.stringify(entries.find((e) => e.path === "src/app.ts")!.data.toString())).toBe(JSON.stringify("export const a = 1;\n"));
    expect(entries.some((e) => e.path.includes("UNTRACKED"))).toBe(false);
    // Execute bit survives (the deploy scripts are run directly on the VM).
    expect(entries.find((e) => e.path === "deploy/bin/rollout.sh")!.mode & 0o111).not.toBe(0);
    expect(entries.map((e) => e.path)).toContain("RELEASE_SHA");
    expect(entries.find((e) => e.path === "RELEASE_SHA")!.data.toString().trim()).toBe(sha);
    // SHA256SUMS is in `sha256sum -c` format and names both files.
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toHaveLength(2);
    expect(sums[0]).toMatch(/^[0-9a-f]{64}  mu-hub-[0-9a-f]{12}\.tar\.gz$/);
    expect(verify({ pkg: join(out, r.name) }).problems).toEqual([]);
  });

  test("the same commit gives the same bytes", () => {
    const { root } = repoWith(FILES);
    const a = build({ repo: root, rev: "HEAD", outDir: join(root, "..", `a-${Date.now()}`) });
    const b = build({ repo: root, rev: "HEAD", outDir: join(root, "..", `b-${Date.now()}`) });
    roots.push(a.out, b.out);
    expect(a.manifest.tarball!.sha256).toBe(b.manifest.tarball!.sha256);
  });

  test("a secret-shaped string in shipped source refuses the build; the same string in a test fixture does not", () => {
    const fake = "-----BEGIN RSA PRIVATE KEY-----\nsynthetic\n";
    const bad = repoWith({ ...FILES, "src/leak.ts": `export const k = ${JSON.stringify(fake)};\n` });
    expect(() => build({ repo: bad.root, rev: "HEAD", outDir: join(bad.root, "..", `bad-${Date.now()}`) })).toThrow(/Secret-shaped content/);
    const ok = repoWith({ ...FILES, "src/leak.test.ts": `export const k = ${JSON.stringify(fake)};\n` });
    const r = build({ repo: ok.root, rev: "HEAD", outDir: join(ok.root, "..", `ok-${Date.now()}`) });
    roots.push(r.out);
    expect(r.manifest.secretScan.fixtureHits).toEqual([{ path: "src/leak.test.ts", rule: "private-key-block" }]);
  });

  test("verify catches a changed file, an added file, a forbidden file and a tampered tarball", () => {
    const { root } = repoWith(FILES);
    const out = join(root, "..", `v-${Date.now()}`);
    roots.push(out);
    const r = build({ repo: root, rev: "HEAD", outDir: out });
    const pkg = join(out, r.name);
    const entries = readTar(gunzipSync(readFileSync(pkg)));

    // Rewrite the package with one file changed and one forbidden file added, keeping the old manifest.
    const { writeTar } = require("./release-package") as typeof import("./release-package");
    const changed = writeTar([
      ...entries.filter((e) => e.path !== "src/app.ts").map((e) => ({ name: e.path, data: e.data, mtime: 0 })),
      { name: "src/app.ts", data: Buffer.from("export const a = 666;\n") },
      { name: ".env", data: Buffer.from("X=1\n") },
    ]);
    const tampered = join(out, "tampered.tar.gz");
    writeFileSync(tampered, gzipSync(changed));
    const v = verify({ pkg: tampered, manifestPath: join(out, r.manifestName) });
    expect(v.ok).toBe(false);
    expect(v.problems.join("|")).toContain("tarball sha256 does not match the manifest");
    expect(v.problems.join("|")).toContain("changed: src/app.ts");
    expect(v.problems.join("|")).toContain("forbidden file shipped (env-file): .env");
    expect(v.problems.join("|")).toContain("not in the manifest: .env");
  });
});

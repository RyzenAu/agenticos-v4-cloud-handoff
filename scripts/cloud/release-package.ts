#!/usr/bin/env bun
/**
 * Release package for the cloud hub (programme 20261001, round 3, Track E): a REVIEWED SOURCE TARBALL built from one git SHA.
 *
 *   bun scripts/cloud/release-package.ts build  [--sha <rev>] [--out <dir>] [--repo <dir>]
 *   bun scripts/cloud/release-package.ts verify --package <mu-hub-<sha12>.tar.gz> [--manifest <file>]
 *
 * What it is: `git archive <sha>` (tracked files of that exact commit: no Git history, nothing untracked, never the working
 * tree) minus a deny list (below), plus a manifest with a sha256 for every file and for the tarball itself, plus a
 * `SHA256SUMS` file that `sha256sum -c` understands. Three files come out; copy all three to the VM:
 *
 *   mu-hub-<sha12>.tar.gz           the source
 *   mu-hub-<sha12>.manifest.json    what is inside, what was left out and why, the secret scan result, the tarball hash
 *   SHA256SUMS                      one line per file above
 *
 * It does NOT install dependencies: the VM runs `bun install --frozen-lockfile` against the `bun.lock` inside, as
 * `deploy/bin/rollout.sh --package` does. It reads no environment value, no `.env*` file and no credential, and prints none.
 *
 * Deny list (a tracked file that matches is left out and counted; the build FAILS if the content scan then finds a
 * secret-shaped string in what is left, other than inside test fixtures):
 *   directories  .git .operator-data node_modules dist .vite .wrangler coverage logs screens screenshots recordings
 *                audio transcripts .claude .playwright-mcp
 *   names        .env and .env.*  *.pem *.key *.p12 *.pfx *.ppk id_rsa* id_ed25519* credentials / secrets (exact names) *.token
 *                *.sqlite *.sqlite-wal *.sqlite-shm *.db *.log
 *   media        images, audio and video under docs/ (screenshots, renders, recordings); app assets under src/ and public/ stay
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DENY_DIRS = [".git", ".operator-data", "node_modules", "dist", ".vite", ".wrangler", "coverage", "logs", "screens", "screenshots", "recordings", "audio", "transcripts", ".claude", ".playwright-mcp"];
const DENY_NAME_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: "env-file", re: /^\.env(\..*)?$/i },
  { rule: "key-material", re: /\.(pem|key|p12|pfx|ppk)$|^id_(rsa|ed25519|ecdsa|dsa)/i },
  { rule: "credential-name", re: /^(credentials?|secrets?)(\.(json|ya?ml|txt|toml|ini|cfg|conf|env))?$|\.token$/i },
  { rule: "database", re: /\.(sqlite|sqlite-wal|sqlite-shm|db)$/i },
  { rule: "log", re: /\.log$/i },
];
const DOC_MEDIA = /\.(png|jpe?g|gif|webp|bmp|ico|mp3|wav|m4a|ogg|flac|mp4|webm|mov|mkv)$/i;

/** Why a tracked path is left out of the package, or null when it ships. Pure. */
export function denyRule(path: string): string | null {
  const parts = path.split("/");
  const file = parts[parts.length - 1]!;
  for (const dir of parts.slice(0, -1)) if (DENY_DIRS.includes(dir)) return `directory:${dir}`;
  for (const p of DENY_NAME_PATTERNS) if (p.re.test(file)) return p.rule;
  if (parts[0] === "docs" && DOC_MEDIA.test(file)) return "docs-media";
  return null;
}

/** High-confidence secret shapes. A hit in shipped, non-test content fails the build. */
export const SECRET_RULES: { rule: string; re: RegExp }[] = [
  { rule: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "openai-style-key", re: /\bsk-(?:proj-|live-)?[A-Za-z0-9]{32,}\b/ },
  { rule: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "tailscale-auth-key", re: /\btskey-(?:auth|api|client)-[A-Za-z0-9]{10,}/ },
  { rule: "stripe-live-key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  { rule: "twilio-api-key", re: /\bSK[0-9a-f]{32}\b/ },
];
const TEST_PATH = /(^|\/)(testing|fixtures?|__tests__)\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|-test\.[jt]s$/;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|yml|yaml|toml|sh|ps1|service|timer|example|html|css|cfg|conf|ini|py|rs|lock)$/i;

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const git = (repo: string, ...args: string[]): Buffer => {
  const r = spawnSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${Buffer.from(r.stderr ?? "").toString("utf8").trim().slice(0, 200)}`);
  return r.stdout;
};
const text = (b: Buffer) => b.toString("utf8").trim();

// A small ustar/pax reader and writer. The package is filtered as a stream, so file modes (the deploy scripts' execute bit)
// and git's fixed commit-time mtimes come through untouched, and no external tar (GNU or bsdtar) is needed on any host.
type TarEntry = { path: string; type: string; mode: number; size: number; header: Buffer; extended: Buffer | null; data: Buffer };
const BLOCK = 512;
const cstr = (b: Buffer, from: number, len: number) => {
  const slice = b.subarray(from, from + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? len : end).toString("utf8");
};
const octal = (b: Buffer, from: number, len: number) => parseInt(cstr(b, from, len).trim() || "0", 8);

function paxPath(data: Buffer): string | null {
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const len = parseInt(data.subarray(off, sp).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, off + len - 1).toString("utf8");
    if (rec.startsWith("path=")) return rec.slice(5);
    off += len;
  }
  return null;
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let pending: Buffer | null = null;
  let pendingPath: string | null = null;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((x) => x === 0)) break;
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "g") continue; // git's global header (the commit id comment): replaced by RELEASE_SHA
    if (type === "x") {
      pending = Buffer.concat([header, data, Buffer.alloc(Math.ceil(size / BLOCK) * BLOCK - size)]);
      pendingPath = paxPath(data);
      continue;
    }
    const prefix = cstr(header, 345, 155);
    const name = pendingPath ?? (prefix ? `${prefix}/${cstr(header, 0, 100)}` : cstr(header, 0, 100));
    out.push({ path: name.replace(/\/$/, ""), type, mode: octal(header, 100, 8), size, header: Buffer.from(header), extended: pending, data: Buffer.from(data) });
    pending = null;
    pendingPath = null;
  }
  return out;
}

function ustarHeader(name: string, size: number, mtime: number, mode = 0o644): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`name too long for the plain header: ${name}`);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(mtime.toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const padTo = (n: number) => Buffer.alloc(Math.ceil(n / BLOCK) * BLOCK - n);
export function writeTar(entries: { raw?: Buffer; name?: string; data?: Buffer; mtime?: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.raw) parts.push(e.raw);
    else parts.push(ustarHeader(e.name!, e.data!.length, e.mtime ?? 0), e.data!, padTo(e.data!.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
const rawOf = (e: TarEntry) => Buffer.concat([...(e.extended ? [e.extended] : []), e.header, e.data, padTo(e.size)]);

export type Manifest = {
  schema: 1;
  kind: "mu-hub-release";
  sha: string;
  shortSha: string;
  commitTime: string;
  subject: string;
  builtAt: string;
  bun: { pinnedInInstallScript: string | null };
  lockfile: { name: string; sha256: string } | null;
  totals: { files: number; bytes: number };
  excluded: { count: number; byRule: Record<string, number> };
  secretScan: { scanned: number; hits: { path: string; rule: string }[]; fixtureHits: { path: string; rule: string }[] };
  files: { path: string; bytes: number; sha256: string }[];
  tarball?: { name: string; bytes: number; sha256: string };
};

export function build(opts: { repo: string; rev: string; outDir: string }) {
  const repo = resolve(opts.repo);
  const sha = text(git(repo, "rev-parse", "--verify", `${opts.rev}^{commit}`));
  const short = sha.slice(0, 12);
  const commitTime = text(git(repo, "show", "-s", "--format=%cI", sha));
  const subject = text(git(repo, "show", "-s", "--format=%s", sha));
  const mtime = Math.floor(new Date(commitTime).getTime() / 1000);

  // 1. The commit's tracked files, exactly. `git archive` never includes .git, untracked files or the working tree.
  // core.autocrlf=false: a Windows host must not turn the deploy scripts into CRLF (bash on the VM fails on a carriage return).
  const entries = readTar(git(repo, "-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", sha));

  // 2. Deny list.
  const byRule: Record<string, number> = {};
  let excludedCount = 0;
  const kept: TarEntry[] = [];
  for (const e of entries) {
    if (e.type === "5") continue; // directories are implied by their files
    if (e.type !== "0") throw new Error(`Unsupported entry type "${e.type}" for ${e.path}: links are not shipped.`);
    const rule = denyRule(e.path);
    if (rule) {
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      excludedCount++;
    } else kept.push(e);
  }
  kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 3. Hash, scan.
  const files: Manifest["files"] = [];
  const hits: { path: string; rule: string }[] = [];
  const fixtureHits: { path: string; rule: string }[] = [];
  let scanned = 0;
  let bytes = 0;
  for (const e of kept) {
    files.push({ path: e.path, bytes: e.size, sha256: sha256(e.data) });
    bytes += e.size;
    if (TEXT_EXT.test(e.path) && e.size < 4 << 20) {
      scanned++;
      const body = e.data.toString("utf8");
      for (const r of SECRET_RULES) if (r.re.test(body)) (TEST_PATH.test(e.path) ? fixtureHits : hits).push({ path: e.path, rule: r.rule });
    }
  }
  if (hits.length) throw new Error(`Secret-shaped content in shipped files, build refused: ${hits.map((h) => `${h.path} (${h.rule})`).join(", ")}`);

  const lock = files.find((f) => f.path === "bun.lock") ?? null;
  const installEntry = kept.find((e) => e.path === "deploy/bin/install.sh");
  const manifest: Manifest = {
    schema: 1,
    kind: "mu-hub-release",
    sha,
    shortSha: short,
    commitTime,
    subject,
    builtAt: new Date().toISOString(),
    bun: { pinnedInInstallScript: /BUN_VERSION="\$\{BUN_VERSION:-([0-9.]+)\}"/.exec(installEntry?.data.toString("utf8") ?? "")?.[1] ?? null },
    lockfile: lock ? { name: "bun.lock", sha256: lock.sha256 } : null,
    totals: { files: files.length, bytes },
    excluded: { count: excludedCount, byRule },
    secretScan: { scanned, hits, fixtureHits },
    files,
  };

  // 4. The package: kept files untouched (modes and times from git), then the SHA the rollout reads and the manifest
  //    without the tarball's own hash. Same commit gives the same bytes (fixed order, commit-time mtimes, no gzip clock).
  const tar = writeTar([
    ...kept.map((e) => ({ raw: rawOf(e) })),
    { name: "RELEASE_SHA", data: Buffer.from(sha + "\n"), mtime },
    { name: "RELEASE-MANIFEST.json", data: Buffer.from(JSON.stringify({ ...manifest, builtAt: commitTime }, null, 2) + "\n"), mtime },
  ]);
  const gz = gzipSync(tar, { level: 9 });
  gz.writeUInt32LE(0, 4);
  gz[9] = 3;
  const out = resolve(opts.outDir);
  mkdirSync(out, { recursive: true });
  const name = `mu-hub-${short}.tar.gz`;
  writeFileSync(join(out, name), gz);
  manifest.tarball = { name, bytes: gz.length, sha256: sha256(gz) };
  const manifestName = `mu-hub-${short}.manifest.json`;
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(out, manifestName), manifestText);
  writeFileSync(join(out, "SHA256SUMS"), `${manifest.tarball.sha256}  ${name}\n${sha256(manifestText)}  ${manifestName}\n`);
  return { sha, short, name, manifestName, out, manifest };
}

export function verify(opts: { pkg: string; manifestPath?: string }) {
  const pkg = resolve(opts.pkg);
  const manifestPath = resolve(opts.manifestPath ?? pkg.replace(/\.tar\.gz$/, ".manifest.json"));
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const bytes = readFileSync(pkg);
  if (!manifest.tarball) problems.push("manifest has no tarball record");
  else {
    if (manifest.tarball.sha256 !== sha256(bytes)) problems.push("tarball sha256 does not match the manifest");
    if (manifest.tarball.bytes !== bytes.length) problems.push("tarball size does not match the manifest");
  }
  const sums = join(dirname(pkg), "SHA256SUMS");
  if (existsSync(sums)) {
    const line = readFileSync(sums, "utf8").split(/\r?\n/).find((l) => l.endsWith(`  ${basename(pkg)}`));
    if (!line || line.split(/\s+/)[0] !== sha256(bytes)) problems.push("SHA256SUMS does not list this tarball's hash");
  } else problems.push("SHA256SUMS is missing next to the tarball");
  if (manifest.secretScan.hits.length) problems.push("manifest records secret-scan hits");

  let entries: TarEntry[] = [];
  try {
    entries = readTar(gunzipSync(bytes));
  } catch (e) {
    problems.push(`cannot read the tarball: ${(e as Error).message.slice(0, 120)}`);
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const f of manifest.files) {
    const e = byPath.get(f.path);
    if (!e) problems.push(`missing: ${f.path}`);
    else if (sha256(e.data) !== f.sha256) problems.push(`changed: ${f.path}`);
  }
  for (const e of entries) {
    if (e.path === "RELEASE_SHA" || e.path === "RELEASE-MANIFEST.json") continue;
    if (!listed.has(e.path)) problems.push(`not in the manifest: ${e.path}`);
    const rule = denyRule(e.path);
    if (rule) problems.push(`forbidden file shipped (${rule}): ${e.path}`);
  }
  const rel = byPath.get("RELEASE_SHA");
  if (!rel || rel.data.toString("utf8").trim() !== manifest.sha) problems.push("RELEASE_SHA is missing or disagrees with the manifest");
  if (!byPath.has("bun.lock")) problems.push("no bun.lock: a frozen install is impossible");
  return { ok: problems.length === 0, problems, manifest, entries };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    if (cmd === "build") {
      const r = build({ repo: flag("--repo") ?? repoDefault, rev: flag("--sha") ?? "HEAD", outDir: flag("--out") ?? "release" });
      const m = r.manifest;
      console.log(`Built ${r.name}: commit ${r.sha}`);
      console.log(`  files ${m.totals.files} (${(m.totals.bytes / 1048576).toFixed(1)} MiB), left out ${m.excluded.count} (${Object.entries(m.excluded.byRule).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
      console.log(`  secret scan: ${m.secretScan.scanned} text files, ${m.secretScan.hits.length} hits, ${m.secretScan.fixtureHits.length} in test fixtures (not shipped as live values)`);
      console.log(`  tarball ${m.tarball!.bytes} bytes sha256 ${m.tarball!.sha256}`);
      console.log(`  ${join(r.out, r.name)}\n  ${join(r.out, r.manifestName)}\n  ${join(r.out, "SHA256SUMS")}`);
      const v = verify({ pkg: join(r.out, r.name) });
      console.log(v.ok ? "Verified: tarball, every file and the deny list agree with the manifest." : `VERIFY FAILED: ${v.problems.join("; ")}`);
      process.exit(v.ok ? 0 : 1);
    } else if (cmd === "verify") {
      const pkg = flag("--package");
      if (!pkg) throw new Error("Give --package <mu-hub-<sha12>.tar.gz>");
      const v = verify({ pkg, manifestPath: flag("--manifest") });
      console.log(v.ok ? `OK ${v.manifest.sha}: ${v.manifest.totals.files} files match the manifest.` : `FAILED:\n  ${v.problems.join("\n  ")}`);
      process.exit(v.ok ? 0 : 1);
    } else {
      console.error("usage: release-package.ts build [--sha REV] [--out DIR] [--repo DIR] | verify --package FILE [--manifest FILE]");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

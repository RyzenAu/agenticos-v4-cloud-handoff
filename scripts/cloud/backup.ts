// Consistent online backup and isolated restore of the hub's data directory (cloud programme, Agent A).
//
//   backup   Every SQLite store is copied with `VACUUM INTO` (a transactionally consistent snapshot taken
//            while the hub keeps running; the -wal and -shm files are never copied by hand). Every other
//            file under the data directory (JSON, JSONL, tokens, uploads) is copied byte for byte. The
//            result is a timestamped folder with `manifest.json`: per file its size, sha256 and, for
//            SQLite, the row count of every table.
//   restore  Only into an EMPTY, ISOLATED directory. It verifies each checksum before writing, copies,
//            re-verifies, opens every store read-only and compares row counts with the manifest. It never
//            writes into a live data directory: a non-empty target is refused.
//
// A backup holds the hub's credentials (OAuth tokens, pairing secrets), so the folder is created 0700 and
// must be kept off the VM's public surface and encrypted at rest wherever it is copied (deploy/README.md).
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const MANIFEST_VERSION = 1;

/** Top-level folders that are caches, browser profiles, virtualenvs or scratch space: rebuilt, never restored. */
export const DEFAULT_EXCLUDE_DIRS = ["backups", "cache", "tmp", "jarvis-app-browser", "dsh-venv", "dsh", "agent-tasks", "lead-thumbs", "node_modules"];

export type FileEntry = {
  path: string; // POSIX-style, relative to the data directory
  kind: "sqlite" | "file";
  bytes: number;
  sha256: string;
  tables?: Record<string, number | null>;
};

export type Manifest = {
  manifestVersion: number;
  createdAt: string;
  sourceDataDir: string;
  gitSha: string | null;
  hubRole: string | null;
  containsCredentials: true;
  excludedDirs: string[];
  files: FileEntry[];
  totals: { files: number; sqliteStores: number; bytes: number };
};

export type BackupOptions = {
  dataDir: string;
  outRoot: string;
  now?: () => Date;
  excludeDirs?: string[];
  gitSha?: string | null;
  hubRole?: string | null;
};

const SQLITE_RE = /\.(sqlite|sqlite3|db)$/i;
const SIDECAR_RE = /\.(sqlite|sqlite3|db)-(wal|shm|journal)$/i;

export function sha256File(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

const posix = (p: string) => p.split(sep).join("/");

/** Timestamp folder name, e.g. backup-20261001T031500Z (sortable, no colons for Windows). */
export function backupFolderName(d: Date): string {
  return `backup-${d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

function listFiles(dir: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (base: string, top: boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(base, e.name);
      if (e.isSymbolicLink()) continue; // never follow a link (or a Windows junction) out of the data directory
      if (e.isDirectory()) {
        if (top && exclude.has(e.name)) continue;
        walk(full, false);
      } else if (e.isFile()) {
        if (SIDECAR_RE.test(e.name) || /\.tmp$/i.test(e.name) || e.name.startsWith(".health-probe-")) continue;
        out.push(full);
      }
    }
  };
  walk(dir, true);
  return out.sort();
}

/** Row count of every table (null where a virtual table cannot be counted here). */
export function tableCounts(path: string): Record<string, number | null> {
  const db = new Database(path, { readonly: true });
  try {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const counts: Record<string, number | null> = {};
    for (const n of names) {
      try {
        counts[n] = (db.query(`SELECT count(*) AS n FROM "${n.replace(/"/g, '""')}"`).get() as { n: number }).n;
      } catch {
        counts[n] = null;
      }
    }
    return counts;
  } finally {
    db.close();
  }
}

/** Snapshot one SQLite store into `dest` with VACUUM INTO (consistent while writers continue). */
function snapshotSqlite(src: string, dest: string) {
  const db = new Database(src, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 15000");
    db.run("VACUUM INTO ?", [dest]);
  } finally {
    db.close();
  }
}

export function backupDataDir(opts: BackupOptions): { dir: string; manifest: Manifest } {
  const dataDir = resolve(opts.dataDir);
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) throw new Error(`Data directory not found: ${dataDir}`);
  const outRoot = resolve(opts.outRoot);
  if (outRoot === dataDir || outRoot.startsWith(dataDir + sep)) throw new Error("Refusing to write a backup inside the data directory it is backing up.");
  const dir = join(outRoot, backupFolderName((opts.now ?? (() => new Date()))()));
  if (existsSync(dir)) throw new Error(`Backup folder already exists: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const exclude = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const files: FileEntry[] = [];
  try {
    for (const src of listFiles(dataDir, new Set(exclude))) {
      const rel = posix(relative(dataDir, src));
      const dest = join(dir, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (SQLITE_RE.test(src)) {
        snapshotSqlite(src, dest);
        files.push({ path: rel, kind: "sqlite", bytes: statSync(dest).size, sha256: sha256File(dest), tables: tableCounts(dest) });
      } else {
        copyFileSync(src, dest);
        files.push({ path: rel, kind: "file", bytes: statSync(dest).size, sha256: sha256File(dest) });
      }
    }
  } catch (e) {
    // A half-written backup must never look like a good one.
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    sourceDataDir: dataDir,
    gitSha: opts.gitSha ?? null,
    hubRole: opts.hubRole ?? null,
    containsCredentials: true,
    excludedDirs: exclude,
    files,
    totals: { files: files.length, sqliteStores: files.filter((f) => f.kind === "sqlite").length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
  };
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { dir, manifest };
}

export function readManifest(backupDir: string): Manifest {
  const path = join(resolve(backupDir), MANIFEST_NAME);
  if (!existsSync(path)) throw new Error(`Not a backup folder (no ${MANIFEST_NAME}): ${backupDir}`);
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (m.manifestVersion !== MANIFEST_VERSION || !Array.isArray(m.files)) throw new Error("Unsupported or damaged manifest.");
  return m;
}

export type VerifyResult = { ok: boolean; checked: number; problems: string[] };

/** Recompute every checksum in a backup folder (or a restored directory) against the manifest. */
export function verifyAgainstManifest(manifest: Manifest, dir: string): VerifyResult {
  const problems: string[] = [];
  for (const f of manifest.files) {
    if (f.path.split("/").some((p) => p === ".." || p === "")) {
      problems.push(`${f.path}: unsafe path in manifest`);
      continue;
    }
    const p = join(dir, ...f.path.split("/"));
    if (!existsSync(p)) {
      problems.push(`${f.path}: missing`);
      continue;
    }
    if (statSync(p).size !== f.bytes) problems.push(`${f.path}: size differs`);
    else if (sha256File(p) !== f.sha256) problems.push(`${f.path}: checksum differs`);
  }
  return { ok: problems.length === 0, checked: manifest.files.length, problems };
}

export type RestoreResult = {
  targetDir: string;
  files: number;
  stores: Array<{ path: string; tables: number; rows: number; matches: boolean }>;
  verified: VerifyResult;
};

/** Restore into an empty directory, then prove it: checksums, stores open, row counts equal the manifest. */
export function restoreBackup(opts: { backupDir: string; targetDir: string }): RestoreResult {
  const backupDir = resolve(opts.backupDir);
  const target = resolve(opts.targetDir);
  const manifest = readManifest(backupDir);
  if (target === backupDir || target.startsWith(backupDir + sep) || backupDir.startsWith(target + sep)) throw new Error("The restore target and the backup must be separate folders.");
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !statSync(target).isDirectory()) throw new Error(`Restore target is not a plain directory: ${target}`);
    if (readdirSync(target).length > 0) throw new Error(`Restore target is not empty: ${target}. Restore only into a fresh, isolated directory, then switch the service to it.`);
  }
  const before = verifyAgainstManifest(manifest, backupDir);
  if (!before.ok) throw new Error(`Backup failed verification, nothing was restored: ${before.problems.join("; ")}`);

  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const f of manifest.files) {
    const dest = join(target, ...f.path.split("/"));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(join(backupDir, ...f.path.split("/")), dest);
  }
  const verified = verifyAgainstManifest(manifest, target);
  const stores: RestoreResult["stores"] = [];
  for (const f of manifest.files.filter((x) => x.kind === "sqlite")) {
    const counts = tableCounts(join(target, ...f.path.split("/")));
    const want = f.tables ?? {};
    const names = new Set([...Object.keys(want), ...Object.keys(counts)]);
    const matches = [...names].every((n) => (want[n] ?? null) === (counts[n] ?? null));
    stores.push({ path: f.path, tables: Object.keys(counts).length, rows: Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0), matches });
  }
  writeFileSync(join(target, ".restore-receipt.json"), JSON.stringify({ restoredAt: new Date().toISOString(), from: backupDir, manifestCreatedAt: manifest.createdAt }, null, 2), { mode: 0o600 });
  return { targetDir: target, files: manifest.files.length, stores, verified };
}

/** Keep the newest `keep` backup folders under `outRoot`; only folders named backup-* that hold a manifest are ever removed. */
export function pruneBackups(outRoot: string, keep: number): string[] {
  const root = resolve(outRoot);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root)
    .filter((n) => /^backup-\d{8}T\d{6}Z$/.test(n))
    .filter((n) => {
      const p = join(root, n);
      const st = lstatSync(p);
      return st.isDirectory() && !st.isSymbolicLink() && existsSync(join(p, MANIFEST_NAME));
    })
    .sort();
  const doomed = dirs.slice(0, Math.max(0, dirs.length - Math.max(1, keep)));
  for (const n of doomed) rmSync(join(root, n), { recursive: true, force: true });
  return doomed;
}

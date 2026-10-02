#!/usr/bin/env bun
// Restore rehearsal on THIS machine, against a disposable cloud-role hub (never 8081, never the real data):
//   start hub A on scratch data -> seed a job + a pairing code -> backup -> stop -> COPY the data, WIPE the copy ->
//   restore the backup into the wiped copy -> start hub B on the restored copy -> /__health + the seeded job + the pairing code survive.
// Also shows a tampered backup being refused. Prints commands and results only: no cookie, code, token or env value.
//
//   bun scripts/cloud/restore-rehearsal.ts [--port 8114] [--scratch D:\prog-scratch\cloud-r4-8114]
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d);
const PORT = Number(opt("port", "8114"));
const R = resolve(opt("scratch", "D:\\prog-scratch\\cloud-r4-8114"));
if (PORT === 8081) throw new Error("Refusing 8081 (the live OS).");
const REPO = resolve(import.meta.dir, "..", "..");
const HUB = `http://127.0.0.1:${PORT}`;
const bun = process.execPath;
const DATA = join(R, "data");
const COPY = join(R, "data-copy");
const BACKUPS = join(R, "backups");
const COOKIE = join(R, "owner.cookie");
const LOG = join(R, "transcript.txt");

// Guard: this script empties <scratch>/data, data-copy, backups and home. Only run in a place that is clearly throwaway:
// under the OS temp dir, or a folder this script created itself (it leaves a marker file), never an arbitrary existing folder.
const MARKER = join(R, ".mu-rehearsal-scratch");
const underTmp = (R + sep).toLowerCase().startsWith((resolve(tmpdir()) + sep).toLowerCase());
if (existsSync(R) && !underTmp && !existsSync(MARKER) && readdirSync(R).length > 0) {
  throw new Error(`Refusing --scratch ${R}: it exists, is not under the OS temp dir and was not created by this script (no marker). Use a new or empty folder.`);
}
mkdirSync(R, { recursive: true });
if (!existsSync(MARKER)) writeFileSync(MARKER, "created by scripts/cloud/restore-rehearsal.ts; safe to empty");
writeFileSync(LOG, "");
const say = (s: string) => {
  console.log(s);
  appendFileSync(LOG, s + "\n");
};
const run = (label: string, args: string[]) => {
  say(`\n$ bun ${args.map((a) => (a.startsWith(R) ? a.replace(R, "<scratch>") : a)).join(" ")}   # ${label}`);
  const r = spawnSync(bun, args, { cwd: REPO, encoding: "utf8" });
  const text = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  say(text.split("\n").map((l) => "  " + l.replaceAll(R, "<scratch>")).join("\n"));
  say(`  (exit ${r.status})`);
  return { code: r.status ?? 1, text };
};
let hubPid = 0;
async function startHub(dataDir: string, tag: string) {
  const env = { ...process.env, MU_HUB_ROLE: "cloud", MU_DATA_DIR: dataDir, HOME: join(R, "home"), USERPROFILE: join(R, "home"), HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off" };
  mkdirSync(join(R, "home"), { recursive: true });
  const child = spawn(bun, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: REPO, env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  hubPid = child.pid ?? 0;
  say(`\n# hub ${tag}: cloud role, MU_DATA_DIR=${dataDir.replace(R, "<scratch>")}, port ${PORT}, pid ${hubPid}`);
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${HUB}/__health`, { signal: AbortSignal.timeout(4000) });
      if (r.status === 200 || r.status === 503) {
        const j = (await r.json()) as any;
        say(`  /__health -> HTTP ${r.status} status=${j.status} hubRole=${j.hubRole} gitSha=${j.gitSha} stores=${j.components?.stores?.detail ?? ""}`);
        return j;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("hub did not answer /__health in 180 s");
}
function stopHub() {
  if (!hubPid) return;
  spawnSync("taskkill", ["/PID", String(hubPid), "/T", "/F"], { encoding: "utf8" });
  say(`# hub stopped (pid ${hubPid}, whole tree)`);
  hubPid = 0;
}
const files = (d: string) => (existsSync(d) ? readdirSync(d) : []);

let failed = 0;
const must = (name: string, ok: boolean) => {
  say(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed++;
};

try {
  for (const d of [DATA, COPY, BACKUPS, join(R, "home")]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  rmSync(COOKIE, { force: true });
  mkdirSync(DATA, { recursive: true });

  const a = await startHub(DATA, "A (original)");
  must("hub A is healthy before anything is seeded", a.status === "ok" || a.status === "degraded");
  const seed = run("seed a job record and a pairing code in hub A", ["scripts/cloud/role-proof.ts", "seed", "--hub", HUB, "--cookie-file", COOKIE, "--out", join(R, "seed.json")]);
  must("seed passed", seed.code === 0);

  const bk = run("online backup of hub A's data (hub still running)", ["scripts/cloud/backup-cli.ts", "backup", "--data-dir", DATA, "--out", BACKUPS]);
  must("backup written", bk.code === 0);
  const folder = join(BACKUPS, files(BACKUPS).filter((x) => x.startsWith("backup-")).sort().pop() ?? "none");
  run("verify the backup against its manifest", ["scripts/cloud/backup-cli.ts", "verify", "--from", folder]);
  stopHub();

  // Tamper rehearsal on a copy of the backup: one byte flipped in a stored file must be refused before anything is written.
  const tampered = join(R, "backup-tampered");
  cpSync(folder, tampered, { recursive: true });
  const victim = readdirSync(tampered).find((f) => f.endsWith(".sqlite"));
  if (victim) {
    const buf = readFileSync(join(tampered, victim));
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    writeFileSync(join(tampered, victim), buf);
    const t = run("verify a TAMPERED copy of the backup (one byte flipped)", ["scripts/cloud/backup-cli.ts", "verify", "--from", tampered]);
    must("a tampered backup is refused", t.code !== 0);
  }

  say("\n# disaster: take a COPY of the data and wipe it (the original data folder is not touched)");
  cpSync(DATA, COPY, { recursive: true });
  for (const f of readdirSync(COPY)) rmSync(join(COPY, f), { recursive: true, force: true });
  must("the copy is now empty", files(COPY).length === 0);
  const rs = run("restore the backup into the wiped copy", ["scripts/cloud/backup-cli.ts", "restore", "--from", folder, "--to", COPY]);
  must("restore verified checksums and row counts", rs.code === 0 && /checksums verified/.test(rs.text));

  const b = await startHub(COPY, "B (restored copy)");
  must("hub B on the restored data is healthy", b.status === "ok" || b.status === "degraded");
  const after = run("seeded job and pairing code survive on the restored data (same cookie file: the session survives too)", ["scripts/cloud/role-proof.ts", "after", "--hub", HUB, "--cookie-file", COOKIE, "--out", join(R, "after.json")]);
  must("after-restore proof passed", after.code === 0);
} catch (e) {
  say(`ABORTED: ${(e as Error).message}`);
  failed++;
} finally {
  stopHub();
}
say(`\nrehearsal ${failed ? "FAILED" : "PASSED"} (${failed} failure${failed === 1 ? "" : "s"})`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env bun
/**
 * R7 journey L: backup, verify and an isolated restore, rehearsed on THIS PC with SYNTHETIC data and checked THROUGH THE APP.
 * Written 3 Oct 2026 by worker G.
 *
 *   1. seed a synthetic data folder (scripts/acceptance/seed-gate-hub.ts: CRM leads, jobs, saved results, a Jarvis conversation)
 *   2. start hub A on it (default PC role, quiet, loopback, port 8127; the server role admits only a console-proven owner or a Tailscale founder, so it cannot be driven from a loopback browser) and read the records back through the app (API and pages)
 *   3. `bun scripts/cloud/backup-cli.ts backup`  (while hub A keeps running: an online, transactionally consistent copy)
 *   4. `... verify`, then a tampered copy must FAIL verify and a non-empty target must be refused by restore
 *   5. stop hub A; `... restore --to <empty isolated folder>`
 *   6. start hub B on the RESTORED copy (port 8137) and read the same records back through the app; they must match hub A exactly
 *
 * Never touches Ryzen, 8081, production data or any real .operator-data. Every folder is under D:\AgenticOS-r7-data. No env value is
 * printed or recorded; the hubs get a minimal environment and a scratch HOME.
 *
 *   bun --no-env-file scripts/cloud/r7-journey-l.ts [--port-a 8127] [--port-b 8137] [--out docs/programme-20261001/evidence/r7-ops]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openBrowser } from "./ops-browser";
import { seedCold } from "../acceptance/seed-gate-hub";
import { ApprovalService } from "../approvals/service";

const ROOT = resolve(import.meta.dir, "..", "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT_A = Number(arg("port-a", "8127"));
const PORT_B = Number(arg("port-b", "8137"));
const OUT = resolve(arg("out", join(ROOT, "docs", "programme-20261001", "evidence", "r7-ops")));
const SCRATCH_ROOT = resolve("D:/AgenticOS-r7-data/g/restore");
const FORBIDDEN = [8081, 8082, 8083, 8093, 8140, 8443, 8444, 8878, 8883, 8888, 8893];
for (const p of [PORT_A, PORT_B]) if (FORBIDDEN.includes(p)) throw new Error(`Refusing port ${p}: a live or shared service.`);
const RUN = randomBytes(3).toString("hex");
const WORK = join(SCRATCH_ROOT, `run-${RUN}`);
const SRC = join(WORK, "src-data");
const BACKUPS = join(WORK, "backups");
const RESTORED = join(WORK, "restored-data");
const HOME = join(WORK, "home");
const LOGS = join(WORK, "logs");
const under = (p: string) => resolve(p).toLowerCase().startsWith(resolve("D:/AgenticOS-r7-data").toLowerCase() + "\\");
if (![SRC, BACKUPS, RESTORED, HOME].every(under)) throw new Error("Safety: every folder must be under D:\\AgenticOS-r7-data.");
for (const d of [WORK, BACKUPS, HOME, LOGS, OUT]) mkdirSync(d, { recursive: true });

type Check = { step: string; check: string; ok: boolean; observed: unknown };
const results: Check[] = [];
const commands: string[] = [];
const check = (step: string, name: string, ok: boolean, observed: unknown) => {
  results.push({ step, check: name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}${ok ? "" : `\n      observed: ${JSON.stringify(observed).slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tidy = (s: string) => s.split(WORK).join("<run>").trim();
function cli(label: string, args: string[], env: Record<string, string> = {}) {
  const shown = `bun ${args.map((a) => (a.startsWith(WORK) ? a.replace(WORK, "<run>") : a)).join(" ")}`;
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", env: { ...minimalEnv(), ...env } });
  const text = tidy(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  commands.push(`$ ${shown}   # ${label}\n${text.split("\n").map((l) => "  " + l).join("\n")}\n  (exit ${r.status})`);
  console.log(`\n$ ${shown}\n${text}\n(exit ${r.status})`);
  return { code: r.status ?? 1, text };
}

const MINIMAL_ENV = ["PATH", "SystemRoot", "windir", "TEMP", "TMP", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "ProgramW6432", "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE"];
function minimalEnv() {
  const env: Record<string, string> = {};
  for (const k of MINIMAL_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
}
const hubs: ChildProcess[] = [];
async function startHub(dataDir: string, port: number, tag: string) {
  const fd = openSync(join(LOGS, `hub-${tag}.log`), "a");
  const child = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...minimalEnv(),
      HOME,
      USERPROFILE: HOME,
      MU_DATA_DIR: dataDir,
      AGENTIC_OS_NO_BACKGROUND: "1",
      AGENTIC_OS_VITE_CACHE_DIR: join(WORK, `vite-cache-${tag}`),
      HINDSIGHT_URL: "off",
      MU_MEMORY_WRITES: "off",
      MU_TRIGGERS: "off",
      MU_PREVIEW_PORT: String(port + 10),
      BROWSER: "none",
    },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  hubs.push(child);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const r = await fetch(`http://127.0.0.1:${port}/__health`).catch(() => null);
    if (r) return { child, health: (await r.json().catch(() => ({}))) as any };
    await sleep(1500);
  }
  throw new Error(`Hub ${tag} did not come up (see logs/hub-${tag}.log).`);
}
const stop = (c: ChildProcess | undefined) => {
  if (c?.pid) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
};

/** Everything a person would look for after a restore, read back through the running app. Hashes, never raw text where it could be private. */
async function snapshot(browser: Awaited<ReturnType<typeof openBrowser>>) {
  // Read through the browser (its confirmed owner session), exactly as the pages do.
  const get = async (path: string) => {
    const r = await browser.evaluate<{ status: number; text: string }>(`fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, text: await r.text() }))`);
    let json: any = null;
    try { json = JSON.parse(r.text); } catch { /* not json */ }
    return { status: r.status, json, text: r.text };
  };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const leads = await get("/__operator/leads/list?limit=500");
  const summary = await get("/__operator/leads/summary");
  const jobsRes = await get("/__jobs?limit=200");
  const jobs: any[] = jobsRes.json?.jobs ?? jobsRes.json?.items ?? [];
  const convs = await get("/__operator/conversations");
  const conversations: any[] = convs.json?.conversations ?? [];
  const leadRows: any[] = leads.json?.leads ?? leads.json?.items ?? leads.json?.rows ?? [];
  const artifacts: Record<string, { status: number; sha: string; bytes: number }> = {};
  for (const j of jobs) {
    const a = await get(`/__computers/artifacts/${j.id}`);
    if (a.status === 200) artifacts[j.id] = { status: a.status, sha: sha(a.text), bytes: a.text.length };
  }
  const threads: Record<string, { entries: number; sha: string }> = {};
  for (const c of conversations) {
    const entries: any[] = c.entries ?? [];
    threads[c.id] = { entries: entries.length, sha: sha(JSON.stringify(entries.map((e) => [e.key, e.state, e.text]))) };
  }
  return {
    leadCount: leadRows.length,
    leadNames: leadRows.map((l) => l.name).sort(),
    // every lead as the app returns it (all fields), hashed per row and keyed by id: a changed field in any row shows up
    leadRecords: Object.fromEntries(leadRows.map((l) => [String(l.id ?? l.placeId ?? l.name), sha(JSON.stringify(Object.entries(l).sort(([a], [b]) => a.localeCompare(b))))])),
    summary: summary.json,
    jobs: jobs.map((j) => ({ id: j.id, state: j.state, title: j.title })).sort((a, b) => a.id.localeCompare(b.id)),
    artifacts,
    threads,
    raw: { leads: leads.status, jobs: jobsRes.status, conversations: convs.status },
  };
}

let exitCode = 0;
let hubA: ChildProcess | undefined;
let hubB: ChildProcess | undefined;
try {
  // 1. seed
  const seeded = seedCold(SRC, "none");
  check("L1", "synthetic data seeded (leads, jobs, saved results, a conversation)", seeded.leads > 0 && seeded.jobs.length > 0 && seeded.artifacts.length > 0, { leads: seeded.leads, jobs: seeded.jobs.length, artifacts: seeded.artifacts.length });

  // A quiet hub opens the job routes only when BOTH stores exist (scripts/jobs/runtime.ts); the seed makes jobs.sqlite, so make the (empty) approvals store too.
  { const ap = new ApprovalService({ path: join(SRC, "approvals.sqlite") }); ap.close(); }

  // The owner's confirmed browser session, minted with the store before any hub starts (the hub trusts the first one). It is part of the
  // backed-up data, so it must still work on the restored hub: that is checked too.
  process.env.MU_DATA_DIR = SRC;
  const { DeviceStore } = await import("../devices/store");
  const owner = new DeviceStore(WORK).mintSession("usman", "This PC's browser (synthetic, confirmed)", "hub");
  const ownerCookie = encodeURIComponent(owner.cookie);
  delete process.env.MU_DATA_DIR;

  // 2. hub A, read back
  const a = await startHub(SRC, PORT_A, "a");
  hubA = a.child;
  const baseA = `http://127.0.0.1:${PORT_A}`;
  const browserA = await openBrowser({ profile: join(WORK, "browser-a"), port: 9247 });
  await browserA.goto(`${baseA}/__health`);
  await browserA.setCookie("mu_session", ownerCookie, baseA);
  await browserA.goto(`${baseA}/leads`);
  await sleep(2500);
  await browserA.shot(join(OUT, "restore-01-source-leads.png"));
  await browserA.goto(`${baseA}/activity`);
  await sleep(2500);
  await browserA.shot(join(OUT, "restore-02-source-activity.png"));
  const before = await snapshot(browserA);
  const withResult = Object.keys(before.artifacts);
  check("L2", "source hub: leads, jobs, saved results and a conversation are readable through the app", before.leadCount > 0 && before.jobs.length > 0 && withResult.length > 0 && Object.keys(before.threads).length > 0, { leads: before.leadCount, jobs: before.jobs.length, savedResults: withResult.length, conversations: Object.keys(before.threads).length, raw: before.raw });
  if (withResult[0]) {
    await browserA.goto(`${baseA}/__computers/artifacts/${withResult[0]}`);
    await browserA.shot(join(OUT, "restore-03-source-saved-result.png"));
  }
  await browserA.quit();

  // 3. backup while hub A runs, 4. verify, tamper, refuse
  const backup = cli("online backup of the running source hub", ["scripts/cloud/backup-cli.ts", "backup", "--data-dir", SRC, "--out", BACKUPS], { MU_HUB_ROLE: "server" });
  const dir = (/backup: (.+)/.exec(backup.text)?.[1] ?? "").replace("<run>", WORK).trim();
  check("L3", "backup ran while the hub was up and wrote a folder", backup.code === 0 && !!dir && existsSync(join(dir, "manifest.json")), backup.text.slice(0, 300));
  const verify = cli("verify the backup against its manifest", ["scripts/cloud/backup-cli.ts", "verify", "--from", dir]);
  check("L4", "verify: every file matches the manifest", verify.code === 0 && /verified: \d+ files match/.test(verify.text), verify.text);
  const tampered = join(WORK, "tampered-backup");
  cpSync(dir, tampered, { recursive: true });
  const victim = readdirSync(tampered, { recursive: true }).map(String).find((f) => /\.(json|sqlite)$/.test(f) && f !== "manifest.json" && !/-wal$|-shm$/.test(f));
  if (victim) appendFileSync(join(tampered, victim), "x");
  const bad = cli("a tampered copy must fail verify", ["scripts/cloud/backup-cli.ts", "verify", "--from", tampered]);
  check("L4", "verify: a tampered backup is refused", bad.code !== 0 && /FAILED/.test(bad.text), { victim, ...bad });

  // 5. stop A, restore into an empty folder; a non-empty target is refused
  stop(hubA);
  hubA = undefined;
  await sleep(2500);
  mkdirSync(RESTORED, { recursive: true });
  const nonEmpty = join(WORK, "not-empty");
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, "keep.txt"), "do not overwrite");
  const refuse = cli("restore into a NON-empty folder must be refused", ["scripts/cloud/backup-cli.ts", "restore", "--from", dir, "--to", nonEmpty, "--fresh-sessions"]);
  check("L5", "restore refuses a non-empty target and leaves it alone", refuse.code !== 0 && readFileSync(join(nonEmpty, "keep.txt"), "utf8") === "do not overwrite", refuse.text);
  const neither = cli("restore with neither session option must be refused", ["scripts/cloud/backup-cli.ts", "restore", "--from", dir, "--to", join(WORK, "neither")]);
  check("L5", "restore refuses to run without --keep-sessions or --fresh-sessions", neither.code !== 0 && !existsSync(join(WORK, "neither")), neither.text);
  const restore = cli("restore into an empty isolated folder; same-machine disaster recovery, so the sessions are kept on purpose", ["scripts/cloud/backup-cli.ts", "restore", "--from", dir, "--to", RESTORED, "--keep-sessions"]);
  check("L5", "restore: checksums verified and every store's row counts match the manifest", restore.code === 0 && /checksums verified/.test(restore.text) && !/MISMATCH/.test(restore.text), restore.text);

  // 5b. A --fresh-sessions restore (test, or another machine) signs everyone out: the owner cookie must stop working on that copy.
  const FRESH = join(WORK, "restored-fresh");
  const fresh = cli("restore --fresh-sessions: the old logins must not survive", ["scripts/cloud/backup-cli.ts", "restore", "--from", dir, "--to", FRESH, "--fresh-sessions"]);
  process.env.MU_DATA_DIR = FRESH;
  const freshStore = new DeviceStore(WORK, { file: join(FRESH, "devices.json"), secretFile: join(FRESH, "devices-secret") });
  delete process.env.MU_DATA_DIR;
  check("L5", "--fresh-sessions: sessions fresh, and the owner cookie from the backup no longer verifies on the copy", fresh.code === 0 && /sessions: fresh/.test(fresh.text) && freshStore.verifySession(owner.cookie) === null, fresh.text.split(String.fromCharCode(10)).slice(-2));

  // 6. hub B on the restored copy
  const b = await startHub(RESTORED, PORT_B, "b");
  hubB = b.child;
  const baseB = `http://127.0.0.1:${PORT_B}`;
  const browserB = await openBrowser({ profile: join(WORK, "browser-b"), port: 9257 });
  await browserB.goto(`${baseB}/__health`);
  await browserB.setCookie("mu_session", ownerCookie, baseB);
  await browserB.goto(`${baseB}/leads`);
  await sleep(2500);
  await browserB.shot(join(OUT, "restore-04-restored-leads.png"));
  await browserB.goto(`${baseB}/activity`);
  await sleep(2500);
  await browserB.shot(join(OUT, "restore-05-restored-activity.png"));
  const after = await snapshot(browserB);
  const me = await browserB.evaluate<string>("fetch('/__devices/me').then(r => r.json()).then(j => JSON.stringify({ via: j.via, actor: j.principal && j.principal.actor }))");
  check("L6", "the owner's browser session survived the restore (the same cookie works on the restored hub)", /"actor":"human"/.test(me ?? ""), me);
  if (withResult[0]) {
    await browserB.goto(`${baseB}/__computers/artifacts/${withResult[0]}`);
    await browserB.shot(join(OUT, "restore-06-restored-saved-result.png"));
  }
  await browserB.quit();
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  check("L6", "restored hub: same CRM leads, every field of every record, and not an empty list on both sides", before.leadCount > 0 && Object.keys(before.leadRecords).length === before.leadCount && same(after.leadRecords, before.leadRecords) && same(after.leadNames, before.leadNames), { before: before.leadRecords, after: after.leadRecords });
  check("L6", "restored hub: same jobs (ids, states, titles), and not an empty list on both sides", same(after.jobs, before.jobs) && before.jobs.length > 0, { before: before.jobs.length, after: after.jobs.length });
  check("L6", "restored hub: every saved result opens with identical content", same(after.artifacts, before.artifacts) && Object.keys(after.artifacts).length === withResult.length, { before: before.artifacts, after: after.artifacts });
  check("L6", "restored hub: the conversation is intact entry for entry", same(after.threads, before.threads) && Object.keys(after.threads).length > 0 && Object.values(after.threads).every((t) => t.entries > 0), { before: before.threads, after: after.threads });
  check("L6", "restored hub: the lead summary matches", same(after.summary, before.summary), { before: before.summary, after: after.summary });
  const health = await (await fetch(`${baseB}/__health`)).json().catch(() => ({}));
  check("L6", "restored hub answers /__health", !!health && typeof health === "object", Object.keys(health as object));

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, "restore-journey-result.json"), JSON.stringify({ ran: new Date().toISOString(), verdict: failed.length ? "FAIL" : "PASS", scope: "this PC, synthetic data, isolated folders under D:\\AgenticOS-r7-data; no Ryzen, no 8081, no production data", before, after, results }, null, 2));
  writeFileSync(join(OUT, "restore-journey-commands.txt"), commands.join("\n\n") + "\n");
  console.log(`\n${failed.length ? "FAIL" : "PASS"}: ${results.length - failed.length}/${results.length} checks`);
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(error);
  exitCode = 2;
} finally {
  stop(hubA);
  stop(hubB);
}
process.exit(exitCode);

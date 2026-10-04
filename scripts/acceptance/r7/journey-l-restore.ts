#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey L: backup, isolated restore and app verification, on the synthetic hub only.
 *
 *   1. Mark the data: a new bot (through the app), and read a snapshot through the app's own APIs (bots, jobs, leads, coding jobs, saved results,
 *      the bot conversation).
 *   2. Stop the hub, back up its data folder (scripts/cloud/backup-cli.ts backup), verify the manifest, restore into a NEW empty folder.
 *   3. Start a second hub on the preview port (8138) against the RESTORED folder only, and re-read the same snapshot in a real browser: every count
 *      and the marker bot match; the marker bot opens in the Agents page; a saved result opens.
 *   4. Isolation: change the marker bot on the restored hub; stop it; restart the original: the original never saw the change.
 *
 *   bun scripts/acceptance/r7/journey-l-restore.ts [--hub http://127.0.0.1:8128] [--restore-port 8138]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { api, arg, closeAll, DATA, expect, hubArgs, flat, HUB, record, session, shot, SIZES, sleep, until, writeResults } from "./lib";

const ROW = "L backup";
const RPORT = arg("restore-port", "8138");
const RHUB = `http://127.0.0.1:${RPORT}`;
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const BACKUPS = `${DATA}-backups`;
const RESTORED = `${DATA}-restore-${STAMP}`;
const MARK = `Wren${Date.now().toString(36).slice(-4)}`;
const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 600_000, cwd: join(import.meta.dir, "..", "..", "..") });
// An explicit --port/--data (the restored hub) comes first and wins; otherwise this run's own hub, never hub.ts's defaults.
const hubCli = (...a: string[]) => run([join(import.meta.dir, "hub.ts"), ...a, ...hubArgs()]);

async function snapshot(p: Page, origin: string) {
  await p.goto(`${origin}/agents/workspace`, { waitUntil: "domcontentloaded" });
  const get = async (u: string) => (await api(p, "GET", u)).json;
  const bots = ((await get("/__agents/bots"))?.bots ?? []) as { id: string; name: string; purpose: string; rev: number }[];
  const jobs = ((await get("/__jobs"))?.jobs ?? []) as { id: string; state: string }[];
  const leads = await get("/__operator/leads/list?limit=200");
  const coding = ((await get("/__operator/coding/jobs?limit=200"))?.jobs ?? []) as { id: string; state: string }[];
  const files = ((await get("/__agents/bots/research/files"))?.files ?? []) as unknown[];
  const thread = await get("/__agents/bots/research/thread");
  return {
    bots: bots.map((b) => `${b.id}:${b.rev}`).sort(),
    marker: bots.find((b) => b.name === MARK) ?? null,
    jobs: jobs.map((j) => `${j.id.slice(0, 8)}:${j.state}`).sort(),
    leads: (leads?.leads ?? leads?.items ?? []).length,
    coding: coding.map((j) => `${j.id.slice(0, 8)}:${j.state}`).sort(),
    researchFiles: files.length,
    researchThread: thread?.entries?.length ?? null,
  };
}

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  // 1. mark and snapshot
  const made = await api(p, "POST", "/__agents/bots", { name: MARK, purpose: "Marker bot for the backup and restore check (synthetic)." });
  expect(ROW, "marker bot made through the app", made.status === 201, { status: made.status, error: made.json?.error });
  const before = await snapshot(p, HUB);
  record(ROW, "snapshot of the original hub (through its own APIs)", "PASS", { ...before, marker: before.marker?.id });
  await closeAll(); // the owner profile must not be in use while the hub restarts

  // 2. stop, back up, verify, restore into a new folder
  const stop = hubCli("stop");
  mkdirSync(BACKUPS, { recursive: true });
  // A killed hub can hold its SQLite files for a few seconds on Windows ("disk I/O error" on the first try, seen once): wait, then retry.
  let b = run(["scripts/cloud/backup-cli.ts", "backup", "--data-dir", DATA, "--out", BACKUPS]);
  for (let i = 0; i < 4 && b.status !== 0 && /I\/O|busy|locked|EBUSY/i.test(b.stderr); i++) {
    await sleep(5000);
    b = run(["scripts/cloud/backup-cli.ts", "backup", "--data-dir", DATA, "--out", BACKUPS]);
  }
  const dir = (b.stdout.match(/^backup: (.+)$/m) ?? [])[1]?.trim();
  expect(ROW, "backup of the stopped hub's data folder", b.status === 0 && !!dir, { stop: flat(stop.stdout).slice(0, 80), out: flat(b.stdout).slice(0, 300), err: flat(b.stderr).slice(0, 200) });
  if (!dir) return;
  const v = run(["scripts/cloud/backup-cli.ts", "verify", "--from", dir]);
  expect(ROW, "backup verifies against its manifest", v.status === 0, flat(v.stdout).slice(0, 200));
  const r = run(["scripts/cloud/backup-cli.ts", "restore", "--from", dir, "--to", RESTORED, "--keep-sessions"]);
  expect(ROW, "restore into a new, isolated folder (checksums and per-table counts match)", r.status === 0, { out: flat(r.stdout).slice(0, 400), err: flat(r.stderr).slice(0, 200) });

  // 3. a second hub on the restored folder only
  const rs = hubCli("start", "--port", RPORT, "--data", RESTORED, "--no-owner");
  record(ROW, `restored hub started on ${RPORT}`, rs.status === 0 ? "PASS" : "FAIL", flat(rs.stdout || rs.stderr).slice(0, 200));
  const s2 = await session(SIZES[0], { origin: RHUB });
  const p2 = s2.page;
  await p2.goto(`${RHUB}/`, { waitUntil: "domcontentloaded" });
  const who = await api(p2, "GET", "/__devices/me");
  const after = await snapshot(p2, RHUB);
  const same = JSON.stringify({ ...before, marker: before.marker?.id }) === JSON.stringify({ ...after, marker: after.marker?.id });
  expect(ROW, "the restored hub serves the same data: bots (with revs), jobs and states, leads, coding jobs, saved results, conversation", same, { restored: { ...after, marker: after.marker?.id }, ownerOnRestored: who.json?.principal?.actor ?? null });
  await p2.goto(`${RHUB}/agents/workspace/${MARK.toLowerCase()}`, { waitUntil: "domcontentloaded" });
  await p2.getByRole("radio", { name: new RegExp(`^${MARK}`) }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  const visible = await p2.getByRole("radio", { name: new RegExp(`^${MARK}`) }).count();
  await shot(p2, "l-1-restored-agents");
  const marker = JSON.parse(await Bun.file(join(RESTORED, ".gate-seed.json")).text()) as { jobs: { key: string; jobId: string }[] };
  const resultId = marker.jobs.find((j) => j.key === "result-research")?.jobId;
  const art = resultId ? await p2.goto(`${RHUB}/__computers/artifacts/${resultId}`, { waitUntil: "domcontentloaded" }) : null;
  const artText = art ? flat(await p2.locator("body").innerText()).slice(0, 120) : "";
  expect(ROW, "in the restored app: the marker bot is in the Agents selector and a saved result opens", visible === 1 && art?.status() === 200 && /Canberra/.test(artText), { selector: visible, artifact: art?.status() ?? null, text: artText });

  // 4. isolation: a change on the restored hub never reaches the original
  await p2.goto(`${RHUB}/agents/workspace`, { waitUntil: "domcontentloaded" });
  const id = after.marker ? (after.marker as { id: string }).id : MARK.toLowerCase();
  const cur = (await api(p2, "GET", `/__agents/bots/${id}`)).json;
  const changed = await api(p2, "PATCH", `/__agents/bots/${id}`, { rev: cur?.rev, purpose: "Changed on the RESTORED hub only." });
  await closeAll();
  hubCli("stop", "--data", RESTORED);
  const back = hubCli("start", "--no-owner");
  const s3 = await session(SIZES[0]);
  await s3.page.goto(`${HUB}/agents/workspace`, { waitUntil: "domcontentloaded" });
  const orig = await until("original bot", async () => (await api(s3.page, "GET", `/__agents/bots/${id}`)).json, 20_000);
  expect(ROW, "isolation: the restored hub's change is not in the original", changed.status === 200 && orig?.purpose === "Marker bot for the backup and restore check (synthetic).", { restoredPatch: changed.status, originalPurpose: orig?.purpose, originalRestart: flat(back.stdout).slice(0, 120) });
  record(ROW, "production backup on Ryzen (nightly task, C:\\mu-hub\\data\\production) and its restore", "OUT OF SCOPE", "lead/owner only: production is never touched from this worktree");
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-l-restore", { backups: BACKUPS, restored: RESTORED });
  await closeAll();
  // Leave things as found: the restored hub stopped, the original hub running.
  hubCli("stop", "--port", RPORT, "--data", RESTORED);
  const up = await fetch(`${HUB}/__health`).then((r) => r.status).catch(() => 0);
  if (!up) hubCli("start", "--no-owner");
}

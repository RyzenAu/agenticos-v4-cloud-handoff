#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey F (synthetic half): the Coding page over the gate seed's nine synthetic coding jobs. Reads are verified against
 * /__operator/coding/jobs; a decision on a pending tool request (Deny, double-clicked) is written once and survives a reload; Stop (with its
 * confirmation) on the synthetic running job persists; unknown ids say so. The REAL half (a small job on a chosen account and model, receipts,
 * review, approval, failure recovery, no duplicate execution on a live provider) needs the owner's coding accounts and is BLOCKED here: this hub
 * has no accounts (synthetic HOME, no keys) and paid model calls are out of bounds for acceptance.
 *
 *   bun scripts/acceptance/r7/journey-f-coding.ts [--hub http://127.0.0.1:8128]
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { api, closeAll, DATA, expect, flat, HUB, pageHealth, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "F coding";
type CJob = { id: string; state: string; spec?: { objective?: string }; supersededBy?: unknown };

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/coding`, { waitUntil: "domcontentloaded" });
  const jobs = async () => ((await api(p, "GET", "/__operator/coding/jobs?limit=50")).json?.jobs ?? []) as CJob[];
  const one = async (id: string) => (await api(p, "GET", `/__operator/coding/jobs/${id}`)).json as { job?: CJob & { runs?: { roleId: string; state: string; pendingInput?: unknown }[] }; receipts?: unknown[] } | null;
  // H-12: the in-flight coding jobs are written AFTER the hub booted (seed-gate-hub --phase live), so boot recovery has not interrupted them.
  const live = spawnSync(process.execPath, [join(import.meta.dir, "..", "seed-gate-hub.ts"), "--data", DATA, "--phase", "live"], { encoding: "utf8" });
  const marker = JSON.parse(await Bun.file(join(DATA, ".gate-seed.json")).text()) as { jobs: { key: string; jobId: string }[] };
  const liveIds = { input: marker.jobs.find((j) => j.key === "coding-needs-input")?.jobId, running: marker.jobs.find((j) => j.key === "coding-running")?.jobId };
  record(ROW, "live coding seed after boot (H-12)", liveIds.input && liveIds.running ? "PASS" : "FAIL", { seeded: live.status === 0 ? "now" : /already/.test(live.stderr) ? "already" : flat(live.stderr).slice(0, 160), liveIds });
  await p.reload({ waitUntil: "domcontentloaded" });
  const all = await jobs();
  await p.waitForTimeout(3000);
  const listText = flat(await p.locator("main").innerText());
  const shown = all.filter((j) => listText.includes((j.spec?.objective ?? "").slice(0, 25)));
  expect(ROW, "the Coding list shows every stored job (objective text on screen)", all.length > 0 && shown.length === all.length, { stored: all.length, onScreen: shown.length, states: all.map((j) => j.state) });
  await shot(p, "f-1-coding-list");

  // Every job's detail page renders; receipts for finished work
  const rows: unknown[] = [];
  for (const j of all) {
    await p.goto(`${HUB}/coding/${j.id}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2000);
    const h = await pageHealth(p);
    const d = await one(j.id);
    rows.push({ state: j.state, h1: h.h1[0], crashed: h.crashed, overflow: h.overflow, receipts: d?.receipts?.length ?? null });
  }
  expect(ROW, "each job's page renders (h1, no crash, no overflow)", (rows as { crashed: boolean; overflow: boolean; h1?: string }[]).every((r) => !r.crashed && !r.overflow && !!r.h1), rows);

  // A pending tool request: Deny, double-clicked, is decided once and persists
  const target = all.find((j) => j.id === liveIds.input);
  if (!target) record(ROW, "Deny on a pending tool request is written once and persists", "BLOCKED", "the gate seed writes coding jobs BEFORE the hub boots, so boot recovery turns the waiting-for-input job into interrupted (honest, not replayed); a live coding seed after boot is needed (worker D)");
  else {
    await p.goto(`${HUB}/coding/${target.id}`, { waitUntil: "domcontentloaded" });
    const deny = p.getByRole("button", { name: "Deny" }).first();
    await deny.waitFor({ timeout: 20_000 }).catch(() => undefined);
    if (!(await deny.count())) record(ROW, "Deny on a pending tool request is written once and persists", "FAIL", { said: flat(await p.locator("main").innerText()).slice(0, 300) });
    else {
      await deny.dblclick({ delay: 30 });
      await p.waitForTimeout(2500);
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2500);
      const d = await one(target.id);
      const stillPending = (d?.job?.runs ?? []).some((r) => r.pendingInput);
      expect(ROW, "Deny (double-clicked) is decided once: after reload no request is pending and the Deny button is gone", !stillPending && (await p.getByRole("button", { name: "Deny" }).count()) === 0, { state: d?.job?.state, runs: (d?.job?.runs ?? []).map((r) => `${r.roleId}:${r.state}`) });
    }
  }

  // Stop (with confirmation) on the running synthetic job
  const running = (await jobs()).find((j) => j.id === liveIds.running);
  const runningState = running?.state;
  if (!running) record(ROW, "Stop with confirmation on a running job persists", "BLOCKED", "same cause: the seeded running coding job is interrupted by boot recovery; needs a live coding seed after boot (worker D)");
  else {
    await p.goto(`${HUB}/coding/${running.id}`, { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: /^Stop/ }).first().click({ timeout: 20_000 });
    await p.getByRole("button", { name: "Keep it running" }).waitFor({ timeout: 10_000 });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    const escapeKept = (await one(running.id))?.job?.state === runningState;
    await p.getByRole("button", { name: "Keep it running" }).click().catch(() => undefined);
    await p.getByRole("button", { name: /^Stop/ }).first().click();
    await p.getByRole("button", { name: "Yes, stop it" }).click();
    const stopped = await until("stopped", async () => ((await one(running.id))?.job?.state === "cancelled" ? true : null), 15_000);
    await p.reload({ waitUntil: "domcontentloaded" });
    expect(ROW, "Stop asks first (Escape or Keep it running changes nothing), then Stop persists as cancelled", escapeKept && !!stopped, { escapeKept, state: (await one(running.id))?.job?.state });
    await shot(p, "f-2-stopped");
  }

  // Unknown id
  await p.goto(`${HUB}/coding/00000000-0000-4000-8000-000000000000`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const unknownText = flat(await p.locator("main").innerText());
  expect(ROW, "an unknown coding job id says so", /not found|no such|isn.t|doesn.t exist|couldn.t find/i.test(unknownText), { says: unknownText.slice(0, 200) });

  for (const step of ["A small real job on the selected account and model (Builder, pinned account)", "Receipts per model call, reviewer independence, approval to apply", "Failure recovery: provider limit → fallback or honest pause, Resume continues the same sessions", "No duplicate execution: Start double-clicked and a hub restart mid-run run once"])
    record(ROW, step, "BLOCKED", "needs the owner's coding accounts on a disposable repo (paid or quota-bearing): lead/owner run on the candidate");
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-f-coding");
  await closeAll();
}

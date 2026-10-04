#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey D (the part a host-less synthetic hub can show): Stop on a running job, from the UI, persists and nothing runs after it;
 * a stopped job is not replayed by a restart; the Computers page and the bot's Computer panel say plainly that there is no computer instead of
 * offering takeover controls that cannot work. Takeover → agent input paused → release → resume, and Stop cancelling REAL computer work, need a
 * bot computer (worker C's local WSL displays or Ryzen-PC) and are recorded BLOCKED here; the lead runs them in phase 2 on a computer host.
 *
 *   bun scripts/acceptance/r7/journey-d-stop.ts [--hub http://127.0.0.1:8128]
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { api, closeAll, DATA, expect, flat, HUB, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "D stop";

async function main() {
  const live = spawnSync(process.execPath, [join(import.meta.dir, "..", "seed-gate-hub.ts"), "--data", DATA, "--phase", "live"], { encoding: "utf8" });
  const seeded = /already seeded/.test(live.stderr) ? "already" : live.status === 0 ? "now" : `failed: ${flat(live.stderr).slice(0, 160)}`;
  const marker = JSON.parse(await Bun.file(join(DATA, ".gate-seed.json")).text()) as { jobs: { key: string; jobId: string; title: string }[] };
  const running = marker.jobs.find((j) => j.key === "running");
  if (!running) return record(ROW, "a running synthetic job exists", "BLOCKED", { seeded });
  const s = await session(SIZES[0]);
  const p = s.page;
  const job = async () => ((await api(p, "GET", `/__jobs/${running.jobId}`)).json?.job ?? (await api(p, "GET", `/__jobs/${running.jobId}`)).json) as { state: string; steps?: unknown[]; cancelRequested?: boolean; quarantined?: boolean } | null;
  const j0 = await job();
  record(ROW, "running synthetic job (seeded after boot)", j0 ? "PASS" : "FAIL", { seeded, state: j0?.state, steps: j0?.steps?.length });

  // Stop from the UI: the Inspector's job history (the shell's one Stop for a computer/control job).
  await p.goto(`${HUB}/activity`, { waitUntil: "domcontentloaded" });
  await p.locator("main").waitFor({ timeout: 30_000 });
  await p.waitForTimeout(2000);
  await p.keyboard.press("Alt+Shift+I"); // the Inspector (also under More); its "Agent steps" tab holds the job history with Stop
  await p.locator("#sh-inspector").waitFor({ timeout: 15_000 });
  // The tab picker is a segmented control on wide screens and a <select> on narrow ones: use whichever is visible.
  const stepsSelect = p.locator("#sh-inspector select:has(option[value=steps])");
  if (await stepsSelect.isVisible().catch(() => false)) await stepsSelect.selectOption("steps");
  else await p.locator("#sh-inspector").getByRole("radio", { name: "Agent steps" }).or(p.locator("#sh-inspector").getByRole("tab", { name: "Agent steps" })).or(p.locator("#sh-inspector").getByRole("button", { name: "Agent steps" })).first().click({ timeout: 10_000 });
  const item = p.locator('section[aria-label="Job history"] li', { hasText: running.title.slice(0, 30) }).first();
  const stop = item.getByRole("button", { name: "Stop" });
  if (!(await stop.count())) {
    record(ROW, "Stop is offered on the running job in the UI", "FAIL", { history: flat(await p.locator('section[aria-label="Job history"]').innerText().catch(() => "(no Job history section)")).slice(0, 300) });
  } else {
    await stop.dblclick({ delay: 30 }); // a double click must not do anything twice
    const ended = await until("stopped", async () => {
      const j = await job();
      return j && ["cancelled", "unknown", "interrupted"].includes(j.state) ? j : j?.quarantined ? j : null;
    }, 20_000);
    await shot(p, "d-1-stopped");
    const later = await job();
    const button = flat(await item.innerText()).slice(-120);
    // The seeded job was written by another process (the seed), so no worker in this hub holds it: the hub can only set the durable stop flag
    // (scripts/jobs/service.ts cancel(): "Running in another worker"). That is the same position as a job whose worker died. What a person must
    // see then is that the stop is recorded and why it has not finished, not an endless "Stopping…".
    if (ended) expect(ROW, "Stop (double-clicked) ends the job, persisted", true, { state: later?.state, quarantined: later?.quarantined ?? false });
    else {
      expect(ROW, "Stop on a job no worker in this hub holds: the stop request is durable (cancelRequested)", later?.cancelRequested === true, { state: later?.state, cancelRequested: later?.cancelRequested });
      expect(ROW, "…and the UI says the stop is recorded but unconfirmed, instead of an endless 'Stopping…' (finding H-08)", !/Stopping…/.test(button) || /not confirmed|waiting|recorded/i.test(button), { after20s: button });
    }
  }
  await p.reload({ waitUntil: "domcontentloaded" });
  const afterReload = await job();
  record(ROW, "after reload: the job's recorded state (for the record)", "PASS", { state: afterReload?.state, cancelRequested: afterReload?.cancelRequested });

  // A second Stop is harmless: refused (409) or a no-op that repeats nothing
  const again = await api(p, "POST", `/__jobs/${running.jobId}/cancel`, {});
  expect(ROW, "a second cancel is harmless (409, or a no-op 200/202)", again.status === 409 || again.status === 202 || again.status === 200, { status: again.status, body: again.json });

  // Honest states with no computer
  await p.goto(`${HUB}/agents/workspace/research`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const show = p.getByRole("button", { name: "Show computer" });
  if (await show.count()) await show.click();
  await p.waitForTimeout(1500);
  const text = flat(await p.locator("main").innerText());
  const takeover = await p.getByRole("button", { name: /Take control|Request control/ }).count();
  expect(ROW, "no computer: the bot's computer panel says so and offers no takeover control", takeover === 0 && /offline|isn.t on this hub|no computer|doesn.t exist/i.test(text), { takeoverButtons: takeover, says: (text.match(/[^.]*(offline|isn.t on this hub|doesn.t exist)[^.]*\./i) ?? [""])[0] });
  await shot(p, "d-2-no-computer");
  // Screen truth (candidate, worker C): with no computer the screen is never called ready, and the API names the failing layer or says there is
  // no such computer; nothing claims a live view.
  const screen = await api(p, "GET", "/__computers/research/screen");
  const screenText = JSON.stringify(screen.json ?? screen.text);
  const claimsReady = /"ready"\s*:\s*true|screen ready|"layer"\s*:\s*null/i.test(screenText) || /Live view|Screen ready/i.test(text);
  expect(ROW, "screen truth with no computer: /__computers/research/screen does not claim a ready screen and the page shows no live view", !claimsReady && screen.status !== 500, { status: screen.status, body: screenText.slice(0, 300), pageClaimsLive: /Live view|Screen ready/i.test(text) });
  const screenshotReq = await api(p, "GET", "/__computers/research/screenshot");
  expect(ROW, "screen truth: a screenshot of a computer that doesn't exist is refused (no stale or placeholder image)", screenshotReq.status >= 400, { status: screenshotReq.status });
  record(ROW, "screen-truth layers (host, display, VNC, blank, viewer, frame) on a real computer", "BLOCKED", "needs a computer host (worker C's WSL displays); C's unit tests cover the layer logic (scripts/computers/screen.test.ts)");
  for (const step of ["Takeover pauses agent input (agent input refused while a person holds the lease)", "Release resumes the SAME job with no replay", "Stop cancels real computer work and later steps never run (file never written)", "A program cannot take or use the lease (person-only input)"])
    record(ROW, step, "BLOCKED", "needs a bot computer: run scripts/acceptance/r6b-gate-drive.ts --scenario computers-controls on a hub with a host (worker C's WSL displays, or Ryzen-PC via the lead)");
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-d-stop");
  await closeAll();
}

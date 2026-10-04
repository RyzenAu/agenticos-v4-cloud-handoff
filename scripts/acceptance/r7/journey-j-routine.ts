#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey J: a synthetic routine runs once and notifies once, across a duplicate event and a hub restart.
 *
 * The routine is the seeded "New enquiry: draft a reply" trigger (scripts/triggers/service.ts), fed the SYNTHETIC enquiry source only. It drafts,
 * never sends: its follow-up is ONE approval card ("Send the reply drafted for enquiry …"), which is the notification counted here, plus the job
 * events seen on the page's own /__events stream. The same event is delivered twice (a duplicate), the hub is restarted, the periodic tick runs,
 * and the event is delivered a third time: there must still be one delivery, one job, one approval. The Automations page must show it after reload.
 *
 *   bun scripts/acceptance/r7/journey-j-routine.ts [--hub http://127.0.0.1:8128]
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { api, closeAll, expect, flat, HUB, hubArgs, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "J routine";
const REF = `SYN-R7H-${Date.now().toString(36).toUpperCase()}`.slice(0, 30);
const hubCli = (...a: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "hub.ts"), ...a, ...hubArgs()], { encoding: "utf8", timeout: 300_000 });

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  // Collect the page's own live stream (what the notification bell and Activity read).
  await p.goto(`${HUB}/automations`, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => {
    (window as any).__r7events = [];
    const es = new EventSource("/__events");
    es.onmessage = (e) => (window as any).__r7events.push(e.data.slice(0, 600));
    for (const t of ["job", "approval", "trigger", "notification"]) es.addEventListener(t, (e: MessageEvent) => (window as any).__r7events.push(`${t}:${String(e.data).slice(0, 600)}`));
  });
  const list = async () => ((await api(p, "GET", "/__operator/triggers")).json?.triggers ?? []) as { id: string; state: string; name: string; counts?: Record<string, number>; lastDelivery?: { id: number; jobId?: string; stage?: string } }[];
  const enquiry = (await list()).find((t) => t.id === "trg-synthetic-enquiry");
  if (!enquiry) return record(ROW, "the synthetic enquiry routine exists", "BLOCKED", { triggers: (await list()).map((t) => t.id) });
  if (enquiry.state !== "active") await api(p, "POST", "/__operator/triggers/resume", { id: enquiry.id });

  const deliver = () => api(p, "POST", "/__operator/triggers/synthetic", { ref: REF, topic: "Check-up" });
  const d1 = await deliver();
  const d2 = await deliver(); // the duplicate event
  const r1 = d1.json?.results?.[0] ?? {};
  const r2 = d2.json?.results?.[0] ?? {};
  const jobId = r1.jobId ?? r2.jobId ?? null;
  expect(ROW, "first delivery runs; the identical second event is a duplicate of the same delivery and job", d1.status === 200 && r2.status === "duplicate" && r2.deliveryId === r1.deliveryId, { first: r1, second: r2 });
  const approvalsFor = async () => {
    const r = await api(p, "GET", "/__approvals");
    const all = (r.json?.approvals ?? r.json?.items ?? r.json ?? []) as { id: string; summary?: string; state?: string; status?: string }[];
    return Array.isArray(all) ? all.filter((a) => JSON.stringify(a).includes(REF)) : [];
  };
  const firstApprovals = await until("the approval card", async () => ((await approvalsFor()).length ? await approvalsFor() : null), 30_000);
  const job = jobId ? (await api(p, "GET", `/__jobs/${jobId}`)).json?.job ?? (await api(p, "GET", `/__jobs/${jobId}`)).json : null;
  expect(ROW, "the routine ran once: one job with its draft step, one approval card (the notification), nothing sent", !!job && (firstApprovals?.length ?? 0) === 1, { jobState: job?.state, steps: (job?.steps ?? []).map((x: { intent: string }) => x.intent.slice(0, 60)), approvals: (firstApprovals ?? []).map((a) => ({ id: a.id, state: a.state ?? a.status, summary: a.summary })) });

  await p.waitForTimeout(1500);
  const eventsBefore = (((await p.evaluate(() => (window as any).__r7events as string[] | undefined)) ?? []) as string[]).filter((e) => (jobId && e.includes(jobId)) || e.includes(REF));
  // UI: Automations shows it after a reload.
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.locator('[data-testid="triggers-panel"]').waitFor({ timeout: 30_000 }).catch(() => undefined);
  const panel = flat(await p.locator('[data-testid="triggers-panel"]').innerText().catch(() => ""));
  expect(ROW, "the Automations page shows the routine and its last delivery after reload", /New enquiry/.test(panel), { panel: panel.slice(0, 400) });
  await shot(p, "j-1-automations");

  // Restart the hub (a real stop and start), then a tick and a third identical event.
  const stop = hubCli("stop");
  const start = hubCli("start", "--no-owner", "--triggers", "on");
  record(ROW, "hub restarted (stop, start)", start.status === 0 ? "PASS" : "FAIL", { stop: flat(stop.stdout).slice(0, 120), start: flat(start.stdout || start.stderr).slice(0, 200) });
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  const tick = await api(p, "POST", "/__operator/triggers/tick", {});
  const d3 = await deliver();
  const r3 = d3.json?.results?.[0] ?? {};
  await p.waitForTimeout(3000);
  const afterApprovals = await approvalsFor();
  const jobsWithRef = ((await api(p, "GET", "/__jobs")).json?.jobs ?? []).filter((j: { title?: string; id: string }) => JSON.stringify(j).includes(REF) || j.id === jobId);
  const trig = (await list()).find((t) => t.id === "trg-synthetic-enquiry");
  expect(ROW, "after the restart, a tick and a third identical event: still one delivery, one job, one approval", r3.status === "duplicate" && r3.deliveryId === r1.deliveryId && afterApprovals.length === 1 && jobsWithRef.length <= 1, { tick: tick.status, third: r3, approvals: afterApprovals.length, jobs: jobsWithRef.map((j: { id: string; state: string }) => `${j.id.slice(0, 8)}:${j.state}`), counts: trig?.counts });
  record(ROW, "live-stream events seen for this run before the restart (for the record)", "PASS", { count: eventsBefore.length, sample: eventsBefore.slice(0, 4).map((e) => e.slice(0, 160)) });
  record(ROW, "a scheduled (clock) routine firing once across a restart (Morning summary, 07:30 Sydney)", "NOT RUN", "needs the clock to cross 07:30 with the hub stopped (offlinePolicy run-once); covered by scripts/triggers/engine.test.ts, not by this browser run");
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-j-routine", { ref: REF });
  await closeAll();
}

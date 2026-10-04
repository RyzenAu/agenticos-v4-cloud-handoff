// Round 7, journey J: a routine linked to a bot runs ONCE and notifies ONCE, however its trigger arrives: the same event twice at the same moment,
// again later, and again after the trigger service restarts over the same store. Synthetic routine ("routine.schedule"), synthetic computer.
// What "once" means here: one task started on the bot's computer, one job per kind, one terminal entry per job in the founder's bot conversation,
// and one live append notification for it (the thing the stream, the voice gate and a browser's notification all start from).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { botThreadId } from "../conversations";
import { createTriggerService } from "../triggers/service";
import { makeRig, sleep, waitFor, type Rig } from "./test-rig";

const cleanups: Array<() => void | Promise<void>> = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const r of rigs.splice(0)) await r.close();
});

const ROUTINE = "trg-bot-clinics";
const triggers = (r: Rig) => {
  const hooks = r.agents.routineHooks;
  const svc = createTriggerService({ path: join(r.root, "triggers.sqlite"), jobs: r.jobs, approvals: {} as never, asBot: (t) => hooks.asBot(t), onBotJob: (i) => hooks.onBotJob(i), deps: { botTask: (i) => hooks.botTask(i) } });
  svc.store.upsert({ id: ROUTINE, name: "Weekly clinic check", kind: "routine", source: "routine.schedule", action: "bot.task", conditions: [], mode: "draft", retryLimit: 1, offlinePolicy: "skip", schedule: { kind: "interval", everyMinutes: 60 }, config: { goal: "find new dental clinics in Parramatta" } } as never);
  return svc;
};
const fire = (svc: ReturnType<typeof triggers>, slot: string) => svc.engine.ingest(svc.store.get(ROUTINE)!, { source: "routine.schedule", eventId: `${ROUTINE}:${slot}`, actor: "system", fields: { slot } });

describe("J. a routine runs once and notifies once", () => {
  test("a duplicated trigger event, a late repeat and a restart of the trigger service: one task, one completion per job, in the linking founder's conversation", async () => {
    const r = await makeRig({ routines: [ROUTINE] });
    rigs.push(r);
    // Every live append (the one place a stream push, a spoken line and a browser notification start from).
    const appended: Array<{ conversationId: string; key: string; state: string }> = [];
    cleanups.push(r.conversations.onAppend((e) => appended.push({ conversationId: e.conversationId, key: e.entry.key, state: e.entry.state })));
    r.setBody(async () => (await sleep(80), { ok: true, note: "report ready" }));
    expect((await r.agents.service.patch("research", { rev: 1, routines: [ROUTINE] }, "mehroz")).status).toBe(200);

    const first = triggers(r);
    cleanups.push(() => first.close());
    // The same event delivered twice at once (a duplicated webhook or a double tick).
    const [a, b] = await Promise.all([fire(first, "2026-10-03T09:00:00Z"), fire(first, "2026-10-03T09:00:00Z")]);
    expect([a.status, b.status].filter((s) => s === "job").length).toBeGreaterThanOrEqual(1);
    expect(r.started).toHaveLength(1);
    const jobsAfterBoth = r.jobs.list({ bot: "research" }).map((j) => j.id).sort();
    expect(jobsAfterBoth).toHaveLength(2); // the trigger's own job and the bot's task on its computer: one of each, not two of each

    // Later, the same event again; then a restart of the trigger service over the same durable store, and the same event once more.
    await sleep(20);
    await fire(first, "2026-10-03T09:00:00Z");
    first.close();
    const second = triggers(r);
    cleanups.push(() => second.close());
    await fire(second, "2026-10-03T09:00:00Z");
    expect(r.started).toHaveLength(1);
    expect(r.jobs.list({ bot: "research" }).map((j) => j.id).sort()).toEqual(jobsAfterBoth);

    // The jobs finish; the conversation is Mehroz's (who linked the routine), and each job ends there exactly once.
    await waitFor(() => r.jobs.list({ bot: "research" }).every((j) => j.state === "succeeded"), 8000);
    const mehroz = botThreadId("mehroz", "research");
    await waitFor(() => (r.conversations.get(mehroz)?.entries ?? []).filter((e) => e.state === "succeeded").length === 2, 8000);
    await r.threads.reconcile(); // a re-read of every watched job (what a restart does): nothing new
    await sleep(60);
    const entries = r.conversations.get(mehroz)!.entries!;
    for (const id of jobsAfterBoth) expect(entries.filter((e) => e.key === `${id}:succeeded`)).toHaveLength(1);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    expect(r.conversations.get(botThreadId("usman", "research"))).toBeNull();
    // One live notification per terminal entry; none for a repeat.
    for (const id of jobsAfterBoth) expect(appended.filter((e) => e.key === `${id}:succeeded`)).toHaveLength(1);
    expect(appended.every((e) => e.conversationId === mehroz)).toBe(true);
  });

  test("a routine whose bot is archived or unlinked at the time of the event starts nothing on the computer and says so once", async () => {
    const r = await makeRig({ routines: [ROUTINE] });
    rigs.push(r);
    r.setBody(async () => ({ ok: true }));
    const svc = triggers(r);
    cleanups.push(() => svc.close());
    const res = await fire(svc, "2026-10-03T10:00:00Z");
    await fire(svc, "2026-10-03T10:00:00Z");
    expect(res.status).toBe("job");
    expect(r.started).toHaveLength(0);
    expect(r.jobs.list({ kind: "trigger" })).toHaveLength(1);
  });
});

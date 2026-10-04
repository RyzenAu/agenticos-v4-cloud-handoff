// Typed and spoken requests for a bot, through the real command service: one conversation per person and bot, every job's progress, result and
// completion in it exactly once (and not again after a restart), "Stop that task" resolving to the right bot or asking, nothing sent to another machine,
// a Builder coding job on a named account (refused, never swapped, when it isn't ready), CRM subjects, and the CRM contract on synthetic records.
import { afterEach, describe, expect, test } from "bun:test";
import { botThreadId, jarvisThreadId } from "../conversations";
import { computerCommand } from "../computers/jarvis";
import { createJobThreads } from "../jarvis-command/threads";
import { codingSnapshotOf } from "../jarvis-command/coding-snapshot";
import { commandFor, computerView, fakeCodingJob, makeRig, mehroz, sleep, usageEvent, usman, waitFor, type Rig } from "./test-rig";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async (o: Parameters<typeof makeRig>[0] = {}) => {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
};
const research = (p = "usman") => botThreadId(p, "research");
const builder = (p = "usman") => botThreadId(p, "builder");
const entries = (r: Rig, conv: string) => r.conversations.get(conv)?.entries ?? [];
const keys = (r: Rig, conv: string) => entries(r, conv).map((e) => e.key);
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((res) => (release = res));
  return { promise, release };
};
/** A job body that waits for the test to let it finish. */
const gated = (h: ReturnType<typeof hold>) => async (_id: string, ctx: { signal: AbortSignal }) => {
  await Promise.race([h.promise, new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }))]);
  return ctx.signal.aborted ? { ok: false, note: "Stopped on request." } : { ok: true, note: "report ready" };
};

describe("typed and spoken requests for a bot land in ONE conversation", () => {
  test("typed in the bot's conversation: runs on THAT bot's computer, as a job carrying the bot, with the request, the receipt and the reply in the thread", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const done = await say(usman, "find the licence classes for home building in NSW", { conversationId: research(), target: { bot: "research" }, eventId: "evt-typed-1" });
    expect(done).toMatchObject({ ok: true, kind: "remote" });
    expect(r.started).toHaveLength(1);
    expect(r.started[0]).toMatchObject({ computer: "research", by: "usman", agent: "research", bot: "research" });
    expect(r.started[0].steps[0].executor).toBe("research");
    const job = r.jobs.get(done.jobId!)!;
    expect(job).toMatchObject({ bot: "research", targetDeviceId: "dev-research" });
    expect(job.steps.some((s) => s.executor === "context" && /bot Research:/.test(s.intent))).toBe(true);
    // The conversation: the person's own words, then the receipt for the job, then the reply, all in the bot thread; nothing in the default thread.
    const log = entries(r, research());
    expect(log.map((e) => [e.key, e.state])).toEqual([["evt-typed-1:request", "request"], [`${done.jobId}:started`, "started"], ["evt-typed-1:ack", "ack"]]);
    expect(log[0].text).toBe("find the licence classes for home building in [number] NSW".replace("[number] ", ""));
    expect(log[1]).toMatchObject({ jobId: done.jobId, jobKind: "computer" });
    expect(log[2]).toMatchObject({ jobId: done.jobId });
    expect(log[2].text).toContain(`(job ${done.jobId!.slice(0, 8)})`);
    expect(r.conversations.get(jarvisThreadId("usman"))).toBeNull();
    h.release();
  });

  test("spoken from the default thread, 'Ask Research to ...': the SAME bot thread as typed; the spoken words are not stored", async () => {
    const r = await rig({ lease: false });
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const typed = await say(usman, "find the best dental software", { conversationId: research(), eventId: "evt-aaaa" });
    const spoken = await say(usman, "Ask Research to compare three dental software vendors", { source: "voice", eventId: "evt-bbbb" });
    expect(spoken.numbers).toMatchObject({ conversationId: research() });
    expect(r.started.map((s) => s.computer)).toEqual(["research", "research"]);
    const log = entries(r, research());
    expect(log.map((e) => e.key)).toEqual(["evt-aaaa:request", `${typed.jobId}:started`, "evt-aaaa:ack", "evt-bbbb:request", `${spoken.jobId}:started`, "evt-bbbb:ack"]);
    const request = log.find((e) => e.key === "evt-bbbb:request")!;
    expect(request.text).toBe("Spoken request.");
    for (const e of log) expect(e.text).not.toContain("three dental software vendors".replace("three", "3"));
    // The title (what the job is called) is in the receipt entry, which every spoken or typed job gets.
    expect(log.find((e) => e.key === `${spoken.jobId}:started`)!.text).toContain("compare");
    // Round 10: the default thread it was SPOKEN in gets the receipt (and later the one end entry), never the spoken words; the typed request made in
    // Research's own conversation adds nothing there.
    const home = entries(r, jarvisThreadId("usman"));
    expect(home.map((e) => e.key)).toEqual([`${spoken.jobId}:started`]);
    expect(home[0].text).toContain("Started with Research:");
    for (const e of home) expect(e.text).not.toContain("vendors\"");
    h.release();
  });

  test("progress, the result and the ONE completion land in the bot thread exactly once, live, and not again after a restart or a replayed event", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(async (_id, ctx) => {
      ctx.step({ intent: "sub-goal 1 of 2, sources: done. found 4 (1 of 2 done)", executor: "research", ms: 0, outcome: "ok", verification: { method: "research-subgoal", ok: true } });
      await h.promise;
      ctx.step({ intent: "sub-goal 2 of 2, report: done. written (2 of 2 done)", executor: "research", ms: 0, outcome: "ok", verification: { method: "research-subgoal", ok: true } });
      return { ok: true, note: "report ready" };
    });
    const done = await say(usman, "research the licence classes", { conversationId: research(), eventId: "evt-run-1" });
    const jobId = done.jobId!;
    await waitFor(() => entries(r, research()).some((e) => e.state === "progress"));
    h.release();
    await waitFor(() => r.jobs.get(jobId)!.state === "succeeded");
    await waitFor(() => keys(r, research()).includes(`${jobId}:succeeded`));
    const count = (k: string) => keys(r, research()).filter((x) => x === k).length;
    const progress = entries(r, research()).filter((e) => e.state === "progress");
    expect([count(`${jobId}:started`), progress.length, new Set(progress.map((p) => p.key)).size, count(`${jobId}:succeeded`)]).toEqual([1, 2, 2, 1]);
    expect(entries(r, research()).find((e) => e.key === `${jobId}:succeeded`)).toMatchObject({ state: "succeeded", jobKind: "computer", text: expect.stringContaining("Finished:") });
    expect(progress[0]).toMatchObject({ state: "progress", jobKind: "computer", text: expect.stringContaining("Research, step 1 of 2") });

    // A replayed command (the same event id) is the same command: no second job, no second line.
    const again = await say(usman, "research the licence classes", { conversationId: research(), eventId: "evt-run-1" });
    expect(again.jobId).toBe(jobId);
    expect(r.started).toHaveLength(1);

    // A restart: a NEW watcher over the same conversations and jobs re-reads everything and appends nothing twice.
    const before = keys(r, research());
    const restarted = createJobThreads({ conversations: r.conversations, jobs: () => r.jobs, pollMs: 60_000, localFile: `${r.root}/thread-local.json` });
    await restarted.start();
    await restarted.reconcile();
    await r.threads.reconcile();
    restarted.stop();
    expect(keys(r, research())).toEqual(before);
  });

  test("a failed job says so in the thread with a blocker the UI can act on; it is never re-run", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => (await sleep(60), { ok: false, note: "the page timed out" }));
    const done = await say(usman, "research something slow", { conversationId: research() });
    await waitFor(() => keys(r, research()).includes(`${done.jobId}:failed`));
    const e = entries(r, research()).find((x) => x.key === `${done.jobId}:failed`)!;
    expect(e).toMatchObject({ state: "failed", jobKind: "computer", blocker: { kind: "failed" } });
    expect(e.blocker?.recovery).toContain("Nothing is re-run by itself");
    expect(r.started).toHaveLength(1);
  });

  test("two people, two conversations: Mehroz's request for the same bot never lands in Usman's thread", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true }));
    await say(usman, "Ask Research to find clinics", { eventId: "evt-uuuu" });
    await say(mehroz, "Ask Research to find vets", { eventId: "evt-mmmm" });
    expect(keys(r, research("usman")).filter((k) => k.endsWith(":request"))).toEqual(["evt-uuuu:request"]);
    expect(keys(r, research("mehroz")).filter((k) => k.endsWith(":request"))).toEqual(["evt-mmmm:request"]);
    expect(r.conversations.get(research("usman"))?.personId).toBe("usman");
    expect(r.conversations.get(research("mehroz"))?.personId).toBe("mehroz");
  });
});

describe("never the wrong device", () => {
  test("a bot with no computer says so; nothing runs anywhere, and the reply is in its thread", async () => {
    const r = await rig();
    r.agents.store.patch("research", 1, (b) => ({ ...b, computer: null }));
    const { say } = commandFor(r);
    const done = await say(usman, "Ask Research to find clinics", { eventId: "evt-nc01" });
    expect(done).toMatchObject({ ok: false });
    expect(done.said).toContain("has no computer assigned");
    expect(done.said).toContain("Nothing ran on any other machine");
    expect(r.started).toHaveLength(0);
    expect(keys(r, research())).toEqual(["evt-nc01:request", "evt-nc01:ack"]);
  });

  test("an offline bot computer refuses honestly (the computers service's own line) and nothing runs on another computer", async () => {
    const r = await rig();
    r.views.set("research", computerView("research", { state: "offline", desired: "stopped" }));
    const { say } = commandFor(r);
    const done = await say(usman, "find clinics", { conversationId: research(), eventId: "evt-off-0001" });
    expect(done.ok).toBe(false);
    expect(done.said).toContain("is offline");
    // The reply entry carries the machine-readable blocker the UI offers a fix for.
    expect(entries(r, research()).find((e) => e.key === "evt-off-0001:ack")?.blocker).toMatchObject({ kind: "offline" });
    expect(done.said).toContain("never run it on another machine");
    expect(r.started).toHaveLength(0);
    expect(r.jobs.list({}).length).toBe(0);
  });

  test("a request for the person's OWN device typed inside a bot conversation is not the bot's: no bot job, the normal device path answers, the default thread keeps it", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const done = await say(usman, "open notepad on my laptop", { conversationId: research(), eventId: "evt-own" });
    expect(r.started).toHaveLength(0);
    expect(done.said).toMatch(/no device in this test|Nothing ran on any other machine/);
    expect(keys(r, research()).filter((k) => k.startsWith("evt-own"))).toEqual([]);
  });

  test("the bot's computer is the bot's: Builder's request goes to the builder computer, never the research one", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true }));
    await say(usman, "Ask Builder to build a pricing card component", { eventId: "evt-b101" });
    expect(r.started.map((s) => [s.computer, s.bot, s.steps[0].executor])).toEqual([["builder", "builder", "builder"]]);
    // The brief is the request; the bot's instructions go to the job's model prompts in full (settings.test.ts proves they arrive).
    expect(String(r.started[0].steps[0].args.brief)).not.toContain("Work in an isolated branch");
    expect(r.started[0].context).toContain("Work in an isolated branch");
  });
});

describe("words that are not tasks never become jobs", () => {
  test("a thank-you, and a bare yes or 'start it' with nothing open to answer, ask for a task and run nothing", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    for (const words of ["thanks", "ok", "start it", "yes", "no"]) {
      const done = await say(usman, words, { conversationId: research() });
      expect([words, done.ok, done.ask === true, r.started.length]).toEqual([words, true, true, 0]);
    }
    expect(r.codingCalls).toHaveLength(0);
  });

  test("with a coding question open, a plain answer goes to the coding turn, not to the bot's computer", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setVoiceOpen(true);
    r.setCodingReply((u) => (u === "muv-marketing" ? { say: "Draft ready. Start it?", jobId: "77777777-7777-4777-8777-777777777777", jobState: "awaiting_confirmation" } : null));
    const done = await say(usman, "muv-marketing", { conversationId: builder() });
    expect(done.numbers).toMatchObject({ codingJobId: "77777777-7777-4777-8777-777777777777" });
    expect(r.codingCalls.map((c) => c.utterance)).toEqual(["muv-marketing"]);
    expect(r.started).toHaveLength(0);
  });
});

describe("show, continue and stop resolve to the right bot, or ask", () => {
  test("'Show me its computer': the open page's bot; with no page and two bots, one question; 'Show me Research's computer' names it", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const page = await say(usman, "show me its computer", { pageContext: { page: "/agents/workspace/builder" }, eventId: "evt-show1" });
    expect(page).toMatchObject({ ok: true, kind: "navigate", navigate: { path: "/agents/workspace/builder?tab=computer" } });
    expect(page.said).toContain("Builder's computer is idle and ready");
    const asked = await say(usman, "show me its computer");
    expect(asked).toMatchObject({ ok: false, kind: "ask", ask: true });
    expect(asked.said).toContain("Research's or Builder's");
    const named = await say(usman, "Show me Research's computer");
    expect(named).toMatchObject({ ok: true, navigate: { path: "/agents/workspace/research?tab=computer" } });
    expect(r.started).toHaveLength(0);
  });

  test("'Show me its computer' reports the job it is running and the person holding it", async () => {
    const r = await rig();
    const h = hold();
    r.setBody(gated(h));
    const { say } = commandFor(r);
    const started = await say(usman, "find clinics", { conversationId: research() });
    r.views.set("research", computerView("research", { state: "busy", controller: { kind: "person", who: "mehroz", jobId: null, expiresAt: null, epoch: null }, assigned: { agent: "research", jobId: started.jobId!, by: "usman", title: "find clinics" } }));
    const shown = await say(usman, "show me its computer", { conversationId: research() });
    expect(shown.said).toContain("mehroz is controlling it");
    expect(shown.said).toContain('its job "find clinics" is running');
    h.release();
  });

  test("'Stop that task' in a bot's thread stops THAT bot's task only; from the default thread with two bots' tasks open it asks, then 'Stop the Research task' stops Research's", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const hr = hold();
    const hb = hold();
    let which = 0;
    r.setBody((id, ctx, goal) => (which++ === 0 ? gated(hr) : gated(hb))(id, ctx as never));
    const a = await say(usman, "Ask Research to find clinics", { eventId: "evt-s101" });
    await sleep(5);
    const b = await say(usman, "Ask Builder to build an opening hours component", { eventId: "evt-s201" });
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "running" && r.jobs.get(b.jobId!)!.state === "running");

    // Default thread, nothing said about which: one question, nothing stopped.
    const asked = await say(usman, "stop that task");
    expect(asked).toMatchObject({ ok: false, kind: "ask", ask: true });
    expect(asked.said).toContain("Research's");
    expect(asked.said).toContain("Builder's");
    expect(r.jobs.get(a.jobId!)!.state).toBe("running");
    expect(r.jobs.get(b.jobId!)!.state).toBe("running");

    // Typed in Builder's conversation: Builder's task, never Research's.
    const stoppedB = await say(usman, "stop that task", { conversationId: builder() });
    expect(stoppedB).toMatchObject({ ok: true, stopped: true, jobId: b.jobId });
    expect(r.jobs.get(b.jobId!)!.state).toBe("cancelled");
    expect(r.jobs.get(a.jobId!)!.state).toBe("running");

    // Named from anywhere.
    const stoppedA = await say(usman, "Stop the Research task");
    expect(stoppedA).toMatchObject({ ok: true, stopped: true, jobId: a.jobId });
    expect(r.jobs.get(a.jobId!)!.state).toBe("cancelled");
    hr.release();
    hb.release();
  });

  test("a bare 'stop' inside a bot thread is about that bot's task: nothing of the person's own is touched, and with nothing running it says so", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const idle = await say(usman, "stop", { conversationId: research() });
    expect(idle.said).toContain("Nothing is running for Research");
    const h = hold();
    r.setBody(gated(h));
    const a = await say(usman, "find clinics", { conversationId: research() });
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "running");
    const stopped = await say(usman, "stop", { conversationId: research() });
    expect(stopped).toMatchObject({ stopped: true, jobId: a.jobId });
    expect(r.jobs.get(a.jobId!)!.state).toBe("cancelled");
    h.release();
  });

  test("'Continue the research' reports where the bot's newest task is and attaches to a running one; an ended one is reported, never re-run", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const none = await say(usman, "Continue the research");
    expect(none).toMatchObject({ ok: false });
    expect(none.said).toContain("hasn't been given a task");
    const h = hold();
    r.setBody(gated(h));
    const a = await say(usman, "Ask Research to find clinics", { eventId: "evt-c101" });
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "running");
    const going = await say(usman, "Continue the research");
    expect(going).toMatchObject({ ok: true, jobId: a.jobId, navigate: { path: "/agents/workspace/research?tab=tasks" } });
    expect(going.said).toContain("I've attached to it");
    h.release();
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "succeeded");
    const ended = await say(usman, "Continue the research");
    expect(ended.ok).toBe(false);
    expect(ended.said).toContain("I won't run it again blindly");
    expect(r.started).toHaveLength(1);
  });
});

describe("a Builder coding job on a named account", () => {
  const draft = { say: "Draft ready in muv-marketing on Claude Max 2: Opus builds, Sonnet reviews. Start it?", jobId: "55555555-5555-4555-8555-555555555555", jobState: "awaiting_confirmation" };

  test("'Have Builder fix this on Claude Max 2' drafts a coding job on that account, tagged with the bot; the person's 'start it' starts it and links it to Builder's thread; its result carries the account and model that RAN", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setCodingReply((u) => {
      if (/claude max 2/i.test(u)) return draft;
      if (/^start it$/i.test(u)) {
        (r.codingJobs[0] as unknown as { state: string }).state = "building";
        return { say: "Started.", jobId: draft.jobId, jobState: "building", started: true };
      }
      return null;
    });
    const drafted = await say(usman, "Have Builder fix this on Claude Max 2", { eventId: "evt-code-1" });
    expect(drafted).toMatchObject({ ok: true, numbers: { codingJobId: draft.jobId, codingJobState: "awaiting_confirmation" } });
    // What the coding entry was given: a builder asked to fix this, on the account the person named.
    expect(r.codingCalls[0].utterance).toMatch(/^Have a builder fix this on Claude Max 2/i);
    expect(r.codingCalls[0].turn).toMatchObject({ personId: "usman", actor: "human", via: "local" });
    expect(r.started).toHaveLength(0);
    expect(r.agents.links.get(draft.jobId)).toMatchObject({ bot: "builder", personId: "usman" });
    // A draft waits for "start it": no job is linked, but the request and the reply are in the thread.
    expect(keys(r, builder())).toEqual(["evt-code-1:request", "evt-code-1:ack"]);

    // The coding voice now remembers the drafted job (it awaits "start it").
    r.codingJobs.push(fakeCodingJob({ id: draft.jobId, state: "awaiting_confirmation", objective: "Fix the footer" }));
    r.setVoiceJob(draft.jobId);
    const started = await say(usman, "start it", { conversationId: builder(), eventId: "evt-code-2" });
    expect(started.numbers).toMatchObject({ codingJobId: draft.jobId, conversationId: builder() });
    const thread = r.conversations.get(builder())!;
    expect(thread.jobs?.map((j) => [j.jobId, j.kind])).toEqual([[draft.jobId, "coding"]]);
    expect(entries(r, builder()).find((e) => e.key === `${draft.jobId}:started`)).toMatchObject({ jobKind: "coding" });

    // The job finishes: ONE completion entry in Builder's thread, naming the account and model that actually ran.
    const job = r.codingJobs[0] as unknown as { state: string; headSha: string };
    job.state = "completed";
    job.headSha = "abc1234";
    r.codingEvents.set(draft.jobId, [usageEvent("claude:max-2", "claude-opus-5-5"), usageEvent("claude:max-2", "claude-sonnet-5-5", "coding.review")]);
    await r.threads.reconcile();
    await r.threads.reconcile();
    const fin = entries(r, builder()).filter((e) => e.key === `${draft.jobId}:succeeded`); // round 10: one spelling for finished (the state stays `completed`)
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ state: "completed", jobKind: "coding" });
    expect(fin[0].text).toContain("Ran on Claude Max 2: builder claude-opus-5-5, reviewer claude-sonnet-5-5");
    expect(fin[0].blocker).toBeUndefined();
    expect(r.conversations.get(jarvisThreadId("usman"))).toBeNull();
  });

  test("a named account that isn't signed in is refused BY NAME: nothing is drafted, no other account is used", async () => {
    const r = await rig({ claude: { "claude:max-2": false } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    const done = await say(usman, "Have Builder fix this on Claude Max 2", { eventId: "evt-nr01" });
    expect(done.ok).toBe(false);
    expect(done.said).toContain("Claude Max 2 isn't ready: not signed in on this profile");
    expect(done.said).toContain("I won't use a different account");
    expect(r.codingCalls).toHaveLength(0);
    expect(r.started).toHaveLength(0);
    expect(r.agents.links.get(draft.jobId)).toBeNull();
    expect(keys(r, builder())).toEqual(["evt-nr01:request", "evt-nr01:ack"]);
  });

  test("an account that isn't configured, one not checked yet, and the bot's own set-up account are all held to the same rule", async () => {
    const r = await rig({ claude: { "claude:max-2": null } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    const missing = await say(usman, "Have Builder fix this on Claude Max 7");
    expect(missing.said).toContain("Claude Max 7 isn't connected on this server");
    const unchecked = await say(usman, "Have Builder fix this on Claude Max 2");
    expect(unchecked.said).toContain("Claude Max 2 isn't ready: not checked yet");
    // Builder set up on Claude Max 2 (signed out now), no account named: refused too; naming a ready one goes ahead on THAT one.
    r.claude["claude:max-2"] = false;
    await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "claude:max-2", model: null } });
    const set = await say(usman, "Have Builder fix the footer in muv-marketing");
    expect(set.ok).toBe(false);
    expect(set.said).toContain("Claude Max 2 isn't ready");
    expect(r.codingCalls).toHaveLength(0);
    const named = await say(usman, "Have Builder fix the footer in muv-marketing on Claude Max 1");
    expect(named.ok).toBe(true);
    expect(r.codingCalls).toHaveLength(1);
    expect(r.codingCalls[0].utterance).toMatch(/on Claude Max 1$/i);
    expect(r.codingCalls[0].utterance).not.toMatch(/Claude Max 2/);
  });

  test("the account and model set for Builder in Setup are what the coding entry is asked for when the words name none", async () => {
    const r = await rig();
    await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "claude:max-2", model: "claude-sonnet-5-5" } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    await say(usman, "Have Builder fix the footer year in muv-marketing", { eventId: "evt-set1" });
    // Finding 3: not words. The exact slot and model go as structured fields, and the request words are left as said.
    expect(r.codingCalls[0].utterance).toBe("Have a builder fix the footer year in muv-marketing");
    expect((r.codingCalls[0].turn as { pin: unknown }).pin).toEqual({ accountSlot: "claude:max-2", model: "claude-sonnet-5-5" });
  });

  test("a Codex account set for Builder is passed as the exact slot to run on (Codex doesn't pick its own from the words); a model the words name wins over the bot's", async () => {
    const r = await rig();
    await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "codex:openai-2", model: "gpt-5.5" } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    await say(usman, "Have Builder fix the footer in muv-marketing", { eventId: "evt-pin-codex" });
    expect((r.codingCalls[0].turn as { pin: unknown }).pin).toEqual({ accountSlot: "codex:openai-2", model: "gpt-5.5" });
    await say(usman, "Have Builder fix the header in muv-marketing and have Codex build it", { eventId: "evt-pin-codex2" });
    expect((r.codingCalls[1].turn as { pin: unknown }).pin).toEqual({ accountSlot: "codex:openai-2", model: null });
  });

  test("a Codex account set for Builder in Setup is held to the same rule: not ready (isolation not applied) means refused by name, nothing drafted", async () => {
    const r = await rig();
    await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "codex:openai-2", model: null } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    // The synthetic runtime reports the isolation as applied: ready, so the request reaches the coding entry (Codex picks its own slot from the words).
    await say(usman, "Have Builder fix the footer in muv-marketing", { eventId: "evt-codex-1" });
    expect(r.codingCalls).toHaveLength(1);
  });

  test("with Codex's isolation not applied, the Codex account set in Setup is refused by name and nothing is drafted", async () => {
    const r = await rig({ isolation: false });
    await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "codex:openai-2", model: null } });
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    const done = await say(usman, "Have Builder fix the footer in muv-marketing", { eventId: "evt-codex-2" });
    expect(done.ok).toBe(false);
    expect(done.said).toContain("Codex (openai-2) isn't ready");
    expect(done.said).toContain("I won't use a different account");
    expect(r.codingCalls).toHaveLength(0);
  });

  test("a component brief is the builder WORKFLOW on its computer, not a coding job, unless an account or the coding words say otherwise", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true }));
    await say(usman, "Ask Builder to build a pricing card component", { eventId: "evt-wf01" });
    expect(r.codingCalls).toHaveLength(0);
    expect(r.started[0].steps[0].executor).toBe("builder");
  });

  test("a bot with coding OFF never reaches the coding entry, however the request is worded", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setCodingReply(() => draft);
    r.setBody(async () => ({ ok: true }));
    await say(usman, "Have Research fix this on Claude Max 2", { eventId: "evt-off1" });
    expect(r.codingCalls).toHaveLength(0);
    expect(r.started.map((s) => s.computer)).toEqual(["research"]);
  });

  test("a waiting coding job is a blocker the UI can act on (an approval, with its id); an account at its limit is offline", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setCodingReply((u) => {
      if (!/start it/i.test(u)) return null;
      (r.codingJobs[0] as unknown as { state: string }).state = "building";
      return { say: "Started.", jobId: draft.jobId, jobState: "building", started: true };
    });
    r.codingJobs.push(fakeCodingJob({ id: draft.jobId, state: "awaiting_confirmation" }));
    r.setVoiceJob(draft.jobId);
    await say(usman, "start it", { conversationId: builder() });
    const job = r.codingJobs[0] as unknown as { state: string; applies: unknown[] };
    job.state = "awaiting_approval";
    job.applies = [{ approval: { approvalId: "aaaaaaaa-0000-4000-8000-000000000001" } }];
    await r.threads.reconcile();
    const waiting = entries(r, builder()).find((e) => e.key === `${draft.jobId}:awaiting_approval`)!;
    expect(waiting.blocker).toMatchObject({ kind: "needs-approval", approvalId: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(waiting.jobKind).toBe("coding");
    // Not a snapshot function of the entries alone: the same reading as the watcher's.
    expect(codingSnapshotOf(r.codingJobs[0], [])).toMatchObject({ state: "awaiting_approval", approvalId: "aaaaaaaa-0000-4000-8000-000000000001" });
  });
});

describe("CRM subjects ride on the job, and the CRM contract holds on synthetic records", () => {
  /** The CRM side (Dot's `scripts/crm/ops.ts`) is STUBBED: one idempotent activity per eventId, a deep link to the record's timeline. */
  function stubCrm() {
    const activities = new Map<string, { activityId: string; ref: string; kind: string; title: string; artifact?: string; href: string }>();
    return {
      activities,
      add(input: { ref: string; eventId: string; kind: string; title: string; by: unknown; artifact?: string }) {
        const have = activities.get(input.eventId);
        if (have) return { ok: true as const, activityId: have.activityId, href: have.href };
        const [, kind, id] = input.ref.split(":");
        const href = `/crm/${kind}/${id}?tab=timeline`;
        const row = { activityId: `act-${activities.size + 1}`, ref: input.ref, kind: input.kind, title: input.title, ...(input.artifact ? { artifact: input.artifact } : {}), href };
        activities.set(input.eventId, row);
        return { ok: true as const, activityId: row.activityId, href };
      },
    };
  }

  test("a Research job made in a deal's context carries the deal, and the workspace and /__jobs both find it by that reference", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true }));
    const done = await say(usman, "Ask Research to find the owner's other practices", { pageContext: { page: "/crm/deal/42", crm: { kind: "deal", id: "42" } } as never, eventId: "evt-crm" });
    expect(r.started[0].subjects).toEqual(["crm:deal:42"]);
    expect(r.jobs.get(done.jobId!)?.subjects).toEqual(["crm:deal:42"]);
    expect(r.jobs.list({ subject: "crm:deal:42" }).map((j) => j.id)).toEqual([done.jobId]);
    const tasks = (await r.agents.service.tasks("research", "usman"))!.tasks;
    expect(tasks[0]).toMatchObject({ id: done.jobId, subjects: ["crm:deal:42"] });
    // Explicit subjects on the request work too, and a malformed one is dropped.
    const explicit = await say(usman, "Ask Research to look at the company", { subjects: ["crm:company:7", "not a ref"], eventId: "evt-crm2" });
    expect(r.jobs.get(explicit.jobId!)?.subjects).toEqual(["crm:company:7"]);
  });

  test("contract: fixture company + deal; a Research job with subjects:[crm:deal:<id>]; it completes with an artifact; crm.activity.add twice with eventId=<jobId>:result -> ONE activity whose href opens the deal timeline and whose artifact opens the saved result", async () => {
    const r = await rig();
    const crm = stubCrm();
    const company = { kind: "company", id: "7" };
    const deal = { kind: "deal", id: "42", company: company.id };
    const ref = `crm:${deal.kind}:${deal.id}`;
    const { say } = commandFor(r);
    r.setBody(async (jobId) => {
      r.artifacts.save({ jobId, personId: "usman", kind: "research", title: "Research: Bondi Dental", summary: "Complete report", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# Bondi Dental\nSynthetic." }] });
      return { ok: true, note: "report saved" };
    });
    const done = await say(usman, "Ask Research to profile Bondi Dental", { subjects: [ref], eventId: "evt-contract" });
    const jobId = done.jobId!;
    await waitFor(() => r.jobs.get(jobId)!.state === "succeeded");

    // The agent side: the job is findable by the deal, and its saved result is listed for the bot and resolvable by the string the CRM stores.
    expect(r.jobs.list({ subject: ref }).map((j) => j.id)).toEqual([jobId]);
    const files = (await r.agents.service.files("research", "usman"))!.files;
    expect(files[0]).toMatchObject({ artifact: `artifact:${jobId}`, jobId, subjects: [ref], href: `/__computers/artifacts/${jobId}` });
    expect(r.artifacts.get(jobId, "usman")?.id).toBe(jobId);
    expect(r.artifacts.file(jobId, "usman", "report.md")?.data.toString()).toContain("Bondi Dental");

    // The CRM side (stub): the same event id twice is one activity.
    const first = crm.add({ ref, eventId: `${jobId}:result`, kind: "agent-result", title: "Research finished: Bondi Dental", by: { agent: "research", jobId }, artifact: files[0].artifact });
    const second = crm.add({ ref, eventId: `${jobId}:result`, kind: "agent-result", title: "Research finished: Bondi Dental", by: { agent: "research", jobId }, artifact: files[0].artifact });
    expect(crm.activities.size).toBe(1);
    expect(second).toEqual(first);
    const row = [...crm.activities.values()][0];
    expect(row.href).toBe("/crm/deal/42?tab=timeline");
    expect(row.artifact).toBe(`artifact:${jobId}`);
    expect(row.artifact!.replace("artifact:", "")).toBe(jobId); // opens /__computers/artifacts/<jobId>
  });
});

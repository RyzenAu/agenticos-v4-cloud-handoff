// Open Dot V: one durable Jarvis conversation per person, job links + server-appended results, follow-ups about the right job, and a replayed
// utterance never runs twice. Real JobService (SQLite), real conversation store (JSON on disk), real command service; synthetic delegates only.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { conversationStore, jarvisThreadId } from "../conversations";
import { createCommandService, type Delegates } from "./service";
import { createJobThreads } from "./threads";
import { ATTACH_WINDOW_MS, classifyFollowUp, type ActiveJob } from "./followup";
import { requestContext } from "./linked-run";
import { parseCommandBody } from "./route";

const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function rig(options: { coding?: Delegates["coding"]; jobAgeMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-dot-v-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0, ...(options.jobAgeMs ? { now: () => Date.now() - options.jobAgeMs! } : {}) });
  const conversations = conversationStore(dir);
  let clock = 1_000_000;
  const now = () => clock;
  const codingStates = new Map<string, string>();
  const threads = createJobThreads({ conversations, jobs: () => jobs, now, pollMs: 60_000, coding: (id) => (codingStates.has(id) ? { state: codingStates.get(id)!, title: "fix the footer year", receipts: [{ account: "claude:max-2", model: "claude-sonnet-5", providerModel: "claude-sonnet-5-5", role: "builder" }, { account: "claude:max-2", model: "claude-opus-5-5", providerModel: "claude-opus-5-5", role: "reviewer" }], detail: "1 file changed. Tests passed. Review: approve." } : null) });
  void threads.start();
  cleanups.push(() => {
    threads.stop();
    try { jobs.close(); } catch { /* jobs still closing */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles close at GC on Windows */ }
  });
  /** Each started computer job waits on its own gate, checks the stop between steps, and records which steps ran. */
  const gates = new Map<string, () => void>();
  const ran: Record<string, string[]> = {};
  const started: string[] = [];
  const computers: NonNullable<Delegates["computers"]> = async (utterance, principal) => {
    if (!/\b(?:research|investigate|look up)\b/i.test(utterance)) return null;
    started.push(utterance);
    const title = utterance.replace(/^.*?\b(?:research|investigate|look up)\s+/i, "research ").slice(0, 60);
    const job = jobs.create({ kind: "control", principal: { personId: principal.personId, via: principal.via, actor: principal.actor } as never, targetDeviceId: "cloud-v-research", title });
    ran[job.id] = [];
    const gate = new Promise<void>((resolve) => gates.set(job.id, resolve));
    void jobs.run(job.id, async (ctx) => {
      for (const step of ["observe", "search", "summarise"]) {
        if (ctx.signal.aborted || ctx.cancelRequested()) return { ok: false, note: "Stopped on request." };
        if (step === "search") await Promise.race([gate, new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }))]);
        if (ctx.signal.aborted || ctx.cancelRequested()) return { ok: false, note: "Stopped on request." };
        ran[job.id].push(step);
        ctx.step({ intent: `${step} done`, executor: "companion", ms: 1, outcome: "ok" });
      }
      return { ok: true, note: `Researched: ${title.slice(7)}; 3 sources read` };
    });
    return { ok: true, said: `Started on research: ${utterance.slice(0, 120)}. It runs there whether or not your PC is on; say "show me the research computer" to follow it, or stop to cancel.`, jobId: job.id, deviceId: "cloud-v-research" };
  };
  const service = createCommandService({
    jobs: () => jobs, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "no device in this test" }),
    delegates: { computers, ...(options.coding ? { coding: options.coding } : {}) }, graceMs: 50, dedupeMs: 0, threads, now,
    deviceLabel: (id) => (id === "cloud-v-research" ? "v-research" : id),
  });
  const say = (principal: Principal, utterance: string, body: Record<string, unknown> = {}) => service.run({ principal, body: { utterance, source: "voice", ...body } as never });
  const finish = (jobId: string) => gates.get(jobId)?.();
  return { codingStates, dir, jobs, conversations, threads, service, say, finish, ran, started, advance: (ms: number) => void (clock += ms), tick: () => threads.reconcile() };
}

const job = (over: Partial<ActiveJob> & { jobId: string }): ActiveJob => ({ kind: "job", title: "research Bondi Dental", state: "running", lastReferencedAt: 1_000_000, ...over });

describe("attach rule (pure)", () => {
  const bondi = job({ jobId: "a", title: "research Bondi Dental", lastReferencedAt: 1_000_000 });
  const mount = job({ jobId: "b", title: "research Mount Druitt Physio", lastReferencedAt: 1_050_000 });
  const code = job({ jobId: "c", kind: "coding", title: "fix the footer year", state: "building", lastReferencedAt: 1_020_000 });
  const now = 1_060_000;

  test("status: one active job -> that job; several -> the most recently referenced; a tie -> one short question", () => {
    expect(classifyFollowUp("how's that going?", [bondi], now)).toEqual({ kind: "status", jobId: "a" });
    expect(classifyFollowUp("how's that going?", [bondi, mount], now)).toEqual({ kind: "status", jobId: "b" });
    const tie = classifyFollowUp("how's that going?", [bondi, { ...mount, lastReferencedAt: bondi.lastReferencedAt }], now);
    expect(tie.kind).toBe("ask");
    expect(tie.kind === "ask" && tie.question.length).toBeLessThan(120);
  });
  test("an explicit topical reference beats recency: 'the Bondi research' / 'the coding job'", () => {
    expect(classifyFollowUp("how is the Bondi research going", [bondi, mount], now)).toEqual({ kind: "status", jobId: "a" });
    expect(classifyFollowUp("how's the coding job going?", [bondi, mount, code], now)).toEqual({ kind: "status", jobId: "c" });
    expect(classifyFollowUp("what's the status of the research job", [bondi, mount], now).kind).toBe("status"); // both match "research": newest wins
  });
  test("a job that isn't his, or a topic with no job, is not answered as one", () => {
    expect(classifyFollowUp("how's the invoice job going?", [bondi, mount], now).kind).toBe("none");
    expect(classifyFollowUp("how's that going?", [], now).kind).toBe("none");
    // A question about something else is not a job's status just because one job is running.
    expect(classifyFollowUp("how's the market doing?", [bondi], now).kind).toBe("none");
    expect(classifyFollowUp("what's the status of the weather", [bondi], now).kind).toBe("none");
    expect(classifyFollowUp("cancel the 3pm meeting", [bondi], now).kind).toBe("none");
  });
  test("stop: 'stop that task' hits the most recently referenced; 'stop the coding job' the coding job; several + bare words ask", () => {
    expect(classifyFollowUp("stop that task", [bondi, mount], now)).toEqual({ kind: "cancel", jobId: "b" });
    expect(classifyFollowUp("cancel the coding job", [bondi, mount, code], now)).toEqual({ kind: "cancel", jobId: "c" });
    expect(classifyFollowUp("stop the music", [bondi], now).kind).toBe("none");
    expect(classifyFollowUp("stop that task", [{ ...bondi, state: "succeeded" }], now).kind).toBe("none"); // nothing open to stop
  });
  test("attach: explicit reference attaches; marker + topical match attaches; an additive marker pointing back (their/its) with one job attaches; new device action does not; several + no match asks", () => {
    expect(classifyFollowUp("for the Bondi research, also include their opening hours", [bondi, mount], now)).toEqual({ kind: "attach", jobId: "a", context: "also include their opening hours" });
    expect(classifyFollowUp("also check Mount Druitt reviews", [bondi, mount], now)).toMatchObject({ kind: "attach", jobId: "b" });
    expect(classifyFollowUp("also include their opening hours", [bondi], now)).toMatchObject({ kind: "attach", jobId: "a" });
    expect(classifyFollowUp("also open YouTube", [bondi], now).kind).toBe("none");
    expect(classifyFollowUp("also include their opening hours", [bondi, mount], now).kind).toBe("ask");
  });
  // Open Dot review C3: an unrelated command is a NEW command even when one job is running (never swallowed as context).
  test("unrelated commands with one open job are not attached (the reviewer's cases)", () => {
    for (const u of ["skip this song", "don't forget my 5pm meeting", "instead show my calendar", "but what's the weather", "ignore that notification", "make sure the door is locked", "include the invoice in my email", "open YouTube", "only 5 minutes", "actually play some music"])
      expect([u, classifyFollowUp(u, [bondi], now).kind]).toEqual([u, "none"]);
    // "stop it" about audio does not cancel a job nobody just mentioned.
    expect(classifyFollowUp("stop it", [{ ...bondi, kind: "job" as const, lastReferencedAt: now - ATTACH_WINDOW_MS - 1 }], now).kind).toBe("none");
  });
  test("attach still works when the words are about the job's own topic or reference it explicitly", () => {
    expect(classifyFollowUp("also include Bondi Dental opening hours", [bondi], now)).toMatchObject({ kind: "attach", jobId: "a" });
    expect(classifyFollowUp("add to that task: only dentists with parking", [bondi], now)).toMatchObject({ kind: "attach", jobId: "a" });
    expect(classifyFollowUp("add to the research job: also their phone numbers", [bondi, mount], now).kind).not.toBe("none");
    expect(classifyFollowUp("also include their opening hours", [bondi], now)).toMatchObject({ kind: "attach", jobId: "a" });
  });
  test("attach window: outside two minutes a marker is a new request; a plain new request is never attached", () => {
    expect(classifyFollowUp("also include their opening hours", [bondi], bondi.lastReferencedAt + ATTACH_WINDOW_MS + 1).kind).toBe("none");
    expect(classifyFollowUp("research the Newtown dentist", [bondi], now).kind).toBe("none");
    expect(classifyFollowUp("yes", [bondi], now).kind).toBe("none");
  });
});

describe("Jarvis thread store", () => {
  test("one deterministic thread per person; entries are idempotent, durable and merged into reads; a client save never clobbers or conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = conversationStore(dir);
    const a = store.ensureThread({ personId: "usman" })!;
    expect(a.id).toBe(jarvisThreadId("usman"));
    expect(store.ensureThread({ personId: "usman" })!.id).toBe(a.id);
    expect(jarvisThreadId("mehroz")).not.toBe(a.id);
    expect(store.ensureThread({ id: a.id, personId: "mehroz" })).toBeNull(); // someone else's thread is refused
    store.linkJob(a.id, { jobId: "j1", kind: "job", title: "research X", state: "running" });
    expect(store.appendEntry(a.id, { key: "j1:succeeded", jobId: "j1", state: "succeeded", text: "Finished: research X.", speak: "research X is finished." })).toMatchObject({ seq: 1 });
    expect(store.appendEntry(a.id, { key: "j1:succeeded", jobId: "j1", state: "succeeded", text: "again" })).toBeNull();
    // A tab saves its own messages with the revision it knew (0): no conflict, entries kept and shown after them.
    const saved = store.save({ id: a.id, revision: 0, title: "Jarvis", persona: "assistant", messages: [{ role: "user", text: "research X" }, { role: "oracle", text: "On it." }] });
    expect(saved.revision).toBe(1);
    expect(saved.messages.map((m) => m.text)).toEqual(["research X", "On it.", "Finished: research X."]);
    // A later save of what the tab was shown (the merged list) does not store the job entry as a message, nor duplicate it.
    const again = store.save({ id: a.id, revision: 1, title: "Jarvis", persona: "assistant", messages: [...saved.messages, { role: "user", text: "thanks" }] });
    expect(again.messages.map((m) => m.text)).toEqual(["research X", "On it.", "Finished: research X.", "thanks"]);
    expect(conversationStore(dir).get(a.id)!.jobs).toEqual([expect.objectContaining({ jobId: "j1", state: "succeeded" })]);
    // The client cannot rewrite who owns it or the jobs it links.
    store.save({ id: a.id, revision: again.revision, title: "Jarvis", persona: "assistant", messages: [{ role: "user", text: "x" }], personId: "mehroz", jobs: [] });
    expect(store.get(a.id)!.personId).toBe("usman");
    expect(store.get(a.id)!.jobs!.length).toBe(1);
    // A server append while a tab holds an old revision does not move the revision.
    const rev = store.get(a.id)!.revision;
    store.appendEntry(a.id, { key: "j1:note", jobId: "j1", state: "note", text: "n" });
    expect(store.get(a.id)!.revision).toBe(rev);
  });
});

describe("a started job is linked, receipted, and its result lands in the same conversation", () => {
  test("voice: short job-id acknowledgement; thread has the link, the started entry and the context; the real result is appended after the client is gone", async () => {
    const r = rig();
    const done = await r.say(usman, "research Harbourside Dental on the research computer", { pageContext: { page: "/leads", title: "Leads", focused: { kind: "lead", id: "12", label: "Harbourside Dental" }, capturedAt: 1_000_000, visible: [], sources: [] } });
    expect(done.ok).toBe(true);
    const id = done.jobId!;
    expect(done.said).toBe(`Started on research: research Harbourside Dental on the research computer. Job ${id.slice(0, 8)}.`);
    expect(done.said.length).toBeLessThan(130);
    const conv = r.conversations.get(jarvisThreadId("usman"))!;
    expect(conv.jobs).toEqual([expect.objectContaining({ jobId: id, kind: "job" })]);
    expect(conv.messages.map((m) => m.text)).toEqual([expect.stringContaining(`Started: research Harbourside Dental on the research com`)]);
    expect(conv.messages[0].text).toContain(`(job ${id.slice(0, 8)})`);
    // The job carries the request's constraints, page, selected record and target device.
    const ctx = r.jobs.get(id)!.steps.find((s) => s.executor === "context")!;
    expect(ctx.intent).toContain("Harbourside Dental");
    expect(ctx.intent).toContain("/leads");
    expect(ctx.intent).toContain("lead");
    expect(ctx.intent).toContain("v-research");
    // No client is attached any more (the stream/tab/mic is gone); the job finishes and the SERVER appends the result.
    r.finish(id);
    await waitFor(() => conversationStore(r.dir).get(jarvisThreadId("usman"))!.messages.length === 2);
    const after = conversationStore(r.dir).get(jarvisThreadId("usman"))!; // a fresh store instance: durable, not in-memory
    expect(after.messages[1].text).toMatch(/^Finished: research Harbourside Dental/);
    expect(after.messages[1].text).toContain("3 sources read");
    expect(after.entries![1]).toMatchObject({ state: "succeeded", speak: expect.stringMatching(/finished\.$/) });
    expect(r.jobs.get(id)!.state).toBe("succeeded");
    expect(after.jobs![0].state).toBe("succeeded");
  });

  test("typed carries the whole line plus the job id; a thread is per person: Mehroz sees none of Usman's jobs and cannot use his conversation id", async () => {
    const r = rig();
    const typed = await r.say(usman, "research Bondi Dental", { source: "typed" });
    expect(typed.said).toMatch(/\(job [0-9a-f]{8}\)$/);
    const other = await r.say(mehroz, "how's that going?");
    expect(other.said).not.toContain(typed.jobId!.slice(0, 8));
    const stolen = await r.say(mehroz, "research Newtown Physio", { conversationId: jarvisThreadId("usman") });
    expect(stolen.jobId).toBeTruthy();
    expect(r.conversations.get(jarvisThreadId("usman"))!.jobs!.length).toBe(1); // not linked into his thread
    expect(r.conversations.get(jarvisThreadId("mehroz"))!.jobs!.map((j) => j.jobId)).toEqual([stolen.jobId!]); // it went to HIS own thread instead
    r.finish(typed.jobId!);
    r.finish(stolen.jobId!);
  });

  test("a failed, stopped or unknown job says so in the thread (real state words), and a restart re-reads what landed while it was down", async () => {
    const r = rig();
    const a = await r.say(usman, "research Alpha Cafe");
    await r.say(usman, "stop that task");
    await waitFor(() => r.conversations.get(jarvisThreadId("usman"))!.messages.some((m) => /^Stopped: /.test(m.text)));
    expect(r.jobs.get(a.jobId!)!.state).toBe("cancelled");
    // A job that was open when the hub went down: the new process's watcher appends its terminal state once.
    const b = await r.say(usman, "research Beta Bakery");
    r.threads.stop();
    r.jobs.finish(b.jobId!, "unknown", "Interrupted at restart: not re-run");
    const revived = createJobThreads({ conversations: r.conversations, jobs: () => r.jobs, pollMs: 60_000 });
    cleanups.push(() => revived.stop());
    await revived.start();
    await revived.start();
    const texts = r.conversations.get(jarvisThreadId("usman"))!.messages.map((m) => m.text);
    expect(texts.filter((t) => t.startsWith("Ended without a confirmed outcome")).length).toBe(1);
    expect(texts.join(" ")).toContain("not re-run");
  });
});

describe("follow-ups about the current job", () => {
  test("'how's that going?' with two active jobs answers the most recently referenced; naming the other answers that one; it reads the REAL state", async () => {
    const r = rig();
    const a = await r.say(usman, "research Alpha Cafe");
    r.advance(5000);
    const b = await r.say(usman, "research Beta Bakery");
    r.advance(5000);
    const which = await r.say(usman, "how's that going?");
    expect(which.jobId).toBe(b.jobId!);
    expect(which.said).toContain("Beta Bakery");
    expect(which.said).toMatch(/is running|is queued/);
    r.advance(5000);
    const named = await r.say(usman, "how's the Alpha Cafe research going?");
    expect(named.jobId).toBe(a.jobId!);
    r.advance(5000);
    expect((await r.say(usman, "how's that going?")).jobId).toBe(a.jobId!); // referencing it made it the current one
    r.finish(a.jobId!);
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "succeeded");
    r.advance(1000);
    const finished = await r.say(usman, "how's the Alpha Cafe research going?");
    expect(finished.said).toMatch(/^Finished: research Alpha Cafe/);
    expect(r.started.length).toBe(2); // none of the follow-ups started a job
    r.finish(b.jobId!);
  });

  test("speaking again about the current job adds context to it instead of starting a new one", async () => {
    const r = rig();
    const a = await r.say(usman, "research Alpha Cafe");
    r.advance(10_000);
    const more = await r.say(usman, "also include their opening hours");
    expect(more.jobId).toBe(a.jobId!);
    expect(more.said).toMatch(/^Added to the/);
    expect(r.started.length).toBe(1);
    expect(r.jobs.get(a.jobId!)!.steps.map((s) => s.intent)).toContain("added context: include their opening hours");
    expect(r.conversations.get(jarvisThreadId("usman"))!.jobs![0].context).toEqual(["include their opening hours"]);
    r.advance(ATTACH_WINDOW_MS + 5000);
    const late = await r.say(usman, "also research Gamma Gym");
    expect(late.jobId).not.toBe(a.jobId!); // a new, separate request
    expect(r.started.length).toBe(2);
    r.finish(a.jobId!);
    r.finish(late.jobId!);
  });

  test("ambiguous: two jobs and no clear referent is one short question, and nothing is changed", async () => {
    const r = rig();
    await r.say(usman, "research Alpha Cafe");
    await r.say(usman, "research Beta Bakery"); // same clock: referenced at the same moment
    const ask = await r.say(usman, "how's that going?");
    expect(ask.ask).toBe(true);
    expect(ask.said.length).toBeLessThan(120);
    const attach = await r.say(usman, "also include their opening hours");
    expect(attach.ask).toBe(true);
    expect(r.started.length).toBe(2);
    const stopBoth = await r.say(usman, "stop");
    expect(stopBoth.ask).toBe(true);
    expect(r.jobs.list({ state: "cancelled" }).length).toBe(0);
    for (const j of r.jobs.list()) r.finish(j.id);
  });

  test("'stop that task' cancels through the existing cancel path and no later step executes; a bare 'stop' with one linked job stops it too", async () => {
    const r = rig();
    const a = await r.say(usman, "research Alpha Cafe");
    await waitFor(() => r.ran[a.jobId!].includes("observe"));
    const stop = await r.say(usman, "stop that task");
    expect(stop.said).toBe("Stopped it. Nothing further will run.");
    await waitFor(() => r.jobs.get(a.jobId!)!.state === "cancelled");
    r.finish(a.jobId!); // even if the gate opens afterwards
    await new Promise((res) => setTimeout(res, 100));
    expect(r.ran[a.jobId!]).toEqual(["observe"]);
    const b = await r.say(usman, "research Beta Bakery");
    const bare = await r.say(usman, "stop");
    expect(bare.jobId).toBe(b.jobId!);
    await waitFor(() => r.jobs.get(b.jobId!)!.state === "cancelled");
  });

  test("a coding job is followed through the coding store and stopped through the coding delegate's own stop", async () => {
    const stops: string[] = [];
    const codingId = "99999999-8888-4777-8666-555555555555";
    const r = rig({ coding: async (utterance) => (/assign a builder/i.test(utterance) ? { say: "Started the build.", jobId: codingId, jobState: "building" } : /stop the coding job/i.test(utterance) ? (stops.push(utterance), { say: "Stopped the coding job." }) : null) });
    r.codingStates.set(codingId, "building");
    const started = await r.say(usman, "assign a builder to fix the footer year", { source: "typed" });
    expect(started.numbers).toMatchObject({ codingJobId: codingId });
    expect(r.conversations.get(jarvisThreadId("usman"))!.jobs).toEqual([expect.objectContaining({ jobId: codingId, kind: "coding", state: "building" })]);
    const stop = await r.say(usman, "stop that task");
    expect(stops).toEqual(["stop the coding job"]);
    expect(stop.said).toBe("Stopped the coding job.");
    // The coding store later says it finished: the result lands in the conversation with the account and the model that actually answered.
    r.codingStates.set(codingId, "completed");
    await r.tick();
    const text = r.conversations.get(jarvisThreadId("usman"))!.messages.at(-1)!.text;
    expect(text).toMatch(/^Finished: fix the footer year/);
    expect(text).toContain("Ran on Claude Max 2: builder claude-sonnet-5-5, reviewer claude-opus-5-5.");
    expect(text).toContain("1 file changed. Tests passed. Review: approve.");
  });
});

describe("a replayed utterance after a reconnect never creates a second job or repeats the action", () => {
  test("the same event id from the same person returns the first outcome; a different id is a new command; another person's same id is theirs", async () => {
    const r = rig();
    const first = await r.say(usman, "research Alpha Cafe", { eventId: "utt-1700000000-1" });
    // The voice channel dropped and reconnected: the client replays the same utterance event, twice, even after the job finished.
    const replay = await r.say(usman, "research Alpha Cafe", { eventId: "utt-1700000000-1" });
    r.finish(first.jobId!);
    await waitFor(() => r.jobs.get(first.jobId!)!.state === "succeeded");
    r.advance(60_000);
    const late = await r.say(usman, "research Alpha Cafe", { eventId: "utt-1700000000-1" });
    expect(replay.jobId).toBe(first.jobId!);
    expect(late.jobId).toBe(first.jobId!);
    expect(late.said).toBe(first.said);
    expect(r.started.length).toBe(1);
    expect(r.jobs.list().length).toBe(1);
    const fresh = await r.say(usman, "research Alpha Cafe", { eventId: "utt-1700000000-2" });
    expect(fresh.jobId).not.toBe(first.jobId!);
    const theirs = await r.say(mehroz, "research Alpha Cafe", { eventId: "utt-1700000000-1" });
    expect(theirs.jobId).not.toBe(first.jobId!);
    expect(r.started.length).toBe(3);
    r.finish(fresh.jobId!);
    r.finish(theirs.jobId!);
  });
  test("concurrent replays (the reconnect resends while the first is still in flight) share the one run", async () => {
    const r = rig();
    const [x, y] = await Promise.all([r.say(usman, "research Alpha Cafe", { eventId: "utt-same-0001" }), r.say(usman, "research Alpha Cafe", { eventId: "utt-same-0001" })]);
    expect(x.jobId).toBe(y.jobId);
    expect(r.started.length).toBe(1);
    r.finish(x.jobId!);
  });
});

describe("contract helpers", () => {
  test("the wire body keeps only a valid conversation id and event id", () => {
    const good = parseCommandBody({ utterance: "hi", conversationId: jarvisThreadId("usman"), eventId: "utt-abc-0001" });
    expect(good.conversationId).toBe(jarvisThreadId("usman"));
    expect(good.eventId).toBe("utt-abc-0001");
    const bad = parseCommandBody({ utterance: "hi", conversationId: "../etc", eventId: "no spaces allowed" });
    expect(bad.conversationId).toBeUndefined();
    expect(bad.eventId).toBeUndefined();
  });
  test("requestContext is one masked line with the words, page, selection and device", () => {
    const line = requestContext({ utterance: "research Harbourside Dental, only the Sydney branch", pageContext: { page: "/leads", selected: [{ kind: "lead", id: "12", label: "Harbourside" }], capturedAt: 1, visible: [], sources: [] } as never, deviceLabel: "v-research", account: "Claude Max 2" });
    expect(line).toContain("only the Sydney branch");
    expect(line).toContain("/leads");
    expect(line).toContain("lead \"Harbourside\"");
    expect(line).toContain("v-research");
    expect(line).toContain("Claude Max 2");
    expect(line.length).toBeLessThanOrEqual(280);
  });
});

describe("context added to a running computer job reaches its goal loop", () => {
  test("the next decision's question carries what was added; without it, it does not", async () => {
    const { runGoalLoop } = await import("../computers/goal-loop");
    const run = async (extra: string[]) => {
      const bodies: string[] = [];
      await runGoalLoop({
        goal: "research Bondi Dental",
        extraContext: () => extra,
        ask: (async (body: unknown) => (bodies.push(JSON.stringify(body)), null)) as never,
        io: { signal: new AbortController().signal, step: () => undefined, boundary: async () => "go", observe: async () => ({ ok: true, obs: { title: "T", url: "https://example.com/", viewport: { w: 1, h: 1 }, elements: [] } }), act: async () => ({ kind: "done", said: "", verified: null }) } as never,
      });
      return bodies.join("|");
    };
    expect(await run(["include their opening hours"])).toContain("opening hours");
    expect(await run([])).not.toContain("opening hours");
  });
});

describe("the voice client's event identity", () => {
  test("the same event (early + final call, or a replay after a reconnect) shares one id; another turn or other words do not", async () => {
    const { utteranceEventId } = await import("../../src/lib/voice-turns");
    const a = utteranceEventId("n1", "u4", "jarvis_command", { utterance: "research Alpha Cafe" });
    expect(utteranceEventId("n1", "u4", "jarvis_command", { utterance: "research Alpha Cafe" })).toBe(a);
    expect(utteranceEventId("n1", "u5", "jarvis_command", { utterance: "research Alpha Cafe" })).not.toBe(a);
    expect(utteranceEventId("n1", "u4", "jarvis_command", { utterance: "research Beta Bakery" })).not.toBe(a);
    expect(a).toMatch(/^[\w:.-]{6,80}$/);
  });
  test("runJarvisCommand sends the id (given or minted) with the body; a replay with the same id is the same command on the server", async () => {
    const { runJarvisCommand } = await import("../../src/lib/jarvis-command");
    const r = rig();
    const bodies: Array<{ eventId?: string; utterance: string }> = [];
    const post = async (_path: string, body: unknown) => {
      bodies.push(body as never);
      const done = await r.service.run({ principal: usman, body: { ...(body as object), source: "voice" } as never });
      return new Response(`${JSON.stringify(done)}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
    };
    const first = await runJarvisCommand({ utterance: "research Alpha Cafe", source: "voice", pageContext: null, eventId: "utt-abcd12-u7-xyz", post: post as never });
    // The voice channel dropped and came back; the same utterance event is sent again.
    const again = await runJarvisCommand({ utterance: "research Alpha Cafe", source: "voice", pageContext: null, eventId: "utt-abcd12-u7-xyz", post: post as never });
    expect(bodies.map((b) => b.eventId)).toEqual(["utt-abcd12-u7-xyz", "utt-abcd12-u7-xyz"]);
    expect(again.jobId).toBe(first.jobId);
    expect(r.started.length).toBe(1);
    const minted = await runJarvisCommand({ utterance: "research Beta Bakery", source: "typed", pageContext: null, post: post as never });
    expect(bodies.at(-1)!.eventId).toMatch(/^cmd-[\w]+-[\w]+$/);
    expect(minted.jobId).not.toBe(first.jobId);
    r.finish(first.jobId!);
    r.finish(minted.jobId!);
  });
});

describe("a coding job's snapshot for the thread", () => {
  test("receipts name the account and the model that actually answered, per role; the result is a few words from the job record", async () => {
    const { codingSnapshotOf } = await import("./coding-snapshot");
    const job = { state: "completed", spec: { objective: "Add farewell()" }, diff: { files: [{ path: "src/greet.ts" }] }, tests: [{ exitCode: 0 }], review: { verdict: "approve" }, gate: { passed: true } } as never;
    const events = [
      { type: "usage", payload: { task: "coding.build", account: "claude:max-2", model: "claude-sonnet-5", providerModel: "claude-sonnet-5-5" } },
      { type: "usage", payload: { task: "coding.review", account: "claude:max-2", model: "claude-opus-5-5", providerModel: null } },
      { type: "step", payload: {} },
    ] as never;
    const snap = codingSnapshotOf(job, events);
    expect(snap.receipts).toEqual([
      { account: "claude:max-2", model: "claude-sonnet-5", providerModel: "claude-sonnet-5-5", role: "builder" },
      { account: "claude:max-2", model: "claude-opus-5-5", providerModel: null, role: "reviewer" },
    ]);
    expect(snap.detail).toBe("1 file changed. Tests passed. Review: approve. Done gate passed.");
  });
});

describe("a job the command only brought up is followed, not claimed as started", () => {
  test("an older job returned by the command (\"show me the computer\") is linked as 'Following', with no context step and the reply left as it was", async () => {
    const r = rig({ jobAgeMs: 120_000 });
    const done = await r.say(usman, "research Alpha Cafe");
    expect(done.said).not.toMatch(/Job [0-9a-f]{8}.$/);
    const conv = r.conversations.get(jarvisThreadId("usman"))!;
    expect(conv.messages[0].text).toMatch(/^Following: research Alpha Cafe/);
    expect(r.jobs.get(done.jobId!)!.steps.some((s) => s.executor === "context")).toBe(false);
    r.finish(done.jobId!);
  });
});

// Open Dot review C7: titles, notes and context stored in the conversation pass the job log's masking.
describe("thread text is masked before it is stored", () => {
  test("a coding link's title, the started entry and added context never carry numbers, e-mails or secrets", async () => {
    const r = rig();
    const linked = await r.threads.link({ personId: "usman", jobId: "11111111-1111-4111-8111-111111111111", kind: "coding", title: "email a.b@client.com the invoice 123456789 with PIN 4821" });
    expect(linked).not.toBeNull();
    r.threads.touch(linked!.conversationId, "11111111-1111-4111-8111-111111111111", { addContext: "also call 0412 345 678, password: hunter2" });
    const c = r.conversations.get(linked!.conversationId)!;
    const stored = JSON.stringify(c);
    for (const secret of ["a.b@client.com", "123456789", "4821", "0412 345 678", "hunter2"]) expect(stored).not.toContain(secret);
    expect(c.jobs![0].title).toContain("[number]");
  });
});

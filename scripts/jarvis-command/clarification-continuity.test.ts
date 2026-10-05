// Real durable command/conversation/job boundary; all models and executors are synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, jarvisThreadId, botThreadId } from "../conversations";
import type { CommandInput } from "../devices/dispatch";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { createJobThreads } from "./threads";
import { createCommandService, type CommandServiceDeps } from "./service";
import { namedBot } from "../agents/named";
import { CLARIFICATION_TTL_MS } from "./clarification";

const OWNER: Principal = { personId: "usman", actor: "human", via: "paired-session", displayName: "Synthetic founder" };
const OTHER: Principal = { ...OWNER, personId: "mehroz" };
const ORIGINAL = 'research the opening year of the Sydney Opera House, with sources';
const CONVERSATION = jarvisThreadId("usman");
const SECOND = "11111111-2222-4333-8444-555555555555";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(c => c()));
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() > deadline) throw Error("synthetic gate did not open"); await new Promise(resolve => setTimeout(resolve, 1)); }
}


function rig(lane: "bot" | "coding" | "brain" | "device.open" = "bot") {
  const root = mkdtempSync(join(tmpdir(), "clarification-continuity-"));
  let now = Date.now();
  let jobs: JobService;
  let threads: ReturnType<typeof createJobThreads>;
  let store: ReturnType<typeof conversationStore>;
  let service: ReturnType<typeof createCommandService>;
  const asked: any[] = [], executed: any[] = [];
  let sequence = 0, confidence = 0.46, device = "synthetic-device-a", availablePin = true, outage = false, allWritesFail = false;
  let saveFailure: "begin" | "question" | null = null;
  let beforeDecision: (() => Promise<void>) | null = null;
  let beforeBot: (() => Promise<void>) | null = null;
  const make = () => {
    jobs = new JobService({ path: join(root, "jobs.sqlite"), snapshotMs: 0 });
    store = conversationStore(root);
    const begin = store.beginRoutingTurn, save = store.saveRoutingQuestion;
    store.beginRoutingTurn = (...args) => { if (saveFailure === "begin") throw Error("synthetic persistence failure"); return begin(...args); };
    store.saveRoutingQuestion = (...args) => { if (saveFailure === "question") throw Error("synthetic persistence failure"); return save(...args); };
    const append = store.appendEntry, touch = store.touchJob;
    store.appendEntry = (...args) => { if (allWritesFail) throw Error("synthetic transcript write failure"); return append(...args); };
    store.touchJob = (...args) => { if (allWritesFail) throw Error("synthetic transcript write failure"); return touch(...args); };
    threads = createJobThreads({ conversations: store, jobs: () => jobs, now: () => now, pollMs: 60_000 });
    service = createCommandService({
      jobs: () => jobs, threads, now: () => now, entry: () => null, hubDeviceId: "", dedupeMs: 0,
      resolveTarget: () => ({ ok: true, deviceId: device, owner: "usman", reason: "synthetic" } as never),
      supports: () => true,
      dispatcher: { submit: async (call: CommandInput) => { executed.push({ dispatch: call }); return { ok: true, local: false, deviceId: device, commandId: "synthetic-command", result: { ok: true, said: "Synthetic opened.", verified: true } }; } } as never,
      controller: {
        key: () => "synthetic", cache: null,
        decide: (async (call: any) => {
          const certainty = confidence;
          asked.push({ state: call.state, questions: call.questions });
          await beforeDecision?.();
          if (outage) return { ok: false, reason: "timeout", httpStatus: null, ms: 1, receipt: null };
          return { ok: true, answers: { lane: { choice: lane, confidence: certainty }, bot: { choice: "research", confidence: 0.95 }, bot_lane: { choice: "computer", confidence: 0.95 }, multi: { noul: 0 }, outbound: { noul: 0 } }, ms: 1, receipt: null, httpStatus: 200, raw: null, attempts: 1 };
        }) as never,
      },
      bots: {
        nameOf: id => id === "research" ? "Research" : id,
        threadIds: person => [botThreadId(person, "research")],
        list: () => [{ id: "research", name: "Research", purpose: "Research with sources" }],
        scope: ({ principal, utterance, body }) => {
          const named = namedBot(utterance, [{ id: "research", name: "Research" }]);
          if (!named && body.target?.bot !== "research" && body.conversationId !== botThreadId(principal.personId, "research")) return null;
          return { kind: "bot", bot: { id: "research", name: "Research" }, utterance: named?.kind === "stop" ? "stop that task" : named?.kind === "task" ? named.task : utterance, conversationId: botThreadId(principal.personId, "research"), via: named ? "words" : "target", subjects: body.subjects ?? [] };
        },
        run: async input => {
          await beforeBot?.();
          executed.push(input);
          const job = jobs.create({ kind: "control", principal: { personId: input.principal.personId, actor: input.principal.actor, via: input.principal.via } as never, targetDeviceId: "synthetic-research", title: input.utterance, bot: "research" } as never);
          return { ok: true, started: true, said: "Synthetic task admitted.", jobId: job.id, deviceId: "synthetic-research" };
        },
      },
      delegates: { crm: async intent => { executed.push({ crm: intent }); return { ok: true, said: "Synthetic CRM mutation.", verified: true }; }, coding: async (utterance, turn) => { executed.push({ utterance, turn }); return { say: "Synthetic draft only.", jobId: "synthetic-coding-draft", jobState: "draft", drafted: true }; } },
      pinCatalogue: () => ({ claude: availablePin ? [{ slot: "claude:max-2", label: "Claude Max 2" }] : [], codex: [] }),
    });
  };
  make();
  cleanups.push(() => { threads.stop(); jobs.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, asked, executed, now: () => now,
    jobs: () => jobs, store: () => store, service: () => service,
    advance(ms: number) { now += ms; },
    confident() { confidence = 0.95; }, uncertain() { confidence = 0.46; },
    outage() { outage = true; },
    failAllTranscriptWrites() { saveFailure = "begin"; allWritesFail = true; },
    moveDevice() { device = "synthetic-device-b"; }, removePin() { availablePin = false; },
    fail(when: typeof saveFailure) { saveFailure = when; },
    holdDecision(fn: typeof beforeDecision) { beforeDecision = fn; }, holdBot(fn: typeof beforeBot) { beforeBot = fn; },
    restart() { threads.stop(); jobs.close(); make(); },
    say(utterance: string, extra: Record<string, unknown> = {}, principal = OWNER) {
      return service.run({ principal, body: { utterance, source: "typed", eventId: `clarification-test-${++sequence}`, conversationId: CONVERSATION, pageContext: { page: "/jarvis", capturedAt: now }, ...extra } as never });
    },
  };
}

describe("original request continuity through a routing question", () => {
  test("live Sydney request survives a 126-second answer and full service recreation", async () => {
    const r = rig();
    const first = await r.say(ORIGINAL, { eventId: "original-research-event" });
    expect(first).toMatchObject({ ask: true, kind: "ask", decision: { op: "jev.ask", confidence: 0.46 } });
    expect(r.executed).toHaveLength(0);
    r.advance(126_474); r.restart(); r.confident();
    const reply = await r.say("Research", { eventId: "research-answer-event", pageContext: { page: "/crm", capturedAt: r.now() } });
    expect(reply.ok).toBe(true); expect(r.executed).toHaveLength(1);
    expect(r.executed[0].utterance).toBe(ORIGINAL); expect(r.executed[0].principal).toEqual(OWNER);
    expect(r.asked.at(-1).state.utterance).toBe(ORIGINAL);
    expect(Object.keys(r.asked.at(-1).questions.lane.criteria)).toEqual(["bot", "ask"]);
    expect(r.asked.at(-1).state.clarifiedRoute).toBe("bot:research");
    expect(reply.numbers?.clarification).toMatchObject({ originalEventId: "original-research-event", answerEventId: "research-answer-event", askJobId: first.jobId });
    expect(r.store().get(CONVERSATION)?.jobs?.some(j => j.jobId === reply.jobId)).toBe(true);
    expect(r.store().get(botThreadId("usman", "research"))?.jobs?.some(j => j.jobId === reply.jobId)).toBe(true);
  });
  test("coding answer retains exact task, account/model pin and only offered coding lane", async () => {
    const r = rig("coding");
    const original = 'Fix the login bug in the dental site using Opus on Claude Max 2';
    expect((await r.say(original)).ask).toBe(true);
    r.restart(); r.confident();
    await r.say("a coding job");
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0]).toMatchObject({ utterance: original, turn: { pin: { accountSlot: "claude:max-2", model: "claude-opus-5-5" } } });
    expect(Object.keys(r.asked.at(-1).questions.lane.criteria)).toEqual(["coding", "ask"]);
  });
  test("model/account disappearance refuses without substitution", async () => {
    const r = rig("coding");
    await r.say("Fix the login bug using Opus on Claude Max 2");
    r.removePin(); r.confident();
    expect((await r.say("coding")).refused).toBe(true);
    expect(r.executed).toHaveLength(0);
  });
  test("the originally offered own device cannot silently switch", async () => {
    const r = rig("device.open");
    await r.say("open https://example.com on my PC");
    r.moveDevice(); r.confident();
    const answer = await r.say("on my PC");
    expect(answer.refused).toBe(true); expect(answer.said).toContain("another computer"); expect(r.executed).toHaveLength(0);
  });
  test("another founder or conversation cannot consume the question", async () => {
    const r = rig();
    await r.say(ORIGINAL);
    const other = await r.say("Research", { conversationId: jarvisThreadId("mehroz") }, OTHER);
    const second = await r.say("Research", { conversationId: SECOND });
    expect(other.said).not.toContain("Sydney"); expect(second.said).not.toContain("Sydney");
    expect(r.executed).toHaveLength(0);
    r.confident(); await r.say("Research");
    expect(r.executed[0].utterance).toBe(ORIGINAL);
  });
  test("same-event reply and restart replay never dispatch twice", async () => {
    const r = rig(); await r.say(ORIGINAL); r.confident();
    const extra = { eventId: "same-reply-event", pageContext: undefined };
    const [first, second] = await Promise.all([r.say("Research", extra), r.say("Research", extra)]);
    expect(first.jobId).toBe(second.jobId); expect(r.executed).toHaveLength(1);
    r.restart(); const replay = await r.say("Research", extra);
    expect(replay.numbers?.replayed).toBe(true); expect(replay.jobId).toBe(first.jobId); expect(r.executed).toHaveLength(1);
  });
  test("two distinct concurrent answers consume once", async () => {
    const r = rig(); await r.say(ORIGINAL); r.confident();
    await Promise.all([r.say("Research", { eventId: "answer-first" }), r.say("Research", { eventId: "answer-second" })]);
    expect(r.executed).toHaveLength(1);
  });
  test("cancel and expiry never become a task about a lane name", async () => {
    const cancelled = rig(); await cancelled.say(ORIGINAL); cancelled.restart();
    expect((await cancelled.say("cancel")).stopped).toBe(true);
    cancelled.confident(); expect((await cancelled.say("Research")).ok).toBe(false); expect(cancelled.executed).toHaveLength(0);
    const expired = rig(); await expired.say(ORIGINAL); expired.advance(CLARIFICATION_TTL_MS + 1); expired.restart(); expired.confident();
    expect((await expired.say("Research")).said).toContain("expired"); expect(expired.executed).toHaveLength(0);
  });
  test("added task text is preserved as a new request", async () => {
    const r = rig(); await r.say(ORIGINAL); r.confident();
    await r.say("Research Tokyo instead, with sources");
    expect(r.executed[0].utterance).toBe("Research Tokyo instead, with sources");
  });
  test("reply execution metadata cannot silently replace or add to the original task", async () => {
    for (const extra of [{ target: { bot: "builder" } }, { spokenTarget: "another computer" }, { subjects: ["crm:deal:other"] }, { steps: [{ executor: "open-url", args: { url: "https://example.com" } }] }]) {
      const r = rig(); await r.say(ORIGINAL); r.confident();
      expect((await r.say("Research", extra)).refused).toBe(true); expect(r.executed).toHaveLength(0);
    }
  });
  test("storage failures prevent dispatch and do not pretend a resumable question exists", async () => {
    const r = rig(); r.fail("question");
    expect((await r.say(ORIGINAL)).kind).toBe("unavailable"); expect(r.executed).toHaveLength(0);
    r.fail(null); await r.say(ORIGINAL); r.confident(); r.fail("begin");
    expect((await r.say("Research")).kind).toBe("unavailable"); expect(r.executed).toHaveLength(0);
  });
  test("a delayed old router ask cannot resurrect after a newer request", async () => {
    const r = rig(); let release!: () => void;
    r.holdDecision(() => new Promise<void>(resolve => { release = resolve; }));
    const old = r.say(ORIGINAL);
    await waitFor(() => !!release);
    r.holdDecision(null); r.confident(); await r.say("research Tokyo");
    release(); expect((await old).kind).toBe("unavailable");
    const next = await r.say("Research");
    expect(r.executed.every(x => x.utterance !== ORIGINAL)).toBe(true);
    expect(next.numbers?.clarification).toBeUndefined();
  });
  test("conversation reads hide the slot and client snapshots cannot alter it", async () => {
    const r = rig(); await r.say(ORIGINAL);
    const view = r.store().get(CONVERSATION)!;
    expect((view as any).routingClarification).toBeUndefined();
    const saved = r.store().save({ ...view, routingClarification: { generation: "forged", record: null } } as never);
    expect((saved as any).routingClarification).toBeUndefined();
    r.restart(); r.confident(); await r.say("Research"); expect(r.executed[0].utterance).toBe(ORIGINAL);
  });
});


test("the target cannot change during the resumed routing await", async () => {
  const r = rig("device.open"); await r.say("open https://example.com on my PC"); r.confident();
  let release!: () => void;
  r.holdDecision(() => new Promise<void>(resolve => { release = resolve; }));
  const answer = r.say("on my PC");
  await waitFor(() => !!release);
  r.moveDevice(); release();
  const result = await answer;
  expect(result.ok).toBe(false); expect(result.said).toContain("another computer"); expect(r.executed).toHaveLength(0);
});

test("remembered voice context is snapshotted before another conversation changes it", async () => {
  const r = rig("brain");
  const item = (id: string) => ({ page: "/leads", capturedAt: r.now(), focused: { kind: "lead", id, label: `Synthetic ${id}`, data: { marker: id } } });
  await r.say("explain this lead", { source: "voice", pageContext: item("A") });
  const question = await r.say("explain this lead", { source: "voice", pageContext: undefined });
  expect(question.ask).toBe(true);
  r.confident(); await r.say("explain this lead", { source: "voice", conversationId: SECOND, pageContext: item("B") });
  const answer = await r.say("an answer from you", { source: "voice", pageContext: undefined });
  expect(r.asked.at(-1).state.record).toBe("lead:A");
  expect(answer.handoff?.utterance).toContain("Synthetic A");
  expect(answer.handoff?.utterance).not.toContain("Synthetic B");
  await r.say("explain this lead", { source: "voice", pageContext: undefined });
  expect(r.asked.at(-1).state.record).toBe("lead:B");
});


test("unconfirmed same-founder process cannot consume or supersede human clarification", async () => {
  const r = rig(); await r.say(ORIGINAL);
  const process: Principal = { ...OWNER, actor: "process", via: "tailnet-person" };
  await r.say("Research", {}, process);
  await r.say("different new request", {}, process);
  r.confident(); const result = await r.say("Research");
  expect(result.ok).toBe(true); expect(r.executed).toHaveLength(1); expect(r.executed[0].utterance).toBe(ORIGINAL);
});


test("conflicting answer metadata preserves the pending request for a corrected answer", async () => {
  const r = rig(); await r.say(ORIGINAL); r.confident();
  expect((await r.say("Research", { target: { bot: "builder" } })).refused).toBe(true);
  expect(r.executed).toHaveLength(0);
  expect((await r.say("Research")).ok).toBe(true);
  expect(r.executed[0].utterance).toBe(ORIGINAL);
});

test("a device choice cannot use a CRM write fallback during a router outage", async () => {
  const r = rig("device.open");
  expect((await r.say("add a note to the Harbour website deal: synthetic text")).ask).toBe(true);
  r.outage();
  const answer = await r.say("my computer");
  expect(answer.kind).toBe("unavailable"); expect(r.executed).toHaveLength(0);
});

test("a restored include request does not attach itself to a newer matching job", async () => {
  const r = rig(); const original = "include a bibliography about Sydney architecture";
  expect((await r.say(original)).ask).toBe(true);
  r.confident(); await r.say("research a bibliography about Sydney architecture", { conversationId: SECOND });
  const answer = await r.say("Research");
  expect(answer.ok).toBe(true); expect(r.executed).toHaveLength(2); expect(r.executed[1].utterance).toBe(original);
});

test.each(["cancel", "please stop", "Jarvis, stop"])("%s during resumed routing prevents dispatch", async words => {
  const r = rig(); await r.say(ORIGINAL); r.confident();
  let release!: () => void;
  r.holdDecision(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = r.say("Research", { eventId: "held-routing-answer" });
  await waitFor(() => !!release);
  const stop = await r.say(words);
  expect(r.jobs().commandAdmission("usman", "held-routing-answer")?.stoppedAt).not.toBeNull();
  release(); expect((await pending).stopped).toBe(true); expect(r.executed).toHaveLength(0);
  expect(stop.said).toContain("Stop");
});

test("bot-scoped Stop reaches its pre-job admission even when no job exists yet", async () => {
  const r = rig(); await r.say(ORIGINAL, { conversationId: botThreadId("usman", "research"), target: { bot: "research" } }); r.confident();
  let release!: () => void;
  r.holdDecision(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = r.say("Research", { eventId: "held-bot-routing-answer", conversationId: botThreadId("usman", "research") });
  await waitFor(() => !!release);
  await r.say("stop", { conversationId: botThreadId("usman", "research") });
  expect(r.jobs().commandAdmission("usman", "held-bot-routing-answer")?.stoppedAt).not.toBeNull();
  release(); expect((await pending).stopped).toBe(true); expect(r.executed).toHaveLength(0);
});

test("Stop still cancels a running bot job when question/transcript writes fail", async () => {
  const r = rig(); r.confident(); const running = await r.say("research a synthetic topic", { conversationId: botThreadId("usman", "research") });
  r.uncertain(); expect((await r.say(ORIGINAL, { conversationId: botThreadId("usman", "research") })).ask).toBe(true);
  r.failAllTranscriptWrites();
  const result = await r.say("please stop", { conversationId: botThreadId("usman", "research") });
  expect(r.jobs().get(running.jobId!)?.state).toBe("cancelled");
  expect(result.said).toContain("couldn't clear");
});

test("streamed done carries the same clarification provenance as the returned coding response", async () => {
  const r = rig("coding"); await r.say("Fix the bug using Opus on Claude Max 2"); r.confident();
  const events: any[] = [];
  const answer = await r.service().run({ principal: OWNER, body: { utterance: "coding", source: "typed", eventId: "streamed-reply-event", conversationId: CONVERSATION } }, e => events.push(e));
  expect(answer.numbers?.clarification).toBeTruthy();
  expect(events.filter(e => e.type === "done").at(-1)?.numbers.clarification).toEqual(answer.numbers?.clarification);
});


test("an unkeyed route answer is refused without consuming the legitimate question", async () => {
  const r = rig(); await r.say(ORIGINAL); r.confident();
  const unkeyed = await r.service().run({ principal: OWNER, body: { utterance: "Research", source: "typed", conversationId: CONVERSATION } });
  expect(unkeyed.refused).toBe(true); expect(r.executed).toHaveLength(0);
  await r.say("Research"); expect(r.executed[0].utterance).toBe(ORIGINAL);
});


test("an explicitly Research-targeted Stop cannot cancel a different resumed lane from default chat", async () => {
  const r = rig("brain"); await r.say("write a synthetic outline"); r.confident();
  let release!: () => void;
  r.holdDecision(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = r.say("an answer from you", { eventId: "held-brain-answer" });
  await waitFor(() => !!release);
  await r.say("stop", { target: { bot: "research" } });
  expect(r.jobs().commandAdmission("usman", "held-brain-answer")?.stoppedAt).toBeNull();
  release(); expect((await pending).stopped).not.toBe(true);
});

test("a saved absence of page context stays absent on voice resume", async () => {
  const r = rig("brain");
  expect((await r.say("write a synthetic outline", { source: "voice", pageContext: undefined })).ask).toBe(true);
  r.confident();
  await r.say("explain this lead", { source: "voice", conversationId: SECOND, pageContext: { page: "/leads", capturedAt: r.now(), focused: { kind: "lead", id: "B", label: "Synthetic B" } } });
  await r.say("an answer from you", { source: "voice", pageContext: undefined });
  expect(r.asked.at(-1).state.page).toBeUndefined(); expect(r.asked.at(-1).state.record).toBeUndefined();
});

test("a Research-targeted Stop preserves an unrelated pending default-chat question", async () => {
  const r = rig("brain");
  expect((await r.say("write a synthetic outline")).ask).toBe(true);
  await r.say("stop", { target: { bot: "research" } });
  r.confident(); const answer = await r.say("an answer from you");
  expect(answer.kind).toBe("handoff"); expect(answer.handoff?.utterance).toBe("write a synthetic outline");
});


test("a bot named in Stop words does not supersede an unrelated pending question", async () => {
  const r = rig("brain"); expect((await r.say("write a synthetic outline")).ask).toBe(true);
  await r.say("stop Research");
  r.confident(); const answer = await r.say("an answer from you");
  expect(answer.handoff?.utterance).toBe("write a synthetic outline");
});


test("provenance remains on streamed fallback when job execution is refused before its callback", async () => {
  const r = rig("coding"); await r.say("Fix the bug using Opus on Claude Max 2"); r.confident();
  r.jobs().run = (async () => ({ ok: false, reason: "quarantined" })) as never;
  const events: any[] = [];
  const answer = await r.service().run({ principal: OWNER, body: { utterance: "coding", source: "typed", eventId: "quarantined-reply-event", conversationId: CONVERSATION } }, e => events.push(e));
  expect(answer.kind).toBe("unavailable"); expect(answer.numbers?.clarification).toBeTruthy();
  expect(events.filter(e => e.type === "done").at(-1)?.numbers.clarification).toEqual(answer.numbers?.clarification);
});

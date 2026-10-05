// Founder testing on production 1c94f418 (5 Oct, typed on /jarvis from a remote paired session): the exact utterances that failed, through the
// real command service, the real CRM store and operations, and the real job store; Jev, the calendar, the needs-you panels, the AI usage
// skill and the agent list are fakes. One regression per finding.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { jevDecide } from "../jev-client";
import { JobService } from "../jobs/service";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { runCrmIntent } from "./crm";
import { runLeadAction } from "./leads";
import { agentStatusSaid, calendarSaid, isQuestion, osReadIn } from "./os-reads";
import { createCommandService, type CommandServiceDeps } from "./service";

const usman: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-10-05T01:10:00Z"); // 12:10 pm in Sydney
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

type Jev = "unavailable" | "ask" | "brain" | "crm";
function rig(options: { jev?: Jev } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-findings-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const rt = crmRuntime(dir);
  cleanups.push(() => { jobs.close(); closeCrmRuntime(dir); Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
  const by = { personId: "usman" as const };
  const company = rt.store.createCompany({ name: "Westpoint Dental Clinic" }, by);
  const deal = rt.store.createDeal({ companyId: company.id, title: "Westpoint Dental Clinic opportunity", service: "website", commercialBasis: "pending" }, by);
  rt.store.createTask({ companyId: company.id, dealId: deal.id, title: "Review the synthetic scope", owner: "usman" }, by);
  const state = { jev: options.jev ?? ("unavailable" as Jev) };
  const log: string[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const controller: CommandServiceDeps["controller"] = {
    key: () => "synthetic-key-never-logged",
    cache: null,
    log: (line) => void log.push(line),
    decide: (async (input: { state: { utterance: string } }) => {
      asked.push(input.state.utterance);
      if (state.jev === "unavailable") return { ok: false, reason: "unavailable", httpStatus: null, ms: 41, receipt: null, attempts: 2, detail: "transport ECONNRESET" };
      return { ok: true, answers: { lane: { choice: state.jev, confidence: state.jev === "ask" ? 0.4 : 0.96 }, multi: { noul: 0.05 }, outbound: { noul: 0.02 } }, ms: 12, attempts: 1, httpStatus: 200, receipt: { requestId: "synthetic-jev", model: "synthetic-jev" }, raw: null };
    }) as never,
  };
  const service = createCommandService({
    jobs: () => jobs, entry: () => null, hubDeviceId: "synthetic-hub", dedupeMs: 0, now: () => NOW,
    resolveTarget: () => ({ ok: false, reason: "No synthetic device" }),
    controller,
    bots: { scope: (() => null) as never, nameOf: (id: string) => (id === "research" ? "Research" : id), threadIds: () => [], list: () => [{ id: "research", name: "Research" }, { id: "builder", name: "Builder" }], run: (async () => { ran.push("bot"); return { ok: true, said: "ran" }; }) as never } as never,
    delegates: {
      crm: (intent, principal, context, eventId) => runCrmIntent({ operations: () => rt.operations as never, role: () => "pc", readOnly: () => false }, intent, principal, context as never, eventId ? { eventId } : {}),
      leads: (action, principal) => runLeadAction({ handle: async () => ({ open: 839 }) } as never, action, principal),
      skill: { match: (u: string) => (/spent on ai|spend on ai/i.test(u) ? "ai_usage" : null), run: async () => ({ ok: true, said: "AI spend this month is A$815.72 across your providers." }) } as never,
      reads: {
        calendar: () => [
          { title: "Call with Westpoint", start: "2026-10-05T03:00:00Z", end: "2026-10-05T03:30:00Z", location: "Zoom" },
          { title: "Tomorrow's standup", start: "2026-10-05T22:00:00Z", end: "2026-10-05T22:15:00Z" },
          { title: "Last week's thing", start: "2026-09-29T03:00:00Z", end: "2026-09-29T04:00:00Z" },
        ],
        needsYou: async () => "3 things need you: 2 decisions and 1 failed job. First: approve the Westpoint quote.",
      },
    },
  });
  const say = async (utterance: string, extras: Record<string, unknown> = {}) => {
    const done = (await service.run({ principal: usman, body: { utterance, source: "typed", conversationId: CONVERSATION, ...extras } as never }, () => undefined)) as any;
    return { done, job: done.jobId ? jobs.get(done.jobId) : null };
  };
  return { say, state, log, asked, ran, jobs, deal };
}

describe("finding 1: Jev unavailable is diagnosable, retried once, and never refuses a question", () => {
  test("\"what's on my calendar today\" is answered from the saved calendar with Jev out; Jev is not even asked", async () => {
    const r = rig({ jev: "unavailable" });
    const { done, job } = await r.say("what's on my calendar today");
    expect(done.ok).toBe(true);
    expect(done.said).toBe("1 event today: 2:00 pm: Call with Westpoint (Zoom).");
    expect(done.said).not.toContain("Jev");
    expect(r.asked).toEqual([]);
    expect(job!.state).toBe("succeeded");
    expect((await r.say("what's on my calendar tomorrow")).done.said).toContain("Tomorrow's standup");
  });

  test("a question no read lane covers goes to the brain (answer only), with the reason on the job and one hub log line", async () => {
    const r = rig({ jev: "unavailable" });
    const { done, job } = await r.say("why do dental clinics need a website?");
    expect(done.kind).toBe("handoff");
    expect(done.handoff).toMatchObject({ to: "brain", intent: "question.jev-unavailable" });
    expect(done.numbers.jev).toMatchObject({ state: "unavailable", reason: "unavailable", detail: "transport ECONNRESET", attempts: 2, recovery: "brain-answer" });
    expect(done.decision).toMatchObject({ source: "fallback", op: "delegate.brain" });
    expect(job!.state).toBe("succeeded");
    expect(job!.receipts.some((x) => /Jev unavailable \(unavailable: transport ECONNRESET, 2 requests\)/.test(x.reason ?? ""))).toBe(true);
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatch(/^\[jev\] unavailable surface=command\.controller reason=unavailable http=none attempts=2 ms=41 detail="transport ECONNRESET"$/);
    expect(r.log[0]).not.toContain("synthetic-key-never-logged");
    expect(r.log[0]).not.toContain("dental");
  });

  test("an ACTION with Jev out still runs nothing and says so; the cause is recorded", async () => {
    const r = rig({ jev: "unavailable" });
    const { done, job } = await r.say("sort out the Westpoint paperwork");
    expect(done.ok).toBe(false);
    expect(done.kind).toBe("unavailable");
    expect(done.said).toContain("nothing ran");
    expect(done.numbers.jev).toMatchObject({ reason: "unavailable", detail: "transport ECONNRESET" });
    expect(r.ran).toEqual([]);
    expect(job!.state).toBe("failed");
    expect(isQuestion("sort out the Westpoint paperwork")).toBe(false);
    expect(isQuestion("could you sort out the paperwork")).toBe(true);
  });

  test("the Jev client tries a dropped or timed-out controller call once more, and says why when it still fails", async () => {
    const base = { surface: "command.controller" as const, key: "k", state: { utterance: "x" }, questions: { lane: { type: "choice", criteria: { brain: "an answer", ask: "unclear" } } }, sink: new MemoryReceiptSink(), health: new MemoryHealthStore() };
    let n = 0;
    const dropped = await jevDecide({ ...base, request: (async () => { if (++n === 1) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" }); return Response.json({ answers: { lane: { choice: "brain", confidence: 0.9 } } }); }) as never });
    expect([dropped.ok, n]).toEqual([true, 2]);
    n = 0;
    const slow = await jevDecide({ ...base, sink: new MemoryReceiptSink(), request: (async () => { if (++n === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); return Response.json({ answers: { lane: { choice: "brain", confidence: 0.9 } } }); }) as never });
    expect([slow.ok, n]).toEqual([true, 2]);
    n = 0;
    const down = await jevDecide({ ...base, sink: new MemoryReceiptSink(), request: (async () => { n++; throw Object.assign(new Error("Bearer k must never appear"), { code: "ECONNREFUSED" }); }) as never });
    expect(down).toMatchObject({ ok: false, reason: "unavailable", attempts: 2, detail: "transport ECONNREFUSED" });
    expect(JSON.stringify(down)).not.toContain("Bearer");
  });
});

describe("finding 2: plain questions about the OS's own data are answered, whatever Jev says", () => {
  test("\"how much have we spent on AI this month\" and \"what needs my attention right now\" with an unsure Jev", async () => {
    const r = rig({ jev: "ask" });
    const spend = await r.say("how much have we spent on AI this month");
    expect([spend.done.ok, spend.done.said]).toEqual([true, "AI spend this month is A$815.72 across your providers."]);
    const needs = await r.say("what needs my attention right now");
    expect([needs.done.ok, needs.done.said]).toEqual([true, "3 things need you: 2 decisions and 1 failed job. First: approve the Westpoint quote."]);
    expect(r.asked).toEqual([]);
    for (const x of [spend, needs]) expect(x.job!.state).toBe("succeeded");
    expect(osReadIn("what needs me today")).toEqual({ kind: "needs" });
    expect(osReadIn("open the calendar")).toBeNull();
    expect(osReadIn("put lunch on my calendar today")).toBeNull();
  });

  test("an unsure Jev on any other question hands it to the brain instead of asking where to run it", async () => {
    const r = rig({ jev: "ask" });
    const { done } = await r.say("what should I say to a client who thinks the price is too high?");
    expect(done.kind).toBe("handoff");
    expect(done.handoff).toMatchObject({ to: "brain", intent: "question.jev-unsure" });
    expect(done.said).not.toContain("I'm not sure how you want that done");
  });
});

describe("findings 3 and 4: a deal's stage, and \"that deal\" after a find", () => {
  test("\"what stage is the Westpoint Dental Clinic opportunity deal in\" is read from the CRM", async () => {
    const r = rig({ jev: "brain" });
    const { done } = await r.say("what stage is the Westpoint Dental Clinic opportunity deal in");
    expect(done.ok).toBe(true);
    expect(done.said).toStartWith("Westpoint Dental Clinic opportunity is in the New stage.");
    expect(r.asked).toEqual([]);
  });

  test("\"find client Westpoint Dental Clinic\" then \"what stage is that deal in\" resolves to that client's deal", async () => {
    const r = rig({ jev: "crm" });
    const found = await r.say("find client Westpoint Dental Clinic");
    expect(found.done.ok).toBe(true);
    const stage = await r.say("what stage is that deal in");
    expect(stage.done.ok).toBe(true);
    expect(stage.done.said).toStartWith("Westpoint Dental Clinic opportunity is in the New stage.");
    const next = await r.say("what's the next action for it");
    expect(next.done.said).toContain("Review the synthetic scope");
  });

  test("the reference stays in its own conversation and person; with nothing remembered he is asked, once, and that is not a failure", async () => {
    const r = rig({ jev: "crm" });
    await r.say("find client Westpoint Dental Clinic");
    const elsewhere = await r.say("what stage is that deal in", { conversationId: "99999999-2222-4333-8444-555555555555" });
    expect(elsewhere.done.said).not.toContain("New stage");
    expect(elsewhere.done.ok).toBe(false);
    expect(elsewhere.job?.state).not.toBe("failed");
  });
});

describe("finding 5: an agent's status comes from the job store", () => {
  test("\"what is Research working on\": its running job, or idle with its last job and when", async () => {
    const r = rig({ jev: "brain" });
    const idle = await r.say("what is Research working on");
    expect(idle.done.said).toBe("Research is idle and has no jobs on record here.");
    r.jobs.create({ kind: "control", principal: usman, targetDeviceId: "computer-research", title: "Research the Sydney Harbour Bridge", bot: "research" });
    const busy = await r.say("what is Research working on");
    expect(busy.done.ok).toBe(true);
    expect(busy.done.said).toStartWith('Research has queued "Research the Sydney Harbour Bridge"');
    expect(r.asked).toEqual([]);
    expect(agentStatusSaid("Builder", [{ id: "j", state: "succeeded", title: "Build the landing page", createdAt: new Date(NOW - 3 * 3_600_000).toISOString(), updatedAt: new Date(NOW - 2 * 3_600_000).toISOString() }], NOW)).toBe('Builder is idle. Its last job, "Build the landing page", finished 2 hours ago.');
    expect(calendarSaid([], "today", NOW)).toBe("Nothing is on your calendar today, from the events saved here.");
  });
});

describe("finding 6: a clarifying ask is not a failed job", () => {
  test("\"I'm not sure how you want that done\" settles as asked, never failed", async () => {
    const r = rig({ jev: "ask" });
    const { done, job } = await r.say("sort out the Westpoint paperwork");
    expect(done.ask).toBe(true);
    expect(done.said).toContain("I'm not sure how you want that done");
    expect(job!.state).toBe("succeeded");
    expect(job!.note).toStartWith("Asked: I'm not sure how you want that done");
    expect(r.jobs.list({ state: "failed" })).toEqual([]);
  });
});

// ── Re-test on production f35d5a4f (5 Oct): three more ────────────────────────────────────────────────────────────────
import { freeVoice } from "../free-voice";
import { aiSpendSaid, osQuestionIn } from "./os-reads";
import { splitRoutes } from "../../src/components/ds/route-text";

describe("re-test 1: AI spend for a remote founder, from the Finance page's source", () => {
  const snap = { month: { label: "October 2026" }, totals: { fixedAud: 600, meteredAud: 215.72, monthAud: 815.72, projectedAud: 1010.5, unknown: ["x"] } };
  test("this month is the snapshot's month-to-date figure; last month is said to be unknown, never guessed", () => {
    expect(aiSpendSaid(snap, "this")).toBe("AI spend so far this October is A$815.72: A$600.00 in subscriptions and A$215.72 of metered API use. On track for A$1,010.50 by month end. Not in the total: 1 item with no readable price.");
    expect(aiSpendSaid(snap, "last")).toStartWith("I only have the current month's AI spend here, not last month's total, so I won't guess it. AI spend so far this October is A$815.72");
  });

  test("\"how much have we spent on AI this month\" from a paired remote session never says \"only works at the PC itself\"", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-findings-ai-"));
    const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
    cleanups.push(() => { jobs.close(); Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
    const service = createCommandService({
      jobs: () => jobs, entry: () => null, hubDeviceId: "synthetic-hub", dedupeMs: 0, resolveTarget: () => ({ ok: false, reason: "none" }),
      delegates: {
        // The PC-only skill, exactly as it answered a remote founder on production.
        skill: { match: () => "ai_usage", run: async () => ({ ok: false, said: "That one only works at the PC itself, sir." }) } as never,
        reads: { aiTotals: async () => snap },
      },
    });
    for (const [words, expected] of [["how much have we spent on AI this month", /^AI spend so far this October is A\$815\.72/], ["how much did we spend on AI last month", /^I only have the current month's AI spend here/]] as const) {
      const done = (await service.run({ principal: usman, body: { utterance: words, source: "typed" } as never }, () => undefined)) as any;
      expect([words, done.ok]).toEqual([words, true]);
      expect(done.said).toMatch(expected);
      expect(done.said).not.toContain("only works at the PC");
    }
  });
});

describe("re-test 2: the OS read lanes run before the brain on the typed /jarvis lane, remote or at the hub", () => {
  const QUESTIONS = ["what is Research working on", "how much have we spent on AI this month", "what's on my calendar today", "what needs my attention right now", "what stage is the Westpoint Dental Clinic opportunity deal in", "what stage is that deal in"];
  for (const remote of [true, false])
    for (const jevKey of [true, false])
      test(`free-voice typed turn (${remote ? "remote" : "hub"} founder, Jev ${jevKey ? "on" : "off"}): each goes to the command path; the brain is never called`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "live-findings-voice-"));
        cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
        let network = 0;
        const engine = freeVoice(dir, {
          key: (k) => (k === "GROQ_API_KEY" || (jevKey && k === "TYPESAFE_API_KEY") ? "synthetic" : ""),
          bots: () => [{ id: "research", name: "Research" }, { id: "builder", name: "Builder" }] as never,
          fetch: (async () => { network++; return Response.json({ choices: [{ message: { role: "assistant", content: "Research is focused on expanding M&U Ventures' offerings." } }] }); }) as never,
          sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), hub: () => ({ name: "fixture", role: "server" }), companions: () => [],
        });
        for (const words of QUESTIONS) {
          const out = (await engine.handle("/voice/free/turn", { typed: true, remote, messages: [{ role: "user", content: words }] }, undefined, usman)) as any;
          expect([words, out.tool_calls?.[0]?.function?.name, out.content]).toEqual([words, "jarvis_command", null]);
          expect(JSON.parse(out.tool_calls[0].function.arguments).utterance).toBe(words);
        }
        expect(network).toBe(0);
      });

  test("ordinary questions and requests are not taken by the read lanes", () => {
    const bots = [{ id: "research", name: "Research" }];
    for (const w of ["what is the capital of Portugal", "what is research", "Research the Sydney Harbour Bridge", "ask Research to look into dental pricing", "what stage of grief is anger", "open the CRM"]) expect([w, osQuestionIn(w, bots)]).toEqual([w, false]);
  });
});

describe("re-test 3: a question answers with a link and never navigates; an explicit open still does", () => {
  test("the stage and next-action answers carry no navigate, and a CRM link the page shows; \"open ...\" navigates", async () => {
    const r = rig({ jev: "crm" });
    for (const words of ["what stage is the Westpoint Dental Clinic opportunity deal in", "what's the next action for the Westpoint Dental Clinic opportunity deal"]) {
      const { done } = await r.say(words);
      expect([words, done.ok, done.navigate, done.kind]).toEqual([words, true, undefined, "answer"]);
    }
    const stage = (await r.say("what stage is the Westpoint Dental Clinic opportunity deal in")).done;
    const path = `/crm?ref=${encodeURIComponent(`crm:deal:${r.deal.id}`)}&tab=deals`;
    expect(stage.said).toEndWith(`Open it: ${path}`);
    expect(splitRoutes(stage.said).at(-1)).toEqual({ text: path, to: path });
    // Spoken: no path is read out.
    expect((await r.say("what stage is the Westpoint Dental Clinic opportunity deal in", { source: "voice" })).done.said).not.toContain("/crm");
    const opened = (await r.say("open the Westpoint Dental Clinic opportunity deal")).done;
    expect(opened.ok).toBe(true);
    expect(opened.navigate?.path).toContain("/crm");
  });
});

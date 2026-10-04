// Exact founder regression through the real HTTP command handler and command service.
// Synthetic CRM records, scripted Jev and an injected read-only Leads API; no live providers.
import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import { JobService } from "../jobs/service";
import { createCommandService, type CommandServiceDeps } from "./service";
import { commandRoute } from "./route";
import { runCrmIntent } from "./crm";
import { runLeadAction } from "./leads";
import { businessIntentIn } from "./business";
import { businessClauses } from "./business-clauses";
import { businessQuestionsIn } from "./compound-questions";
import { planRules } from "./plan";
import { openCrm, upsertLead, mergeLead } from "../leads/crm";
import { pipelineSummary } from "../leads/lead-pipeline";

const REPRO = "what's the next action for the Westpoint Dental Clinic opportunity deal, and how many open leads do we have?";
const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(c => c()));

function rig(options: { lane?: string; noController?: boolean; unavailable?: boolean; title?: string; summary?: unknown; beforeRead?: (name: string) => Promise<void>; realPipeline?: boolean; mutatingDelegates?: boolean; missingLeads?: boolean; resolveTarget?: CommandServiceDeps["resolveTarget"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "compound-questions-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const rt = crmRuntime(dir);
  // Windows: a closed SQLite/FTS5 handle stays locked until GC, so cleanup must not fail the test (same pattern as scripts/finance tests).
  cleanups.push(() => { jobs.close(); closeCrmRuntime(dir); Bun.gc(true); try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
  const by = { personId: "usman" as const };
  const company = rt.store.createCompany({ name: "Synthetic Westpoint Dental Clinic" }, by);
  const deal = rt.store.createDeal({ companyId: company.id, title: options.title ?? "Westpoint Dental Clinic opportunity", service: "website", commercialBasis: "pending" }, by);
  rt.store.createTask({ companyId: company.id, dealId: deal.id, title: "Review the synthetic scope", owner: "usman" }, by);
  const calls: string[] = [];
  const queries: string[] = [];
  const asked: string[] = [];
  const controller: CommandServiceDeps["controller"] = {
    key: () => options.unavailable ? "" : "synthetic",
    cache: null,
    decide: (async (input: any) => {
      asked.push(input.state.utterance);
      return { ok: true, answers: { lane: { choice: options.lane ?? "crm", confidence: .97 }, multi: { noul: .99 }, outbound: { noul: .01 } }, ms: 12, attempts: 1, httpStatus: 200, receipt: { requestId: "synthetic-compound", model: "synthetic-jev" }, raw: null };
    }) as never,
  };
  const leadDb = options.realPipeline ? openCrm(join(dir, "leads.sqlite")) : null;
  if (leadDb) {
    cleanups.push(() => leadDb.close());
    for (let id = 1; id <= 5; id++) upsertLead(leadDb, { placeId: `synthetic-${id}`, name: `Synthetic lead ${id}`, vertical: "dental", area: "Synthetic", phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch: "", reasons: [], googleAt: null });
    leadDb.run("UPDATE leads SET status='lost' WHERE id=2");
    leadDb.run("UPDATE leads SET excluded=1 WHERE id=3");
    mergeLead(leadDb, 1, 4, { by: "usman", reason: "Synthetic duplicate" });
  }
  const service = createCommandService({
    pinCatalogue: () => ({ claude: [], codex: [] }),
    jobs: () => jobs, entry: () => null, hubDeviceId: "synthetic-pc", dedupeMs: 0,
    resolveTarget: options.resolveTarget ?? (() => ({ ok: false, reason: "No synthetic device" })),
    ...(options.noController ? {} : { controller }),
    delegates: {
      ...(options.mutatingDelegates ? {
        coding: async () => { calls.push("MUTATING_CODING_DELEGATE"); return { say: "Coding ran" }; },
        computers: async () => { calls.push("MUTATING_COMPUTER_DELEGATE"); return { ok: true, said: "Computer ran" }; },
      } : {}),
      crm: (intent, principal, context, eventId) => runCrmIntent({ operations: () => ({ run: async (name, input, who) => {
        calls.push(name);
        if (name === "crm.search") queries.push((input as { query: string }).query);
        await options.beforeRead?.(name);
        return rt.operations.run(name, input, who);
      } }), role: () => "pc", readOnly: () => false }, intent, principal, context as never, { eventId }),
      ...(options.missingLeads ? {} : { leads: (action: Parameters<typeof runLeadAction>[1], principal: Principal) => runLeadAction({ handle: async (path, method, _body, params) => {
        calls.push(`${method} ${path}?${params}`);
        if (path !== "/leads/pipeline" || method !== "GET" || params.get("summary") !== "1") throw new Error("Unexpected Leads request");
        return leadDb ? pipelineSummary(dir, leadDb) : options.summary ?? { open: 7, total: 12, lost: 2, excluded: 2, merged: 1 };
      } }, action, principal) }),
    },
  });
  const say = async (utterance: string, extras: Record<string, unknown> = {}, principal = owner) => {
    const events: any[] = [];
    const res = Object.assign(new EventEmitter(), { statusCode: 0, headersSent: false, writableEnded: false, destroyed: false, setHeader: () => {}, write: (data: string) => { events.push(JSON.parse(data)); }, end() { this.writableEnded = true; } });
    await commandRoute({ path: "/screen/command", method: "POST", url: new URL("http://localhost/__operator/screen/command"), body: { utterance, source: "typed", ...extras }, principal, req: {} as never, res: res as never, service, send: value => events.push(value) });
    return events.at(-1);
  };
  return { say, calls, queries, asked, jobs, rt, service };
}

test("exact founder compound keeps the record name and answers both questions in order through the real route", async () => {
  const r = rig();
  const done = await r.say(REPRO);
  expect(done.ok).toBe(true);
  expect(done.said).toContain("Review the synthetic scope");
  expect(done.said).toContain("7 open leads");
  expect(done.said.indexOf("Review the synthetic scope")).toBeLessThan(done.said.indexOf("7 open leads"));
  expect(r.queries).toEqual(["Westpoint Dental Clinic opportunity"]);
  expect(r.asked).toEqual([REPRO]);
  expect(done.decision).toMatchObject({ source: "jev", requestId: "synthetic-compound" });
});


test.each(["typed", "voice"])("%s questions work without Jev and with the labelled unavailable fallback", async source => {
  for (const options of [{ noController: true }, { unavailable: true }]) {
    const r = rig(options);
    const done = await r.say(REPRO, { source });
    expect(done).toMatchObject({ ok: true, verified: true, decision: { source: options.unavailable ? "fallback" : "rules" } });
    expect(done.said).toContain("Review the synthetic scope");
    expect(done.said).toContain("7 open leads");
    expect(r.calls).toEqual(["crm.search", "crm.next.list", "GET /leads/pipeline?summary=1"]);
    if (options.unavailable) expect(r.jobs.get(done.jobId)?.receipts[0]).toMatchObject({ provider: "typesafe", outcome: "failed" });
  }
});

test.each(["Smith and Jones", "Key & Castle", "Smith and Sons", "Westpoint, Dental Clinic"])("unquoted company conjunctions and commas remain names: %s", async name => {
  const r = rig({ title: name });
  const question = `what's the next action for the ${name} deal`;
  const done = await r.say(`${question} and how many open leads do we have?`);
  expect(done.ok).toBe(true);
  expect(r.queries).toEqual([name]);
  expect(businessClauses(question)).toEqual([question]);
});

test.each([['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']])("quoted names retain conjunctions, question words and separators: %s%s", async (left, right) => {
  const name = "Smith and Jones, and how many open leads";
  const r = rig({ title: name });
  const done = await r.say(`what's the next action for the ${left}${name}${right} deal, and how many open leads do we have?`);
  expect(done.ok).toBe(true);
  expect(r.queries).toEqual([name]);
});

test("single question stays a single existing operation; reverse compound preserves order", async () => {
  const r = rig();
  const single = await r.say("what's the next action for the Westpoint Dental Clinic opportunity deal?");
  expect(single).toMatchObject({ ok: true, decision: { op: "crm.operation" } });
  expect(r.calls).toEqual(["crm.search", "crm.next.list"]);
  const done = await r.say("how many open leads do we have, and what's the next action for the Westpoint Dental Clinic opportunity deal?");
  expect(done.ok).toBe(true);
  expect(done.said.indexOf("7 open leads")).toBeLessThan(done.said.indexOf("Review the synthetic scope"));
  expect(businessIntentIn(REPRO)).toBeNull();
});

test.each([", and ", " and ", "; ", " then ", "? ", ". "])("question boundary %s", separator => {
  const one = "what's the next action for the Smith and Jones deal";
  const two = "how many open leads do we have?";
  expect(businessClauses(one + separator + two)).toEqual([one, two]);
  expect(businessQuestionsIn(one + separator + two)?.kind).toBe("questions");
});

test.each(["email the client", "send the invoice", "delete the client", "mark Westpoint Dental as won", "draft a quote for Westpoint", "pay the invoice", "create a task for the Westpoint deal: contact them", "crm.task.complete {}", "what's the weather?"])("mixed request never executes the read prefix or client action: %s", async suffix => {
  const r = rig();
  const before = { ...r.rt.store.snapshot(), generatedAt: "ignored" };
  const done = await r.say(`what's the next action for the Westpoint Dental Clinic opportunity deal, and ${suffix}`);
  expect(done.ok).toBe(false);
  expect(r.calls).toEqual([]);
  expect({ ...r.rt.store.snapshot(), generatedAt: "ignored" }).toEqual(before);
});

test("unsupported mixed request and over-limit questions execute nothing without Jev", async () => {
  const r = rig({ noController: true });
  for (const text of ["how many open leads do we have and email the client", Array(5).fill("how many open leads do we have").join(", and ")]) {
    const done = await r.say(text);
    expect(done).toMatchObject({ ok: false, ask: true });
    expect(r.calls).toEqual([]);
  }
  const four = await r.say(Array(4).fill("how many open leads do we have").join(", and "));
  expect(four.ok).toBe(true);
  expect(r.calls).toHaveLength(4);
});

test("failures report the unanswered remainder; missing service executes nothing", async () => {
  const r = rig({ missingLeads: true });
  const done = await r.say(REPRO);
  expect(done.ok).toBe(false);
  expect(r.calls).toEqual([]);
  const noMatch = rig();
  const failed = await noMatch.say("what's the next action for the Missing Synthetic Company deal and how many open leads do we have?");
  expect(failed.ok).toBe(false);
  expect(failed.said).toContain("remaining questions were not answered");
  expect(noMatch.calls).toEqual(["crm.search"]);
});

test.each([{ total: 12 }, { open: -1 }, { open: 2.5 }, { open: "7" }, { open: 7, ok: false }, { open: 7, error: "unavailable" }])("never invent or substitute an invalid pipeline total: %j", async summary => {
  const r = rig({ summary });
  const done = await r.say(REPRO);
  expect(done).toMatchObject({ ok: false, verified: null });
  expect(done.said).toContain("Review the synthetic scope");
  expect(done.said).toContain("won't guess");
});

test("zero and singular open counts come from the canonical pipeline field", async () => {
  for (const open of [0, 1]) {
    const r = rig({ summary: { open, total: 999 } });
    const done = await r.say(REPRO);
    expect(done.ok).toBe(true);
    expect(done.said).toContain(`We have ${open} open lead${open === 1 ? "" : "s"}.`);
  }
});

test("routine principals cannot use the read-only compound path", async () => {
  const r = rig({ noController: true });
  const done = await r.say(REPRO, {}, { ...owner, actor: "process", via: "routine" });
  expect(done.ok).toBe(false);
  expect(r.calls).toEqual([]);
});

test("a Jev brain choice is honored without running the deterministic compound", async () => {
  const r = rig({ lane: "brain" });
  const done = await r.say(REPRO);
  expect(done).toMatchObject({ kind: "handoff", handoff: { utterance: REPRO, to: "brain" } });
  expect(r.calls).toEqual([]);
});

test("named device and account pins are never dropped to run the read-only compound", async () => {
  for (const options of [{ noController: true }, { unavailable: true }, {}]) {
    const r = rig({ ...options, resolveTarget: () => ({ ok: true, deviceId: "own-pc", owner: "usman", reason: "synthetic own device" } as never) });
    const done = await r.say(REPRO, { spokenTarget: "my PC" });
    expect(done.ok).toBe(false);
    expect(r.calls).toEqual([]);
  }
  const r = rig();
  const pinned = await r.say(`${REPRO} and fix the README using Opus on Claude Max 7`);
  expect(pinned).toMatchObject({ ok: false, refused: true, decision: { op: "coding.pin" } });
  expect(r.calls).toEqual([]);
  expect(r.asked).toEqual([]);
});

test("notes and task descriptions remain data, including comma separators and ands", () => {
  expect(businessIntentIn("add a note to the Smith and Jones client, call and email them")).toMatchObject({ kind: "named-note", name: "Smith and Jones", text: "call and email them" });
  expect(businessIntentIn("create a task for the Smith and Sons deal: call and email them")).toMatchObject({ kind: "task", name: "Smith and Sons", title: "call and email them" });
  expect(planRules("draft a quote for Smith and Jones")).toMatchObject({ to: "crm", op: "crm.operation" });
});


test("real pipeline semantics exclude lost, excluded and merged synthetic leads", async () => {
  const r = rig({ realPipeline: true });
  const done = await r.say(REPRO);
  expect(done).toMatchObject({ ok: true, verified: true });
  expect(done.said).toContain("2 open leads");
  expect(r.calls).toEqual(["crm.search", "crm.next.list", "GET /leads/pipeline?summary=1"]);
});

test.each(["next actions", "overdue follow-ups", "view outreach drafts"])("bare supported business form is a second clause: %s", clause => {
  const words = `what's the next action for the Westpoint deal and ${clause}`;
  expect(businessClauses(words)).toHaveLength(2);
  expect(businessQuestionsIn(words)?.kind).toBe("questions");
  expect(businessIntentIn(words)).toBeNull();
});

test.each(["coding", "device.screen", "device.open", "brain", "crm"])("unsupported mixed read/action cannot bypass into Jev lane %s", async lane => {
  const r = rig({ lane, mutatingDelegates: true });
  const done = await r.say("how many open leads do we have and update the website code");
  expect(done).toMatchObject({ ok: false, ask: true, decision: { source: "jev" } });
  expect(r.asked).toHaveLength(1);
  expect(r.calls).toEqual([]);
});

test("no-controller unsupported compound is checked before greedy coding/computer delegates", async () => {
  const r = rig({ noController: true, mutatingDelegates: true });
  const done = await r.say("how many open leads do we have and update the website code");
  expect(done).toMatchObject({ ok: false, ask: true });
  expect(r.calls).toEqual([]);
});


test("full planner keeps explicit note/task payload questions as data", () => {
  for (const words of ["add a note to the Westpoint deal: call the owner and show the next actions", "create a task for the Westpoint deal: call and show the next actions", "add a note to this deal: call and show the next actions"]) {
    expect(businessQuestionsIn(words)).toBeNull();
    expect(planRules(words)).toMatchObject({ lane: "delegate", to: "crm", op: "crm.operation" });
  }
});

test("supported legacy compound does not reach greedy coding/computer delegates", async () => {
  const r = rig({ noController: true, mutatingDelegates: true });
  const done = await r.say(REPRO);
  expect(done.ok).toBe(true);
  expect(r.calls).toEqual(["crm.search", "crm.next.list", "GET /leads/pipeline?summary=1"]);
});

test("standalone count uses the same signed-in read gate", async () => {
  const r = rig({ noController: true });
  const done = await r.say("how many open leads do we have?", {}, { ...owner, actor: "process", via: "routine" });
  expect(done.ok).toBe(false);
  expect(r.calls).toEqual([]);
});


test("Jev unavailable cannot open a page from an unsupported compound and drop the question", async () => {
  const r = rig({ unavailable: true });
  const done = await r.say("open Leads and how many open leads do we have");
  expect(done).toMatchObject({ ok: false, kind: "unavailable" });
  expect(done.navigate).toBeUndefined();
  expect(r.calls).toEqual([]);
});

test("stop during the first read prevents the second question and never reports complete", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const r = rig({ beforeRead: async name => { if (name === "crm.next.list") { started(); await held; } } });
  const pending = r.say(REPRO);
  await entered;
  const stopping = r.service.cancel(r.service.liveJobs().at(-1)!, owner);
  release();
  const done = await pending;
  await stopping;
  expect(done.stopped).toBe(true);
  expect(done.ok).toBe(false);
  expect(r.calls).toEqual(["crm.search", "crm.next.list"]);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, jarvisThreadId, CRM_REFERENCE_TTL_MS } from "../conversations";
import { closeCrmRuntime, crmRuntime } from "../crm/runtime";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { closeJobsRuntime } from "../jobs/runtime";
import { runCrmIntent, type CrmIntent } from "./crm";
import { createCommandService } from "./service";
import { createJobThreads } from "./threads";

const OWNER: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Synthetic founder" };
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function rig(options: { verified?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crm-followup-restart-"));
  let now = Date.parse("2026-10-05T01:10:00Z");
  const rt = crmRuntime(root);
  const by = { personId: "usman" as const };
  const company = rt.store.createCompany({ name: "Synthetic Orchard Clinic" }, by);
  const deal = rt.store.createDeal({ companyId: company.id, title: "Synthetic Orchard opportunity", service: "website", commercialBasis: "pending" }, by);
  rt.store.createTask({ companyId: company.id, dealId: deal.id, title: "Review the synthetic scope", owner: "usman" }, by);
  let jobs: JobService;
  let afterCrm: ((intent: CrmIntent) => Promise<void>) | null = null;
  let referenceFailure: "clear" | "save" | null = null;
  const make = () => {
    jobs = new JobService({ path: join(root, "jobs.sqlite"), snapshotMs: 0 });
    const threads = createJobThreads({ conversations: conversationStore(root), jobs: () => jobs, now: () => now });
    const persist = threads.rememberCrmRecord;
    threads.rememberCrmRecord = (...args) => { if (referenceFailure === (args[2] ? "save" : "clear")) throw new Error("synthetic write failure"); return persist(...args); };
    return createCommandService({
      jobs: () => jobs, threads, now: () => now, dedupeMs: 0,
      entry: () => null, hubDeviceId: "synthetic-hub", resolveTarget: () => ({ ok: false, reason: "No synthetic device" }),
      delegates: { crm: async (intent, principal, context, eventId) => { const answer = await runCrmIntent({ operations: () => rt.operations as never, role: () => "server", readOnly: () => false }, intent, principal, context, { eventId }); await afterCrm?.(intent); return options.verified === false ? { ...answer, verified: false } : answer; } },
    });
  };
  let service = make();
  cleanup.push(() => { jobs.close(); closeCrmRuntime(root); closeJobsRuntime(root); rmSync(root, { recursive: true, force: true }); });
  return {
    root, rt, company, deal,
    now: () => now,
    holdCrm(fn: ((intent: CrmIntent) => Promise<void>) | null) { afterCrm = fn; },
    failReference(when: "clear" | "save" | null) { referenceFailure = when; },
    advance(ms: number) { now += ms; },
    restart() { jobs.close(); service = make(); },
    say(utterance: string, extras: Record<string, unknown> = {}, principal = OWNER) {
      return service.run({ principal, body: { utterance, source: "typed", conversationId: CONVERSATION, ...extras } as never });
    },
  };
}

test("a CRM reference survives recreation of the command service, job service and conversation store", async () => {
  const r = rig();
  expect((await r.say("find client Synthetic Orchard Clinic")).ok).toBe(true);
  r.restart();
  const stage = await r.say("what stage is that deal in");
  expect(stage.ok).toBe(true);
  expect(stage.said).toContain("Synthetic Orchard opportunity is in the New stage");
  r.restart();
  expect((await r.say("what's the next action for it")).said).toContain("Review the synthetic scope");
});

const OTHER = "99999999-2222-4333-8444-555555555555";
const SECOND: Principal = { ...OWNER, personId: "mehroz" };

test("references never cross conversations or founders, or fall back from an unknown conversation", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  r.restart();
  for (const [extras, principal] of [[{ conversationId: OTHER }, OWNER], [{}, SECOND], [{ conversationId: "invalid" }, OWNER]] as const) {
    const reply = await r.say("what stage is that deal in", extras, principal);
    expect(reply.ask).toBe(true);
    expect(reply.said).not.toContain("Synthetic Orchard");
  }
  await r.say("find deal Synthetic Orchard opportunity", {}, SECOND);
  expect(conversationStore(r.root).crmRecord("usman", CONVERSATION, r.now())?.kind).toBe("company");
  expect(conversationStore(r.root).crmRecord("mehroz", CONVERSATION, r.now())).toBeNull();
});

test("the omitted and explicit default conversation use the same reference", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic", { conversationId: undefined });
  r.restart();
  expect((await r.say("what stage is that deal in", { conversationId: jarvisThreadId("usman") })).said).toContain("New stage");
});

test("15-minute TTL survives restart and expired references ask without searching for a pronoun", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  r.advance(CRM_REFERENCE_TTL_MS + 1);
  r.restart();
  const ask = await r.say("what's the next action for it");
  expect(ask.ask).toBe(true);
  expect(ask.said).toBe("Which CRM record do you mean? Name or open it first.");
  expect(conversationStore(r.root).crmRecord("usman", CONVERSATION, r.now())).toBeNull();
});

test("a replayed event does not refresh or retarget the reference", async () => {
  const r = rig();
  const extras = { eventId: "crm-find-replay-0001" };
  await r.say("find client Synthetic Orchard Clinic", extras);
  r.advance(CRM_REFERENCE_TTL_MS - 1000);
  r.restart();
  expect((await r.say("find client Synthetic Orchard Clinic", extras)).numbers).toMatchObject({ replayed: true });
  r.advance(1001);
  expect((await r.say("what stage is that deal in")).ask).toBe(true);
});

test("a renamed record and a new identical old name still resolve to the original exact ID", async () => {
  const r = rig();
  await r.say("find deal Synthetic Orchard opportunity");
  r.rt.store.updateDeal(r.deal.id, { title: "Renamed synthetic opportunity" }, r.deal.version, { personId: "usman" });
  r.rt.store.createDeal({ companyId: r.company.id, title: "Synthetic Orchard opportunity", service: "website", commercialBasis: "pending" }, { personId: "usman" });
  r.restart();
  const stage = await r.say("what stage is that deal in");
  expect(stage.said).toContain("Renamed synthetic opportunity is in the New stage");
  expect(stage.said).not.toContain("2 records");
});

test("deleted records never fall back to a same-named replacement", async () => {
  const r = rig();
  await r.say("find deal Synthetic Orchard opportunity");
  r.rt.store.db.query("DELETE FROM crm_tasks WHERE deal_id = ?").run(r.deal.id);
  r.rt.store.db.query("DELETE FROM crm_deals WHERE id = ?").run(r.deal.id);
  r.rt.store.createDeal({ companyId: r.company.id, title: "Synthetic Orchard opportunity", service: "website", commercialBasis: "pending" }, { personId: "usman" });
  r.restart();
  const stage = await r.say("what stage is that deal in");
  expect(stage.ask).toBe(true);
  expect(stage.said).toContain("no longer available");
  expect(stage.said).not.toContain("New stage");
});

test("archived records never select another active deal in the company", async () => {
  const r = rig();
  await r.say("find deal Synthetic Orchard opportunity");
  r.rt.store.db.query("UPDATE crm_deals SET data = json_set(data, '$.archivedAt', ?) WHERE id = ?").run(new Date(r.now()).toISOString(), r.deal.id);
  r.rt.store.createDeal({ companyId: r.company.id, title: "Other synthetic opportunity", service: "website", commercialBasis: "pending" }, { personId: "usman" });
  r.restart();
  expect((await r.say("what stage is that deal in")).ask).toBe(true);
});

test("a company reference with two deals asks which, without guessing", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  r.rt.store.createDeal({ companyId: r.company.id, title: "Other synthetic opportunity", service: "website", commercialBasis: "pending" }, { personId: "usman" });
  r.restart();
  const stage = await r.say("what stage is that deal in");
  expect(stage.ask).toBe(true);
  expect(stage.said).toContain("has 2 deals");
});

test("client snapshot saves preserve the server reference and cannot forge or erase it", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  const store = conversationStore(r.root);
  const before = store.get(CONVERSATION)!;
  expect(before.crmRecordReference).toBeUndefined();
  store.save({ ...before, crmRecordReference: { kind: "deal", id: r.deal.id, title: "forged", at: r.now() } }, { personId: "usman", hub: false });
  expect(store.crmRecord("usman", CONVERSATION, r.now())).toMatchObject({ kind: "company", id: r.company.id });
  store.save({ id: OTHER, messages: [], crmRecordReference: { kind: "deal", id: r.deal.id, title: "forged", at: r.now() } }, { personId: "usman", hub: false });
  expect(store.crmRecord("usman", OTHER, r.now())).toBeNull();
  r.restart();
  expect((await r.say("what stage is that deal in")).said).toContain("New stage");
});

test("legacy unowned and foreign conversations cannot receive a reference", async () => {
  const r = rig();
  const store = conversationStore(r.root);
  store.save({ id: CONVERSATION, messages: [], title: "Legacy synthetic chat" });
  await r.say("find client Synthetic Orchard Clinic");
  expect(store.get(CONVERSATION)?.personId).toBeUndefined();
  expect(store.crmRecord("usman", CONVERSATION, r.now())).toBeNull();
  expect(store.get(jarvisThreadId("usman"))).toBeNull();
});

test("unverified CRM results never become reference authority", async () => {
  const r = rig({ verified: false });
  await r.say("find client Synthetic Orchard Clinic");
  r.restart();
  expect((await r.say("what stage is that deal in")).ask).toBe(true);
});

test("a note payload mentioning that deal does not retarget its explicitly named client", async () => {
  const r = rig();
  const other = r.rt.store.createCompany({ name: "Synthetic Meadow Clinic" }, { personId: "usman" });
  await r.say("find client Synthetic Orchard Clinic");
  r.restart();
  const note = await r.say("add a note to the Synthetic Meadow Clinic client: asked about that deal");
  expect(note.ok).toBe(true);
  expect(note.navigate?.path).toContain(encodeURIComponent(`crm:company:${other.id}`));
  expect(note.said).toContain("Synthetic Meadow Clinic");
});

test("a reference to a client never grants CRM writes to a process or unconfirmed browser", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  r.restart();
  for (const principal of [{ ...OWNER, personId: "dot", via: "gateway", actor: "process" }, { ...OWNER, via: "tailnet-person", actor: "process" }] as Principal[]) {
    const note = await r.say("add a note to that client: synthetic denied write", {}, principal);
    expect(note.ok).toBe(false);
  }
});

test("malformed and future-dated references fail closed, and corrupt files are left untouched", async () => {
  const r = rig();
  await r.say("find client Synthetic Orchard Clinic");
  const file = join(r.root, ".operator-data", "conversations.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  for (const patch of [{ at: r.now() + 1 }, { kind: "invalid" }, { id: "../../outside" }]) {
    const altered = structuredClone(saved);
    Object.assign(altered[0].crmRecordReference, patch);
    writeFileSync(file, JSON.stringify(altered));
    r.restart();
    expect((await r.say("what stage is that deal in")).ask).toBe(true);
  }
  writeFileSync(file, "not JSON");
  r.restart();
  expect((await r.say("what stage is that deal in")).ask).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("not JSON");
});


test("failed replacement cannot leave an older record authoritative after restart", async () => {
  const r = rig();
  r.rt.store.createCompany({ name: "Synthetic Meadow Clinic" }, { personId: "usman" });
  await r.say("find client Synthetic Orchard Clinic");
  r.failReference("save");
  const found = await r.say("find client Synthetic Meadow Clinic");
  expect(found.ok).toBe(true);
  expect(found.said).toContain("couldn't save its conversation reference");
  r.failReference(null);
  r.restart();
  expect((await r.say("what stage is that deal in")).ask).toBe(true);
});

test("a failed initial invalidation refuses the new lookup before showing its result", async () => {
  const r = rig();
  r.rt.store.createCompany({ name: "Synthetic Meadow Clinic" }, { personId: "usman" });
  await r.say("find client Synthetic Orchard Clinic");
  r.failReference("clear");
  const found = await r.say("find client Synthetic Meadow Clinic");
  expect(found.ok).toBe(false);
  expect(found.said).toContain("lookup was not run");
  expect(found.said).not.toContain("Synthetic Meadow");
});

test("literal placeholder names and payload pronouns cannot forge a contextual target", async () => {
  const r = rig();
  const other = r.rt.store.createCompany({ name: "recent CRM record" }, { personId: "usman" });
  await r.say("find client Synthetic Orchard Clinic");
  r.restart();
  const note = await r.say("add a note to the recent   CRM record client: asked about that deal");
  expect(note.ok).toBe(true);
  expect(note.navigate?.path).toContain(encodeURIComponent(`crm:company:${other.id}`));
});


test("overlapping lookups cannot restore an older reference after the newer save fails", async () => {
  const r = rig();
  r.rt.store.createCompany({ name: "Synthetic Meadow Clinic" }, { personId: "usman" });
  const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
  const a = gate(), b = gate(), aReady = gate(), bReady = gate();
  r.holdCrm(async intent => {
    if (intent.kind !== "search") return;
    if (intent.query === "Synthetic Orchard Clinic") { aReady.release(); await a.promise; }
    if (intent.query === "Synthetic Meadow Clinic") { bReady.release(); await b.promise; }
  });
  const first = r.say("find client Synthetic Orchard Clinic", { conversationId: undefined });
  await aReady.promise;
  const second = r.say("find client Synthetic Meadow Clinic", { conversationId: jarvisThreadId("usman") });
  await bReady.promise;
  a.release();
  expect((await first).said).toContain("couldn't save its conversation reference");
  r.failReference("save");
  b.release();
  expect((await second).said).toContain("couldn't save its conversation reference");
  r.failReference(null);
  r.holdCrm(null);
  r.restart();
  expect((await r.say("what stage is that deal in", { conversationId: undefined })).ask).toBe(true);
});

// Creating, duplicating and archiving bots: the store (persists, rev, ids never reused), the rules (validation, last active bot, work in flight), the
// routes (who may), Jarvis (an archived bot refuses by name, target, thread and page) and the migration (an existing bots.json loads as it is).
// Real job service, conversation store and command service over SYNTHETIC computers, coding and memory; nothing touches a real machine or account.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { botThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { abilitiesOf } from "./abilities";
import { createAgentsRoutes } from "./routes";
import { botsFile, createBotStore } from "./store";
import { seedBots, type Bot } from "./types";
import { copyOf, normaliseName, parseCreate, slugOf, type ValidationDeps } from "./validate";
import { commandFor, computerView, fakeCodingJob, makeRig, sleep, usman, waitFor, type Rig } from "./test-rig";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async (o: Parameters<typeof makeRig>[0] = {}) => {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
};
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((res) => (release = res));
  return { promise, release };
};
/** A job body that waits for the test to let it finish (and stops when asked to). */
const gated = (h: ReturnType<typeof hold>) => async (_id: string, ctx: { signal: AbortSignal }) => {
  await Promise.race([h.promise, new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }))]);
  return ctx.signal.aborted ? { ok: false, note: "Stopped on request." } : { ok: true, note: "report ready" };
};
const NEW = { name: "Scout", purpose: "Finds suppliers and lists them." };
const reload = (r: Rig) => createBotStore({ file: botsFile(r.root) });

describe("create", () => {
  test("persists across a store reload, with who made it and when; a new bot has no conversation, task, result or computer of its own", async () => {
    const r = await rig();
    const computersBefore = [...r.views.keys()];
    const out = await r.agents.service.create({ ...NEW, instructions: "Be brief.", computer: "research", modelPreference: { route: "free-only" }, memory: { recall: false, saveResults: false } }, "mehroz");
    expect(out.status).toBe(201);
    const bot = out.body as any;
    expect(bot).toMatchObject({ id: "scout", name: "Scout", rev: 1, createdBy: "mehroz", duplicatedFrom: null, computer: "research", lifecycle: "active", skills: ["research", "builder", "audit", "bizprep"] });
    expect(bot.history).toEqual([{ at: bot.createdAt, by: "mehroz", action: "created" }]);
    // reload: the file is the truth
    const again = reload(r).get("scout")!;
    expect(again).toMatchObject({ id: "scout", name: "Scout", purpose: NEW.purpose, instructions: "Be brief.", computer: "research", coding: { enabled: false, accountSlot: null, model: null }, modelPreference: { route: "free-only" }, memory: { recall: false, saveResults: false }, routines: [], createdBy: "mehroz", rev: 1 });
    expect(reload(r).list().map((b) => b.id)).toEqual(["research", "builder", "scout"]);
    // nothing else was made: no computer, no thread, no tasks, no files
    expect([...r.views.keys()]).toEqual(computersBefore);
    expect(r.conversations.get(botThreadId("mehroz", "scout"))).toBeNull();
    expect((await r.agents.service.tasks("scout", "mehroz"))!.tasks).toEqual([]);
    expect((await r.agents.service.files("scout", "mehroz"))!.files).toEqual([]);
  });

  test("a bot's conversation is made lazily, the way the existing ones are: first read by a confirmed person", async () => {
    const r = await rig();
    await r.agents.service.create(NEW, "usman");
    expect(r.conversations.get(botThreadId("usman", "scout"))).toBeNull();
    const got = await r.agents.service.get("scout", "usman", { thread: true });
    expect(got).toMatchObject({ conversationKey: "agent:usman:scout" });
    expect(r.conversations.get(botThreadId("usman", "scout"))).not.toBeNull();
  });

  test("ids come from the name, are lowercase slugs and stay unique (-2, -3); an explicit id is used as given", async () => {
    const r = await rig();
    const svc = r.agents.service;
    expect(((await svc.create({ name: "Scout!", purpose: "x" }, "usman")).body as any).id).toBe("scout");
    // a different name with the same slug gets the next free id; the same name (any case) is refused
    expect(((await svc.create({ name: "SCOUT?", purpose: "x" }, "usman")).body as any).id).toBe("scout-2");
    expect((await svc.create({ name: "scout!", purpose: "x" }, "usman")).status).toBe(409);
    expect(((await svc.create({ name: "Zed", purpose: "x", id: "custom-id" }, "usman")).body as any).id).toBe("custom-id");
  });

  test("validation: every field is checked against the services the bot points at", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const bad = async (body: unknown) => (await svc.create(body, "usman")) as { status: number; body: { errors?: Array<{ field: string; message: string; code?: string }> } };
    const fields = async (body: unknown) => (await bad(body)).body.errors?.map((e) => e.field) ?? [];
    expect(await fields({ purpose: "x" })).toContain("name");
    expect(await fields({ name: "A" })).toContain("purpose");
    expect(await fields({ name: "A", purpose: "x".repeat(301) })).toContain("purpose");
    expect(await fields({ name: "A".repeat(41), purpose: "x" })).toContain("name");
    expect(await fields({ ...NEW, instructions: "y".repeat(8001) })).toContain("instructions");
    expect(await fields({ ...NEW, id: "Not A Slug" })).toContain("id");
    expect(await fields({ ...NEW, id: "-lead" })).toContain("id");
    expect(await fields({ ...NEW, computer: "ghost" })).toContain("computer");
    expect(await fields({ ...NEW, modelPreference: { route: "no-such-model" } })).toContain("modelPreference.route");
    expect(await fields({ ...NEW, skills: ["research"] })).toContain("skills");
    expect(await fields({ ...NEW, routines: ["trig-morning-brief"] })).toContain("routines");
    expect(await fields({ ...NEW, rev: 1 })).toContain("rev");
    expect(await fields({ ...NEW, anything: 1 })).toContain("anything");
    expect(await fields({ ...NEW, coding: { enabled: true, accountSlot: "claude:max-9", model: null } })).toContain("coding.accountSlot");
    expect(await fields({ ...NEW, coding: { enabled: true, accountSlot: "claude:max-2", model: "gpt-nope" } })).toContain("coding.model");
    expect(await fields({ ...NEW, coding: { enabled: false, accountSlot: "claude:max", model: null } })).toContain("coding");
    expect(await fields({ ...NEW, memory: { recall: true } })).toContain("memory.saveResults");
    expect((await bad("nope")).status).toBe(400);
    expect(reload(r).list().map((b) => b.id)).toEqual(["research", "builder"]); // none of those wrote anything
  });

  test("coding can be on only where the coding executor can honour it: a configured account, and a model that account runs", async () => {
    const r = await rig();
    const ok = await r.agents.service.create({ name: "Coder", purpose: "Writes code.", coding: { enabled: true, accountSlot: "claude:max-2", model: null } }, "usman");
    expect(ok.status).toBe(201);
    expect((ok.body as any).abilities.map((a: any) => a.id)).toEqual(["coding"]);
    // no coding account configured at all: coding can't be turned on (the rules, with a fake accounts service)
    const none: ValidationDeps = { computerExists: () => true, accountSlots: () => [], modelsFor: () => [], allModels: () => [], routerModels: () => [], routineIds: () => [], bots: () => [] };
    const p = parseCreate({ ...NEW, coding: { enabled: true, accountSlot: null, model: null } }, none);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.errors.map((e) => e.field)).toContain("coding.enabled");
  });

  test("ids are never reused: an archived bot keeps its id and its name, so neither can be taken again", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const made = (await svc.create(NEW, "usman")).body as any;
    expect((await svc.archive("scout", { rev: made.rev, archived: true }, "usman")).status).toBe(200);
    const sameId = await svc.create({ name: "Zeta", purpose: "x", id: "scout" }, "usman");
    expect(sameId.status).toBe(409);
    expect((sameId.body as any).code).toBe("id-taken");
    const sameName = await svc.create({ name: "scout", purpose: "x" }, "usman");
    expect(sameName.status).toBe(409);
    expect((sameName.body as any).code).toBe("name-taken");
    // a different name whose slug is the same gets the next free id, never the archived one
    const next = await svc.create({ name: "Scout.", purpose: "x" }, "usman");
    expect(next.status).toBe(201);
    expect((next.body as any).id).toBe("scout-2");
    // an id that is another bot's NAME is taken too (Jarvis matches either word)
    expect((await svc.create({ name: "Zed", purpose: "x", id: "builder" }, "usman")).status).toBe(409);
    expect((await svc.create({ name: "builder", purpose: "x" }, "usman")).status).toBe(409);
    expect(slugOf("Café Ünïcode 2!")).toBe("cafe-unicode-2");
    expect(slugOf("!!!")).toBe("bot");
  });

  test("several bots may share one computer; creating a bot never creates one, and Setup can say who shares it", async () => {
    const r = await rig();
    const svc = r.agents.service;
    await svc.create({ ...NEW, computer: "research" }, "usman");
    const list = (await svc.list()) as any[];
    expect(list.find((b) => b.id === "research").sharesComputerWith).toEqual([{ id: "scout", name: "Scout", archived: false }]);
    expect(list.find((b) => b.id === "scout").sharesComputerWith).toEqual([{ id: "research", name: "Research", archived: false }]);
    expect(list.find((b) => b.id === "builder").sharesComputerWith).toEqual([]);
    expect([...r.views.keys()]).toEqual(["research", "builder"]);
  });

  test("bots sharing a computer share its one lease and there is NO queue: the second request is refused, and the other bot reads busy with a reason that names the holder", async () => {
    const r = await rig();
    await r.agents.service.create({ ...NEW, computer: "research" }, "usman");
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const a = await say(usman, "Ask Research to find clinics", { eventId: "evt-sh01" });
    expect(a.ok).toBe(true);
    const list = (await r.agents.service.list()) as any[];
    const rb = list.find((b) => b.id === "research");
    const sb = list.find((b) => b.id === "scout");
    expect(rb.readiness).toMatchObject({ state: "working", working: { jobId: a.jobId } });
    // Scout is busy too, but not "working" on Research's job: its reason names Research and says to ask again; nothing waits in line
    expect(sb.readiness.state).toBe("working");
    expect(sb.readiness.working).toBeNull();
    const why = sb.readiness.reasons.find((x: any) => x.code === "computer-busy-other-bot");
    expect(why).toMatchObject({ bot: { id: "research", name: "Research" } });
    expect(why.text).toContain("Research's task");
    expect(why.text).toContain("Ask Scout again when it finishes");
    expect(JSON.stringify(sb.readiness)).not.toMatch(/queue|waits its turn/i);
    expect((await r.agents.service.tasks("scout", "usman"))!.tasks).toEqual([]);
    expect((await r.agents.service.tasks("research", "usman"))!.tasks.map((t) => t.id)).toEqual([a.jobId]);
    // Scout's request goes through the same start path and the lease REFUSES it: nothing starts, and the refusal is the computer's own words
    const b = await say(usman, "Ask Scout to find suppliers", { eventId: "evt-sh02" });
    expect(b.ok).toBe(false);
    expect(JSON.stringify(b)).toContain("one controller at a time");
    expect(JSON.stringify(b)).not.toMatch(/queue(?!d)|waits its turn/i);
    expect(r.started.map((s) => [s.computer, s.bot])).toEqual([["research", "research"]]);
    // once the holder's job ends the computer is free, and Scout can run
    h.release();
    await waitFor(() => r.jobs.get(a.jobId!)?.state === "succeeded");
    await waitFor(() => r.views.get("research")!.state === "online");
    const c = await say(usman, "Ask Scout to find suppliers", { eventId: "evt-sh03" });
    expect(c.ok).toBe(true);
    expect(r.started.map((s) => [s.computer, s.bot])).toEqual([["research", "research"], ["research", "scout"]]);
  });

  test("a copy or a new bot shows none of the original's results or tasks, and reads idle while the original works", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true, note: "report ready" }));
    const a = await say(usman, "Ask Research to find clinics", { eventId: "evt-lk01" });
    await waitFor(() => r.jobs.get(a.jobId!)?.state === "succeeded");
    r.artifacts.save({ jobId: a.jobId!, personId: "usman", kind: "research", title: "clinics", summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# r" }] } as never);
    expect(((await r.agents.service.files("research", "usman"))!.files).map((f) => f.jobId)).toEqual([a.jobId]);
    const copy = (await r.agents.service.duplicate("research", "usman")).body as any;
    const fresh = (await r.agents.service.create({ ...NEW, computer: "research" }, "usman")).body as any;
    for (const id of [copy.id, fresh.id]) {
      expect((await r.agents.service.files(id, "usman"))!.files).toEqual([]);
      expect((await r.agents.service.tasks(id, "usman"))!.tasks).toEqual([]);
    }
    // an UNATTRIBUTED saved result (no bot on its job) belongs to the original bot of that computer only
    r.artifacts.save({ jobId: "11111111-2222-4333-8444-000000000001", personId: "usman", kind: "research", title: "old", summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# r" }] } as never);
    expect(((await r.agents.service.files("research", "usman"))!.files).map((f) => f.jobId).sort()).toEqual([a.jobId, "11111111-2222-4333-8444-000000000001"].sort());
    expect((await r.agents.service.files(copy.id, "usman"))!.files).toEqual([]);
    expect((await r.agents.service.files(fresh.id, "usman"))!.files).toEqual([]);
  });

  test("a legacy coding job nobody linked belongs to the original Builder only: a duplicate or new Builder isn't 'working' and can be archived", async () => {
    const r = await rig();
    r.codingJobs.push(fakeCodingJob({ id: "cj-leg-0001", state: "building", objective: "Fix the footer year" }));
    expect(((await r.agents.service.tasks("builder", "usman"))!.tasks).map((t) => t.id)).toEqual(["cj-leg-0001"]);
    const copy = (await r.agents.service.duplicate("builder", "usman")).body as any;
    const fresh = (await r.agents.service.create({ name: "Coder", purpose: "Writes code.", coding: { enabled: true, accountSlot: "claude:max-2", model: null } }, "usman")).body as any;
    for (const b of [copy, fresh]) {
      expect((await r.agents.service.tasks(b.id, "usman"))!.tasks).toEqual([]);
      expect((await r.agents.service.files(b.id, "usman"))!.files).toEqual([]);
      const view = ((await r.agents.service.list()) as any[]).find((x) => x.id === b.id);
      expect(view.readiness.working).toBeNull();
      expect(view.readiness.state).not.toBe("working");
      const ar = await r.agents.service.archive(b.id, { rev: view.rev, archived: true }, "usman");
      expect(ar.status).toBe(200);
    }
    // a job that WAS linked to a bot stays that bot's
    r.agents.links.note({ jobId: "cj-leg-0001", bot: "coder", personId: "usman", subjects: [] });
    expect(((await r.agents.service.tasks("coder", "usman"))!.tasks).map((t) => t.id)).toEqual(["cj-leg-0001"]);
    expect((await r.agents.service.tasks("builder", "usman"))!.tasks).toEqual([]);
  });
});

describe("duplicate", () => {
  test("copies configuration only, as '<name> copy' with a fresh id; never credentials, sessions, approvals, routine links, conversations, tasks or results", async () => {
    const r = await rig();
    const svc = r.agents.service;
    // Builder gets a routine, a conversation with a message, a task and a coding job: none of it may travel
    const b = reload(r).get("builder")!;
    const set = await svc.patch("builder", { rev: b.rev, routines: ["trig-morning-brief"], instructions: "Work in a branch.", coding: { enabled: true, accountSlot: "claude:max-2", model: null }, memory: { recall: false, saveResults: true } }, "usman");
    expect(set.status).toBe(200);
    await svc.get("builder", "usman", { thread: true });
    r.conversations.appendEntry(botThreadId("usman", "builder"), { key: "k1", state: "request", text: "hello" } as never);
    const h = hold();
    r.setBody(gated(h));
    const { say } = commandFor(r);
    await say(usman, "Ask Builder to build a pricing card component", { eventId: "evt-d1" });
    r.codingJobs.push(fakeCodingJob({ id: "cj-dup-0001", state: "succeeded" }));
    r.agents.links.note({ jobId: "cj-dup-0001", bot: "builder", personId: "usman", subjects: [] });

    const out = await svc.duplicate("builder", "mehroz");
    expect(out.status).toBe(201);
    const copy = out.body as any;
    expect(copy).toMatchObject({ id: "builder-copy", name: "Builder copy", purpose: reload(r).get("builder")!.purpose, instructions: "Work in a branch.", computer: "builder", coding: { enabled: true, accountSlot: "claude:max-2", model: null }, memory: { recall: false, saveResults: true }, routines: [], duplicatedFrom: "builder", createdBy: "mehroz", rev: 1, lifecycle: "active" });
    expect(copy.history).toEqual([{ at: copy.createdAt, by: "mehroz", action: "duplicated", note: "from builder" }]);
    // the whole stored record is the allowed shape: no credential, session, approval or result field exists to copy
    const stored = JSON.parse(readFileSync(botsFile(r.root), "utf8")).bots.find((x: Bot) => x.id === "builder-copy");
    expect(Object.keys(stored).sort()).toEqual(["coding", "computer", "createdAt", "createdBy", "duplicatedFrom", "history", "id", "instructions", "memory", "modelPreference", "name", "purpose", "rev", "routines", "skills", "updatedAt"]);
    // no conversation, no tasks, no results, no routine link; the original is untouched
    expect(r.conversations.get(botThreadId("mehroz", "builder-copy"))).toBeNull();
    expect(r.conversations.get(botThreadId("usman", "builder-copy"))).toBeNull();
    expect((await svc.tasks("builder-copy", "usman"))!.tasks).toEqual([]);
    expect((await svc.files("builder-copy", "usman"))!.files).toEqual([]);
    expect((await svc.tasks("builder", "usman"))!.tasks.length).toBeGreaterThan(0);
    expect(reload(r).get("builder")!.routines).toEqual(["trig-morning-brief"]);
    expect(reload(r).get("builder-copy")!.routines).toEqual([]);
    h.release();
  });

  test("a second copy is '<name> copy 2', then 3; copying an archived bot is allowed and the copy is active", async () => {
    const r = await rig();
    const svc = r.agents.service;
    expect(((await svc.duplicate("research", "usman")).body as any).name).toBe("Research copy");
    const second = (await svc.duplicate("research", "usman")).body as any;
    expect(second).toMatchObject({ name: "Research copy 2", id: "research-copy-2" });
    expect(((await svc.duplicate("research", "usman")).body as any).name).toBe("Research copy 3");
    const res = reload(r).get("research")!;
    await svc.archive("research", { rev: res.rev, archived: true }, "usman");
    const copyOfArchived = (await svc.duplicate("research", "usman")).body as any;
    expect(copyOfArchived).toMatchObject({ name: "Research copy 4", lifecycle: "active" });
    expect((await svc.duplicate("ghost", "usman")).status).toBe(404);
  });

  test("a computer or account that is gone isn't carried to the copy", () => {
    const gone: ValidationDeps = { computerExists: () => false, accountSlots: () => [], modelsFor: () => [], allModels: () => [], routerModels: () => [], routineIds: () => [], bots: () => [{ id: "builder", name: "Builder" }] };
    const copy = copyOf({ ...seedBots(1)[1], coding: { enabled: true, accountSlot: "claude:max-9", model: "opus" } }, gone);
    expect(copy).toMatchObject({ computer: null, coding: { enabled: false, accountSlot: null, model: null }, name: "Builder copy", id: "builder-copy" });
    // with an account configured the copy keeps coding on (the same rule as creating a bot)
    const some: ValidationDeps = { ...gone, accountSlots: () => ["claude:max"], modelsFor: () => ["opus"], allModels: () => ["opus"] };
    expect(copyOf({ ...seedBots(1)[1], coding: { enabled: true, accountSlot: null, model: null } }, some).coding).toEqual({ enabled: true, accountSlot: null, model: null });
  });
});

describe("archive and unarchive", () => {
  test("persists across a reload, hides the bot (lifecycle), records who and when, and unarchive restores it", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const scout = (await svc.create(NEW, "usman")).body as any;
    const a = await svc.archive("scout", { rev: scout.rev, archived: true }, "mehroz");
    expect(a.status).toBe(200);
    const archived = a.body as any;
    expect(archived).toMatchObject({ lifecycle: "archived", rev: 2, archived: { by: "mehroz", afterCurrentWork: false } });
    expect(archived.archived.at).toBeGreaterThan(0);
    expect(reload(r).get("scout")!.archived).toMatchObject({ by: "mehroz" });
    expect(reload(r).get("scout")!.history!.map((h) => [h.action, h.by])).toEqual([["created", "usman"], ["archived", "mehroz"]]);
    expect(((await svc.list()) as any[]).find((b) => b.id === "scout").lifecycle).toBe("archived");
    const back = await svc.archive("scout", { rev: archived.rev, archived: false }, "usman");
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ lifecycle: "active", rev: 3, archived: null });
    expect(reload(r).get("scout")!.history!.map((h) => h.action)).toEqual(["created", "archived", "unarchived"]);
  });

  test("a stale rev is a 409 with the current bot; nothing is written", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const out = await svc.archive("builder", { rev: 7, archived: true }, "usman");
    expect(out.status).toBe(409);
    expect((out.body as any).current).toMatchObject({ id: "builder", rev: 1 });
    expect(reload(r).get("builder")!.archived).toBeUndefined();
    // an edit made meanwhile also makes an archive stale
    const b = reload(r).get("builder")!;
    await svc.patch("builder", { rev: b.rev, purpose: "Changed." }, "mehroz");
    expect((await svc.archive("builder", { rev: b.rev, archived: true }, "usman")).status).toBe(409);
    // bad bodies are 400s, unknown bots 404s
    expect((await svc.archive("builder", { archived: true }, "usman")).status).toBe(400);
    expect((await svc.archive("builder", { rev: 2 }, "usman")).status).toBe(400);
    expect((await svc.archive("builder", { rev: 2, archived: false, afterCurrentWork: true }, "usman")).status).toBe(400);
    expect((await svc.archive("ghost", { rev: 1, archived: true }, "usman")).status).toBe(404);
    expect((await svc.archive("builder", { rev: 2, archived: false }, "usman")).status).toBe(422); // not archived
  });

  test("refused with running or waiting work (listed); allowed 'after current work': new work is refused at once and the running job is untouched", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const job = await say(usman, "Ask Research to find clinics", { eventId: "evt-ar01" });
    expect(job.ok).toBe(true);
    await waitFor(() => r.jobs.get(job.jobId!)?.state === "running");

    const refused = await svc.archive("research", { rev: 1, archived: true }, "usman");
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "has-running-work", work: [{ jobId: job.jobId, kind: "computer", phase: "running" }] });
    expect((refused.body as any).error).toContain("find clinics");
    expect(reload(r).get("research")!.archived).toBeUndefined();

    const after = await svc.archive("research", { rev: 1, archived: true, afterCurrentWork: true }, "usman");
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ lifecycle: "archiving", archived: { afterCurrentWork: true, by: "usman" } });
    // the running job was not touched
    expect(r.jobs.get(job.jobId!)!.state).toBe("running");
    // new work is refused at once, by words and by the conversation; nothing starts
    const startedBefore = r.started.length;
    const refusedWords = await say(usman, "Ask Research to find suppliers", { eventId: "evt-ar02" });
    expect(refusedWords.ok).toBe(false);
    expect(JSON.stringify(refusedWords)).toContain("archived");
    const refusedThread = await say(usman, "find suppliers", { eventId: "evt-ar03", conversationId: botThreadId("usman", "research"), target: { bot: "research" } });
    expect(refusedThread.ok).toBe(false);
    expect(r.started.length).toBe(startedBefore);
    // it finishes by itself; the bot then reads as archived, and its result is still there
    h.release();
    await waitFor(() => r.jobs.get(job.jobId!)?.state === "succeeded");
    expect(((await svc.list()) as any[]).find((b) => b.id === "research").lifecycle).toBe("archived");
    expect((await svc.tasks("research", "usman"))!.tasks.map((t) => [t.id, t.phase])).toEqual([[job.jobId, "done"]]);
  });

  test("the last active bot can't be archived, however it is asked; unarchiving another makes it possible", async () => {
    const r = await rig();
    const svc = r.agents.service;
    expect((await svc.archive("builder", { rev: 1, archived: true }, "usman")).status).toBe(200);
    const last = await svc.archive("research", { rev: 1, archived: true, afterCurrentWork: true }, "usman");
    expect(last.status).toBe(422);
    expect(last.body).toMatchObject({ code: "last-active" });
    expect(reload(r).get("research")!.archived).toBeUndefined();
    expect(reload(r).list().filter((b) => !b.archived).map((b) => b.id)).toEqual(["research"]);
    expect((await svc.archive("builder", { rev: 2, archived: false }, "usman")).status).toBe(200);
    expect((await svc.archive("research", { rev: 1, archived: true }, "usman")).status).toBe(200);
    // the store itself holds the line (not only the service)
    const store = reload(r);
    expect(store.setArchived("builder", store.get("builder")!.rev, { archive: { by: "usman", afterCurrentWork: false }, by: "usman" })).toMatchObject({ ok: false, status: 422, reason: "last-active" });
  });

  test("Research and Builder archive like any other bot", async () => {
    const r = await rig();
    expect((await r.agents.service.archive("research", { rev: 1, archived: true }, "usman")).status).toBe(200);
    expect(reload(r).get("research")!.archived).toBeTruthy();
  });

  test("an archived bot's tasks, files and conversation stay readable; it can't be edited until it is unarchived", async () => {
    const r = await rig();
    const svc = r.agents.service;
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true, note: "report ready" }));
    const job = await say(usman, "Ask Research to find clinics", { eventId: "evt-rd01" });
    await waitFor(() => r.jobs.get(job.jobId!)?.state === "succeeded");
    await svc.get("research", "usman", { thread: true });
    const archived = (await svc.archive("research", { rev: 1, archived: true }, "usman")).body as any;
    expect((await svc.tasks("research", "usman"))!.tasks.map((t) => t.id)).toEqual([job.jobId]);
    expect((await svc.files("research", "usman"))).not.toBeNull();
    const thread = svc.thread("research", "usman", 0) as any;
    expect(thread.entries.length).toBeGreaterThan(0);
    expect(r.conversations.get(botThreadId("usman", "research"))).not.toBeNull();
    const edit = await svc.patch("research", { rev: archived.rev, purpose: "New." }, "usman");
    expect(edit.status).toBe(422);
    expect((edit.body as any).error).toContain("archived");
  });
});

describe("abilities match what an executor provides", () => {
  const bot = (patch: Partial<Bot>): Bot => ({ ...seedBots(1)[0], ...patch });
  const caps = { research: true, workflows: true, computers: ["research"], codingSlots: ["claude:max"] };
  const ids = (b: Bot, c = caps) => abilitiesOf(b, c).map((a) => a.id);
  test("computer abilities need a computer that exists; coding needs coding on AND a configured account", () => {
    expect(ids(bot({ computer: null }))).toEqual([]);
    expect(ids(bot({ computer: "ghost" }))).toEqual([]);
    expect(ids(bot({ computer: "research" }))).toEqual(["research", "builder", "audit", "bizprep"]);
    expect(ids(bot({ computer: "research" }, ), { ...caps, research: false })).toEqual(["builder", "audit", "bizprep"]);
    expect(ids(bot({ computer: null, coding: { enabled: true, accountSlot: "claude:max", model: null } }))).toEqual(["coding"]);
    expect(ids(bot({ computer: null, coding: { enabled: true, accountSlot: null, model: null } }))).toEqual(["coding"]);
    expect(ids(bot({ computer: null, coding: { enabled: true, accountSlot: "claude:max-9", model: null } }))).toEqual([]);
    expect(ids(bot({ computer: null, coding: { enabled: true, accountSlot: null, model: null } }), { ...caps, codingSlots: [] })).toEqual([]);
    expect(ids(bot({ computer: null, coding: { enabled: false, accountSlot: "claude:max", model: null } }))).toEqual([]);
  });
  test("skills are derived and read-only: they are the abilities' ids, whatever a stored list says, and a create or edit naming them is refused", async () => {
    const r = await rig();
    const b = reload(r).get("research")!;
    expect(((await r.agents.service.get("research", "usman", { thread: false }))!).skills).toEqual(["research", "builder", "audit", "bizprep"]);
    expect((await r.agents.service.patch("research", { rev: b.rev, skills: ["x"] }, "usman")).status).toBe(400);
    expect((await r.agents.service.create({ ...NEW, skills: ["research"] }, "usman")).status).toBe(400);
  });
});

describe("Jarvis refuses an archived bot", () => {
  const archive = async (r: Rig, id: string) => (await r.agents.service.archive(id, { rev: reload(r).get(id)!.rev, archived: true }, "usman")).status;
  test("by words, by target, by its conversation and by the open page: nothing runs, and it says so", async () => {
    const r = await rig();
    r.setBody(async () => ({ ok: true }));
    expect(await archive(r, "research")).toBe(200);
    const scope = (utterance: string, body: Record<string, unknown> = {}) => r.botCommands.scope({ principal: usman, utterance, body: body as never });
    for (const s of [
      scope("Ask Research to find clinics"),
      scope("Have the research bot compare vendors"),
      scope("find clinics", { target: { bot: "research" } }),
      scope("find clinics", { conversationId: botThreadId("usman", "research") }),
      scope("find clinics", { conversationId: "agent:usman:research" }),
      scope("show me its computer", { pageContext: { focused: { kind: "bot", id: "research" } } }),
    ]) {
      expect(s).toMatchObject({ kind: "refuse" });
      expect((s as { said: string }).said).toContain("Research is archived");
      expect((s as { said: string }).said).toContain("nothing ran");
    }
    // an active bot is unaffected; a plain request is still nobody's
    expect(scope("Ask Builder to build a card component")).toMatchObject({ kind: "bot", bot: { id: "builder" } });
    expect(scope("find clinics")).toBeNull();
    // an unknown bot lists only the ACTIVE ones
    expect((scope("do it", { target: { bot: "ghost" } }) as { said: string }).said).toContain("(the bots are Builder)");
    // the full command path: refused, no job
    const { say } = commandFor(r);
    const said = await say(usman, "Ask Research to find clinics", { eventId: "evt-jv01" });
    expect(said.ok).toBe(false);
    expect(JSON.stringify(said)).toContain("archived");
    expect(r.started).toEqual([]);
    // the bot's own run() and a routine's task refuse too (the one gate behind every way of asking)
    expect(await r.botCommands.run({ principal: usman, bot: "research", utterance: "find clinics", source: "typed" })).toMatchObject({ ok: false });
    expect(await r.botCommands.routineTask({ bot: "research", personId: "usman", goal: "find clinics", routine: "trig-morning-brief" })).toMatchObject({ ok: false });
    expect(r.started).toEqual([]);
  });

  test("'show me its computer' asks only about active bots; unarchiving makes the bot answer again", async () => {
    const r = await rig();
    expect(await archive(r, "research")).toBe(200);
    const scope = (utterance: string) => r.botCommands.scope({ principal: usman, utterance, body: {} as never });
    // only Builder has a computer among the active bots, so it is the one meant
    expect(scope("show me its computer")).toMatchObject({ kind: "bot", bot: { id: "builder" } });
    const research = reload(r).get("research")!;
    await r.agents.service.archive("research", { rev: research.rev, archived: false }, "usman");
    expect(scope("show me its computer")).toMatchObject({ kind: "ask" });
    expect(scope("Ask Research to find clinics")).toMatchObject({ kind: "bot", bot: { id: "research" } });
  });
});

describe("an existing bots.json loads as it is", () => {
  test("Research and Builder are unchanged by the migration: the file isn't rewritten on read, and the views show them active", async () => {
    const r = await rig();
    // an old file: exactly what seeding wrote before bots could be made (no createdBy, archived, history)
    const old = { version: 1, seededAt: 1_759_000_000_000, bots: seedBots(1_759_000_000_000) };
    const file = botsFile(r.root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(old, null, 2));
    const bytes = readFileSync(file, "utf8");
    const store = createBotStore({ file });
    expect(store.list()).toEqual(old.bots);
    expect(store.list().every((b) => !b.archived && !b.history && !b.createdBy)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    const views = (await r.agents.service.list()) as any[];
    expect(views.map((v) => [v.id, v.lifecycle, v.rev, v.sharesComputerWith.length])).toEqual([["research", "active", 1, 0], ["builder", "active", 1, 0]]);
    expect(views[0]).toMatchObject({ computer: "research", coding: { enabled: false }, memory: { recall: true, saveResults: true }, purpose: old.bots[0].purpose, instructions: old.bots[0].instructions });
    // an edit keeps every other field of the old record exactly
    const b = store.get("builder")!;
    const edited = store.patch("builder", b.rev, (x) => ({ ...x, purpose: "Edited." }));
    expect(edited.ok && edited.bot).toMatchObject({ id: "builder", purpose: "Edited.", computer: "builder", coding: old.bots[1].coding, rev: 2 });
    expect(existsSync(file)).toBe(true);
  });
});

// ── who may ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("identity: who may create, duplicate and archive", () => {
  const TOKEN = "page-token-for-tests";
  const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
  const confirmed: Principal = { personId: "mehroz", via: "paired-session", actor: "human", displayName: "Mehroz" };
  const bare: Principal = { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
  const gateway = { personId: "usman", via: "telegram-owner", actor: "human", displayName: "Usman" } as unknown as Principal;
  let rg: Rig;
  let server: Server;
  let base = "";
  let who: Principal | null = owner;
  let role = "pc";
  beforeAll(async () => {
    rg = await makeRig();
    const routes = createAgentsRoutes({ service: rg.agents.service, principal: () => who, tokenOk: (req: IncomingMessage) => req.headers["x-claude-os-token"] === TOKEN, role: () => role });
    server = createServer((req, res) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
      void routes.handle(req, res, () => ((res.statusCode = 404), res.end("{}")));
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((res) => server.close(() => res()));
    await rg.close();
  });
  const call = async (method: string, path: string, init: { body?: unknown; as?: Principal | null; token?: string | null } = {}) => {
    who = init.as === undefined ? owner : init.as;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token !== null && method !== "GET") headers["x-claude-os-token"] = init.token ?? TOKEN;
    const res = await fetch(`${base}/__agents${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const ids = () => createBotStore({ file: botsFile(rg.root) }).list().map((b) => b.id);

  test("the owner at the hub and a confirmed session may; the person is recorded", async () => {
    const a = await call("POST", "/bots", { body: { name: "Owner Bot", purpose: "x" } });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ id: "owner-bot", createdBy: "usman" });
    const b = await call("POST", "/bots", { body: { name: "Confirmed Helper", purpose: "x" }, as: confirmed });
    expect(b.status).toBe(201);
    expect(b.json.createdBy).toBe("mehroz");
    const d = await call("POST", "/bots/owner-bot/duplicate", { body: {}, as: confirmed });
    expect(d.status).toBe(201);
    expect(d.json).toMatchObject({ id: "owner-bot-copy", createdBy: "mehroz", duplicatedFrom: "owner-bot" });
    const ar = await call("POST", "/bots/owner-bot-copy/archive", { body: { rev: 1, archived: true }, as: confirmed });
    expect(ar.status).toBe(200);
    expect(ar.json.archived).toMatchObject({ by: "mehroz" });
    expect((await call("GET", "/bots")).json.bots.find((x: any) => x.id === "owner-bot-copy").lifecycle).toBe("archived");
    const un = await call("POST", "/bots/owner-bot-copy/archive", { body: { rev: 2, archived: false } });
    expect(un.status).toBe(200);
  });

  test("an unpaired Tailscale login can't; a gateway principal can't; a missing page token can't; nothing is written", async () => {
    const before = ids();
    for (const as of [bare, gateway, null]) {
      const refused = [
        await call("POST", "/bots", { body: { name: "Sneaky", purpose: "x" }, as }),
        await call("POST", "/bots/research/duplicate", { body: {}, as }),
        await call("POST", "/bots/builder/archive", { body: { rev: 1, archived: true }, as }),
      ];
      expect(refused.map((x) => x.status)).toEqual(as === bare ? [403, 403, 403] : [401, 401, 401]);
    }
    expect((await call("POST", "/bots", { body: { name: "No Token", purpose: "x" }, token: null })).status).toBe(403);
    expect((await call("POST", "/bots", { body: { name: "Bad Token", purpose: "x" }, token: "wrong" })).status).toBe(403);
    expect(ids()).toEqual(before);
    expect(createBotStore({ file: botsFile(rg.root) }).get("builder")!.archived).toBeUndefined();
  });

  test("on the headless server the same rule holds: a confirmed human session or the owner at the hub; a bare login is refused", async () => {
    role = "server";
    try {
      expect((await call("POST", "/bots", { body: { name: "Server Bot", purpose: "x" }, as: confirmed })).status).toBe(201);
      expect((await call("POST", "/bots", { body: { name: "Server Bare", purpose: "x" }, as: bare })).status).toBe(403);
      expect((await call("POST", "/bots/research/duplicate", { body: {}, as: bare })).status).toBe(403);
    } finally {
      role = "pc";
    }
  });

  test("the validation errors reach the caller: 400 per field, 409 for an id or name in use, 404, 405", async () => {
    const e = await call("POST", "/bots", { body: { name: "", purpose: "" } });
    expect(e.status).toBe(400);
    expect(e.json.errors.map((x: any) => x.field)).toEqual(expect.arrayContaining(["name", "purpose"]));
    const taken = await call("POST", "/bots", { body: { name: "Zeta", purpose: "x", id: "research" } });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe("id-taken");
    expect((await call("POST", "/bots/ghost/duplicate", { body: {} })).status).toBe(404);
    expect((await call("GET", "/bots/research/archive")).status).toBe(405);
    expect((await call("DELETE", "/bots")).status).toBe(405);
    const refused = await call("POST", "/bots/research/archive", { body: { rev: 99, archived: true } });
    expect(refused.status).toBe(409);
    expect(refused.json.current.id).toBe("research");
    await sleep(0);
  });
});

// ── the independent review's findings ────────────────────────────────────────────────────────────────────────────────────────────

describe("review 3: archiving releases the bot's routines", () => {
  const link = async (r: Rig, id: string, routines: string[]) => {
    const b = reload(r).get(id)!;
    return r.agents.service.patch(id, { rev: b.rev, routines }, "usman");
  };
  test("the routine stops running as the archived bot, is recorded as released, and can be linked to another bot; unarchive does not link it again", async () => {
    const r = await rig();
    expect((await link(r, "research", ["trig-morning-brief"])).status).toBe(200);
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toMatchObject({ bot: "research" });
    const rev = reload(r).get("research")!.rev;
    const ar = await r.agents.service.archive("research", { rev, archived: true }, "usman");
    expect(ar.status).toBe(200);
    expect(ar.body).toMatchObject({ routines: [], releasedRoutines: ["trig-morning-brief"], lifecycle: "archived" });
    expect(reload(r).get("research")).toMatchObject({ routines: [], releasedRoutines: ["trig-morning-brief"] });
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toBeNull();
    expect(await r.agents.routineHooks.botTask({ triggerId: "trig-morning-brief", goal: "find x" })).toBeNull();
    // it can now be linked to another bot (this was a 400 before)
    expect((await link(r, "builder", ["trig-morning-brief"])).status).toBe(200);
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toMatchObject({ bot: "builder" });
    // unarchive brings the bot back WITHOUT the link
    const un = await r.agents.service.archive("research", { rev: ar.body.rev as number, archived: false }, "usman");
    expect(un.body).toMatchObject({ lifecycle: "active", routines: [], releasedRoutines: ["trig-morning-brief"] });
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toMatchObject({ bot: "builder" });
  });

  test("'after current work' releases them at once, and the running job is untouched", async () => {
    const r = await rig();
    await link(r, "research", ["trig-morning-brief"]);
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const job = await say(usman, "Ask Research to find clinics", { eventId: "evt-rr01" });
    await waitFor(() => r.jobs.get(job.jobId!)?.state === "running");
    const rev = reload(r).get("research")!.rev;
    const ar = await r.agents.service.archive("research", { rev, archived: true, afterCurrentWork: true }, "usman");
    expect(ar.body).toMatchObject({ lifecycle: "archiving", routines: [], releasedRoutines: ["trig-morning-brief"] });
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toBeNull();
    expect(r.jobs.get(job.jobId!)!.state).toBe("running");
    h.release();
  });

  test("a routine an ARCHIVED bot still lists (an older file) doesn't block linking it to another bot", async () => {
    const r = await rig();
    await link(r, "research", ["trig-morning-brief"]);
    const store = reload(r);
    const b = store.get("research")!;
    // write the archived flag directly, keeping the routine on it, as a file made before this rule would have it
    const file = JSON.parse(readFileSync(botsFile(r.root), "utf8"));
    file.bots.find((x: Bot) => x.id === "research").archived = { at: 1, by: "usman", afterCurrentWork: false };
    writeFileSync(botsFile(r.root), JSON.stringify(file));
    expect(reload(r).get("research")!.routines).toEqual(["trig-morning-brief"]);
    expect(r.agents.routineHooks.asBot({ id: "trig-morning-brief" })).toBeNull();
    expect((await link(r, "builder", ["trig-morning-brief"])).status).toBe(200);
    expect(b.rev).toBeGreaterThan(0);
  });
});

describe("review 4 and 5: names Jarvis would capture, and one normaliser", () => {
  const make = async (r: Rig, name: string, extra: Record<string, unknown> = {}) => (await r.agents.service.create({ name, purpose: "x", ...extra }, "usman")) as { status: number; body: any };
  test("reserved words, people, single letters and names made only of those are refused (400), and none is created", async () => {
    const r = await rig();
    for (const name of ["it", "Jarvis", "that", "this", "me", "my", "the", "task", "job", "bot", "agent", "computer", "Usman", "Mehroz", "stop", "yes", "its", "The Bot", "my computer", "A", "7", "!!"]) {
      const out = await make(r, name);
      expect([name, out.status]).toEqual([name, 400]);
      expect(out.body.errors?.[0]?.field).toBe("name");
    }
    for (const id of ["jarvis", "it", "usman", "task", "workspace", "new", "tasks"]) expect([id, (await make(r, "Zedly", { id })).status]).toEqual([id, 400]);
    expect(reload(r).list().map((b) => b.id)).toEqual(["research", "builder"]);
    // a name with one ordinary word among them is fine, and still routes
    const ok = await make(r, "Scout bot");
    expect(ok.status).toBe(201);
    expect(r.botCommands.scope({ principal: usman, utterance: "Ask Scout bot to find suppliers", body: {} as never })).toMatchObject({ kind: "bot", bot: { id: "scout-bot" } });
  });

  test("the words Jarvis already routes keep meaning what they meant: 'stop it' and 'continue that task' are nobody's", async () => {
    const r = await rig();
    expect((await make(r, "it")).status).toBe(400);
    for (const u of ["stop it", "cancel that", "stop the task", "tell me to relax", "ask jarvis to find clinics"]) expect([u, r.botCommands.scope({ principal: usman, utterance: u, body: {} as never })]).toEqual([u, null]);
  });

  test("a name with no usable letters makes a free id, never the reserved word 'bot'", async () => {
    const r = await rig();
    const a = await make(r, "機器人");
    expect(a.status).toBe(201);
    expect(a.body.id).toBe("bot-2");
  });

  test("create and rename share one normaliser: control and zero-width characters go, whitespace collapses, and the same limits apply", async () => {
    const r = await rig();
    expect(normaliseName("Re\nsearch\u0007")).toBe("Re search");
    expect(normaliseName("  A​ \t B⁠﻿  ")).toBe("A B");
    const created = await make(r, "Scout\nTwo\u0007​");
    expect(created.body.name).toBe("Scout Two");
    // a rename gets exactly the same treatment
    const b = reload(r).get("builder")!;
    const renamed = await r.agents.service.patch("builder", { rev: b.rev, name: "Re\nsearcher\u0007" }, "usman");
    expect(renamed.status).toBe(200);
    expect((renamed.body as any).name).toBe("Re searcher");
    // invisible characters can't be used to dodge the uniqueness check (create or rename)
    expect((await make(r, "Scout​ Two")).status).toBe(409);
    const res = reload(r).get("research")!;
    const dodge = await r.agents.service.patch("research", { rev: res.rev, name: "Scout Two​" }, "usman");
    expect(dodge.status).toBe(400);
    expect((dodge.body as any).error).toContain("already answers");
    // limits are the same: 40 characters after normalising, and a rename to a reserved word or to nothing is refused
    expect((await make(r, `${"x".repeat(39)}​​ ab`)).status).toBe(400);
    expect((await r.agents.service.patch("research", { rev: res.rev, name: "stop" }, "usman")).status).toBe(400);
    expect((await r.agents.service.patch("research", { rev: res.rev, name: "​\u0007" }, "usman")).status).toBe(400);
  });
});

describe("review: the archive check and the write have no await between them", () => {
  test("a job that appears while the archive reads the coding source is seen, and archiving is refused", async () => {
    let armed = false;
    let calls = 0;
    let r!: Rig;
    r = await rig({
      onCodingRuntime: () => {
        // the second time the runtime is asked during the archive: the work appears after the old code had already looked at the computer's jobs
        if (armed && ++calls === 2) r.jobs.create({ kind: "control", principal: { personId: "usman", via: "loopback-owner", actor: "human" } as never, targetDeviceId: "dev-builder", title: "A job that started meanwhile", bot: "builder" });
      },
    });
    const b = reload(r).get("builder")!;
    armed = true;
    const out = await r.agents.service.archive("builder", { rev: b.rev, archived: true }, "usman");
    armed = false;
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ code: "has-running-work", work: [{ title: "A job that started meanwhile" }] });
    expect(reload(r).get("builder")!.archived).toBeUndefined();
  });
});

// ── leftovers from the second review ───────────────────────────────────────────────────────────────────────────────────────────

describe("who owns results and legacy coding jobs nobody recorded a bot for", () => {
  const UNATTRIBUTED = "11111111-2222-4333-8444-0000000000a1";
  const saveFor = (r: Rig, computer: string, jobId = UNATTRIBUTED) => r.artifacts.save({ jobId, personId: "usman", kind: "research", title: "old", summary: "s", host: "synthetic", computer, outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# r" }] } as never);
  const filesOf = async (r: Rig, id: string) => ((await r.agents.service.files(id, "usman"))!.files).map((f) => f.jobId);

  test("the OLDEST bot using the computer owns them: a later bot named after the computer doesn't take them, and they follow the oldest when the computer is reassigned", async () => {
    const r = await rig({ computers: ["research", "builder", "lab"] });
    const svc = r.agents.service;
    await svc.create({ name: "Zeta", purpose: "x", computer: "lab" }, "usman");
    await sleep(3);
    const lab = (await svc.create({ name: "Lab", purpose: "x", computer: "lab" }, "usman")).body as any; // id "lab" == the computer's name
    expect(lab.id).toBe("lab");
    saveFor(r, "lab");
    expect(await filesOf(r, "zeta")).toEqual([UNATTRIBUTED]);
    expect(await filesOf(r, "lab")).toEqual([]);
    // Zeta moves to another computer: the results are now the one remaining user's, never nobody's
    const z = reload(r).get("zeta")!;
    await svc.patch("zeta", { rev: z.rev, computer: "builder" }, "usman");
    expect(await filesOf(r, "lab")).toEqual([UNATTRIBUTED]);
    expect(await filesOf(r, "zeta")).toEqual([]);
    // an archived bot is the owner only while no active bot uses the computer
    const l = reload(r).get("lab")!;
    await svc.archive("lab", { rev: l.rev, archived: true }, "usman");
    expect(await filesOf(r, "lab")).toEqual([UNATTRIBUTED]);
    await svc.create({ name: "Newer", purpose: "x", computer: "lab" }, "usman");
    expect(await filesOf(r, "newer")).toEqual([UNATTRIBUTED]);
    expect(await filesOf(r, "lab")).toEqual([]);
  });

  test("the bots are read once per request, not once per result", async () => {
    const r = await rig();
    const count = async (n: number) => {
      for (let i = 0; i < n; i++) saveFor(r, "research", `11111111-2222-4333-8444-0000000001${String(i).padStart(2, "0")}`);
      let reads = 0;
      const list = r.agents.store.list;
      r.agents.store.list = () => (reads++, list());
      await r.agents.service.files("research", "usman");
      r.agents.store.list = list;
      return reads;
    };
    const few = await count(1);
    const many = await count(20);
    expect(many).toBe(few);
    expect(few).toBeLessThanOrEqual(3);
  });

  test("without a Builder, the legacy coding jobs go to the oldest coding-enabled bot only", async () => {
    const r = await rig();
    const seeded = seedBots(1_000);
    const coder = (id: string, createdAt: number): Bot => ({ ...seeded[1], id, name: id[0].toUpperCase() + id.slice(1), createdAt, updatedAt: createdAt, computer: null });
    const file = botsFile(r.root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, seededAt: 1, bots: [seeded[0], coder("later", 9_000), coder("earlier", 5_000)] }));
    r.codingJobs.push(fakeCodingJob({ id: "cj-old-0001", state: "building" }));
    const tasks = async (id: string) => ((await r.agents.service.tasks(id, "usman"))!.tasks).map((t) => t.id);
    expect(await tasks("earlier")).toEqual(["cj-old-0001"]);
    expect(await tasks("later")).toEqual([]);
    expect(await tasks("research")).toEqual([]);
  });
});

describe("a name that is another bot's name plus filler is confused with it when spoken", () => {
  test("'Builder Task', 'Research Computer', 'Builder Bot', 'The Builder', 'my research' are refused (create and rename); a name with a real extra word is fine", async () => {
    const r = await rig();
    const svc = r.agents.service;
    for (const name of ["Builder Task", "Research Computer", "Builder Bot", "The Builder", "my research", "A Research"]) {
      const out = await svc.create({ name, purpose: "x" }, "usman");
      expect([name, out.status]).toEqual([name, 409]);
      expect((out.body as any).error).toContain("confused with");
    }
    const b = reload(r).get("builder")!;
    const rename = await svc.patch("builder", { rev: b.rev, name: "The Research" }, "usman");
    expect(rename.status).toBe(400);
    expect((rename.body as any).error).toContain("confused with Research when spoken");
    // renaming a bot to its own name plus filler is not a clash with itself
    expect((await svc.patch("builder", { rev: b.rev, name: "The Builder" }, "usman")).status).toBe(200);
    expect((await svc.create({ name: "Builder Helper", purpose: "x" }, "usman")).status).toBe(201);
    expect(reload(r).list().map((x) => x.id)).toEqual(["research", "builder", "builder-helper"]);
  });
});

describe("a copy's name goes through the one normaliser", () => {
  test("invisible characters in the source's name don't reach the copy's name or id", () => {
    const deps: ValidationDeps = { computerExists: () => true, accountSlots: () => [], modelsFor: () => [], allModels: () => [], routerModels: () => [], routineIds: () => [], bots: () => [] };
    const copy = copyOf({ ...seedBots(1)[0], name: "Sco​ut\u0007\n Two" }, deps);
    expect(copy.name).toBe("Scout Two copy");
    expect(copy.id).toBe("scout-two-copy");
  });
});

describe("the takeover line says where to return control", () => {
  test("a paused-for-a-person progress entry points at Show computer beside the chat, not the old Computer tab", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    const h = hold();
    r.setBody(gated(h));
    const job = await say(usman, "Ask Research to find clinics", { eventId: "evt-tk01" });
    await waitFor(() => r.jobs.get(job.jobId!)?.state === "running");
    r.jobs.step(job.jobId!, { intent: "paused before the next step: Mehroz is taking control", executor: "computer.lease", ms: 0, outcome: "note" } as never);
    await waitFor(() => (r.conversations.get(botThreadId("usman", "research"))?.entries ?? []).some((e: any) => e.blocker?.kind === "needs-takeover"));
    const e = (r.conversations.get(botThreadId("usman", "research"))?.entries ?? []).find((x: any) => x.blocker?.kind === "needs-takeover") as any;
    expect(e.blocker).toMatchObject({ held: "other", recovery: "Mehroz has the controls. The job carries on when they hand them back." }); // Usman is reading; Mehroz holds them
    expect(e.blocker.recovery).not.toContain("Computer tab");
    h.release();
  });
});

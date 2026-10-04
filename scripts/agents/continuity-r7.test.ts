// Round 7, worker B: conversation continuity on the hub side.
//   - the thread route names a broken conversations store (503 with the hub's own sentence) instead of "Something went wrong";
//   - a command carrying an event id the conversation already holds is answered from the record, never run again: not after a hub restart (the
//     in-memory dedupe is gone), not after its window, not when the hub died between recording the request and the reply;
//   - an unreadable store refuses a bot command BEFORE anything starts, and says so.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { botThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { createAgentsRoutes } from "./routes";
import { commandFor, makeRig, sleep, usman, type Rig } from "./test-rig";

const rigs: Rig[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async () => {
  const r = await makeRig();
  rigs.push(r);
  return r;
};
const research = botThreadId("usman", "research");
const entries = (r: Rig) => r.conversations.get(research)?.entries ?? [];
/** Garble the saved conversations (a torn write, a bad edit): the file exists and cannot be parsed. */
const corrupt = (r: Rig) => {
  mkdirSync(dataDirFor(r.root), { recursive: true });
  writeFileSync(join(dataDirFor(r.root), "conversations.json"), "{ not json");
};

async function routesOver(r: Rig, who: Principal) {
  const routes = createAgentsRoutes({ service: r.agents.service, principal: () => who, tokenOk: () => true, role: () => "pc" });
  const server = createServer((req: IncomingMessage, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    void routes.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the thread read names a broken conversations store", () => {
  test("an unreadable conversations file is a 503 with the hub's own sentence, and the file is left untouched (it was a bare 500 'Something went wrong')", async () => {
    const r = await rig();
    r.conversations.ensureThread({ personId: "usman", bot: "research", title: "Research" });
    corrupt(r);
    const base = await routesOver(r, usman);
    const res = await fetch(`${base}/__agents/bots/research/thread?after=0`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Saved conversations could not be read. Your history was left untouched.");
    const file = await Bun.file(join(dataDirFor(r.root), "conversations.json")).text();
    expect(file).toBe("{ not json");
  });

  test("the bot's own record (GET /bots/:id) says the same, so the page knows it is the store and not the bot", async () => {
    const r = await rig();
    corrupt(r);
    const base = await routesOver(r, usman);
    const res = await fetch(`${base}/__agents/bots/research`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("Saved conversations could not be read");
  });

  test("a store that simply does not exist yet is not a fault: the thread is empty and the read works", async () => {
    const r = await rig();
    const base = await routesOver(r, usman);
    const res = await fetch(`${base}/__agents/bots/research/thread?after=0`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });
});

describe("a command the conversation already holds is never run again", () => {
  test("the same event id after a hub restart (a fresh command service, no in-memory dedupe): one job in all, the first reply is returned", async () => {
    const r = await rig();
    const hold = new Promise<void>(() => undefined);
    r.setBody(async () => (await hold, { ok: true, note: "never" }));
    const first = commandFor(r);
    const a = await first.say(usman, "find the licence classes for home building in NSW", { conversationId: research, target: { bot: "research" }, eventId: "evt-restart-1" });
    expect(a.ok).toBe(true);
    expect(r.started).toHaveLength(1);
    // The hub restarts: a new service with an empty dedupe window over the same durable conversation.
    const second = commandFor(r);
    const b = await second.say(usman, "find the licence classes for home building in NSW", { conversationId: research, target: { bot: "research" }, eventId: "evt-restart-1" });
    expect(r.started).toHaveLength(1);
    expect(b.numbers).toMatchObject({ replayed: true, jobId: a.jobId });
    expect(b.jobId).toBe(a.jobId);
    expect(b.said).toBe(entries(r).find((e) => e.key === "evt-restart-1:ack")!.text);
    // Nothing was added to the thread by the replay.
    expect(entries(r).map((e) => e.key)).toEqual(["evt-restart-1:request", `${a.jobId}:started`, "evt-restart-1:ack"]);
  });

  test("the hub died after recording the request and before the reply, with a job that may have started: the resend is not run, and the answer says it is unconfirmed (never 'did not start')", async () => {
    const r = await rig();
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-torn-1", role: "request", text: "find the best dental software" });
    r.conversations.appendEntry(research, { key: "0a1b2c3d-1111-4222-8333-444455556666:started", jobId: "0a1b2c3d-1111-4222-8333-444455556666", state: "started", text: "Started: x (job 0a1b2c3d)." });
    const { say } = commandFor(r);
    const d = await say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-torn-1" });
    expect(r.started).toHaveLength(0);
    expect(d).toMatchObject({ ok: false, kind: "unavailable", outcome: "unverified" });
    expect(d.said).toContain("not run again");
  });

  test("a request that was logged but NEVER ran (no reply, no job, no receipt) can be sent again with the same event id: it runs once", async () => {
    const r = await rig();
    r.setBody(async () => ({ ok: true, note: "x" }));
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-never-1", role: "request", text: "find the best dental software" });
    const { say } = commandFor(r);
    const d = await say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-never-1" });
    expect(d.ok).toBe(true);
    expect(r.started).toHaveLength(1);
    const keys = entries(r).map((e) => e.key);
    expect(keys.filter((k) => k === "evt-never-1:request")).toHaveLength(1);
    expect(keys.filter((k) => k === "evt-never-1:ack")).toHaveLength(1);
    // And now it is a command that ran: asking again replays, never runs a second time.
    const again = await commandFor(r).say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-never-1" });
    expect(again.numbers).toMatchObject({ replayed: true });
    expect(r.started).toHaveLength(1);
  });

  test("a run that THROWS leaves an unverified reply and durable admission; resend never guesses that nothing started", async () => {
    const r = await rig();
    r.setBody(async () => ({ ok: true, note: "x" }));
    const create = r.jobs.create.bind(r.jobs);
    let broken = true;
    (r.jobs as { create: typeof r.jobs.create }).create = ((...a: Parameters<typeof r.jobs.create>) => {
      if (broken) throw new Error("disk full");
      return create(...a);
    }) as typeof r.jobs.create;
    let failed = false;
    await commandFor(r).say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-throw-1" }).then((d) => { failed = d.ok === false; }, () => { failed = true; });
    expect(failed).toBe(true);
    const reply = entries(r).find((e) => e.key === "evt-throw-1:ack");
    expect(reply).toMatchObject({ ok: false });
    expect(reply!.unverified).toBe(true);
    expect(r.jobs.list({ bot: "research" })).toHaveLength(0); // missing job metadata cannot prove an external call did not happen
    broken = false;
    const second = await commandFor(r).say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-throw-1" });
    expect(second).toMatchObject({ ok: false, outcome: "unverified", numbers: { replayed: true } });
    expect(r.jobs.list({ bot: "research" })).toHaveLength(0);
    const ack = entries(r).filter((e) => e.key === "evt-throw-1:ack");
    expect(ack).toHaveLength(1);
    expect(ack[0]).toMatchObject({ ok: false, unverified: true }); // the unresolved result is not replaced with invented success
  });

  test("a replay carries the ORIGINAL verdict: a command that failed (or was a stop) is not reported as a success after a restart", async () => {
    const r = await rig();
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-failed-1", role: "request", text: "do the thing" });
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-failed-1", role: "ack", text: "That did not finish, so nothing ran.", jobId: "0a1b2c3d-1111-4222-8333-444455556666", ok: false });
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-ok-1", role: "request", text: "do the other thing" });
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-ok-1", role: "ack", text: "On it.", jobId: "0a1b2c3d-1111-4222-8333-444455556666", ok: true });
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-stop-1", role: "request", text: "stop that" });
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-stop-1", role: "ack", text: "Stopped it.", jobId: "0a1b2c3d-1111-4222-8333-444455556666", ok: true, stopped: true });
    const { say } = commandFor(r);
    const ask = (id: string) => say(usman, "x", { conversationId: research, target: { bot: "research" }, eventId: id });
    expect(await ask("evt-failed-1")).toMatchObject({ ok: false, numbers: { replayed: true } });
    expect(await ask("evt-ok-1")).toMatchObject({ ok: true });
    expect(await ask("evt-stop-1")).toMatchObject({ ok: true, stopped: true });
    expect(r.started).toHaveLength(0);
  });

  test("a bot command's reply records its own verdict", async () => {
    const r = await rig();
    r.setBody(async () => ({ ok: true, note: "x" }));
    await commandFor(r).say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-verdict-1" });
    expect(entries(r).find((e) => e.key === "evt-verdict-1:ack")).toMatchObject({ ok: true });
  });

  test("a different person's identical event id is their own command (the record is per person and bot)", async () => {
    const r = await rig();
    r.setBody(async () => ({ ok: true, note: "x" }));
    const { say } = commandFor(r);
    const mehroz: Principal = { personId: "mehroz", via: "paired-session", actor: "human", displayName: "Mehroz" };
    await say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-shared-id" });
    await sleep(20);
    const m = await say(mehroz, "find the best dental software", { conversationId: botThreadId("mehroz", "research"), target: { bot: "research" }, eventId: "evt-shared-id" });
    expect((m.numbers as { replayed?: boolean } | undefined)?.replayed).toBeUndefined();
    expect(r.started.map((s) => s.by)).toEqual(["usman", "mehroz"]);
  });

  test("an unreadable store refuses the command before anything starts, and says why (it used to surface as a generic fault)", async () => {
    const r = await rig();
    r.conversations.ensureThread({ personId: "usman", bot: "research", title: "Research" });
    corrupt(r);
    const { say } = commandFor(r);
    const d = await say(usman, "find the best dental software", { conversationId: research, target: { bot: "research" }, eventId: "evt-broken-1" });
    expect(r.started).toHaveLength(0);
    expect(d.ok).toBe(false);
    expect(d.said).toContain("Saved conversations could not be read");
    expect(d.said).toContain("Nothing was started");
  });
});

describe("job ids and notes in the conversation", () => {
  test("a job reference is kept as written ('job db837321', a full id); real phone-like digit runs are still masked", async () => {
    const { maskJobText } = await import("../jarvis-command/threads");
    expect(maskJobText("On it. (job db837321)")).toBe("On it. (job db837321)");
    expect(maskJobText("Started: x (job 0a1b2c3d).")).toBe("Started: x (job 0a1b2c3d).");
    expect(maskJobText("job 0a1b2c3d-1111-4222-8333-444455556666 finished")).toBe("job 0a1b2c3d-1111-4222-8333-444455556666 finished");
    const masked = maskJobText("call 0412 345 678 about (job db837321) and card 4111111111111111");
    expect(masked).toContain("(job db837321)");
    expect(masked).not.toContain("0412 345 678");
    expect(masked).not.toContain("4111111111111111");
    expect(masked.match(/\[number\]/g)).toHaveLength(2);
  });

  test("the receipt of a bot command keeps its job id readable in the stored reply", async () => {
    const r = await rig();
    r.threads.note({ personId: "usman", bot: { id: "research", name: "Research" }, commandId: "evt-id-1", role: "ack", text: "On it. (job db837321)" });
    expect(entries(r).find((e) => e.key === "evt-id-1:ack")!.text).toBe("On it. (job db837321)");
  });
});

describe("plain words: memory notes and who has the controls", () => {
  test("every memory note variant is plain: no config name, switch, id or the hub's own refusal text", async () => {
    const { memoryNote } = await import("./automation");
    const notes = [
      memoryNote({ ok: true, message: "Remembered as mem-3b20eebb69 (MU_MEMORY_WRITES on)" }),
      memoryNote({ ok: false, message: "Memory writing is off (MU_MEMORY_WRITES is not on), so nothing was saved or changed. The lead switches it on after acceptance." }),
      memoryNote({ ok: false, message: "Screened out: looks like a secret" }),
      memoryNote({ ok: false, message: "ECONNRESET 127.0.0.1:8888 mem-123" }),
    ];
    expect(notes).toEqual([
      "Saved the outcome to shared memory.",
      "Not saved to shared memory: saving is switched off on this hub.",
      "Not saved to shared memory: it looked like it held private details, so it was left out.",
      "Not saved to shared memory: it could not be saved just now.",
    ]);
    for (const n of notes) expect(n).not.toMatch(/MU_|mem-|lead|acceptance|ECONN|127\.0|env|config/i);
  });

  test("a person took the computer: the holder reads one calm sentence; the other founder reads that it carries on when handed back", async () => {
    const { takeoverBlocker } = await import("../jarvis-command/threads");
    const mine = takeoverBlocker("usman", "usman");
    expect(mine).toEqual({ kind: "needs-takeover", held: "you", recovery: "Paused while you have the controls. Return them when you're done." });
    const theirs = takeoverBlocker("mehroz", "usman");
    expect(theirs).toMatchObject({ kind: "needs-takeover", held: "other", recovery: "Mehroz has the controls. The job carries on when they hand them back." });
    expect(mine.recovery).not.toMatch(/wait|hand it back|hand them back/i);
  });
});

// Review fix B (2 Oct 2026): paging of older coding jobs, one bot per routine, the routine-run identity, and the saved-results marker race.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAtHub, isBrowserPrincipal, isHumanSession } from "../identity/principal";
import { isPrincipal } from "../approvals/principal";
import { createRoutineLinks, memorySavesFile, routineLinksFile } from "./automation";
import { botThreadId, botConversationKey, jarvisThreadId } from "../conversations";
import { commandRoute } from "../jarvis-command/route";
import type { Principal } from "../identity/principal";
import { commandFor, fakeCodingJob, makeRig, mehroz, sleep, usman, waitFor, type Rig } from "./test-rig";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async (o: Parameters<typeof makeRig>[0] = {}) => {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
};

describe("6. task paging reaches older coding jobs", () => {
  test("page 2 holds the next older coding jobs, not what is left of the newest few", async () => {
    const r = await rig();
    // Newest first, as the store lists them.
    for (let i = 5; i >= 1; i--) r.codingJobs.push(fakeCodingJob({ id: `0000000${i}-0000-4000-8000-000000000000`, state: "succeeded", objective: `job ${i}`, createdAt: `2026-10-02T0${i}:00:00.000Z`, updatedAt: `2026-10-02T0${i}:30:00.000Z` }));
    const p1 = (await r.agents.service.tasks("builder", "usman", { limit: 2 }))!;
    expect(p1.tasks.map((t) => t.title)).toEqual(["job 5", "job 4"]);
    const p2 = (await r.agents.service.tasks("builder", "usman", { limit: 2, before: p1.before! }))!;
    expect(p2.tasks.map((t) => t.title)).toEqual(["job 3", "job 2"]);
    const p3 = (await r.agents.service.tasks("builder", "usman", { limit: 2, before: p2.before! }))!;
    expect(p3.tasks.map((t) => t.title)).toEqual(["job 1"]);
    expect(p3.before).toBeNull();
  });
});

describe("7. a routine runs as exactly one bot", () => {
  test("linking a routine already linked to another bot is a 400 that names the bot; the same bot may keep it; after unlinking it can move", async () => {
    const r = await rig({ routines: ["trg-a", "trg-b"] });
    expect((await r.agents.service.patch("research", { rev: 1, routines: ["trg-a"] }, "mehroz")).status).toBe(200);
    const clash = await r.agents.service.patch("builder", { rev: 1, routines: ["trg-a", "trg-b"] }, "usman");
    expect(clash.status).toBe(400);
    expect((clash.body as { error: string }).error).toContain("trg-a is already linked to Research");
    expect(r.agents.store.get("builder")!.routines).toEqual([]);
    expect((await r.agents.service.patch("research", { rev: 2, routines: ["trg-a", "trg-b"] }, "mehroz")).status).toBe(200);
    expect((await r.agents.service.patch("research", { rev: 3, routines: ["trg-b"] }, "mehroz")).status).toBe(200);
    expect((await r.agents.service.patch("builder", { rev: 1, routines: ["trg-a"] }, "usman")).status).toBe(200);
  });

  test("unlinking from one bot keeps the owner while another bot still lists the routine (older data that holds it on two bots)", async () => {
    const r = await rig({ routines: ["trg-a"] });
    await r.agents.service.patch("research", { rev: 1, routines: ["trg-a"] }, "mehroz");
    // Older data: the same routine on the second bot too (bypassing the new check).
    r.agents.store.patch("builder", 1, (b) => ({ ...b, routines: ["trg-a"] }));
    await r.agents.service.patch("research", { rev: 2, routines: [] }, "mehroz");
    expect(createRoutineLinks(routineLinksFile(r.root)).owner("trg-a")).toBe("mehroz");
  });
});

describe("8. a routine run is its own kind of caller, never the owner at the PC", () => {
  test("the principal a routine's task starts with has via routine: no browser, no hub owner, no human session; the approvals layer still accepts it as a principal", async () => {
    const r = await rig({ routines: ["trg-a"] });
    await r.agents.service.patch("research", { rev: 1, routines: ["trg-a"] }, "mehroz");
    r.setBody(async () => (await sleep(20), { ok: true }));
    const out = await r.agents.routineHooks.botTask({ triggerId: "trg-a", goal: "find new clinics" });
    expect(out?.ok).toBe(true);
    const p = r.started[0].principal as { via: string; actor: string; personId: string };
    expect(p).toMatchObject({ via: "routine", actor: "process", personId: "mehroz" });
    expect(isAtHub(p as never)).toBe(false);
    expect(isBrowserPrincipal(p as never)).toBe(false);
    expect(isHumanSession(p as never)).toBe(false);
    expect(isPrincipal(p)).toBe(true);
  });

  test("the trigger engine's own principal is the same: via routine", async () => {
    const { TriggerEngine } = await import("../triggers/engine");
    const e = new TriggerEngine({ store: {} as never, jobs: {} as never, approvals: {} as never });
    expect((e as unknown as { principal: { via: string } }).principal.via).toBe("routine");
  });
});

describe("saved-results marker: two jobs ending at once both keep their mark", () => {
  test("both <jobId>:result marks persist, and each is remembered exactly once", async () => {
    const r = await rig({ lease: false });
    r.agents.startMemory();
    r.setRememberDelay(80);
    const { say } = commandFor(r);
    r.setBody(async (jobId) => {
      r.artifacts.save({ jobId, personId: "usman", kind: "research", title: `Research ${jobId.slice(0, 4)}`, summary: "Complete report: 2 facts.", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# r" }] });
      await sleep(40);
      return { ok: true, note: "saved" };
    });
    const [a, b] = await Promise.all([say(usman, "Ask Research to profile Alpha Dental", { eventId: "evt-race-alpha" }), say(usman, "Ask Research to profile Beta Dental", { eventId: "evt-race-beta" })]);
    expect(a.jobId && b.jobId && a.jobId !== b.jobId).toBeTruthy();
    await waitFor(() => r.memoryCalls.remember.length === 2);
    const file = memorySavesFile(r.root);
    await waitFor(() => existsSync(file) && Object.keys(JSON.parse(readFileSync(file, "utf8")).keys).length === 2);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).keys).sort()).toEqual([`${a.jobId}:result`, `${b.jobId}:result`].sort());
    await sleep(150);
    expect(r.memoryCalls.remember).toHaveLength(2);
  });
});

describe("A. an unpaired login never reaches an agent through the command path", () => {
  const bare: Principal = { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
  const routine: Principal = { personId: "mehroz", via: "routine", actor: "process", displayName: "Mehroz" };

  test("a bare tailnet login targeting a bot: refused with a reason, nothing written to the bot thread, no job started", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => ({ ok: true }));
    const out = await say(bare, "find new dental clinics", { target: { bot: "research" }, eventId: "evt-bare-001" });
    expect(out.ok).toBe(false);
    expect(out.said).toContain("confirmed sign-in");
    expect(r.conversations.get(botThreadId("mehroz", "research"))).toBeNull();
    expect(r.conversations.list()).toHaveLength(0);
    expect(r.started).toHaveLength(0);
    expect(r.jobs.list({}).length).toBe(0);
    // ...also when the bot is named by the conversation it was typed in, or by the words.
    const viaKey = await say(bare, "find clinics", { conversationId: botConversationKey("mehroz", "research"), eventId: "evt-bare-002" });
    expect(viaKey.ok).toBe(false);
    const viaWords = await say(bare, "Ask Research to find clinics", { eventId: "evt-bare-003" });
    expect(viaWords.ok).toBe(false);
    expect(r.conversations.list()).toHaveLength(0);
    expect(r.started).toHaveLength(0);
  });

  test("a confirmed person and the owner at the hub still run the bot; a routine run still runs as the bot and writes to the linker's bot thread", async () => {
    const r = await rig();
    const { say } = commandFor(r);
    r.setBody(async () => (await sleep(20), { ok: true }));
    // one job at a time (the computer's lease): each starts once the last has ended
    const free = () => waitFor(() => r.views.get("research")!.state === "online");
    const human = await say(mehroz, "find clinics", { target: { bot: "research" }, eventId: "evt-human-001" });
    expect(human.ok).toBe(true);
    expect(r.conversations.get(botThreadId("mehroz", "research"))).not.toBeNull();
    await free();
    const owner = await say(usman, "find clinics", { target: { bot: "research" }, eventId: "evt-owner-001" });
    expect(owner.ok).toBe(true);
    // A routine run: through the same command path it is allowed, and through the hooks the engine uses it writes the linker's bot thread.
    await free();
    const viaCommand = await say(routine, "find clinics", { target: { bot: "research" }, eventId: "evt-routine-001" });
    expect(viaCommand.ok).toBe(true);
    await r.agents.service.patch("research", { rev: 1, routines: ["trig-morning-brief"] }, "mehroz");
    await free();
    const out = await r.agents.routineHooks.botTask({ triggerId: "trig-morning-brief", goal: "find new clinics" });
    expect(out?.ok).toBe(true);
    await waitFor(() => (r.conversations.get(botThreadId("mehroz", "research"))?.jobs ?? []).length >= 2);
  });

  test("reading a bot thread through /screen/command/thread needs the same: a bare login gets a 403 (by key or by id); the default thread is unchanged", async () => {
    const r = await rig();
    const { service } = commandFor(r);
    await r.agents.service.get("research", "mehroz");
    const read = async (principal: Principal, conversation: string) => {
      let status = 200;
      let value: unknown = null;
      await commandRoute({ path: "/screen/command/thread", method: "GET", url: new URL(`http://x/screen/command/thread?conversation=${encodeURIComponent(conversation)}`), body: null, principal, req: {} as never, res: {} as never, service, send: (v, s) => { value = v; status = s ?? 200; } });
      return { status, value };
    };
    expect((await read(bare, botConversationKey("mehroz", "research"))).status).toBe(403);
    expect((await read(bare, botThreadId("mehroz", "research"))).status).toBe(403);
    expect((await read(mehroz, botConversationKey("mehroz", "research"))).status).toBe(200);
    expect((await read(mehroz, botThreadId("mehroz", "research"))).status).toBe(200);
    expect((await read(bare, jarvisThreadId("mehroz"))).status).toBe(200);
  });
});

describe("C. the paging cursor is exact across a shared millisecond", () => {
  test("four coding jobs created in the same millisecond are each seen exactly once across pages of two", async () => {
    const r = await rig();
    for (const n of [4, 3, 2, 1]) r.codingJobs.push(fakeCodingJob({ id: `0000000${n}-0000-4000-8000-000000000000`, state: "succeeded", objective: `tie ${n}`, createdAt: "2026-10-02T05:00:00.000Z", updatedAt: "2026-10-02T05:00:00.000Z" }));
    r.codingJobs.push(fakeCodingJob({ id: "00000009-0000-4000-8000-000000000000", state: "succeeded", objective: "older", createdAt: "2026-10-02T04:00:00.000Z" }));
    const seen: string[] = [];
    let cursor: { before?: number; beforeId?: string } = {};
    for (let i = 0; i < 6; i++) {
      const page = (await r.agents.service.tasks("builder", "usman", { limit: 2, ...cursor }))!;
      seen.push(...page.tasks.map((t) => t.title));
      if (page.before === null) break;
      cursor = { before: page.before, beforeId: page.beforeId! };
    }
    expect(seen).toEqual(["tie 4", "tie 3", "tie 2", "tie 1", "older"]);
  });
});

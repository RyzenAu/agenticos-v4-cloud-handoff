// The Agents workspace service on real stores: bots with live readiness, the merged task list and files list, the per-person conversation, PATCH
// outcomes, and the /__jobs filters that carry `bot` and CRM `subjects`.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import { botConversationKey, botThreadId, jarvisThreadId } from "../conversations";
import { jobsApprovalsRoute } from "../jobs/routes";
import { computerView, fakeCodingJob, makeRig, sleep, usageEvent, usman, type Rig } from "./test-rig";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async (o: Parameters<typeof makeRig>[0] = {}) => {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
};
const principal = { personId: "usman", via: "loopback-owner", actor: "human" } as never;
const asJob = (r: Rig, input: { bot?: string; subjects?: string[]; device?: string; title?: string; person?: string }) =>
  r.jobs.create({ kind: "control", principal: { personId: input.person ?? "usman", via: "loopback-owner", actor: "human" } as never, targetDeviceId: input.device ?? "dev-research", title: input.title ?? "a task", ...(input.bot ? { bot: input.bot } : {}), ...(input.subjects ? { subjects: input.subjects } : {}) });

describe("bots with live readiness and one conversation per person and bot", () => {
  test("list: Research and Builder, ready, with readiness derived from the computers and the accounts", async () => {
    const r = await rig();
    const bots = await r.agents.service.list();
    expect(bots.map((b) => [b.id, b.readiness.state])).toEqual([["research", "ready"], ["builder", "ready"]]);
    // Nothing about readiness is stored: stop the computer and the very next read says so.
    r.views.set("research", computerView("research", { state: "offline", desired: "stopped" }));
    const again = await r.agents.service.list();
    expect(again[0].readiness).toMatchObject({ state: "offline", reasons: [{ code: "computer-stopped" }] });
    expect(JSON.stringify(r.agents.store.get("research"))).not.toContain("readiness");
  });

  test("Builder's coding readiness is the accounts service's answer: a signed-out Claude account named in Setup is not ready", async () => {
    const r = await rig({ claude: { "claude:max-2": false } });
    const done = await r.agents.service.patch("builder", { rev: 1, coding: { enabled: true, accountSlot: "claude:max-2", model: null } });
    expect(done.status).toBe(200);
    const builder = (await r.agents.service.get("builder", "usman"))!;
    expect(builder.readiness.parts.coding).toMatchObject({ state: "offline", reason: { code: "coding-account-not-ready", fix: { kind: "sign-in", target: "claude:max-2" } } });
    expect(builder.readiness.parts.computer?.state).toBe("ready");
  });

  test("get: the conversation id is deterministic per person and bot, and the conversation is created with ensureThread (once)", async () => {
    const r = await rig();
    const one = (await r.agents.service.get("research", "usman"))!;
    expect(one.conversationId).toBe(botThreadId("usman", "research"));
    expect(one.conversationKey).toBe(botConversationKey("usman", "research"));
    expect(one.conversationId).not.toBe(botThreadId("mehroz", "research"));
    expect(one.conversationId).not.toBe(botThreadId("usman", "builder"));
    expect(one.conversationId).not.toBe(jarvisThreadId("usman"));
    const c = r.conversations.get(one.conversationId)!;
    expect(c).toMatchObject({ thread: "bot", bot: "research", personId: "usman", title: "Research" });
    await r.agents.service.get("research", "usman");
    expect(r.conversations.list().filter((x) => x.bot === "research").length).toBe(1);
    expect(await r.agents.service.get("nobody", "usman")).toBeNull();
  });

  test("thread: this person's entries after a seq, never another person's, never created by a read", async () => {
    const r = await rig();
    expect(r.agents.service.thread("research", "usman", 0)).toMatchObject({ entries: [], last: 0 });
    expect(r.conversations.list().length).toBe(0);
    const t = (await r.agents.service.get("research", "usman"))!;
    r.conversations.appendEntry(t.conversationId, { key: "a:started", jobId: "j", state: "started", text: "Started: x (job aaaaaaaa)." });
    r.conversations.appendEntry(t.conversationId, { key: "a:succeeded", jobId: "j", state: "succeeded", text: "Finished: x." });
    const all = r.agents.service.thread("research", "usman", 0)!;
    expect(all.entries.map((e) => [e.seq, e.key])).toEqual([[1, "a:started"], [2, "a:succeeded"]]);
    expect(all.entries[0]).toMatchObject({ seq: 1, key: "a:started", jobId: "j", state: "started", text: expect.any(String), at: expect.any(String) });
    expect(r.agents.service.thread("research", "usman", 1)!.entries.map((e) => e.seq)).toEqual([2]);
    expect(r.agents.service.thread("research", "usman", 2)).toMatchObject({ entries: [], last: 2 });
    // Mehroz asks for the same bot and gets HIS conversation: empty.
    expect(r.agents.service.thread("research", "mehroz", 0)).toMatchObject({ entries: [], conversationId: botThreadId("mehroz", "research") });
  });
});

describe("PATCH outcomes", () => {
  test("200 returns the updated bot with readiness; 409 returns the stored bot as `current` and writes nothing; 400 names the field; 404", async () => {
    const r = await rig();
    const ok = await r.agents.service.patch("research", { rev: 1, purpose: "Reads the web." });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: "research", rev: 2, purpose: "Reads the web.", readiness: { state: "ready" } });
    const stale = await r.agents.service.patch("research", { rev: 1, purpose: "Other." });
    expect(stale.status).toBe(409);
    expect((stale.body as { current: { rev: number; purpose: string } }).current).toMatchObject({ rev: 2, purpose: "Reads the web." });
    expect(r.agents.store.get("research")?.purpose).toBe("Reads the web.");
    const bad = await r.agents.service.patch("research", { rev: 2, computer: "ghost" });
    expect(bad.status).toBe(400);
    expect((bad.body as { errors: Array<{ field: string }> }).errors[0].field).toBe("computer");
    expect((await r.agents.service.patch("nobody", { rev: 1, purpose: "x" })).status).toBe(404);
  });

  test("a coding.enabled change is refused whatever else is in the body", async () => {
    const r = await rig();
    const out = await r.agents.service.patch("research", { rev: 1, coding: { enabled: true, accountSlot: null, model: null } });
    expect(out.status).toBe(400);
    expect(r.agents.store.get("research")?.coding.enabled).toBe(false);
  });
});

describe("tasks: computer jobs and coding jobs in one list", () => {
  test("merged newest first; a computer job carries its saved result; coding rows carry branch, commit, review, tests and the account and model that ACTUALLY ran", async () => {
    const r = await rig();
    const t0 = Date.now();
    const a = asJob(r, { bot: "research", title: "Find clinics", device: "dev-research" });
    r.jobs.begin(a.id);
    r.jobs.finish(a.id, "succeeded", "done");
    r.artifacts.save({ jobId: a.id, personId: "usman", kind: "research", title: "Research: clinics", summary: "Complete report", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# Report" }] });
    await sleep(15);
    const b = asJob(r, { title: "Open the page", device: "dev-research" });
    await sleep(2);
    r.jobs.begin(b.id);
    r.jobs.finish(b.id, "failed", "the page timed out");
    // Another computer's job is NOT Research's; a job made FOR research on a different device is.
    await sleep(8);
    asJob(r, { title: "Builder's own", device: "dev-builder", bot: "builder" });
    await sleep(8);
    asJob(r, { title: "Made for research elsewhere", device: "dev-elsewhere", bot: "research" });
    r.codingJobs.push(fakeCodingJob({ id: "11111111-1111-4111-8111-111111111111", state: "completed", head: "abc1234", files: [{ path: "src/footer.tsx", status: "modified" }], review: { verdict: "approve", severities: ["minor"] }, tests: [{ commandId: "unit", passed: 12, failed: 0, exitCode: 0 }], createdAt: new Date(t0 + 60_000).toISOString(), updatedAt: new Date(t0 + 120_000).toISOString() }));
    r.codingEvents.set("11111111-1111-4111-8111-111111111111", [usageEvent("claude:max-2", "claude-opus-5-5"), usageEvent("claude:max-2", "claude-sonnet-5-5", "coding.review")]);

    const research = (await r.agents.service.tasks("research", "usman"))!;
    expect(research.tasks.map((t) => t.title)).toEqual(["Made for research elsewhere", "Open the page", "Find clinics"]);
    expect(research.tasks.every((t) => t.kind === "computer")).toBe(true);
    const find = research.tasks.find((t) => t.title === "Find clinics")!;
    expect(find).toMatchObject({ id: a.id, state: "succeeded", phase: "done", resultArtifact: `artifact:${a.id}` });
    expect(typeof find.endedAt).toBe("number");
    expect(research.tasks.find((t) => t.title === "Open the page")).toMatchObject({ state: "failed", phase: "failed", blocker: "the page timed out" });

    const builder = (await r.agents.service.tasks("builder", "usman"))!;
    expect(builder.tasks.map((t) => [t.kind, t.title])).toEqual([["coding", "Fix the footer year"], ["computer", "Builder's own"]]);
    const coding = builder.tasks[0];
    expect(coding).toMatchObject({ state: "completed", phase: "done", commit: "abc1234", branch: expect.stringContaining("coding/fix-footer"), review: { verdict: "approve", blockers: 0, majors: 0, minors: 1 }, tests: { passed: 12, failed: 0 }, account: "claude:max-2", model: "claude-sonnet-5-5" });
    expect(coding.receipts).toEqual([{ account: "claude:max-2", model: "claude-opus-5-5", role: "builder" }, { account: "claude:max-2", model: "claude-sonnet-5-5", role: "reviewer" }]);
    // Research has coding off: no coding rows, however many coding jobs exist.
    expect(research.tasks.some((t) => t.kind === "coding")).toBe(false);
  });

  test("limit and before page back through the list", async () => {
    const r = await rig();
    for (let i = 0; i < 5; i++) {
      asJob(r, { title: `task ${i}`, bot: "research" });
      await sleep(5);
    }
    const first = (await r.agents.service.tasks("research", "usman", { limit: 2 }))!;
    expect(first.tasks.map((t) => t.title)).toEqual(["task 4", "task 3"]);
    expect(first.before).not.toBeNull();
    const next = (await r.agents.service.tasks("research", "usman", { limit: 2, before: first.before! }))!;
    expect(next.tasks.map((t) => t.title)).toEqual(["task 2", "task 1"]);
    const last = (await r.agents.service.tasks("research", "usman", { limit: 2, before: next.before! }))!;
    expect(last.tasks.map((t) => t.title)).toEqual(["task 0"]);
    expect(last.before).toBeNull();
  });

  test("a coding job a bot's conversation drafted belongs to THAT bot only; one nobody claimed shows for a coding bot", async () => {
    const r = await rig();
    r.codingJobs.push(fakeCodingJob({ id: "22222222-2222-4222-8222-222222222222", state: "building", objective: "Claimed" }), fakeCodingJob({ id: "33333333-3333-4333-8333-333333333333", state: "building", objective: "Unclaimed" }));
    r.agents.links.note({ jobId: "22222222-2222-4222-8222-222222222222", bot: "someone-else", personId: "usman", subjects: [] });
    const builder = (await r.agents.service.tasks("builder", "usman"))!;
    expect(builder.tasks.map((t) => t.title)).toEqual(["Unclaimed"]);
  });
});

describe("files: saved results and coding outputs", () => {
  test("a computer's saved results (this person's own) with their files, and a coding job's branch, commit, changed files, review and tests", async () => {
    const r = await rig();
    const a = asJob(r, { bot: "research", subjects: ["crm:deal:42"] });
    r.artifacts.save({ jobId: a.id, personId: "usman", kind: "research", title: "Research: clinics", summary: "Complete report", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# Report" }, { name: "facts.json", data: "{}" }] });
    const other = asJob(r, { person: "mehroz" });
    r.artifacts.save({ jobId: other.id, personId: "mehroz", kind: "research", title: "Mehroz's", summary: "x", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# M" }] });
    const builderJob = asJob(r, { device: "dev-builder" });
    r.artifacts.save({ jobId: builderJob.id, personId: "usman", kind: "builder", title: "Builder preview", summary: "x", host: "synthetic", computer: "builder", outcome: "complete", main: "preview.html", files: [{ name: "preview.html", data: "<p>x</p>" }] });
    r.codingJobs.push(fakeCodingJob({ id: "44444444-4444-4444-8444-444444444444", state: "completed", head: "def5678", files: [{ path: "a.ts", status: "added" }, { path: "b.ts", status: "modified" }], review: { verdict: "approve", severities: [] }, tests: [{ commandId: "unit", passed: 3, failed: 0, exitCode: 0 }] }));
    r.codingEvents.set("44444444-4444-4444-8444-444444444444", [usageEvent("codex:openai-2", "gpt-6-astra")]);

    const research = (await r.agents.service.files("research", "usman"))!.files;
    expect(research).toHaveLength(1);
    expect(research[0]).toMatchObject({ artifact: `artifact:${a.id}`, title: "Research: clinics", jobId: a.id, source: "computer", href: `/__computers/artifacts/${a.id}`, subjects: ["crm:deal:42"], files: [{ name: "report.md", bytes: 8 }, { name: "facts.json", bytes: 2 }] });
    const builder = (await r.agents.service.files("builder", "usman"))!.files;
    expect(builder.map((f) => f.source).sort()).toEqual(["coding", "computer"]);
    const coding = builder.find((f) => f.source === "coding")!;
    expect(coding).toMatchObject({ artifact: "coding:44444444-4444-4444-8444-444444444444", commit: "def5678", files: [{ name: "a.ts", status: "added" }, { name: "b.ts", status: "modified" }], review: { verdict: "approve" }, tests: { passed: 3, failed: 0 }, receipts: [{ account: "codex:openai-2", model: "gpt-6-astra", role: "builder" }] });
    // Mehroz's own (unattributed, personal) saved result is never in Usman's list; Mehroz sees his AND the shared bot's result Usman's task made.
    expect((await r.agents.service.files("research", "mehroz"))!.files.map((f) => f.title).sort()).toEqual(["Mehroz's", "Research: clinics"]);
  });

  const save = (r: Rig, id: string, person: string, computer: string, title: string) =>
    r.artifacts.save({ jobId: id, personId: person, kind: "research", title, summary: "x", host: "synthetic", computer, outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# R" }] });

  test("a result a shared bot made is visible to BOTH founders; a personal one (no bot) stays its owner's", async () => {
    const r = await rig();
    const botMade = asJob(r, { bot: "research", person: "usman" });
    save(r, botMade.id, "usman", "research", "Bot made");
    const personal = asJob(r, { person: "usman" });
    save(r, personal.id, "usman", "research", "Personal");
    expect((await r.agents.service.files("research", "mehroz"))!.files.map((f) => f.title)).toEqual(["Bot made"]);
    expect((await r.agents.service.files("research", "usman"))!.files.map((f) => f.title).sort()).toEqual(["Bot made", "Personal"]);
  });

  test("a bot moved to another computer keeps its Files history (listed by the job's bot, not the computer name); another bot's results never join it", async () => {
    const r = await rig({ computers: ["research", "builder", "spare"] });
    const old = asJob(r, { bot: "research" });
    save(r, old.id, "usman", "research", "Made on research");
    const theirs = asJob(r, { bot: "builder", device: "dev-builder" });
    save(r, theirs.id, "usman", "research", "Builder's, same computer name");
    const moved = await r.agents.service.patch("research", { rev: 1, computer: "spare" }, "usman");
    expect(moved.status).toBe(200);
    const files = (await r.agents.service.files("research", "usman"))!.files.map((f) => f.title);
    expect(files).toEqual(["Made on research"]);
  });

  test("the CRM rule still holds: a result that records no bot goes to the oldest bot using that computer, and only to its owner", async () => {
    const r = await rig();
    const legacy = asJob(r, {});
    save(r, legacy.id, "usman", "research", "Legacy");
    expect((await r.agents.service.files("research", "usman"))!.files.map((f) => f.title)).toEqual(["Legacy"]);
    expect((await r.agents.service.files("research", "mehroz"))!.files).toEqual([]);
    expect((await r.agents.service.files("builder", "usman"))!.files.filter((f) => f.source === "computer")).toEqual([]);
  });
});

describe("/__jobs filters: targetDevice, bot, subject (read-only, the same identity rules)", () => {
  const get = (r: Rig, query: string, p: unknown = principal) => jobsApprovalsRoute({ method: "GET", path: "/__jobs", url: new URL(`http://x/__jobs?${query}`), principal: p as never }, { jobs: () => r.jobs, approvals: () => null as never });

  test("each filter narrows the same history; a job carries `bot` and `subjects` back out", async () => {
    const r = await rig();
    const a = asJob(r, { bot: "research", subjects: ["crm:deal:42", "crm:company:7"], device: "dev-research" });
    asJob(r, { bot: "research", device: "dev-research" });
    asJob(r, { bot: "builder", subjects: ["crm:deal:43"], device: "dev-builder" });
    asJob(r, { device: "dev-research" });
    const body = async (q: string) => ((await get(r, q))!.body as { jobs: Array<{ id: string; bot?: string; subjects?: string[]; targetDeviceId: string }> }).jobs;
    expect((await body("bot=research")).length).toBe(2);
    expect((await body("bot=builder")).length).toBe(1);
    expect((await body("targetDevice=dev-research")).length).toBe(3);
    expect((await body("targetDevice=dev-builder&bot=builder")).length).toBe(1);
    const bySubject = await body("subject=crm:deal:42");
    expect(bySubject.map((j) => j.id)).toEqual([a.id]);
    expect(bySubject[0]).toMatchObject({ bot: "research", subjects: ["crm:deal:42", "crm:company:7"] });
    expect((await body("subject=crm:company:7")).length).toBe(1);
    expect((await body("subject=crm:deal:999")).length).toBe(0);
  });

  test("bad filter values are refused, not ignored; no principal is 401", async () => {
    const r = await rig();
    expect((await get(r, "subject=deal:42"))!.status).toBe(400);
    expect((await get(r, "subject=crm:nonsense:1"))!.status).toBe(400);
    expect((await get(r, "bot=Not%20A%20Bot"))!.status).toBe(400);
    expect((await get(r, "targetDevice=a%20b"))!.status).toBe(400);
    expect((await get(r, "bot=research", null))!.status).toBe(401);
  });

  test("an older jobs.sqlite (no bot or subjects columns) is migrated in place, and its rows read as having neither", async () => {
    const { Database } = await import("bun:sqlite");
    const { JobService } = await import("../jobs/service");
    const path = join(dataDirFor((await rig()).root), "old-jobs.sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, principal TEXT NOT NULL, target_device_id TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, request_id TEXT UNIQUE, approval_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, quarantine_reason TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    db.query("INSERT INTO jobs (id, kind, principal, target_device_id, state, title, created_at, updated_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','control','{\"personId\":\"usman\",\"via\":\"loopback-owner\",\"actor\":\"human\"}','dev-x','succeeded','old job',1,1)").run();
    db.close();
    const migrated = new JobService({ path, snapshotMs: 0 });
    expect(migrated.list({}).map((j) => [j.title, j.bot, j.subjects])).toEqual([["old job", undefined, undefined]]);
    const made = migrated.create({ kind: "control", principal: usman as never, targetDeviceId: "dev-x", title: "new", bot: "research", subjects: ["crm:lead:9", "bad ref", "crm:lead:9"] });
    expect([made.bot, made.subjects]).toEqual(["research", ["crm:lead:9"]]);
    expect(migrated.list({ bot: "research" }).length).toBe(1);
    migrated.close();
  });
});

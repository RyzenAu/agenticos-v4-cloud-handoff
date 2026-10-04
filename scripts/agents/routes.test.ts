// /__agents over real HTTP: every route of the plan's table, the identity rules in the pc and server roles, and the gate's classification of the mount.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { botThreadId } from "../conversations";
import { CALLER_KINDS, decisionTable } from "../identity/role-matrix";
import type { Principal } from "../identity/principal";
import { routeClass } from "../identity/routes";
import { createAgentsRoutes } from "./routes";
import { fakeCodingJob, makeRig, usageEvent, type Rig } from "./test-rig";

const TOKEN = "page-token-for-tests";
const owner: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" };
const confirmed: Principal = { personId: "mehroz", via: "paired-session", actor: "human", displayName: "Mehroz" };
const bare: Principal = { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
const program: Principal = { personId: "usman", via: "loopback-owner", actor: "process", displayName: "Usman" };

let rig: Rig;
let server: Server;
let base = "";
let who: Principal | null = owner;
let role = "pc";
let remote = "127.0.0.1";

beforeAll(async () => {
  rig = await makeRig();
  const routes = createAgentsRoutes({
    service: rig.agents.service,
    principal: () => who,
    tokenOk: (req: IncomingMessage) => req.headers["x-claude-os-token"] === TOKEN,
    role: () => role,
  });
  server = createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true });
    // Mounted the way connect mounts it: prefix stripped is NOT done by this handler (it strips /__agents itself), so the full URL goes in.
    void routes.handle(req, res, () => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await rig.close();
});

const call = async (method: string, path: string, init: { body?: unknown; token?: string | null; headers?: Record<string, string>; as?: Principal | null; raw?: string } = {}) => {
  who = init.as === undefined ? owner : init.as;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token !== null && method !== "GET") headers["x-claude-os-token"] = init.token ?? TOKEN;
  if (init.body !== undefined || init.raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/__agents${path}`, { method, headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
};

describe("reads", () => {
  test("GET /bots: Research and Builder with live readiness; no-store", async () => {
    const r = await call("GET", "/bots");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json.bots.map((b: any) => [b.id, b.readiness.state, b.computer, b.coding.enabled])).toEqual([["research", "ready", "research", false], ["builder", "ready", "builder", true]]);
    expect(r.json.bots[0].readiness).toMatchObject({ reasons: [], working: null });
  });

  test("GET /bots/:id: the bot, readiness and THIS person's conversation id; another person gets theirs", async () => {
    const mine = await call("GET", "/bots/research");
    expect(mine.json).toMatchObject({ id: "research", rev: 1, conversationId: botThreadId("usman", "research"), conversationKey: "agent:usman:research", readiness: { state: "ready" } });
    const theirs = await call("GET", "/bots/research", { as: confirmed });
    expect(theirs.json.conversationId).toBe(botThreadId("mehroz", "research"));
    expect((await call("GET", "/bots/nobody")).status).toBe(404);
    expect((await call("GET", "/bots/Not%20A%20Bot")).status).toBe(404);
  });

  test("GET /bots/:id/thread?after: the entries, in the shape the UI folds, after a seq", async () => {
    const t = (await call("GET", "/bots/research")).json;
    rig.conversations.appendEntry(t.conversationId, { key: "j1:started", jobId: "j1", state: "started", text: "Started: x (job j1000000).", jobKind: "computer" });
    rig.conversations.appendEntry(t.conversationId, { key: "j1:failed", jobId: "j1", state: "failed", text: "Failed: x.", jobKind: "computer", blocker: { kind: "failed", recovery: "Tell the bot the next goal." } });
    const all = await call("GET", "/bots/research/thread");
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({ conversationId: t.conversationId, last: 2 });
    expect(all.json.entries.map((e: any) => [e.seq, e.key, e.state])).toEqual([[1, "j1:started", "started"], [2, "j1:failed", "failed"]]);
    expect(all.json.entries[1]).toMatchObject({ jobKind: "computer", blocker: { kind: "failed" }, at: expect.any(String), jobId: "j1", text: "Failed: x." });
    expect((await call("GET", "/bots/research/thread?after=1")).json.entries.map((e: any) => e.seq)).toEqual([2]);
    expect((await call("GET", "/bots/research/thread?after=junk")).json.entries.length).toBe(2);
    // Someone else's view of the same bot is theirs: empty, not Usman's.
    expect((await call("GET", "/bots/research/thread", { as: confirmed })).json.entries).toEqual([]);
  });

  test("GET /bots/:id/tasks and /files", async () => {
    const job = rig.jobs.create({ kind: "control", principal: owner as never, targetDeviceId: "dev-research", title: "Find clinics", bot: "research", subjects: ["crm:deal:42"] });
    rig.jobs.begin(job.id);
    rig.jobs.finish(job.id, "succeeded", "done");
    rig.artifacts.save({ jobId: job.id, personId: "usman", kind: "research", title: "Research: clinics", summary: "Report", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: "# r" }] });
    rig.codingJobs.push(fakeCodingJob({ id: "66666666-6666-4666-8666-666666666666", state: "completed", head: "abc1234", files: [{ path: "a.ts", status: "modified" }] }));
    rig.codingEvents.set("66666666-6666-4666-8666-666666666666", [usageEvent("claude:max", "claude-opus-5-5")]);
    const tasks = await call("GET", "/bots/builder/tasks?limit=10");
    expect(tasks.status).toBe(200);
    expect(tasks.json.tasks.map((t: any) => [t.kind, t.state, t.account])).toEqual([["coding", "completed", "claude:max"]]);
    const rt = await call("GET", "/bots/research/tasks");
    expect(rt.json.tasks[0]).toMatchObject({ id: job.id, kind: "computer", resultArtifact: `artifact:${job.id}`, subjects: ["crm:deal:42"] });
    const files = await call("GET", "/bots/research/files");
    expect(files.json.files[0]).toMatchObject({ artifact: `artifact:${job.id}`, href: `/__computers/artifacts/${job.id}` });
    expect((await call("GET", "/bots/builder/files")).json.files.map((f: any) => f.source)).toEqual(["coding"]);
    expect((await call("GET", "/bots/research/tasks?before=abc")).status).toBe(400);
    expect((await call("GET", "/bots/nobody/tasks")).status).toBe(404);
  });

  test("GET /skills is the read-only catalogue of abilities; a bot's own abilities are on its record and derive from what it can run", async () => {
    const r = await call("GET", "/skills");
    expect(r.status).toBe(200);
    expect(r.json.skills.map((s: any) => s.name)).toEqual(["research", "builder", "audit", "bizprep", "coding"]);
    for (const s of r.json.skills) expect(typeof s.description).toBe("string");
    const bots = (await call("GET", "/bots")).json.bots;
    expect(bots.find((b: any) => b.id === "research").skills).toEqual(["research", "builder", "audit", "bizprep"]);
    expect(bots.find((b: any) => b.id === "builder").skills).toEqual(["research", "builder", "audit", "bizprep", "coding"]);
    expect(bots[0].abilities[0]).toMatchObject({ id: "research", name: "Research" });
  });
});

describe("PATCH /bots/:id", () => {
  test("a good edit returns the bot with readiness and a new rev; a stale rev is 409 with { error, current } and writes nothing", async () => {
    const ok = await call("PATCH", "/bots/builder", { body: { rev: 1, purpose: "Builds and ships previews.", memory: { recall: true, saveResults: false } } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: "builder", rev: 2, purpose: "Builds and ships previews.", memory: { recall: true, saveResults: false }, readiness: { state: "ready" } });
    const stale = await call("PATCH", "/bots/builder", { body: { rev: 1, purpose: "Lost update." } });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain("changed by someone else");
    expect(stale.json.current).toMatchObject({ rev: 2, purpose: "Builds and ships previews.", readiness: { state: "ready" } });
    expect(rig.agents.store.get("builder")?.purpose).toBe("Builds and ships previews.");
  });

  test("400 names the field; coding.enabled is refused; unknown bot 404; bad JSON 400; wrong type 415; no token 403", async () => {
    const bad = await call("PATCH", "/bots/research", { body: { rev: 1, computer: "ghost", skills: ["nope"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors.map((e: any) => e.field).sort()).toEqual(["computer", "skills"]);
    expect((await call("PATCH", "/bots/research", { body: { rev: 1, coding: { enabled: true, accountSlot: null, model: null } } })).json.errors[0].field).toBe("coding.enabled");
    expect((await call("PATCH", "/bots/nobody", { body: { rev: 1, purpose: "x" } })).status).toBe(404);
    expect((await call("PATCH", "/bots/research", { raw: "{nope" })).status).toBe(400);
    const noType = await fetch(`${base}/__agents/bots/research`, { method: "PATCH", headers: { "x-claude-os-token": TOKEN }, body: "{}" });
    expect(noType.status).toBe(415);
    expect((await call("PATCH", "/bots/research", { body: { rev: 1, purpose: "x" }, token: "wrong" })).status).toBe(403);
    expect((await call("PATCH", "/bots/research", { body: { rev: 1, purpose: "x" }, token: null })).status).toBe(403);
    expect(rig.agents.store.get("research")?.rev).toBe(1);
  });

  test("a saved edit survives a reopen of the store (atomic file, same rev)", async () => {
    await call("PATCH", "/bots/research", { body: { rev: 1, name: "Scout" } });
    const { createBotStore } = await import("./store");
    expect(createBotStore({ file: rig.agents.store.file }).get("research")).toMatchObject({ name: "Scout", rev: 2 });
    await call("PATCH", "/bots/research", { body: { rev: 2, name: "Research" } });
  });
});

describe("identity: who may read, who may change what a bot does", () => {
  test("no principal is 401; a non-loopback socket and another origin are 403", async () => {
    expect((await call("GET", "/bots", { as: null })).status).toBe(401);
    remote = "192.168.1.9";
    expect((await call("GET", "/bots")).status).toBe(403);
    remote = "127.0.0.1";
    expect((await call("GET", "/bots", { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await call("GET", "/bots", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  test("pc role: both founders read; a PATCH needs only the caller's own page token (the gate already limits who reaches it)", async () => {
    role = "pc";
    expect((await call("GET", "/bots", { as: confirmed })).status).toBe(200);
    expect((await call("GET", "/bots", { as: bare })).status).toBe(200);
    expect((await call("PATCH", "/bots/research", { body: { rev: 99, purpose: "x" }, as: owner })).status).toBe(409);
    // ...but changing a bot is the same act as making one: a bare tailnet login (no confirmed session) is refused in this role too, and nothing is written
    const refused = await call("PATCH", "/bots/research", { body: { rev: 1, purpose: "hijacked" }, as: bare });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toContain("needs a confirmed sign-in");
    expect((await call("GET", "/bots/research")).json.purpose).not.toBe("hijacked");
  });

  test("server role: reads are open to verified founders; a PATCH needs the owner at the hub or a CONFIRMED human session; a bare tailnet login or a pending session is refused", async () => {
    role = "server";
    try {
      expect((await call("GET", "/bots", { as: bare })).status).toBe(200);
      expect((await call("GET", "/bots/research/thread", { as: bare })).status).toBe(403);
      const body = { rev: 99, purpose: "x" }; // a stale rev: reaching the handler is a 409, being refused is a 403
      expect((await call("PATCH", "/bots/research", { body, as: owner })).status).toBe(409);
      expect((await call("PATCH", "/bots/research", { body, as: program })).status).toBe(409); // the owner's own script at the hub (it holds the local-owner proof)
      expect((await call("PATCH", "/bots/research", { body, as: confirmed })).status).toBe(409);
      const refused = await call("PATCH", "/bots/research", { body, as: bare });
      expect(refused.status).toBe(403);
      expect(refused.json.error).toContain("needs a confirmed sign-in");
    } finally {
      role = "pc";
    }
  });

  test("an unknown path under the mount fails closed with a 404 JSON; it is never handed to the next handler", async () => {
    const r = await call("GET", "/elsewhere");
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("Not found");
    expect((await call("DELETE", "/bots/research")).status).toBe(405);
    expect((await call("POST", "/bots/research")).status).toBe(405);
    expect((await call("POST", "/bots/research/tasks")).status).toBe(405);
  });
});

describe("the gate's classification of /__agents (generated by the real gate, both roles)", () => {
  const pc = decisionTable("pc");
  const serverRole = decisionTable("server");
  const col = (k: (typeof CALLER_KINDS)[number]) => CALLER_KINDS.indexOf(k);

  test("shared reads for both founders; writes are the hub owner's, which is a confirmed human founder session in the server role", () => {
    expect(routeClass("/__agents/bots", "GET")).toBe("shared");
    expect(routeClass("/__agents/bots/research", "PATCH")).toBe("local-owner");
    for (const kind of ["loopback-owner", "paired-founder"] as const) expect([kind, pc["GET /__agents"][col(kind)]]).toEqual([kind, 200]);
    // A bare tailnet login (an unconfirmed browser) doesn't see the agents' conversations or tasks (acceptance #18).
    expect(pc["GET /__agents"][col("tailnet-founder")]).toBe(403);
    // pc: only the owner at the PC writes.
    expect(pc["POST /__agents"][col("loopback-owner")]).toBe(200);
    expect(pc["POST /__agents"][col("tailnet-founder")]).toBe(403);
    expect(pc["POST /__agents"][col("paired-founder")]).toBe(403);
    // server: a confirmed human session writes; a bare tailnet login still does not; the loopback owner keeps its access.
    expect(serverRole["POST /__agents"][col("paired-founder")]).toBe(200);
    expect(serverRole["POST /__agents"][col("tailnet-founder")]).toBe(403);
    expect(serverRole["POST /__agents"][col("loopback-owner")]).toBe(200);
    for (const kind of ["companion-remote", "companion-local", "bridge-client", "anonymous-lan", "forged-lan", "forged-loopback"] as const) {
      expect([kind, pc["GET /__agents"][col(kind)] >= 400, serverRole["GET /__agents"][col(kind)] >= 400]).toEqual([kind, true, true]);
      expect([kind, pc["POST /__agents"][col(kind)] >= 400, serverRole["POST /__agents"][col(kind)] >= 400]).toEqual([kind, true, true]);
    }
  });
});

describe("review fix B: conversations need a confirmed person or the owner at the hub; another person's thread is a 403", () => {
  test("a bare Tailscale login (actor process) reads the bot but gets no conversationId, and /thread is a 403 with a short reason", async () => {
    const asBare = await call("GET", "/bots/builder", { as: bare });
    expect(asBare.status).toBe(200);
    expect(asBare.json.id).toBe("builder");
    expect(asBare.json.conversationId).toBeUndefined();
    expect(asBare.json.conversationKey).toBeUndefined();
    // ...and reading it created nothing for that person (the ensureThread write).
    expect(rig.conversations.get(botThreadId("mehroz", "builder"))).toBeNull();
    const thread = await call("GET", "/bots/builder/thread", { as: bare });
    expect(thread.status).toBe(403);
    expect(thread.json.error).toContain("confirmed sign-in");
    expect(thread.json.entries).toBeUndefined();
  });

  test("a confirmed human session and the owner at the hub (even a local script holding the owner proof) get the conversation", async () => {
    for (const as of [confirmed, owner, program]) {
      const bot = await call("GET", "/bots/builder", { as });
      expect(bot.status).toBe(200);
      expect(bot.json.conversationId).toBe(botThreadId(as.personId, "builder"));
      expect((await call("GET", "/bots/builder/thread", { as })).status).toBe(200);
    }
  });

  test("asking for a thread that belongs to another person is a 403, not a 'no such bot' 404", async () => {
    const real = rig.conversations.get.bind(rig.conversations);
    (rig.conversations as any).get = () => ({ personId: "someone-else" });
    try {
      const r = await call("GET", "/bots/research/thread", { as: owner });
      expect(r.status).toBe(403);
      expect(r.json.error).toContain("someone else");
    } finally {
      (rig.conversations as any).get = real;
    }
    expect((await call("GET", "/bots/ghost-bot/thread", { as: owner })).status).toBe(404);
  });
});

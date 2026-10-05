// Owner, 5 Oct: "Just give it the full Jarvis; stop limiting things." Dot's /jarvis through the gateway (POST /__gateway/tasks) on a
// synthetic hub: the founders' command service wiring (CRM, leads, compound questions, the shared bot computers) with Dot's principal,
// and the founders' typed-lane brain answering plain questions server-side. Real gateway routes over HTTP, real command service, job
// store, computers service, conversation store and free-voice engine; synthetic Jev, model, CRM records and people.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startComputersHub, type ComputersHub } from "../computers/test-harness";
import { computerCommand } from "../computers/jarvis";
import { conversationStore, jarvisThreadId } from "../conversations";
import { createCrmOperations } from "../crm/ops";
import { CrmStore } from "../crm/store";
import { resolveTarget } from "../devices/route";
import { syntheticWorld } from "../devices/synthetic";
import { freeVoice } from "../free-voice";
import { pageTokenFor, type Principal } from "../identity/principal";
import { withComputerResolution } from "../jarvis-command/computer-target";
import { runCrmIntent } from "../jarvis-command/crm";
import { runLeadAction } from "../jarvis-command/leads";
import { createCommandService } from "../jarvis-command/service";
import { createJobThreads } from "../jarvis-command/threads";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { createGatewayRoutes } from "./hub-plugin";

setDefaultTimeout(40_000);

const TOKEN = "full-jarvis-test-token";
const COMPOUND = "what's the next action for the Westpoint Dental Clinic opportunity deal, and how many open leads do we have?";
const root = mkdtempSync(join(tmpdir(), "gw-full-jarvis-"));
const dir = join(root, "data", "gateway");
mkdirSync(dir, { recursive: true });

const crmStore = new CrmStore(new Database(":memory:"));
const crmOps = createCrmOperations({ store: crmStore });
const world = syntheticWorld({ start: false });
let hub: ComputersHub;
let server: Server;
let base = "";
let jevLane = "brain";
const brainAsked: string[] = [];
let stopThreads = () => undefined as void;

const dotPrincipal = (caps: string[]): Principal => ({ personId: "dot" as never, via: "gateway", actor: "process", sessionId: "gw:ab", displayName: "Dot", capabilities: ["view", ...caps] as never, delegatedBy: "usman" });
async function call(caps: string[], method: string, path: string, body?: unknown) {
  const label = `dot:${caps.join(",")}`;
  const headers: Record<string, string> = { "x-test-who": label };
  if (method !== "GET") Object.assign(headers, { "content-type": "application/json", "x-claude-os-token": pageTokenFor(dotPrincipal(caps), TOKEN) });
  const res = await fetch(`${base}/__gateway${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const dotThread = () => (hub ? conversationStore(hub.root).get(jarvisThreadId("dot"))?.messages ?? [] : []);

beforeAll(async () => {
  hub = await startComputersHub();
  // A goal step that takes a while, so Stop has something running to stop.
  const slow = async () => { await Bun.sleep(5_000); return { ok: true, said: "Researched.", verified: true }; };
  hub.host.executorsFor = () => ({ echo: slow, "screen.goal": slow });
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("research online", () => hub.computers.view("research").state === "online");
  const by = { personId: "usman" as const };
  const company = crmStore.createCompany({ name: "Synthetic Westpoint Dental Clinic" }, by);
  const deal = crmStore.createDeal({ companyId: company.id, title: "Westpoint Dental Clinic opportunity", service: "website", commercialBasis: "pending" }, by);
  crmStore.createTask({ companyId: company.id, dealId: deal.id, title: "Review the synthetic scope", owner: "usman" }, by);
  const conversations = conversationStore(hub.root);
  const threads = createJobThreads({ conversations, jobs: () => hub.jobs });
  void threads.start(); // the hub's thread watcher (operator-plugin starts it with the background services)
  stopThreads = () => threads.stop();
  const computers = hub.computers;
  // The founders' delegates (scripts/jarvis-command/live.ts and operator-plugin.ts), here with the synthetic services.
  const commands = createCommandService({
    jobs: () => hub.jobs, threads, entry: () => null, hubDeviceId: "synthetic-hub", dedupeMs: 0, graceMs: 50,
    resolveTarget: (ctx) => resolveTarget(ctx, world.registry),
    controller: { key: () => "synthetic", cache: null, decide: (async () => ({ ok: true, answers: { lane: { choice: jevLane, confidence: 0.96 }, multi: { noul: 0.05 }, outbound: { noul: 0.02 } }, ms: 5, httpStatus: 200, attempts: 1, receipt: { requestId: "req-jev-full", model: "synthetic-jev" } })) as never },
    delegates: {
      crm: (intent, principal, context, eventId) => runCrmIntent({ operations: () => crmOps as never, role: () => "pc", readOnly: () => false }, intent, principal, context as never, eventId ? { eventId } : {}),
      leads: (action, principal) => runLeadAction({ handle: async (path) => (path === "/leads/pipeline" ? { open: 7, total: 12 } : null) } as never, action, principal),
      computers: withComputerResolution(() => computers.list().map((c) => ({ name: c.name, label: c.label })), (utterance, principal) => computerCommand(computers, utterance, principal)),
    },
  });
  const engine = freeVoice(hub.root, {
    key: (k) => (k === "GROQ_API_KEY" ? "synthetic" : ""), bots: () => [],
    fetch: (async (url: string, init: { body?: string }) => {
      if (!String(url).includes("/chat/completions")) throw new Error(`unexpected network: ${url}`);
      const asked = JSON.parse(String(init.body)).messages.at(-1).content as string;
      brainAsked.push(asked);
      return Response.json({ choices: [{ message: { role: "assistant", content: `Synthetic brain: ${asked.includes("Portugal") ? "Lisbon." : "an answer."}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch,
    sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), hub: () => ({ name: "fixture", role: "server" }), companions: () => [],
  });
  const handle = createGatewayRoutes({
    root, internalToken: () => TOKEN, dir, trust: () => true,
    principal: (req: IncomingMessage) => {
      const who = String(req.headers["x-test-who"] ?? "");
      return who.startsWith("dot:") ? dotPrincipal(who.slice(4).split(",").filter(Boolean)) : null;
    },
    operate: {
      env: () => ({}), readOnly: () => false, crm: () => crmOps as never, jobs: () => hub.jobs as never, commands: () => commands as never,
      brain: () => (utterance: string) => engine.answer(utterance), computers: () => hub.computers as never, taskWaitMs: 8_000,
      jarvisThreads: () => conversations as never,
    },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  stopThreads();
  world.dispatcher.close();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await hub?.close().catch(() => undefined);
  Bun.gc(true);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ }
});

describe("Dot's /jarvis is the founders' Jarvis", () => {
  test("a plain question is answered by the brain and saved, request then reply, in Dot's thread", async () => {
    jevLane = "brain";
    const r = await call(["tasks.run"], "POST", "/tasks", { text: "What's the capital of Portugal?", eventId: "jr-full-plain-01" });
    expect(r.status).toBe(200);
    expect(r.json.said).toBe("Synthetic brain: Lisbon.");
    expect(r.json.said).not.toContain("chat brain");
    expect(brainAsked.at(-1)).toBe("What's the capital of Portugal?");
    await hub.waitFor("the reply saved", () => dotThread().some((m) => m.text === "Synthetic brain: Lisbon."));
    expect(dotThread().filter((m) => m.via?.startsWith("say:jr-full-plain-01")).map((m) => [m.role, m.text])).toEqual([["user", "What's the capital of Portugal?"], ["oracle", "Synthetic brain: Lisbon."]]);
    expect(conversationStore(hub.root).get(jarvisThreadId("usman"))).toBeNull();
  });

  test("the compound business question answers both parts in order, through Dot's CRM capabilities", async () => {
    jevLane = "crm";
    const r = await call(["tasks.run", "crm.read"], "POST", "/tasks", { text: COMPOUND, eventId: "jr-full-compound-01" });
    expect(r.status).toBe(200);
    const [first, second] = String(r.json.said).split("\n");
    expect(first).toStartWith("1. ");
    expect(first).toContain("Review the synthetic scope");
    expect(second).toBe("2. We have 7 open leads.");
    await hub.waitFor("the compound reply saved", () => dotThread().some((m) => m.via === "say:jr-full-compound-01:reply"));
    // Without crm.read the same words read nothing: Dot's CRM guard still decides.
    const refused = await call(["tasks.run"], "POST", "/tasks", { text: COMPOUND, eventId: "jr-full-compound-02" });
    expect(String(refused.json.said)).not.toContain("Review the synthetic scope");
    expect(String(refused.json.said)).not.toContain("7 open leads");
  });

  test("research on a shared bot computer starts a real job owned by Dot; Stop stops it; its lines land in Dot's thread", async () => {
    jevLane = "computer";
    const r = await call(["tasks.run"], "POST", "/tasks", { text: "use the research computer to research the Sydney Harbour Bridge", eventId: "jr-full-research-01" });
    expect([200, 202]).toContain(r.status);
    if (typeof r.json.jobId !== "string") throw new Error(`no job: ${JSON.stringify(r.json)}`);
    const jobId = r.json.jobId as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const job = hub.jobs.get(jobId)!;
    expect(job.principal).toMatchObject({ personId: "dot", via: "gateway" });
    expect(hub.computers.jobView(jobId)?.computer).toBe("research");
    const stopped = await call(["tasks.run"], "POST", `/jobs/${jobId}/stop`);
    expect(stopped.status).toBe(202);
    await hub.waitFor("the job ended", () => ["cancelled", "failed", "succeeded"].includes(hub.jobs.get(jobId)!.state));
    expect(hub.jobs.get(jobId)!.state).toBe("cancelled");
    expect(dotThread().some((m) => m.via === "say:jr-full-research-01:user")).toBe(true);
    // The job is linked into Dot's own thread: its start and its end land there (the thread watcher), never in a founder's.
    await hub.waitFor("the job's lines in Dot's thread", () => conversationStore(hub.root).entriesAfter(jarvisThreadId("dot"), 0).filter((e) => e.jobId === jobId).length >= 2).catch((e) => {
      throw new Error(`${e.message}: ${JSON.stringify(conversationStore(hub.root).entriesAfter(jarvisThreadId("dot"), 0).map((x) => [x.key, x.state]))}`);
    });
  });
});

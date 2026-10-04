import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { mayControl, mayTakeOver } from "../computers/permissions";
import { pairPersonalPc, startComputersHub, type ComputersHub } from "../computers/test-harness";
import { createCrmOperations } from "../crm/ops";
import { CrmStore } from "../crm/store";
import { resolveTarget } from "../devices/route";
import { SYNTHETIC_MEHROZ_PC_ID, SYNTHETIC_USMAN_HUB_ID, SyntheticCompanion, syntheticExecutors, syntheticWorld, type RanCall } from "../devices/synthetic";
import { pageTokenFor, type Principal } from "../identity/principal";
import { createCommandService } from "../jarvis-command/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { JarvisEntry } from "../jev-command";
import { readAudit } from "./audit";
import { FILES } from "./config";
import { GATEWAY_CRM_FOUNDER_ONLY, GATEWAY_CRM_READS, GATEWAY_CRM_WRITES, gatewayCrmGuard } from "./crm-policy";
import { createGatewayRoutes } from "./hub-plugin";
import { MEMORY_BUCKETS_FOR_GATEWAY, releaseReceipts } from "./hub-ops";
import { CAPABILITIES, GRANTABLE, OPERATE_SET, permitted } from "./policy";
import { ControlFile, SessionFile } from "./store";

/**
 * What Dot can and cannot DO on the hub, capability by capability. The hub's /__gateway routes over real HTTP (loopback),
 * in front of the REAL services: the CRM's typed operations on a real (in-memory) store, the job store, the Jev-led command
 * service with a synthetic device world, and the computers service with an in-process shared bot computer and a founder's
 * paired personal PC. The principal is injected (the identity gate and the assertion are proven in hub.test.ts and
 * access.e2e.test.ts); everything after the gate is the real code. Synthetic people and data only.
 */

setDefaultTimeout(40_000);

const TOKEN = "operate-test-internal-token";
const SID = "ab".repeat(12);
const root = mkdtempSync(join(tmpdir(), "gw-operate-"));
const dataDir = join(root, "data");
const dir = join(dataDir, "gateway");
const designs = join(root, "designs");
const receiptsDir = join(root, "release-logs");
for (const d of [dir, designs, receiptsDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(designs, "index.html"), "<h1>Synthetic design</h1>");
writeFileSync(join(receiptsDir, "release-20261003T212700.json"), JSON.stringify({ time: "2026-10-03T21:27:00+10:00", oldHead: "aaaaaaa1", newHead: "664c0c91", rollbackTag: "rollback/pre-r8-20261003", backup: "D:\\mu-hub-backups\\BACKUP-PATH-MARKER", envCopy: "C:\\mu-hub\\config\\hub.env.pre-release-MARKER", crmMigrated: false }));
writeFileSync(join(receiptsDir, "hub.out.log"), "NOT-A-RECEIPT");
const env: Record<string, string | undefined> = { MU_DATA_DIR: dataDir, MU_DESIGN_PROJECTS_DIR: designs, MU_RELEASE_RECEIPTS_DIR: receiptsDir };

// ── the real services ───────────────────────────────────────────────────────────────────────────────────────────────
const crmStore = new CrmStore(new Database(":memory:"));
const crmOps = createCrmOperations({ store: crmStore });
let hub: ComputersHub;
let usmanPc: Awaited<ReturnType<typeof pairPersonalPc>>;
const world = syntheticWorld({ start: false });
const ranOnMehrozPc: RanCall[] = [];
const mehrozPc = new SyntheticCompanion(world.dispatcher, world.registry, SYNTHETIC_MEHROZ_PC_ID, "mehroz", syntheticExecutors(ranOnMehrozPc, "mehroz"), world.clock.now);
/** The hub's own desktop entry: recorded, so a test can prove Dot never reaches it. */
const hubDesktopCalls: unknown[] = [];
const entry = { handle: async (req: unknown) => (hubDesktopCalls.push(req), { type: "done", ok: true, said: "ran on the hub", kind: "app", jobId: null, runId: "", targetDeviceId: SYNTHETIC_USMAN_HUB_ID }) } as unknown as JarvisEntry;
/** Jev, scripted: the lane a test names. Recorded so "went through Jev" is a fact. */
const jevAsked: string[] = [];
let jevLane = "page";
const decide = (async (call: { state: unknown }) => {
  jevAsked.push(String((call.state as { utterance?: string }).utterance ?? ""));
  return { ok: true, answers: { lane: { choice: jevLane, confidence: 0.95 }, multi: { noul: 0.05 }, outbound: { noul: 0.02 } }, ms: 5, httpStatus: 200, attempts: 1, receipt: { requestId: "req-jev-test", model: "typesafe/jev-latest", inputTokens: 100 } };
}) as never;
let commands: ReturnType<typeof createCommandService>;
/** What the shared bot computer actually ran. */
let ranOnBot: string[] = [];

/** Shared memory, as the memory API answers (types.ts): buckets on the items, a writes switch the owner holds. */
const memory = {
  writes: false,
  saved: [] as Array<{ p: unknown; input: Record<string, unknown> }>,
  facts: [
    { id: "mf-biz", bucket: "business", title: "Receptionist pricing", text: "Synthetic: plans are 699, 1099 and 1999 ex GST." },
    { id: "mf-personal", bucket: "personal", title: "A founder's own note", text: "PERSONAL-MARKER" },
    { id: "mf-deen", bucket: "deen", title: "Deen", text: "DEEN-MARKER" },
    { id: "mf-finance", bucket: "finance", title: "Finance", text: "FINANCE-MARKER" },
    { id: "mem-research", bucket: "research", title: "Model notes", text: "Synthetic research note." },
    { id: "mf-unknown", bucket: null, title: "No bucket", text: "UNKNOWN-MARKER" },
  ],
  off: false,
  async recall(_p: unknown, query: string) {
    if (memory.off) return { ok: true as const, query, facts: [], spoken: "Memory is off here.", hindsight: "off", off: "memory is off (MU_MEMORY_WRITES=off)" };
    return { ok: true as const, query, facts: memory.facts.map((f) => ({ id: f.id, kind: "fact", title: f.title, text: f.text, date: "2026-10-01", origin: "vault", actor: null, source: { kind: "vault", path: `wiki/topics/${f.bucket}/x.md` }, score: 1 })), spoken: "", hindsight: "ok" };
  },
  async remember(p: unknown, input: Record<string, unknown>) {
    if (!memory.writes) return { ok: false, code: "writes-disabled", message: "Memory writing is off (MU_MEMORY_WRITES is not on), so nothing was saved or changed." };
    memory.saved.push({ p, input });
    return { ok: true, message: "Saved.", duplicate: false, memory: { id: "mem-new-1" }, destination: { indexed: "queued" } };
  },
  item(id: string) {
    const f = memory.facts.find((x) => x.id === id);
    return f && f.bucket ? { row: { bucket: f.bucket } } : null;
  },
};

let server: Server;
let base = "";
let readOnly = false;

// ── callers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Who = { dot: string[]; session?: string } | "usman" | "mehroz-bare" | "anon";
const principalOf = (req: IncomingMessage): Principal | null => {
  const who = String(req.headers["x-test-who"] ?? "");
  if (who === "usman") return { personId: "usman", via: "paired-session", actor: "human", sessionId: "sk-usman-test-session", displayName: "Usman" };
  if (who === "mehroz-bare") return { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" };
  if (who.startsWith("dot:")) {
    const [, session, caps] = who.split(":");
    return { personId: "dot" as never, via: "gateway", actor: "process", sessionId: `gw:${session}`, displayName: "Dot", capabilities: ["view", ...caps.split(",").filter(Boolean)], delegatedBy: "usman" };
  }
  return null;
};
async function call(who: Who, method: string, path: string, body?: unknown, opts: { token?: string | null } = {}) {
  const label = typeof who === "string" ? who : `dot:${who.session ?? SID}:${who.dot.join(",")}`;
  const p = principalOf({ headers: { "x-test-who": label } } as unknown as IncomingMessage);
  const headers: Record<string, string> = { "x-test-who": label };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    const token = opts.token === undefined ? (p ? pageTokenFor(p, TOKEN) : "") : opts.token;
    if (token) headers["x-claude-os-token"] = token;
  }
  const res = await fetch(`${base}/__gateway${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, recordIds: res.headers.get("x-mu-record-ids") };
}
const dot = (...caps: string[]): Who => ({ dot: caps });
const ALL_CAPS = CAPABILITIES.filter((c) => c !== "view");

beforeAll(async () => {
  hub = await startComputersHub();
  const botRan: string[] = [];
  const ok = (said: string) => ({ ok: true, said, verified: true });
  hub.host.executorsFor = () => ({ echo: async () => (botRan.push("echo"), ok("Echoed.")), "input.click": async () => (botRan.push("input.click"), ok("Clicked.")), "message.send": async () => (botRan.push("message.send"), ok("Sent.")) });
  ranOnBot = botRan;
  (hub.host as unknown as { openTerminal: unknown }).openTerminal = async () => {
    const data: ((c: Uint8Array) => void)[] = [];
    const exit: ((c: number | null) => void)[] = [];
    return { write: (d: Uint8Array) => data.forEach((l) => l(new TextEncoder().encode(`echo:${new TextDecoder().decode(d)}`))), resize: () => undefined, close: () => exit.forEach((l) => l(0)), onData: (l: (c: Uint8Array) => void) => void data.push(l), onExit: (l: (c: number | null) => void) => void exit.push(l) };
  };
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("research online", () => hub.computers.view("research").state === "online");
  usmanPc = await pairPersonalPc(hub, "usman");
  mehrozPc.start();
  commands = createCommandService({
    jobs: () => hub.jobs,
    entry: () => entry,
    hubDeviceId: SYNTHETIC_USMAN_HUB_ID,
    resolveTarget: (ctx) => resolveTarget(ctx, world.registry),
    dispatcher: world.dispatcher,
    micOwner: (p) => world.registry.micOwner(p),
    deviceLabel: (id) => world.registry.all().find((d) => d.id === id)?.label ?? id,
    spoken: new SpokenConfirmationLedger(),
    delegates: {},
    controller: { key: () => "synthetic", decide },
    graceMs: 50,
  });
  const handle = createGatewayRoutes({
    root,
    internalToken: () => TOKEN,
    dir,
    principal: principalOf,
    trust: () => true,
    operate: { env: () => env, readOnly: () => readOnly, crm: () => crmOps as never, jobs: () => hub.jobs as never, commands: () => commands as never, memory: () => memory as never, computers: () => hub.computers as never, taskWaitMs: 8_000, version: async () => ({ version: "0.0.0-test", gitSha: "testsha", dirty: false, buildTime: "2026-10-04T00:00:00.000Z" }), health: async () => ({ ok: true, status: "ok", checkedAt: "2026-10-04T00:00:00.000Z", hubRole: "server", version: "0.0.0-test", gitSha: "testsha", dirty: false, startedAt: "2026-10-04T00:00:00.000Z", dataDir: { path: "C:\\mu-hub\\data\\DATA-PATH-MARKER", overridden: true, writable: true }, components: { stores: { status: "ok", detail: "6 stores open at C:\\mu-hub\\data\\DATA-PATH-MARKER\\crm.sqlite" } }, failed: [] }) },
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await mehrozPc.stop().catch(() => undefined);
  world.dispatcher.close();
  await usmanPc?.worker.stop?.();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await hub?.close().catch(() => undefined);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("deny by default: each route needs its own capability, checked on the hub for this request", () => {
  const id = "0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11";
  const routes: Array<[string, string, string, unknown?]> = [
    ["POST", "/crm/read", "crm.read", { name: "crm.snapshot" }],
    ["POST", "/crm/ops", "crm.write", { name: "crm.company.create", input: { name: "Refused Co" } }],
    ["GET", "/files/roots", "files.read"],
    ["GET", "/files/list?root=designs", "files.read"],
    ["GET", "/files/read?root=designs&path=index.html", "files.read"],
    ["POST", "/files/write", "files.write", { root: "drafts", path: "refused.md", content: "x" }],
    ["POST", "/tasks", "tasks.run", { text: "open the leads page" }],
    ["GET", "/jobs", "tasks.run"],
    ["POST", "/memory/recall", "memory.read", { query: "pricing" }],
    ["POST", "/memory/remember", "memory.write", { text: "a fact" }],
    ["POST", "/coding/draft", "coding.start", { utterance: "x", requestId: id }],
    ["POST", `/coding/jobs/${id}/start`, "coding.start", { specDigest: "x" }],
    ["GET", "/bots", "bots.operate"],
    ["GET", "/bots/research", "bots.operate"],
    ["GET", "/bots/research/screenshot", "bots.operate"],
    ["POST", "/bots/research/jobs", "bots.operate", { steps: [{ executor: "echo", args: {} }] }],
    ["POST", "/bots/research/takeover", "bots.operate"],
    ["POST", "/bots/research/input", "bots.operate", { executor: "input.click", args: { x: 1, y: 1 } }],
    ["POST", "/bots/research/terminal", "bots.terminal"],
    ["GET", "/diagnostics", "ops.read"],
    ["GET", "/diagnostics/releases", "ops.read"],
    ["GET", "/diagnostics/actions", "ops.read"],
  ];

  test("with view only, or with every OTHER capability, each route is 403 and names the capability; nothing happens", async () => {
    const before = { companies: crmStore.snapshot().companies.length, jobs: hub.jobs.list({ limit: 200 }).length, saved: memory.saved.length };
    for (const [method, path, cap, body] of routes) {
      for (const caps of [[], ALL_CAPS.filter((c) => c !== cap)]) {
        const r = await call(dot(...caps), method, path, body);
        expect([method, path, caps.length, r.status, r.json?.needs]).toEqual([method, path, caps.length, 403, cap]);
      }
    }
    expect({ companies: crmStore.snapshot().companies.length, jobs: hub.jobs.list({ limit: 200 }).length, saved: memory.saved.length }).toEqual(before);
    expect(hub.computers.view("research").controller.kind).toBeNull();
    expect(readdirSync(join(dir)).some((n) => n === "files")).toBe(false);
  });

  test("a founder, a bare sign-in and nobody are refused on Dot's routes: they act as Dot, so only Dot uses them", async () => {
    for (const [method, path, , body] of routes) {
      expect([path, (await call("usman", method, path, body)).status]).toEqual([path, 403]);
      expect([path, (await call("mehroz-bare", method, path, body)).status]).toEqual([path, 403]);
      expect([path, (await call("anon", method, path, body)).status]).toEqual([path, 401]);
    }
  });

  test("a write without Dot's own page token is refused, whatever the capability", async () => {
    for (const token of [null, "wrong", TOKEN, pageTokenFor({ personId: "usman", via: "paired-session" }, TOKEN)])
      expect([token, (await call(dot(...ALL_CAPS), "POST", "/crm/ops", { name: "crm.company.create", input: { name: "No Token Co" } }, { token })).status]).toEqual([token, 403]);
    expect(crmStore.snapshot().companies.some((c) => c.name === "No Token Co")).toBe(false);
  });

  test("the capability matrix says, per capability, working, not granted, unsupported or waiting on the owner", async () => {
    const mine = await call(dot("crm.read", "tasks.run"), "GET", "/capabilities");
    expect(mine.status).toBe(200);
    const byCap = Object.fromEntries((mine.json.rows as Array<{ capability: string; state: string; granted: boolean }>).map((r) => [r.capability, r]));
    expect(Object.keys(byCap).sort()).toEqual([...CAPABILITIES].sort());
    expect(byCap.view).toMatchObject({ state: "working", granted: true });
    expect(byCap["crm.read"]).toMatchObject({ state: "working", granted: true });
    expect(byCap["crm.write"]).toMatchObject({ state: "missing-authorisation", granted: false });
    expect(byCap["bots.operate"]).toMatchObject({ state: "missing-authorisation" });
    expect(String(byCap["crm.write"].detail)).toContain("grant crm.write");
    expect(mine.json.never.join(" ")).toContain("personal desktop");
    expect(mine.text).not.toContain(root);
  });
});

describe("crm: the typed operations, the same validation founders get, drafts stay drafts", () => {
  let companyId = "";
  let version = 0;

  test("create, read back, and a reversible update, all recorded as Dot's", async () => {
    const created = await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.create", input: { name: "Synthetic Dental Co", locality: "Mount Druitt", notes: "synthetic record" } });
    expect(created.status).toBe(200);
    expect(created.json.ok).toBe(true);
    companyId = created.json.data.id;
    version = created.json.data.version;
    expect(created.recordIds).toBe(companyId);
    // Reads need crm.read, and return the record.
    const got = await call(dot("crm.read"), "POST", "/crm/read", { name: "crm.record.get", input: { ref: { kind: "company", id: companyId } } });
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.json)).toContain("Synthetic Dental Co");
    // Update, then put it back.
    const changed = await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.update", input: { id: companyId, expectedVersion: version, patch: { locality: "Rooty Hill" } } });
    expect(changed.status).toBe(200);
    expect(changed.json.data.locality).toBe("Rooty Hill");
    const reverted = await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.update", input: { id: companyId, expectedVersion: changed.json.data.version, patch: { locality: "Mount Druitt" } } });
    expect(reverted.status).toBe(200);
    expect(reverted.json.data.locality).toBe("Mount Druitt");
    version = reverted.json.data.version;
    // A stale version is the CRM's own conflict, exactly as for a founder.
    const stale = await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.update", input: { id: companyId, expectedVersion: 1, patch: { locality: "Elsewhere" } } });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(crmStore.snapshot().companies.find((c) => c.id === companyId)!.locality).toBe("Mount Druitt");
    // Who did it: the agent "dot" with its gateway session. Never a founder.
    const story = JSON.stringify(crmStore.snapshot());
    expect(story).toContain(`"agent":"dot"`);
    expect(story).toContain(`gw:${SID}`);
    expect(story).not.toContain(`"personId":"usman"`);
  });

  test("the same validation as founders: a bad input is a 422 with field errors and changes nothing", async () => {
    const r = await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.create", input: { name: "", phone: "not a phone", surprise: true } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("validation");
    const founder = crmOps.run("crm.company.create", { name: "", phone: "not a phone", surprise: true }, { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" } as never);
    expect(founder.code).toBe("validation");
    expect(Object.keys(r.json.fieldErrors).sort()).toEqual(Object.keys(founder.fieldErrors ?? {}).sort());
  });

  test("contacts, deals, tasks, activities, projects and documents: written as drafts and records, nothing sent", async () => {
    const w = (name: string, input: unknown) => call(dot("crm.write"), "POST", "/crm/ops", { name, input });
    const contact = await w("crm.contact.add", { companyId, name: "Synthetic Receptionist", role: "Front desk" });
    expect(contact.status).toBe(200);
    const deal = await w("crm.deal.create", { companyId, title: "Synthetic website", service: "website" });
    expect(deal.status).toBe(200);
    const task = await w("crm.task.create", { companyId, title: "Follow up (synthetic)", kind: "follow-up" });
    expect(task.status).toBe(200);
    const done = await w("crm.task.complete", { id: task.json.data.id, expectedVersion: task.json.data.version });
    expect(done.status).toBe(200);
    const note = await w("crm.activity.add", { ref: { kind: "company", id: companyId }, eventId: "gw-test:note-1", kind: "note", title: "Drafted an intro email (not sent)", communicationState: "drafted" });
    expect(note.status).toBe(200);
    const again = await w("crm.activity.add", { ref: { kind: "company", id: companyId }, eventId: "gw-test:note-1", kind: "note", title: "Drafted an intro email (not sent)", communicationState: "drafted" });
    expect(again.status).toBe(200);
    const doc = await w("crm.document.create", { companyId, title: "Proposal draft (synthetic)", kind: "proposal", status: "draft", content: "Draft only." });
    expect(doc.status).toBe(200);
    expect(doc.json.data.status).toBe("draft");
    const project = await w("crm.project.create", { companyId, name: "Synthetic build" });
    expect(project.status).toBe(200);
    // Every activity on the company says Dot.
    const snapshot = await call(dot("crm.read"), "POST", "/crm/read", { name: "crm.snapshot" });
    expect(snapshot.status).toBe(200);
    expect(JSON.stringify(snapshot.json)).toContain("Drafted an intro email (not sent)");
  });

  test("only sends and what would bypass their approval stay refused: issuing, loosening contact, outbound claims, borrowed attribution", async () => {
    const w = (name: string, input: unknown) => call(dot(...ALL_CAPS), "POST", "/crm/ops", { name, input });
    const before = JSON.stringify(crmStore.snapshot());
    expect(GATEWAY_CRM_FOUNDER_ONLY).toEqual([]);
    expect((await w("crm.nonexistent", {})).status).toBe(404);
    expect((await w("crm.snapshot", {})).status).toBe(400); // a read sent to the write route
    expect((await call(dot(...ALL_CAPS), "POST", "/crm/read", { name: "crm.company.create", input: { name: "Sneaky" } })).status).toBe(400);
    expect((await w("crm.company.create", { name: "Extra key" })).status).toBe(200); // control: a plain create works
    const control = crmStore.snapshot().companies.find((c) => c.name === "Extra key")!;
    // Who may be contacted: loosening is refused (it authorises future outbound contact).
    for (const patch of [{ emailAllowed: true }, { doNotContact: false }, { excluded: false }]) {
      const r = await w("crm.company.update", { id: control.id, expectedVersion: control.version, patch });
      expect([JSON.stringify(patch), r.status, r.json.code]).toEqual([JSON.stringify(patch), 403, "restricted"]);
    }
    // Tightening is Dot's: do not contact, email off, excluded (with a reason).
    const tightened = await w("crm.company.update", { id: control.id, expectedVersion: control.version, patch: { doNotContact: true, emailAllowed: false, excluded: true, excludedReason: "asked not to be contacted (synthetic)" } });
    expect(tightened.status).toBe(200);
    expect(crmStore.getCompany(control.id)).toMatchObject({ doNotContact: true, excluded: true });
    // And it cannot be loosened back through the gateway.
    expect((await w("crm.company.update", { id: control.id, expectedVersion: tightened.json.data.version, patch: { doNotContact: false } })).status).toBe(403);
    expect((await w("crm.company.create", { name: "Mailable", emailAllowed: true })).status).toBe(403);
    expect((await w("crm.contact.add", { companyId: control.id, name: "X", doNotContact: false })).status).toBe(403);
    // A document is never issued or accepted through the gateway.
    for (const status of ["issued", "accepted"]) expect((await w("crm.document.create", { companyId: control.id, title: "Invoice", status })).status).toBe(403);
    // An activity never claims a message was queued, sent or received, and never borrows a founder's name.
    for (const extra of [{ communicationState: "sent" }, { communicationState: "queued" }, { communicationState: "received" }, { providerEvidence: { provider: "gmail", eventId: "e1", observedAt: "2026-10-04T00:00:00.000Z", state: "sent" } }, { by: { personId: "usman" } }, { by: { agent: "research", jobId: "job-1" } }]) {
      const r = await w("crm.activity.add", { ref: { kind: "company", id: control.id }, eventId: `gw-test:${JSON.stringify(extra).length}`, kind: "note", title: "Claim", ...extra });
      expect([JSON.stringify(extra), r.status, r.json.code]).toEqual([JSON.stringify(extra), 403, "restricted"]);
    }
    // Winning a deal is Dot's: it opens internal onboarding work only (here no automations are connected, so it says so).
    const pipeline = crmStore.snapshot().pipelines[0];
    const won = pipeline.stages.find((s) => s.category === "won")!;
    const open = pipeline.stages.find((s) => s.category === "open")!;
    const deal = await w("crm.deal.create", { companyId: control.id, title: "Open deal", stageId: open.id });
    expect(deal.status).toBe(200);
    const moved = await w("crm.deal.move", { id: deal.json.data.id, expectedVersion: deal.json.data.version, stageId: won.id });
    expect(moved.status).toBe(200);
    expect(moved.json.text).toContain("not a payment receipt");
    // Body shape: exactly { name, input }.
    expect((await call(dot(...ALL_CAPS), "POST", "/crm/ops", { name: "crm.company.create", input: { name: "Y" }, principal: { personId: "usman" } })).status).toBe(400);
    void before;
  });

  test("the guard is the CRM's own, on every path: a gateway principal without the capability is refused by ops.run itself", () => {
    const withCaps = (caps: string[]) => ({ personId: "dot", via: "gateway", actor: "process", sessionId: `gw:${SID}`, capabilities: caps }) as never;
    // Straight to the operations registry (what a Jarvis task's CRM lane would call): the same answer as the HTTP route.
    expect(crmOps.run("crm.company.create", { name: "No capability" }, withCaps(["view", "tasks.run"]))).toMatchObject({ ok: false, code: "unauthorised" });
    expect(crmOps.run("crm.snapshot", {}, withCaps(["view", "crm.write"]))).toMatchObject({ ok: false, code: "unauthorised" });
    expect(crmOps.run("crm.snapshot", {}, withCaps(["view", "crm.read"])).ok).toBe(true);
    expect(crmOps.run("crm.csv.export", { kind: "companies" }, withCaps(["view", "crm.read"]))).toMatchObject({ ok: false, code: "unauthorised" });
    expect(crmOps.run("crm.csv.export", { kind: "companies" }, withCaps(["view", "crm.write"])).ok).toBe(true);
    expect(crmOps.run("crm.document.create", { companyId, title: "Invoice", status: "issued" }, withCaps([...CAPABILITIES]))).toMatchObject({ ok: false, code: "restricted" });
    expect(crmStore.snapshot().companies.some((c) => c.name === "No capability")).toBe(false);
    // The lists are disjoint, and every operation the CRM registers is in exactly one of them (a new one is denied until placed).
    const lists = [...GATEWAY_CRM_READS, ...GATEWAY_CRM_WRITES, ...GATEWAY_CRM_FOUNDER_ONLY];
    expect(new Set(lists).size).toBe(lists.length);
    const registered = (crmOps.list() as Array<{ name: string }>).map((o) => o.name);
    expect(registered.filter((n) => !lists.includes(n))).toEqual([]);
    // A look-alike is not the gateway.
    expect(gatewayCrmGuard("crm.snapshot", {}, { personId: "dot", via: "paired-session", actor: "process", capabilities: ["crm.read"] }, { wonStageIds: () => new Set() })).toMatchObject({ ok: false, code: "unauthorised" });
    // A founder is untouched by any of it.
    expect(crmOps.run("crm.company.update", { id: companyId, expectedVersion: version, patch: { emailAllowed: false } }, { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" } as never).ok).toBe(true);
  });

  test("a read-only copy of the hub changes nothing", async () => {
    readOnly = true;
    try {
      expect((await call(dot("crm.write"), "POST", "/crm/ops", { name: "crm.company.create", input: { name: "Quiet copy" } })).status).toBe(409);
      expect((await call(dot("files.write"), "POST", "/files/write", { root: "drafts", path: "quiet.md", content: "x" })).status).toBe(409);
      expect((await call(dot("tasks.run"), "POST", "/tasks", { text: "open the leads page" })).status).toBe(409);
      expect((await call(dot("crm.read"), "POST", "/crm/read", { name: "crm.snapshot" })).status).toBe(200);
    } finally {
      readOnly = false;
    }
    expect(crmStore.snapshot().companies.some((c) => c.name === "Quiet copy")).toBe(false);
  });
});

describe("files: the approved roots through the routes", () => {
  test("roots, list, read, write and reverse; no path in any answer; refusals keep their reason", async () => {
    const roots = await call(dot("files.read"), "GET", "/files/roots");
    expect(roots.json.roots.map((r: { name: string }) => r.name)).toEqual(["drafts", "designs"]);
    expect((await call(dot("files.read"), "GET", "/files/list?root=designs")).json.entries.map((e: { name: string }) => e.name)).toEqual(["index.html"]);
    const page = await call(dot("files.read"), "GET", "/files/read?root=designs&path=index.html");
    expect(page.json).toMatchObject({ encoding: "utf8", content: "<h1>Synthetic design</h1>" });
    const written = await call(dot("files.write"), "POST", "/files/write", { root: "designs", path: "index.html", content: "<h1>Changed by Dot</h1>", expectedSha256: page.json.sha256 });
    expect(written.status).toBe(200);
    expect(written.json.previousSha256).toBe(page.json.sha256);
    expect(readFileSync(join(designs, "index.html"), "utf8")).toBe("<h1>Changed by Dot</h1>");
    const back = await call(dot("files.write"), "POST", "/files/write", { root: "designs", path: "index.html", content: "<h1>Synthetic design</h1>", expectedSha256: written.json.sha256 });
    expect(back.json.sha256).toBe(page.json.sha256);
    for (const r of [roots, page, written]) expect(r.text).not.toContain(root);
    // files.read does not write; files.write does not read.
    expect((await call(dot("files.read"), "POST", "/files/write", { root: "drafts", path: "a.md", content: "x" })).status).toBe(403);
    expect((await call(dot("files.write"), "GET", "/files/read?root=designs&path=index.html")).status).toBe(403);
    for (const [path, status] of [["../data/gateway/control.json", 400], ["..%2f..%2fx", 400], ["credentials.json", 403], [".env", 400]] as const)
      expect([path, (await call(dot("files.read"), "GET", `/files/read?root=designs&path=${path}`)).status]).toEqual([path, status]);
    expect((await call(dot("files.write"), "POST", "/files/write", { root: "drafts", path: "run.ps1", content: "x" })).status).toBe(403);
    expect((await call(dot("files.write"), "POST", "/files/write", { root: "drafts", path: "a.md", content: "x", mode: "0777" })).status).toBe(400);
    expect((await call(dot("files.read"), "GET", "/files/delete?root=drafts&path=a.md")).status).toBe(404);
  });
});

describe("tasks: through Jev, as Dot; never a founder's device, never the hub's desktop", () => {
  test("a task goes through Jev, becomes a job owned by Dot, and its result is read back", async () => {
    jevLane = "page";
    const asked = jevAsked.length;
    const r = await call(dot("tasks.run"), "POST", "/tasks", { text: "open the leads page", eventId: "gw-task-0001" });
    expect([200, 202]).toContain(r.status);
    expect(r.json.jobId).toMatch(/^[0-9a-f-]{36}$/);
    const job = await hub.waitFor("the task to settle", async () => {
      const j = await call(dot("tasks.run"), "GET", `/jobs/${r.json.jobId}`);
      return j.status === 200 && ["succeeded", "failed", "cancelled"].includes(j.json.job.state) ? j.json.job : null;
    });
    // The job says who: Dot, through the gateway, a program. No session key, no founder.
    expect(job.principal).toEqual({ personId: "dot", via: "gateway", actor: "process" });
    expect(job.steps.length).toBeGreaterThan(0);
    expect(jevAsked.length + (r.json.kind === "navigate" ? 1 : 0)).toBeGreaterThan(asked);
    expect((await call(dot("tasks.run"), "GET", "/jobs")).json.jobs.map((j: { id: string }) => j.id)).toContain(r.json.jobId);
    // The same eventId again is the same job, never a second run.
    const again = await call(dot("tasks.run"), "POST", "/tasks", { text: "open the leads page", eventId: "gw-task-0001" });
    expect(again.json.jobId).toBe(r.json.jobId);
  });

  test("a desktop request reaches nothing: not the hub's desktop, not a founder's PC, whatever Jev chooses", async () => {
    for (const [lane, words] of [["device.open", "open notepad"], ["device.screen", "click the start button and open settings"], ["device.open", "open notepad on Mehroz's PC"], ["device.open", "open notepad on my pc"], ["device.open", `open notepad on computer:${SYNTHETIC_MEHROZ_PC_ID}`], ["device.open", `open notepad on computer:${SYNTHETIC_USMAN_HUB_ID}`]] as const) {
      jevLane = lane;
      const r = await call(dot("tasks.run"), "POST", "/tasks", { text: words });
      expect([200, 202]).toContain(r.status);
      expect([words, r.json.ok]).toEqual([words, false]);
    }
    expect(hubDesktopCalls).toEqual([]);
    expect(ranOnMehrozPc).toEqual([]);
    // The resolver itself: "dot" owns nothing, and only an exact shared computer is ever a target.
    for (const spokenTarget of [undefined, "here", "my pc", "Mehroz's PC", "Usman's PC", "pc", `computer:${SYNTHETIC_MEHROZ_PC_ID}`, `computer:${SYNTHETIC_USMAN_HUB_ID}`]) {
      expect([spokenTarget, resolveTarget({ personId: "dot", ...(spokenTarget ? { spokenTarget } : {}), originDeviceId: SYNTHETIC_USMAN_HUB_ID }, world.registry).ok]).toEqual([spokenTarget, false]);
    }
    const research = hub.computers.view("research");
    expect(resolveTarget({ personId: "dot", spokenTarget: `computer:${research.id}` }, hub.devices.registry)).toMatchObject({ ok: true, deviceId: research.id, owner: "shared" });
    expect(resolveTarget({ personId: "dot", spokenTarget: `computer:${usmanPc.deviceId}` }, hub.devices.registry).ok).toBe(false);
    expect(resolveTarget({ personId: "dot", spokenTarget: "the research computer" }, hub.devices.registry).ok).toBe(false); // by exact id only
  });

  test("Dot reads and stops only its own jobs; a founder's job does not exist for it", async () => {
    const founders = hub.jobs.create({ kind: "command", principal: { personId: "usman", via: "paired-session", actor: "human" }, targetDeviceId: "none", title: "A founder's private command" });
    expect((await call(dot("tasks.run"), "GET", `/jobs/${founders.id}`)).status).toBe(404);
    expect((await call(dot("tasks.run"), "POST", `/jobs/${founders.id}/stop`)).status).toBe(404);
    expect(hub.jobs.get(founders.id)!.state).toBe("queued");
    const list = await call(dot("tasks.run"), "GET", "/jobs");
    expect(list.text).not.toContain("A founder's private command");
    expect(list.json.jobs.every((j: { principal: { personId: string } }) => j.principal.personId === "dot")).toBe(true);
    // Its own running job stops.
    const own = hub.jobs.create({ kind: "command", principal: { personId: "dot", via: "gateway", actor: "process" } as never, targetDeviceId: "none", title: "Dot's long task" });
    let release!: () => void;
    void hub.jobs.run(own.id, (ctx) => new Promise((resolve) => ((release = () => resolve({ ok: false, note: "stopped" })), ctx.signal.addEventListener("abort", () => release()))));
    await hub.waitFor("running", () => hub.jobs.get(own.id)!.state === "running");
    const stopped = await call(dot("tasks.run"), "POST", `/jobs/${own.id}/stop`);
    expect(stopped.status).toBe(202);
    await hub.waitFor("cancelled", () => hub.jobs.get(own.id)!.state === "cancelled");
    hub.jobs.cancel(founders.id).catch(() => undefined);
  });

  test("the job store records a job as Dot's only for the gateway actor; approvals never accept it", () => {
    expect(() => hub.jobs.create({ kind: "command", principal: { personId: "dot", via: "paired-session", actor: "human" } as never, targetDeviceId: "none", title: "x" })).toThrow();
    expect(() => hub.jobs.create({ kind: "command", principal: { personId: "stranger", via: "gateway", actor: "process" } as never, targetDeviceId: "none", title: "x" })).toThrow();
    const approvals = new ApprovalService({ path: join(root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
    try {
      const dotPrincipal = { personId: "dot", via: "gateway", actor: "process", sessionId: `gw:${SID}` } as never;
      // Dot can neither file a request for an approval nor decide one.
      let asked: unknown;
      try {
        asked = approvals.request({ requester: dotPrincipal, action: "git.merge.protected", scope: { approverPersonId: "usman", resource: "coding:x", deviceId: "hub" }, summary: "merge", origin: "principal" } as never);
      } catch (e) {
        asked = { ok: false, threw: String((e as Error).message) };
      }
      expect((asked as { ok?: boolean }).ok).not.toBe(true);
      expect(approvals.list({ limit: 10 }).length).toBe(0);
    } finally {
      approvals.close();
    }
  });
});

describe("memory: through the memory API, Dot as provenance, the owner's switch respected", () => {
  test("recall returns business, research and general facts only; personal, deen and finance never leave", async () => {
    const r = await call(dot("memory.read"), "POST", "/memory/recall", { query: "pricing" });
    expect(r.status).toBe(200);
    expect(r.json.facts.map((f: { id: string }) => f.id)).toEqual(["mf-biz", "mem-research"]);
    expect(r.json.withheld).toBe(4);
    for (const marker of ["PERSONAL-MARKER", "DEEN-MARKER", "FINANCE-MARKER", "UNKNOWN-MARKER"]) expect(r.text).not.toContain(marker);
    expect(r.json.buckets).toEqual([...MEMORY_BUCKETS_FOR_GATEWAY]);
    expect(r.text).not.toContain("obsidian://");
    memory.off = true;
    const off = await call(dot("memory.read"), "POST", "/memory/recall", { query: "pricing" });
    memory.off = false;
    expect(off.json).toMatchObject({ ok: true, facts: [] });
    expect(off.json.off).toContain("memory is off");
  });

  test("remember is refused while MU_MEMORY_WRITES is off; when on it is saved as Dot's, a program", async () => {
    memory.writes = false;
    const refused = await call(dot("memory.write"), "POST", "/memory/remember", { text: "Synthetic fact from Dot." });
    expect([refused.status, refused.json.code]).toEqual([409, "writes-disabled"]);
    expect(memory.saved).toEqual([]);
    memory.writes = true;
    const saved = await call(dot("memory.write"), "POST", "/memory/remember", { text: "Synthetic fact from Dot.", title: "Synthetic" });
    memory.writes = false;
    expect([saved.status, saved.json.id]).toEqual([200, "mem-new-1"]);
    expect(memory.saved[0].p).toEqual({ id: "dot", name: "Dot", via: "system", actor: "process" });
    expect(memory.saved[0].input).toMatchObject({ text: "Synthetic fact from Dot.", title: "Synthetic", channel: "agent" });
    expect(String(memory.saved[0].input.note)).toContain("Dot through the gateway");
    // No bucket, vault or forget control is offered.
    expect((await call(dot("memory.write"), "POST", "/memory/remember", { text: "x", bucket: "personal" })).status).toBe(400);
    expect((await call(dot("memory.read", "memory.write"), "POST", "/memory/forget", { id: "mf-biz" })).status).toBe(404);
    expect((await call(dot("memory.read", "memory.write"), "POST", "/memory/vault/save", { text: "x" })).status).toBe(404);
  });
});

describe("shared bot computers: Dot's, with bots.operate; a personal device and the hub never", () => {
  test("list shows shared bots only; a founder's personal PC is not a bot and cannot be named", async () => {
    const list = await call(dot("bots.operate"), "GET", "/bots");
    expect(list.status).toBe(200);
    expect(list.json.bots.map((b: { name: string; shared: boolean }) => [b.name, b.shared])).toEqual([["research", true]]);
    expect(list.text).not.toContain(usmanPc.deviceId);
    expect(list.json.bots[0].watch).toEqual({ screenshot: expect.any(Boolean), liveViewer: false });
    // The personal PC is a device of the hub, but no name reaches it through any bot route.
    for (const name of [usmanPc.deviceId, "usman-pc", "hub", "usmans-pc"]) {
      const safe = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
      expect([safe, (await call(dot("bots.operate"), "POST", `/bots/${safe}/takeover`)).status]).toEqual([safe, 404]);
      expect([safe, (await call(dot("bots.operate"), "POST", `/bots/${safe}/jobs`, { steps: [{ executor: "echo", args: {} }] })).status]).toEqual([safe, 404]);
    }
    expect(usmanPc.ran).toEqual([]);
    // The permission table: shared computers yes; a personal device or the hub never, for "dot".
    const personal = hub.devices.registry.all().find((d) => d.id === usmanPc.deviceId)!;
    const shared = hub.devices.registry.all().find((d) => d.id === hub.computers.view("research").id)!;
    expect(mayControl("dot", shared)).toEqual({ allowed: true });
    expect(mayTakeOver("dot", shared)).toEqual({ allowed: true });
    expect(mayControl("dot", personal).allowed).toBe(false);
    expect(mayTakeOver("dot", personal).allowed).toBe(false);
    expect(mayControl("dot", { kind: "hub", owner: "usman", label: "Usman's PC" }).allowed).toBe(false);
    expect(mayControl("dot", { kind: "companion", owner: "mehroz", label: "Mehroz's PC" }).allowed).toBe(false);
    expect(mayControl("stranger", shared).allowed).toBe(false);
  });

  test("start a bot job as Dot, read its result, and the bot ran it (not a founder's PC)", async () => {
    const started = await call(dot("bots.operate"), "POST", "/bots/research/jobs", { title: "Synthetic echo", steps: [{ executor: "echo", args: { tag: "dot-1" } }] });
    expect(started.status).toBe(202);
    const job = await hub.waitFor("the bot job to finish", () => {
      const j = hub.jobs.get(started.json.jobId);
      return j && ["succeeded", "failed"].includes(j.state) ? j : null;
    });
    expect(job.state).toBe("succeeded");
    expect(job.principal).toEqual({ personId: "dot", via: "gateway", actor: "process" });
    expect(job.kind).toBe("control");
    const mine = await call(dot("tasks.run"), "GET", `/jobs/${started.json.jobId}`);
    expect(mine.status).toBe(200);
    expect(usmanPc.ran).toEqual([]);
    // A risky step is refused by the computers service's own validation, as for anyone.
    const risky = await call(dot("bots.operate"), "POST", "/bots/research/jobs", { steps: [{ executor: "message.send", args: { to: "client@example.test" } }] });
    expect(risky.status).toBeGreaterThanOrEqual(400);
    expect(ranOnBot).toEqual(["echo"]);
    expect((await call(dot("bots.operate"), "POST", "/bots/nope/jobs", { steps: [] })).status).toBe(404);
  });

  test("take the control lease, send input, renew, and hand it back; without the lease input is refused", async () => {
    expect((await call(dot("bots.operate"), "POST", "/bots/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(409);
    const taken = await call(dot("bots.operate"), "POST", "/bots/research/takeover");
    expect(taken.status).toBe(200);
    expect(taken.json.bot.heldByYou).toBe(true);
    expect(hub.computers.view("research").controller).toMatchObject({ kind: "person", who: "dot" });
    const click = await call(dot("bots.operate"), "POST", "/bots/research/input", { executor: "input.click", args: { x: 10, y: 20, tag: "dot" } });
    expect(click.status).toBe(200);
    expect(ranOnBot.filter((e) => e === "input.click").length).toBe(1);
    // Only what a person at the controls may send: the founders' own input list. Anything else is refused before the bot is asked.
    for (const executor of ["echo", "message.send", "shell.run", "file.delete"]) expect([executor, (await call(dot("bots.operate"), "POST", "/bots/research/input", { executor, args: {} })).status]).toEqual([executor, 400]);
    expect(ranOnBot).not.toContain("message.send");
    expect((await call(dot("bots.operate"), "POST", "/bots/research/lease/renew")).status).toBe(200);
    // One controller at a time: a founder's own job is told Dot holds it; another gateway session does not hold Dot's lease.
    const founderJob = await hub.api("usman", "POST", "/research/jobs", { agent: "reader", steps: [{ executor: "echo", args: {} }] });
    expect(founderJob.status).toBe(409);
    expect((await call({ dot: ["bots.operate"], session: "cd".repeat(12) }, "POST", "/bots/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(409);
    // Without bots.terminal there is no terminal, even while holding the lease.
    expect((await call(dot("bots.operate"), "POST", "/bots/research/terminal")).status).toBe(403);
    const term = await call(dot("bots.operate", "bots.terminal"), "POST", "/bots/research/terminal", { cols: 100, rows: 30 });
    expect(term.status).toBe(200);
    expect(term.json.id).toMatch(/^[a-z0-9]{6,40}$/);
    expect((await call(dot("bots.terminal"), "POST", `/bots/research/terminal/${term.json.id}/input`, { data: "echo hello\n" })).status).toBe(200);
    const out = await call(dot("bots.terminal"), "GET", `/bots/research/terminal/${term.json.id}/events?after=0&wait=500`);
    expect(out.status).toBe(200);
    expect(JSON.stringify(out.json.chunks)).toContain("echo hello");
    const returned = await call(dot("bots.operate"), "POST", "/bots/research/return");
    expect(returned.status).toBe(200);
    expect(hub.computers.view("research").controller.kind).toBeNull();
    // The lease is gone: the terminal closes with it, and input is refused again.
    expect((await call(dot("bots.terminal"), "POST", `/bots/research/terminal/${term.json.id}/input`, { data: "whoami\n" })).status).toBeGreaterThanOrEqual(400);
    expect((await call(dot("bots.operate", "bots.terminal"), "POST", "/bots/research/terminal")).status).toBe(409);
    expect((await call(dot("bots.operate"), "POST", "/bots/research/input", { executor: "input.click", args: { x: 1, y: 1 } })).status).toBe(409);
    // Provisioning, lifecycle and setup are not routes at all.
    for (const [method, path] of [["POST", "/bots"], ["POST", "/bots/research/action"], ["POST", "/bots/research/screen-report"], ["POST", "/bots/research/take-here"]] as const) expect([path, (await call(dot(...ALL_CAPS), method, path, { name: "x", action: "stop" })).status]).toEqual([path, 404]);
  });

  test("a hub with no computers service or no bots says so honestly", async () => {
    const empty = createGatewayRoutes({ root, internalToken: () => TOKEN, dir, principal: principalOf, operate: { env: () => env, computers: () => undefined, commands: () => undefined, memory: () => undefined, crm: () => crmOps as never, jobs: () => hub.jobs as never } });
    const s = createServer((req, res) => void empty(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}/__gateway`;
    const get = async (path: string, caps: string) => {
      const res = await fetch(b + path, { headers: { "x-test-who": `dot:${SID}:${caps}` } });
      return { status: res.status, json: (await res.json()) as any };
    };
    try {
      const bots = await get("/bots", "bots.operate");
      expect(bots).toMatchObject({ status: 200, json: { bots: [], unsupported: true } });
      const matrix = await get("/capabilities", OPERATE_SET.join(","));
      const state = Object.fromEntries(matrix.json.rows.map((r: { capability: string; state: string }) => [r.capability, r.state]));
      expect(state).toMatchObject({ "bots.operate": "unsupported", "bots.terminal": "unsupported", "tasks.run": "unsupported", "memory.read": "unsupported", "crm.write": "working" });
      const task = await fetch(`${b}/tasks`, { method: "POST", headers: { "x-test-who": `dot:${SID}:tasks.run`, "content-type": "application/json", "x-claude-os-token": pageTokenFor({ personId: "dot" as never, via: "gateway" }, TOKEN) }, body: JSON.stringify({ text: "open the leads page" }) });
      expect(task.status).toBe(503);
    } finally {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("diagnostics and the hub's record of what Dot did", () => {
  test("health and version are sanitised; release receipts carry no path; the action log names Dot and holds no body", async () => {
    const d = await call(dot("ops.read"), "GET", "/diagnostics");
    expect(d.status).toBe(200);
    expect(d.json.version).toMatchObject({ gitSha: "testsha" });
    expect(d.json.health).toMatchObject({ ok: true, hubRole: "server" });
    expect(d.text).not.toContain("DATA-PATH-MARKER");
    const releases = await call(dot("ops.read"), "GET", "/diagnostics/releases");
    expect(releases.json).toMatchObject({ configured: true, receipts: [{ file: "release-20261003T212700.json", newHead: "664c0c91", rollbackTag: "rollback/pre-r8-20261003", crmMigrated: false }] });
    for (const marker of ["BACKUP-PATH-MARKER", "hub.env", "NOT-A-RECEIPT", receiptsDir]) expect(releases.text).not.toContain(marker);
    expect(releaseReceipts({})).toMatchObject({ configured: false, receipts: [] });
    const log = await call(dot("ops.read"), "GET", "/diagnostics/actions?tail=500");
    expect(log.status).toBe(200);
    const actions = log.json.actions as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(20);
    expect(actions.every((a) => a.person === "dot" && typeof a.session === "string" && typeof a.action === "string" && typeof a.capability === "string")).toBe(true);
    expect(actions.some((a) => a.action === "crm.company.create" && a.outcome === "done" && a.delegatedBy === "usman")).toBe(true);
    expect(actions.some((a) => a.action === "files.write" && String(a.target).startsWith("designs:"))).toBe(true);
    expect(actions.some((a) => a.outcome === "refused" && a.status === 403)).toBe(true);
    // Nothing a request carried is in it: no body text, no token, no file content.
    const raw = readdirSync(dir).filter((n) => n.startsWith("hub-actions-")).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
    for (const secret of ["Synthetic Dental Co", "Changed by Dot", "Synthetic fact from Dot", pageTokenFor({ personId: "dot" as never, via: "gateway" }, TOKEN), TOKEN, "echo hello"]) expect(raw.includes(secret)).toBe(false);
  });

  test("the job log shows founders' jobs as shape only, never their words (review B1, 4 Oct)", async () => {
    const founders = hub.jobs.create({ kind: "voice", principal: { personId: "usman", via: "paired-session", actor: "human" }, targetDeviceId: "none", title: "PRIVATE-FOUNDER-WORDS who called the receptionist" });
    const own = hub.jobs.create({ kind: "command", principal: { personId: "dot", via: "gateway", actor: "process" } as never, targetDeviceId: "none", title: "Dot's diagnostic task" });
    expect((await call(dot("view"), "GET", "/diagnostics/jobs")).status).toBe(403);
    const list = await call(dot("ops.read"), "GET", "/diagnostics/jobs?limit=200");
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("PRIVATE-FOUNDER-WORDS");
    const rows = list.json.jobs as Array<Record<string, unknown>>;
    expect(rows.find((j) => j.id === founders.id)).toEqual(expect.objectContaining({ id: founders.id, kind: "voice", yours: false }));
    expect(Object.keys(rows.find((j) => j.id === founders.id)!).sort()).toEqual(["createdAt", "id", "kind", "quarantined", "state", "stepCount", "updatedAt", "yours"]);
    expect(rows.find((j) => j.id === own.id)).toEqual(expect.objectContaining({ title: "Dot's diagnostic task", yours: true }));
    const one = await call(dot("ops.read"), "GET", `/diagnostics/jobs/${founders.id}`);
    expect(one.status).toBe(200);
    expect(one.text).not.toContain("PRIVATE-FOUNDER-WORDS");
    expect(permitted("GET", "/__jobs", [...GRANTABLE, "view"]).ok).toBe(false);
    expect(permitted("GET", "/__jobs/events", [...GRANTABLE, "view"]).ok).toBe(false);
  });
});

describe("founders: Dot's identity in Devices and people, revocable there", () => {
  test("a confirmed founder lists identities and revokes one; a bare sign-in may look but not revoke; Dot may do neither", async () => {
    const control = new ControlFile(dir);
    const { code } = control.mintCode({ by: "usman", label: "Dot (cloud browser)" });
    const sessions = new SessionFile(dir);
    const first = sessions.redeem(code, control.read(), ["view"])!;
    control.grant({ capability: "crm.write", by: "usman", hours: 1 });
    const listed = await call("usman", "GET", "/admin/access");
    expect(listed.status).toBe(200);
    expect(listed.json.identities).toMatchObject([{ id: first.identity.id, label: "Dot (cloud browser)", enrolledBy: "usman", state: "active", activeSessions: 1 }]);
    expect(listed.json.capabilities.map((c: { name: string }) => c.name).sort()).toEqual(["crm.write", "view"]);
    expect(listed.json.canRevoke).toBe(true);
    // No key, hash or token in what a founder's browser receives.
    for (const secret of [first.reconnectKey, first.token, first.identity.keyHash, first.session.tokenHash, code]) expect(listed.text.includes(secret)).toBe(false);
    // Dot, with everything granted, reaches neither route.
    expect((await call(dot(...ALL_CAPS), "GET", "/admin/access")).status).toBe(403);
    expect((await call(dot(...ALL_CAPS), "POST", `/admin/identities/${first.identity.id}/revoke`)).status).toBe(403);
    // A bare Tailscale sign-in (not a confirmed person) can see the list but cannot revoke.
    const bare = await call("mehroz-bare", "GET", "/admin/access");
    expect([bare.status, bare.json.canRevoke]).toEqual([200, false]);
    expect((await call("mehroz-bare", "POST", `/admin/identities/${first.identity.id}/revoke`)).status).toBe(403);
    expect((await call("anon", "GET", "/admin/access")).status).toBe(401);
    expect((await call("usman", "POST", `/admin/identities/${first.identity.id}/revoke`, {}, { token: "wrong" })).status).toBe(403);
    expect(sessions.verify(first.token, control.read()).ok).toBe(true);
    expect((await call("usman", "POST", "/admin/identities/0123456789abcdef/revoke")).status).toBe(404);
    // The founder revokes: the session is dead on the very next check, and so is the reconnect key.
    const revoked = await call("usman", "POST", `/admin/identities/${first.identity.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.json.identities[0].state).toBe("revoked");
    expect(sessions.verify(first.token, new ControlFile(dir).read())).toEqual({ ok: false, reason: "revoked" });
    expect(sessions.renew(first.reconnectKey, new ControlFile(dir).read(), ["view"])).toBeNull();
    expect(readAudit(dir).some((e) => e.event === "identity-revoked" && e.identity === first.identity.id && e.delegatedBy === "usman")).toBe(true);
    expect(readFileSync(join(dir, FILES.control), "utf8")).toContain(first.identity.id);
  });

  test("renewal: a confirmed founder renews 30 days in one step; a bare sign-in and Dot cannot; Dot sees expiry and renewSoon", async () => {
    const control = new ControlFile(dir);
    const { code } = control.mintCode({ by: "usman", label: "Dot (renewal)", identityDays: 3 });
    const sessions = new SessionFile(dir);
    const first = sessions.redeem(code, control.read(), ["view"])!;
    control.grant({ capability: "crm.read", by: "usman", hours: 24 });
    const listed = await call("usman", "GET", "/admin/access");
    expect(listed.json).toMatchObject({ canRenew: true, expiry: { renewSoon: true } });
    expect((await call("mehroz-bare", "GET", "/admin/access")).json.canRenew).toBe(false);
    expect((await call("mehroz-bare", "POST", "/admin/renew")).status).toBe(403);
    expect((await call(dot(...ALL_CAPS), "POST", "/admin/renew")).status).toBe(403);
    expect((await call("usman", "POST", "/admin/renew", {}, { token: "wrong" })).status).toBe(403);
    const renewed = await call("usman", "POST", "/admin/renew");
    expect(renewed.status).toBe(200);
    const id = renewed.json.identities.find((i: { id: string }) => i.id === first.identity.id);
    expect(Math.round((id.expiresAt - Date.now()) / 86_400_000)).toBe(30);
    expect(renewed.json.grants.map((g: { capability: string }) => g.capability)).toContain("crm.read");
    expect(readAudit(dir).some((e) => e.event === "identity-renewed" && e.delegatedBy === "usman")).toBe(true);
    // Dot's matrix carries the expiry view (its identity comes from the verified assertion; the grants from the control file).
    const matrix = await call(dot("crm.read"), "GET", "/capabilities");
    expect(matrix.json.expiry.grants.some((g: { capability: string; expiresAt: number }) => g.capability === "crm.read" && g.expiresAt > Date.now() + 20 * 86_400_000)).toBe(true);
    expect(typeof matrix.json.expiry.renewSoon).toBe("boolean");
    expect(matrix.json.expiry.renewal).toContain("renew --by");
  });
});

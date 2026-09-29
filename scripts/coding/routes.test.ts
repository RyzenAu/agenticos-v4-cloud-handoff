import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Principal } from "../approvals/principal";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { codingMiddleware } from "./plugin";
import { codingRoute, sseFrames, type CodingRuntime } from "./routes";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { routerRunner } from "./runners/router";
import { createShaper } from "./shaper";
import { claudeBinding, draftSpec, specDigest } from "./spec";
import { CodingStore } from "./store";
import { cleanup, fixtureRepo } from "./test-fixtures";

/** The /__operator/coding routes over a SYNTHETIC store (no agent runs here). */
const fx = fixtureRepo();
afterAll(() => { rt.orch.close(); rt.store.close(); approvals.close(); cleanup(fx.root); });
const registry: RepoRegistry = { version: 1, repos: [fx.entry] };
const store = CodingStore.open(join(fx.root, "coding-data"));
const approvals = new ApprovalService({ path: join(fx.root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
const never = { start: () => { throw new Error("no agent runs in route tests"); } } as never;
const orch = createOrchestrator({ store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, runners: { claude: claudeRunner(), codex: codexRunner(), router: routerRunner() }, approvals: () => approvals, liveRoot: null });
void never;
const shaper = createShaper({ registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), jev: null, planner: null });
const rt: CodingRuntime = { store, orch, shaper, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS, approvals: () => approvals, cliVersions: () => ({ claude: "2.1.280", codex: "0.154.0" }), focus: null };

const OWNER: Principal = { personId: "usman", via: "loopback-owner", actor: "human", deviceId: "usman-pc", sessionId: "sk1.owner-session-key-never-in-json" };
const MEHROZ: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", sessionId: "sk1.mehroz-session-key" };
const call = (method: string, path: string, body: unknown = {}, principal: Principal | null = OWNER) =>
  codingRoute({ method, path: path.split("?")[0], url: new URL(`http://x${path}`), body, principal }, rt);

function draft() {
  const spec = draftSpec({
    requestedBy: { personId: "usman" as never, via: "local", deviceId: "usman-pc" as never, sessionId: "hash" }, channel: "ui", utterance: "x", entry: fx.entry,
    objective: "Set a to 42 in the fixture", doneWhen: [{ id: "c1", text: "a is 42", evidence: "reviewer-confirms" }], roleTemplate: "build+review",
    builders: [{ binding: claudeBinding("claude-opus-5-5", "2.1.280"), owns: { globs: ["src/a.ts"], newFiles: [] } }], reviewer: { binding: claudeBinding("claude-opus-5-5", "2.1.280") }, checks: ["fx.test" as never],
  });
  return orch.draft(spec).job;
}

describe("coding routes", () => {
  test("no principal → 401 on every route", async () => {
    for (const [m, p] of [["GET", "/coding/jobs"], ["POST", "/coding/shape"], ["GET", "/coding/repos"]]) expect((await call(m, p, {}, null))!).toMatchObject({ status: 401 });
    // R4: a request longer than a draft takes is refused with the reason, never cut.
    const long = (await call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance: "set a to 42 in src/a.ts. ".repeat(60), channel: "typed" })) as { status: number; body: any };
    expect(long.status).toBe(400);
    expect(long.body.error).toContain("over 1,000 characters");
  }, 120_000);
  test("list, detail, events (poll resumes after a seq) and SSE frames", async () => {
    const job = draft();
    const list = (await call("GET", "/coding/jobs")) as { status: number; body: any };
    expect(list.status).toBe(200);
    expect(list.body.jobs.map((j: any) => j.id)).toContain(job.id);
    const detail = (await call("GET", `/coding/jobs/${job.id}`)) as { status: number; body: any };
    expect(detail.body.job.id).toBe(job.id);
    expect(detail.body.specDigest).toBe(specDigest(job.spec));
    const all = (await call("GET", `/coding/jobs/${job.id}/events?poll=1&after=0`)) as { body: any };
    const after = (await call("GET", `/coding/jobs/${job.id}/events?poll=1&after=1`)) as { body: any };
    expect(after.body.events.length).toBe(all.body.events.length - 1);
    expect(after.body.events[0].seq).toBe(2);
    const sse = await call("GET", `/coding/jobs/${job.id}/events?after=1`);
    expect(sse).toMatchObject({ sse: { jobId: job.id, after: 1 } });
    expect(sseFrames(all.body.events)).toContain(`id: 1\nevent: coding\ndata: `);
  }, 120_000);
  test("a POST can't claim a spoken yes; the UI confirmation starts only with the digest that was shown", async () => {
    const job = draft();
    expect(await call("POST", "/coding/jobs", { specId: job.id, specDigest: specDigest(job.spec), confirmation: "spoken-yes" })).toMatchObject({ status: 400 });
    expect(await call("POST", "/coding/jobs", { specId: job.id, specDigest: "0".repeat(64), confirmation: "ui" })).toMatchObject({ status: 409 });
  }, 120_000);
  test("owner decision 4: Mehroz (tailnet, signed in) can see and shape jobs; the requester is recorded from the principal, never the body", async () => {
    const list = (await call("GET", "/coding/jobs", {}, MEHROZ)) as { status: number };
    expect(list.status).toBe(200);
    const shaped = (await call("POST", "/coding/shape", { requestId: crypto.randomUUID(), utterance: "set a to 42 in src/a.ts. Opus builds, another Opus reviews.", channel: "typed", personId: "usman" }, MEHROZ)) as { status: number; body: any };
    expect(shaped.status).toBe(200);
    expect(shaped.body.kind).toBe("draft");
    expect(shaped.body.spec.requestedBy.personId).toBe("mehroz");
    // The session key never appears in any coding JSON (A1-1's rule).
    expect(JSON.stringify(shaped.body)).not.toContain("sk1.");
  }, 120_000);
  test("merging is only asked, and only for a completed job with a passed gate", async () => {
    const job = draft();
    const r = (await call("POST", `/coding/jobs/${job.id}/apply`, { action: "git.merge.protected", toRef: "main" })) as { status: number; body: any };
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/completed job/);
  }, 120_000);
  test("REVIEW-T3 F6: a program with the page token can read and draft, never start, stop, answer or approve", async () => {
    const PROGRAM: Principal = { personId: "usman", via: "loopback-owner", actor: "process" } as Principal;
    const TELEGRAM: Principal = { personId: "usman", via: "telegram", actor: "human", sessionId: "tg-session-123" } as Principal;
    const job = draft();
    expect(await call("GET", "/coding/jobs", {}, PROGRAM)).toMatchObject({ status: 200 });
    for (const who of [PROGRAM, TELEGRAM]) {
      expect(await call("POST", "/coding/jobs", { specId: job.id, specDigest: specDigest(job.spec), confirmation: "ui" }, who)).toMatchObject({ status: 403 });
      for (const action of ["cancel", "interrupt", "resume", "input", "apply", "tests/rerun"])
        expect(await call("POST", `/coding/jobs/${job.id}/${action}`, { action: "git.merge.protected", toRef: "main", decision: "approve" }, who)).toMatchObject({ status: 403 });
    }
    expect(rt.store.getJob(job.id)!.state).toBe(job.state);
  }, 120_000);
  test("REVIEW-T3 F6: no sessionId or deviceId in any coding JSON, and requestIds are per person and route", async () => {
    const job = draft();
    const detail = (await call("GET", `/coding/jobs/${job.id}`)) as { body: any };
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain("sessionId");
    expect(text).not.toContain("deviceId");
    const events = (await call("GET", `/coding/jobs/${job.id}/events?poll=1&after=0`)) as { body: any };
    expect(sseFrames([{ ...events.body.events[0], payload: { by: { personId: "usman", via: "local", sessionId: "hash", deviceId: "usman-pc" } } }])).not.toMatch(/sessionId|deviceId/);
    const requestId = crypto.randomUUID();
    const mine = (await call("POST", "/coding/shape", { requestId, utterance: "set a to 42 in src/a.ts. Opus builds, another Opus reviews.", channel: "typed" }, MEHROZ)) as { body: any };
    const owner = (await call("POST", "/coding/shape", { requestId, utterance: "set a to 42 in src/a.ts. Opus builds, another Opus reviews.", channel: "typed" }, OWNER)) as { body: any };
    expect(mine.body.spec.requestedBy.personId).toBe("mehroz");
    expect(owner.body.spec.requestedBy.personId).toBe("usman");
  }, 120_000);
  test("artefacts are read by id only; unknown routes are 404", async () => {
    const job = draft();
    const id = store.putArtefact(job.id, "patch text with sk-ant-api03-" + "X".repeat(40));
    const art = (await call("GET", `/coding/artefacts/${job.id}/${id}`)) as { text: string };
    expect(art.text).toContain("patch text");
    expect(art.text).not.toContain("XXXXXXXXXXXXXXXXXXXX");
    expect(await call("GET", `/coding/artefacts/${job.id}/../../x`)).toMatchObject({ status: 404 });
    expect(await call("GET", "/coding/nope")).toMatchObject({ status: 404 });
  }, 120_000);
});

describe("coding middleware transport checks", () => {
  function req(opts: { url: string; method?: string; remote?: string; headers?: Record<string, string>; body?: string }) {
    const e = new EventEmitter() as any;
    e.url = opts.url; e.method = opts.method ?? "GET"; e.headers = { host: "127.0.0.1:4473", ...(opts.headers ?? {}) }; e.socket = { remoteAddress: opts.remote ?? "127.0.0.1" };
    e[Symbol.asyncIterator] = async function* () { if (opts.body) yield Buffer.from(opts.body); };
    return e;
  }
  function res() {
    const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { r.headers[k] = v; }, end(b?: string) { r.body = b ?? ""; r.ended = true; }, write() {} };
    return r;
  }
  const mw = codingMiddleware({ root: fx.root, token: "internal-token", resolvePrincipal: () => OWNER, runtime: () => rt });
  test("non-canonical paths, non-loopback sockets, cross-site and a missing page token are refused", async () => {
    for (const [r, status] of [
      [req({ url: "/__operator/coding/jobs/../x" }), 400],
      [req({ url: "/__operator/coding/jobs", remote: "100.64.1.2" }), 403],
      [req({ url: "/__operator/coding/jobs", headers: { "sec-fetch-site": "cross-site" } }), 403],
      [req({ url: "/__operator/coding/jobs", headers: { origin: "http://evil.test" } }), 403],
      [req({ url: "/__operator/coding/shape", method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), 403],
    ] as const) {
      const out = res();
      await mw(r, out, () => { out.nexted = true; });
      expect(out.statusCode).toBe(status);
    }
  }, 120_000);
  test("other paths fall through to the operator plugin", async () => {
    const out = res();
    let next = false;
    await mw(req({ url: "/__operator/leads" }), out, () => { next = true; });
    expect(next).toBe(true);
  }, 120_000);
});

describe("GET /coding/accounts reports Codex isolation (W-B)", () => {
  test("paused until --apply when there's no owner record; protected with one; read-only either way", async () => {
    const paused = (await codingRoute({ method: "GET", path: "/coding/accounts", url: new URL("http://x/coding/accounts"), body: {}, principal: OWNER }, { ...rt, codexIsolationApproval: () => null })) as { status: number; body: any };
    expect(paused.status).toBe(200);
    expect(paused.body.codexIsolation).toMatchObject({ state: "paused", label: "Codex paused until --apply", approvedAt: null });
    expect(paused.body.accounts.map((a: any) => a.accountSlot)).toEqual(["claude:max", "codex:openai-2"]);
    const ok = (await codingRoute({ method: "GET", path: "/coding/accounts", url: new URL("http://x/coding/accounts"), body: {}, principal: OWNER }, { ...rt, codexIsolationApproval: () => ({ version: 1, group: "CodexSandboxUsers", approvedAt: "2026-09-28T10:00:00.000Z", paths: ["C:/synthetic/a"] }) })) as { body: any };
    expect(ok.body.codexIsolation).toMatchObject({ state: "protected", protectedPaths: 1 });
    // Paths themselves never leave the server: only the count.
    expect(JSON.stringify(ok.body)).not.toContain("C:/synthetic/a");
  }, 120_000);
});

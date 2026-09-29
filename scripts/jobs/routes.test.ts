import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Principal } from "../approvals/principal";
import { pageTokenFor } from "../identity/principal";
import { ApprovalService } from "../approvals/service";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { jobsApprovalsMiddleware } from "./plugin";
import { jobsApprovalsRoute } from "./routes";
import { JobService } from "./service";

const usman: Principal = { personId: "usman", via: "loopback-owner" };
const usmanUi: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
let dir: string;
let jobs: JobService;
let approvals: ApprovalService;
let ledger: SpokenConfirmationLedger;
const deps = () => ({ jobs: () => jobs, approvals: () => approvals });
const call = (method: string, path: string, body?: unknown, principal: Principal | null = usman) =>
  jobsApprovalsRoute({ method, path: path.split("?")[0], url: new URL(path, "http://localhost"), body, principal }, deps());

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-routes-"));
  ledger = new SpokenConfirmationLedger();
  jobs = new JobService({ path: join(dir, "jobs.sqlite"), kill: async () => true });
  approvals = new ApprovalService({ path: join(dir, "approvals.sqlite"), spoken: ledger, code: () => "AB3D" });
});
afterEach(() => {
  jobs.close();
  approvals.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* WAL */
  }
});

describe("routes", () => {
  test("every route needs a Principal (401), unrelated paths fall through", async () => {
    expect(await call("GET", "/__jobs", undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", "/__approvals", undefined, null)).toMatchObject({ status: 401 });
    expect(await call("GET", "/__memory/facts")).toBeNull();
  });

  test("list, get, events and cancel", async () => {
    const job = jobs.create({ kind: "voice", principal: usman, targetDeviceId: "usman-pc", title: "Read my calendar" });
    const list = await call("GET", "/__jobs?kind=voice");
    expect((list!.body as { jobs: unknown[] }).jobs.length).toBe(1);
    expect(await call("GET", "/__jobs?kind=bogus")).toMatchObject({ status: 400 });
    expect(await call("GET", `/__jobs/${job.id}`)).toMatchObject({ status: 200, body: { job: { id: job.id } } });
    expect(await call("GET", "/__jobs/events?tail=1")).toMatchObject({ status: 200, body: { events: [] } });
    const ev = await call("GET", "/__jobs/events?after=0");
    expect((ev!.body as { events: unknown[] }).events.length).toBeGreaterThan(0);
    expect(await call("POST", `/__jobs/${job.id}/cancel`, { force: true })).toMatchObject({ status: 400 });
    expect(await call("POST", `/__jobs/${job.id}/cancel`, {})).toMatchObject({ status: 202, body: { result: { state: "cancelled" } } });
    expect(await call("POST", `/__jobs/${job.id}/cancel`, {})).toMatchObject({ status: 409 });
    expect(await call("POST", `/__jobs/00000000-0000-4000-8000-000000000000/cancel`, {})).toMatchObject({ status: 404 });
  });

  test("there is no route that creates an approval; decide uses the resolved Principal, never a body field", async () => {
    expect(await call("POST", "/__approvals", { action: "deploy" })).toMatchObject({ status: 405 });
    // Requested by the human in the UI, so the card may confirm it (a process's request couldn't be).
    const r = approvals.request({ action: "deploy", args: { site: "x" }, requester: usmanUi, summary: "Deploy x", origin: "principal" });
    if (!r.ok) throw new Error();
    const id = r.approval.id;
    expect(await call("POST", `/__approvals/${id}/decide`, { decision: "approve" })).toMatchObject({ status: 400 });
    expect(await call("POST", `/__approvals/${id}/decide`, { decision: "approve", evidence: { uiConfirm: "yes" } })).toMatchObject({ status: 400 });
    // A body claiming an approver is ignored; the Principal here is Telegram (not a UI session).
    const tg = await jobsApprovalsRoute(
      { method: "POST", path: `/__approvals/${id}/decide`, url: new URL("http://x"), body: { decision: "approve", evidence: { uiConfirm: true, cardNonce: "x" }, approver: usmanUi }, principal: { personId: "usman", via: "telegram-owner" } },
      deps(),
    );
    expect(tg).toMatchObject({ status: 409 });
    const card = await call("POST", `/__approvals/${id}/card`, {}, usmanUi);
    expect(card!.status).toBe(200);
    const cardNonce = (card!.body as { cardNonce: string }).cardNonce;
    expect(await call("POST", `/__approvals/${id}/decide`, { decision: "approve", evidence: { uiConfirm: true, cardNonce } }, usmanUi)).toMatchObject({ status: 200, body: { approval: { state: "approved" } } });
    expect(await call("GET", `/__approvals?state=approved`)).toMatchObject({ status: 200 });
  });

  test("review H1: a local process with only the page token can't UI-confirm (no card, no session) and can't ask a question", async () => {
    const r = approvals.request({ action: "coding.merge", args: { repoId: "x", fromSha: "a".repeat(40) }, requester: usman, summary: "Merge", origin: "principal" });
    if (!r.ok) throw new Error();
    const id = r.approval.id;
    // `usman` here is what the interim resolver gives any loopback process: no session id.
    expect(await call("POST", `/__approvals/${id}/card`, {})).toMatchObject({ status: 403 });
    expect(await call("POST", `/__approvals/${id}/decide`, { decision: "approve", evidence: { uiConfirm: true, cardNonce: "00000000-0000-4000-8000-000000000000" } })).toMatchObject({ status: 409 });
    // A nonce issued to one session doesn't work from another.
    const card = await call("POST", `/__approvals/${id}/card`, {}, usmanUi);
    const cardNonce = (card!.body as { cardNonce: string }).cardNonce;
    const other: Principal = { personId: "usman", via: "loopback-owner", sessionId: "sess-other-0001" };
    expect(await call("POST", `/__approvals/${id}/decide`, { decision: "approve", evidence: { uiConfirm: true, cardNonce } }, other)).toMatchObject({ status: 409 });
    expect(approvals.get(id)!.state).toBe("pending");
    // The spoken question is the server's own TTS path: there's no HTTP route for it.
    expect(await call("POST", `/__approvals/${id}/question`, {})).toMatchObject({ status: 404 });
  });

  test("the spoken path: the server asks, then the STT event id stamped with that question", async () => {
    const r = approvals.request({ action: "memory.forget", args: { target: "m1" }, requester: usman, summary: "Forget m1", origin: "principal" });
    if (!r.ok) throw new Error();
    const q = approvals.ask(r.approval.id, usman);
    await Bun.sleep(2);
    const yes = ledger.record("yes")!;
    const d = await call("POST", `/__approvals/${r.approval.id}/decide`, { decision: "approve", evidence: { spokenYes: yes.id, questionId: q.questionId } });
    expect(d).toMatchObject({ status: 200 });
  });

  test("review B2: an away code over HTTP counts from the owner's Telegram channel, never from a bare local process", async () => {
    const r = approvals.request({ action: "away.run", args: { task: "delete D:/tmp/old.txt" }, requester: usman, summary: "Delete old.txt", origin: "principal" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const local = await call("POST", `/__approvals/${r.approval.id}/decide`, { decision: "approve", evidence: { awayCode: "AB3D" } });
    expect(local).toMatchObject({ status: 409, body: { code: "wrong-channel" } });
    const res = await jobsApprovalsRoute(
      { method: "POST", path: `/__approvals/${r.approval.id}/decide`, url: new URL("http://x"), body: { decision: "approve", evidence: { awayCode: "AB3D" } }, principal: { personId: "usman", via: "telegram-owner" } },
      deps(),
    );
    expect(res).toMatchObject({ status: 200 });
  });
});

// --- the transport ---------------------------------------------------------------------------------
function fakeReq(input: { method?: string; url: string; headers?: Record<string, string>; body?: string; remote?: string }) {
  const req = Readable.from(input.body ? [Buffer.from(input.body)] : []) as unknown as IncomingMessage;
  Object.assign(req, { method: input.method ?? "GET", url: input.url, headers: { host: "localhost:8081", ...(input.headers ?? {}) }, socket: { remoteAddress: input.remote ?? "127.0.0.1" } });
  return req;
}
function fakeRes() {
  const out: { status: number; body: unknown } = { status: 0, body: null };
  const res = { statusCode: 0, setHeader() {}, end(text: string) { out.status = res.statusCode; out.body = JSON.parse(text); } } as unknown as ServerResponse & { statusCode: number };
  return { res, out };
}

describe("middleware", () => {
  const mw = () => jobsApprovalsMiddleware({ root: dir, token: "tok", deps: deps() });
  const run = async (req: IncomingMessage) => {
    const { res, out } = fakeRes();
    let passed = false;
    await mw()(req, res, () => (passed = true));
    return { ...out, passed };
  };

  test("loopback owner reads; relayed, remote and rebinding requests get 401", async () => {
    expect((await run(fakeReq({ url: "/__jobs" }))).status).toBe(200);
    expect((await run(fakeReq({ url: "/__jobs", headers: { "x-forwarded-for": "100.64.0.2" } }))).status).toBe(401);
    expect((await run(fakeReq({ url: "/__jobs", headers: { "tailscale-user-login": "x@y" } }))).status).toBe(401);
    expect((await run(fakeReq({ url: "/__jobs", remote: "100.64.0.9" }))).status).toBe(401);
    expect((await run(fakeReq({ url: "/__jobs", headers: { host: "evil.example:8081" } }))).status).toBe(401);
  });

  test("POST needs the page token and JSON; cross-site and foreign origins are blocked", async () => {
    const job = jobs.create({ kind: "voice", principal: usman, targetDeviceId: "usman-pc", title: "x" });
    const url = `/__jobs/${job.id}/cancel`;
    expect((await run(fakeReq({ method: "POST", url, body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(403);
    expect((await run(fakeReq({ method: "POST", url, body: "{}", headers: { "x-claude-os-token": "tok" } }))).status).toBe(415);
    expect((await run(fakeReq({ url: "/__jobs", headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await run(fakeReq({ url: "/__jobs", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await run(fakeReq({ method: "POST", url, body: "{}", headers: { "x-claude-os-token": "tok", "content-type": "application/json" } }))).status).toBe(202);
  });

  test("other paths pass through untouched", async () => {
    expect((await run(fakeReq({ url: "/__memory/facts" }))).passed).toBe(true);
  });

  test("a remote founder writes with HIS OWN page token (B1), never the internal one", async () => {
    const job = jobs.create({ kind: "voice", principal: usman, targetDeviceId: "usman-pc", title: "x" });
    const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", sessionId: "sess-mehroz-0001", displayName: "Mehroz" };
    const mwAs = (p: Principal | null) => jobsApprovalsMiddleware({ root: dir, token: () => "tok", resolvePrincipal: () => p, deps: deps() });
    const post = async (p: Principal | null, token: string) => {
      const { res, out } = fakeRes();
      await mwAs(p)(fakeReq({ method: "POST", url: `/__jobs/${job.id}/cancel`, body: "{}", headers: { "x-claude-os-token": token, "content-type": "application/json" } }), res, () => {});
      return out.status;
    };
    expect(await post(mehroz, "tok")).toBe(403); // the internal token isn't his
    expect(await post(mehroz, pageTokenFor(mehroz, "tok"))).toBe(202);
    expect(await post(null, "tok")).toBe(401);
  });

  // Reconciled from codex/b2-security-review (fb80b96): B1's sessionId is the server-only key of a live
  // session cookie (DeviceStore.sessionKey). The stores keep it inside requester/approver/job principals
  // for card binding and audit, but it must never leave over HTTP, even to the other signed-in founder.
  test("server-only session keys never leave any jobs or approvals HTTP response", async () => {
    const mehroz: Principal = { personId: "mehroz", via: "paired-session", actor: "human", sessionId: "sess-mehroz-0001" };
    let current: Principal = usmanUi;
    const middleware = jobsApprovalsMiddleware({ root: dir, token: () => "tok", resolvePrincipal: () => current, deps: deps() });
    const request = async (method: string, url: string, body?: unknown) => {
      const { res, out } = fakeRes();
      const token = pageTokenFor(current, "tok");
      await middleware(
        fakeReq({ method, url, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: method === "GET" ? {} : { "content-type": "application/json", "x-claude-os-token": token } }),
        res,
        () => {},
      );
      return out;
    };
    const job = jobs.create({ kind: "voice", principal: usmanUi, targetDeviceId: "usman-pc", title: "Synthetic task" });
    const asked = approvals.request({ action: "deploy", args: { site: "example" }, requester: usmanUi, summary: "Synthetic approval", origin: "principal" });
    const other = approvals.request({ action: "deploy", args: { site: "other" }, requester: usmanUi, summary: "Synthetic approval 2", origin: "principal" });
    if (!asked.ok || !other.ok) throw new Error("approval was refused");
    // Usman confirms one on his card, so the approver (with his session key) is stored too.
    const card = await request("POST", `/__approvals/${asked.approval.id}/card`, {});
    expect(card.status).toBe(200);
    const decided = await request("POST", `/__approvals/${asked.approval.id}/decide`, { decision: "approve", evidence: { uiConfirm: true, cardNonce: (card.body as { cardNonce: string }).cardNonce } });
    const cancelled = await request("POST", `/__approvals/${other.approval.id}/cancel`, {});
    expect(decided.status).toBe(200);
    expect(cancelled.status).toBe(200);
    // S1 (AUDIT-A1-1) goes further than the recon fix: the card nonce binds to the live session in memory,
    // so the stores never keep the session key at all; the HTTP view drops it for rows stored before that.
    expect(approvals.get(asked.approval.id)!.approver?.sessionId).toBeUndefined();
    const seen = [decided, cancelled];
    for (const who of [usmanUi, mehroz]) {
      current = who;
      for (const url of ["/__jobs", `/__jobs/${job.id}`, "/__jobs/events", "/__approvals", "/__approvals?state=approved", `/__approvals/${asked.approval.id}`, `/__approvals/${other.approval.id}`]) {
        const out = await request("GET", url);
        expect(out.status).toBe(200);
        seen.push(out);
      }
    }
    // The views still say who asked and who decided, just not the session key.
    expect(seen.at(-2)!.body).toMatchObject({ approval: { requester: { personId: "usman", actor: "human" }, approver: { personId: "usman" } } });
    for (const out of seen) {
      expect(JSON.stringify(out.body)).not.toContain("sessionId");
      expect(JSON.stringify(out.body)).not.toContain(usmanUi.sessionId!);
      expect(JSON.stringify(out.body)).not.toContain(mehroz.sessionId!);
    }
  });

  // Reconciled from codex/b2-security-review (3a32acd/b1abbdd): the service-level rule (review-b2) held
  // at the HTTP boundary: a B1 process actor gets no card even when it carries a session-shaped key.
  test("over HTTP, a process actor with a session-shaped key gets no approval card; the human session does", async () => {
    const pending = approvals.request({ action: "deploy", args: { site: "example" }, requester: usmanUi, summary: "Synthetic approval", origin: "principal" });
    if (!pending.ok) throw new Error("approval was refused");
    const process: Principal = { personId: "mehroz", via: "paired-session", actor: "process", sessionId: "forged-session-key" };
    const noActor: Principal = { personId: "mehroz", via: "paired-session", sessionId: "forged-session-key" };
    const human: Principal = { personId: "mehroz", via: "paired-session", actor: "human", sessionId: "sess-mehroz-0001" };
    const cardAs = async (p: Principal) => {
      const { res, out } = fakeRes();
      await jobsApprovalsMiddleware({ root: dir, token: () => "tok", resolvePrincipal: () => p, deps: deps() })(
        fakeReq({ method: "POST", url: `/__approvals/${pending.approval.id}/card`, body: "{}", headers: { "content-type": "application/json", "x-claude-os-token": pageTokenFor(p, "tok") } }),
        res,
        () => {},
      );
      return out.status;
    };
    expect(await cardAs(process)).toBe(403);
    expect(await cardAs(noActor)).toBe(403); // a missing actor is a process (fail closed)
    expect(await cardAs(human)).toBe(200);
  });
});

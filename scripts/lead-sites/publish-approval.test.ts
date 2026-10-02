import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals/service";
import { actionPolicy, allowedEvidence } from "../approvals/policy";
import type { Principal } from "../approvals/principal";
import { DeviceStore } from "../devices/store";
import { createPrincipalGate, under } from "../identity/gate";
import { createLocalOwnerProof } from "../identity/local-owner-token";
import { pageTokenFor } from "../identity/principal";
import { syntheticTailnetForTests } from "../remote-access";
import { leadSitesPlugin } from "./plugin";
import { folderDigest, publishArgs, publishResource } from "./publish-approval";
import type { PreviewRecord } from "./registry";

/**
 * Remote publish and take-down of a lead preview in the server role go through the B2 approval service: ask, decide per
 * B2's rules, run once. Synthetic everything: a temp data dir, fake deploy/takedown (Vercel is never touched), Tailscale
 * Serve simulated over loopback, a temp approvals store.
 */

// Process-wide state this file depends on, pinned for its own duration and restored after (bun runs many test files in ONE process:
// an ambient MU_DATA_DIR from the shell or another file would send the registry, people and approvals stores somewhere else).
const savedEnv = { bg: process.env.AGENTIC_OS_NO_BACKGROUND, data: process.env.MU_DATA_DIR, role: process.env.MU_HUB_ROLE };
process.env.AGENTIC_OS_NO_BACKGROUND = "1";
delete process.env.MU_HUB_ROLE;
const TAILNET = "hub.tail-test.ts.net";
const LOGIN = { usman: "owner@example.test", mehroz: "partner@example.test" };
const INTERNAL = "publish-internal-token";
const DOMAIN = "harbour-realty.muventures.com.au";

const base = mkdtempSync(join(tmpdir(), "mu-publish-"));
const root = join(base, "os");
const dataDir = join(root, ".operator-data");
const previewDir = join(base, "drafts", "harbour-realty", "flagship-preview");
mkdirSync(previewDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
process.env.MU_DATA_DIR = dataDir;
writeFileSync(join(previewDir, "index.html"), "<h1>Harbour Realty</h1>");
writeFileSync(join(dataDir, "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGIN.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGIN.mehroz] }] }));

const record = (over: Partial<PreviewRecord> = {}): PreviewRecord => ({
  leadId: 7, business: "Harbour Realty", vertical: "real-estate", slug: "harbour-realty", domain: DOMAIN, url: `https://${DOMAIN}`, project: "mu-harbour-realty",
  dir: previewDir, status: "generated", generatedAt: "2026-10-02T00:00:00.000Z", generatedBy: "usman", deployedAt: null, deployedBy: null, expiresAt: null,
  takenDownAt: null, takenDownBy: null, verified: null, lastError: null, serviceCount: 3, missing: [], ...over,
});
const setRegistry = (r: PreviewRecord) => writeFileSync(join(dataDir, "lead-sites.json"), JSON.stringify({ version: 1, previews: [r] }));

const store = new DeviceStore(root);
const tailnet = syntheticTailnetForTests(TAILNET, ["100.64.0.1"]);
const proof = createLocalOwnerProof(root, { MU_LOCAL_OWNER_TOKEN_FILE: join(base, "owner.token") });
let storeN = 0;
let approvals = new ApprovalService({ path: join(base, "approvals-0.sqlite") });
const minted = { mehroz: store.mintSession("mehroz", "Mehroz's laptop", "code"), usman: store.mintSession("usman", "Usman's laptop", "code") };
const cookies = { mehroz: minted.mehroz.cookie, usman: minted.usman.cookie };
/** The real session key the identity layer gives that browser's principal (what a request is bound to). */
const keyOf = (who: "usman" | "mehroz") => store.sessionKey(minted[who].session.id);

const calls: Array<{ what: string; by: string; confirm?: string }> = [];
const sent: Array<{ to: string; text: string }> = [];
const fakeDeploy = async (_db: unknown, leadId: number, o: { by: string; confirm: string }) => {
  calls.push({ what: "deploy", by: o.by, confirm: o.confirm });
  return record({ leadId, status: "live", deployedAt: "2026-10-02T01:00:00.000Z", deployedBy: o.by, expiresAt: "2026-11-01T00:00:00.000Z" });
};
const fakeTakedown = async (_db: unknown, leadId: number, o: { by: string }) => {
  calls.push({ what: "takedown", by: o.by });
  return record({ leadId, status: "taken_down", takenDownAt: "2026-10-02T02:00:00.000Z", takenDownBy: o.by });
};

const mounts: Array<{ path: string; fn: (req: IncomingMessage, res: ServerResponse) => unknown }> = [];
leadSitesPlugin({
  root, token: INTERNAL, draftsRoot: join(base, "drafts"), role: "server",
  deps: { approvals: () => approvals, notify: async (to, text) => (sent.push({ to, text }), { ok: true, detail: "sent" }), deploy: fakeDeploy as never, takedown: fakeTakedown as never },
}).configureServer!({ middlewares: { use: (p: string, fn: never) => mounts.push({ path: p, fn }) } } as never);
const leadSites = mounts.find((m) => m.path === "/__lead-sites")!.fn;

const gate = createPrincipalGate({ root, internalToken: () => INTERNAL, store, tailnetName: TAILNET, servePeer: () => true, tailnet, role: "server", localOwnerProof: proof });
let server: Server;
let origin = "";
const ownerToken = () => INTERNAL;
const founderHeaders = (who: "usman" | "mehroz", cookie = cookies[who]) => ({
  host: `${TAILNET}:8443`, "tailscale-user-login": LOGIN[who], "x-forwarded-for": who === "usman" ? "100.64.0.11" : "100.64.0.12", "x-forwarded-proto": "https",
  cookie: `mu_session=${encodeURIComponent(cookie)}`, "x-claude-os-token": pageTokenFor({ personId: who, via: "paired-session" }, INTERNAL),
});
const ownerHeaders = () => ({ "x-mu-local-owner": proof.path && require("node:fs").readFileSync(proof.path, "utf8").trim(), "x-claude-os-token": ownerToken() });

async function post(who: "usman" | "mehroz" | "owner", path: string, body: unknown, cookie?: string) {
  const headers = { ...(who === "owner" ? ownerHeaders() : founderHeaders(who, cookie)), "content-type": "application/json" } as Record<string, string>;
  const res = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

beforeEach(() => {
  // A fresh approvals store per test: a repeat of the same exact request would otherwise reuse the previous test's record.
  approvals.close();
  approvals = new ApprovalService({ path: join(base, `approvals-${++storeN}.sqlite`) });
  calls.length = 0;
  sent.length = 0;
  setRegistry(record());
  writeFileSync(join(previewDir, "index.html"), "<h1>Harbour Realty</h1>");
});
afterAll(async () => {
  for (const [k, v] of [["AGENTIC_OS_NO_BACKGROUND", savedEnv.bg], ["MU_DATA_DIR", savedEnv.data], ["MU_HUB_ROLE", savedEnv.role]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  approvals.close();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* sqlite handle on Windows */
  }
});
await new Promise<void>((resolve) => {
  server = createServer((req, res) =>
    gate(req, res, () => {
      const original = req.url ?? "/";
      if (!under(original.split("?")[0], "/__lead-sites")) return void res.end("{}");
      req.url = original.slice("/__lead-sites".length) || "/";
      return void leadSites(req, res);
    }),
  );
  server.listen(0, "127.0.0.1", () => {
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    resolve();
  });
});

/** A verified interactive session, as B1's resolver gives it (what the approval card needs). */
const human = (personId: "usman" | "mehroz", n = 1): Principal => ({ personId, via: "paired-session", actor: "human", sessionId: `sk1.session-${personId}-${n}-abcdef` });
function approve(id: string, approver: Principal) {
  const card = approvals.card(id, approver);
  expect(card).not.toBeNull();
  const r = approvals.decide(id, approver, "approve", { uiConfirm: true, cardNonce: card!.cardNonce });
  expect(r.ok).toBe(true);
}

describe("deploy through B2", () => {
  test("a founder's request asks, publishes nothing, and carries no code", async () => {
    const r = await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ needsApproval: true, approval: { action: "content.publish", state: "pending", requester: { personId: "mehroz", actor: "human" } } });
    expect(r.json.approval.summary).toContain(DOMAIN);
    expect(r.json.approval.scope.resource).toMatch(/^lead-sites:deploy:7:human:[a-f0-9]{16}$/);
    expect(JSON.stringify(r.json)).not.toMatch(/[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}/);
    expect(calls).toEqual([]);
    // Asked once: the same exact request gets the same live approval.
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id).toBe(r.json.approval.id);
  });

  test("running before it is approved does nothing; after approval it runs exactly once, as the requester, and the outcome is recorded", async () => {
    const asked = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    const early = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked });
    expect(early.status).toBe(409);
    expect(calls).toEqual([]);
    approve(asked, human("mehroz"));
    const run = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked });
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ outcome: "succeeded", preview: { status: "live" } });
    expect(calls).toEqual([{ what: "deploy", by: "mehroz", confirm: DOMAIN }]);
    expect(approvals.get(asked)).toMatchObject({ state: "consumed", outcome: "succeeded" });
    // No replay: a second call, and a retry after a "restart" of the service, are refused.
    const again = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked });
    expect(again.status).toBe(409);
    expect(again.json.code ?? again.json.error).toBeTruthy();
    expect(calls.length).toBe(1);
  });

  test("the OTHER founder can approve it (B2: a verified session that is not a program); the approver never runs it for the requester", async () => {
    const asked = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    approve(asked, human("usman"));
    expect(approvals.get(asked)).toMatchObject({ state: "approved", approver: { personId: "usman" } });
    // Usman is not the requester, so he cannot run Mehroz's approval (the owner at the console included).
    expect((await post("usman", "/__lead-sites/deploy", { lead: 7, approvalId: asked })).status).toBe(403);
    expect((await post("owner", "/__lead-sites/deploy", { lead: 7, approvalId: asked, by: "usman" })).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked })).status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("a rejected, expired or unknown approval never runs; a wrong lead or action is not found", async () => {
    const asked = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    expect(approvals.decide(asked, human("usman"), "reject").ok).toBe(true);
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked })).status).toBe(409);
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: "not-an-id" })).status).toBe(400);
    // A deploy approval cannot be used to take down.
    const other = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    approve(other, human("usman"));
    expect((await post("mehroz", "/__lead-sites/takedown", { lead: 7, approvalId: other })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("the preview changing after approval voids it at the moment it would run", async () => {
    const asked = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    approve(asked, human("usman"));
    writeFileSync(join(previewDir, "index.html"), "<h1>Harbour Realty (regenerated)</h1>");
    const run = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: asked });
    expect(run.status).toBe(409);
    expect(run.json.code).toBe("digest-mismatch");
    expect(calls).toEqual([]);
    expect(approvals.get(asked)?.state).toBe("cancelled");
  });

  test("the typed domain must match, and there must be a preview", async () => {
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: "wrong.example" })).status).toBe(400);
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 99, confirm: DOMAIN })).status).toBe(404);
    expect((await post("mehroz", "/__lead-sites/deploy", { confirm: DOMAIN })).status).toBe(400);
    expect(approvals.list({ state: "pending" }).filter((a) => String(a.scope.resource).startsWith("lead-sites:deploy:99:"))).toEqual([]);
  });

  test("a failed deploy records a failed outcome and the approval stays spent", async () => {
    mounts.length = 0;
    const failing = (await import("./plugin")).leadSitesPlugin({
      root, token: INTERNAL, draftsRoot: join(base, "drafts"), role: "server",
      deps: { approvals: () => approvals, notify: async () => ({ ok: true, detail: "" }), deploy: (async () => { throw new Error("Vercel said no"); }) as never },
    });
    failing.configureServer!({ middlewares: { use: (p: string, fn: never) => mounts.push({ path: p, fn }) } } as never);
    const fn = mounts.find((m) => m.path === "/__lead-sites")!.fn;
    const requester = { ...human("mehroz"), sessionId: keyOf("mehroz") };
    const asked = approvals.request({ action: "content.publish", args: publishArgs("deploy", record()), requester, summary: "x", origin: "principal", scope: { resource: publishResource("deploy", 7, requester) } });
    expect(asked.ok).toBe(true);
    const id = (asked as { approval: { id: string } }).approval.id;
    approve(id, human("usman"));
    // Run it through a second server using the failing deps.
    const s2 = createServer((req, res) => gate(req, res, () => { req.url = (req.url ?? "/").slice("/__lead-sites".length) || "/"; void fn(req, res); }));
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/__lead-sites/deploy`, { method: "POST", headers: { ...founderHeaders("mehroz"), "content-type": "application/json" }, body: JSON.stringify({ lead: 7, approvalId: id }) });
      expect(res.status).toBe(400);
      expect((await res.json()) as { outcome: string }).toMatchObject({ outcome: "failed" });
      expect(approvals.get(id)).toMatchObject({ state: "consumed", outcome: "failed" });
    } finally {
      s2.closeAllConnections?.();
      s2.close();
    }
  });
});

describe("S4: the approval is bound to the whole preview folder and to the asking browser session", () => {
  const ask = async () => (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
  const voided = async (change: () => void) => {
    const id = await ask();
    approve(id, human("usman"));
    change();
    const run = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: id });
    expect([run.status, run.json.code]).toEqual([409, "digest-mismatch"]);
    expect(calls).toEqual([]);
    expect(approvals.get(id)?.state).toBe("cancelled");
  };
  test("a change to ANY file in the folder voids it: another page, an asset, a new file, a dotfile, a removal, a rename, a nested file", async () => {
    mkdirSync(join(previewDir, "_next", "static"), { recursive: true });
    const baseline = () => {
      for (const f of ["extra.js", ".hidden", "style2.css", "_next/static/new.js"]) rmSync(join(previewDir, f), { force: true });
      writeFileSync(join(previewDir, "style.css"), "body{}");
      writeFileSync(join(previewDir, "_next", "static", "app.js"), "1");
      writeFileSync(join(previewDir, "about.html"), "<h1>about</h1>");
    };
    const changes: Array<() => void> = [
      () => writeFileSync(join(previewDir, "style.css"), "body{color:red}"), // an asset
      () => writeFileSync(join(previewDir, "about.html"), "<h1>about us</h1>"), // another page (not index.html)
      () => writeFileSync(join(previewDir, "extra.js"), "fetch('//evil')"), // a new file
      () => writeFileSync(join(previewDir, ".hidden"), "x"), // a dotfile
      () => rmSync(join(previewDir, "style.css")), // a removal
      () => renameSync(join(previewDir, "style.css"), join(previewDir, "style2.css")), // a rename, same bytes
      () => writeFileSync(join(previewDir, "_next", "static", "app.js"), "2"), // nested, same size
      () => writeFileSync(join(previewDir, "_next", "static", "new.js"), "n"), // nested new
    ];
    for (const change of changes) {
      baseline();
      await voided(change);
      approvals.close();
      approvals = new ApprovalService({ path: join(base, `approvals-s4-${++storeN}.sqlite`) });
      calls.length = 0;
    }
    baseline();
  });
  test("an unchanged folder digests the same every time, and the digest moves with content, path and size", () => {
    const d1 = folderDigest(previewDir);
    expect(folderDigest(previewDir)).toBe(d1);
    writeFileSync(join(previewDir, "z.txt"), "a");
    const d2 = folderDigest(previewDir);
    expect(d2).not.toBe(d1);
    writeFileSync(join(previewDir, "z.txt"), "b"); // same size, other content
    expect(folderDigest(previewDir)).not.toBe(d2);
    rmSync(join(previewDir, "z.txt"));
    expect(folderDigest(previewDir)).toBe(d1);
  });
  test("a request made in one browser session cannot be run from another session of the same person", async () => {
    const id = await ask();
    approve(id, human("usman"));
    const second = store.mintSession("mehroz", "Mehroz's phone", "code");
    const r = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: id }, second.cookie);
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/session that asked/);
    expect(calls).toEqual([]);
    expect(approvals.get(id)?.state).toBe("approved"); // not voided by the attempt
    expect((await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: id })).status).toBe(200);
    expect(calls.length).toBe(1);
  });
  test("a program holding the owner token cannot complete a deploy a browser asked for, and a program's request cannot be run from a browser", async () => {
    const id = await ask();
    approve(id, human("usman"));
    for (const who of ["owner", "usman"] as const) expect((await post(who, "/__lead-sites/deploy", { lead: 7, approvalId: id, by: "mehroz" })).status).toBe(403);
    expect(calls).toEqual([]);
    expect(approvals.get(id)?.state).toBe("approved");
    const asked = await post("owner", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN, by: "usman" });
    expect(asked.json.approval.scope.resource).toMatch(/:process$/);
    const pid = asked.json.approval.id as string;
    const code = /approve ([2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4})/.exec(sent[sent.length - 1].text)![1];
    approvals.decide(pid, { personId: "usman", via: "telegram-owner", actor: "human" }, "approve", { telegramCode: code });
    expect((await post("usman", "/__lead-sites/deploy", { lead: 7, approvalId: pid })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("take-down through B2", () => {
  test("only a live preview can be taken down; approve, then run once", async () => {
    expect((await post("mehroz", "/__lead-sites/takedown", { lead: 7 })).status).toBe(409); // not live: nothing to take down
    setRegistry(record({ status: "live", deployedAt: "2026-10-02T01:00:00.000Z", deployedBy: "usman" }));
    const asked = await post("mehroz", "/__lead-sites/takedown", { lead: 7 });
    expect(asked.status).toBe(202);
    expect(asked.json.approval).toMatchObject({ action: "content.unpublish", state: "pending" });
    expect(asked.json.approval.summary).toContain("will stop working");
    const id = asked.json.approval.id as string;
    approve(id, human("usman"));
    const run = await post("mehroz", "/__lead-sites/takedown", { lead: 7, approvalId: id });
    expect(run.status).toBe(200);
    expect(calls).toEqual([{ what: "takedown", by: "mehroz" }]);
    expect((await post("mehroz", "/__lead-sites/takedown", { lead: 7, approvalId: id })).status).toBe(409);
    expect(calls.length).toBe(1);
  });
});

describe("a program's request (the owner's console, with the local-owner proof) follows B2's process rules", () => {
  test("it asks, the code goes to the requester's own Telegram DM and never into the response, and a click cannot answer it", async () => {
    const asked = await post("owner", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN, by: "usman" });
    expect(asked.status).toBe(202);
    expect(asked.json).toMatchObject({ needsApproval: true, codeSent: true, approval: { requester: { personId: "usman", actor: "process" } } });
    expect(calls).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("usman");
    const code = /approve ([2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4})/.exec(sent[0].text)?.[1];
    expect(code).toBeTruthy();
    expect(JSON.stringify(asked.json)).not.toContain(code!);
    const id = asked.json.approval.id as string;
    // A UI confirm cannot answer a program's request (policy.allowedEvidence).
    const card = approvals.card(id, human("usman"));
    const click = approvals.decide(id, human("usman"), "approve", { uiConfirm: true, cardNonce: card?.cardNonce ?? "x" });
    expect(click.ok).toBe(false);
    // Running it unapproved does nothing.
    expect((await post("owner", "/__lead-sites/deploy", { lead: 7, approvalId: id, by: "usman" })).status).toBe(409);
    expect(calls).toEqual([]);
    // The owner's Telegram DM with the code approves it; then it runs once.
    const telegram: Principal = { personId: "usman", via: "telegram-owner", actor: "human" };
    expect(approvals.decide(id, telegram, "approve", { telegramCode: code! }).ok).toBe(true);
    expect((await post("owner", "/__lead-sites/deploy", { lead: 7, approvalId: id, by: "usman" })).status).toBe(200);
    expect(calls).toEqual([{ what: "deploy", by: "usman", confirm: DOMAIN }]);
  });

  test("the owner at the console cannot publish directly in the server role: there is no direct path", async () => {
    const direct = await post("owner", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN, by: "usman" });
    expect(direct.status).toBe(202);
    expect(calls).toEqual([]);
  });
});

describe("B2 itself: no replay across a restart, and the new action is registered like content.publish", () => {
  test("content.unpublish has the evidence and lifetime of content.publish", () => {
    expect(actionPolicy("content.unpublish")).toEqual(actionPolicy("content.publish"));
    expect(allowedEvidence("content.unpublish", true)).toEqual(allowedEvidence("content.publish", true));
  });

  test("approved-but-unconsumed survives a restart and is usable; consumed is never replayed; a consumed action with no outcome becomes unknown", async () => {
    const path = join(base, "restart.sqlite");
    let svc = new ApprovalService({ path });
    const mk = (n: number) => svc.request({ action: "content.publish", args: { mode: "deploy", leadId: n, siteRef: `r${n}` }, requester: human("mehroz"), summary: "x", origin: "principal", scope: { resource: `lead-sites:deploy:${n}` } }) as { ok: true; approval: { id: string } };
    const a = mk(1).approval.id;
    const b = mk(2).approval.id;
    const decide = (id: string) => {
      const card = svc.card(id, human("usman"))!;
      expect(svc.decide(id, human("usman"), "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(true);
    };
    decide(a);
    decide(b);
    const digest = (n: number) => (svc as unknown as { get(id: string): { argsDigest: string } }).get(n === 1 ? a : b)!.argsDigest;
    expect(svc.consume(b, digest(2)).ok).toBe(true); // b is consumed, the process "crashes" before recording an outcome
    svc.close();
    svc = new ApprovalService({ path });
    const recovered = svc.recover();
    expect(recovered.unknownOutcomes).toBe(1);
    expect(svc.get(b)).toMatchObject({ state: "consumed", outcome: "unknown" });
    expect(svc.consume(b, digest(2))).toMatchObject({ ok: false, code: "consumed" }); // never replayed
    expect(svc.get(a)?.state).toBe("approved"); // still usable once
    expect(svc.consume(a, digest(1)).ok).toBe(true);
    expect(svc.consume(a, digest(1)).ok).toBe(false);
    svc.close();
  });
});

describe("final review 4: an unbindable folder is refused, never approved against a constant", () => {
  test("asking to publish a preview whose folder can't be checked as one piece is refused with a clear line, and nothing is recorded", async () => {
    setRegistry(record({ dir: join(base, "does-not-exist") }));
    const r = await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("unbindable");
    expect(r.json.error).toMatch(/can't be approved for publishing/);
    expect(approvals.list({ state: "pending" })).toEqual([]);
    expect(() => publishArgs("deploy", record({ dir: join(base, "does-not-exist") }))).toThrow(/can't be approved for publishing/);
  });
  test("an approval made while bindable cannot be run once the folder became unreadable: refused 409, not consumed", async () => {
    const id = (await post("mehroz", "/__lead-sites/deploy", { lead: 7, confirm: DOMAIN })).json.approval.id as string;
    approve(id, human("usman"));
    setRegistry(record({ dir: join(base, "vanished") }));
    const run = await post("mehroz", "/__lead-sites/deploy", { lead: 7, approvalId: id });
    expect([run.status, run.json.code]).toEqual([409, "unbindable"]);
    expect(calls).toEqual([]);
    expect(approvals.get(id)?.state).toBe("approved");
  });
  test("the generic gate: an args function that throws Unbindable is a 409 on both steps; another error is not swallowed", async () => {
    const { askGated, runGated, Unbindable } = await import("../approvals/gated-action");
    const asked = await askGated(approvals, async () => ({ ok: true, detail: "" }), { action: "content.publish", resource: "x:1", args: () => { throw new Unbindable("too big"); }, summary: "s", requester: human("mehroz"), next: () => "n" });
    expect([asked.status, asked.body.error, asked.body.code]).toEqual([409, "too big", "unbindable"]);
    await expect(askGated(approvals, async () => ({ ok: true, detail: "" }), { action: "content.publish", resource: "x:1", args: () => { throw new Error("boom"); }, summary: "s", requester: human("mehroz"), next: () => "n" })).rejects.toThrow("boom");
    const live = { mode: "deploy", leadId: 1, siteRef: "a" };
    const ok = await askGated(approvals, async () => ({ ok: true, detail: "" }), { action: "content.publish", resource: "x:2", args: live, summary: "s", requester: human("mehroz"), next: () => "n" });
    expect(ok.status).toBe(202);
    const id2 = (ok.body.approval as { id: string }).id;
    approve(id2, human("usman"));
    const run = await runGated(approvals, { action: "content.publish", resource: "x:2", args: () => { throw new Unbindable("too big"); }, approvalId: id2, caller: human("mehroz"), words: { noun: "preview" } }, async () => 1);
    expect([run.ok, (run as { status: number }).status]).toEqual([false, 409]);
    expect(approvals.get(id2)?.state).toBe("approved");
  });
});

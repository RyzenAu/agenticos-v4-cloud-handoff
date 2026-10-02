import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "./approvals/service";
import type { Principal } from "./approvals/principal";
import { designArgs, handleDesignPublish, type BlotatoFetch, type DesignPublishDeps } from "./design-publish";

/**
 * /__design_publish: in the server role every caller asks first (B2 content.publish), then runs once, bound to what would be
 * posted. Everything is synthetic: a temp folder of fake slide files, a fake Blotato (a test NEVER reaches a social platform),
 * a temp approvals store. The fake records every call so "nothing was posted" is a fact, not a hope.
 */

const base = mkdtempSync(join(tmpdir(), "mu-design-publish-"));
const slide = (n: number) => join(base, `slide-${n}.png`);
writeFileSync(slide(1), "slide one bytes");
writeFileSync(slide(2), "slide two bytes");
const carousels = () => [{ id: "car-1", name: "Spring offers", slides: [{ render: slide(1) }, { render: slide(2) }] }];

let accounts: Array<{ id: string; platform: string; username: string }> = [];
const calls: Array<{ path: string; method: string; body?: any }> = [];
let failPosts = false;
const blotato: BlotatoFetch = async (_key, path, init) => {
  calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const ok = (json: unknown) => ({ status: 200, ok: true, json, body: JSON.stringify(json) });
  if (path === "/users/me/accounts") return ok({ items: accounts });
  if (path === "/media") return ok({ url: `https://fake.invalid/m${calls.length}.png` });
  if (failPosts) return { status: 500, ok: false, json: null, body: "boom" };
  return ok({ id: "post" });
};
const deps = (over: Partial<DesignPublishDeps> = {}): DesignPublishDeps => ({ blotatoKey: () => "fake-key", readCarousels: carousels, blotato, ...over });
const posted = () => calls.filter((c) => c.method === "POST");
const posts = () => calls.filter((c) => c.path === "/posts");

let n = 0;
let approvals = new ApprovalService({ path: join(base, "a0.sqlite") });
const sent: Array<{ to: string; text: string }> = [];
const notify = async (to: string, text: string) => (sent.push({ to, text }), { ok: true, detail: "sent" });

const human = (personId: "usman" | "mehroz", k = 1): Principal => ({ personId, via: "paired-session", actor: "human", sessionId: `sk1.session-${personId}-${k}-abcdef` });
const program = (personId: "usman" | "mehroz"): Principal => ({ personId, via: "loopback-owner", actor: "process" });
const body = (over: Record<string, unknown> = {}) => ({ carouselId: "car-1", platforms: ["Instagram", "TikTok"], caption: "Spring offers", ...over });
const server = (requester: Principal | null, b: unknown, d = deps()) => handleDesignPublish({ body: b, approvalMode: true, requester, approvals: () => approvals, notify }, d);
function approve(id: string, approver: Principal) {
  const card = approvals.card(id, approver);
  expect(card).not.toBeNull();
  expect(approvals.decide(id, approver, "approve", { uiConfirm: true, cardNonce: card!.cardNonce }).ok).toBe(true);
}
async function ask(who: Principal = human("mehroz"), b = body()) {
  const r = await server(who, b);
  expect(r.status).toBe(202);
  return (r.body as any).approval.id as string;
}

beforeEach(() => {
  approvals.close();
  approvals = new ApprovalService({ path: join(base, `a${++n}.sqlite`) });
  calls.length = 0;
  sent.length = 0;
  failPosts = false;
  accounts = [{ id: "acc-ig", platform: "instagram", username: "mu_studio" }, { id: "acc-tt", platform: "tiktok", username: "mu_studio_tt" }];
  writeFileSync(slide(1), "slide one bytes");
  writeFileSync(slide(2), "slide two bytes");
});
afterAll(() => {
  approvals.close();
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* sqlite handle on Windows */
  }
});

describe("server role: ask first", () => {
  test("a founder's request asks (202), posts and uploads nothing, names what and where, and carries no code", async () => {
    const r = await server(human("mehroz"), body());
    expect(r.status).toBe(202);
    const b = r.body as any;
    expect(b).toMatchObject({ needsApproval: true, slides: 2, approval: { action: "content.publish", state: "pending", requester: { personId: "mehroz", actor: "human" } } });
    expect(b.approval.scope.resource).toMatch(/^design-publish:car-1:human:[0-9a-f]{16}$/);
    expect(b.approval.summary).toMatch(/Spring offers/);
    expect(b.approval.summary).toMatch(/Instagram \(mu_studio\)/);
    expect(b.approval.summary).toMatch(/2 slides/);
    expect(b.targets).toEqual([{ platform: "Instagram", account: "mu_studio" }, { platform: "TikTok", account: "mu_studio_tt" }]);
    expect(JSON.stringify(b)).not.toMatch(/[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}/);
    // The only Blotato call was the read-only account lookup.
    expect(calls).toEqual([{ path: "/users/me/accounts", method: "GET", body: undefined }]);
    // Asked once: the same exact request is the same live approval, even with the boxes ticked in another order.
    expect(((await server(human("mehroz"), body())).body as any).approval.id).toBe(b.approval.id);
    expect(((await server(human("mehroz"), body({ platforms: ["TikTok", "instagram"] }))).body as any).approval.id).toBe(b.approval.id);
    expect(posted()).toEqual([]);
  });

  test("missing key, deck, finished renders and accounts answer as before and ask nothing", async () => {
    expect((await server(human("mehroz"), body(), deps({ blotatoKey: () => null }))).status).toBe(428);
    expect((await server(human("mehroz"), body({ carouselId: "nope" }))).status).toBe(404);
    expect((await server(human("mehroz"), body(), deps({ readCarousels: () => [{ id: "car-1", name: "x", slides: [{ render: join(base, "gone.png") }] }] }))).status).toBe(409);
    expect((await server(human("mehroz"), { carouselId: "car-1" })).status).toBe(400);
    accounts = [];
    const none = await server(human("mehroz"), body());
    expect([none.status, (none.body as any).stage]).toEqual([409, "accounts"]);
    expect(approvals.list({ state: "pending" })).toEqual([]);
    expect((await server(null, body())).status).toBe(401);
  });
});

describe("server role: run once", () => {
  test("running before it is approved does nothing; after approval it posts exactly once, as the requester, and records the outcome", async () => {
    const id = await ask();
    const early = await server(human("mehroz"), { ...body(), approvalId: id });
    expect(early.status).toBe(409);
    expect(posted()).toEqual([]);
    approve(id, human("usman"));
    const run = await server(human("mehroz"), { ...body(), approvalId: id });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ ok: true, outcome: "succeeded", approvalId: id, mediaUrls: 2, results: [{ platform: "Instagram", ok: true }, { platform: "TikTok", ok: true }] });
    expect(calls.filter((c) => c.path === "/media").length).toBe(2);
    expect(posts().map((c) => [c.body.post.accountId, c.body.post.content.text, c.body.post.content.mediaUrls.length])).toEqual([["acc-ig", "Spring offers", 2], ["acc-tt", "Spring offers", 2]]);
    expect(approvals.get(id)).toMatchObject({ state: "consumed", outcome: "succeeded" });
    // Replay refused, nothing more is posted.
    const postedBefore = posted().length;
    const again = await server(human("mehroz"), { ...body(), approvalId: id });
    expect(again.status).toBe(409);
    expect(posted().length).toBe(postedBefore);
    expect(posts().length).toBe(2);
  });

  test("only the requester runs it; a wrong or unknown id never runs", async () => {
    const id = await ask();
    approve(id, human("usman"));
    expect((await server(human("usman"), { ...body(), approvalId: id })).status).toBe(403);
    expect((await server(program("usman"), { ...body(), approvalId: id })).status).toBe(403);
    expect((await server(human("mehroz"), { ...body(), approvalId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await server(human("mehroz"), { ...body(), approvalId: "not-an-id" })).status).toBe(400);
    expect(posted()).toEqual([]);
    expect((await server(human("mehroz"), { ...body(), approvalId: id })).status).toBe(200);
    expect(posts().length).toBe(2);
  });

  test("bound to the asking session: another session of the same person, or a program, gets 403 and the approval is NOT voided; the same session runs it once", async () => {
    const id = await ask(human("mehroz", 1));
    approve(id, human("usman"));
    for (const other of [human("mehroz", 2), program("mehroz")]) {
      const r = await server(other, { ...body(), approvalId: id });
      expect(r.status).toBe(403);
    }
    expect(approvals.get(id)?.state).toBe("approved");
    expect(posted()).toEqual([]);
    expect((await server(human("mehroz", 1), { ...body(), approvalId: id })).status).toBe(200);
    expect(posts().length).toBe(2);
    expect((await server(human("mehroz", 1), { ...body(), approvalId: id })).status).toBe(409);
    expect(posts().length).toBe(2);
  });

  test("a second session of the same person asking the identical thing is told so, and is not handed the first session's approval", async () => {
    await ask(human("mehroz", 1));
    const r = await server(human("mehroz", 2), body());
    expect(r.status).toBe(409);
    expect(String((r.body as any).error)).toMatch(/Another session of yours/);
  });

  test("a program's request is bound to process: no browser session (even the same person's) can run it, a program can", async () => {
    const asked = await server(program("usman"), body());
    const id = (asked.body as any).approval.id as string;
    expect((asked.body as any).approval.scope.resource).toMatch(/:process$/);
    const code = /approve ([2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4})/.exec(sent[0].text)![1];
    expect(approvals.decide(id, { personId: "usman", via: "telegram-owner", actor: "human" }, "approve", { telegramCode: code }).ok).toBe(true);
    expect((await server(human("usman", 1), { ...body(), approvalId: id })).status).toBe(403);
    expect(approvals.get(id)?.state).toBe("approved");
    expect(posted()).toEqual([]);
    expect((await server(program("usman"), { ...body(), approvalId: id })).status).toBe(200);
  });

  test("an approval for one deck cannot post another", async () => {
    const id = await ask();
    approve(id, human("usman"));
    const two = () => [...carousels(), { id: "car-2", name: "Other", slides: [{ render: slide(1) }] }];
    const run = await server(human("mehroz"), { ...body({ carouselId: "car-2" }), approvalId: id }, deps({ readCarousels: two }));
    expect(run.status).toBe(404);
    expect(posted()).toEqual([]);
  });

  test("a rejected approval never runs", async () => {
    const id = await ask();
    expect(approvals.decide(id, human("usman"), "reject").ok).toBe(true);
    expect((await server(human("mehroz"), { ...body(), approvalId: id })).status).toBe(409);
    expect(posted()).toEqual([]);
  });

  test("changed content voids the approval at the moment it would run: slide bytes, caption, target accounts, platform list", async () => {
    // slide bytes
    let id = await ask();
    approve(id, human("usman"));
    writeFileSync(slide(2), "slide two, re-rendered");
    let run = await server(human("mehroz"), { ...body(), approvalId: id });
    expect([run.status, (run.body as any).code]).toEqual([409, "digest-mismatch"]);
    expect(approvals.get(id)?.state).toBe("cancelled");
    writeFileSync(slide(2), "slide two bytes");
    // caption (a different text is a different post)
    id = await ask();
    approve(id, human("usman"));
    run = await server(human("mehroz"), { ...body({ caption: "A different caption" }), approvalId: id });
    expect([run.status, (run.body as any).code]).toEqual([409, "digest-mismatch"]);
    // account re-pointed
    id = await ask();
    approve(id, human("usman"));
    accounts = [{ id: "acc-OTHER", platform: "instagram", username: "someone_else" }, accounts[1]];
    run = await server(human("mehroz"), { ...body(), approvalId: id });
    expect([run.status, (run.body as any).code]).toEqual([409, "digest-mismatch"]);
    // an extra platform
    accounts = [{ id: "acc-ig", platform: "instagram", username: "mu_studio" }, { id: "acc-tt", platform: "tiktok", username: "mu_studio_tt" }];
    id = await ask(human("mehroz"), body({ platforms: ["Instagram"] }));
    approve(id, human("usman"));
    run = await server(human("mehroz"), { ...body({ platforms: ["Instagram", "TikTok"] }), approvalId: id });
    expect([run.status, (run.body as any).code]).toEqual([409, "digest-mismatch"]);
    expect(posted()).toEqual([]);
  });

  test("the digest is of content, not of ordering or letter case", () => {
    const files = [{ sha: "a", bytes: Buffer.from("a") }];
    const a = designArgs({ carouselId: "c", caption: "t", files, targets: [{ platform: "Instagram", account: { id: "1", platform: "instagram", label: "" } }, { platform: "TikTok", account: null }] });
    const b = designArgs({ carouselId: "c", caption: "t", files, targets: [{ platform: "tiktok", account: null }, { platform: "instagram", account: { id: "1", platform: "instagram", label: "x" } }] });
    expect(a).toEqual(b);
  });

  test("a post that fails everywhere records a failed outcome and the approval stays spent; a media failure is a 502 and also spent", async () => {
    let id = await ask();
    approve(id, human("usman"));
    failPosts = true;
    let run = await server(human("mehroz"), { ...body(), approvalId: id });
    expect(run.body).toMatchObject({ ok: false, outcome: "failed" });
    expect(approvals.get(id)).toMatchObject({ state: "consumed", outcome: "failed" });
    failPosts = false;
    id = await ask();
    approve(id, human("usman"));
    const down: BlotatoFetch = async (k, p, i) => (p === "/media" ? { status: 503, ok: false, json: null, body: "down" } : blotato(k, p, i));
    run = await server(human("mehroz"), { ...body(), approvalId: id }, deps({ blotato: down }));
    expect([run.status, (run.body as any).stage, (run.body as any).outcome]).toEqual([502, "media", "failed"]);
    expect(approvals.get(id)).toMatchObject({ state: "consumed", outcome: "failed" });
    expect((await server(human("mehroz"), { ...body(), approvalId: id })).status).toBe(409);
  });
});

describe("server role: restart", () => {
  test("approved-but-unconsumed survives a restart and runs once; a consumed run with no recorded outcome is unknown and never replayed", async () => {
    const path = join(base, "restart.sqlite");
    let svc = new ApprovalService({ path });
    const call = (b: unknown) => handleDesignPublish({ body: b, approvalMode: true, requester: human("mehroz"), approvals: () => svc, notify }, deps());
    const decide = (id: string) => {
      const card = svc.card(id, human("usman"))!;
      expect(svc.decide(id, human("usman"), "approve", { uiConfirm: true, cardNonce: card.cardNonce }).ok).toBe(true);
    };
    const first = ((await call(body())).body as any).approval.id as string;
    decide(first);
    // The process "crashes" after consuming but before recording an outcome.
    expect(svc.consume(first, svc.get(first)!.argsDigest).ok).toBe(true);
    svc.close();
    svc = new ApprovalService({ path });
    expect(svc.recover().unknownOutcomes).toBe(1);
    expect(svc.get(first)).toMatchObject({ state: "consumed", outcome: "unknown" });
    calls.length = 0;
    expect((await call({ ...body(), approvalId: first })).status).toBe(409);
    expect(posted()).toEqual([]);
    // A fresh approval that was approved before the restart is still usable, once.
    const second = ((await call(body({ caption: "Second" }))).body as any).approval.id as string;
    decide(second);
    svc.close();
    svc = new ApprovalService({ path });
    svc.recover();
    expect((await call({ ...body({ caption: "Second" }), approvalId: second })).status).toBe(200);
    expect((await call({ ...body({ caption: "Second" }), approvalId: second })).status).toBe(409);
    expect(posts().length).toBe(2);
    svc.close();
  });
});

describe("server role: a program's request needs the stronger proof", () => {
  test("it asks, the code goes only to the requester's own Telegram DM, a click cannot answer it, the code then runs it once", async () => {
    const asked = await server(program("usman"), body());
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ needsApproval: true, codeSent: true, approval: { requester: { personId: "usman", actor: "process" } } });
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("usman");
    const code = /approve ([2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4})/.exec(sent[0].text)?.[1];
    expect(code).toBeTruthy();
    const id = (asked.body as any).approval.id as string;
    expect(JSON.stringify(asked.body)).not.toContain(code!);
    const card = approvals.card(id, human("usman"));
    expect(approvals.decide(id, human("usman"), "approve", { uiConfirm: true, cardNonce: card?.cardNonce ?? "x" }).ok).toBe(false);
    expect((await server(program("usman"), { ...body(), approvalId: id })).status).toBe(409);
    expect(posted()).toEqual([]);
    expect(approvals.decide(id, { personId: "usman", via: "telegram-owner", actor: "human" }, "approve", { telegramCode: code! }).ok).toBe(true);
    expect((await server(program("usman"), { ...body(), approvalId: id })).status).toBe(200);
    expect(posts().length).toBe(2);
  });
});

describe("pc role: unchanged", () => {
  const pc = (b: unknown, d = deps()) => handleDesignPublish({ body: b, approvalMode: false, requester: null }, d);
  test("one POST uploads and posts directly, with the same answer shape and no approval", async () => {
    const r = await pc(body());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, results: [{ platform: "Instagram", ok: true, detail: "queued" }, { platform: "TikTok", ok: true, detail: "queued" }], mediaUrls: 2 });
    expect(approvals.list({})).toEqual([]);
    expect(posts().length).toBe(2);
  });
  test("a platform with no account is reported, not posted; the old stage errors are the same", async () => {
    accounts = [accounts[0]];
    const r = await pc(body());
    expect(r.body).toMatchObject({ ok: true, results: [{ platform: "Instagram", ok: true }, { platform: "TikTok", ok: false, detail: "no account connected in Blotato" }] });
    expect((await pc(body(), deps({ blotatoKey: () => null }))).body).toEqual({ ok: false, stage: "key", error: "no Blotato key connected" });
    expect((await pc({ carouselId: "x" })).body).toEqual({ ok: false, error: "expected { carouselId, platforms }" });
    expect((await pc(body({ carouselId: "nope" }))).status).toBe(404);
  });
});

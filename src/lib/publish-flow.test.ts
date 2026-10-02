// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_READ_MS,
  IDLE,
  PublishFlow,
  approvalsFromActivity,
  claimRun,
  decideOnCard,
  interpretAsk,
  interpretRun,
  publishReduce,
  type ApprovalFeed,
  type ApprovalView,
  type FlowState,
  type KV,
  type Reply,
} from "./publish-flow";
import { designCardWords, designReply, postedLines } from "./design-publish-client";
import { deployReply } from "./leads";

const ID = "11111111-1111-4111-8111-111111111111";
const approval = (state: ApprovalView["state"], over: Partial<ApprovalView> = {}): ApprovalView => ({ id: ID, state, action: "content.publish", summary: "Publish Harbour Realty's preview", ...over });
const asked = (a = approval("pending")): Reply => ({ status: 202, json: { needsApproval: true, approval: a } });
const ok = (json: unknown = { preview: { status: "live", url: "https://x.example" } }): Reply => ({ status: 200, json });
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const memory = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

/** A feed the test pushes approvals through, like /__events does. */
function fakeFeed(healthy = true) {
  const listeners = new Set<(a: ApprovalView[]) => void>();
  const feed: ApprovalFeed & { push(a: ApprovalView): void; subscribers(): number; up: boolean } = {
    up: healthy,
    subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
    healthy() {
      return this.up;
    },
    push: (a) => listeners.forEach((l) => l([a])),
    subscribers: () => listeners.size,
  };
  return feed;
}
function rig(opts: { replies?: Reply[]; feed?: ReturnType<typeof fakeFeed>; fetched?: () => ApprovalView | null; storage?: KV | null; claims?: Set<string>; resumeKey?: string | null; timers?: Array<() => void> } = {}) {
  const sent: Array<string | undefined> = [];
  const replies = [...(opts.replies ?? [])];
  const reads: string[] = [];
  const settled: FlowState[] = [];
  const flow = new PublishFlow({
    send: async (id) => (sent.push(id), replies.shift() ?? ok()),
    fetchApproval: async (id) => (reads.push(id), opts.fetched ? opts.fetched() : null),
    feed: opts.feed,
    storage: opts.storage === undefined ? memory() : opts.storage,
    claims: opts.claims ?? new Set(),
    resumeKey: opts.resumeKey === undefined ? "k" : opts.resumeKey,
    setTimer: (fn) => (opts.timers?.push(fn), opts.timers?.length ?? 0),
    clearTimer: () => {},
    onSettled: (s) => settled.push(s),
  });
  return { flow, sent, reads, settled };
}

describe("hub answers, worded as the server meant them", () => {
  test("ask: 202 is an approval, any other 2xx simply ran (pc role), anything else is an error with the hub's words", () => {
    expect(interpretAsk(asked())).toMatchObject({ kind: "asked", approval: { id: ID } });
    expect(interpretAsk(ok())).toMatchObject({ kind: "done" });
    expect(interpretAsk({ status: 400, json: { error: "Confirm by passing the exact domain: x" } })).toMatchObject({ kind: "ended", why: "error", message: "Confirm by passing the exact domain: x" });
    expect(interpretAsk({ status: 202, json: {} })).toMatchObject({ kind: "done" }); // not an approval answer: never treated as waiting
  });
  test("run: voided, already used, expired, declined and a failed run each say so; none is softened into done", () => {
    expect(interpretRun({ status: 409, json: { code: "digest-mismatch", error: "The preview changed after it was approved, so the approval is void. Ask again." } })).toMatchObject({ why: "voided" });
    expect(interpretRun({ status: 409, json: { code: "consumed", error: "That approval was already used." } })).toMatchObject({ why: "already-used" });
    expect(interpretRun({ status: 409, json: { error: "That approval was already used." } })).toMatchObject({ why: "already-used" });
    expect(interpretRun({ status: 409, json: { code: "expired", error: "That approval expired. Ask again." } })).toMatchObject({ why: "expired" });
    expect(interpretRun({ status: 409, json: { error: "Not approved yet (it is rejected).", approval: { state: "rejected" } } })).toMatchObject({ why: "rejected" });
    const failed = interpretRun({ status: 400, json: { error: "Vercel said no", outcome: "failed" } });
    expect(failed).toMatchObject({ kind: "ended", why: "error" });
    expect((failed as { message: string }).message).toMatch(/Vercel said no.*approval is spent/);
    expect(interpretRun({ status: 200, json: { outcome: "succeeded" } })).toMatchObject({ kind: "done" });
  });
});

describe("the state machine", () => {
  test("ask, asked, approved, run, ran; replays and out-of-order events change nothing", () => {
    let s: FlowState = IDLE;
    s = publishReduce(s, { t: "ask" });
    expect(s.kind).toBe("asking");
    expect(publishReduce(s, { t: "ask" })).toBe(s);
    s = publishReduce(s, { t: "asked", approval: approval("pending") });
    expect(s.kind).toBe("waiting");
    expect(publishReduce(s, { t: "run" })).toBe(s); // cannot run before approval
    s = publishReduce(s, { t: "seen", approval: approval("approved") });
    expect(s.kind).toBe("approved");
    expect(publishReduce(s, { t: "seen", approval: approval("approved") })).toBe(s);
    s = publishReduce(s, { t: "run" });
    expect(s.kind).toBe("running");
    expect(publishReduce(s, { t: "run" })).toBe(s);
    s = publishReduce(s, { t: "seen", approval: approval("consumed") }); // our own run's consumption does not end it
    expect(s.kind).toBe("running");
    s = publishReduce(s, { t: "ran", result: { a: 1 } });
    expect(s).toMatchObject({ kind: "done", via: "approved", approvalId: ID });
    expect(publishReduce(s, { t: "seen", approval: approval("rejected") })).toBe(s);
  });
  test("an event for another approval is ignored; rejected, cancelled and expired end it with their own words", () => {
    const waiting = publishReduce(publishReduce(IDLE, { t: "ask" }), { t: "asked", approval: approval("pending") });
    expect(publishReduce(waiting, { t: "seen", approval: { ...approval("approved"), id: "22222222-2222-4222-8222-222222222222" } })).toBe(waiting);
    for (const why of ["rejected", "cancelled", "expired"] as const) expect(publishReduce(waiting, { t: "seen", approval: approval(why) })).toMatchObject({ kind: "ended", why });
    expect(publishReduce(waiting, { t: "seen", approval: approval("cancelled", { reason: "digest-mismatch" }) })).toMatchObject({ why: "cancelled", message: expect.stringMatching(/changed after it was approved/) });
    expect(publishReduce(waiting, { t: "seen", approval: approval("consumed") })).toMatchObject({ kind: "ended", why: "already-used" });
  });
});

describe("claimRun: this browser runs an approval once", () => {
  test("a re-render, a second flow and a second tab are all refused after the first", () => {
    const store = memory();
    const mine = new Set<string>();
    expect(claimRun(ID, store, mine)).toBe(true);
    expect(claimRun(ID, store, mine)).toBe(false); // re-render
    expect(claimRun(ID, store, new Set())).toBe(false); // another tab: new memory, same storage
    expect(claimRun("33333333-3333-4333-8333-333333333333", store, mine)).toBe(true);
  });
  test("with storage blocked it still claims once per page", () => {
    const broken: KV = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    const mine = new Set<string>();
    expect(claimRun(ID, broken, mine)).toBe(true);
    expect(claimRun(ID, broken, mine)).toBe(false);
  });
});

describe("PublishFlow", () => {
  test("pc role: the first POST just does it; no approval, no watching, one send", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [ok()], feed });
    await r.flow.start();
    expect(r.flow.getState()).toMatchObject({ kind: "done", via: "direct" });
    expect(r.sent).toEqual([undefined]);
    expect(feed.subscribers()).toBe(0);
    expect(r.settled.length).toBe(1);
  });

  test("server role: 202 shows waiting and sends nothing more; approval over the stream runs it exactly once with the id", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [asked(), ok()], feed, fetched: () => approval("pending") });
    await r.flow.start();
    expect(r.flow.getState()).toMatchObject({ kind: "waiting", approval: { id: ID } });
    expect(r.sent).toEqual([undefined]);
    expect(feed.subscribers()).toBe(1);
    feed.push(approval("pending")); // an unrelated update changes nothing
    await flush();
    expect(r.sent).toEqual([undefined]);
    feed.push(approval("approved"));
    feed.push(approval("approved")); // a replayed event
    feed.push(approval("approved"));
    await flush();
    expect(r.sent).toEqual([undefined, ID]);
    expect(r.flow.getState()).toMatchObject({ kind: "done", via: "approved", approvalId: ID });
    expect(feed.subscribers()).toBe(0); // stopped watching
    feed.push(approval("consumed"));
    await flush();
    expect(r.sent.length).toBe(2);
    expect(r.settled.at(-1)?.kind).toBe("done");
  });

  test("an approval that was granted before the stream was subscribed is found by the one read", async () => {
    const r = rig({ replies: [asked(), ok()], feed: fakeFeed(), fetched: () => approval("approved") });
    await r.flow.start();
    await flush();
    expect(r.sent).toEqual([undefined, ID]);
    expect(r.flow.getState().kind).toBe("done");
  });

  test("start twice, or while waiting, asks only once", async () => {
    const r = rig({ replies: [asked()], feed: fakeFeed(), fetched: () => approval("pending") });
    await Promise.all([r.flow.start(), r.flow.start()]);
    await r.flow.start();
    expect(r.sent).toEqual([undefined]);
  });

  test("declined, withdrawn and expired end it, say so, and never run", async () => {
    for (const why of ["rejected", "cancelled", "expired"] as const) {
      const feed = fakeFeed();
      const r = rig({ replies: [asked()], feed, fetched: () => approval("pending"), storage: memory(), claims: new Set() });
      await r.flow.start();
      feed.push(approval(why));
      await flush();
      expect(r.flow.getState()).toMatchObject({ kind: "ended", why });
      expect(r.sent).toEqual([undefined]);
    }
  });

  test("the preview changing after approval: the hub's 409 digest-mismatch is shown as voided, not as an error or a success", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [asked(), { status: 409, json: { code: "digest-mismatch", error: "The preview changed after it was approved, so the approval is void. Ask again." } }], feed, fetched: () => approval("pending") });
    await r.flow.start();
    feed.push(approval("approved"));
    await flush();
    expect(r.flow.getState()).toMatchObject({ kind: "ended", why: "voided" });
    expect(r.sent).toEqual([undefined, ID]);
  });

  test("two tabs: only the one that claims runs it; the other shows 'already used' when the approval is spent", async () => {
    const storage = memory();
    const feedA = fakeFeed();
    const feedB = fakeFeed();
    const a = rig({ replies: [asked(), ok()], feed: feedA, fetched: () => approval("pending"), storage, claims: new Set() });
    const b = rig({ replies: [asked()], feed: feedB, fetched: () => approval("pending"), storage, claims: new Set(), resumeKey: null });
    await a.flow.start();
    // Tab B joins the same approval (as it would after a refresh), then both see "approved".
    await b.flow.start();
    feedA.push(approval("approved"));
    feedB.push(approval("approved"));
    await flush();
    expect(a.sent).toEqual([undefined, ID]);
    expect(b.sent).toEqual([undefined]); // never sent the run
    expect(a.flow.getState().kind).toBe("done");
    expect(b.flow.getState().kind).toBe("approved"); // still watching for what the other tab did
    feedB.push(approval("consumed", { outcome: "succeeded" }));
    await flush();
    expect(b.flow.getState()).toMatchObject({ kind: "ended", why: "already-used" });
    expect(b.settled.at(-1)?.kind).toBe("ended"); // so the page refetches the real state
  });

  test("if the server says already used (the other tab won the race), that is what is shown", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [asked(), { status: 409, json: { code: "consumed", error: "That approval was already used." } }], feed, fetched: () => approval("pending") });
    await r.flow.start();
    feed.push(approval("approved"));
    await flush();
    expect(r.flow.getState()).toMatchObject({ kind: "ended", why: "already-used" });
  });

  test("a failed run is shown as failed (and says the approval is spent), not as published", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [asked(), { status: 400, json: { error: "Vercel said no", outcome: "failed" } }], feed, fetched: () => approval("pending") });
    await r.flow.start();
    feed.push(approval("approved"));
    await flush();
    expect(r.flow.getState()).toMatchObject({ kind: "ended", why: "error" });
    expect((r.flow.getState() as { message: string }).message).toMatch(/spent/);
  });

  test("a dropped connection during the run does not claim success", async () => {
    const feed = fakeFeed();
    const flow = new PublishFlow({
      send: async (id) => {
        if (id) throw new Error("Failed to fetch");
        return asked();
      },
      fetchApproval: async () => approval("pending"),
      feed,
      storage: memory(),
      claims: new Set(),
      setTimer: () => 1,
      clearTimer: () => {},
    });
    await flow.start();
    feed.push(approval("approved"));
    await flush();
    expect(flow.getState()).toMatchObject({ kind: "ended", why: "error", message: expect.stringMatching(/may or may not have been used/) });
  });

  test("a refresh resumes an open approval (one read), runs an approved one once, and forgets a finished one", async () => {
    const storage = memory();
    storage.setItem("k", ID);
    const pending = rig({ feed: fakeFeed(), fetched: () => approval("pending"), storage, claims: new Set() });
    await pending.flow.resume();
    expect(pending.flow.getState()).toMatchObject({ kind: "waiting" });
    expect(pending.sent).toEqual([]);

    const approved = rig({ replies: [ok()], feed: fakeFeed(), fetched: () => approval("approved"), storage, claims: new Set() });
    await approved.flow.resume();
    await flush();
    expect(approved.sent).toEqual([ID]);
    expect(approved.flow.getState().kind).toBe("done");

    storage.setItem("k", ID);
    const spent = rig({ feed: fakeFeed(), fetched: () => approval("consumed"), storage, claims: new Set() });
    await spent.flow.resume();
    expect(spent.flow.getState()).toBe(IDLE);
    expect(storage.getItem("k")).toBeNull();
  });

  test("the stream is the source; a read timer exists only to cover a down stream", async () => {
    const timers: Array<() => void> = [];
    const feed = fakeFeed(true);
    let reads = 0;
    const r = rig({ replies: [asked()], feed, timers, fetched: () => (reads++, approval("pending")) });
    await r.flow.start();
    await flush();
    const afterStart = reads; // the one starting read
    expect(afterStart).toBe(1);
    timers.at(-1)!(); // a tick with a healthy stream reads nothing
    await flush();
    expect(reads).toBe(afterStart);
    feed.up = false;
    timers.at(-1)!(); // a tick with the stream down reads
    await flush();
    expect(reads).toBe(afterStart + 1);
    expect(FALLBACK_READ_MS).toBeGreaterThanOrEqual(5000);
  });

  test("a screen that unmounts and mounts again (StrictMode, a drawer reopened) keeps following the same approval and still runs it once", async () => {
    const feed = fakeFeed();
    const r = rig({ replies: [asked(), ok()], feed, fetched: () => approval("pending") });
    await r.flow.start();
    r.flow.dispose();
    expect(feed.subscribers()).toBe(0);
    r.flow.attach();
    expect(feed.subscribers()).toBe(1);
    feed.push(approval("approved"));
    await flush();
    expect(r.sent).toEqual([undefined, ID]);
    expect(r.flow.getState().kind).toBe("done");
    // and a resume after dispose + attach (StrictMode's second effect) still works
    const storage = memory();
    storage.setItem("k", ID);
    const again = rig({ feed: fakeFeed(), fetched: () => approval("pending"), storage });
    const pending = again.flow.resume();
    again.flow.dispose();
    again.flow.attach();
    await pending;
    await again.flow.resume();
    expect(again.flow.getState().kind).toBe("waiting");
  });

  test("dismiss leaves a finished flow and forgets it", async () => {
    const storage = memory();
    const feed = fakeFeed();
    const r = rig({ replies: [asked()], feed, storage, fetched: () => approval("pending") });
    await r.flow.start();
    expect(storage.getItem("k")).toBe(ID);
    r.flow.dismiss();
    expect(r.flow.getState()).toBe(IDLE);
    expect(storage.getItem("k")).toBeNull();
    expect(feed.subscribers()).toBe(0);
  });
});

describe("the activity stream's approval events", () => {
  test("an approval event and a snapshot both yield approvals; other topics do not", () => {
    expect(approvalsFromActivity({ kind: "event", event: { topic: "approval", data: { approval: approval("approved") } } })).toEqual([approval("approved")]);
    expect(approvalsFromActivity({ kind: "event", event: { topic: "job", data: { approval: approval("approved") } } })).toEqual([]);
    expect(approvalsFromActivity({ kind: "snapshot", snapshot: { approvals: [approval("pending")] } })).toEqual([approval("pending")]);
    expect(approvalsFromActivity({ kind: "event", event: { topic: "approval", data: {} } })).toEqual([]);
  });
});

describe("confirming on the card", () => {
  const route = (answers: Record<string, { status: number; json: unknown }>, seen: Array<{ url: string; body: unknown }> = []): typeof fetch =>
    (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const key = Object.keys(answers).find((k) => String(url).endsWith(k))!;
      const a = key ? answers[key] : { status: 404, json: {} };
      return new Response(JSON.stringify(a.json), { status: a.status });
    }) as never;
  test("approve = card nonce, then decide with uiConfirm; the hub's refusal is shown as it was said", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const f = route({ "/__token": { status: 200, json: { token: "t" } }, "/card": { status: 200, json: { cardNonce: "nonce-1" } }, "/decide": { status: 200, json: { approval: approval("approved") } } }, seen);
    const r = await decideOnCard(ID, "approve", f);
    expect(r.ok).toBe(true);
    expect(seen.at(-1)).toMatchObject({ url: `/__approvals/${ID}/decide`, body: { decision: "approve", evidence: { uiConfirm: true, cardNonce: "nonce-1" } } });
    const refused = await decideOnCard(ID, "approve", route({ "/__token": { status: 200, json: { token: "t" } }, "/card": { status: 403, json: { error: "Confirming needs a signed-in browser session." } } }));
    expect(refused).toMatchObject({ ok: false, message: "Confirming needs a signed-in browser session." });
  });
  test("decline needs no card", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const r = await decideOnCard(ID, "reject", route({ "/__token": { status: 200, json: { token: "t" } }, "/decide": { status: 200, json: { approval: approval("rejected") } } }, seen));
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(["/__token", `/__approvals/${ID}/decide`]);
  });
});

describe("what each screen makes of the answer", () => {
  test("leads: a 200 deploy whose preview isn't live and checked is a failure, as the pc-role drawer always said", () => {
    expect(deployReply({ status: 200, json: { preview: { status: "live", lastError: null } } }).status).toBe(200);
    expect(deployReply({ status: 200, json: { preview: { status: "live", lastError: "banner missing" } } })).toMatchObject({ status: 400, json: { error: "banner missing" } });
    expect(deployReply({ status: 200, json: { preview: { status: "failed", lastError: null } } }).json.error).toMatch(/live check/);
    expect(deployReply({ status: 202, json: { needsApproval: true } }).status).toBe(202);
  });
  test("design: nothing queued anywhere is a failure with the per-platform lines; the old render wording is kept; a partial success stays a success", () => {
    const results = [{ platform: "Instagram", ok: false, detail: "500: boom" }, { platform: "TikTok", ok: false, detail: "no account connected in Blotato" }];
    expect(designReply({ status: 200, json: { ok: false, results } })).toMatchObject({ status: 502, json: { error: "Instagram: 500: boom · TikTok: no account connected in Blotato" } });
    expect(designReply({ status: 409, json: { ok: false, stage: "render", error: "x" } }).json.error).toMatch(/Render it before publishing/);
    expect(designReply({ status: 200, json: { ok: true, results } }).status).toBe(200);
    expect(designReply({ status: 202, json: { needsApproval: true } }).status).toBe(202);
    expect(postedLines({ results: [{ platform: "Instagram", ok: true, detail: "queued" }, results[1]] })).toBe("Instagram: queued · TikTok: no account connected in Blotato");
    expect(designCardWords("Spring", 3, ["Instagram"])).toEqual({ what: 'The carousel "Spring" (3 slides)', where: "Instagram through Blotato" });
  });
});

// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import type { BotThreadEntry } from "@/lib/agent-chat";
import { addAck, addRequest, applyEntries, emptyChat, isNotable, needsYou, recoveryFor, titleOf, toBlocks, toStored, withStored, working, type Run } from "./chat-state";
import { JOB_A, JOB_B, JOB_C } from "./__fixtures__/fake-bot-hub";

let seq = 0;
const entry = (jobId: string, key: string, state: string, text: string, extra: Partial<BotThreadEntry> = {}): BotThreadEntry => ({
  seq: ++seq,
  key: `${jobId}:${key}`,
  at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  jobId,
  state,
  text,
  ...extra,
});
const runs = (blocks: ReturnType<typeof toBlocks>) => blocks.filter((b): b is Run => b.type === "run");

describe("folding server entries", () => {
  test("applying the same entry twice (a replay, a second tab, a catch-up over a live event) changes nothing", () => {
    const e = entry(JOB_A, "started", "started", `Started: Find dentists (job ${JOB_A.slice(0, 8)}).`);
    const once = applyEntries(emptyChat(), [e]);
    expect(once.applied).toHaveLength(1);
    const twice = applyEntries(once.state, [e]);
    expect(twice.applied).toHaveLength(0);
    expect(twice.state).toBe(once.state);
    expect(twice.state.items).toHaveLength(1);
  });

  test("a catch-up page that overlaps what is shown adds only what is missing, in server order, however it arrives", () => {
    const e1 = entry(JOB_A, "started", "started", "Started: x (job 0a1b2c3d).");
    const e2 = entry(JOB_A, "step:1", "progress", "one");
    const e3 = entry(JOB_A, "step:2", "progress", "two");
    const live = applyEntries(emptyChat(), [e2]).state;
    const caught = applyEntries(live, [e3, e1, e2]);
    expect(caught.applied.map((i) => i.key)).toEqual([e1.key, e3.key]);
    expect(caught.state.items.map((i) => i.key)).toEqual([e1.key, e2.key, e3.key]);
    expect(caught.state.maxSeq).toBe(e3.seq);
  });

  test("after a hub restart a full re-read of the thread (from 0) creates no duplicates and keeps the order", () => {
    const all = [entry(JOB_A, "started", "started", "Started: x (job 0a1b2c3d)."), entry(JOB_A, "step:1", "progress", "one"), entry(JOB_A, "report:1", "report", "Done.")];
    const before = applyEntries(emptyChat(), all).state;
    const again = applyEntries(before, all.map((e) => ({ ...e })));
    expect(again.applied).toHaveLength(0);
    expect(again.state.items.map((i) => i.key)).toEqual(all.map((e) => e.key));
  });

  test("the maximum seq moves even for entries already shown, so the next catch-up resumes after it", () => {
    const e = entry(JOB_A, "started", "started", "Started: x (job 0a1b2c3d).");
    const s = applyEntries(emptyChat(), [e]).state;
    expect(applyEntries(s, [{ ...e, seq: e.seq + 50 }]).state.maxSeq).toBe(e.seq + 50);
  });
});

describe("the person's own lines", () => {
  test("a request shows at once, its acknowledgement follows it, and both come back after the page is reopened", () => {
    let s = addRequest(emptyChat(), { key: "k1", text: "Find dentists", source: "typed", at: 1000 });
    expect(s.items[0]).toMatchObject({ type: "request", pending: true });
    s = addAck(s, { key: "k1", text: "On it.", ok: true, jobId: JOB_A, at: 900 });
    expect(s.items.map((i) => i.type)).toEqual(["request", "ack"]);
    expect(s.items[0]).toMatchObject({ pending: false, jobId: JOB_A });
    expect(s.items[1].at).toBeGreaterThan(s.items[0].at);
    const restored = withStored(emptyChat(), toStored(s));
    expect(restored.items.map((i) => [i.type, i.text])).toEqual([
      ["request", "Find dentists"],
      ["ack", "On it."],
    ]);
    // the same request key twice, or acknowledging twice, never doubles it
    const again = addAck(addRequest(s, { key: "k1", text: "Find dentists", source: "typed", at: 1000 }), { key: "k1", text: "On it.", ok: true, jobId: JOB_A, at: 1 });
    expect(again.items).toHaveLength(2);
  });

  test("an unsent (pending) request is not kept on the device", () => {
    expect(toStored(addRequest(emptyChat(), { key: "k", text: "x", source: "voice", at: 1 }))).toEqual([]);
  });
});

describe("reading the transcript as blocks", () => {
  test("one card per job: the started line is the title, progress steps fold into the card, request and ack stay as lines", () => {
    let s = addAck(addRequest(emptyChat(), { key: "k", text: "Find dentists", source: "typed", at: 1_699_999_990_000 }), { key: "k", text: "On it.", ok: true, jobId: JOB_A, at: 1_699_999_990_001 });
    s = applyEntries(s, [entry(JOB_A, "started", "started", `Started: Find dentists (job ${JOB_A.slice(0, 8)}).`), entry(JOB_A, "step:1", "progress", "Searched."), entry(JOB_A, "step:2", "progress", "Scored.")]).state;
    const blocks = toBlocks(s);
    expect(blocks.map((b) => b.type)).toEqual(["request", "ack", "run"]);
    const [r] = runs(blocks);
    expect(r).toMatchObject({ title: "Find dentists", status: "running", jobId: JOB_A });
    expect(r.steps.map((x) => x.text)).toEqual(["Searched.", "Scored."]);
    expect(working(blocks)).toBe(true);
    expect(needsYou(blocks)).toBe(false);
  });

  test("two jobs interleave without mixing; each keeps its own state", () => {
    const s = applyEntries(emptyChat(), [
      entry(JOB_A, "started", "started", "Started: A (job 0a1b2c3d)."),
      entry(JOB_B, "started", "started", "Started: B (job 0b1b2c3d)."),
      entry(JOB_A, "report:1", "report", "Result A\nSaved result: A\n(job 0a1b2c3d)"),
      entry(JOB_B, "needs_owner", "needs_owner", "Code needed."),
    ]).state;
    const [a, b] = runs(toBlocks(s));
    expect(a).toMatchObject({ status: "done", hasSavedResult: true });
    expect(b).toMatchObject({ status: "blocked" });
    expect(needsYou(toBlocks(s))).toBe(true);
  });

  test("a blocked job that then makes progress is running again; the last word wins", () => {
    const s = applyEntries(emptyChat(), [entry(JOB_A, "started", "started", "Started: A (job 0a1b2c3d)."), entry(JOB_A, "needs_owner", "needs_owner", "Code."), entry(JOB_A, "step:3", "progress", "Back on it.")]).state;
    expect(runs(toBlocks(s))[0].status).toBe("running");
  });

  test("a result without a saved-result line offers no result link; one with the line does", () => {
    const plain = applyEntries(emptyChat(), [entry(JOB_A, "started", "started", "Started: A (job 0a1b2c3d)."), entry(JOB_A, "report:1", "report", "Just words.")]).state;
    expect(runs(toBlocks(plain))[0].hasSavedResult).toBe(false);
    const saved = applyEntries(emptyChat(), [entry(JOB_A, "started", "started", "Started: A (job 0a1b2c3d)."), entry(JOB_A, "report:1", "report", "Words.\nSaved result: A\n(job 0a1b2c3d)")]).state;
    expect(runs(toBlocks(saved))[0].hasSavedResult).toBe(true);
  });

  test("titleOf reads the server's started line and falls back to the first line", () => {
    expect(titleOf("Started: Find dentists (job 0a1b2c3d).")).toBe("Find dentists");
    expect(titleOf("Following: Research notes (job 0a1b2c3d).")).toBe("Research notes");
    expect(titleOf("Something else\nmore")).toBe("Something else");
  });
});

describe("blockers and recovery", () => {
  const runFor = (state: string, text = "x", extra: Partial<BotThreadEntry> = {}) =>
    runs(toBlocks(applyEntries(emptyChat(), [entry(JOB_C, "started", "started", "Started: T (job 0c1b2c3d)."), entry(JOB_C, state, state, text, extra)]).state))[0];
  test("approval, take over, allowance, failed and unclear each offer the right actions", () => {
    expect(recoveryFor(runFor("awaiting-approval"))).toMatchObject({ title: "Needs your approval", actions: ["approve", "open-job"] });
    expect(recoveryFor(runFor("needs_owner"))).toMatchObject({ title: "Needs your decision", actions: ["open-job"] });
    expect(recoveryFor(runFor("blocked_allowance"))).toMatchObject({ actions: ["retry", "open-job"] });
    expect(recoveryFor(runFor("failed"))).toMatchObject({ tone: "danger", actions: ["retry", "open-job"] });
    expect(recoveryFor(runFor("interrupted"))).toMatchObject({ title: "Outcome unclear", actions: ["reconnect", "open-job"] });
  });
  test("the server's own recovery sentence and blocker kind win over the default", () => {
    const r = recoveryFor(runFor("needs_owner", "x", { blocker: { kind: "offline", recovery: "Reconnect Ryzen-PC." } }))!;
    expect(r.body).toBe("Reconnect Ryzen-PC.");
    expect(r.actions).toEqual(["reconnect", "open-job"]);
  });
  test("the server's own kinds map: needs-approval offers Review and approve; an allowance blocker is the account limit, not offline", () => {
    const a = recoveryFor(runFor("awaiting_approval", "x", { blocker: { kind: "needs-approval", approvalId: "ap1" } }))!;
    expect(a.actions).toEqual(["approve", "open-job"]);
    expect(a.title).toBe("Needs your approval");
    const l = recoveryFor(runFor("blocked_allowance", "x", { blocker: { kind: "allowance" } }))!;
    expect(l.actions).toEqual(["retry", "open-job"]);
    expect(`${l.title} ${l.body}`).toContain("limit");
    expect(`${l.title} ${l.body}`.toLowerCase()).not.toContain("offline");
    expect(recoveryFor(runFor("needs_owner", "x", { blocker: { kind: "needs-takeover" } }))!.actions).toEqual(["take-over", "open-job"]);
  });
  test("a coding job stopped for its owner is a decision, never an approval or a takeover, and offers only the job", () => {
    const r = recoveryFor(runFor("needs_owner", "x", { jobKind: "coding", blocker: { kind: "needs-owner", recovery: "The builder did not finish." } }))!;
    expect(r).toMatchObject({ title: "Needs your decision", body: "The builder did not finish.", actions: ["open-job"] });
  });
  test("an unknown blocker kind falls back to the job state instead of hiding it", () => {
    const r = recoveryFor(runFor("blocked_allowance", "x", { blocker: { kind: "something-new" } }))!;
    expect(r.actions).toEqual(["retry", "open-job"]);
    expect(recoveryFor(runFor("awaiting_approval", "x", { blocker: { kind: "???" } }))!.actions).toEqual(["approve", "open-job"]);
  });
  test("a takeover blocker on a progress entry holds the run: Needs you, with the take-over action, until a later step clears it", () => {
    const held = (extra: Partial<BotThreadEntry>[] = []) =>
      runs(toBlocks(applyEntries(emptyChat(), [
        entry(JOB_C, "started", "started", "Started: T (job 0c1b2c3d)."),
        entry(JOB_C, "step:1", "progress", "Paused: a person has taken over.", { blocker: { kind: "needs-takeover", recovery: "Return control from the Computer tab." } }),
        ...extra.map((e, i) => entry(JOB_C, `step:${i + 2}`, "progress", "Back on it.", e)),
      ]).state))[0];
    const run = held();
    expect(run.status).toBe("blocked");
    expect(recoveryFor(run)).toMatchObject({ title: "Needs you at the computer", body: "Return control from the Computer tab.", actions: ["take-over", "open-job"] });
    expect(needsYou([run])).toBe(true);
    expect(held([{}]).status).toBe("running");
    expect(recoveryFor(held([{}]))).toBeNull();
  });
  test("a running, finished or deliberately stopped job offers no recovery", () => {
    expect(recoveryFor(runFor("step:1"))).toBeNull();
    expect(recoveryFor(runFor("cancelled"))).toBeNull();
    expect(recoveryFor(runFor("succeeded"))).toBeNull();
  });
  test("results, failures and waiting entries are notable; progress is not", () => {
    const items = applyEntries(emptyChat(), [entry(JOB_A, "step:1", "progress", "p"), entry(JOB_A, "report:1", "report", "r"), entry(JOB_A, "failed", "failed", "f")]).applied;
    expect(items.map(isNotable)).toEqual([false, true, true]);
  });
});

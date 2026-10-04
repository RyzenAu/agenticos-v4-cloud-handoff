import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { conversationStore, jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { freeVoice } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { createTypedTurnPersistence } from "./typed-turn-persistence";

const principal: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const other: Principal = { personId: "mehroz", via: "paired-session", actor: "human", displayName: "Mehroz" };
const words = "Reply with QA JARVIS 20261005 only.";
const answer = "QA JARVIS 20261005";
const body = (extra: Record<string, unknown> = {}) => ({ typed: true, requestId: "plain-request-20261005", turnIndex: 0, messages: [{ role: "user", content: words }], ...extra });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const root = mkdtempSync(join(tmpdir(), "typed-turn-")); dirs.push(root);
  const store = conversationStore(root);
  const run = createTypedTurnPersistence(store);
  return { root, store, run, saved: () => conversationStore(root).get(jarvisThreadId("usman")) };
}

describe("typed plain answer durability", () => {
  test("actual free-turn plain answer is saved on reload, exact words and digits, without a job", async () => {
    const r = rig(); let calls = 0;
    const engine = () => freeVoice(r.root, {
      key: (n) => n === "GROQ_API_KEY" ? "synthetic" : "", bots: () => [],
      fetch: (async (url: string) => { if (!url.includes("/chat/completions")) throw Error("unexpected network"); calls++; return Response.json({ choices: [{ message: { role: "assistant", content: answer } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); }) as typeof fetch,
      sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), hub: () => ({ name: "fixture", role: "server" }), companions: () => [],
    });
    const out = await engine().handle("/voice/free/turn", body(), undefined, principal) as any;
    expect(out.content).toBe(answer);
    expect(out.persistence).toMatchObject({ saved: true, complete: true, conversationId: jarvisThreadId("usman") });
    expect(r.saved()!.messages.map((m) => [m.role, m.text])).toEqual([["user", words], ["oracle", answer]]);
    expect(r.saved()!.jobs).toEqual([]);
    expect(await engine().handle("/voice/free/turn", body(), undefined, principal)).toEqual(out);
    expect(calls).toBe(1);
  });
  test("host-only policy refusals are persisted without invoking the turn or model", async () => {
    const r = rig(); let calls = 0;
    const engine = freeVoice(r.root, { key: () => "", bots: () => [], fetch: (async () => { calls++; throw Error("must not call"); }) as typeof fetch });
    const refusal = "Away mode is for the PC it runs on.";
    const out = await engine.handle("/voice/free/turn", body(), undefined, principal, refusal) as any;
    expect(out.content).toBe(refusal); expect(out.persistence.saved).toBe(true);
    expect(r.saved()!.messages.at(-1)!.text).toBe(refusal); expect(calls).toBe(0);
  });
  test("early /thread/say plus final duplicate are compatible, and a fresh store sees each only once", async () => {
    const r = rig(); const binding = { personId: "usman", requestId: body().requestId };
    r.store.saveTypedPart(binding, "user", "user", words);
    await r.run(body(), principal, async () => ({ content: answer }));
    r.store.saveTypedPart(binding, "reply", "assistant", answer);
    expect(r.saved()!.messages).toHaveLength(2);
  });
  test("concurrent same-id replay shares execution; identical text with a new id is new", async () => {
    const r = rig(); let calls = 0; let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const execute = async () => { calls++; await pause; return { content: answer }; };
    const first = r.run(body(), principal, execute), second = r.run(body(), principal, execute);
    release(); expect(await first).toEqual(await second); expect(calls).toBe(1);
    await r.run(body({ requestId: "another-request-20261005" }), principal, execute);
    expect(calls).toBe(2); expect(r.saved()!.messages).toHaveLength(4);
  });
  test("changing request text or origin rejects both in-flight and after restart", async () => {
    const r = rig(); let calls = 0;
    await r.run(body(), principal, async () => { calls++; return { content: answer }; });
    const restarted = createTypedTurnPersistence(conversationStore(r.root));
    for (const run of [r.run, restarted]) {
      await expect(run(body({ messages: [{ role: "user", content: "Different words" }] }), principal, async () => { calls++; return { content: "wrong" }; })).rejects.toMatchObject({ code: "typed_request_conflict", status: 409 });
      await expect(run(body({ conversationId: "11111111-2222-4333-8444-555555555555" }), principal, async () => { calls++; return {}; })).rejects.toMatchObject({ code: "typed_request_conflict" });
    }
    expect(calls).toBe(1); expect(r.store.list()).toHaveLength(1);
  });
  test("founder is verified separately, foreign and unowned conversations are never adopted", async () => {
    const r = rig();
    await expect(r.run(body({ personId: "usman" }), undefined, async () => ({ content: answer }))).rejects.toMatchObject({ code: "typed_identity_required" });
    await r.run(body(), principal, async () => ({ content: answer }));
    await expect(r.run(body({ conversationId: jarvisThreadId("usman") }), other, async () => ({ content: "wrong" }))).rejects.toMatchObject({ status: 403 });
    const legacy = r.store.save({ messages: [{ role: "user", text: "legacy" }] });
    await expect(r.run(body({ conversationId: legacy.id }), principal, async () => ({ content: "wrong" }))).rejects.toMatchObject({ status: 403 });
    await r.run(body(), other, async () => ({ content: "Mehroz's reply" }));
    expect(r.store.get(jarvisThreadId("mehroz"))!.messages.at(-1)!.text).toBe("Mehroz's reply");
    expect(r.saved()!.messages.at(-1)!.text).toBe(answer);
  });
  test("completion write failure exposes unsaved answer; identical retry saves it without regeneration", async () => {
    const r = rig(); let fail = true, calls = 0;
    const run = createTypedTurnPersistence({ ...r.store, finishTypedTurn(...args) { if (fail) throw Error("EIO /private/path"); return r.store.finishTypedTurn(...args); } });
    const execute = async () => { calls++; return { content: answer }; };
    const error = await run(body(), principal, execute).catch((e) => e);
    expect(error).toMatchObject({ code: "typed_save_failed", status: 503, content: answer });
    expect(error.message).not.toContain("/private"); expect(r.saved()!.messages).toHaveLength(1);
    fail = false; expect(await run(body(), principal, execute)).toMatchObject({ content: answer, persistence: { saved: true } });
    expect(calls).toBe(1); expect(r.saved()!.messages).toHaveLength(2);
  });
  test("restart with a pending receipt refuses replay instead of generating twice", async () => {
    const r = rig(); let calls = 0;
    const run = createTypedTurnPersistence({ ...r.store, finishTypedTurn() { throw Error("fail"); } });
    await run(body(), principal, async () => { calls++; return { content: answer }; }).catch(() => undefined);
    await expect(createTypedTurnPersistence(conversationStore(r.root))(body(), principal, async () => { calls++; return { content: answer }; })).rejects.toMatchObject({ code: "typed_outcome_unknown", status: 409 });
    expect(calls).toBe(1);
  });
  test("initial write failure invokes nothing and reports save failure explicitly", async () => {
    const r = rig(); let calls = 0;
    const run = createTypedTurnPersistence({ ...r.store, beginTypedTurn() { throw Error("EACCES /private/path"); } });
    await expect(run(body(), principal, async () => { calls++; return {}; })).rejects.toMatchObject({ code: "typed_save_failed", status: 503 });
    expect(calls).toBe(0); expect(r.store.list()).toEqual([]);
  });
  test("two-stage tool loop caches stages and only adds final reply once", async () => {
    const r = rig(); let calls = 0;
    const tool = { id: "call-1", type: "function", function: { name: "jarvis_command", arguments: '{"utterance":"status"}' } };
    const first = await r.run(body(), principal, async () => { calls++; return { content: null, tool_calls: [tool] }; });
    expect(first.persistence).toMatchObject({ saved: true, complete: false });
    const next = body({ turnIndex: 1, messages: [...body().messages, { role: "assistant", content: null, tool_calls: [tool] }, { role: "tool", tool_call_id: "call-1", content: "ready" }] });
    await r.run(next, principal, async () => { calls++; return { content: answer }; });
    expect(await createTypedTurnPersistence(r.store)(next, principal, async () => { calls++; return {}; })).toMatchObject({ content: answer });
    expect(calls).toBe(2); expect(r.saved()!.messages).toHaveLength(2);
  });
  test("receipts never appear on reads, client snapshots cannot remove or replace receipts or saved words", async () => {
    const r = rig(); await r.run(body(), principal, async () => ({ content: answer }));
    const saved = r.saved()!;
    expect(JSON.stringify(saved)).not.toContain("fingerprint"); expect(JSON.stringify(r.store.list())).not.toContain("typedRequests");
    r.store.save({ ...saved, typedRequests: [], messages: saved.messages.map((m) => ({ ...m, text: "forged" })) }, { personId: "usman", hub: false });
    expect(r.saved()!.messages.map((m) => m.text)).toEqual([words, answer]);
    expect(await createTypedTurnPersistence(r.store)(body(), principal, async () => { throw Error("must not run"); })).toMatchObject({ content: answer });
  });
  test("capacity refuses before running; reply-first legacy fragments are recovered in correct order", async () => {
    const r = rig(); const binding = { personId: "usman", requestId: body().requestId };
    r.store.saveTypedPart(binding, "reply", "assistant", answer);
    r.store.saveTypedPart(binding, "user", "user", words);
    expect(r.saved()!.messages.map((m) => m.role)).toEqual(["user", "oracle"]);
    const id = jarvisThreadId("mehroz");
    r.store.save({ id, messages: Array.from({ length: 499 }, () => ({ role: "user", text: "existing" })) }, { personId: "mehroz", hub: false });
    let calls = 0;
    await expect(r.run(body(), other, async () => { calls++; return { content: answer }; })).rejects.toMatchObject({ code: "typed_conversation_full" });
    expect(calls).toBe(0); expect(r.store.get(id)!.messages).toHaveLength(499);
  });
  test("fresh foreign default ids cannot be claimed; process and unpaired callers cannot persist", async () => {
    const r = rig(); let calls = 0;
    const execute = async () => { calls++; return { content: answer }; };
    await expect(r.run(body({ conversationId: jarvisThreadId("mehroz") }), principal, execute)).rejects.toMatchObject({ status: 403 });
    for (const denied of [{ ...principal, actor: "process" as const }, { ...principal, via: "tailnet-person" as const }])
      await expect(r.run(body(), denied, execute)).rejects.toMatchObject({ code: "typed_identity_required" });
    expect(calls).toBe(0); expect(r.store.list()).toEqual([]);
  });
  test("snapshot cannot invent request keys or duplicate an existing saved part", async () => {
    const r = rig(); const id = jarvisThreadId("usman");
    expect(() => r.store.save({ id, messages: [{ role: "oracle", text: "forged", via: `say:${body().requestId}:reply` }] }, { personId: "usman", hub: false })).toThrow("cannot be created");
    await r.run(body(), principal, async () => ({ content: answer }));
    const saved = r.saved()!;
    r.store.save({ ...saved, messages: [...saved.messages, ...saved.messages] }, { personId: "usman", hub: false });
    expect(r.saved()!.messages).toHaveLength(2);
  });
  test("oversized/deep request rejects before admission; retained failed replies are bounded without evicting uncertainty", async () => {
    const r = rig(); let calls = 0;
    const execute = async () => { calls++; return { content: answer }; };
    await expect(r.run(body({ context: ["x".repeat(128001)] }), principal, execute)).rejects.toMatchObject({ code: "typed_binding_invalid" });
    let context: unknown = "x"; for (let i = 0; i < 15; i++) context = [context];
    await expect(r.run(body({ context }), principal, execute)).rejects.toMatchObject({ code: "typed_binding_invalid" });
    await expect(r.run(body({ messages: Array(61).fill(null) }), principal, execute)).rejects.toMatchObject({ code: "typed_binding_invalid" });
    await expect(r.run(body({ messages: [...body().messages, { role: "assistant", content: null, tool_calls: Array(9).fill(null) }] }), principal, execute)).rejects.toMatchObject({ code: "typed_binding_invalid" });
    expect(calls).toBe(0); expect(r.store.list()).toEqual([]);
    const blocked = createTypedTurnPersistence({ ...r.store, finishTypedTurn() { throw Error("unwritable"); } });
    for (let i = 0; i < 64; i++) await blocked(body({ requestId: `failed-save-${i}` }), principal, execute).catch(() => undefined);
    await expect(blocked(body({ requestId: "failed-save-65" }), principal, execute)).rejects.toMatchObject({ code: "typed_save_busy" });
    expect(calls).toBe(64); expect(r.saved()!.messages).toHaveLength(64);
    await expect(blocked(body({ requestId: "failed-save-0" }), principal, execute)).rejects.toMatchObject({ code: "typed_save_failed", content: answer });
    expect(calls).toBe(64);
  });
  test("legacy scoped bot free turns keep their existing path; opting a bot into founder persistence is refused", async () => {
    const r = rig(); const bot = r.store.ensureThread({ personId: "usman", bot: "research" })!; let calls = 0;
    const execute = async () => { calls++; return { content: "bot reply" }; };
    const scoped = body({ conversationId: bot.id, target: { bot: "research" } });
    await expect(r.run(scoped, principal, execute)).rejects.toMatchObject({ status: 403 });
    const { requestId: _requestId, turnIndex: _index, ...legacy } = scoped;
    expect(await r.run(legacy, principal, execute)).toEqual({ content: "bot reply" });
    expect(calls).toBe(1); expect(r.store.get(bot.id)!.messages).toEqual([]);
    expect(r.store.get(jarvisThreadId("usman"))).toBeNull();
  });
  test("colon-containing request ids are distinct and cannot shadow a shorter id in another owned origin", async () => {
    const r = rig();
    await r.run(body({ requestId: "review-123:child" }), principal, async () => ({ content: answer }));
    const conversationId = "11111111-2222-4333-8444-555555555555";
    await r.run(body({ requestId: "review-123", conversationId }), principal, async () => ({ content: "different" }));
    expect(r.store.get(conversationId)!.messages).toHaveLength(2);
  });
  test("corrupt store remains untouched and has no raw path leak", async () => {
    const r = rig(); r.store.ensureThread({ personId: "usman" });
    const file = join(r.root, ".operator-data", "conversations.json"); writeFileSync(file, "{broken");
    await expect(r.run(body(), principal, async () => ({ content: answer }))).rejects.toMatchObject({ code: "typed_save_failed" });
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });
});

// Portable regression: copied unchanged onto a0da, these assertions reproduce the missing free-turn exchange and unsafe /thread/say success.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { freeVoice } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { createCommandService } from "./service";
import { createJobThreads } from "./threads";
import { commandRoute } from "./route";
const principal: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));
function rig() {
  const root = mkdtempSync(join(tmpdir(), "plain-contract-"));
  const store = conversationStore(root);
  const jobs = new JobService({ path: join(root, "jobs.sqlite"), snapshotMs: 0 });
  const threads = createJobThreads({ conversations: store, jobs: () => jobs });
  const service = createCommandService({ jobs: () => jobs, threads, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "none" }) });
  cleanup.push(() => { threads.stop(); jobs.close(); rmSync(root, { recursive: true, force: true }); });
  const post = async (body: unknown) => {
    let status = 0, value: any;
    await commandRoute({ path: "/screen/command/thread/say", method: "POST", url: new URL("http://localhost/screen/command/thread/say"), body, principal, service, req: {} as never, res: { setHeader() {} } as never, send: (v, s = 200) => { value = v; status = s; } });
    return { status, value };
  };
  return { root, store, post };
}
test("plain free-turn answer persists exact user/reply and survives engine restart without regenerating", async () => {
  const r = rig(); let calls = 0;
  const engine = () => freeVoice(r.root, { key: (n) => n === "GROQ_API_KEY" ? "synthetic" : "", bots: () => [], sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), fetch: (async () => { calls++; return Response.json({ choices: [{ message: { role: "assistant", content: "QA JARVIS 20261005" } }] }); }) as typeof fetch });
  const request = { typed: true, requestId: "plain-contract-20261005", turnIndex: 0, messages: [{ role: "user", content: "Reply with QA JARVIS 20261005 only." }] };
  expect((await (engine().handle as any)("/voice/free/turn", request, undefined, principal)).content).toBe("QA JARVIS 20261005");
  expect(conversationStore(r.root).get(jarvisThreadId("usman"))?.messages.map((m) => m.text)).toEqual([request.messages[0].content, "QA JARVIS 20261005"]);
  await (engine().handle as any)("/voice/free/turn", request, undefined, principal);
  expect(calls).toBe(1);
});
test("thread/say preserves exact private words, refuses changed replay and reloads once", async () => {
  const r = rig(); const b = { requestId: "plain-contract-20261005", part: "reply", role: "assistant", text: " QA JARVIS 20261005 " };
  expect((await r.post(b)).status).toBe(200);
  expect(conversationStore(r.root).get(jarvisThreadId("usman"))!.messages[0].text).toBe(b.text);
  expect((await r.post(b)).status).toBe(200);
  expect((await r.post({ ...b, text: "changed" })).status).toBe(409);
  expect(r.store.get(jarvisThreadId("usman"))!.messages).toHaveLength(1);
});
test("thread/say rejects changed origin and foreign owner rather than silently saving to default", async () => {
  const r = rig(); const conversationId = "11111111-2222-4333-8444-555555555555";
  const b = { requestId: "plain-contract-20261005", part: "user", role: "user", text: "original", conversationId };
  expect((await r.post(b)).value.conversationId).toBe(conversationId);
  expect((await r.post({ ...b, conversationId: jarvisThreadId("usman") })).status).toBe(409);
  r.store.ensureThread({ personId: "mehroz" });
  expect((await r.post({ ...b, requestId: "new-contract-request", conversationId: jarvisThreadId("mehroz") })).status).toBe(403);
});
test("thread/say full conversation is an explicit failure, duplicate saved text remains success", async () => {
  const r = rig(); const id = jarvisThreadId("usman");
  await r.post({ requestId: "plain-contract-20261005", part: "user", role: "user", text: "original" });
  const saved = r.store.get(id)!;
  r.store.save({ ...saved, messages: [...saved.messages, ...Array.from({ length: 499 }, () => ({ role: "user", text: "existing" }))] }, { personId: "usman", hub: false });
  expect((await r.post({ requestId: "plain-contract-20261005", part: "reply", role: "assistant", text: "reply" })).status).toBe(409);
  expect((await r.post({ requestId: "plain-contract-20261005", part: "user", role: "user", text: "original" })).status).toBe(200);
});

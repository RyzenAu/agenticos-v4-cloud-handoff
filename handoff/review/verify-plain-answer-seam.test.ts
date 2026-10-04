/** Run after applying the Claude review patch in an isolated copy; set BACKEND_REVIEW_ROOT and CLIENT_REVIEW_ROOT. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const backend = process.env.BACKEND_REVIEW_ROOT;
const client = process.env.CLIENT_REVIEW_ROOT;
if (!backend || !client) throw new Error("Set BACKEND_REVIEW_ROOT and CLIENT_REVIEW_ROOT to isolated source copies; never point tests at live data.");
const { conversationStore, jarvisThreadId } = await import(join(backend, "scripts/conversations.ts"));
const { JobService } = await import(join(backend, "scripts/jobs/service.ts"));
const { freeVoice } = await import(join(backend, "scripts/free-voice.ts"));
const { MemoryHealthStore } = await import(join(backend, "scripts/model-router/health.ts"));
const { MemoryReceiptSink } = await import(join(backend, "scripts/model-router/receipts.ts"));
const { createCommandService } = await import(join(backend, "scripts/jarvis-command/service.ts"));
const { createJobThreads } = await import(join(backend, "scripts/jarvis-command/threads.ts"));
const { commandRoute } = await import(join(backend, "scripts/jarvis-command/route.ts"));
const { captureTypedRequest, runPersistedTypedRequest, runPersistedTypedTurn } = await import(join(client, "src/lib/typed-persistence.ts"));
const words = "Reply with QA JARVIS 20261005 only.";
const reply = "QA JARVIS 20261005";
const principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function rig() {
  const root = mkdtempSync(join(tmpdir(), "plain-seam-"));
  const store = conversationStore(root);
  const jobs = new JobService({ path: join(root, "jobs.sqlite"), snapshotMs: 0 });
  const threads = createJobThreads({ conversations: store, jobs: () => jobs });
  const service = createCommandService({ jobs: () => jobs, threads, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "synthetic" }) });
  let calls = 0;
  const engine = () => freeVoice(root, { key: (name: string) => name === "GROQ_API_KEY" ? "synthetic" : "", bots: () => [], sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), fetch: (async () => {
    calls++; return Response.json({ choices: [{ message: { role: "assistant", content: reply } }] });
  }) as typeof fetch });
  let voice = engine();
  const post = async (path: string, body: unknown): Promise<Response> => {
    if (path === "/voice/free/turn") {
      try { return Response.json(await voice.handle(path, body, undefined, principal)); }
      catch (error: any) { return Response.json({ error: error.message, code: error.code, saved: false, ...(error.content ? { content: error.content } : {}) }, { status: error.status ?? 500 }); }
    }
    let status = 500, value: unknown;
    await commandRoute({ path, method: "POST", url: new URL(`http://localhost${path}`), body, principal, service, req: {} as never, res: { setHeader() {} } as never, send: (v: unknown, s = 200) => { value = v; status = s; } });
    return Response.json(value, { status });
  };
  cleanups.push(() => { threads.stop(); jobs.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, post, calls: () => calls, restart: () => { voice = engine(); } };
}
const run = (state: any, post: any) => {
  const signal = new AbortController().signal;
  return runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, post, signal, async () => { throw new Error("The plain reply must create no tools."); }, []), post, signal);
};
test("actual client + real backend: exact QA request and reply reload once, without jobs", async () => {
  const r = rig(); const state = captureTypedRequest("paired-qa-20261005", words, {});
  expect(await run(state, r.post)).toBe(reply);
  expect(state.saved).toBe(true);
  const saved = conversationStore(r.root).get(jarvisThreadId("usman"));
  expect(saved.messages.map((m: any) => m.text)).toEqual([words, reply]);
  expect(saved.jobs).toEqual([]);
  r.restart(); const same = captureTypedRequest("paired-qa-20261005", words, {});
  expect(await run(same, r.post)).toBe(reply);
  expect(r.calls()).toBe(1);
  expect(r.store.get(jarvisThreadId("usman")).messages).toHaveLength(2);
});
test("failed initial user append preserves state and blocks generation until same-ID retry", async () => {
  const r = rig(); const state = captureTypedRequest("paired-fail-20261005", words, {}); let fail = true;
  const post = (path: string, body: any) => fail && path.endsWith("/thread/say") ? Promise.resolve(Response.json({ code: "typed_save_failed", error: "Synthetic save failure" }, { status: 503 })) : r.post(path, body);
  await expect(run(state, post)).rejects.toThrow("not confirmed saved");
  expect(state.text).toBe(words); expect(state.requestId).toBe("paired-fail-20261005"); expect(r.calls()).toBe(0);
  fail = false; expect(await run(state, post)).toBe(reply); expect(r.calls()).toBe(1);
});
test("lost final response plus rebuilt engine replays the durable answer without regeneration", async () => {
  const r = rig(); const state = captureTypedRequest("paired-lost-20261005", words, {}); let lose = true;
  const post = async (path: string, body: any) => { const response = await r.post(path, body); if (lose && path === "/voice/free/turn") { lose = false; r.restart(); throw new Error("Synthetic dropped response"); } return response; };
  await expect(run(state, post)).rejects.toThrow("not confirmed saved");
  expect(await run(state, post)).toBe(reply); expect(r.calls()).toBe(1);
  expect(conversationStore(r.root).get(jarvisThreadId("usman")).messages.map((m: any) => m.text)).toEqual([words, reply]);
});

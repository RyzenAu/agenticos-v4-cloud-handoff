// 5 Oct production QA of PR #7 (98a3d090): "Reply with QA JARVIS PR7B only." typed on /jarvis by a remote founder went to the command
// controller ("Jev isn't answering", then "where should it run?") instead of the brain, and only the request reached the conversation.
// Real free-voice engine, real conversation store, real /screen/command/thread/say route and the real client persistence helpers;
// synthetic model, synthetic keys, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Principal } from "../identity/principal";
import { conversationStore, jarvisThreadId } from "../conversations";
import { freeVoice, plainReplyRequest } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { JobService } from "../jobs/service";
import { createJobThreads } from "./threads";
import { createCommandService } from "./service";
import { commandRoute } from "./route";
import { captureTypedRequest, runPersistedTypedRequest, runPersistedTypedTurn, TypedPersistenceFailure } from "../../src/lib/typed-persistence";

const founder: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const WORDS = "Reply with QA JARVIS PR7B only.";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((c) => c()));

/** `model(n)` answers the n-th brain call; Jev's key is set, so an unguarded remote turn would go to the command controller. */
function rig(model: (n: number) => Record<string, unknown> = () => ({ role: "assistant", content: "QA JARVIS PR7B" })) {
  const root = mkdtempSync(join(tmpdir(), "typed-every-"));
  const store = conversationStore(root);
  const jobs = new JobService({ path: join(root, "jobs.sqlite"), snapshotMs: 0 });
  const threads = createJobThreads({ conversations: store, jobs: () => jobs });
  const service = createCommandService({ jobs: () => jobs, threads, entry: () => null, hubDeviceId: "", resolveTarget: () => ({ ok: false, reason: "none" }) });
  cleanups.push(() => { threads.stop(); jobs.close(); Bun.gc(true); try { rmSync(root, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ } });
  let brainCalls = 0;
  const engine = freeVoice(root, {
    key: (k) => (k === "GROQ_API_KEY" || k === "TYPESAFE_API_KEY" ? "synthetic" : ""), bots: () => [],
    fetch: (async (url: string) => {
      if (!String(url).includes("/chat/completions")) throw new Error(`unexpected network: ${url}`);
      return Response.json({ choices: [{ message: model(++brainCalls) }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch,
    sink: new MemoryReceiptSink(), health: new MemoryHealthStore(), hub: () => ({ name: "fixture", role: "server" }), companions: () => [],
  });
  const posts: string[] = [];
  /** The hub as the browser sees it: the host sets `remote` (a founder not at the hub) on every free turn. */
  const post = async (path: string, body: any): Promise<Response> => {
    posts.push(path === "/voice/free/turn" ? `turn:${body.turnIndex}` : `say:${body.part}`);
    if (path === "/voice/free/turn") {
      try { return Response.json(await engine.handle(path, { ...JSON.parse(JSON.stringify(body)), remote: true }, undefined, founder)); }
      catch (e: any) { return Response.json({ error: e.message, code: e.code, saved: false, ...(e.content !== undefined ? { content: e.content } : {}) }, { status: e.status ?? 500 }); }
    }
    let status = 0, value: unknown;
    await commandRoute({ path, method: "POST", url: new URL(`http://localhost${path}`), body, principal: founder, service, req: {} as never, res: { setHeader() {} } as never, send: (v, s = 200) => { value = v; status = s; } });
    return Response.json(value, { status });
  };
  const saved = () => (conversationStore(root).get(jarvisThreadId("usman"))?.messages ?? []).map((m) => [m.role, m.text]);
  return { post, posts, saved, brainCalls: () => brainCalls };
}

/** The companion's durable typed lane: save the request, run the free turn (tools via `tool`), save the reply unless the turn did. */
function send(r: ReturnType<typeof rig>, requestId: string, tool: (name: string) => Promise<string>) {
  const state = captureTypedRequest(requestId, WORDS, {});
  const signal = new AbortController().signal;
  const run = () => runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, r.post, signal, (call) => tool(call.function.name), []), r.post, signal);
  return { state, run };
}
const commandLine = (said: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "command_result", ok: false, said, kind: "ask", ...extra });

describe("a plain reply request is the brain's answer, also for a remote founder with Jev on", () => {
  test("the exact QA request is answered by the brain, saved once after the request, with no command tool", async () => {
    const r = rig();
    const tools: string[] = [];
    const { run } = send(r, "jr-pr7b-plain-01", async (name) => { tools.push(name); return commandLine("must not run"); });
    expect(await run()).toBe("QA JARVIS PR7B");
    expect(tools).toEqual([]);
    expect(r.saved()).toEqual([["user", WORDS], ["oracle", "QA JARVIS PR7B"]]);
    expect(r.posts).toEqual(["say:user", "turn:0"]);
  });

  test("only words addressed to Jarvis count; anything sent somewhere or acting on something keeps its route", () => {
    for (const w of ["Reply with QA JARVIS PR7B only.", "reply with QA JARVIS 20261005 only", "Jarvis, respond with OK only.", "please answer with yes only", "say exactly: done"])
      expect([w, plainReplyRequest(w)]).toEqual([w, true]);
    for (const w of ["reply with yes to the email only", "reply with thanks on WhatsApp only", "respond with OK in Slack only", "reply to Mehroz", "open notepad", "reply with the invoice", "say hello to Mehroz", "what's the time?"])
      expect([w, plainReplyRequest(w)]).toEqual([w, false]);
  });
});

describe("every reply is saved exactly once after its request", () => {
  for (const [name, said, extra] of [
    ["clarifying ask", "I'm not sure how you want that done, so nothing ran. Should it be on Usman's PC or an answer from me?", { kind: "ask", ask: true }],
    ["Jev unavailable", "Jev, my decision layer, isn't answering right now, so I won't guess where that should go, and nothing ran.", { kind: "unavailable" }],
    ["refusal", "That one needs a signed-in founder, so nothing ran.", { kind: "refused", refused: true }],
  ] as const) {
    test(`a command ${name} reached through a tool is the saved reply`, async () => {
      // The brain reaches for jarvis_command on purpose (not a plain-reply request); the command's own line ends the turn.
      const r = rig((n) => (n === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "jarvis_command", arguments: "{\"utterance\":\"x\"}" } }] } : { role: "assistant", content: "unused" }));
      const state = captureTypedRequest(`jr-pr7b-${name.replace(/\W+/g, "-")}`, "Organise my afternoon.", {});
      const signal = new AbortController().signal;
      const reply = await runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, r.post, signal, async () => commandLine(said, extra), []), r.post, signal);
      expect(reply).toBe(said);
      expect(r.saved()).toEqual([["user", "Organise my afternoon."], ["oracle", said]]);
      expect(r.posts.filter((p) => p === "say:reply")).toEqual([]); // the free turn saved it; the client never appends it twice
    });
  }

  test("a turn that cannot finish after a command ran saves the command's line and why, once; a retry adds nothing", async () => {
    const r = rig((n) => (n === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "jarvis_command", arguments: "{}" } }] } : { role: "assistant", content: "unused" }));
    const said = "Jev, my decision layer, isn't answering right now, so nothing ran.";
    // The second stage loses its save acknowledgement (a final, non-retryable failure: the outcome is uncertain, nothing may rerun).
    const post = async (path: string, body: any) => {
      const res = await r.post(path, body);
      if (path === "/voice/free/turn" && body.turnIndex === 1) { const v = await res.json(); delete v.persistence; return Response.json(v); }
      return res;
    };
    const state = captureTypedRequest("jr-pr7b-final-01", "Organise my afternoon.", {});
    const signal = new AbortController().signal;
    const run = () => runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, post, signal, async () => commandLine(said), []), post, signal);
    const first = await run().catch((e) => e);
    expect(first).toBeInstanceOf(TypedPersistenceFailure);
    const messages = r.saved();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(["user", "Organise my afternoon."]);
    expect(messages[1][1]).toStartWith(said);
    expect(await run().catch((e) => e)).toBe(first); // blocked: never run or saved again
    expect(r.saved()).toEqual(messages);
  });

  test("a failed request save runs nothing and saves no reply", async () => {
    const r = rig();
    const post = async (path: string, body: any) => (path === "/screen/command/thread/say" ? new Response("{}", { status: 503 }) : r.post(path, body));
    const state = captureTypedRequest("jr-pr7b-nosave-01", WORDS, {});
    const signal = new AbortController().signal;
    expect(await runPersistedTypedRequest(state, () => runPersistedTypedTurn(state, post, signal, async () => "", []), post, signal).catch((e) => e)).toBeInstanceOf(TypedPersistenceFailure);
    expect(r.brainCalls()).toBe(0);
    expect(r.saved()).toEqual([]);
  });
});

// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import { agentConversationId, botCommandOptions, loadLocalItems, loadSeen, parseThread, saveLocalItems, saveSeen, THREAD_PATH } from "./agent-chat";
import { runJarvisCommand, type CommandPost } from "./jarvis-command";
import { getVoiceScope, onVoiceScope, setVoiceScope, voiceScopeCommandOptions } from "./voice-scope";

const DONE = { type: "done", ok: true, said: "On it.", kind: "handoff", jobId: "job-1", runId: "r1", targetDeviceId: "hub", verified: null };
/** A command post that records the request body and answers with a done line. */
const recorder = () => {
  const bodies: Array<Record<string, unknown>> = [];
  const post: CommandPost = async (_path, body) => {
    bodies.push(body as Record<string, unknown>);
    return new Response(`${JSON.stringify(DONE)}\n`, { headers: { "content-type": "application/x-ndjson" } });
  };
  return { bodies, post };
};

afterEach(() => setVoiceScope(null));

describe("a bot command carries its conversation and its bot", () => {
  const input = { botId: "research", conversationId: "agent:p1:research", utterance: "Find dentists", source: "typed" as const, eventId: "bot-evt-0001" };

  test("typed: the request body has the bot's conversation id, target { bot } and the event id", async () => {
    const { bodies, post } = recorder();
    const done = await runJarvisCommand(botCommandOptions(input, { post, pageContext: null }));
    expect(done).toMatchObject({ ok: true, jobId: "job-1" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ utterance: "Find dentists", source: "typed", conversationId: "agent:p1:research", target: { bot: "research" }, eventId: "bot-evt-0001" });
  });

  test("spoken: the voice tool path adds the scope's conversation id and bot; with no scope the request is exactly as before", async () => {
    const scoped = recorder();
    setVoiceScope({ conversationId: "agent:p1:builder", bot: "builder", label: "Builder" });
    await runJarvisCommand({ utterance: "Fix the footer", source: "voice", pageContext: null, post: scoped.post, ...voiceScopeCommandOptions() });
    expect(scoped.bodies[0]).toMatchObject({ source: "voice", conversationId: "agent:p1:builder", target: { bot: "builder" } });

    setVoiceScope(null);
    const plain = recorder();
    await runJarvisCommand({ utterance: "What time is it", source: "voice", pageContext: null, post: plain.post, ...voiceScopeCommandOptions() });
    expect(plain.bodies[0]).not.toHaveProperty("conversationId");
    expect(plain.bodies[0]).not.toHaveProperty("target");
  });

  test("a bot id that is not a plain slug is never sent as a target", async () => {
    const { bodies, post } = recorder();
    await runJarvisCommand(botCommandOptions({ ...input, botId: "../admin" }, { post, pageContext: null }));
    expect(bodies[0]).not.toHaveProperty("target");
  });

  test("the conversation id is deterministic per person and bot, and the thread read is per bot", () => {
    expect(agentConversationId("p1", "research")).toBe("agent:p1:research");
    expect(THREAD_PATH("research", 7)).toBe("/__agents/bots/research/thread?after=7");
    expect(THREAD_PATH("a b", -3)).toBe("/__agents/bots/a%20b/thread?after=0");
  });
});

describe("voice scope", () => {
  test("setting, clearing and listening; the same scope twice notifies once", () => {
    const seen: Array<string | null> = [];
    const off = onVoiceScope((s) => seen.push(s?.bot ?? null));
    const scope = { conversationId: "agent:p1:research", bot: "research", label: "Research" };
    setVoiceScope(scope);
    setVoiceScope({ ...scope });
    expect(getVoiceScope()?.bot).toBe("research");
    setVoiceScope(null);
    off();
    expect(seen).toEqual(["research", null]);
  });
});

describe("reading the thread", () => {
  test("a well-formed response is parsed; malformed entries are dropped, never thrown", () => {
    const t = parseThread({ conversationId: "c", entries: [{ seq: 1, key: "k", at: "2026-10-02T00:00:00Z", jobId: "j", state: "started", text: "hi", jobKind: "coding" }, { nope: true }, null] });
    expect(t?.entries).toHaveLength(1);
    expect(t?.entries[0]).toMatchObject({ key: "k", jobKind: "coding" });
    expect(parseThread({ entries: [] })).toBeNull();
    expect(parseThread(null)).toBeNull();
  });
});

describe("local persistence never breaks the chat", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  test("round trip, per conversation", () => {
    const store = memory();
    saveLocalItems("c1", [{ type: "request", key: "a", at: 1, text: "x" }], store);
    expect(loadLocalItems("c1", store)).toHaveLength(1);
    expect(loadLocalItems("c2", store)).toEqual([]);
    saveSeen("c1", new Set(["j:done"]), store);
    expect([...loadSeen("c1", store)]).toEqual(["j:done"]);
  });
  test("a store that throws (private window) or holds junk gives an empty thread, not an error", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadLocalItems("c", broken)).toEqual([]);
    expect(() => saveLocalItems("c", [], broken)).not.toThrow();
    expect(loadLocalItems("c", { getItem: () => "{not json", setItem() {} })).toEqual([]);
    expect(loadSeen("c", null).size).toBe(0);
  });
});

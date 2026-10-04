// Bot-scoped Jarvis through the ONE command path: typed and spoken requests for a bot land in that person's conversation with that bot; progress, the
// result and the one completion arrive there exactly once (and not again after a restart); "Stop that task" and "Show me its computer" resolve to the
// right bot or ask; nothing is ever sent to a different machine; a Builder coding job names its account, and is refused (never swapped) when that
// account isn't ready. Real job service, conversation store, thread watcher and command service over SYNTHETIC computers, coding and voice.
import { afterEach, describe, expect, test } from "bun:test";
import { botThreadId, jarvisThreadId } from "../conversations";
import { makeRig, mehroz, usman, type Rig } from "./test-rig";
import type { Principal } from "../identity/principal";
import { subjectsFrom, botFromPage } from "./jarvis";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});
const rig = async (o: Parameters<typeof makeRig>[0] = {}) => {
  const r = await makeRig(o);
  rigs.push(r);
  return r;
};

const research = (p = "usman") => botThreadId(p, "research");
const builder = (p = "usman") => botThreadId(p, "builder");

describe("scope: which bot a turn is for, and where it lands", () => {
  const scope = (r: Rig, utterance: string, body: Record<string, unknown> = {}, p: Principal = usman) => r.botCommands.scope({ principal: p, utterance, body: body as never });

  test("the words name the bot: 'Ask Research to ...', 'Have Builder ...', 'Get the research bot to ...'; the words win over where it was typed", async () => {
    const r = await rig();
    expect(scope(r, "Ask Research to find the licence classes for builders")).toMatchObject({ kind: "bot", bot: { id: "research", name: "Research" }, conversationId: research(), utterance: "find the licence classes for builders", via: "words" });
    expect(scope(r, "Have Builder fix this on Claude Max 2")).toMatchObject({ kind: "bot", bot: { id: "builder" }, utterance: "fix this on Claude Max 2" });
    expect(scope(r, "Hey Jarvis, get the research bot to compare three dental software vendors")).toMatchObject({ bot: { id: "research" }, utterance: "compare three dental software vendors" });
    // typed in Builder's conversation but naming Research: Research's conversation
    expect(scope(r, "ask research to look up hours", { conversationId: builder() })).toMatchObject({ bot: { id: "research" }, conversationId: research(), via: "words" });
  });

  test("a plain request in the default thread is nobody's: it stays where it is", async () => {
    const r = await rig();
    expect(scope(r, "find the licence classes for builders")).toBeNull();
    expect(scope(r, "open notepad", { conversationId: jarvisThreadId("usman") })).toBeNull();
    expect(scope(r, "what's the weather")).toBeNull();
  });

  test("the request's own target and the bot conversation it was typed in are the bot (a UUID or the agent:<person>:<bot> key); someone else's key is ignored", async () => {
    const r = await rig();
    expect(scope(r, "find clinics", { target: { bot: "research" } })).toMatchObject({ bot: { id: "research" }, via: "target", conversationId: research() });
    expect(scope(r, "find clinics", { conversationId: research() })).toMatchObject({ bot: { id: "research" }, via: "thread" });
    expect(scope(r, "find clinics", { conversationId: "agent:usman:research" })).toMatchObject({ bot: { id: "research" }, conversationId: research() });
    // Mehroz presenting Usman's key gets nothing of Usman's: not a bot turn at all.
    expect(scope(r, "find clinics", { conversationId: "agent:usman:research" }, mehroz)).toBeNull();
    // Mehroz's own conversation id for the same bot is HIS thread.
    expect(scope(r, "find clinics", { conversationId: research("mehroz") }, mehroz)).toMatchObject({ conversationId: research("mehroz") });
    expect(scope(r, "find clinics", { conversationId: research("mehroz") }, usman)).toBeNull();
  });

  test("an unknown bot is refused by name, with the bots there are", async () => {
    const r = await rig();
    const s = scope(r, "do it", { target: { bot: "ghost" } });
    expect(s).toMatchObject({ kind: "refuse" });
    expect((s as { said: string }).said).toContain('"ghost"');
    expect((s as { said: string }).said).toContain("Research, Builder");
  });

  test("a request for the person's OWN device typed in a bot conversation is not the bot's: it stays in the default thread", async () => {
    const r = await rig();
    expect(scope(r, "open notepad on my laptop", { conversationId: research() })).toEqual({ kind: "default", conversationId: jarvisThreadId("usman") });
    expect(scope(r, "send this to my phone", { target: { bot: "research" } })).toMatchObject({ kind: "default" });
  });

  test("pointing words: the open page's bot; 'show me its computer' with two bots and no page is ONE question; a plain request never takes the page's bot", async () => {
    const r = await rig();
    const page = (path: string) => ({ pageContext: { page: path } });
    expect(scope(r, "show me its computer", page("/agents/workspace/builder"))).toMatchObject({ bot: { id: "builder" }, via: "page", utterance: "show me its computer" });
    expect(scope(r, "continue that task", { pageContext: { page: "/agents/research", focused: { kind: "bot", id: "research", label: "Research" } } })).toMatchObject({ bot: { id: "research" }, utterance: "continue that task" });
    const asked = scope(r, "show me its computer");
    expect(asked).toMatchObject({ kind: "ask" });
    expect((asked as { said: string }).said).toContain("Research's or Builder's");
    expect(scope(r, "what's the weather", page("/agents/workspace/builder"))).toBeNull();
    // "continue that task" with no open bot is the computers' own request, not a bot's.
    expect(scope(r, "continue that task")).toBeNull();
  });

  test("'Show me Research's computer', 'Continue the research', 'Stop the Research task' name the bot and become the canonical request", async () => {
    const r = await rig();
    expect(scope(r, "Show me Research's computer")).toMatchObject({ bot: { id: "research" }, utterance: "show me its computer" });
    expect(scope(r, "what's Builder doing")).toMatchObject({ bot: { id: "builder" }, utterance: "show me its computer" });
    expect(scope(r, "Continue the research")).toMatchObject({ bot: { id: "research" }, utterance: "continue that task" });
    expect(scope(r, "stop the Research task")).toMatchObject({ bot: { id: "research" }, utterance: "stop that task" });
  });

  test("CRM subjects come from the request and the page context, well-formed only", () => {
    expect(subjectsFrom({ page: "/crm", crm: { kind: "deal", id: "42" } } as never, ["crm:company:7", "nonsense"])).toEqual(["crm:company:7", "crm:deal:42"]);
    expect(subjectsFrom({ page: "/x", focused: { kind: "lead", id: "9", label: "L" }, selected: [{ kind: "invoice", id: "1", label: "I" }] } as never)).toEqual(["crm:lead:9"]);
    expect(subjectsFrom(null)).toEqual([]);
    expect(botFromPage({ page: "/agents/workspace/builder?tab=tasks" } as never, r0bots())).toBe("builder");
    expect(botFromPage({ page: "/agents/workspace/ghost" } as never, r0bots())).toBeNull();
  });
});
const r0bots = () => [{ id: "research" }, { id: "builder" }] as never;

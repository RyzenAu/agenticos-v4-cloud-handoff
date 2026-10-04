// Round 9 (E): the owner's broken voice session, re-run as a script through the REAL voice rules (freeVoice /voice/free/turn), the voice client's
// jarvis_command dispatch (Track 1's resolver unless the rules marked a bot request), the REAL command service with the REAL agents wiring
// (bot scope, the Builder on its own computer, the job threads), and the follow-up turn that speaks the result.
// The hub is a synthetic SERVER-role hub: no hub device, and the owner (Usman, a confirmed remote browser) has no companion paired.
// Fakes: Jev and the brain over a fake fetch (Jev unsure except "device" words, which it reads as "look at the screen" as it did live; the brain
// only says it was reached), synthetic shared computers (scripts/agents/test-rig.ts). No real device, account, model or network.
// The utterances are minimal paraphrases of the owner's words; nothing else from the session is recorded.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { MemoryHealthStore } from "../model-router/health";
import { MemoryReceiptSink } from "../model-router/receipts";
import { resolveTarget } from "../devices/route";
import { staticRegistry } from "../devices/registry";
import type { Principal } from "../identity/principal";
import { commandResultText, voiceRouteFor } from "../../src/lib/jarvis-command";
import { createCommandService } from "./service";
import type { CommandDoneEvent } from "./contracts";
import { makeRig, type Rig } from "../agents/test-rig";

const rigs: Rig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Usman in his own confirmed browser on his main PC: a remote client of the server hub (never "at the PC"). */
const owner: Principal = { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" };
const ownerCaller = { id: "usman", name: "Usman", via: "tailnet", actor: "human" };

type Msg = { role: "user"; content: string } | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } | { role: "tool"; tool_call_id: string; content: string };

async function ownerSession() {
  const rig = await makeRig({ role: "server" });
  rigs.push(rig);
  const bots = rig.botCommands;
  const service = createCommandService({
    jobs: () => rig.jobs,
    entry: () => null,
    hubDeviceId: "",
    role: () => "server",
    // The server hub is nobody's device, and Usman has no companion: exactly the live registry.
    resolveTarget: (ctx) => resolveTarget(ctx, staticRegistry([])),
    delegates: { coding: rig.sharedCoding as never },
    bots: { scope: bots.scope, nameOf: bots.nameOf, threadIds: bots.threadIds, run: bots.run },
    graceMs: 50,
    dedupeMs: 0,
    threads: rig.threads,
    deviceLabel: (id) => id,
  } as never);
  const root = mkdtempSync(join(tmpdir(), "r9-owner-voice-"));
  dirs.push(root);
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("typesafe")) {
      const said = String(body?.state?.utterance ?? "");
      // Live, Jev read "what device is this?" as "look at the screen"; everything else here it is unsure about.
      if (/\bdevice\b/i.test(said)) return Response.json({ answers: { category: { choice: "screen", confidence: 0.95 }, outbound: { noul: 0.01 }, complete: { noul: 0.95 } } });
      return Response.json({ answers: { category: { choice: "brain", confidence: 0.2 }, outbound: { noul: 0.01 }, complete: { noul: 0.9 } } });
    }
    if (url.includes("/chat/completions")) return Response.json({ choices: [{ message: { role: "assistant", content: "[brain reached: a model would improvise here]" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const voice = freeVoice(root, {
    key: (name) => ({ GROQ_API_KEY: "synthetic-groq", TYPESAFE_API_KEY: "synthetic-jev" } as Record<string, string>)[name] ?? "",
    fetch: fakeFetch,
    sink: new MemoryReceiptSink(),
    health: new MemoryHealthStore(),
    bots: () => rig.agents.store.list().filter((b) => !b.archived).map((b) => ({ id: b.id, name: b.name })),
    hub: () => ({ name: "Ryzen-PC", role: "server" as const }),
    companions: () => [],
  } as never);

  const history: Msg[] = [];
  const log: Array<{ said: string; reply: string; lane: string }> = [];
  /** One spoken turn, end to end, as the voice client runs it (voice-companion.tsx jarvisCommand). */
  async function say(words: string, opts: { device?: string } = {}) {
    history.push({ role: "user", content: words });
    const turn = { remote: true, ...(opts.device ? { device: opts.device } : {}) };
    const first = (await voice.handle("/voice/free/turn", { messages: history, ...turn }, ownerCaller)) as { content: string | null; tool_calls?: Msg extends never ? never : Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; model?: string };
    const call = first.tool_calls?.[0];
    if (!call) {
      const reply = first.content ?? "";
      history.push({ role: "assistant", content: reply });
      log.push({ said: words, reply, lane: first.model ?? "?" });
      return { reply, lane: first.model ?? "?", done: null as CommandDoneEvent | null, tool: null as string | null };
    }
    history.push({ role: "assistant", content: null, tool_calls: first.tool_calls });
    let content: string;
    let done: CommandDoneEvent | null = null;
    if (call.function.name === "jarvis_command") {
      const args = JSON.parse(call.function.arguments) as { utterance: string; bot?: boolean };
      const route = args.bot === true ? { route: "server" as const } : voiceRouteFor(args.utterance, null);
      if (route.route !== "server") {
        content = JSON.stringify({ type: "command_result", ok: true, said: `[client opened ${route.route}]`, kind: "navigate" });
      } else {
        done = await service.run({ principal: owner, body: { utterance: args.utterance, source: "voice" } as never });
        content = commandResultText(done);
      }
    } else {
      // Any other client tool: recorded, not run (the line says which tool the rules chose).
      content = `[client tool ${call.function.name} ${call.function.arguments.slice(0, 80)}]`;
    }
    history.push({ role: "tool", tool_call_id: call.id, content });
    const second = (await voice.handle("/voice/free/turn", { messages: history, ...turn }, ownerCaller)) as { content: string | null; model?: string };
    const reply = second.content ?? content;
    history.push({ role: "assistant", content: reply });
    log.push({ said: words, reply, lane: `${call.function.name}${done ? ` → ${done.kind}` : ""}` });
    return { reply, lane: call.function.name, done, tool: call.function.name };
  }
  return { rig, service, voice, say, log, history };
}

describe("round 9: the owner's session on a server hub, re-run (E)", () => {
  test("every step routes to the Builder, answers from facts, and never says 'no device registered for usman'", async () => {
    const s = await ownerSession();
    // 1. "Can you run a builder for me … open Chrome on it?" → a Builder task on the Builder's own computer, no confirmation, no PC control.
    const one = await s.say("Can you run a builder for me and open Chrome on it?");
    expect(one.tool).toBe("jarvis_command");
    expect(one.done?.ok).toBe(true);
    expect(s.rig.started.at(-1)).toMatchObject({ computer: "builder", bot: "builder" });
    expect(one.reply).toMatch(/^Builder started: open Chrome\b/);
    // 2. "I want to use the builder agent" → not a no; where the Builder stands and what to say next.
    const two = await s.say("I want to use the builder agent");
    expect(two.reply).not.toMatch(/I've left it|Nothing was done\.$/);
    expect(two.reply).toMatch(/Builder/);
    // 3. "So I want you to use the Builder Agent" → the Builder again, in other words, never "no registered device" and never the repeat guard.
    const three = await s.say("So I want you to use the Builder Agent");
    expect(three.reply).toMatch(/Builder/);
    expect(three.reply).not.toMatch(/registered device|no device registered/i);
    expect(three.reply).not.toMatch(/done that again|same answer again/);
    expect(three.reply).not.toBe(two.reply);
    // 4. "Tell it to start a crowd" (mis-heard "start Chrome") → asked in plain words, nothing started, no yes/no question.
    const startedBefore = s.rig.started.length;
    // (the Builder's first task has ended, so the computer is free again)
    await new Promise((r) => setTimeout(r, 50));
    const four = await s.say("Tell it to start a crowd");
    expect(four.reply).toMatch(/did you mean "open Chrome"\?/);
    expect(four.reply).not.toMatch(/say yes|yes or no/i);
    expect(s.rig.started.length).toBe(startedBefore);
    // 5. "Chrome, Chrome, Chrome tab" → the Builder opens a Chrome tab (its answer to "What should Builder do?").
    const five = await s.say("Chrome, Chrome, Chrome tab");
    expect(five.reply).toMatch(/^Builder started: open Chrome tab\b/);
    expect(five.reply).not.toMatch(/won't give you the same answer/);
    // 6. "In my agents section, I want you to have the builder open a Chrome tab" → the Builder, not "only works at the PC itself".
    await new Promise((r) => setTimeout(r, 50));
    const six = await s.say("In my agents section, I want you to have the builder open a Chrome tab");
    expect(six.reply).toMatch(/^Builder started: open a Chrome tab\b/);
    // 7. "I am at the PC" → the facts: his PC is a client of the hub on Ryzen-PC, with no companion yet.
    const seven = await s.say("I am at the PC");
    expect(seven.reply).toMatch(/Ryzen-PC/);
    expect(seven.reply).toMatch(/no companion/);
    // 8. "What device is this?" → answered directly, never the screen-sharing line.
    const eight = await s.say("What device is this?", { device: "Usman's desktop app" });
    expect(eight.reply).toMatch(/^You're on "Usman's desktop app", a client of the hub: Agentic OS runs on Ryzen-PC/);
    expect(eight.reply).not.toMatch(/Screen sharing/);
    // 9. "Where is the agentic OS running?" → the hub, from facts (never "the cloud").
    const nine = await s.say("Where is the agentic OS running?");
    expect(nine.reply).toMatch(/^Agentic OS runs on Ryzen-PC, the always-on server/);
    expect(nine.reply).not.toMatch(/cloud/i);
    // 10. "So why can't you launch the Builder?" → where the Builder stands.
    await new Promise((r) => setTimeout(r, 50));
    const ten = await s.say("So why can't you launch the Builder?");
    expect(ten.reply).toMatch(/^Builder is ready on its own computer/);
    // 11. "Can you have a Chrome tab on my PC?" → his own PC (no companion): one plain line with the setup step and the bot alternative.
    const eleven = await s.say("Can you open a Chrome tab on my PC?");
    expect(eleven.reply).toMatch(/no companion paired/);
    expect(eleven.reply).toMatch(/Code for a companion/);
    expect(eleven.reply).not.toMatch(/no device registered for usman|none of your devices is called/);
    // 12. "to this device here" → the same missing companion, said shorter, never verbatim again.
    const twelve = await s.say("Open Notepad on this PC");
    expect(twelve.reply).toMatch(/^Still no companion on your PC/);
    expect(twelve.reply).not.toBe(eleven.reply);

    // The replies, for the report (no transcript is stored anywhere else).
    for (const [i, l] of s.log.entries()) console.log(`${String(i + 1).padStart(2)}. "${l.said}"\n    [${l.lane}] ${l.reply}`);
    // Nothing ever went to the speaker's own PC or the hub: every job that started is the Builder's, on its own computer.
    expect(s.rig.started.every((j) => j.computer === "builder" && j.bot === "builder")).toBe(true);
  }, 30_000);
});

// J-fix regression (owner's live voice session, 29 Sep ~04:50). The exact transcript, turn by turn, through the
// real voice turn (/voice/free/turn) with a fake brain that always reaches for the `screen` (share/vision) tool,
// which is what it did live. Every turn must be routed by rules to the window skill instead, the correction
// must be acknowledged, and no reply may be given three times. SYNTHETIC: no model, no real windows.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice, guardToolCall, isCorrection, protocolFollowUp, repeatGuard } from "./free-voice";
import { forgetReferent, rememberReferent } from "./jarvis-skills/referent";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const SHARE_OFF = "Screen sharing is off, sir. Press Share screen at the top and choose what I should see.";

/** The worst case: a brain that always answers with the share/vision tool, or with a fixed line. */
function voice(brain: { tool?: string; content?: string } = { tool: "screen" }) {
  const dir = mkdtempSync(join(tmpdir(), "jfix-voice-"));
  dirs.push(dir);
  const calls: string[] = [];
  const v = freeVoice(dir, {
    key: (name: string) => ({ GROQ_API_KEY: "synthetic", TYPESAFE_API_KEY: "synthetic" } as Record<string, string>)[name] ?? "",
    fetch: (async (url: string) => {
      calls.push(String(url));
      const message = brain.tool
        ? { content: null, tool_calls: [{ id: "b1", type: "function", function: { name: brain.tool, arguments: JSON.stringify({ question: "what's on my screen" }) } }] }
        : { content: brain.content ?? "Fine." };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  return { v, calls };
}
type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
const call = (r: any) => r?.tool_calls?.[0]?.function as { name: string; arguments: string } | undefined;
const args = (r: any) => JSON.parse(call(r)?.arguments ?? "{}");

describe("J-fix: the owner's transcript, through the voice turn", () => {
  test("every turn goes to the window skill (never the screen tool), the correction is acknowledged", async () => {
    const { v } = voice({ tool: "screen" });
    const history: Msg[] = [];
    // One turn: his words → the rule's tool call → the skill's line → the spoken follow-up (rules).
    const say = async (words: string, skillSaid: string) => {
      history.push({ role: "user", content: words });
      const r: any = await v.handle("/voice/free/turn", { messages: history });
      expect({ words, model: r.model, tool: call(r)?.name }).toEqual({ words, model: "rules", tool: "skill" });
      history.push({ role: "assistant", content: null, tool_calls: r.tool_calls });
      history.push({ role: "tool", tool_call_id: r.tool_calls[0].id, content: skillSaid });
      const spoken: any = await v.handle("/voice/free/turn", { messages: history });
      history.push({ role: "assistant", content: spoken.content });
      return { req: args(r), spoken: String(spoken.content) };
    };

    const t1 = await say("Can you open a Chrome tab for me?", "Opened a Chrome tab on your main screen, sir.");
    expect(t1.req).toEqual({ skill: "browser", action: "new_tab" }); // (J2: the agent-browser hands; the window skill puts it on his main screen)
    expect(t1.spoken).toBe("Opened a Chrome tab on your main screen, sir.");

    const t2 = await say("Can you bring it to my front screen?", "Google Chrome is up on your main screen, sir.");
    expect(t2.req).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });

    const t3 = await say("I didn't see it on my main screen.", "Google Chrome is on your main screen now, sir.");
    expect(t3.req).toEqual({ skill: "window", action: "bring", target: "front", screen: "main" });

    const t4 = await say("I'm saying I don't see the Chrome tab on my front screen.", "Google Chrome is up on your main screen, sir.");
    expect(t4.req).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    expect(t4.spoken).toBe("Sorry, sir, my mistake. Google Chrome is up on your main screen, sir.");

    const t5 = await say(
      "No, you're not understanding me. The Chrome tab that I asked you to open is not being shown on the screen I want. I did not say that I am share screening.",
      "Google Chrome is up on your main screen, sir.",
    );
    expect(t5.req).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    // The same verified result as t4: said differently (never the same line twice running), still acknowledged.
    expect(t5.spoken).toBe("Sorry, sir, I've done that again: Google Chrome is up on your main screen, sir. If it's still not right, what are you seeing?");
    // And the share-screen line was never said.
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("Screen sharing is off"))).toBe(false);
  });

  test("whoever picks the screen tool for a placement complaint, it becomes the window skill", () => {
    const screenCall = { id: "x", type: "function" as const, function: { name: "screen", arguments: JSON.stringify({ question: "is chrome on my screen" }) } };
    const fixed = guardToolCall(screenCall, "the Chrome tab isn't showing on my main screen");
    expect(fixed.function.name).toBe("skill");
    expect(JSON.parse(fixed.function.arguments)).toEqual({ skill: "window", action: "bring", target: "chrome", screen: "main" });
    // Asking him to LOOK stays the screen tool.
    expect(guardToolCall(screenCall, "what's on my screen").function.name).toBe("screen");
  });
});

describe("J-fix: correction and repetition guard", () => {
  test("corrections are recognised; ordinary requests aren't", () => {
    for (const s of ["That's not what I said", "I didn't say that", "I did not say that I am share screening", "I'm saying I don't see it", "you're not listening", "no, I meant the Chrome tab"])
      expect(isCorrection(s)).toBe(true);
    for (const s of ["open a Chrome tab", "play it again", "say that again", "what did I say yesterday about pricing"]) expect(isCorrection(s)).toBe(false);
  });

  test("the same reply a third time (and even a second) is replaced by an acknowledgement and one short question", async () => {
    const { v } = voice({ content: SHARE_OFF });
    const history: Msg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: SHARE_OFF },
      { role: "user", content: "hmm, what now" },
      { role: "assistant", content: SHARE_OFF },
      { role: "user", content: "that's not what I asked" },
    ];
    const r: any = await v.handle("/voice/free/turn", { messages: history });
    expect(r.content).not.toBe(SHARE_OFF);
    expect(r.content).toBe(`Sorry, sir, I won't give you the same answer again. I heard: "that's not what I asked". What would you like me to do?`);
    // A new line is left alone.
    expect(repeatGuard(history, "Opened a Chrome tab on your main screen, sir.")).toBeNull();
  });

  test("a rules follow-up that repeats itself is guarded too", () => {
    const msgs: any[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: "Done, sir." },
      { role: "user", content: "again please do the thing" },
      { role: "assistant", content: null, tool_calls: [{ id: "k", type: "function", function: { name: "skill", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "k", content: "Done, sir." },
    ];
    expect(protocolFollowUp(msgs)).toBe("Done, sir.");
    expect(repeatGuard(msgs, "Done, sir.")).toBe("Sorry, sir, I've done that again: Done, sir. If it's still not right, what are you seeing?");
    // A third time: not that line again either, but the short question.
    const third = [...msgs.slice(0, 3), { role: "assistant", content: repeatGuard(msgs, "Done, sir.") }, ...msgs.slice(3)];
    expect(repeatGuard(third, "Done, sir.")).toMatch(/^Sorry, sir, I won't give you the same answer again\./);
    const again = [{ role: "assistant", content: "Done, sir." }, { role: "assistant", content: "Sorry, sir, I've done that again: Done, sir. If it's still not right, what are you seeing?" }, ...msgs.slice(2)];
    expect(repeatGuard(again as any, "Done, sir.")).toMatch(/^Sorry, sir, I won't give you the same answer again\./);
  });
});

// The owner's SECOND live transcript (29 Sep): "bring up Chrome on my screen" went to the share tool; "go to MU
// Ventures main website" opened muventures.com hidden; "bring it up" → "yep" drove his screen through Windows
// Search and YouTube results about another company.
describe("J-fix: the second transcript", () => {
  test("every turn is rules: window focus, our own site, and bring-it-up with no question", async () => {
    const { v, calls } = voice({ tool: "screen_act" });
    const turn = async (words: string) => (await v.handle("/voice/free/turn", { messages: [{ role: "user", content: words }] })) as any;
    const a = await turn("Can you bring up Chrome on my screen?");
    expect([a.model, call(a)?.name, args(a)]).toEqual(["rules", "skill", { skill: "window", action: "bring", target: "chrome", screen: "main" }]);
    const b = await turn("Can you bring up Chrome, please?");
    expect([call(b)?.name, args(b).action, args(b).target]).toEqual(["skill", "bring", "chrome"]);
    const c = await turn("Can you go to MU Ventures main website?");
    expect([c.model, call(c)?.name, args(c)]).toEqual(["rules", "skill", { skill: "browser", action: "open", url: "https://muventures.com.au/", name: "muventures.com.au" }]);
    // (The site was opened in Jarvis Chrome: that is what "it" is now.)
    rememberReferent({ app: "chrome", jarvisChrome: true, title: "muventures.com.au" });
    for (const words of ["Can you bring it up?", "bring it to the front", "show me that tab", "put it on my screen", "focus the MU Ventures site"]) {
      const d = await turn(words);
      expect({ words, model: d.model, tool: call(d)?.name, req: args(d) }).toEqual({ words, model: "rules", tool: "skill", req: { skill: "window", action: "bring", target: "front", screen: "main" } });
    }
    // None of it reached the (screen_act-happy) brain. (Round 10: Jev is asked first; this fake answers nothing Jev-shaped, so the rules ran
    // as the labelled fallback. Only the Jev calls are on the wire.)
    expect(calls.filter((u) => !u.includes("typesafe"))).toEqual([]);
    forgetReferent();
  });
  test("the opened site's line is spoken as the server made it (where it is), not paraphrased", () => {
    const msgs: any[] = [
      { role: "user", content: "Can you go to MU Ventures main website?" },
      { role: "assistant", content: null, tool_calls: [{ id: "o", type: "function", function: { name: "open_url", arguments: JSON.stringify({ url: "https://muventures.com.au/" }) } }] },
      { role: "tool", tool_call_id: "o", content: "Opened muventures.com.au in Chrome on your main screen." },
    ];
    expect(protocolFollowUp(msgs)).toBe("Opened muventures.com.au in Chrome on your main screen.");
  });
  test("a brain's guessed muventures.com, or a screen_act for a bring, is corrected", () => {
    const open = { id: "u", type: "function" as const, function: { name: "open_url", arguments: JSON.stringify({ url: "https://muventures.com/" }) } };
    expect(JSON.parse(guardToolCall(open, "open the site").function.arguments).url).toBe("https://muventures.com.au/");
    const act = { id: "s", type: "function" as const, function: { name: "screen_act", arguments: JSON.stringify({ goal: "focus muventures.com" }) } };
    expect(guardToolCall(act, "bring it up").function.name).toBe("skill"); // …"bring it up" is
    const control = { id: "c", type: "function" as const, function: { name: "control_pc", arguments: JSON.stringify({ task: "bring chrome to the front" }) } };
    expect(guardToolCall(control, "bring it to the front").function.name).toBe("skill");
  });
});

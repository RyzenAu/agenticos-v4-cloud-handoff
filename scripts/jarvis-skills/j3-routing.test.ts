// J3 routing regressions from the Jarvis audit (29 Sep 2026): AI spend goes to the AI usage skill and bank spend still
// goes to finance; a note that mentions "receptionist" is a note; "clip this page to Obsidian" waits for his yes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeVoice } from "../free-voice";
import { commandIntent } from "../jarvis-command/words";
import { planRules } from "../jarvis-command/plan";
import { receptionistQuestion } from "../jarvis-command/receptionist";
import { gateControlTask } from "../../src/lib/jarvis-control";
import { skillIntent } from "./index";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "j3-route-"));
  dirs.push(d);
  return d;
};

describe("AI spend phrasings go to the AI usage skill (audit top-15 #5)", () => {
  test("the four audit phrasings, and the long rambling one", () => {
    for (const u of [
      "how much have I spent on AI tools this month",
      "what have I spent on AI this month",
      "how much am I spending on ChatGPT and Claude",
      "sorry I keep going on but before you do anything can you tell me how much I've spent on AI this month because I think it's a lot",
    ])
      expect([u, skillIntent(u)]).toEqual([u, { skill: "ai_usage", action: "spend" }]);
  });
  test("bank, groceries and NAB spend still go to finance", () => {
    for (const u of ["how much have I spent on groceries this month", "what did I spend at the bank this month", "how much did I spend on NAB this month", "how much have I spent on software", "what did I spend this week"])
      expect([u, (skillIntent(u) as { skill?: string } | null)?.skill]).toEqual([u, "finance"]);
  });
});

describe("a note that mentions the receptionist is a note, not a status question (audit top-15 #6)", () => {
  const SAY = [
    "write that down: the receptionist needs a go-live date",
    "note down that the receptionist needs a go-live date",
    "jot this down the receptionist needs a go-live date",
    "note: the receptionist needs a go-live date",
    "add to my notes the receptionist needs a go-live date",
  ];
  for (const u of SAY)
    test(u, () => {
      expect(skillIntent(u)).toEqual({ skill: "notes", action: "add", text: "the receptionist needs a go-live date" });
      expect(receptionistQuestion(u)).toBeNull();
      expect(planRules(u)).toBeNull();
      // The command entry does not take it either, so the skills (the notes lane) get it.
      expect(commandIntent(u)).toBeNull();
    });
  test("real receptionist questions are unchanged", () => {
    expect(receptionistQuestion("what's the receptionist status")).toBe("status");
    expect(receptionistQuestion("is the receptionist safe to sell")).toBe("safe-to-sell");
    expect(receptionistQuestion("any flagged receptionist calls")).toBe("flagged");
    expect(planRules("how is the receptionist doing")).toMatchObject({ lane: "delegate", to: "receptionist" });
  });
  test("through the real voice turn: one notes skill call, no receptionist status", async () => {
    const voice = freeVoice(temp(), {
      key: (name: string) => ({ GROQ_API_KEY: "synthetic" } as Record<string, string>)[name] ?? "",
      fetch: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
      jarvisChromeInFront: async () => true,
    });
    for (const u of SAY) {
      const r: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: u }] });
      expect(r.tool_calls?.length).toBe(1);
      const call = r.tool_calls[0].function;
      expect([u, call.name, JSON.parse(call.arguments)]).toEqual([u, "skill", { skill: "notes", action: "add", text: "the receptionist needs a go-live date" }]);
    }
  });
});

describe("clip this page to Obsidian never runs without his yes (audit 'Telling it things')", () => {
  const gate = (task: string) => gateControlTask({ task, confirmed: false, pending: null, lastUserUtterance: task, now: Date.now() }).action;
  test("clipping, saving and adding to the vault ask first", () => {
    for (const t of [
      "clip this page to Obsidian",
      "clip this to obsidian",
      "save this article to my Obsidian vault",
      "add this page to my Obsidian vault",
      "add the meeting notes to my Obsidian vault",
      "put this in Obsidian",
      "write a note in my vault about Bianca",
      // J3 review F6: typing into Obsidian, the wiki and knowledge base, misspellings and look-alikes.
      "open Obsidian and type the meeting summary",
      "open Obsidian, then type the meeting summary",
      "save this to the wiki",
      "save this to my knowledge base",
      "save to my vault",
      "type this into the daily note",
      "clip this page to obs1dian",
      "save this to obsidan",
      "add this to Obsidien",
      "save this to Ｏｂｓｉｄｉａｎ",
      "save this to V a u l t",
      "put this in the o b s i d i a n vault",
    ])
      expect([t, gate(t)]).toEqual([t, "ask"]);
  });
  test("only opening Obsidian, or a plain launch, still runs on its own", () => {
    for (const t of ["open Obsidian", "open notepad", "open Obs1dian", "what is Obsidian"]) expect([t, gate(t)]).toEqual([t, "run"]);
  });
  test("a spoken yes to the read-back runs it (the gate is a question, not a wall)", () => {
    const pending = gateControlTask({ task: "clip this page to Obsidian", confirmed: false, pending: null, lastUserUtterance: "clip this page to Obsidian", now: 1_000 }) as { action: string; pending?: unknown };
    expect(pending.action).toBe("ask");
    const yes = gateControlTask({ task: "clip this page to Obsidian", confirmed: true, pending: (pending.pending ?? null) as never, lastUserUtterance: "yes", now: 2_000 });
    expect(yes.action).toBe("run");
  });
});

describe("an AI spend question that also orders a payment says plainly it only reads (review F7)", () => {
  const spend = (u: string) => skillIntent(u) as { skill: string; action: string; wontPay?: boolean; provider?: string } | null;
  test("the compound phrasings are answered as spend, flagged, and never as a payment", () => {
    for (const u of [
      "how much do I owe OpenAI, pay it",
      "how much did I spend on AI and transfer 100 to savings",
      "how much have I spent on Claude and top up my credits",
      "how much am I spending on ChatGPT, cancel the subscription",
      "how much have I spent on AI this month and then send it to Mehroz",
    ])
      expect([u, spend(u)?.skill, spend(u)?.wontPay]).toEqual([u, "ai_usage", true]);
    expect(spend("how much do I owe OpenAI, pay it")).toMatchObject({ action: "spend", provider: "openai", wontPay: true });
  });
  test("plain questions carry no flag; a product price question isn't his own spend", () => {
    for (const u of ["how much have I spent on AI this month", "how much am I paying for Claude", "how much do I owe OpenAI"]) expect([u, spend(u)?.wontPay]).toEqual([u, undefined]);
    for (const u of ["what does ChatGPT cost", "how much does Claude cost per month"]) expect([u, spend(u)?.skill === "ai_usage"]).toEqual([u, false]);
    expect(spend("how much is Claude costing me")).toMatchObject({ skill: "ai_usage", provider: "anthropic" });
  });
  test("the spoken answer starts with what it won't do, then gives the figure", async () => {
    const { answerAiUsage, WONT_PAY } = await import("../ai-usage/jarvis-intent");
    const snap: any = { month: { label: "September 2026" }, totals: { monthAud: 694.34, fixedAud: 684.85, meteredAud: 9.49, projectedAud: 695, unknown: [] }, subscriptions: [], apiKeys: [], claudeModels: { ok: false, reason: "x", checkedAt: null } };
    const said = answerAiUsage({ skill: "ai_usage", action: "spend", wontPay: true }, snap, 1);
    expect(said.startsWith(WONT_PAY)).toBe(true);
    expect(said).toContain("About 694 dollars on AI so far this September");
    expect(WONT_PAY).toMatch(/won't pay/);
  });
  test("the skill parser keeps the flag", async () => {
    const { parseSkillRequest } = await import("./index");
    expect(parseSkillRequest({ skill: "ai_usage", action: "spend", wontPay: true })).toEqual({ skill: "ai_usage", action: "spend", wontPay: true });
    expect(parseSkillRequest({ skill: "ai_usage", action: "spend", wontPay: "yes" })).toEqual({ skill: "ai_usage", action: "spend" });
  });
});
